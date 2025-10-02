const express = require('express');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_DIR = path.join(__dirname, 'users');
const MAX_USERS = 20;

if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });

app.use(express.json({ limit: '8mb' }));
app.use(express.static('public')); // serve html from public/

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// UID -> child process mapping
const processes = {};

// log helper
function appendLog(userDir, text) {
  try {
    const logFile = path.join(userDir, 'logs.txt');
    fs.appendFileSync(logFile, text + "\n");
  } catch (e) {
    console.error('Failed writing logs:', e);
  }
}

// socket.io
io.on('connection', (socket) => {
  socket.on('join', (uid) => {
    socket.join(uid);
  });
});

// --- start bot ---
app.post('/start-bot', (req, res) => {
  const { appstate, admin } = req.body;
  if (!appstate || !admin) return res.status(400).send('❌ AppState or UID missing');

  const userDir = path.join(USERS_DIR, String(admin));
  const currentUsers = fs.readdirSync(USERS_DIR).filter(uid =>
    fs.existsSync(path.join(USERS_DIR, uid, 'appstate.json'))
  );

  if (!currentUsers.includes(String(admin)) && currentUsers.length >= MAX_USERS) {
    return res.status(403).send('❌ Limit reached: Only 20 users allowed.');
  }

  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

  try {
    const appStateObj = typeof appstate === 'string' ? JSON.parse(appstate) : appstate;
    fs.writeFileSync(path.join(userDir, 'appstate.json'), JSON.stringify(appStateObj, null, 2));
    fs.writeFileSync(path.join(userDir, 'admin.txt'), String(admin));

    const logPath = path.join(userDir, 'logs.txt');
    fs.writeFileSync(logPath, `📂 Logs started at ${new Date().toISOString()}\n`);

    // kill previous
    if (processes[admin]) {
      try { processes[admin].kill(); } catch {}
    }

    // fork bot
    const child = fork(path.join(__dirname, 'bot.js'), [String(admin)], { silent: true });

    child.stdout.on('data', (data) => {
      const text = data.toString().trim();
      appendLog(userDir, text);
      io.to(String(admin)).emit('botlog', text);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString().trim();
      appendLog(userDir, `[ERR] ${text}`);
      io.to(String(admin)).emit('botlog', `[ERR] ${text}`);
    });

    child.on('exit', (code) => {
      const msg = `🔴 Bot exited with code ${code} at ${new Date().toISOString()}`;
      appendLog(userDir, msg);
      io.to(String(admin)).emit('botlog', msg);
      delete processes[admin];
    });

    processes[admin] = child;

    res.send(`✅ Bot started successfully for UID: ${admin}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('❌ Invalid AppState JSON or Internal Error.');
  }
});

// --- stop bot ---
app.get('/stop-bot', (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).send('❌ UID missing.');
  if (!processes[uid]) return res.send('⚠️ Bot not running.');
  try {
    processes[uid].kill();
    delete processes[uid];
    res.send(`🔴 Bot stopped for UID: ${uid}`);
  } catch (e) {
    res.status(500).send('❌ Failed to stop bot.');
  }
});

// --- fetch logs ---
app.get('/logs', (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).send('❌ UID missing.');
  const logFile = path.join(USERS_DIR, String(uid), 'logs.txt');
  if (!fs.existsSync(logFile)) return res.send('(No logs yet)');
  res.send(fs.readFileSync(logFile, 'utf-8'));
});

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
