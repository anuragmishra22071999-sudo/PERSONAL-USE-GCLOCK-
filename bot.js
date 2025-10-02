const fs = require("fs");
const path = require("path");
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const ws3 = require("ws3-fca");
const login = typeof ws3==="function"?ws3:(ws3.default||ws3.login||ws3);

const ADMIN_ARG = process.argv[2];
if(!ADMIN_ARG){ console.error("❌ Missing admin UID arg"); process.exit(1); }

const ROOT = process.cwd();
const USER_DIR = path.join(ROOT,"users",String(ADMIN_ARG));
const APPSTATE_PATH = path.join(USER_DIR,"appstate.json");
const ADMIN_PATH = path.join(USER_DIR,"admin.txt");
const LOCKS_PATH = path.join(USER_DIR,"locks.json");

if(!fs.existsSync(USER_DIR)){ console.error("❌ User folder not found:",USER_DIR); process.exit(1); }

let appState;
try{ appState = JSON.parse(fs.readFileSync(APPSTATE_PATH,"utf8")); }
catch(e){ console.error("❌ Failed reading appstate.json:",e.message); process.exit(1); }

let BOSS_UID = ADMIN_ARG;
try{ if(fs.existsSync(ADMIN_PATH)){ const t = fs.readFileSync(ADMIN_PATH,"utf8").trim(); if(t) BOSS_UID=t; } }catch{}

let locks={groupNames:{},nicknames:{},emojis:{},antiOut:{}};
try{ if(fs.existsSync(LOCKS_PATH)) locks=JSON.parse(fs.readFileSync(LOCKS_PATH,"utf8")); }catch(e){ console.warn("⚠️ Could not load locks.json, using defaults."); }

function saveLocks(){ try{ fs.writeFileSync(LOCKS_PATH,JSON.stringify(locks,null,2)); }catch(e){console.error(e);} }
function log(msg){ console.log(`[${new Date().toISOString()}] ${msg}`); }

// retry nick change helper
async function retryChangeNick(api,threadID,uid,nick,retries=3){
  let lastErr=null;
  for(let i=0;i<retries;i++){
    try{ await new Promise(res=>api.changeNickname(nick,threadID,uid,err=>{lastErr=err;res();})); if(!lastErr) return true; }catch(e){lastErr=e;}
    await sleep(250+i*150);
  }
  log(`❌ changeNickname failed for ${uid} in ${threadID}. lastErr=${lastErr}`);
  return false;
}

async function revertSingleNick(api,threadID,uid){
  try{ const locked = locks.nicknames?.[threadID]?.[uid]; if(!locked) return; await retryChangeNick(api,threadID,uid,locked,3); log(`🔁 Reverted nick for ${uid} in ${threadID}`);}catch(e){log(e);}
}

async function enforceNickLockForThread(api,threadID,nick){
  try{
    const info = await api.getThreadInfo(threadID);
    const members = info?.participantIDs||info?.userInfo?.map(u=>u.id)||[];
    for(const uid of members) locks.nicknames[threadID][uid]=nick;
    const batchSize=15;
    for(let i=0;i<members.length;i+=batchSize){
      const batch = members.slice(i,i+batchSize);
      await Promise.all(batch.map(uid=>retryChangeNick(api,threadID,uid,nick,3)));
      await sleep(350);
    }
    saveLocks();
    log(`✅ Nicklock enforced for thread ${threadID}`);
  }catch(e){ log("❌ enforceNickLockForThread error: "+e.message); }
}

login({ appState }, async (err,api)=>{
  if(err){ console.error("❌ Login failed:",err); process.exit(1); }
  api.setOptions({ listenEvents:true, selfListen:true });
  log("🤖 Bot logged in");

  setInterval(saveLocks,60000);

  api.listenMqtt(async (err,event)=>{
    if(err||!event) return;
    try{
      const threadID=String(event.threadID||"");
      const senderID=String(event.senderID||"");
      const body=(event.body||"").toString();
      const logType=event.logMessageType||"";

      // -------- Event Handlers --------
      if(event.type==="event"){
        if(logType==="log:thread-name"){
          const newName = event.logMessageData?.name||"";
          const lockedName = locks.groupNames?.[threadID];
          if(lockedName && newName!==lockedName){
            try{ await api.setTitle(lockedName,threadID); log(`🔒 Reverted thread name in ${threadID}`); }catch(e){log(e.message);}
          }
          return;
        }
        if(["log:user-nickname","log:user-nick"].includes(logType)){
          const uid = event.logMessageData?.participant_id || event.logMessageData?.participantID;
          const newNick = event.logMessageData?.nickname||"";
          if(locks.nicknames?.[threadID]?.[uid] && locks.nicknames[threadID][uid]!==newNick){
            await revertSingleNick(api,threadID,uid);
            try{ await api.sendMessage(`🔐 Nick reverted for ${uid}`,threadID); }catch{}
          }
          return;
        }
        if(["log:unsubscribe","log:remove","log:remove-participant","log:user-left"].includes(logType)){
