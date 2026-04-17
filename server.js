const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

// ============================================================
// Sessions
// ============================================================
app.use(session({
  secret: process.env.SESSION_SECRET || 'alertis-quiz-secret-change-moi',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }, // 24h
}));

// ============================================================
// Middleware : protection de l'admin
// ============================================================
function requireAuth(req, res, next) {
  if (req.session.isAdmin) return next();
  res.redirect('/login.html');
}

// Middleware : animateur ou admin
function requireAnimateur(req, res, next) {
  if (req.session.isAdmin || req.session.isAnimateur) return next();
  res.redirect('/login.html');
}


// Servir admin.html uniquement si connecté
app.get('/admin.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'admin.html'));
});

// Servir animateur.html si animateur ou admin
app.get('/animateur.html', requireAnimateur, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'animateur.html'));
});


// Servir display.html (affichage projecteur — animateur ou admin)
app.get('/display.html', requireAnimateur, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'display.html'));
});

// Tout le reste est public (play.html, index.html, login.html...)
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// API Auth
// ============================================================
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
  const ANIMATEUR_EMAIL = process.env.ANIMATEUR_EMAIL || '';
  const ANIMATEUR_PASSWORD = process.env.ANIMATEUR_PASSWORD || '';

  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true, role: 'admin' });
  }
  if (ANIMATEUR_EMAIL && email === ANIMATEUR_EMAIL && password === ANIMATEUR_PASSWORD) {
    req.session.isAnimateur = true;
    req.session.animateurName = email.split('@')[0];
    return res.json({ ok: true, role: 'animateur' });
  }
  res.status(401).json({ error: 'Email ou mot de passe incorrect' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth-check', (req, res) => {
  res.json({ authenticated: !!req.session.isAdmin });
});

app.get('/api/me', (req, res) => {
  if (req.session.isAdmin) return res.json({ role: 'admin' });
  if (req.session.isAnimateur) return res.json({ role: 'animateur', name: req.session.animateurName });
  res.status(401).json({ error: 'Non authentifié' });
});

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

// Normalise un objet question pour gérer l'ancien et le nouveau format
function normalizeQuestion(q) {
  const nq = { ...q };
  // Normaliser le type
  if (!nq.type) nq.type = 'qcm';
  // Normaliser choices : ancien format = tableau de strings
  if (nq.choices && nq.choices.length > 0 && typeof nq.choices[0] === 'string') {
    nq.choices = nq.choices.map(c => ({ text: c, image: '' }));
  }
  // Pour poll et open, pas besoin de correctIndexes
  if (nq.type === 'poll' || nq.type === 'open') {
    nq.correctIndexes = [];
  } else {
    // Normaliser correctIndexes : ancien format = correctIndex (nombre)
    if (!nq.correctIndexes) {
      nq.correctIndexes = (nq.correctIndex !== undefined && nq.correctIndex !== null)
        ? [nq.correctIndex] : [0];
    }
  }
  return nq;
}

// ============================================================
// Parties actives en mémoire : code -> état de la partie
// ============================================================
const games = {};

// ============================================================
// API REST — Gestion des quizzes
// ============================================================
// Lecture accessible aux admin et animateurs
app.get('/api/quizzes', requireAnimateur, (_req, res) => res.json(getQuizzes()));

app.post('/api/quizzes', requireAuth, (req, res) => {
  const quizzes = getQuizzes();
  const quiz = {
    id: uuidv4(),
    title: (req.body.title || 'Nouveau Quiz').trim(),
    questions: req.body.questions || [],
    folder: req.body.folder || '',
    createdAt: Date.now(),
  };
  quizzes.push(quiz);
  saveQuizzes(quizzes);
  res.json(quiz);
});

app.put('/api/quizzes/:id', requireAuth, (req, res) => {
  const quizzes = getQuizzes();
  const i = quizzes.findIndex(q => q.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Quiz introuvable' });
  quizzes[i] = { ...quizzes[i], ...req.body, id: req.params.id, updatedAt: Date.now() };
  saveQuizzes(quizzes);
  res.json(quizzes[i]);
});

app.delete('/api/quizzes/:id', requireAuth, (req, res) => {
  saveQuizzes(getQuizzes().filter(q => q.id !== req.params.id));
  res.json({ ok: true });
});

// Dupliquer un quiz
app.post('/api/quizzes/:id/duplicate', requireAuth, (req, res) => {
  const quizzes = getQuizzes();
  const original = quizzes.find(q => q.id === req.params.id);
  if (!original) return res.status(404).json({ error: 'Quiz introuvable' });
  const copy = {
    ...JSON.parse(JSON.stringify(original)),
    id: uuidv4(),
    title: original.title + ' (copie)',
    createdAt: Date.now(),
  };
  delete copy.updatedAt;
  quizzes.push(copy);
  saveQuizzes(quizzes);
  res.json(copy);
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

  // ── DISPLAY : rejoindre en spectateur ─────────────────────
  socket.on('display:join', ({ code }) => {
    const g = games[code];
    if (!g) return socket.emit('display:error', 'Partie introuvable');
    socket.join(`display:${code}`);
    socket.data = { role: 'display', code };
    // Envoyer l'état courant immédiatement
    socket.emit('display:players', {
      count: Object.keys(g.players).length,
      players: playerList(g),
    });
    if (g.state === 'question') {
      const q = normalizeQuestion(g.quiz.questions[g.currentQ]);
      const elapsed = Math.floor((Date.now() - g.qStartTime) / 1000);
      socket.emit('display:question', {
        index: g.currentQ,
        total: g.quiz.questions.length,
        text: q.text,
        image: q.image || null,
        choices: q.choices,
        type: q.type || 'qcm',
        timeLimit: q.timeLimit || 30,
        doublePoints: q.doublePoints || false,
        remaining: Math.max(0, (q.timeLimit || 30) - elapsed),
      });
    }
  });

  // ── ADMIN : créer une nouvelle partie ──────────────────────
  socket.on('admin:create', ({ quizId, blindMode }) => {
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
      streaks: {},
      blindMode: blindMode || false,
      paused: false,
      pausedRemaining: 0,
      openAnswers: {},
    };

    socket.join(`g:${code}`);
    socket.data = { role: 'admin', code };
    socket.emit('admin:created', { code });
    console.log(`[GAME] Partie créée : ${code} (quiz: "${quiz.title}", blindMode: ${blindMode || false})`);
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

  // ── ADMIN : pause ──────────────────────────────────────────
  socket.on('admin:pause', ({ code }) => {
    const g = games[code];
    if (!g || g.adminSocketId !== socket.id || g.state !== 'question') return;
    if (g.paused) return;
    g.paused = true;
    const elapsed = (Date.now() - g.qStartTime) / 1000;
    const q = g.quiz.questions[g.currentQ];
    g.pausedRemaining = Math.max(0, (q.timeLimit || 30) - elapsed);
    if (g.qTimer) { clearTimeout(g.qTimer); g.qTimer = null; }
    io.to(`g:${code}`).emit('game:paused', { remaining: Math.ceil(g.pausedRemaining) });
  });

  // ── ADMIN : reprendre ──────────────────────────────────────
  socket.on('admin:resume', ({ code }) => {
    const g = games[code];
    if (!g || g.adminSocketId !== socket.id || !g.paused) return;
    g.paused = false;
    g.qStartTime = Date.now() - ((g.quiz.questions[g.currentQ].timeLimit || 30) - g.pausedRemaining) * 1000;
    io.to(`g:${code}`).emit('game:resumed', { remaining: Math.ceil(g.pausedRemaining) });
    g.qTimer = setTimeout(() => {
      if (games[g.code]?.state === 'question') showResults(games[g.code]);
    }, g.pausedRemaining * 1000);
  });

  // ── ADMIN : valider une réponse ouverte ───────────────────
  socket.on('admin:validate-open', ({ code, playerId, points }) => {
    const g = games[code];
    if (!g || g.adminSocketId !== socket.id) return;
    if (g.players[playerId]) {
      g.players[playerId].score += points;
      io.to(playerId).emit('answer:ok', { correct: points > 0, points });
    }
    io.to(g.adminSocketId).emit('answers:progress', { answered: Object.keys(g.answers).length, total: Object.keys(g.players).length });
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
    io.to(`display:${code}`).emit('display:players', { count: Object.keys(g.players).length, players: playerList(g) });
    console.log(`[GAME] ${name} rejoint ${code}`);
  });

  // ── JOUEUR : soumettre une réponse ─────────────────────────
  socket.on('player:answer', ({ index, indexes, text }) => {
    const code = socket.data?.code;
    const g = games[code];
    if (!g || g.state !== 'question') return;
    if (g.answers[socket.id] !== undefined) return;

    const q = normalizeQuestion(g.quiz.questions[g.currentQ]);
    const ms = Date.now() - g.qStartTime;
    const timeLimit = (q.timeLimit || 30) * 1000;

    // Type open : stocker le texte, pas de points automatiques
    if (q.type === 'open') {
      if (!g.openAnswers[g.currentQ]) g.openAnswers[g.currentQ] = [];
      const playerName = g.players[socket.id]?.name || 'Joueur';
      g.openAnswers[g.currentQ].push({ playerId: socket.id, name: playerName, text: text || '' });
      g.answers[socket.id] = { text, correct: false, points: 0, ms };
      // Notifier l'admin qu'une réponse ouverte est arrivée
      io.to(g.adminSocketId).emit('open:answer', {
        playerId: socket.id,
        name: playerName,
        text: text || '',
        questionIdx: g.currentQ,
      });
      const answered = Object.keys(g.answers).length;
      const total = Object.keys(g.players).length;
      io.to(g.adminSocketId).emit('answers:progress', { answered, total });
      if (answered >= total) showResults(g);
      return;
    }

    // Type poll : pas de points
    if (q.type === 'poll') {
      const selected = indexes !== undefined ? indexes : (index !== undefined ? [index] : []);
      g.answers[socket.id] = { indexes: selected, correct: false, points: 0, ms };
      socket.emit('answer:ok', { correct: false, points: 0 });
      const answered = Object.keys(g.answers).length;
      const total = Object.keys(g.players).length;
      io.to(g.adminSocketId).emit('answers:progress', { answered, total });
      if (answered >= total) showResults(g);
      return;
    }

    // Supporte l'ancien format { index } et le nouveau { indexes }
    const selected = indexes !== undefined ? indexes : (index !== undefined ? [index] : []);
    const correctSet = q.correctIndexes;

    // Correct si toutes les bonnes réponses sont sélectionnées ET aucune mauvaise
    const correct = selected.length > 0
      && correctSet.every(ci => selected.includes(ci))
      && selected.every(si => correctSet.includes(si));

    let points = 0;
    if (correct) {
      const speed = Math.max(0, 1 - ms / timeLimit);
      points = Math.round(500 + 500 * speed);
      // Points doubles
      if (q.doublePoints) points *= 2;
    }

    // Streak
    if (correct) {
      g.streaks[socket.id] = (g.streaks[socket.id] || 0) + 1;
    } else {
      g.streaks[socket.id] = 0;
    }
    const streak = g.streaks[socket.id];
    // Bonus streak
    if (correct) {
      if (streak === 2) points += 50;
      else if (streak === 3) points += 100;
      else if (streak >= 4) points += 150;
    }

    g.answers[socket.id] = { indexes: selected, correct, points, ms };
    if (correct && g.players[socket.id]) g.players[socket.id].score += points;

    socket.emit('answer:ok', { correct, points, streak });

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
      io.to(`display:${code}`).emit('display:players', { count: Object.keys(g.players).length, players: playerList(g) });
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
  g.paused = false;

  const q = normalizeQuestion(g.quiz.questions[idx]);
  const timeLimit = q.timeLimit || 30;

  io.to(`g:${g.code}`).emit('question:start', {
    index: idx,
    total: g.quiz.questions.length,
    text: q.text,
    choices: q.choices,
    type: q.type || 'qcm',
    timeLimit,
    image: q.image || null,
    doublePoints: q.doublePoints || false,
  });

  g.qTimer = setTimeout(() => {
    if (games[g.code]?.state === 'question' && games[g.code].currentQ === idx)
      showResults(games[g.code]);
  }, (timeLimit + 1) * 1000);

  // Notifier le display
  io.to(`display:${g.code}`).emit('display:question', {
    index: idx,
    total: g.quiz.questions.length,
    text: q.text,
    image: q.image || null,
    choices: q.choices,
    type: q.type || 'qcm',
    timeLimit,
    doublePoints: q.doublePoints || false,
    remaining: timeLimit,
  });
}

function showResults(g) {
  if (g.state !== 'question') return;
  if (g.qTimer) { clearTimeout(g.qTimer); g.qTimer = null; }
  g.state = 'results';

  const q = normalizeQuestion(g.quiz.questions[g.currentQ]);
  const counts = (q.choices || []).length > 0 ? new Array(q.choices.length).fill(0) : [];
  for (const a of Object.values(g.answers)) {
    const sel = a.indexes || (a.index !== undefined ? [a.index] : []);
    for (const idx of sel) {
      if (idx >= 0 && idx < counts.length) counts[idx]++;
    }
  }

  // Pour sondage et open, correctIndexes = []
  const correctIndexes = (q.type === 'poll' || q.type === 'open') ? [] : q.correctIndexes;

  // Envoyer le résultat complet à l'admin
  io.to(g.adminSocketId).emit('question:results', {
    correctIndexes,
    explanation: q.explanation || null,
    counts,
    leaderboard: buildLeaderboard(g),
    isLast: g.currentQ >= g.quiz.questions.length - 1,
    type: q.type,
    openAnswers: q.type === 'open' ? (g.openAnswers[g.currentQ] || []) : undefined,
  });

  // Envoyer aux joueurs (sans leaderboard si blindMode)
  const playerData = {
    correctIndexes,
    counts,
    isLast: g.currentQ >= g.quiz.questions.length - 1,
    type: q.type,
  };
  if (!g.blindMode) playerData.leaderboard = buildLeaderboard(g);

  // Envoyer à tous les joueurs (pas à l'admin)
  for (const sid of Object.keys(g.players)) {
    io.to(sid).emit('question:results', playerData);
  }

  // Notifier le display avec données complètes
  io.to(`display:${g.code}`).emit('display:results', {
    correctIndexes,
    counts,
    leaderboard: buildLeaderboard(g),
    type: q.type,
    choices: q.choices,
    explanation: q.explanation || null,
    isLast: g.currentQ >= g.quiz.questions.length - 1,
  });
}

function endGame(g) {
  g.state = 'ended';
  const lb = buildLeaderboard(g);
  io.to(`g:${g.code}`).emit('game:end', { leaderboard: lb });
  io.to(`display:${g.code}`).emit('display:end', { leaderboard: lb });
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
  console.log(`⚡ Alertis Quiz   → http://localhost:${PORT}/admin.html`);
  console.log(`   Joueurs       → http://localhost:${PORT}/play.html`);
  console.log(`   Animateur     → http://localhost:${PORT}/animateur.html`);
});
