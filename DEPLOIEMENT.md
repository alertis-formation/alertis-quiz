# 🚀 Guide de déploiement — Kahoot Maison

## En local (test rapide)

```bash
# 1. Installer les dépendances
npm install

# 2. Lancer le serveur
npm start

# 3. Ouvrir dans le navigateur
# Admin  → http://localhost:3000/admin.html
# Joueur → http://localhost:3000/play.html
```

---

## En ligne — Railway (recommandé, gratuit)

### Prérequis
- Un compte GitHub (gratuit) → https://github.com
- Un compte Railway (gratuit) → https://railway.app

### Étapes

1. **Créer un repo GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial commit — Kahoot Maison"
   # Crée un repo sur github.com, puis :
   git remote add origin https://github.com/TON-PSEUDO/kahoot-maison.git
   git push -u origin main
   ```

2. **Déployer sur Railway**
   - Va sur https://railway.app → "New Project"
   - Clique "Deploy from GitHub repo"
   - Sélectionne ton repo `kahoot-maison`
   - Railway détecte automatiquement Node.js et lance `npm start`
   - Après ~1 minute : ton app est en ligne !

3. **Récupérer l'URL publique**
   - Dans Railway : Settings → Domains → "Generate Domain"
   - Tu obtiens une URL comme `kahoot-maison.up.railway.app`
   - Partage `/play.html` aux joueurs : `https://kahoot-maison.up.railway.app/play.html`

---

## Structure des fichiers

```
kahoot-maison/
├── server.js          # Serveur Node.js (Express + Socket.io)
├── package.json
├── .gitignore
├── data/
│   └── quizzes.json   # Quizzes sauvegardés (créé automatiquement)
└── public/
    ├── index.html     # Page d'accueil
    ├── admin.html     # Interface organisateur
    └── play.html      # Interface joueur (mobile-friendly)
```

---

## Fonctionnalités

- Création/édition/suppression de quizzes
- Questions à 4 choix avec bonne réponse configurable
- Temps limite par question (5–120 secondes)
- Image optionnelle par question
- Explication optionnelle après la réponse
- QR Code généré automatiquement
- Classement en temps réel
- Score proportionnel à la rapidité (500–1000 pts/question)
- Interface joueur optimisée mobile
- Expulsion de joueurs
- Sauvegarde persistante des quizzes (JSON)
