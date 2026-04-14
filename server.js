const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Stockage JSON persistant
// ============================================================
const DATA_DIR = path.join(__dirname, 'data');
const QUIZ_FILE = path.join(DATA_DIR, 'quizzes.json');

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(QUIZ_FILE)) fs.writeFileSync(QUIZ_FILE, '[]');
}
function getQuizzes() {
  ensureData();
  try { return JSON.parse(fs.readFileSync(QUIZ_FILE, 'utf8')); }
  catch { return []; }
}
function saveQuizzes(data) {
  ensureData();
  fs.writeFileSync(QUIZ_FILE, JSON.stringify(data, null, 2));
}

// ============================================================
// Parties actives en mémoire : code -> état de la partie
// ============================================================
const games = {};

// ============================================================
// API REST — Gestion des quizzes
// ============================================================
app.get('/api/quizzes', (_req, res) => res.json(getQuizzes()));

app.post('/api/quizzes', (req, res) => {
  const quizzes = getQuizzes();
  const quiz = {
    id: uuidv4(),
    title: (req.body.title || 'Nouveau Quiz').trim(),
    questions: req.body.questions || [],
    createdAt: Date.now(),
  };
  quizzes.push(quiz);
  saveQuizzes(quizzes);
  res.json(quiz);
});

app.put('/api/quizzes/:id', (req, res) => {
  const quizzes = getQuizzes();
  const i = quizzes.findIndex(q => q.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Quiz introuvable' });
  quizzes[i] = { ...quizzes[i], ...req.body, id: req.params.id, updatedAt: Date.now() };
  saveQuizzes(quizzes);
  res.json(quizzes[i]);
});

app.delete('/api/quizzes/:id', (req, res) => {
  saveQuizzes(getQuizzes().filter(q => q.id !== req.params.id));
  res.json({ ok: true });
});

// Génération QR code pour rejoindre une partie
app.get('/api/qr/:code', async (req, res) => {
  const url = `${req.protocol}://${req.get('host')}/play.html?code=${req.params.code}`;
  try {
    const qr = await QRCode.toDataURL(url, {
      width: 280, margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' },
    });
    res.json({ qr, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// Socket.io — Logique temps réel
// ============================================================
io.on('connection', socket => {

  // ── ADMIN : créer une nouvelle partie ──────────────────────
  socket.on('admin:create', ({ quizId }) => {
    const quiz = getQuizzes().find(q => q.id === quizId);
    if (!quiz) return socket.emit('error', 'Quiz introuvable');
    if (quiz.questions.length === 0) return socket.emit('error', 'Ce quiz ne contient aucune question');

    let code;
    do { code = Math.random().toString(36).slice(2, 8).toUpperCase(); }
    while (games[code]);

    games[code] = {
      code, quiz,
      adminSocketId: socket.id,
      players: {},
      state: 'waiting',
      currentQ: -1,
      answers: {},
      qStartTime: 0,
      qTimer: null,
    };

    socket.join(`g:${code}`);
    socket.data = { role: 'admin', code };
    socket.emit('admin:created', { code });
    console.log(`[GAME] Partie créée : ${code} (quiz: "${quiz.title}")`);
  });

  // ── ADMIN : démarrer la partie ─────────────────────────────
  socket.on('admin:start', ({ code }) => {
    const g = games[code];
    if (!g || g.adminSocketId !== socket.id) return;
    sendQuestion(g, 0);
  });

  // ── ADMIN : passer à la question suivante ──────────────────
  socket.on('admin:next', ({ code }) => {
    const g = games[code];
    if (!g || g.adminSocketId !== socket.id) return;
    const next = g.currentQ + 1;
    if (next >= g.quiz.questions.length) endGame(g);
    else sendQuestion(g, next);
  });

  // ── ADMIN : terminer la question manuellement ──────────────
  socket.on('admin:stop-q', ({ code }) => {
    const g = games[code];
    if (!g || g.adminSocketId !== socket.id) return;
    showResults(g);
  });

  // ── ADMIN : expulser un joueur ─────────────────────────────
  socket.on('admin:kick', ({ code, playerId }) => {
    const g = games[code];
    if (!g || g.adminSocketId !== socket.id) return;
    delete g.players[playerId];
    io.to(playerId).emit('kicked');
    io.to(`g:${code}`).emit('players:update', playerList(g));
  });

  // ── ADMIN : terminer la partie ─────────────────────────────
  socket.on('admin:end-game', ({ code }) => {
    const g = games[code];
    if (!g || g.adminSocketId !== socket.id) return;
    endGame(g);
  });

  // ── JOUEUR : rejoindre ─────────────────────────────────────
  socket.on('player:join', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    name = (name || '').trim();
    const g = games[code];

    if (!g) return socket.emit('join:err', 'Code de partie invalide');
    if (g.state !== 'waiting') return socket.emit('join:err', 'La partie a déjà commencé');
    if (!name || name.length < 1) return socket.emit('join:err', 'Pseudo invalide');
    if (name.length > 20) return socket.emit('join:err', 'Pseudo trop long (max 20 caractères)');
    if (Object.values(g.players).some(p => p.name.toLowerCase() === name.toLowerCase()))
      return socket.emit('join:err', 'Ce pseudo est déjà pris');

    g.players[socket.id] = { id: socket.id, name, score: 0 };
    socket.join(`g:${code}`);
    socket.data = { role: 'player', code, name };

    socket.emit('join:ok', {
      name,
      quizTitle: g.quiz.title,
      questionCount: g.quiz.questions.length,
    });
    io.to(`g:${code}`).emit('players:update', playerList(g));
    console.log(`[GAME] ${name} rejoint ${code}`);
  });

  // ── JOUEUR : soumettre une réponse ─────────────────────────
  socket.on('player:answer', ({ index }) => {
    const code = socket.data?.code;
    const g = games[code];
    if (!g || g.state !== 'question') return;
    if (g.answers[socket.id] !== undefined) return;

    const q = g.quiz.questions[g.currentQ];
    const ms = Date.now() - g.qStartTime;
    const timeLimit = (q.timeLimit || 20) * 1000;
    const correct = index === q.correctIndex;

    let points = 0;
    if (correct) {
      const speed = Math.max(0, 1 - ms / timeLimit);
      points = Math.round(500 + 500 * speed);
    }

    g.answers[socket.id] = { index, correct, points, ms };
    if (correct && g.players[socket.id]) g.players[socket.id].score += points;

    socket.emit('answer:ok', { correct, points });

    const answered = Object.keys(g.answers).length;
    const total = Object.keys(g.players).length;
    io.to(g.adminSocketId).emit('answers:progress', { answered, total });

    if (answered >= total) showResults(g);
  });

  // ── Déconnexion ────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { role, code } = socket.data || {};
    if (!code || !games[code]) return;
    const g = games[code];

    if (role === 'admin') {
      io.to(`g:${code}`).emit('game:aborted');
      if (g.qTimer) clearTimeout(g.qTimer);
      delete games[code];
      console.log(`[GAME] Partie ${code} abandonnée (admin parti)`);
    } else if (role === 'player') {
      const name = g.players[socket.id]?.name;
      delete g.players[socket.id];
      io.to(`g:${code}`).emit('players:update', playerList(g));
      if (name) console.log(`[GAME] ${name} a quitté ${code}`);
    }
  });
});

// ============================================================
// Fonctions de jeu
// ============================================================
function sendQuestion(g, idx) {
  if (g.qTimer) { clearTimeout(g.qTimer); g.qTimer = null; }
  g.state = 'question';
  g.currentQ = idx;
  g.answers = {};
  g.qStartTime = Date.now();

  const q = g.quiz.questions[idx];
  const timeLimit = q.timeLimit || 20;

  io.to(`g:${g.code}`).emit('question:start', {
    index: idx,
    total: g.quiz.questions.length,
    text: q.text,
    choices: q.choices,
    timeLimit,
    image: q.image || null,
  });

  g.qTimer = setTimeout(() => {
    if (games[g.code]?.state === 'question' && games[g.code].currentQ === idx)
      showResults(games[g.code]);
  }, (timeLimit + 1) * 1000);
}

function showResults(g) {
  if (g.state !== 'question') return;
  if (g.qTimer) { clearTimeout(g.qTimer); g.qTimer = null; }
  g.state = 'results';

  const q = g.quiz.questions[g.currentQ];
  const counts = new Array(q.choices.length).fill(0);
  for (const a of Object.values(g.answers)) {
    if (a.index >= 0 && a.index < counts.length) counts[a.index]++;
  }

  io.to(`g:${g.code}`).emit('question:results', {
    correctIndex: q.correctIndex,
    explanation: q.explanation || null,
    counts,
    leaderboard: buildLeaderboard(g),
    isLast: g.currentQ >= g.quiz.questions.length - 1,
  });
}

function endGame(g) {
  g.state = 'ended';
  io.to(`g:${g.code}`).emit('game:end', { leaderboard: buildLeaderboard(g) });
  if (g.qTimer) clearTimeout(g.qTimer);
  delete games[g.code];
  console.log(`[GAME] Partie ${g.code} terminée`);
}

function playerList(g) {
  return Object.values(g.players).map(p => ({ id: p.id, name: p.name, score: p.score }));
}

function buildLeaderboard(g) {
  return Object.values(g.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
}

// ============================================================
// Démarrage
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 Kahoot Maison → http://localhost:${PORT}/admin.html`);
  console.log(`   Joueurs       → http://localhost:${PORT}/play.html`);
});
