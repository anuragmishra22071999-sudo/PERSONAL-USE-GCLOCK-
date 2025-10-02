const fs = require("fs");
const path = require("path");
const HttpsProxyAgent = require("https-proxy-agent");
const ws3 = require("ws3-fca");
const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);

// === UID ARG ===
const uid = process.argv[2];
if (!uid) {
  console.error("❌ No UID provided to bot.js");
  process.exit(1);
}

const userDir = path.join(__dirname, "users", String(uid));
const appStatePath = path.join(userDir, "appstate.json");
const adminPath = path.join(userDir, "admin.txt");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- Load appstate ---
let appState;
try {
  appState = JSON.parse(fs.readFileSync(appStatePath, "utf-8"));
} catch (e) {
  console.error("❌ Invalid appstate.json");
  process.exit(1);
}

// --- Load Admin UID ---
let BOSS_UID;
try {
  BOSS_UID = fs.readFileSync(adminPath, "utf-8").trim();
} catch (e) {
  console.error("❌ Invalid admin.txt");
  process.exit(1);
}

// Proxy (optional)
const INDIAN_PROXY = process.env.INDIAN_PROXY || null;
let proxyAgent = null;
try {
  if (INDIAN_PROXY) proxyAgent = new HttpsProxyAgent(INDIAN_PROXY);
} catch (e) {}

let api = null;

// === STATE (mutable) ===
let GROUP_THREAD_ID = null;
let LOCKED_GROUP_NAME = null;
let lockedNick = null;
let nickLockEnabled = false;
let nickRemoveEnabled = false;
let gcAutoRemoveEnabled = false;
let antiOutEnabled = false;

// === Commands as constants ===
const GCLOCK_CMD        = "/gclock";
const GCREMOVE_CMD      = "/gcremove";
const NICKLOCK_ON_CMD   = "/nicklock on";
const NICKLOCK_OFF_CMD  = "/nicklock off";
const NICKREMOVEALL_CMD = "/nickremoveall";
const NICKREMOVEOFF_CMD = "/nickremoveoff";
const SETNICK_CMD       = "/setnick";

const LOCK_COMMANDS = Object.freeze({
  GCLOCK: GCLOCK_CMD,
  GCREMOVE: GCREMOVE_CMD,
  NICKLOCK_ON: NICKLOCK_ON_CMD,
  NICKLOCK_OFF: NICKLOCK_OFF_CMD,
  NICKREMOVEALL: NICKREMOVEALL_CMD,
  NICKREMOVEOFF: NICKREMOVEOFF_CMD,
  SETNICK: SETNICK_CMD
});

// === Helper Functions ===
async function setNickSafe(nick, threadID, uidToChange) {
  return new Promise(async (resolve) => {
    try {
      await new Promise((r) =>
        api.changeNickname(nick, threadID, uidToChange, () => r())
      );
      setTimeout(() => {
        api.changeNickname(nick, threadID, uidToChange, () => resolve());
      }, 800);
    } catch {
      resolve();
    }
  });
}

async function setTitleSafe(title, threadID) {
  try {
    await new Promise((r) =>
      api.setTitle(title, threadID, () => r())
    );
    setTimeout(() => api.setTitle(title, threadID, () => {}), 900);
  } catch {}
}

function parseMentionTarget(event) {
  try {
    if (event.mentions && typeof event.mentions === "object") {
      const keys = Object.keys(event.mentions);
      if (keys.length > 0) return keys[0];
    }
    if (event.messageReply && event.messageReply.senderID) {
      return String(event.messageReply.senderID);
    }
  } catch {}
  return null;
}

// === Start Bot ===
function startBot() {
  login(
    {
      appState,
      agent: proxyAgent,
    },
    (err, a) => {
      if (err) {
        console.error("❌ LOGIN FAILED: " + err);
        process.exit(1);
      }

      api = a;
      api.setOptions({ listenEvents: true, selfListen: true });
      log("🤖 BOT ONLINE");

      // Listen for events
      api.listenMqtt(async (err, event) => {
        if (err) return log("❌ Listen error: " + err);

        const senderID = String(event.senderID || "");
        const threadID = String(event.threadID || "");
        const bodyRaw = event.body || "";
        const body = (bodyRaw || "").toLowerCase();

        // =======================
        // 🔒 GCLOCK COMMAND
        // =======================
        if (body.startsWith(LOCK_COMMANDS.GCLOCK) && senderID === BOSS_UID) {
          const newName = bodyRaw.slice(LOCK_COMMANDS.GCLOCK.length).trim();
          if (!newName) return api.sendMessage("❌ Provide a name", threadID);
          GROUP_THREAD_ID = threadID;
          LOCKED_GROUP_NAME = newName;
          gcAutoRemoveEnabled = false;
          await setTitleSafe(newName, threadID);
          return api.sendMessage(`🔒 GC locked as "${newName}"`, threadID);
        }

        if (body === LOCK_COMMANDS.GCREMOVE && senderID === BOSS_UID) {
          await setTitleSafe("", threadID);
          GROUP_THREAD_ID = threadID;
          LOCKED_GROUP_NAME = null;
          gcAutoRemoveEnabled = true;
          return api.sendMessage("🧹 GC name removed. Auto-remove ON", threadID);
        }

        // =======================
        // 🔐 NICKLOCK COMMANDS
        // =======================
        if (body.startsWith(LOCK_COMMANDS.NICKLOCK_ON) && senderID === BOSS_UID) {
          const requested = bodyRaw.slice(LOCK_COMMANDS.NICKLOCK_ON.length).trim();
          if (!requested) return api.sendMessage("❌ Provide a nickname", threadID);
          lockedNick = `${requested} — Locked by ANURAG MISHRA`;
          nickLockEnabled = true;
          const info = await api.getThreadInfo(threadID);
          for (const u of info.userInfo) {
            await setNickSafe(lockedNick, threadID, u.id);
          }
          return api.sendMessage(`🔐 Nickname locked as "${lockedNick}"`, threadID);
        }

        if (body === LOCK_COMMANDS.NICKLOCK_OFF && senderID === BOSS_UID) {
          nickLockEnabled = false;
          lockedNick = null;
          return api.sendMessage("🔓 NickLock OFF", threadID);
        }

        if (body === LOCK_COMMANDS.NICKREMOVEALL && senderID === BOSS_UID) {
          nickRemoveEnabled = true;
          const info = await api.getThreadInfo(threadID);
          for (const u of info.userInfo) {
            await setNickSafe("", threadID, u.id);
          }
          return api.sendMessage("💥 All nicknames cleared. Auto-remove ON", threadID);
        }

        if (body === LOCK_COMMANDS.NICKREMOVEOFF && senderID === BOSS_UID) {
          nickRemoveEnabled = false;
          return api.sendMessage("🛑 Auto nick remove OFF", threadID);
        }

        if (body.startsWith(LOCK_COMMANDS.SETNICK) && senderID === BOSS_UID) {
          const target = parseMentionTarget(event);
          let requestedNick = bodyRaw.split(" ").slice(1).join(" ").trim();
          if (!target && !event.messageReply)
            return api.sendMessage("❌ Mention or reply required", threadID);
          if (!requestedNick) return api.sendMessage("❌ Provide nickname", threadID);
          const victimId = target || String(event.messageReply.senderID);
          const finalNick = `${requestedNick} — Locked by ANURAG MISHRA`;
          await setNickSafe(finalNick, threadID, victimId);
          return api.sendMessage(`✅ Nick set for ${victimId}`, threadID);
        }

        // =======================
        // 🔒 AUTO ENFORCERS
        // =======================
        if (event.logMessageType === "log:thread-name") {
          const changed = event.logMessageData?.name || "";
          if (LOCKED_GROUP_NAME && changed !== LOCKED_GROUP_NAME) {
            await setTitleSafe(LOCKED_GROUP_NAME, threadID);
          } else if (gcAutoRemoveEnabled && changed !== "") {
            await setTitleSafe("", threadID);
          }
        }

        if (event.logMessageType === "log:user-nickname") {
          const changedUID = event.logMessageData?.participant_id;
          const newNick = event.logMessageData?.nickname || "";
          if (nickLockEnabled && lockedNick && newNick !== lockedNick) {
            await setNickSafe(lockedNick, threadID, changedUID);
          }
          if (nickRemoveEnabled && newNick !== "") {
            await setNickSafe("", threadID, changedUID);
          }
        }
      });
    }
  );
}

startBot();
