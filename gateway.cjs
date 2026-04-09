#!/usr/bin/env node
/**
 * WhatsApp Gateway for Claude Code — v0.1.0
 *
 * Standalone daemon: handles single Baileys WhatsApp connection,
 * routes messages to per-user Claude Code sessions via filesystem IPC.
 * Each user gets their own Claude Code + bridge.cjs MCP server.
 */

const { execFile, execFileSync } = require("child_process");
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Config ──────────────────────────────────────────────────────────

const STATE_DIR = process.env.WHATSAPP_STATE_DIR || path.join(os.homedir(), ".claude", "channels", "whatsapp");
const ACCESS_FILE = path.join(STATE_DIR, "access.json");
const AUTH_DIR = path.join(STATE_DIR, "auth");
const OTP_LOG_FILE = path.join(STATE_DIR, "otp.log");
const OTP_FILE = path.join(STATE_DIR, "otp.json");
const ADMIN_FILE = path.join(STATE_DIR, "admin.json");
const USERS_DIR = path.join(STATE_DIR, "users");
const OUTBOX_DIR = path.join(STATE_DIR, "outbox");
const PHONE = path.basename(STATE_DIR).replace("whatsapp-", "");
const SESSION_IDLE_MS = 30 * 60 * 1000;

fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(USERS_DIR, { recursive: true });
fs.mkdirSync(OUTBOX_DIR, { recursive: true });

const logger = pino({ level: "silent" });
const log = (msg) => process.stderr.write(`wa-gateway: ${msg}\n`);

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;
const RECONNECT = { initialMs: 2000, maxMs: 30000, factor: 1.8, jitter: 0.25 };
const WATCHDOG_INTERVAL = 60 * 1000;
const STALE_TIMEOUT = 30 * 60 * 1000;
const HEALTHY_THRESHOLD = 60 * 1000;

// ── Access Control ──────────────────────────────────────────────────

function defaultAccess() { return { allowFrom: [], allowGroups: false, allowedGroups: [], requireAllowFromInGroups: false }; }
function loadAccess() {
  try { return { ...defaultAccess(), ...JSON.parse(fs.readFileSync(ACCESS_FILE, "utf8")) }; }
  catch (err) { if (err.code === "ENOENT") return defaultAccess(); try { fs.renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`); } catch {} return defaultAccess(); }
}
function toJid(phone) { return phone.includes("@") ? phone : `${phone.replace(/[^0-9]/g, "")}@s.whatsapp.net`; }
function isAllowed(jid, participant) {
  const access = loadAccess();
  if (jid.endsWith("@g.us")) { if (!access.allowGroups) return false; if (access.allowedGroups.length > 0 && !access.allowedGroups.includes(jid)) return false; if (access.requireAllowFromInGroups && participant) return access.allowFrom.some((a) => toJid(a) === participant || a === participant); return true; }
  if (access.allowFrom.length === 0) return true;
  return access.allowFrom.some((a) => toJid(a) === jid || a === jid);
}
function addToWhitelist(jid) {
  const access = loadAccess();
  if (!access.allowFrom.some((a) => toJid(a) === jid || a === jid)) { access.allowFrom.push(jid); fs.writeFileSync(ACCESS_FILE, JSON.stringify(access, null, 2) + "\n"); log(`whitelist: added ${jid}`); }
}
function loadAdmin() { try { return JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8")); } catch { return null; } }
function loadOtp() { try { const d = JSON.parse(fs.readFileSync(OTP_FILE, "utf8")); return d.code && d.expiresAt > Date.now() ? d : null; } catch { return null; } }

// ── Message helpers ─────────────────────────────────────────────────

function extractText(msg) { return msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || msg.documentMessage?.caption || ""; }
function extractMediaInfo(msg) {
  if (msg.imageMessage) return { type: "image", mimetype: msg.imageMessage.mimetype || "image/jpeg", size: Number(msg.imageMessage.fileLength) || 0 };
  if (msg.videoMessage) return { type: "video", mimetype: msg.videoMessage.mimetype || "video/mp4", size: Number(msg.videoMessage.fileLength) || 0 };
  if (msg.audioMessage) return { type: "audio", mimetype: msg.audioMessage.mimetype || "audio/ogg", size: Number(msg.audioMessage.fileLength) || 0 };
  if (msg.documentMessage) return { type: "document", mimetype: msg.documentMessage.mimetype || "application/octet-stream", size: Number(msg.documentMessage.fileLength) || 0, filename: msg.documentMessage.fileName };
  if (msg.stickerMessage) return { type: "sticker", mimetype: msg.stickerMessage.mimetype || "image/webp", size: Number(msg.stickerMessage.fileLength) || 0 };
  return null;
}
function mimeToExt(m) { return { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "audio/ogg; codecs=opus": "ogg", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "application/pdf": "pdf" }[m] || "bin"; }
function formatJid(jid) { return jid.replace(/@s\.whatsapp\.net$/, "").replace(/@g\.us$/, "").replace(/@lid$/, "").replace(/:\d+$/, ""); }

// ── Caches ──────────────────────────────────────────────────────────

const rawMessages = new Map(); const RAW_MSG_CAP = 500;
const seenMessages = new Map(); const SEEN_TTL = 20 * 60 * 1000; const SEEN_MAX = 5000;
function isDuplicate(key) { if (seenMessages.has(key)) return true; seenMessages.set(key, Date.now()); if (seenMessages.size > SEEN_MAX) { const now = Date.now(); for (const [k, t] of seenMessages) { if (now - t > SEEN_TTL) seenMessages.delete(k); } } return false; }
function storeRaw(msg) { const id = msg.key?.id; if (!id) return; rawMessages.set(id, msg); if (rawMessages.size > RAW_MSG_CAP) { const first = rawMessages.keys().next().value; if (first) rawMessages.delete(first); } }

// ── Per-user session management ─────────────────────────────────────

const userActivity = new Map();
function sanitizeUserId(jid) { return formatJid(jid).replace(/[^a-zA-Z0-9]/g, "_"); }
function getUserDir(userId) {
  const dir = path.join(USERS_DIR, userId);
  for (const sub of ["inbox", "outbox", "permissions", "downloads"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}
function getUserSessionName(userId) { return `cc-ch-wa-${PHONE}-u-${userId}`; }

function isSessionRunning(sessionName) {
  try { execFileSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" }); return true; } catch { return false; }
}

function ensureUserConfig(userId, userJid) {
  const userDir = getUserDir(userId);
  const userWorkDir = path.join(userDir, "workspace");
  fs.mkdirSync(userWorkDir, { recursive: true });

  // Per-user MCP config
  fs.writeFileSync(path.join(userWorkDir, ".mcp.json"), JSON.stringify({
    mcpServers: { whatsapp: { command: "node", args: [path.join(__dirname, "bridge.cjs")], env: { BRIDGE_USER_DIR: userDir, BRIDGE_USER_JID: userJid, BRIDGE_PHONE: PHONE } } }
  }, null, 2));

  // Auto-approve settings — write to all possible path encodings Claude Code might use
  const autoApproveSettings = JSON.stringify({
    permissions: { allow: ["mcp__whatsapp__reply", "mcp__whatsapp__react", "mcp__whatsapp__download_attachment", "mcp__whatsapp__fetch_messages"] },
    enabledMcpjsonServers: ["whatsapp"], enableAllProjectMcpServers: true
  });
  const encodings = new Set([
    userWorkDir.replace(/\//g, "-"),
    userWorkDir.replace(/[/.]/g, "-"),
    userWorkDir.replace(/\//g, "-").replace(/-\./g, "."),
  ]);
  for (const enc of encodings) {
    const projDir = path.join(os.homedir(), ".claude", "projects", enc);
    fs.mkdirSync(projDir, { recursive: true });
    const sf = path.join(projDir, "settings.local.json");
    if (!fs.existsSync(sf)) fs.writeFileSync(sf, autoApproveSettings);
  }

  // Pre-populate .claude.json project entry so Claude Code auto-trusts the MCP server
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  try {
    const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
    if (!claudeJson.projects) claudeJson.projects = {};
    const projKey = userWorkDir;
    if (!claudeJson.projects[projKey] || !claudeJson.projects[projKey].hasTrustDialogAccepted) {
      claudeJson.projects[projKey] = {
        ...(claudeJson.projects[projKey] || {}),
        allowedTools: ["mcp__whatsapp__reply", "mcp__whatsapp__react", "mcp__whatsapp__download_attachment", "mcp__whatsapp__fetch_messages"],
        mcpServers: {},
        enabledMcpjsonServers: ["whatsapp"],
        enableAllProjectMcpServers: true,
        hasTrustDialogAccepted: true,
      };
      fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
    }
  } catch (e) { log(`failed to update .claude.json: ${e}`); }

  return { userDir, userWorkDir };
}

function spawnUserSession(userId, userJid) {
  const { userDir, userWorkDir } = ensureUserConfig(userId, userJid);
  const sessionName = getUserSessionName(userId);
  if (isSessionRunning(sessionName)) return;

  // Launcher script — pass --allowedTools to auto-approve MCP tools
  const launcher = path.join(userDir, "launch.sh");
  const allowedTools = "mcp__whatsapp__reply mcp__whatsapp__react mcp__whatsapp__download_attachment mcp__whatsapp__fetch_messages";
  fs.writeFileSync(launcher, `#!/bin/bash\ncd "${userWorkDir}"\nexec cc-watchdog --dangerously-load-development-channels "server:whatsapp" --allowedTools ${allowedTools}\n`);
  fs.chmodSync(launcher, 0o755);

  execFile("tmux", ["new-session", "-d", "-s", sessionName, "-x", "200", "-y", "50", launcher], (err) => {
    if (err) { log(`spawn failed for ${userId}: ${err}`); return; }
    log(`spawned ${sessionName}`);
    // Auto-approve interactive prompts
    const approve = () => execFile("tmux", ["send-keys", "-t", sessionName, "Enter"], () => {});
    setTimeout(approve, 5000);
    setTimeout(approve, 8000);
    setTimeout(approve, 11000);
  });
}

// ── Creds backup/restore ────────────────────────────────────────────

function maybeRestoreCredsFromBackup() {
  const cp = path.join(AUTH_DIR, "creds.json"), bp = path.join(AUTH_DIR, "creds.json.bak");
  try { JSON.parse(fs.readFileSync(cp, "utf8")); return; } catch {}
  try { JSON.parse(fs.readFileSync(bp, "utf8")); fs.copyFileSync(bp, cp); try { fs.chmodSync(cp, 0o600); } catch {} log("restored creds from backup"); } catch {}
}
let credsSaveQueue = Promise.resolve(); let saveCreds = null;
function enqueueSaveCreds() {
  if (!saveCreds) return;
  credsSaveQueue = credsSaveQueue.then(() => {
    const cp = path.join(AUTH_DIR, "creds.json"), bp = path.join(AUTH_DIR, "creds.json.bak");
    try { JSON.parse(fs.readFileSync(cp, "utf8")); fs.copyFileSync(cp, bp); try { fs.chmodSync(bp, 0o600); } catch {} } catch {}
    return saveCreds();
  }).then(() => { try { fs.chmodSync(path.join(AUTH_DIR, "creds.json"), 0o600); } catch {} })
    .catch((err) => { log(`creds save error: ${err}`); setTimeout(enqueueSaveCreds, 1000); });
}

// ── WhatsApp Connection ─────────────────────────────────────────────

let sock = null; let connectionReady = false; let retryCount = 0; let connectedAt = 0; let lastInboundAt = 0; let watchdogTimer = null;
function computeDelay(n) { const b = Math.min(RECONNECT.initialMs * Math.pow(RECONNECT.factor, n), RECONNECT.maxMs); return Math.max(250, Math.round(b + b * RECONNECT.jitter * (Math.random() * 2 - 1))); }
function cleanupSocket() { if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; } if (sock) { try { sock.ev.removeAllListeners(); } catch {} try { sock.end(undefined); } catch {} sock = null; } connectionReady = false; }

async function connectWhatsApp() {
  cleanupSocket(); maybeRestoreCredsFromBackup();
  const authState = await useMultiFileAuthState(AUTH_DIR);
  saveCreds = authState.saveCreds;
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ auth: { creds: authState.state.creds, keys: makeCacheableSignalKeyStore(authState.state.keys, logger) }, version, logger, printQRInTerminal: false, browser: ["Mac OS", "Safari", "1.0.0"], syncFullHistory: false, markOnlineOnConnect: false, getMessage: async (key) => { const c = rawMessages.get(key.id); return c?.message || { conversation: "" }; } });

  sock.ev.on("creds.update", enqueueSaveCreds);
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { qrcode.generate(qr, { small: true }, (code) => { log("scan QR code"); process.stderr.write(code + "\n"); }); }
    if (connection === "close") {
      connectionReady = false; const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === 440) { log("session conflict (440)"); return; }
      if (reason === DisconnectReason.loggedOut) { log("logged out (401)"); return; }
      if (reason === 515) { log("restart (515)"); setTimeout(connectWhatsApp, 2000); return; }
      if (connectedAt && Date.now() - connectedAt > HEALTHY_THRESHOLD) retryCount = 0;
      if (retryCount >= 15) { retryCount = 0; setTimeout(connectWhatsApp, 300000); return; }
      setTimeout(connectWhatsApp, computeDelay(retryCount++));
    }
    if (connection === "open") {
      connectionReady = true; connectedAt = Date.now(); retryCount = 0; log("connected");
      if (watchdogTimer) clearInterval(watchdogTimer);
      watchdogTimer = setInterval(() => { if (connectionReady && lastInboundAt && Date.now() - lastInboundAt > STALE_TIMEOUT) { log("stale"); connectWhatsApp(); } }, WATCHDOG_INTERVAL);
    }
  });
  if (sock.ws && typeof sock.ws.on === "function") sock.ws.on("error", (err) => log(`ws error: ${err}`));

  // ── Message handler ─────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages }) => {
    log(`messages.upsert: ${messages.length} message(s)`);
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      // Skip poll update messages (votes) — handled by messages.update listener
      if (msg.message.pollUpdateMessage) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith("@broadcast") || jid.endsWith("@status")) continue;
      const msgId = msg.key.id; const participant = msg.key.participant;
      if (msgId && isDuplicate(`${jid}:${msgId}`)) continue;

      // OTP — works for anyone
      if (!jid.endsWith("@g.us")) {
        const otp = loadOtp();
        if (otp && extractText(msg.message || {}).trim().toUpperCase() === otp.code) {
          if (otp.type === "admin") {
            fs.writeFileSync(ADMIN_FILE, JSON.stringify({ jid }) + "\n"); addToWhitelist(jid);
            try { fs.unlinkSync(OTP_FILE); } catch {}
            try { await sock.sendMessage(jid, { text: "\u2705 You are now the admin of this agent." }); } catch {}
            try { fs.appendFileSync(OTP_LOG_FILE, `${new Date().toISOString()} otp: ${formatJid(jid)} set as admin\n`); } catch {}
          } else {
            addToWhitelist(jid); try { fs.unlinkSync(OTP_FILE); } catch {}
            try { await sock.sendMessage(jid, { text: "\u2705 You've been verified! You can now message this agent." }); } catch {}
            try { fs.appendFileSync(OTP_LOG_FILE, `${new Date().toISOString()} otp: ${formatJid(jid)} verified\n`); } catch {}
          }
          continue;
        }
      }

      if (!isAllowed(jid, participant || undefined)) continue;

      // Permission replies from admin
      const msgText = extractText(msg.message || {});
      const permMatch = PERMISSION_REPLY_RE.exec(msgText);
      if (permMatch) {
        try { await sock.readMessages([msg.key]); } catch {}
        const behavior = permMatch[1].toLowerCase().startsWith("y") ? "allow" : "deny";
        const reqId = permMatch[2].toLowerCase();
        try { await sock.sendMessage(jid, { react: { text: behavior === "allow" ? "\u2705" : "\u274C", key: msg.key } }); } catch {}
        // Find the user with this pending permission
        try {
          for (const uid of fs.readdirSync(USERS_DIR)) {
            const reqFile = path.join(USERS_DIR, uid, "permissions", `request-${reqId}.json`);
            if (fs.existsSync(reqFile)) {
              const reqData = JSON.parse(fs.readFileSync(reqFile, "utf8"));
              fs.writeFileSync(path.join(USERS_DIR, uid, "permissions", `response-${reqId}.json`), JSON.stringify({ request_id: reqId, behavior }));
              fs.unlinkSync(reqFile);
              if (behavior === "deny") {
                execFile("tmux", ["send-keys", "-t", getUserSessionName(uid), "Escape"], () => {});
                if (reqData.user_jid) { try { await sock.sendMessage(reqData.user_jid, { text: "\u274C The admin denied the request. Please try rephrasing what you need." }); } catch {} }
              }
              break;
            }
          }
        } catch {}
        continue;
      }

      try { await sock.readMessages([msg.key]); } catch {}
      lastInboundAt = Date.now(); storeRaw(msg);

      // Route to per-user session
      const senderJid = participant || jid;
      const userId = sanitizeUserId(senderJid);
      const userDir = getUserDir(userId);
      userActivity.set(userId, Date.now());
      try { sock.sendPresenceUpdate("composing", jid); } catch {}

      // Save/update user meta (push name, jid, last seen)
      const metaFile = path.join(userDir, "meta.json");
      const pushName = msg.pushName || "";
      let userMeta = {};
      try { userMeta = JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch {}
      userMeta.jid = senderJid;
      userMeta.lastSeen = new Date().toISOString();
      if (pushName) userMeta.pushName = pushName;
      // Don't overwrite admin-set name
      if (!userMeta.name && pushName) userMeta.name = pushName;
      fs.writeFileSync(metaFile, JSON.stringify(userMeta, null, 2) + "\n");

      const text = extractText(msg.message); const media = extractMediaInfo(msg.message);
      const meta = { chat_id: jid, message_id: msgId, user: formatJid(senderJid), ts: new Date((Number(msg.messageTimestamp) || Date.now() / 1000) * 1000).toISOString() };
      if (media) { meta.attachment_count = "1"; meta.attachments = `${media.filename || media.type + "." + mimeToExt(media.mimetype)} (${media.mimetype}, ${(media.size / 1024).toFixed(0)}KB)`; }

      const inboxMsg = { content: text || (media ? `(${media.type})` : "(empty)"), meta, raw_msg_id: msgId };
      const tmp = path.join(userDir, "inbox", `.${Date.now()}-${msgId}.tmp`);
      const final = path.join(userDir, "inbox", `${Date.now()}-${msgId}.json`);
      fs.writeFileSync(tmp, JSON.stringify(inboxMsg)); fs.renameSync(tmp, final);

      spawnUserSession(userId, senderJid);
    }
  });

  // ── Poll vote handler (for permission approvals) ────────────────
  sock.ev.on("messages.update", async (updates) => {
    for (const update of updates) {
      if (!update.update?.pollUpdates) continue;
      const pollMsgId = update.key?.id;
      const pending = pendingPolls.get(pollMsgId);
      if (!pending) continue;

      // Get the votes
      for (const pollUpdate of update.update.pollUpdates) {
        const vote = pollUpdate.vote;
        if (!vote?.selectedOptions?.length) continue;

        // Decode the selected option
        const selected = vote.selectedOptions.map((o) => Buffer.from(o).toString("utf8"));
        const isAllow = selected.some((s) => s.includes("Allow"));
        const isDeny = selected.some((s) => s.includes("Deny"));

        if (!isAllow && !isDeny) continue;

        const behavior = isAllow ? "allow" : "deny";
        const { requestId, userId: uid, userJid } = pending;
        pendingPolls.delete(pollMsgId);

        // Write response for bridge
        const respFile = path.join(USERS_DIR, uid, "permissions", `response-${requestId}.json`);
        fs.writeFileSync(respFile, JSON.stringify({ request_id: requestId, behavior }));
        // Clean up request file
        try { fs.unlinkSync(path.join(USERS_DIR, uid, "permissions", `request-${requestId}.json`)); } catch {}

        if (behavior === "deny") {
          execFile("tmux", ["send-keys", "-t", getUserSessionName(uid), "Escape"], () => {});
          if (userJid) { try { await sock.sendMessage(userJid, { text: "\u274C The admin denied the request. Please try rephrasing what you need." }); } catch {} }
        }

        log(`poll vote: ${behavior} for request ${requestId} (user ${uid})`);
      }
    }
  });
}

// ── Per-user outbox processor ───────────────────────────────────────

let outboxBusy = false;
setInterval(async () => {
  if (!sock || !connectionReady || outboxBusy) return;
  outboxBusy = true;
  try {
    // Global outbox (admin OTP messages from menu)
    for (const f of fs.readdirSync(OUTBOX_DIR).filter((x) => x.endsWith(".json"))) {
      const fp = path.join(OUTBOX_DIR, f);
      try { const d = fs.readFileSync(fp, "utf8"); fs.unlinkSync(fp); const { jid: to, text } = JSON.parse(d); if (to && text) await sock.sendMessage(to, { text }); } catch (e) { log(`outbox: ${e}`); }
    }
    // Per-user outboxes
    for (const uid of (fs.readdirSync(USERS_DIR) || [])) {
      const odir = path.join(USERS_DIR, uid, "outbox");
      let files; try { files = fs.readdirSync(odir).filter((x) => x.endsWith(".json")).sort(); } catch { continue; }
      for (const f of files) {
        const fp = path.join(odir, f);
        try {
          const d = fs.readFileSync(fp, "utf8"); fs.unlinkSync(fp); const a = JSON.parse(d);
          if (a.action === "reply") {
            if (a.text) { const q = a.reply_to ? rawMessages.get(a.reply_to) : undefined; await sock.sendMessage(a.chat_id, { text: a.text }, q ? { quoted: q } : undefined); }
            for (const file of (a.files || [])) {
              const ext = path.extname(file).toLowerCase(); const buf = fs.readFileSync(file);
              if ([".jpg",".jpeg",".png",".gif",".webp"].includes(ext)) await sock.sendMessage(a.chat_id, { image: buf });
              else if ([".ogg",".mp3",".m4a",".wav"].includes(ext)) await sock.sendMessage(a.chat_id, { audio: buf, mimetype: ext === ".ogg" ? "audio/ogg; codecs=opus" : "audio/mpeg", ptt: ext === ".ogg" });
              else if ([".mp4",".mov",".avi"].includes(ext)) await sock.sendMessage(a.chat_id, { video: buf });
              else await sock.sendMessage(a.chat_id, { document: buf, mimetype: "application/octet-stream", fileName: path.basename(file) });
            }
            try { sock.sendPresenceUpdate("paused", a.chat_id); } catch {}
          } else if (a.action === "react") {
            await sock.sendMessage(a.chat_id, { react: { text: a.emoji, key: { remoteJid: a.chat_id, id: a.message_id } } });
          } else if (a.action === "download") {
            const raw = rawMessages.get(a.message_id);
            if (raw?.message) {
              const media = extractMediaInfo(raw.message);
              if (media) { const buf = await downloadMediaMessage(raw, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage }); const fn = media.filename || `${Date.now()}.${mimeToExt(media.mimetype)}`; fs.writeFileSync(path.join(USERS_DIR, uid, "downloads", `${a.message_id}-${fn}`), buf); }
            }
          } else if (a.action === "typing_start") { try { sock.sendPresenceUpdate("composing", a.chat_id); } catch {} }
          else if (a.action === "typing_stop") { try { sock.sendPresenceUpdate("paused", a.chat_id); } catch {} }
        } catch (e) { log(`user outbox ${uid}/${f}: ${e}`); }
      }
    }
  } catch (e) { log(`outbox scan: ${e}`); }
  outboxBusy = false;
}, 1500);

// ── Permission request relay (via polls) ────────────────────────────

// Map poll message IDs to { requestId, userId, userJid }
const pendingPolls = new Map();

setInterval(async () => {
  if (!sock || !connectionReady) return;
  const admin = loadAdmin(); if (!admin?.jid) return;
  try {
    for (const uid of fs.readdirSync(USERS_DIR)) {
      const pdir = path.join(USERS_DIR, uid, "permissions");
      let files; try { files = fs.readdirSync(pdir).filter((x) => x.startsWith("request-") && x.endsWith(".json")); } catch { continue; }
      for (const f of files) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(pdir, f), "utf8"));
          if (d._sent) continue; d._sent = true;
          fs.writeFileSync(path.join(pdir, f), JSON.stringify(d));

          let action = d.description || "";
          try { const p = JSON.parse(d.input_preview); if ((d.tool_name||"").includes("reply")||(d.tool_name||"").includes("whatsapp")) action = `Send reply: "${(p.text||"").slice(0,100)}"`; else if ((d.tool_name||"").toLowerCase().includes("bash")) action = `Run command: ${(p.command||d.input_preview).slice(0,100)}`; else action = `${d.description}: ${d.input_preview.slice(0,100)}`; } catch { if ((d.tool_name||"").toLowerCase().includes("bash")) action = `Run command: ${d.input_preview.slice(0,100)}`; }

          let displayName = d.user_number || uid;
          try { const meta = JSON.parse(fs.readFileSync(path.join(USERS_DIR, uid, "meta.json"), "utf8")); if (meta.name) displayName = meta.name; } catch {}

          // Send context message first
          const contextText = `\uD83D\uDD10 *Permission Request*\n\n\uD83D\uDC64 From: ${displayName}\n${d.user_message ? `\uD83D\uDCAC "${d.user_message.slice(0,100)}"\n` : ""}\n\u26A1 ${action}`;
          await sock.sendMessage(admin.jid, { text: contextText });

          // Send poll for approval
          const pollMsg = await sock.sendMessage(admin.jid, {
            poll: {
              name: `Approve this action?`,
              selectableCount: 1,
              values: ["\u2705 Allow", "\u274C Deny"],
            },
          });

          if (pollMsg?.key?.id) {
            pendingPolls.set(pollMsg.key.id, { requestId: d.request_id, userId: uid, userJid: d.user_jid });
          }

          if (d.user_jid) { try { await sock.sendMessage(d.user_jid, { text: "\u23F3 Waiting for admin approval..." }); } catch {} }
        } catch (e) { log(`perm relay ${uid}/${f}: ${e}`); }
      }
    }
  } catch {}
}, 1000);

// ── Idle session cleanup ────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [uid, last] of userActivity) {
    if (now - last > SESSION_IDLE_MS) {
      execFile("tmux", ["kill-session", "-t", getUserSessionName(uid)], () => {});
      userActivity.delete(uid); log(`killed idle session for ${uid}`);
    }
  }
}, 60000);

// ── Startup ─────────────────────────────────────────────────────────

process.on("unhandledRejection", (err) => { const m = String(err).toLowerCase(); if ((m.includes("unable to authenticate data")||m.includes("bad mac"))&&(m.includes("baileys")||m.includes("noise-handler")||m.includes("signal"))) { log("crypto error — reconnecting"); setTimeout(connectWhatsApp, 2000); return; } log(`rejection: ${err}`); });
process.on("uncaughtException", (err) => log(`exception: ${err}`));
process.setMaxListeners(50);
let shuttingDown = false;
function shutdown() { if (shuttingDown) return; shuttingDown = true; log("shutting down"); cleanupSocket(); setTimeout(() => process.exit(0), 2000); }
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
log("starting gateway..."); connectWhatsApp();
