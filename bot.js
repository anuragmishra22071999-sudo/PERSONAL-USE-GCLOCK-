import fs from "fs";
import path from "path";
import ws3 from "ws3-fca";

const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);

// ----- Get admin UID arg -----
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

// ----- Load appstate -----
let appState;
try {
  appState = JSON.parse(fs.readFileSync(APPSTATE_PATH, "utf8"));
} catch (e) {
  console.error("❌ Failed reading appstate.json:", e.message);
  process.exit(1);
}

// ----- Boss UID -----
let BOSS_UID = ADMIN_ARG;
try {
  if (fs.existsSync(ADMIN_PATH)) {
    const t = fs.readFileSync(ADMIN_PATH, "utf8").trim();
    if (t) BOSS_UID = t;
  }
} catch {}

// ----- Locks -----
let locks = {
  groupNames: {},
  nicknames: {},
  emojis: {},
  antiOut: {}
};
try {
  if (fs.existsSync(LOCKS_PATH)) locks = JSON.parse(fs.readFileSync(LOCKS_PATH, "utf8"));
} catch (e) {
  console.warn("⚠️ Could not load locks.json, using defaults.");
}

function saveLocks() {
  try {
    fs.writeFileSync(LOCKS_PATH, JSON.stringify(locks, null, 2));
  } catch (e) {
    console.error("❌ Failed saving locks:", e.message);
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ----- Helper: retry nickname change -----
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function retryChangeNick(api, threadID, uid, nick, retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      await new Promise(res =>
        api.changeNickname(nick, threadID, uid, err => {
          lastErr = err;
          res();
        })
      );
      if (!lastErr) return true;
    } catch (e) {
      lastErr = e;
    }
    await sleep(250 + i * 150);
  }
  log(`❌ changeNickname failed for ${uid} in ${threadID}. lastErr=${lastErr}`);
  return false;
}

async function revertSingleNick(api, threadID, uid) {
  try {
    const locked = locks.nicknames?.[threadID]?.[uid];
    if (!locked) return;
    await retryChangeNick(api, threadID, uid, locked, 3);
    log(`🔁 Reverted nick for ${uid} in ${threadID}`);
  } catch (e) {
    log("❌ revertSingleNick error: " + e.message);
  }
}

async function enforceNickLockForThread(api, threadID, nick) {
  try {
    const info = await api.getThreadInfo(threadID);
    const members = info?.participantIDs || info?.userInfo?.map(u => u.id) || [];
    const batchSize = 15;
    for (let i = 0; i < members.length; i += batchSize) {
      const batch = members.slice(i, i + batchSize);
      await Promise.all(batch.map(uid => retryChangeNick(api, threadID, uid, nick, 3)));
      await sleep(350);
    }
    // Save mapping for all current members
    locks.nicknames[threadID] = {};
    members.forEach(uid => { locks.nicknames[threadID][uid] = nick; });
    saveLocks();
    log(`🔐 Nicklock enforced in thread ${threadID} for all members`);
    return true;
  } catch (e) {
    log("❌ enforceNickLockForThread error: " + e.message);
    return false;
  }
}

// ----- Login & listeners -----
login({ appState }, async (err, api) => {
  if (err) {
    console.error("❌ Login failed:", err);
    process.exit(1);
  }

  api.setOptions({ listenEvents: true, selfListen: true });
  log("🤖 Bot logged in. Listening for events...");

  // periodically save locks
  setInterval(saveLocks, 60 * 1000);

  api.listenMqtt(async (err, event) => {
    if (err || !event) return;

    try {
      const threadID = String(event.threadID || "");
      const senderID = String(event.senderID || "");
      const body = (event.body || "").toString();
      const logType = event.logMessageType || "";

      // ----- Event Handlers -----
      if (event.type === "event") {
        // Thread name change
        if (logType === "log:thread-name") {
          const newName = event.logMessageData?.name || "";
          const lockedName = locks.groupNames?.[threadID];
          if (lockedName && newName !== lockedName) {
            try { await api.setTitle(lockedName, threadID); log(`🔒 Reverted thread name in ${threadID}`); } catch {}
          }
          return;
        }

        // Nickname change
        if (["log:user-nickname", "log:user-nick"].includes(logType)) {
          const uid = event.logMessageData?.participant_id || event.logMessageData?.participantID;
          const newNick = event.logMessageData?.nickname || "";
          if (locks.nicknames?.[threadID]?.[uid] && locks.nicknames[threadID][uid] !== newNick) {
            await revertSingleNick(api, threadID, uid);
            try { await api.sendMessage(`🔐 Nick reverted for ${uid}`, threadID); } catch {}
          }
          return;
        }

        // Emoji change
        if (["log:thread-icon", "log:thread-icon-change"].includes(logType)) {
          const currentEmoji = event.logMessageData?.thread_icon || event.logMessageData?.emoji || "";
          const lockedEmoji = locks.emojis?.[threadID];
          if (lockedEmoji && lockedEmoji !== currentEmoji) {
            try { await api.changeThreadEmoji(lockedEmoji, threadID); log(`🔒 Reverted emoji in ${threadID}`); } catch {}
          }
          return;
        }

        // Anti-out
        if (["log:unsubscribe", "log:remove", "log:remove-participant", "log:user-left"].includes(logType)) {
          const leftUID = event.logMessageData?.leftParticipantFbId || event.logMessageData?.leftParticipantId || event.logMessageData?.user_id || event.logMessageData?.participantId || null;
          if (!leftUID) return;
          if (locks.antiOut?.[threadID] && leftUID !== api.getCurrentUserID()) {
            try {
              await api.addUserToGroup(leftUID, threadID);
              await api.sendMessage(`🚨 Anti-Out: Added back ${leftUID}`, threadID);
              log(`🚨 Added back ${leftUID}`);
            } catch (e) { log("❌ antiOut addUser failed: " + e.message); }
          }
          return;
        }
      }

      // ----- Commands -----
      if (senderID !== BOSS_UID) return; // only admin

      if (!body) return;
      const parts = body.trim().split(/\s+/);
      const rawCmd = parts[0].replace(/^\//, "").toLowerCase();
      const args = parts.slice(1);

      // /groupname
      if (rawCmd === "groupname") {
        const sub = (args[0] || "").toLowerCase();
        if (sub === "on") {
          const name = args.slice(1).join(" ").trim();
          if (!name) return api.sendMessage("⚠️ Usage: /groupname on <Name>", threadID);
          locks.groupNames[threadID] = name;
          saveLocks();
          try { await api.setTitle(name, threadID); } catch {}
          return api.sendMessage(`✅ Group name locked ➜ "${name}"`, threadID);
        }
        if (sub === "off") {
          delete locks.groupNames[threadID];
          saveLocks();
          return api.sendMessage("🔓 Group name unlocked", threadID);
        }
      }

      // /nicknames
      if (rawCmd === "nicknames") {
        const sub = (args[0] || "").toLowerCase();
        if (sub === "on") {
          const nick = args.slice(1).join(" ").trim();
          if (!nick) return api.sendMessage("⚠️ Usage: /nicknames on <Nick>", threadID);
          await enforceNickLockForThread(api, threadID, nick);
          return api.sendMessage(`🔐 All nicknames locked ➜ "${nick}"`, threadID);
        }
        if (sub === "off") {
          const existed = locks.nicknames[threadID];
          if (existed) {
            for (const uid of Object.keys(existed)) await retryChangeNick(api, threadID, uid, "", 3);
            delete locks.nicknames[threadID];
            saveLocks();
          }
          return api.sendMessage("🔓 Nicknames unlocked", threadID);
        }
      }

    } catch (e) {
      log("❌ Event handler error: " + (e.message || e));
    }
  });
});
