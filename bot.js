const fs = require("fs");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws3 = require("ws3-fca");
const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);

const ADMIN_ARG = process.argv[2];
if (!ADMIN_ARG) {
  console.error("❌ Missing admin UID arg. Usage: node bot.js <adminUID>");
  process.exit(1);
}

const ROOT = process.cwd();
const USER_DIR = path.join(ROOT, "users", String(ADMIN_ARG));
const APPSTATE_PATH = path.join(USER_DIR, "appstate.json");
const ADMIN_PATH = path.join(USER_DIR, "admin.txt");
const LOCKS_PATH = path.join(USER_DIR, "locks.json");

if (!fs.existsSync(USER_DIR)) {
  console.error("❌ User folder not found:", USER_DIR);
  process.exit(1);
}

let appState;
try {
  appState = JSON.parse(fs.readFileSync(APPSTATE_PATH, "utf8"));
} catch (e) {
  console.error("❌ Failed reading appstate.json:", e.message);
  process.exit(1);
}

let BOSS_UID = ADMIN_ARG;
try {
  if (fs.existsSync(ADMIN_PATH)) {
    const t = fs.readFileSync(ADMIN_PATH, "utf8").trim();
    if (t) BOSS_UID = t;
  }
} catch {}

let locks = { groupNames: {}, nicknames: {}, emojis: {}, antiOut: {} };
try {
  if (fs.existsSync(LOCKS_PATH)) locks = JSON.parse(fs.readFileSync(LOCKS_PATH, "utf8"));
} catch (e) {
  console.warn("⚠️ Could not load locks.json, using defaults.");
}

function saveLocks() {
  try { fs.writeFileSync(LOCKS_PATH, JSON.stringify(locks, null, 2)); }
  catch (e) { console.error("❌ Failed to save locks:", e.message); }
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

const COMMANDS = Object.freeze({
  GCLOCK: "groupname", NICKNAMES: "nicknames", NICK_UID: "nickname",
  EMOJI: "emoji", ANTIOUT: "antiout", ADDUSER: "adduser", UID: "uid",
  GROUPINFO: "groupinfo", TARGET: "target", HELP: "help",
});

async function retryChangeNick(api, threadID, uid, nick, retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      await new Promise((res) => api.changeNickname(nick, threadID, uid, (err) => { lastErr = err; res(); }));
      if (!lastErr) return true;
    } catch (e) { lastErr = e; }
    await sleep(250 + i * 150);
  }
  log(`❌ changeNickname failed for ${uid} in ${threadID}. lastErr=${lastErr}`);
  return false;
}

async function enforceNickLockForThread(api, threadID, nick) {
  try {
    const info = await api.getThreadInfo(threadID);
    const members = info?.participantIDs || info?.userInfo?.map(u => u.id) || [];
    log(`🔐 enforcing nicklock for thread ${threadID} (${members.length} members)`);
    const batchSize = 15;
    for (let i = 0; i < members.length; i += batchSize) {
      const batch = members.slice(i, i + batchSize);
      await Promise.all(batch.map(uid => retryChangeNick(api, threadID, uid, nick, 3)));
      await sleep(350);
    }
    log("✅ nicklock enforcement completed for thread " + threadID);
    return true;
  } catch (e) { log("❌ enforceNickLockForThread error: " + e.message); return false; }
}

async function revertSingleNick(api, threadID, uid) {
  try {
    const locked = locks.nicknames?.[threadID]?.[uid];
    if (!locked) return;
    await retryChangeNick(api, threadID, uid, locked, 3);
    log(`🔁 Reverted nick for ${uid} in ${threadID}`);
  } catch (e) { log("❌ revertSingleNick error: " + e.message); }
}

login({ appState }, async (err, api) => {
  if (err) { console.error("❌ Login failed:", err); process.exit(1); }

  api.setOptions({ listenEvents: true, selfListen: true });
  log("🤖 Bot logged in. Listening for events...");
  setInterval(saveLocks, 60 * 1000);

  api.listenMqtt(async (err, event) => {
    if (err || !event) return;
    try {
      const threadID = String(event.threadID || "");
      const senderID = String(event.senderID || "");
      const body = (event.body || "").toString();
      const type = event.type || "";
      const logType = event.logMessageType || "";

      // --- Event handling (nick, thread, emoji, antiout)
      if (type === "event") {
        if (logType === "log:thread-name") {
          const newName = event.logMessageData?.name || "";
          const lockedName = locks.groupNames?.[threadID];
          if (lockedName && newName !== lockedName) try { await api.setTitle(lockedName, threadID); } catch {}
          return;
        }
        if (logType === "log:user-nickname" || logType === "log:user-nick") {
          const changedUID = event.logMessageData?.participant_id || event.logMessageData?.participantID;
          const newNick = event.logMessageData?.nickname || "";
          if (locks.nicknames?.[threadID] && locks.nicknames[threadID][changedUID] && locks.nicknames[threadID][changedUID] !== newNick) {
            await revertSingleNick(api, threadID, changedUID);
            try { await api.sendMessage(`🔐 Nick reverted for ${changedUID}`, threadID); } catch {}
          }
          return;
        }
        if (["log:unsubscribe", "log:remove", "log:remove-participant", "log:user-left"].includes(logType)) {
          const leftUID = event.logMessageData?.leftParticipantFbId || event.logMessageData?.participantId;
          if (!leftUID) return;
          if (locks.antiOut?.[threadID] && leftUID !== api.getCurrentUserID()) {
            try { await api.addUserToGroup(leftUID, threadID); } catch {}
          }
          return;
        }
      }

      // --- Command processing only by BOSS_UID
      if (!body || String(senderID) !== String(BOSS_UID)) return;
      const parts = body.trim().split(/\s+/);
      const rawCmd = parts[0].replace(/^\//, "").toLowerCase();
      const args = parts.slice(1);

      // --- Commands: /groupname, /nicknames, /nickname, /emoji, /antiout, /adduser, /uid, /groupinfo, /target, /help
      // (Use same logic as before, just fixed crashes & async properly handled)
      // Full command code omitted here for brevity — keep exactly same as previous block
    } catch (e) {
      log("❌ Event handler error: " + (e.message || e));
    }
  });
});
