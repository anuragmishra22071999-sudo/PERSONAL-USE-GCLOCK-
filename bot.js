const fs = require("fs");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws3 = require("ws3-fca"); // keep same API as used before
const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);

// get uid arg
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

// load appstate
let appState;
try {
  appState = JSON.parse(fs.readFileSync(APPSTATE_PATH, "utf8"));
} catch (e) {
  console.error("❌ Failed reading appstate.json:", e.message);
  process.exit(1);
}

// load boss uid (should match ADMIN_ARG but keep it authoritative)
let BOSS_UID = ADMIN_ARG;
try {
  if (fs.existsSync(ADMIN_PATH)) {
    const t = fs.readFileSync(ADMIN_PATH, "utf8").trim();
    if (t) BOSS_UID = t;
  }
} catch {}

// locks persistence
let locks = {
  groupNames: {},      // threadID -> name
  nicknames: {},       // threadID -> { uid: nick, ... }
  emojis: {},          // threadID -> emoji
  antiOut: {},         // threadID -> true/false
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
    console.error("❌ Failed to save locks:", e.message);
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

// ========= Commands (constants, frozen) =========
const COMMANDS = Object.freeze({
  GCLOCK: "groupname",      // usage: /groupname on <Name>  | off
  NICKNAMES: "nicknames",   // usage: /nicknames on <Nick> | off
  NICK_UID: "nickname",     // usage: /nickname on <UID> <Nick> | off <UID>
  EMOJI: "emoji",           // usage: /emoji <emoji>
  ANTIOUT: "antiout",       // usage: /antiout on | off
  ADDUSER: "adduser",       // usage: /adduser <UID>
  UID: "uid",               // usage: /uid
  GROUPINFO: "groupinfo",   // usage: /groupinfo
  TARGET: "target",         // usage: /target on <UID> | off
  HELP: "help",             // usage: /help
});

// ========= Robust NickLock helpers =========
// batch + retry to avoid rate limits
async function retryChangeNick(api, threadID, uid, nick, retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      await new Promise((res) =>
        api.changeNickname(nick, threadID, uid, (err) => {
          lastErr = err;
          // treat any callback return as resolution (we'll log error if present)
          res();
        })
      );
      if (!lastErr) return true;
    } catch (e) {
      lastErr = e;
    }
    // small backoff
    await sleep(250 + i * 150);
  }
  log(`❌ changeNickname failed for ${uid} in ${threadID} after ${retries} tries. lastErr=${lastErr}`);
  return false;
}

async function enforceNickLockForThread(api, threadID, nick) {
  try {
    const info = await api.getThreadInfo(threadID);
    // get participant IDs safely
    const members = info?.participantIDs || info?.userInfo?.map(u => u.id) || [];
    log(`🔐 enforcing nicklock for thread ${threadID} (${members.length} members)`);

    const batchSize = 15; // tuned for reliability
    for (let i = 0; i < members.length; i += batchSize) {
      const batch = members.slice(i, i + batchSize);
      await Promise.all(batch.map(uid => retryChangeNick(api, threadID, uid, nick, 3)));
      // small delay between batches to avoid rate-limit
      await sleep(350);
    }
    log("✅ nicklock enforcement completed for thread " + threadID);
    return true;
  } catch (e) {
    log("❌ enforceNickLockForThread error: " + e.message);
    return false;
  }
}

// revert single user's nick (used on nickname change events)
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

// ========= Start login & listeners =========
login(
  {
    appState,
    // userAgent optional
  },
  async (err, api) => {
    if (err) {
      console.error("❌ Login failed:", err);
      process.exit(1);
    }

    api.setOptions({ listenEvents: true, selfListen: true });
    log("🤖 Bot logged in. Listening for events...");

    // periodically save locks to disk
    setInterval(saveLocks, 60 * 1000);

    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;

        // normalize commonly used fields
        const threadID = String(event.threadID || "");
        const senderID = String(event.senderID || "");
        const body = (event.body || "").toString();
        const lower = (body || "").toLowerCase();
        const type = event.type || "";
        const logType = event.logMessageType || "";

        // --- handle type=event (thread-name, nickname, emoji, unsubscribe/remove) ---
        if (type === "event") {
          // THREAD NAME CHANGED
          if (logType === "log:thread-name") {
            const newName = event.logMessageData?.name || "";
            const lockedName = locks.groupNames?.[threadID];
            if (lockedName && newName !== lockedName) {
              log(`🔒 Reverting thread name in ${threadID} -> ${lockedName}`);
              try { await api.setTitle(lockedName, threadID); } catch (e) { log("❌ setTitle failed: " + e.message); }
            }
            return;
          }

          // NICKNAME CHANGED
          if (logType === "log:user-nickname" || logType === "log:user-nick") {
            const changedUID = event.logMessageData?.participant_id || event.logMessageData?.participantID;
            const newNick = event.logMessageData?.nickname || "";
            if (locks.nicknames?.[threadID]) {
              const lockedForThis = locks.nicknames[threadID] || {};
              if (lockedForThis[changedUID] && lockedForThis[changedUID] !== newNick) {
                // revert single
                await revertSingleNick(api, threadID, changedUID);
                // optional notify
                try { await api.sendMessage(`🔐 Nick reverted for ${changedUID}`, threadID); } catch {}
              }
            }
            return;
          }

          // THREAD ICON / EMOJI CHANGED
          if (logType === "log:thread-icon" || logType === "log:thread-icon-change") {
            const currentEmoji = event.logMessageData?.thread_icon || event.logMessageData?.emoji || "";
            const lockedEmoji = locks.emojis?.[threadID];
            if (lockedEmoji && lockedEmoji !== currentEmoji) {
              log(`🔒 Reverting emoji in ${threadID} -> ${lockedEmoji}`);
              try { await api.changeThreadEmoji(lockedEmoji, threadID); } catch (e) { log("❌ changeThreadEmoji failed: " + e.message); }
            }
            return;
          }

          // USER LEFT / REMOVED (anti-out)
          if (["log:unsubscribe", "log:remove", "log:remove-participant", "log:user-left"].includes(logType) || (typeof logType === "string" && logType.includes("remove"))) {
            // try to detect left uid
            const leftUID = event.logMessageData?.leftParticipantFbId || event.logMessageData?.leftParticipantId || event.logMessageData?.user_id || event.logMessageData?.participantId || null;
            if (!leftUID) return;
            const isAnti = !!locks.antiOut?.[threadID];
            if (isAnti && leftUID !== api.getCurrentUserID()) {
              try {
                await api.addUserToGroup(leftUID, threadID);
                await api.sendMessage(`🚨 Anti-Out: Added back ${leftUID}`, threadID);
                log(`🚨 antiOut: added back ${leftUID} to ${threadID}`);
              } catch (e) {
                log("❌ antiOut addUserToGroup failed: " + e.message);
                try { await api.sendMessage(`⚠️ AntiOut failed to re-add ${leftUID}. Check bot permissions.`, threadID); } catch {}
              }
            }
            return;
          }
        } // end type=event handlers

        // if no body or not a command, skip processing commands
        if (!body || typeof body !== "string") return;

        // Only BOSS_UID allowed to run commands
        if (String(senderID) !== String(BOSS_UID)) {
          // not admin — ignore commands
          return;
        }

        // parse command (allow leading slash or not)
        const parts = body.trim().split(/\s+/);
        const rawCmd = parts[0].replace(/^\//, "").toLowerCase();
        const args = parts.slice(1);

        // --- Command: groupname ---
        if (rawCmd === COMMANDS.GCLOCK) {
          const sub = (args[0] || "").toLowerCase();
          if (sub === "on") {
            const name = args.slice(1).join(" ").trim();
            if (!name) return api.sendMessage("⚠️ Usage: /groupname on <Name>", threadID);
            locks.groupNames[threadID] = name;
            saveLocks();
            try { await api.setTitle(name, threadID); } catch (e) { log("❌ setTitle error: " + e.message); }
            return api.sendMessage(`✅ Group name locked ➜ "${name}"`, threadID);
          } else if (sub === "off") {
            delete locks.groupNames[threadID];
            saveLocks();
            return api.sendMessage("🔓 Group name unlocked", threadID);
          } else {
            return api.sendMessage("⚠️ Usage: /groupname on <Name> | /groupname off", threadID);
          }
        }

        // --- Command: nicknames (global nick lock) ---
        if (rawCmd === COMMANDS.NICKNAMES) {
          const sub = (args[0] || "").toLowerCase();
          if (sub === "on") {
            const nickname = args.slice(1).join(" ").trim();
            if (!nickname) return api.sendMessage("⚠️ Usage: /nicknames on <Nick>", threadID);

            // ensure structure
            if (!locks.nicknames[threadID]) locks.nicknames[threadID] = {};

            // enforce across thread with batching + retries
            await enforceNickLockForThread(api, threadID, nickname);

            // Save mapping for all current members
            try {
              const info = await api.getThreadInfo(threadID);
              const members = info?.participantIDs || info?.userInfo?.map(u => u.id) || [];
              for (const uid of members) locks.nicknames[threadID][uid] = nickname;
              saveLocks();
            } catch (e) {
              log("⚠️ Could not persist nicklist after enforcing: " + e.message);
            }

            return api.sendMessage(`🔐 All nicknames locked ➜ "${nickname}"`, threadID);
          } else if (sub === "off") {
            const existed = locks.nicknames[threadID];
            if (existed) {
              // clear nicknames by setting to empty string in batches
              const uids = Object.keys(existed || {});
              const batchSize = 15;
              for (let i = 0; i < uids.length; i += batchSize) {
                const batch = uids.slice(i, i + batchSize);
                await Promise.all(batch.map(uid => retryChangeNick(api, threadID, uid, "", 3)));
                await sleep(350);
              }
              delete locks.nicknames[threadID];
              saveLocks();
            }
            return api.sendMessage("🔓 Nicknames unlocked", threadID);
          } else {
            return api.sendMessage("⚠️ Usage: /nicknames on <Nick> | /nicknames off", threadID);
          }
        }

        // --- Command: nickname (per-UID lock) ---
        if (rawCmd === COMMANDS.NICK_UID) {
          const sub = (args[0] || "").toLowerCase();
          if (sub === "on") {
            const targetUid = args[1];
            const nickname = args.slice(2).join(" ").trim();
            if (!targetUid || !nickname) return api.sendMessage("⚠️ Usage: /nickname on <UID> <Nick>");
            if (!locks.nicknames[threadID]) locks.nicknames[threadID] = {};
            // set immediately with retry
            await retryChangeNick(api, threadID, targetUid, nickname, 3);
            locks.nicknames[threadID][targetUid] = nickname;
            saveLocks();
            return api.sendMessage(`✅ UID ${targetUid} nickname locked ➜ "${nickname}"`, threadID);
          } else if (sub === "off") {
            const targetUid = args[1];
            if (!targetUid) return api.sendMessage("⚠️ Usage: /nickname off <UID>");
            if (locks.nicknames[threadID] && locks.nicknames[threadID][targetUid]) {
              await retryChangeNick(api, threadID, targetUid, "", 3);
              delete locks.nicknames[threadID][targetUid];
              saveLocks();
              return api.sendMessage(`🔓 UID ${targetUid} nickname unlocked`, threadID);
            } else {
              return api.sendMessage("⚠️ No nickname lock found for this UID", threadID);
            }
          } else {
            return api.sendMessage("⚠️ Usage: /nickname on <UID> <Nick> | /nickname off <UID>", threadID);
          }
        }

        // --- emoji ---
        if (rawCmd === COMMANDS.EMOJI) {
          const emoji = args[0] || "";
          if (!emoji) return api.sendMessage("📛 Usage: /emoji <Emoji>");
          locks.emojis[threadID] = emoji;
          saveLocks();
          try { await api.changeThreadEmoji(emoji, threadID); } catch (e) { log("❌ changeThreadEmoji failed: " + e.message); }
          return api.sendMessage(`✅ Group emoji locked ➜ ${emoji}`, threadID);
        }

        // --- antiout ---
        if (rawCmd === COMMANDS.ANTIOUT) {
          const sub = (args[0] || "").toLowerCase();
          if (sub === "on") {
            locks.antiOut[threadID] = true; saveLocks();
            return api.sendMessage("✅ Antiout enabled", threadID);
          } else if (sub === "off") {
            delete locks.antiOut[threadID]; saveLocks();
            return api.sendMessage("❌ Antiout disabled", threadID);
          } else {
            return api.sendMessage("📌 Usage: /antiout on | /antiout off", threadID);
          }
        }

        // --- adduser ---
        if (rawCmd === COMMANDS.ADDUSER) {
          const toAdd = args[0];
          if (!toAdd) return api.sendMessage("⚠️ Usage: /adduser <UID>", threadID);
          try {
            await api.addUserToGroup(toAdd, threadID);
            return api.sendMessage(`✅ UID ${toAdd} added to this group`, threadID);
          } catch (e) {
            return api.sendMessage(`🥵 Not In Add: ${e?.message || e}`);
          }
        }

        // --- uid ---
        if (rawCmd === COMMANDS.UID) {
          return api.sendMessage(`🆔 Group ID ➜ ${threadID}`, threadID);
        }

        // --- groupinfo ---
        if (rawCmd === COMMANDS.GROUPINFO) {
          try {
            const info = await api.getThreadInfo(threadID);
            const members = info?.participantIDs?.length || info?.userInfo?.length || 0;
            const active = [];
            if (locks.groupNames[threadID]) active.push("🔒 Name Lock");
            if (locks.nicknames[threadID]) active.push("🔒 Nickname Lock");
            if (locks.emojis[threadID]) active.push("🔒 Emoji Lock");
            if (locks.antiOut[threadID]) active.push("🚫 Anti-Out");
            const msg = `📊 GROUP INFORMATION\n• Group Name: ${info?.threadName || "—"}\n• Members: ${members}\n• Active: ${active.length ? active.join(", ") : "— None —"}`;
            return api.sendMessage(msg, threadID);
          } catch (e) {
            return api.sendMessage("❌ Failed to fetch group info: " + (e.message || e));
          }
        }

        // --- target (simple state) ---
        if (rawCmd === COMMANDS.TARGET) {
          const sub = (args[0] || "").toLowerCase();
          if (sub === "on") {
            const t = args[1];
            if (!t) return api.sendMessage("⚠️ Usage: /target on <UID>");
            locks.target = locks.target || {};
            locks.target[threadID] = t;
            saveLocks();
            return api.sendMessage(`✅ Target set ➜ ${t}`, threadID);
          } else if (sub === "off") {
            if (locks.target) {
              delete locks.target[threadID];
              saveLocks();
            }
            return api.sendMessage("🔓 Target cleared", threadID);
          } else {
            return api.sendMessage("⚠️ Usage: /target on <UID> | /target off", threadID);
          }
        }

        // --- help ---
        if (rawCmd === COMMANDS.HELP) {
          const helpText = `Commands:
• /groupname on <Name> | off
• /nicknames on <Nick> | off
• /nickname on <UID> <Nick> | off <UID>
• /emoji <Emoji>
• /antiout on | off
• /adduser <UID>
• /uid
• /groupinfo
• /target on <UID> | off
• /help`;
          return api.sendMessage(helpText, threadID);
        }

      } catch (e) {
        log("❌ Event handler error: " + (e.message || e));
      }
    }); // listenMqtt end
  } // login callback end
);
