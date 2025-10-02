const express = require("express");
const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_DIR = path.join(__dirname, "users");
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });

app.use(express.json({ limit: "8mb" }));
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// mapping adminUID -> child process
const procs = {};

// helper log persistence per user
function appendLog(uid, text) {
  try {
    const userDir = path.join(USERS_DIR, String(uid));
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    const lf = path.join(userDir, "logs.txt");
    fs.appendFileSync(lf, `[${new Date().toISOString()}] ${text}\n`);
  } catch (e) {
    console.error("Failed appendLog:", e.message);
  }
}

io.on("connection", (socket) => {
  socket.on("join", (uid) => {
    socket.join(String(uid));
  });
});

app.post("/start-bot", (req, res) => {
  const { appstate, admin } = req.body;
  if (!appstate || !admin) return res.status(400).send("❌ appstate or admin missing");
  const userDir = path.join(USERS_DIR, String(admin));
  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

  // save appstate and admin.txt
  try {
    const appObj = typeof appstate === "string" ? JSON.parse(appstate) : appstate;
    fs.writeFileSync(path.join(userDir, "appstate.json"), JSON.stringify(appObj, null, 2));
    fs.writeFileSync(path.join(userDir, "admin.txt"), String(admin));
  } catch (e) {
    return res.status(400).send("❌ Invalid appstate JSON");
  }

  // if already running, kill & restart
  if (procs[admin]) {
    try { procs[admin].kill(); } catch {}
  }

  const child = fork(path.join(__dirname, "bot.js"), [String(admin)], { silent: true });

  child.stdout.on("data", (d) => {
    const text = d.toString().trim();
    appendLog(admin, text);
    io.to(String(admin)).emit("botlog", text);
  });

  child.stderr.on("data", (d) => {
    const text = d.toString().trim();
    appendLog(admin, "[ERR] " + text);
    io.to(String(admin)).emit("botlog", "[ERR] " + text);
  });

  child.on("exit", (code, sig) => {
    const m = `🔴 Bot process exited (code=${code}, sig=${sig})`;
    appendLog(admin, m);
    io.to(String(admin)).emit("botlog", m);
    delete procs[admin];
  });

  procs[admin] = child;
  appendLog(admin, `✅ Bot started for admin ${admin}`);
  io.to(String(admin)).emit("botlog", `✅ Bot started for ${admin}`);
  return res.send(`✅ started ${admin}`);
});

app.get("/stop-bot", (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.status(400).send("❌ uid missing");
  if (!procs[uid]) return res.send("⚠️ Bot not running");
  try {
    procs[uid].kill();
    delete procs[uid];
    appendLog(uid, "🔴 Bot stopped by panel");
    io.to(String(uid)).emit("botlog", "🔴 Bot stopped by panel");
    return res.send("🔴 stopped");
  } catch (e) {
    return res.status(500).send("❌ Failed to stop: " + e.message);
  }
});

app.get("/logs", (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.status(400).send("❌ uid missing");
  const lf = path.join(USERS_DIR, String(uid), "logs.txt");
  if (!fs.existsSync(lf)) return res.send("(No logs yet)");
  res.send(fs.readFileSync(lf, "utf8"));
});

server.listen(PORT, () => console.log(`🚀 Panel running on http://localhost:${PORT}`));
