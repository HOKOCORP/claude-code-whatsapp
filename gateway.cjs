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
const crypto = require("crypto");
const channelSlash = require("./lib/channel-slash.cjs");
const invites = require("./lib/invites.cjs");
const tmuxHelper = require("./lib/tmux.cjs");
const outboxReconciler = require("./lib/outbox-reconciler.cjs");
const { dispatchAck } = require("./lib/ack-dispatcher.cjs");
const { createAuditLogger } = require("./lib/audit-log.cjs");
const quotaScraper = require("./lib/quota-scraper.cjs");
const quotaCache = require("./lib/quota-cache.cjs");
const { detectTransitions } = require("./lib/quota-transitions.cjs");

const QUOTA_POLL_INTERVAL_MS = 5 * 60 * 1000;
const QUOTA_RENDER_DELAY_MS = 400;
const QUOTA_TAB_DELAY_MS = 200;
const QUOTA_LOAD_DELAY_MS = 500;
const QUOTA_LOAD_RETRIES = 6;
// Dedicated tmux session that runs its own idle `claude` process
// purely so the poller has a pane to scrape. Keeps the admin's
// active session free of /status flash + "Status dialog dismissed"
// chat-history pollution. Same auth, same quota bucket.
const QUOTA_SCRAPE_SESSION = "woofund-quota-scrape";
const QUOTA_SCRAPE_WORKDIR = "/tmp/woofund-quota-scrape-workspace";
const QUOTA_SCRAPE_BOOT_WAIT_MS = 12000;

// ── Config ──────────────────────────────────────────────────────────

const STATE_DIR = process.env.WHATSAPP_STATE_DIR || path.join(os.homedir(), ".claude", "channels", "whatsapp");
const ACCESS_FILE = path.join(STATE_DIR, "access.json");
const AUTH_DIR = path.join(STATE_DIR, "auth");
const OTP_LOG_FILE = path.join(STATE_DIR, "otp.log");
const OTP_FILE = path.join(STATE_DIR, "otp.json");
const ADMIN_FILE = path.join(STATE_DIR, "admin.json");
// Global admin — server-level identity that sees /usage quota %,
// receives cross-channel permission polls, and is the true "operator"
// of this ccm install. Lives at ~/.ccm/admin.json, shared across all
// channels run by the same Unix user. Per-channel ADMIN_FILE is kept
// for legacy callers (whitelist add/remove, channel-specific handoff)
// until the next cleanup pass; loadAdmin() prefers the global file
// and falls back to per-channel if global is absent.
const GLOBAL_ADMIN_FILE = path.join(os.homedir(), ".ccm", "admin.json");
const OUTBOX_DIR = path.join(STATE_DIR, "outbox");
const PHONE = path.basename(STATE_DIR).replace("whatsapp-", "");
const SESSION_IDLE_MS = 30 * 60 * 1000;
const USAGE_DIR = path.join(os.homedir(), ".ccm", "usage");
const USAGE_LIMITS_FILE = path.join(USAGE_DIR, "limits.json");
const DATABASES_CONFIG = path.join(os.homedir(), ".ccm", "databases.json");

// ── Isolation mode ────────────────────────────────────────────────
const ISOLATION_REQUESTED = process.env.CCM_ISOLATION === "1";
const ISOLATION = ISOLATION_REQUESTED && process.getuid && process.getuid() === 0;
if (ISOLATION_REQUESTED && !ISOLATION) {
  process.stderr.write("wa-gateway: WARNING: CCM_ISOLATION=1 set but gateway is not running as root — isolation disabled, falling back to single-user mode\n");
}
const IPC_BASE = ISOLATION
  ? path.join("/var/lib/ccm/channels", path.basename(STATE_DIR))
  : STATE_DIR;
const USERS_DIR = path.join(IPC_BASE, "users");
const ISOLATION_MAP = path.join(os.homedir(), ".ccm", "isolation-users.json");

fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(USERS_DIR, { recursive: true });
fs.mkdirSync(OUTBOX_DIR, { recursive: true });
fs.mkdirSync(USAGE_DIR, { recursive: true });
if (ISOLATION) {
  fs.mkdirSync(IPC_BASE, { recursive: true });
  process.stderr.write(`wa-gateway: isolation mode: IPC at ${IPC_BASE}\n`);
}

const logger = pino({ level: "silent" });
const log = (msg) => process.stderr.write(`wa-gateway: ${msg}\n`);

// Outbox redelivery (see docs/superpowers/specs/2026-04-14-outbox-redelivery-design.md)
const outboxAckedIds = new Set();
const OUTBOX_ACKED_TTL_MS = 60_000;

function markAcked(id) {
  if (!id || typeof id !== "string") return;
  outboxAckedIds.add(id);
  setTimeout(() => outboxAckedIds.delete(id), OUTBOX_ACKED_TTL_MS);
}

const outboxErroredIds = new Set();
function markErrored(id) {
  if (!id || typeof id !== "string") return;
  outboxErroredIds.add(id);
  setTimeout(() => outboxErroredIds.delete(id), OUTBOX_ACKED_TTL_MS);
}

// msgId → {filename, chatId, dir} — purged by unregisterFile on sendState removal.
const msgIdToFilename = new Map();
function registerMsgIds(dir, filename, msgIds, chatId) {
  for (const id of (msgIds || [])) {
    if (typeof id !== "string") continue;
    msgIdToFilename.set(id, { filename, chatId, dir });
  }
}
function unregisterFile(dir, filename) {
  for (const [id, v] of msgIdToFilename) {
    if (v.dir === dir && v.filename === filename) msgIdToFilename.delete(id);
  }
}

// dir → auditEvent(event, extras)
const outboxAuditors = new Map();

// ── USD wallet ─────────────────────────────────────────────────────
// Pay-as-you-go USD balance per user. New users start at $0 (blocked).
// Admin tops up in USD via cc-usage-monitor. Each API call deducts the
// estimated cost based on model-specific Anthropic pricing.
// Balance can go negative if a single call overshoots.
//
// Config:  ~/.ccm/usage/limits.json   (warn_balance in USD)
// Data:    ~/.ccm/usage/<userId>.json (balance in USD, history, monthly breakdown)

// API pricing: dollars per million tokens (current Anthropic rates)
const MODEL_PRICING = {
  "claude-opus-4-6":   { input: 15, output: 75, cache_5m: 18.75, cache_1h: 22.50, cache_read: 1.50 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_5m: 3.75, cache_1h: 4.50, cache_read: 0.30 },
  "claude-haiku-4-5":  { input: 0.80, output: 4, cache_5m: 1.00, cache_1h: 1.20, cache_read: 0.08 },
};

function getModelPricing(model) {
  for (const key of Object.keys(MODEL_PRICING)) { if (model.startsWith(key)) return MODEL_PRICING[key]; }
  return MODEL_PRICING["claude-sonnet-4-6"]; // default fallback
}

/** Calculate USD cost for a single API call's token usage */
function calcCallCost(usage, model) {
  const p = getModelPricing(model);
  const inp = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  const c5m = usage.cache_creation?.ephemeral_5m_input_tokens || 0;
  const c1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  return (inp * p.input + out * p.output + c5m * p.cache_5m + c1h * p.cache_1h + cr * p.cache_read) / 1e6;
}

function loadUsageConfig() {
  try { return JSON.parse(fs.readFileSync(USAGE_LIMITS_FILE, "utf8")); }
  catch { return { warn_balance: 1.00 }; } // warn when balance drops below $1.00
}

function getUserUsageFile(userId) {
  return path.join(USAGE_DIR, `${userId}.json`);
}

function loadUserUsage(userId) {
  try { return JSON.parse(fs.readFileSync(getUserUsageFile(userId), "utf8")); }
  catch {
    return {
      userId,
      balance: 0,        // current USD balance (can be negative)
      total_added: 0,    // lifetime USD added by admin
      total_cost: 0,     // lifetime estimated API cost in USD
      history: [],       // admin actions: [{ date, action, amount, note }]
      months: {},        // per-month token breakdown + cost
      offsets: {},       // incremental .jsonl scan offsets
    };
  }
}

function saveUserUsage(userId, usage) {
  fs.writeFileSync(getUserUsageFile(userId), JSON.stringify(usage, null, 2));
}

function monthKey() { return new Date().toISOString().slice(0, 7); }
function todayKey() { return new Date().toISOString().slice(0, 10); }

/**
 * Find all .jsonl session files for a user's workspace.
 */
function findUserSessionFiles(userId) {
  // In isolation mode, session files live in the project user's home, not admin's
  const projectUserHome = ISOLATION ? `/home/${isolationGetUsername(userId)}` : os.homedir();
  const projectsDir = path.join(projectUserHome, ".claude", "projects");
  const userWorkDir = ISOLATION
    ? path.join(projectUserHome, "workspace")
    : path.join(USERS_DIR, userId, "workspace");
  if (!fs.existsSync(projectsDir)) return [];

  const slugs = new Set([
    userWorkDir.replace(/\//g, "-"),
    userWorkDir.replace(/[/.]/g, "-"),
    userWorkDir.replace(/\//g, "-").replace(/-\./g, "."),
  ]);

  const files = [];
  for (const slug of slugs) {
    const projDir = path.join(projectsDir, slug);
    if (!fs.existsSync(projDir)) continue;
    try {
      for (const f of fs.readdirSync(projDir)) {
        if (f.endsWith(".jsonl")) files.push(path.join(projDir, f));
      }
      const subDir = path.join(projDir, "subagents");
      if (fs.existsSync(subDir)) {
        for (const sub of fs.readdirSync(subDir)) {
          const subPath = path.join(subDir, sub);
          if (sub.endsWith(".jsonl")) files.push(subPath);
          else if (fs.statSync(subPath).isDirectory()) {
            for (const f of fs.readdirSync(subPath)) {
              if (f.endsWith(".jsonl")) files.push(path.join(subPath, f));
            }
          }
        }
      }
    } catch {}
  }
  return [...new Set(files)];
}

/**
 * Scan .jsonl files incrementally. Deducts new usage from balance.
 * Keeps monthly + daily breakdown for billing reports.
 */
function syncUserUsage(userId) {
  const month = monthKey();
  const today = todayKey();
  const usage = loadUserUsage(userId);

  const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_5m: 0, cache_1h: 0, cache_read: 0, models: {} };
  if (!usage.months) usage.months = {};
  if (!usage.months[month]) usage.months[month] = { ...ZERO_USAGE, daily: {} };
  const mo = usage.months[month];
  if (!mo.daily) mo.daily = {};
  if (!mo.daily[today]) mo.daily[today] = { ...ZERO_USAGE };
  const day = mo.daily[today];
  if (!mo.models) mo.models = {};
  if (!usage.offsets) usage.offsets = {};

  let newCost = 0; // USD cost of new API calls since last scan
  const files = findUserSessionFiles(userId);
  for (const file of files) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const lastOffset = usage.offsets[file] || 0;
    if (stat.size <= lastOffset) continue;

    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(stat.size - lastOffset);
    fs.readSync(fd, buf, 0, buf.length, lastOffset);
    fs.closeSync(fd);

    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.includes('"type":"message"')) continue;
      try {
        const d = JSON.parse(line);
        if (d.type !== "message" && d.message?.type !== "message") continue;
        const msg = d.message || d;
        const u = msg.usage;
        if (!u) continue;
        const inp = u.input_tokens || 0;
        const out = u.output_tokens || 0;
        const c5m = u.cache_creation?.ephemeral_5m_input_tokens || 0;
        const c1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
        const cr = u.cache_read_input_tokens || 0;
        const model = msg.model || "unknown";

        // Accumulate into monthly + daily
        mo.input_tokens += inp;   day.input_tokens += inp;
        mo.output_tokens += out;  day.output_tokens += out;
        mo.cache_5m = (mo.cache_5m || 0) + c5m;   day.cache_5m = (day.cache_5m || 0) + c5m;
        mo.cache_1h = (mo.cache_1h || 0) + c1h;   day.cache_1h = (day.cache_1h || 0) + c1h;
        mo.cache_read = (mo.cache_read || 0) + cr; day.cache_read = (day.cache_read || 0) + cr;

        // Per-model tracking
        if (!mo.models[model]) mo.models[model] = { input_tokens: 0, output_tokens: 0, cache_5m: 0, cache_1h: 0, cache_read: 0 };
        const mm = mo.models[model];
        mm.input_tokens += inp; mm.output_tokens += out; mm.cache_5m += c5m; mm.cache_1h += c1h; mm.cache_read += cr;

        // Calculate USD cost for this call
        newCost += calcCallCost(u, model);
      } catch {}
    }
    usage.offsets[file] = stat.size;
  }

  // Deduct estimated cost from USD balance
  if (newCost > 0) {
    usage.balance = (usage.balance || 0) - newCost;
    usage.total_cost = (usage.total_cost || 0) + newCost;
    // Round to avoid floating point drift
    usage.balance = Math.round(usage.balance * 10000) / 10000;
    usage.total_cost = Math.round(usage.total_cost * 10000) / 10000;
  }

  // Keep last 3 months
  const months = Object.keys(usage.months).sort();
  while (months.length > 3) delete usage.months[months.shift()];

  saveUserUsage(userId, usage);
  return usage;
}

/**
 * Check if a user can send messages. Balance must be > 0.
 * Admin users are always allowed (unlimited usage).
 * Returns { allowed, balance, warned, isAdmin }
 */
function checkUserLimit(userId) {
  const usage = syncUserUsage(userId);
  const config = loadUsageConfig();
  const balance = usage.balance || 0;
  const warnAt = config.warn_balance || 1.00; // warn at $1.00

  // Admin is unlimited — still track cost but never block
  const admin = loadAdmin();
  const isAdmin = admin && userId === sanitizeUserId(admin.jid);
  if (isAdmin) {
    return { allowed: true, balance, warned: false, isAdmin: true };
  }

  return {
    allowed: balance > 0,
    balance,
    warned: balance > 0 && balance <= warnAt,
    isAdmin: false,
  };
}

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;
const RECONNECT = { initialMs: 2000, maxMs: 30000, factor: 1.8, jitter: 0.25 };
const WATCHDOG_INTERVAL = 60 * 1000;
const STALE_TIMEOUT = 30 * 60 * 1000;
const HEALTHY_THRESHOLD = 60 * 1000;

// ── Access Control ──────────────────────────────────────────────────

function defaultAccess() { return { allowFrom: [], allowGroups: false, allowedGroups: [], requireAllowFromInGroups: false, groupTrigger: "" }; }
function loadAccess() {
  try { return { ...defaultAccess(), ...JSON.parse(fs.readFileSync(ACCESS_FILE, "utf8")) }; }
  catch (err) { if (err.code === "ENOENT") return defaultAccess(); try { fs.renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`); } catch {} return defaultAccess(); }
}
function toJid(phone) { return phone.includes("@") ? phone : `${phone.replace(/[^0-9]/g, "")}@s.whatsapp.net`; }
function isAllowed(jid, participant) {
  const access = loadAccess();
  if (jid.endsWith("@g.us")) { if (!access.allowGroups) return false; if (!access.allowedGroups.includes(jid)) return false; if (access.requireAllowFromInGroups && participant) return access.allowFrom.some((a) => toJid(a) === participant || a === participant); return true; }
  if (access.allowFrom.length === 0) return true;
  return access.allowFrom.some((a) => toJid(a) === jid || a === jid);
}
function addToWhitelist(jid) {
  const access = loadAccess();
  if (!access.allowFrom.some((a) => toJid(a) === jid || a === jid)) { access.allowFrom.push(jid); fs.writeFileSync(ACCESS_FILE, JSON.stringify(access, null, 2) + "\n"); log(`whitelist: added ${jid}`); }
}
function loadAdmin() {
  // Prefer the server-level global admin when present. Fall back to
  // the per-channel admin file for backward compatibility — on every
  // successful fallback we also write the global file so the next
  // boot sees it natively (auto-migration without needing a separate
  // step). Both reads swallow errors and return null on any parse
  // failure, so a corrupt file can't crash the gateway.
  try {
    const g = JSON.parse(fs.readFileSync(GLOBAL_ADMIN_FILE, "utf8"));
    if (g && g.jid) return g;
  } catch {}
  try {
    const local = JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
    if (local && local.jid) {
      try {
        fs.mkdirSync(path.dirname(GLOBAL_ADMIN_FILE), { recursive: true });
        fs.writeFileSync(GLOBAL_ADMIN_FILE, JSON.stringify(local) + "\n");
      } catch {}
      return local;
    }
  } catch {}
  return null;
}

function adminQuotaFilePath() { return path.join(IPC_BASE, "admin-quota.json"); }

function adminTmuxSession() {
  const admin = loadAdmin();
  if (!admin || !admin.jid) return null;
  return getUserSessionName(sanitizeUserId(admin.jid));
}

async function runTmuxSendKeys(session, keys) {
  return new Promise((resolve, reject) => {
    execFile("tmux", ["send-keys", "-t", `${session}.0`, ...keys], (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

async function runTmuxCapturePane(session) {
  return new Promise((resolve, reject) => {
    execFile("tmux", ["capture-pane", "-t", `${session}.0`, "-p"], (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

const quotaSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmuxSessionExists(name) {
  return new Promise((resolve) => {
    execFile("tmux", ["has-session", "-t", name], (err) => resolve(!err));
  });
}

// Make sure the dedicated quota-scrape session exists and is running
// a claude process ready to answer /status. Idempotent — a second
// call while the session exists is a no-op. On cold boot we spend
// the full BOOT_WAIT_MS (~12s) waiting for claude's welcome screen
// to settle before the first scrape; subsequent calls return immediately.
let quotaScrapeReadyPromise = null;
async function ensureQuotaScrapeSession() {
  if (quotaScrapeReadyPromise) return quotaScrapeReadyPromise;
  quotaScrapeReadyPromise = (async () => {
    try {
      fs.mkdirSync(QUOTA_SCRAPE_WORKDIR, { recursive: true });
      if (await tmuxSessionExists(QUOTA_SCRAPE_SESSION)) {
        return true;
      }
      await new Promise((resolve, reject) => {
        execFile(
          "tmux",
          [
            "new-session", "-d",
            "-s", QUOTA_SCRAPE_SESSION,
            "-c", QUOTA_SCRAPE_WORKDIR,
            // Claude Code 2.1.110 refuses --dangerously-skip-permissions
            // and --permission-mode bypassPermissions when the process
            // runs as root/sudo. Our quota scraper only sends "/status"
            // into a read-only dialog — no tool execution happens, so
            // no permission flag is needed at all. Just start plain
            // claude; tmux will attach a PTY and the scraper drives it.
            "claude",
          ],
          (err) => (err ? reject(err) : resolve()),
        );
      });
      // Claude's first-run shows a "trust this folder?" prompt. Enter
      // confirms "Yes, I trust this folder" (the default highlight),
      // then claude renders the welcome screen and prompt. If the
      // folder is already trusted (subsequent boots) the Enter key
      // lands on an empty prompt and is harmless.
      await quotaSleep(2500);
      await runTmuxSendKeys(QUOTA_SCRAPE_SESSION, ["Enter"]);
      await quotaSleep(QUOTA_SCRAPE_BOOT_WAIT_MS - 2500);
      return true;
    } catch (e) {
      log(`quota scrape session boot error: ${e.stack || e}`);
      quotaScrapeReadyPromise = null; // allow retry on next call
      return false;
    }
  })();
  return quotaScrapeReadyPromise;
}

async function captureAdminQuota() {
  const admin = loadAdmin();
  if (!admin || !admin.jid) return null;
  const ready = await ensureQuotaScrapeSession();
  if (!ready) return null;
  return quotaScraper.captureQuota({
    tmuxSession: QUOTA_SCRAPE_SESSION,
    sendKeys: runTmuxSendKeys,
    capturePane: runTmuxCapturePane,
    sleep: quotaSleep,
    renderDelayMs: QUOTA_RENDER_DELAY_MS,
    tabDelayMs: QUOTA_TAB_DELAY_MS,
    loadDelayMs: QUOTA_LOAD_DELAY_MS,
    loadRetries: QUOTA_LOAD_RETRIES,
  });
}

function emitQuotaAlert(breach, adminJid, adminUserDir) {
  const icon = breach.threshold === 10 ? "🚨" : "⚠️";
  const label = breach.window === "session" ? "Session" : "Weekly";
  const tail = breach.threshold === 10 ? " — near exhaustion" : "";
  const text = `${icon} ${label} quota at ${breach.remaining}% remaining${tail} (crossed ${breach.threshold}% threshold)`;
  const filename = `${Date.now()}-quota-${breach.window}_${breach.threshold}.json`;
  const fp = path.join(adminUserDir, "outbox", filename);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ action: "reply", chat_id: adminJid, text }));
}

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

async function handleInviteCommands({ sock, msg, jid }) {
  const rawText = extractText(msg.message || {}).trim();
  const lower = rawText.toLowerCase();

  const inviteMatch = /^\/invite(?:\s+(\d+(?:\.\d{1,2})?))?\s*$/i.exec(rawText);
  if (inviteMatch) {
    const adminCheck = loadAdmin();
    const isAdminUser = adminCheck && (adminCheck.jid === jid || toJid(adminCheck.jid) === jid);
    if (!isAdminUser) {
      try { await sock.sendMessage(jid, { text: "🚫 /invite is admin-only." }); } catch {}
      return true;
    }
    const preFundUsd = inviteMatch[1] ? Number(inviteMatch[1]) : 0;
    const invite = invites.createInvite(STATE_DIR, jid, { preFundUsd });
    const expiry = new Date(invite.expires_at).toISOString().split("T")[0];
    const link = `https://wa.me/${PHONE}?text=${encodeURIComponent(`/redeem ${invite.code}`)}`;
    // Reply IS the forwardable invite — admin long-presses + forwards as-is.
    const lines = ["👋 You've been invited to HOKO Coder — your personal coding agent on WhatsApp.", ""];
    if (preFundUsd > 0) lines.push(`💰 Includes $${preFundUsd.toFixed(2)} of credit.`, "");
    lines.push(`Tap below to accept (single-use, expires ${expiry}):`, link);
    try { await sock.sendMessage(jid, { text: lines.join("\n") }); } catch (e) { log(`/invite reply failed: ${e}`); }
    log(`invite created: ${invite.code}${preFundUsd > 0 ? ` ($${preFundUsd.toFixed(2)})` : ""} by ${formatJid(jid)}`);
    try { await sock.readMessages([msg.key]); } catch {}
    return true;
  }

  const redeemMatch = /^\/redeem\s+(\S+)\s*$/i.exec(rawText);
  if (redeemMatch) {
    try { await sock.readMessages([msg.key]); } catch {}
    const result = invites.redeemInvite(STATE_DIR, redeemMatch[1], jid);
    if (!result.ok) {
      const reasonText = {
        missing_code: "Code missing — usage: `/redeem CODE`.",
        unknown: "Invite code not recognised.",
        expired: "That invite expired. Ask the admin for a fresh one.",
        already_used: "That invite has already been redeemed.",
      }[result.reason] || "Invite couldn't be redeemed.";
      try { await sock.sendMessage(jid, { text: `❌ ${reasonText}` }); } catch {}
      log(`invite redeem failed (${result.reason}): ${formatJid(jid)} tried ${redeemMatch[1]}`);
      return true;
    }
    addToWhitelist(jid);
    const redeemerUserId = sanitizeUserId(jid);
    // Apply pre-fund credit (if any) to redeemer's balance + log to audit.
    const preFund = Number(result.invite.pre_fund_usd) || 0;
    if (preFund > 0) {
      const u = loadUserUsage(redeemerUserId);
      u.balance = (u.balance || 0) + preFund;
      u.total_added = (u.total_added || 0) + preFund;
      u.history = u.history || [];
      u.history.push({ date: todayKey(), action: "topup", amount: preFund, note: "invite from admin" });
      saveUserUsage(redeemerUserId, u);
    }
    // Subdomain isn't provisioned until first spawn (ensureProjectUser
    // runs domainsProvision then). Predict the URL deterministically
    // from the same hash inputs so the welcome message can include it.
    let subdomainNote = "";
    if (ISOLATION && process.env.DOMAIN_ROOT) {
      const hash = isolationHash(path.basename(STATE_DIR), redeemerUserId);
      subdomainNote = `🌐 Your project will be hosted at: https://${hash}.${process.env.DOMAIN_ROOT}\n\n`;
    }
    try {
      const lines = [
        "👋 *Welcome to HOKO Coder*",
        "",
        "I'm your personal coding agent on WhatsApp — describe what you want to build and I'll go.",
        "",
      ];
      if (preFund > 0) lines.push(`💰 Starting balance: $${preFund.toFixed(2)}`, "");
      if (subdomainNote) lines.push(subdomainNote.trimEnd());
      lines.push("Send `/help` to see all commands. Then send me your first message to get started.");
      await sock.sendMessage(jid, { text: lines.join("\n") });
    } catch (e) { log(`/redeem welcome failed: ${e}`); }
    log(`invite redeemed: ${result.invite.code}${preFund > 0 ? ` (+$${preFund.toFixed(2)})` : ""} by ${formatJid(jid)}`);
    return true;
  }

  return false;
}

// Grant the admin's isolated ccm user read access to /root/.env so
// their claude session inherits GITHUB_TOKEN / CF_TOKEN / etc from
// ccm Settings. Uses a POSIX ACL so /root/.env stays 600 root:root
// — only this specific ccm user gets an extra read ACE, no new group.
// Plus a symlink in the user's home so cc-watchdog's "source
// ~/.env" line picks up the live file (updates via ccm Settings
// propagate to new sessions without a copy step).
function grantAdminEnvAccess(username, homeDir) {
  const rootEnv = path.join(os.homedir(), ".env");
  if (!fs.existsSync(rootEnv)) return;
  try {
    execFileSync("setfacl", ["-m", `u:${username}:r`, rootEnv]);
  } catch (e) {
    log(`setfacl on ~/.env failed for ${username}: ${e.message}`);
    return;
  }
  const userEnv = path.join(homeDir, ".env");
  try {
    // Remove stale file/symlink before re-linking so this is idempotent.
    const st = fs.lstatSync(userEnv);
    if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(userEnv);
  } catch {}
  try {
    fs.symlinkSync(rootEnv, userEnv);
    execFileSync("chown", ["-h", `${username}:${username}`, userEnv]);
  } catch (e) {
    log(`~/.env symlink failed for ${username}: ${e.message}`);
  }
}

// In-group admin commands — enable/disable the bot for a group and
// configure its trigger word, without needing SSH or DM'ing a JID in.
// Must be invoked BEFORE isAllowed() so the very first /enable-group in
// a brand-new group can register it.
async function handleGroupAdminCommands({ sock, msg, jid, participant }) {
  if (!jid.endsWith("@g.us")) return false;
  const rawText = extractText(msg.message || {}).trim();
  const lower = rawText.toLowerCase();
  const match = lower === "/enable-group"
             || lower === "/disable-group"
             || lower === "/direct on" || lower === "/direct off"
             || /^\/trigger\s+\S+/i.test(rawText)
             || /^\/group-token(\s|$)/i.test(rawText);
  if (!match) return false;

  const senderJid = participant || "";
  const adminCheck = loadAdmin();
  const isAdminSender = adminCheck && (
    adminCheck.jid === senderJid
    || toJid(adminCheck.jid) === senderJid
    || formatJid(adminCheck.jid) === formatJid(senderJid)
  );
  if (!isAdminSender) {
    // Silent: don't leak the command surface to non-admin group members.
    return false;
  }

  const access = loadAccess();
  const persist = () => fs.writeFileSync(ACCESS_FILE, JSON.stringify(access, null, 2) + "\n");

  if (lower === "/enable-group") {
    access.allowGroups = true;
    if (!access.allowedGroups.includes(jid)) access.allowedGroups.push(jid);
    persist();
    const trigger = access.groupTrigger || "@ai";
    // Predict subdomain (same logic as invite welcome message)
    let subdomainNote = "";
    if (ISOLATION && process.env.DOMAIN_ROOT) {
      const groupUserId = sanitizeUserId(jid);
      const hash = isolationHash(path.basename(STATE_DIR), groupUserId);
      subdomainNote = `\n🌐 Project subdomain: https://${hash}.${process.env.DOMAIN_ROOT}\n`;
    }
    try {
      await sock.sendMessage(jid, { text:
        "✅ Group enabled. I'll respond when:\n"
        + `• you mention *${trigger}*\n`
        + "• you reply to one of my messages\n"
        + subdomainNote
        + "\nAdmins can run `/disable-group` to turn me off here, or `/trigger WORD` to change the mention keyword."
      });
    } catch {}
    log(`group enabled: ${jid} by ${formatJid(senderJid)}`);
    return true;
  }

  if (lower === "/disable-group") {
    access.allowedGroups = access.allowedGroups.filter((g) => g !== jid);
    persist();
    try { await sock.sendMessage(jid, { text: "✅ Group disabled. I'll stop responding here. Run `/enable-group` to turn me back on." }); } catch {}
    log(`group disabled: ${jid} by ${formatJid(senderJid)}`);
    return true;
  }

  const triggerMatch = /^\/trigger\s+(\S+)\s*$/i.exec(rawText);
  if (triggerMatch) {
    const newTrigger = triggerMatch[1].slice(0, 32);
    access.groupTrigger = newTrigger;
    persist();
    try { await sock.sendMessage(jid, { text: `✅ Trigger set to *${newTrigger}*. Mention it in any enabled group to summon me.` }); } catch {}
    log(`trigger changed to "${newTrigger}" by ${formatJid(senderJid)}`);
    return true;
  }

  // /direct on|off — toggle direct mode for this group
  if (lower === "/direct on") {
    if (!access.directGroups) access.directGroups = [];
    if (!access.directGroups.includes(jid)) access.directGroups.push(jid);
    persist();
    try { await sock.sendMessage(jid, { text: "✅ Direct mode *ON*. I'll respond to every message in this group — no @ai or reply needed." }); } catch {}
    log(`direct mode ON for ${jid} by ${formatJid(senderJid)}`);
    return true;
  }
  if (lower === "/direct off") {
    if (access.directGroups) access.directGroups = access.directGroups.filter((g) => g !== jid);
    persist();
    const trigger = access.groupTrigger || "@ai";
    try { await sock.sendMessage(jid, { text: `✅ Direct mode *OFF*. Back to normal — mention *${trigger}* or reply to my messages.` }); } catch {}
    log(`direct mode OFF for ${jid} by ${formatJid(senderJid)}`);
    return true;
  }

  // /group-token — per-group env vars. Kept separate from /root/.env so
  // regular group members can't exfiltrate admin-wide tokens. Admin sets
  // specific tokens per group; the launcher for that group exports only
  // those. Storage: <groupUserDir>/env (line-based KEY=VALUE).
  if (/^\/group-token(\s|$)/i.test(rawText)) {
    const groupUserId = sanitizeUserId(jid);
    const groupUserDir = path.join(USERS_DIR, groupUserId);
    const envFile = path.join(groupUserDir, "env");
    fs.mkdirSync(groupUserDir, { recursive: true });

    const parseEnv = () => {
      const out = {};
      try {
        for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
          const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
          if (m) out[m[1]] = m[2];
        }
      } catch {}
      return out;
    };
    const writeEnv = (obj) => {
      const body = Object.keys(obj).sort().map((k) => `${k}=${obj[k]}`).join("\n") + (Object.keys(obj).length ? "\n" : "");
      fs.writeFileSync(envFile, body);
      try { fs.chmodSync(envFile, 0o640); } catch {}
      if (ISOLATION) {
        const gUser = isolationGetUsername(groupUserId);
        try { execFileSync("id", [gUser], { stdio: "ignore" }); execFileSync("chown", [`${gUser}:ccm-gw`, envFile]); } catch {}
      }
    };

    const body = rawText.replace(/^\/group-token\s*/i, "").trim();

    if (body === "" || /^list$/i.test(body)) {
      const env = parseEnv();
      const keys = Object.keys(env).sort();
      const lines = keys.length
        ? ["🔐 Group tokens:", ...keys.map((k) => `• ${k}  (${env[k].length} chars)`)]
        : ["🔐 No group tokens set yet.", "", "Set one: /group-token KEY=VALUE"];
      try { await sock.sendMessage(jid, { text: lines.join("\n") }); } catch {}
      return true;
    }

    const unsetMatch = /^unset\s+([A-Z_][A-Z0-9_]*)\s*$/i.exec(body);
    if (unsetMatch) {
      const key = unsetMatch[1].toUpperCase();
      const env = parseEnv();
      if (env[key] == null) {
        try { await sock.sendMessage(jid, { text: `❌ ${key} isn't set for this group.` }); } catch {}
        return true;
      }
      delete env[key];
      writeEnv(env);
      log(`group-token unset ${key} in ${jid} by ${formatJid(senderJid)}`);
      try { await sock.sendMessage(jid, { text: `✅ Unset ${key}. Restart spawn by messaging the bot to pick up the change.` }); } catch {}
      return true;
    }

    const setMatch = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/i.exec(body);
    if (setMatch) {
      const key = setMatch[1].toUpperCase();
      const value = setMatch[2];
      if (value.length > 4096) {
        try { await sock.sendMessage(jid, { text: "❌ Value too long (max 4096 chars)." }); } catch {}
        return true;
      }
      const env = parseEnv();
      env[key] = value;
      writeEnv(env);
      log(`group-token set ${key} in ${jid} by ${formatJid(senderJid)}`);
      // Delete the original message so the raw token doesn't sit in the
      // group chat history. Best-effort — only works if we're admin.
      try { await sock.sendMessage(jid, { delete: msg.key }); } catch {}
      try { await sock.sendMessage(jid, { text: `✅ Set ${key} for this group (${value.length} chars). I tried to delete your original message so the raw value isn't in chat history — check that it's gone.` }); } catch {}
      return true;
    }

    try {
      await sock.sendMessage(jid, { text:
        "Usage:\n"
        + "/group-token KEY=VALUE   set a token\n"
        + "/group-token unset KEY   remove a token\n"
        + "/group-token list        show current tokens"
      });
    } catch {}
    return true;
  }

  return false;
}

// Look up the public subdomain assigned to a userId via the isolation
// map. Returns the URL string (e.g. "https://b6ed73fb17c7.clawdas.com")
// or null if the user doesn't have one (no isolation, no domains, or
// the mapping hasn't been written yet).
function getUserSubdomainUrl(userId) {
  if (!ISOLATION) return null;
  const username = isolationGetUsername(userId);
  let mapping = {};
  try { mapping = JSON.parse(fs.readFileSync(ISOLATION_MAP, "utf8")); } catch { return null; }
  const entry = mapping[username];
  if (!entry?.subdomain) return null;
  return `https://${entry.subdomain}`;
}

// Hash displayed in /users for a given userId + meta. Matches what
// users see so /topup / /rename lookups stay consistent.
//   - Isolation on (users AND groups): ccm-<12> hex from isolationGetUsername
//   - Non-isolation: first 12 chars of the userId
function displayHashFor(uid, meta) {
  if (ISOLATION) {
    return isolationGetUsername(uid).replace(/^ccm-/, "");
  }
  return uid.slice(0, 12);
}

// Resolve a hash prefix (or full ccm-XXXXX form) to a userId by scanning
// USERS_DIR. Returns { userId, username, isGroup } or null. Groups are
// included so admin can /topup or /rename them too.
function findUserByHashPrefix(hashPrefix) {
  const needle = String(hashPrefix || "").trim().replace(/^ccm-/i, "").toLowerCase();
  if (needle.length < 4) return null;
  let entries;
  try { entries = fs.readdirSync(USERS_DIR); } catch { return null; }
  const matches = [];
  for (const uid of entries) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(USERS_DIR, uid, "meta.json"), "utf8")); } catch { continue; }
    const hash = displayHashFor(uid, meta);
    if (hash.toLowerCase().startsWith(needle)) {
      const username = ISOLATION ? isolationGetUsername(uid) : null;
      matches.push({ userId: uid, username, isGroup: !!meta.isGroup });
    }
  }
  if (matches.length === 1) return matches[0];
  return null;
}

async function handleAdminUserCommands({ sock, msg, jid }) {
  const rawText = extractText(msg.message || {}).trim();
  const lower = rawText.toLowerCase();

  // All commands here are admin-only.
  if (lower !== "/users"
      && !/^\/rename\s+/i.test(rawText)
      && !/^\/topup\s+/i.test(rawText)) {
    return false;
  }

  const adminCheck = loadAdmin();
  const isAdminUser = adminCheck && (adminCheck.jid === jid || toJid(adminCheck.jid) === jid);
  if (!isAdminUser) {
    try { await sock.sendMessage(jid, { text: "🚫 That command is admin-only." }); } catch {}
    return true;
  }

  if (lower === "/users") {
    let entries;
    try { entries = fs.readdirSync(USERS_DIR); } catch { entries = []; }
    const adminJid = adminCheck?.jid;
    // The bot's own phone shows up as a "user" if anything ever DMed it
    // from itself — filter it out, it's never a real user.
    const ownNumber = String(PHONE || "");
    const rows = [];
    for (const uid of entries) {
      if (ownNumber && uid === ownNumber) continue;
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(USERS_DIR, uid, "meta.json"), "utf8")); } catch { continue; }
      const isGroup = !!meta.isGroup;
      // Groups have their own wallet keyed by the group JID — show them
      // so admin can /topup them. In isolation mode, groups get their own
      // Linux account and subdomain, same as individual users.
      const hash = displayHashFor(uid, meta);
      const name = meta.name || meta.pushName || formatJid(meta.jid || uid);
      const isAdminRow = !isGroup && adminJid && (meta.jid === adminJid || toJid(adminJid) === meta.jid);
      const u = loadUserUsage(uid);
      const lastSeen = meta.lastSeen ? meta.lastSeen.slice(0, 10) : "—";
      rows.push({ hash, name, isAdmin: isAdminRow, isGroup, balance: u.balance || 0, lastSeen });
    }
    rows.sort((a, b) =>
      Number(b.isAdmin) - Number(a.isAdmin)
      || Number(a.isGroup) - Number(b.isGroup)  // users above groups
      || a.name.localeCompare(b.name)
    );
    const lines = [`👥 *Users* (${rows.length})`, ""];
    if (rows.length === 0) lines.push("No users yet — share an /invite link.");
    for (const r of rows) {
      const badge = r.isAdmin ? " 👑" : (r.isGroup ? " 👥" : "");
      const balText = r.isAdmin ? "unlimited (admin)" : `$${r.balance.toFixed(2)}`;
      lines.push(`\`${r.hash}\` · ${r.name}${badge}`);
      lines.push(`  bal ${balText} · last ${r.lastSeen}`);
    }
    try { await sock.sendMessage(jid, { text: lines.join("\n") }); } catch (e) { log(`/users reply failed: ${e}`); }
    try { await sock.readMessages([msg.key]); } catch {}
    return true;
  }

  const renameMatch = /^\/rename\s+(\S+)\s+(.+?)\s*$/i.exec(rawText);
  if (renameMatch) {
    try { await sock.readMessages([msg.key]); } catch {}
    const target = findUserByHashPrefix(renameMatch[1]);
    if (!target) {
      try { await sock.sendMessage(jid, { text: `❌ No unique user matched \`${renameMatch[1]}\`. Use 4+ chars from /users.` }); } catch {}
      return true;
    }
    const newName = renameMatch[2].trim().slice(0, 64);
    const metaFile = path.join(USERS_DIR, target.userId, "meta.json");
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch {}
    meta.name = newName;
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n");
    const labelHash = target.username ? target.username.replace(/^ccm-/, "") : target.userId.slice(0, 12);
    log(`renamed ${target.username || target.userId} -> ${newName} by ${formatJid(jid)}`);
    try { await sock.sendMessage(jid, { text: `✅ \`${labelHash}\` is now *${newName}*.` }); } catch {}
    return true;
  }

  const topupMatch = /^\/topup\s+(\S+)\s+(\d+(?:\.\d{1,2})?)\s*$/i.exec(rawText);
  if (topupMatch) {
    try { await sock.readMessages([msg.key]); } catch {}
    const target = findUserByHashPrefix(topupMatch[1]);
    if (!target) {
      try { await sock.sendMessage(jid, { text: `❌ No unique user matched \`${topupMatch[1]}\`. Use 4+ chars from /users.` }); } catch {}
      return true;
    }
    const amount = Number(topupMatch[2]);
    if (!Number.isFinite(amount) || amount <= 0) {
      try { await sock.sendMessage(jid, { text: "❌ Amount must be a positive number." }); } catch {}
      return true;
    }
    const u = loadUserUsage(target.userId);
    u.balance = (u.balance || 0) + amount;
    u.total_added = (u.total_added || 0) + amount;
    u.history = u.history || [];
    u.history.push({ date: todayKey(), action: "topup", amount, note: "admin top-up" });
    saveUserUsage(target.userId, u);
    log(`topup +$${amount.toFixed(2)} -> ${target.username || target.userId} by ${formatJid(jid)} (new balance $${u.balance.toFixed(2)})`);
    try {
      let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(USERS_DIR, target.userId, "meta.json"), "utf8")); } catch {}
      const displayName = meta.name || meta.pushName || formatJid(meta.jid || target.userId);
      const kind = target.isGroup ? "group" : "user";
      await sock.sendMessage(jid, { text: `✅ Topped up ${kind} *${displayName}* with $${amount.toFixed(2)} — new balance $${u.balance.toFixed(2)}.` });
    } catch {}
    return true;
  }

  return false;
}

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
  // In isolation mode, fix ownership ONLY if the project user already exists.
  // On first message the user hasn't been created yet (ensureProjectUser runs
  // later in ensureUserConfig). Trying to chown to a non-existent user causes
  // cascading errors that can skip domain/database provisioning.
  if (ISOLATION) {
    const username = isolationGetUsername(userId);
    try {
      execFileSync("id", [username], { stdio: "ignore" });
      // User exists — safe to chown
      try { execFileSync("chown", ["-R", `${username}:ccm-gw`, dir]); } catch {}
      try { execFileSync("chmod", ["770", dir]); } catch {}
    } catch {
      // User doesn't exist yet — skip chown, ensureProjectUser will handle it
    }
  }
  return dir;
}
function getUserSessionName(userId) { return `cc-ch-wa-${PHONE}-u-${userId}`; }

// ── Isolation: per-user Unix account management ───────────────────

function isolationHash(channelBase, userId) {
  return crypto.createHash("sha256").update(`${channelBase}:${userId}`).digest("hex").slice(0, 12);
}

function isolationGetUsername(userId) {
  return `ccm-${isolationHash(path.basename(STATE_DIR), userId)}`;
}

// ── Database provisioning ─────────────────────────────────────────

function databasesInstalled() {
  try {
    const cfg = JSON.parse(fs.readFileSync(DATABASES_CONFIG, "utf8"));
    return {
      postgresql: !!(cfg.postgresql && cfg.postgresql.installed),
      mariadb: !!(cfg.mariadb && cfg.mariadb.installed),
      redis: !!(cfg.redis && cfg.redis.installed),
    };
  } catch {
    return { postgresql: false, mariadb: false, redis: false };
  }
}

function dbName(username) {
  return username.replace(/-/g, "_");
}

function dbRandomPassword() {
  return crypto.randomBytes(24).toString("base64url").slice(0, 32);
}

function databasesProvision(username) {
  const engines = databasesInstalled();
  if (!engines.postgresql && !engines.mariadb && !engines.redis) return null;

  const sqlName = dbName(username);
  const result = {};

  if (engines.postgresql) {
    try {
      const check = execFileSync("sudo", ["-u", "postgres", "psql", "-tAc",
        `SELECT 1 FROM pg_roles WHERE rolname='${sqlName}'`], { encoding: "utf8" }).trim();
      if (check !== "1") {
        const pw = dbRandomPassword();
        execFileSync("sudo", ["-u", "postgres", "psql", "-c",
          `CREATE USER ${sqlName} WITH PASSWORD '${pw}'`], { stdio: "ignore" });
        execFileSync("sudo", ["-u", "postgres", "psql", "-c",
          `CREATE DATABASE ${sqlName} OWNER ${sqlName}`], { stdio: "ignore" });
        result.postgresql = { password: pw };
        log(`databases: provisioned PostgreSQL db+user ${sqlName}`);
      } else {
        log(`databases: PostgreSQL user ${sqlName} already exists`);
      }
    } catch (e) {
      log(`databases: PostgreSQL provision failed for ${sqlName}: ${e.message}`);
    }
  }

  if (engines.mariadb) {
    try {
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(DATABASES_CONFIG, "utf8")); } catch {}
      const adminPw = cfg.mariadb?.adminPassword || "";
      const check = execFileSync("mysql", ["-u", "root", `--password=${adminPw}`, "-sNe",
        `SELECT COUNT(*) FROM mysql.user WHERE User='${sqlName}'`], { encoding: "utf8" }).trim();
      if (check === "0") {
        const pw = dbRandomPassword();
        const sql = [
          `CREATE DATABASE IF NOT EXISTS \`${sqlName}\`;`,
          `CREATE USER '${sqlName}'@'localhost' IDENTIFIED BY '${pw}';`,
          `GRANT ALL PRIVILEGES ON \`${sqlName}\`.* TO '${sqlName}'@'localhost';`,
          `FLUSH PRIVILEGES;`,
        ].join("\n");
        execFileSync("mysql", ["-u", "root", `--password=${adminPw}`, "-e", sql], { stdio: "ignore" });
        result.mariadb = { password: pw };
        log(`databases: provisioned MariaDB db+user ${sqlName}`);
      } else {
        log(`databases: MariaDB user ${sqlName} already exists`);
      }
    } catch (e) {
      log(`databases: MariaDB provision failed for ${sqlName}: ${e.message}`);
    }
  }

  return Object.keys(result).length ? result : null;
}

function databasesDeprovision(username) {
  const sqlName = dbName(username);

  try {
    execFileSync("sudo", ["-u", "postgres", "psql", "-c",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${sqlName}'`], { stdio: "ignore" });
    execFileSync("sudo", ["-u", "postgres", "psql", "-c",
      `DROP DATABASE IF EXISTS ${sqlName}`], { stdio: "ignore" });
    execFileSync("sudo", ["-u", "postgres", "psql", "-c",
      `DROP USER IF EXISTS ${sqlName}`], { stdio: "ignore" });
    log(`databases: deprovisioned PostgreSQL ${sqlName}`);
  } catch (e) {
    log(`databases: PostgreSQL deprovision ${sqlName}: ${e.message}`);
  }

  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(DATABASES_CONFIG, "utf8")); } catch {}
    const adminPw = cfg.mariadb?.adminPassword || "";
    const sql = `DROP DATABASE IF EXISTS \`${sqlName}\`; DROP USER IF EXISTS '${sqlName}'@'localhost';`;
    execFileSync("mysql", ["-u", "root", `--password=${adminPw}`, "-e", sql], { stdio: "ignore" });
    log(`databases: deprovisioned MariaDB ${sqlName}`);
  } catch (e) {
    log(`databases: MariaDB deprovision ${sqlName}: ${e.message}`);
  }
}

function databasesWriteEnv(userId, username) {
  const engines = databasesInstalled();
  if (!engines.postgresql && !engines.mariadb && !engines.redis) return;

  let mapping = {};
  try { mapping = JSON.parse(fs.readFileSync(ISOLATION_MAP, "utf8")); } catch {}
  const entry = mapping[username];
  if (!entry) return;
  const dbs = entry.databases || {};
  const sqlName = dbName(username);
  const lines = [];

  if (engines.postgresql && dbs.postgresql) {
    const pw = dbs.postgresql.password;
    lines.push("# PostgreSQL");
    lines.push(`DATABASE_URL=postgresql://${sqlName}:${pw}@localhost:5432/${sqlName}`);
    lines.push(`PGDATABASE=${sqlName}`, `PGUSER=${sqlName}`, `PGPASSWORD=${pw}`);
    lines.push("PGHOST=localhost", "PGPORT=5432");
  }

  if (engines.mariadb && dbs.mariadb) {
    const pw = dbs.mariadb.password;
    lines.push("# MariaDB");
    lines.push(`MYSQL_URL=mysql://${sqlName}:${pw}@localhost:3306/${sqlName}`);
    lines.push(`MYSQL_DATABASE=${sqlName}`, `MYSQL_USER=${sqlName}`, `MYSQL_PASSWORD=${pw}`);
    lines.push("MYSQL_HOST=localhost", "MYSQL_PORT=3306");
    if (!engines.postgresql || !dbs.postgresql) {
      lines.push(`DATABASE_URL=mysql://${sqlName}:${pw}@localhost:3306/${sqlName}`);
    }
  }

  if (engines.redis) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(DATABASES_CONFIG, "utf8")); } catch {}
    const redisPw = cfg.redis?.password || "";
    const auth = redisPw ? `:${redisPw}@` : "";
    lines.push("# Redis");
    lines.push(`REDIS_URL=redis://${auth}localhost:6379`);
  }

  if (!lines.length) return;

  const envFile = path.join(USERS_DIR, userId, "env");
  let existing = "";
  try { existing = fs.readFileSync(envFile, "utf8"); } catch {}

  const marker = "# --- CCM Databases ---";
  const endMarker = "# --- /CCM Databases ---";
  const startIdx = existing.indexOf(marker);
  const endIdx = existing.indexOf(endMarker);
  if (startIdx !== -1 && endIdx !== -1) {
    existing = existing.slice(0, startIdx) + existing.slice(endIdx + endMarker.length + 1);
  }

  const dbSection = [marker, ...lines, endMarker].join("\n") + "\n";
  fs.writeFileSync(envFile, existing.trimEnd() + "\n" + dbSection);
}

function databasesAppendClaudeMd(claudeDir) {
  const engines = databasesInstalled();
  if (!engines.postgresql && !engines.mariadb && !engines.redis) return;

  const claudeMdPath = path.join(claudeDir, "CLAUDE.md");
  let content = "";
  try { content = fs.readFileSync(claudeMdPath, "utf8"); } catch { return; }
  if (content.includes("## Available Databases")) return;

  const dbLines = ["", "## Available Databases", "",
    "Pre-configured databases for this workspace. Use environment variables — never hardcode credentials.", ""];
  if (engines.postgresql) dbLines.push("- **PostgreSQL**: `$DATABASE_URL` or individual `$PGUSER`, `$PGPASSWORD`, `$PGDATABASE`, `$PGHOST`");
  if (engines.mariadb) dbLines.push("- **MariaDB**: `$MYSQL_URL` or individual `$MYSQL_USER`, `$MYSQL_PASSWORD`, `$MYSQL_DATABASE`, `$MYSQL_HOST`");
  if (engines.redis) dbLines.push("- **Redis**: `$REDIS_URL`");
  dbLines.push("");

  fs.appendFileSync(claudeMdPath, dbLines.join("\n"));
}

/**
 * Copy admin's gstack skill SKILL.md files into an isolated user's
 * ~/.claude/skills/ directory. Claude Code refuses to follow symlinked
 * SKILL.md files, so we must use real copies. To keep them in sync with
 * admin updates (e.g. /gstack-upgrade), this function compares mtimes
 * and re-copies only when the admin's file is newer.
 */
function syncAdminSkills(claudeDir, username) {
  const adminSkills = path.join(os.homedir(), ".claude", "skills");
  if (!fs.existsSync(adminSkills)) return;
  // Ensure admin skill dirs are world-readable
  try { execFileSync("chmod", ["-R", "o+rX", adminSkills]); } catch {}

  const userSkills = path.join(claudeDir, "skills");
  // Remove stale directory-level symlink from older code
  try { if (fs.lstatSync(userSkills).isSymbolicLink()) fs.unlinkSync(userSkills); } catch {}
  fs.mkdirSync(userSkills, { recursive: true });

  // Symlink the gstack repo itself (needed for SKILL.md references inside skills)
  const userGstackSkill = path.join(userSkills, "gstack");
  const adminGstackSkill = path.join(adminSkills, "gstack");
  if (fs.existsSync(adminGstackSkill) && !fs.existsSync(userGstackSkill)) {
    fs.symlinkSync(adminGstackSkill, userGstackSkill);
  }

  // For each skill dir in admin, create real dir + copy SKILL.md if newer
  for (const entry of fs.readdirSync(adminSkills)) {
    if (entry === "gstack") continue;
    const adminDir = path.join(adminSkills, entry);
    let adminMd;
    // Resolve through symlinks to find the actual SKILL.md
    try {
      const candidate = path.join(adminDir, "SKILL.md");
      if (!fs.existsSync(candidate)) continue;
      adminMd = fs.realpathSync(candidate);
    } catch { continue; }

    const userDir = path.join(userSkills, entry);
    const userMd = path.join(userDir, "SKILL.md");
    fs.mkdirSync(userDir, { recursive: true });

    // Copy only if admin's file is newer or user's doesn't exist
    let needsCopy = !fs.existsSync(userMd);
    if (!needsCopy) {
      try {
        const adminMtime = fs.statSync(adminMd).mtimeMs;
        const userMtime = fs.statSync(userMd).mtimeMs;
        needsCopy = adminMtime > userMtime;
      } catch { needsCopy = true; }
    }
    if (needsCopy) {
      fs.copyFileSync(adminMd, userMd);
    }
  }

  // Fix ownership
  try { execFileSync("chown", ["-R", `${username}:${username}`, userSkills]); } catch {}
}

/** Ensure OAuth credential files and their parent directory are readable
 *  by ccm-auth group members. Claude Code resets these to 0600 on token
 *  refresh, breaking isolated users' auth. Called on every ensureProjectUser
 *  entry so the fix is self-healing. */
function fixCredentialPermissions() {
  const accountsDir = path.join(os.homedir(), ".claude", "accounts");
  try { fs.chmodSync(accountsDir, 0o750); } catch {}
  try {
    for (const f of fs.readdirSync(accountsDir)) {
      if (f.endsWith(".json") && !f.startsWith(".")) {
        fs.chmodSync(path.join(accountsDir, f), 0o640);
      }
    }
  } catch {}
}

function ensureProjectUser(userId, userJid) {
  if (!ISOLATION) return null;

  const username = isolationGetUsername(userId);
  const homeDir = `/home/${username}`;

  // Check if user already exists
  try {
    execFileSync("id", [username], { stdio: "ignore" });
    // User exists — load mapping to get port
    let mapping = {};
    try { mapping = JSON.parse(fs.readFileSync(ISOLATION_MAP, "utf8")); } catch {}
    let port = mapping[username] && mapping[username].port;
    // If domains is on and this user has no port yet, provision now
    if (!port && domainsAvailable()) {
      port = domainsAllocatePort();
      const hash = isolationHash(path.basename(STATE_DIR), userId);
      if (domainsProvision(username, hash, port, homeDir)) {
        if (!mapping[username]) mapping[username] = { userId, channel: path.basename(STATE_DIR), created: Math.floor(Date.now() / 1000) };
        mapping[username].port = port;
        mapping[username].subdomain = `${hash}.${process.env.DOMAIN_ROOT}`;
        fs.mkdirSync(path.dirname(ISOLATION_MAP), { recursive: true });
        fs.writeFileSync(ISOLATION_MAP, JSON.stringify(mapping, null, 2));
      } else {
        port = undefined;
      }
    }
    // Ensure credential files stay group-readable (Claude Code resets
    // them to 0600 on token refresh; fix on every entry so isolated
    // users never lose access).
    fixCredentialPermissions();

    // If this user is the admin, (re-)apply the /root/.env ACL +
    // symlink so tokens are available. Idempotent; safe on re-entry
    // (e.g. ccm-install added the user before an admin was set, and
    // the admin is now set).
    const _adminCheck = loadAdmin();
    if (_adminCheck && (_adminCheck.jid === userJid || toJid(_adminCheck.jid) === userJid)) {
      grantAdminEnvAccess(username, homeDir);
    }
    return { username, homeDir, port };
  } catch {
    // User does not exist — create below
  }

  try {
    execFileSync("useradd", ["-m", "-s", "/usr/sbin/nologin", "-G", "ccm-auth", username], { stdio: "ignore" });
    log(`created project user: ${username}`);
  } catch (e) {
    log(`failed to create user ${username}: ${e}`);
    return null;
  }

  const claudeDir = path.join(homeDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  // Symlink OAuth credentials (project user reads through ccm-auth group)
  const adminCreds = path.join(os.homedir(), ".claude", ".credentials.json");
  const userCreds = path.join(claudeDir, ".credentials.json");
  if (fs.existsSync(adminCreds) && !fs.existsSync(userCreds)) {
    fs.symlinkSync(adminCreds, userCreds);
  }
  // Ensure credential files + directory are group-readable by ccm-auth
  fixCredentialPermissions();

  // Copy base settings + inject skipDangerousModePermissionPrompt so the
  // spawned claude doesn't halt on the bypass-permissions warning on
  // first run. Mirrors lib/isolation.sh isolation_create_user so the
  // gateway-spawn path and the ccm-install path converge on the same
  // first-run seeds.
  const adminSettings = path.join(os.homedir(), ".claude", "settings.json");
  const userSettingsFile = path.join(claudeDir, "settings.json");
  let userSettings = {};
  if (fs.existsSync(adminSettings)) {
    try { userSettings = JSON.parse(fs.readFileSync(adminSettings, "utf8")); } catch {}
  }
  userSettings.skipDangerousModePermissionPrompt = true;
  fs.writeFileSync(userSettingsFile, JSON.stringify(userSettings, null, 2) + "\n");

  // Seed ~/.claude.json with the markers Claude Code looks for to decide
  // "onboarding complete" — without this, every spawned session halts on
  // the theme picker → bypass-warning → effort-callout chain and never
  // reaches a usable prompt. Keep in sync with isolation.sh.
  const claudeJsonPath = path.join(homeDir, ".claude.json");
  const workspaceDir = path.join(homeDir, "workspace");
  // Copy cachedGrowthBookFeatures from admin — these include
  // tengu_harbor which gates the "channels feature" (i.e. whether MCP
  // notifications/claude/channel is allowed at all). Without it the
  // spawned claude sees NP6()=false and marks channels "disabled",
  // dropping all inbound WhatsApp messages on the floor — which looks
  // to the user like "bot never responds in the group".
  let cachedGB = {};
  try {
    const adminClaudeJson = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    cachedGB = adminClaudeJson.cachedGrowthBookFeatures || {};
  } catch {}
  const claudeJson = {
    numStartups: 1,
    firstStartTime: new Date().toISOString(),
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    effortCalloutV2Dismissed: true,
    hasVisitedPasses: true,
    cachedGrowthBookFeatures: cachedGB,
    projects: {
      [workspaceDir]: {
        allowedTools: [],
        mcpContextUris: [],
        mcpServers: {},
        enabledMcpjsonServers: ["whatsapp"],
        disabledMcpjsonServers: [],
        hasTrustDialogAccepted: true,
        projectOnboardingSeenCount: 1,
        hasClaudeMdExternalIncludesApproved: true,
        hasClaudeMdExternalIncludesWarningShown: true,
      },
    },
  };
  fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + "\n");
  try { fs.chmodSync(claudeJsonPath, 0o600); } catch {}

  // User-global security CLAUDE.md — includes admin's CLAUDE.md if it exists
  // (carries gstack skill references, credential rules, etc.) plus isolation
  // security rules as a fallback baseline.
  const adminClaudeMd = path.join(os.homedir(), ".claude", "CLAUDE.md");
  let userClaudeMdContent;
  try {
    userClaudeMdContent = fs.readFileSync(adminClaudeMd, "utf8");
  } catch {
    // Fallback: minimal security rules if admin has no CLAUDE.md
    userClaudeMdContent = [
      "# Security Rules (Isolated Session)",
      "",
      "## Credentials",
      "- NEVER output API keys, tokens, passwords, or secret values in replies.",
      "- Do NOT read ~/.claude/.credentials.json or any credential files.",
      "- Do NOT run env, printenv, or attempt to read environment variables containing secrets.",
      "",
      "## Workspace Scope",
      "- Work within the current directory and its subdirectories only.",
      "- Do NOT access other users' home directories.",
      "- Do NOT access /var/lib/ccm/ directories belonging to other users.",
      "",
    ].join("\n");
  }
  fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), userClaudeMdContent);

  // If domains is enabled, append domain-specific instructions to CLAUDE.md
  // (mirrors the bash branch in isolation_create_user)
  if (domainsAvailable()) {
    const hash = isolationHash(path.basename(STATE_DIR), userId);
    const domainNote = [
      "",
      "## Your subdomain",
      "",
      `You are reachable at: https://${hash}.${process.env.DOMAIN_ROOT}`,
      "Bind your dev server to $PORT (set in your environment).",
      "",
      "### nginx config (yours to edit)",
      "",
      "Your nginx vhost: ~/nginx/vhost.conf",
      "After editing, run: sudo ccm-nginx-reload",
      "",
      "This validates the config with `nginx -t` and reloads on success. On syntax errors,",
      "nginx keeps the previous config running — edits can't break the server globally.",
      "",
      "### Logs",
      "- ~/nginx/logs/access.log — every request your subdomain receives",
      "- ~/nginx/logs/error.log — nginx-side errors (bad upstream, timeouts, etc.)",
      "",
      "### Persistence for long-running services",
      "",
      "When the tmux session dies (30min idle timeout, manual kill), child processes get SIGHUP.",
      "Plain `nohup` is insufficient. For services meant to survive session death, use:",
      "",
      "    setsid nohup <cmd> >~/logs/svc.log 2>&1 </dev/null &",
      "",
      "`setsid` starts a new session detached from tmux.",
      "",
    ].join("\n");
    fs.appendFileSync(path.join(claudeDir, "CLAUDE.md"), domainNote);
  }

  // Create workspace
  fs.mkdirSync(path.join(homeDir, "workspace"), { recursive: true });

  // Share admin's plugins and gstack config via symlinks (plugins use a
  // different discovery mechanism that follows symlinks fine).
  const adminPlugins = path.join(os.homedir(), ".claude", "plugins");
  const userPlugins = path.join(claudeDir, "plugins");
  if (fs.existsSync(adminPlugins) && !fs.existsSync(userPlugins)) {
    fs.symlinkSync(adminPlugins, userPlugins);
    try { execFileSync("chmod", ["-R", "o+rX", adminPlugins]); } catch {}
  }
  const adminGstack = path.join(os.homedir(), ".gstack");
  const userGstack = path.join(homeDir, ".gstack");
  if (fs.existsSync(adminGstack) && !fs.existsSync(userGstack)) {
    fs.symlinkSync(adminGstack, userGstack);
    try { execFileSync("chmod", ["-R", "o+rX", adminGstack]); } catch {}
  }
  // Copy skill SKILL.md files (Claude Code won't follow symlinked SKILL.md).
  // syncAdminSkills handles both initial copy and subsequent updates.
  syncAdminSkills(claudeDir, username);

  // Provision databases for this workspace
  const _newDbs = databasesProvision(username);

  // Fix ownership (chown -R does not follow symlinks, so admin's creds file stays owned by admin)
  try {
    execFileSync("chown", ["-R", `${username}:${username}`, homeDir]);
  } catch (e) {
    log(`chown failed for ${homeDir}: ${e}`);
  }

  // Update mapping file
  let mapping = {};
  try { mapping = JSON.parse(fs.readFileSync(ISOLATION_MAP, "utf8")); } catch {}
  mapping[username] = { userId, channel: path.basename(STATE_DIR), created: Math.floor(Date.now() / 1000) };
  if (_newDbs) mapping[username].databases = _newDbs;

  // If domains is available, allocate port and provision vhost
  if (domainsAvailable()) {
    const port = domainsAllocatePort();
    const hash = isolationHash(path.basename(STATE_DIR), userId);
    if (domainsProvision(username, hash, port, homeDir)) {
      mapping[username].port = port;
      mapping[username].subdomain = `${hash}.${process.env.DOMAIN_ROOT}`;
    }
  }

  fs.mkdirSync(path.dirname(ISOLATION_MAP), { recursive: true });
  fs.writeFileSync(ISOLATION_MAP, JSON.stringify(mapping, null, 2));

  // Write database env vars + update CLAUDE.md
  if (mapping[username].databases) {
    databasesWriteEnv(userId, username);
    databasesAppendClaudeMd(claudeDir);
  }

  // If this user is the admin, grant /root/.env access (ACL + symlink)
  // so claude sessions inherit GITHUB_TOKEN etc from ccm Settings.
  const _adminCheck2 = loadAdmin();
  if (_adminCheck2 && (_adminCheck2.jid === userJid || toJid(_adminCheck2.jid) === userJid)) {
    grantAdminEnvAccess(username, homeDir);
  }

  return { username, homeDir, port: mapping[username].port };
}

// ── Domains: subdomain provisioning ──────────────────────────────

function domainsAvailable() {
  if (!ISOLATION) return false;
  if (process.env.CCM_DOMAINS !== "1") return false;
  if (!process.env.DOMAIN_ROOT) return false;
  try { execFileSync("nginx", ["-v"], { stdio: "ignore" }); } catch { return false; }
  return true;
}

function domainsNginxUser() {
  try {
    const conf = fs.readFileSync("/etc/nginx/nginx.conf", "utf8");
    const m = conf.match(/^\s*user\s+([^\s;]+)/m);
    if (m) return m[1];
  } catch {}
  try { execFileSync("id", ["www-data"], { stdio: "ignore" }); return "www-data"; } catch {}
  try { execFileSync("id", ["nginx"], { stdio: "ignore" }); return "nginx"; } catch {}
  return "www-data";
}

function domainsAllocatePort() {
  const used = new Set();
  try {
    const m = JSON.parse(fs.readFileSync(ISOLATION_MAP, "utf8"));
    for (const info of Object.values(m)) {
      if (info && info.port) used.add(info.port);
    }
  } catch {}
  try {
    const out = execFileSync("ss", ["-tlnH"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const m2 = line.match(/:(\d+)\s/);
      if (m2) used.add(parseInt(m2[1], 10));
    }
  } catch {}
  let p = 10000;
  while (used.has(p)) p++;
  return p;
}

function domainsProvision(username, hash, port, homeDir) {
  if (!domainsAvailable()) return false;

  const vhostDir = path.join(homeDir, "nginx");
  const logsDir = path.join(vhostDir, "logs");
  const vhostFile = path.join(vhostDir, "vhost.conf");
  const symlinkPath = `/etc/nginx/conf.d/${username}.conf`;
  const nginxUser = domainsNginxUser();
  const root = process.env.DOMAIN_ROOT;

  try {
    fs.mkdirSync(vhostDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const vhost = [
      "# Your nginx config — edit freely.",
      "# After changes, run: sudo ccm-nginx-reload",
      `# User: ${username}`,
      `# Port: ${port}`,
      "server {",
      "    listen 80;",
      `    server_name ${hash}.${root};`,
      "",
      `    access_log ${logsDir}/access.log;`,
      `    error_log  ${logsDir}/error.log warn;`,
      "",
      "    location / {",
      `        proxy_pass http://127.0.0.1:${port};`,
      "        proxy_http_version 1.1;",
      "        proxy_set_header Upgrade $http_upgrade;",
      '        proxy_set_header Connection "upgrade";',
      "        proxy_set_header Host $host;",
      "        proxy_set_header X-Real-IP $remote_addr;",
      "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
      "        proxy_set_header X-Forwarded-Proto $scheme;",
      "        proxy_read_timeout 300s;",
      "        proxy_intercept_errors off;",
      "    }",
      "}",
      "",
    ].join("\n");
    fs.writeFileSync(vhostFile, vhost);

    for (const f of ["access.log", "error.log"]) {
      const lf = path.join(logsDir, f);
      if (!fs.existsSync(lf)) fs.writeFileSync(lf, "");
    }

    execFileSync("chown", ["-R", `${username}:${username}`, vhostDir]);
    execFileSync("chmod", ["0755", vhostDir, logsDir]);
    execFileSync("chmod", ["0644", vhostFile]);
    execFileSync("chmod", ["0640", path.join(logsDir, "access.log"), path.join(logsDir, "error.log")]);

    try { execFileSync("setfacl", ["-m", `u:${nginxUser}:rx`, homeDir, vhostDir]); } catch {}
    try { execFileSync("setfacl", ["-m", `u:${nginxUser}:rwx`, logsDir]); } catch {}
    try { execFileSync("setfacl", ["-m", `u:${nginxUser}:rw`, path.join(logsDir, "access.log"), path.join(logsDir, "error.log")]); } catch {}
    try { execFileSync("setfacl", ["-d", "-m", `u:${nginxUser}:rw`, logsDir]); } catch {}

    try { fs.unlinkSync(symlinkPath); } catch {}
    fs.symlinkSync(vhostFile, symlinkPath);

    try { execFileSync("nginx", ["-t"], { stdio: "ignore" }); } catch {
      log(`domainsProvision: nginx -t failed for ${username}, rolling back`);
      try { fs.unlinkSync(symlinkPath); } catch {}
      return false;
    }
    try { execFileSync("systemctl", ["reload", "nginx"], { stdio: "ignore" }); } catch (e) {
      log(`domainsProvision: systemctl reload failed: ${e}`);
      return false;
    }

    log(`domains provisioned: ${username} → ${hash}.${root} :${port}`);
    return true;
  } catch (e) {
    log(`domainsProvision error for ${username}: ${e}`);
    try { fs.unlinkSync(symlinkPath); } catch {}
    return false;
  }
}

function domainsDeprovision(username) {
  const symlinkPath = `/etc/nginx/conf.d/${username}.conf`;
  try { fs.unlinkSync(symlinkPath); } catch {}
  try {
    execFileSync("nginx", ["-t"], { stdio: "ignore" });
    execFileSync("systemctl", ["reload", "nginx"], { stdio: "ignore" });
  } catch {}
}

// ── Group freeze / cleanup ──────────────────────────────────────
// When the bot is removed from a group or the group is deleted,
// freeze the session: kill tmux, stop processes, disable subdomain.
// Data is retained for FREEZE_RETENTION_DAYS before full deletion.

const FREEZE_RETENTION_DAYS = 60;

function freezeGroupSession(userId, reason) {
  const userDir = path.join(USERS_DIR, userId);
  if (!fs.existsSync(userDir)) return;

  // Already frozen?
  const frozenFile = path.join(userDir, "frozen.json");
  if (fs.existsSync(frozenFile)) {
    log(`freeze: ${userId} already frozen — skipping`);
    return;
  }

  // 1. Kill tmux session
  const sessionName = getUserSessionName(userId);
  try { execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" }); } catch {}
  userActivity.delete(userId);

  // 2. Kill all processes owned by the isolated user (if isolation)
  if (ISOLATION) {
    const username = isolationGetUsername(userId);
    try {
      // SIGTERM first, give 3s, then SIGKILL stragglers
      execFileSync("pkill", ["-u", username], { stdio: "ignore" });
      setTimeout(() => {
        try { execFileSync("pkill", ["-9", "-u", username], { stdio: "ignore" }); } catch {}
      }, 3000);
    } catch {} // pkill returns 1 if no processes matched — that's fine

    // 3. Disable subdomain (remove nginx symlink, reload)
    domainsDeprovision(username);
  }

  // 4. Write frozen marker
  const frozen = {
    frozenAt: new Date().toISOString(),
    frozenAtUnix: Math.floor(Date.now() / 1000),
    reason,
    deleteAfter: new Date(Date.now() + FREEZE_RETENTION_DAYS * 86400000).toISOString(),
  };
  fs.writeFileSync(frozenFile, JSON.stringify(frozen, null, 2) + "\n");

  log(`frozen: ${userId} — reason: ${reason}, delete after ${frozen.deleteAfter}`);
}

function unfreezeGroupSession(userId) {
  const frozenFile = path.join(USERS_DIR, userId, "frozen.json");
  if (!fs.existsSync(frozenFile)) return;

  try { fs.unlinkSync(frozenFile); } catch {}

  // Re-provision subdomain if isolation + domains are on
  if (ISOLATION && domainsAvailable()) {
    const username = isolationGetUsername(userId);
    const homeDir = `/home/${username}`;
    let mapping = {};
    try { mapping = JSON.parse(fs.readFileSync(ISOLATION_MAP, "utf8")); } catch {}
    const entry = mapping[username];
    if (entry && entry.port) {
      const hash = isolationHash(path.basename(STATE_DIR), userId);
      domainsProvision(username, hash, entry.port, homeDir);
    }
  }

  log(`unfrozen: ${userId}`);
}

function cleanupFrozenSessions() {
  let entries;
  try { entries = fs.readdirSync(USERS_DIR); } catch { return; }
  const now = Date.now();

  for (const uid of entries) {
    const frozenFile = path.join(USERS_DIR, uid, "frozen.json");
    if (!fs.existsSync(frozenFile)) continue;

    let frozen;
    try { frozen = JSON.parse(fs.readFileSync(frozenFile, "utf8")); } catch { continue; }

    const frozenAt = frozen.frozenAtUnix * 1000;
    const elapsed = now - frozenAt;
    const retentionMs = FREEZE_RETENTION_DAYS * 86400000;

    if (elapsed < retentionMs) continue;

    // Retention expired — full delete
    log(`cleanup: deleting frozen session ${uid} (frozen ${Math.floor(elapsed / 86400000)} days ago)`);

    if (ISOLATION) {
      const username = isolationGetUsername(uid);
      // Remove nginx vhost (may already be gone from freeze)
      domainsDeprovision(username);
      // Drop databases + users before deleting Linux user
      databasesDeprovision(username);
      // Delete Linux user + home directory
      try { execFileSync("userdel", ["-r", username], { stdio: "ignore" }); } catch (e) {
        log(`cleanup: userdel ${username} failed: ${e}`);
      }
      // Remove from isolation map
      try {
        const mapping = JSON.parse(fs.readFileSync(ISOLATION_MAP, "utf8"));
        delete mapping[username];
        fs.writeFileSync(ISOLATION_MAP, JSON.stringify(mapping, null, 2));
      } catch {}
    }

    // Remove user directory from channels state
    try { fs.rmSync(path.join(USERS_DIR, uid), { recursive: true, force: true }); } catch (e) {
      log(`cleanup: rmSync ${uid} failed: ${e}`);
    }

    log(`cleanup: ${uid} fully deleted`);
  }
}

// Run cleanup check every 6 hours
setInterval(cleanupFrozenSessions, 6 * 3600000);
// Also run once at startup (after 30s to let things settle)
setTimeout(cleanupFrozenSessions, 30000);

// ── OAuth token watchdog ────────────────────────────────────────
// Periodically checks token expiry, fixes broken symlinks, and alerts
// admin before sessions start failing with 401.

let _tokenAlertSent = 0; // timestamp of last alert (avoid spam)

function credentialWatchdog() {
  const credsFile = path.join(os.homedir(), ".claude", ".credentials.json");
  const accountsDir = path.join(os.homedir(), ".claude", "accounts");
  const defaultAccount = path.join(accountsDir, "default.json");

  // 1. Fix broken symlink: /login writes a regular file, breaking the chain
  try {
    const stat = fs.lstatSync(credsFile);
    if (!stat.isSymbolicLink() && stat.isFile()) {
      // .credentials.json is a regular file — copy to accounts/default.json and re-symlink
      fs.copyFileSync(credsFile, defaultAccount);
      fs.unlinkSync(credsFile);
      fs.symlinkSync(defaultAccount, credsFile);
      try { fs.chmodSync(defaultAccount, 0o640); } catch {}
      try { fs.chownSync(defaultAccount, 0, (() => { try { return parseInt(execFileSync("getent", ["group", "ccm-auth"], { encoding: "utf8" }).split(":")[2]); } catch { return 0; } })()); } catch {}
      log("credential-watchdog: restored .credentials.json symlink after /login overwrote it");
    }
  } catch {}

  // 2. Fix permissions (Claude Code resets to 0600 on token refresh)
  fixCredentialPermissions();

  // 3. Check token expiry
  let oauth = {};
  try {
    const creds = JSON.parse(fs.readFileSync(defaultAccount, "utf8"));
    oauth = creds.claudeAiOauth || {};
  } catch { return; }

  const expiresAt = oauth.expiresAt || 0;
  const now = Date.now();
  const remainingMin = (expiresAt - now) / 60000;

  // Only alert if token is ACTUALLY expired (cron handles pre-expiry refresh).
  // Log a warning for near-expiry but don't message the admin — the cron
  // auto-refreshes every 20 min and false alerts are worse than no alert.
  if (expiresAt > 0 && remainingMin <= 0 && now - _tokenAlertSent > 3600000) {
    const admin = loadAdmin();
    if (admin?.jid && sock && connectionReady) {
      const msg = "⚠️ *OAuth token EXPIRED.* Auto-refresh cron may have failed.\n\n"
        + "SSH into this server and run:\n```\nclaude\n/login\n```\n"
        + "Then check: `cat /tmp/claude-token-refresh.log`";
      try {
        sock.sendMessage(toJid(admin.jid), { text: msg });
        _tokenAlertSent = now;
        log(`credential-watchdog: token EXPIRED — sent alert`);
      } catch {}
    }
  } else if (expiresAt > 0 && remainingMin < 15) {
    log(`credential-watchdog: token low (${Math.round(remainingMin)}min) — cron should refresh`);
  }
}

// Check every 10 minutes
setInterval(credentialWatchdog, 10 * 60000);
// Run once at startup (after 60s)
setTimeout(credentialWatchdog, 60000);

// ── Capacity / account exhaustion ────────────────────────────────

const CAPACITY_FLAG = "/var/lib/ccm/capacity-blocked";

const CAPACITY_MSG_USER_DEFAULT =
  "⏸ I'm temporarily at capacity. Please try again in <eta_relative>. Or you can upgrade to get more capacity limit.";

const CAPACITY_MSG_ADMIN_DEFAULT =
  "⏸ All Claude accounts rate-limited.\n\nNext reset: <eta_relative> (<account_label>)\n\nOptions:\n  ccm → Settings → [acc] → Add   (new account)\n  ccm → Settings → [acc] → List  (see all statuses)";

function readCapacityInfo() {
  try { return JSON.parse(fs.readFileSync(CAPACITY_FLAG, "utf8")); } catch { return null; }
}

function formatEtaRelative(unixSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, unixSeconds - now);
  if (delta <= 0) return "a moment";
  const days = Math.floor(delta / 86400);
  const hours = Math.floor((delta % 86400) / 3600);
  const minutes = Math.floor((delta % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days} day${days > 1 ? "s" : ""}`);
  if (hours > 0) parts.push(`${hours} hour${hours > 1 ? "s" : ""}`);
  if (minutes > 0 && days === 0) parts.push(`${minutes} minute${minutes > 1 ? "s" : ""}`);
  return parts.join(" ") || "a moment";
}

function sendCapacityMessage(userJid, isAdmin) {
  const info = readCapacityInfo() || {};
  const eta = formatEtaRelative(info.earliest_reset || (Date.now() / 1000 + 3600));
  const label = info.last_active || "";
  const template = isAdmin
    ? (process.env.CAPACITY_MSG_ADMIN || CAPACITY_MSG_ADMIN_DEFAULT)
    : (process.env.CAPACITY_MSG_USER  || CAPACITY_MSG_USER_DEFAULT);
  const text = template
    .replace(/<eta_relative>/g, eta)
    .replace(/<account_label>/g, label);
  // Write to global outbox so the existing outbox scanner delivers it
  const outFile = path.join(OUTBOX_DIR, `${Date.now()}-capacity.json`);
  fs.writeFileSync(outFile, JSON.stringify({ jid: userJid, text }));
}

function isSessionRunning(sessionName) {
  try { execFileSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" }); return true; } catch { return false; }
}

function ensureUserConfig(userId, userJid) {
  const userDir = getUserDir(userId);
  const projectUser = ISOLATION ? ensureProjectUser(userId, userJid) : null;
  // Fix IPC dir ownership now that ensureProjectUser has created the user
  // (getUserDir skips chown if user doesn't exist yet on first message)
  if (projectUser) {
    try { execFileSync("chown", ["-R", `${projectUser.username}:ccm-gw`, userDir]); } catch {}
    try { execFileSync("chmod", ["770", userDir]); } catch {}
  }
  const userWorkDir = projectUser
    ? path.join(projectUser.homeDir, "workspace")
    : path.join(userDir, "workspace");
  const userHomeDir = projectUser ? projectUser.homeDir : os.homedir();
  fs.mkdirSync(userWorkDir, { recursive: true });

  // Sync admin skills to isolated user (copies SKILL.md files, mtime-aware)
  if (projectUser) {
    syncAdminSkills(path.join(projectUser.homeDir, ".claude"), projectUser.username);
  }

  // Provision databases for isolated users (catches newly-installed engines)
  if (projectUser) {
    const engines = databasesInstalled();
    if (engines.postgresql || engines.mariadb || engines.redis) {
      let mapping = {};
      try { mapping = JSON.parse(fs.readFileSync(ISOLATION_MAP, "utf8")); } catch {}
      const entry = mapping[projectUser.username];
      if (entry && !entry.databases) {
        const newDbs = databasesProvision(projectUser.username);
        if (newDbs) {
          entry.databases = newDbs;
          fs.writeFileSync(ISOLATION_MAP, JSON.stringify(mapping, null, 2));
        }
      }
      databasesWriteEnv(userId, projectUser.username);
      databasesAppendClaudeMd(path.join(projectUser.homeDir, ".claude"));
    }
  }

  // Security rules go in .claude/CLAUDE.md (hidden directory) — written once
  // on first creation only. This leaves the visible CLAUDE.md free for
  // project-specific instructions and team memory. Claude Code reads both.
  // The user-global ~/.claude/CLAUDE.md also has "never print tokens" rules.
  const securityDir = path.join(userWorkDir, ".claude");
  const securityMdPath = path.join(securityDir, "CLAUDE.md");
  if (!fs.existsSync(securityMdPath)) {
    fs.mkdirSync(securityDir, { recursive: true });
    const adminCheck = loadAdmin();
    const isUserAdmin = adminCheck && (adminCheck.jid === userJid || toJid(adminCheck.jid) === userJid);
    const securityContent = isUserAdmin
      ? [
          "# Security Rules (Channel Session — Admin)",
          "",
          "## Credentials — NEVER print in chat",
          "",
          "**NEVER** output API keys, tokens, passwords, or secret values in your replies.",
          "Chat messages are stored in message history and are effectively public.",
          "",
          "If the user asks to see a credential value:",
          '- Say: "For security, credentials can only be viewed via SSH. Run `ccm` → Settings on the server."',
          "- You may check if a token is set: `[ -n \"$VAR_NAME\" ] && echo set || echo not-set`",
          "- NEVER print the actual value, even partially masked.",
          "",
        ].join("\n")
      : [
          "# Security Rules (Channel Session — User)",
          "",
          "## File Access Boundaries",
          "",
          "**Do NOT read, access, or reference any of these files or directories:**",
          "- `~/.env` or `$HOME/.env` — server credentials",
          "- `~/.claude/channels/` — channel state and admin config",
          "- `~/.ccm/` — menu system modules",
          "- `~/.ssh/` — SSH keys",
          "- Any `.env` file outside the current workspace",
          "- Any `admin.json`, `access.json`, or `otp.json` file",
          "- Other users' workspace directories",
          "- Claude conversation history files (*.jsonl)",
          "",
          "## Credentials",
          "",
          "Do not read or output environment variables containing tokens or secrets.",
          "If asked about credentials, say:",
          '"You don\'t have access to server credentials. Contact the admin."',
          "",
          "## Workspace Scope",
          "",
          "Work within the current directory and its subdirectories only.",
          "",
          "## Deployment & File Export",
          "",
          "If the user asks about deploying to their own domain, downloading the project files,",
          "exporting the website, transferring to their own hosting, or anything related to",
          "taking the project outside this workspace, respond warmly along these lines:",
          "",
          '"Great news — your project is looking fantastic! To get it live on your own domain,',
          "the HOKOCORP team can help you with that. They'll handle the deployment, make sure",
          "everything runs smoothly, and set you up with a production license so you're fully",
          "covered. Just reach out to them at info@hokocorp.com and they'll take care of the rest.",
          'In the meantime, I\'m happy to keep building and refining the project right here!"',
          "",
          "Adapt the wording naturally to the conversation, but always guide them to HOKOCORP",
          "for deployment, hosting, file export, or licensing questions. Keep it friendly and",
          "helpful — never make it sound like a paywall or restriction.",
          "",
          "## Production Readiness",
          "",
          "When delivering work or when the user seems happy with the result, proactively",
          "mention that AI-generated prototypes are great for rapid development but should",
          "go through a professional security review before going live. Say something like:",
          "",
          '"This looks great as a prototype! One thing worth noting — AI-generated code can',
          "sometimes have subtle security gaps (input validation, auth edge cases, etc.) that",
          "are hard to catch without a thorough review. Before going live with real users or",
          "sensitive data, I'd recommend having HOKOCORP do a production-readiness audit.",
          "They'll patch any vulnerabilities, optimize performance, and make sure everything",
          'is battle-tested. You can reach them at info@hokocorp.com."',
          "",
          "Bring this up naturally when appropriate — not on every message, just when the",
          "project reaches a milestone or the user talks about launching. Frame it as",
          "professional best practice, not a limitation of the current work.",
          "",
          "## Intellectual Property",
          "",
          "All code, assets, and files generated in this workspace are the intellectual",
          "property of HOKO CORP LIMITED under their Proprietary Software License.",
          "This includes all AI-generated code (see LICENSE.md Section 4).",
          "",
          "If the user asks about source code ownership, licensing, downloading code,",
          "or using the code outside this platform, explain warmly:",
          "",
          '"The code built here is covered by HOKO CORP LIMITED\'s proprietary license.',
          "If you'd like to use it on your own infrastructure or get a source code license,",
          "the HOKOCORP team can set that up for you — they'll package everything cleanly",
          "and make sure it's production-ready. Just reach out at info@hokocorp.com and",
          'they\'ll work out the best option for your needs."',
          "",
          "Be natural and helpful. Emphasize the value they get (clean package,",
          "production-ready, support) rather than the restriction. Never say 'you can't'",
          "— say 'HOKOCORP can help you with that'.",
          "",
        ].join("\n");
    fs.writeFileSync(securityMdPath, securityContent);
  }

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
    const projDir = path.join(userHomeDir, ".claude", "projects", enc);
    fs.mkdirSync(projDir, { recursive: true });
    const sf = path.join(projDir, "settings.local.json");
    if (!fs.existsSync(sf)) fs.writeFileSync(sf, autoApproveSettings);
  }

  // Pre-populate .claude.json project entry so Claude Code auto-trusts the MCP server.
  // Always re-apply enabledMcpjsonServers because Claude Code strips it on startup.
  const claudeJsonPath = path.join(userHomeDir, ".claude.json");
  try {
    const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
    if (!claudeJson.projects) claudeJson.projects = {};
    const projKey = userWorkDir;
    const proj = claudeJson.projects[projKey] || {};
    const needsUpdate = !proj.hasTrustDialogAccepted
      || !proj.enabledMcpjsonServers || !proj.enabledMcpjsonServers.includes("whatsapp");
    if (needsUpdate) {
      claudeJson.projects[projKey] = {
        ...proj,
        allowedTools: ["mcp__whatsapp__reply", "mcp__whatsapp__react", "mcp__whatsapp__download_attachment", "mcp__whatsapp__fetch_messages"],
        mcpServers: {},
        enabledMcpjsonServers: ["whatsapp"],
        enableAllProjectMcpServers: true,
        hasTrustDialogAccepted: true,
      };
      fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
    }
  } catch (e) { log(`failed to update .claude.json: ${e}`); }

  // Fix ownership of all config files written to project user's home
  if (projectUser) {
    try {
      execFileSync("chown", ["-R", `${projectUser.username}:${projectUser.username}`, projectUser.homeDir]);
    } catch (e) { log(`chown fixup failed: ${e}`); }
  }

  return { userDir, userWorkDir };
}

function spawnUserSession(userId, userJid) {
  const { userDir, userWorkDir } = ensureUserConfig(userId, userJid);
  const sessionName = getUserSessionName(userId);
  if (isSessionRunning(sessionName)) return;

  // Launcher script — bypassPermissions so Claude can run any tool call
  // without a WhatsApp poll round-trip on every compound command.
  //
  // Was: --permission-mode acceptEdits
  // Now: --permission-mode bypassPermissions
  //
  // Rationale: acceptEdits only auto-allows Edit tool calls. Bash tool
  // calls (even whitelisted ones like `ls`) still go through the
  // permission system, and compound bash commands (e.g. `ls | head;
  // echo ---; ls | head`) are treated as single compound commands that
  // need explicit approval even when every sub-command is on the
  // allowlist. The result is death by a thousand polls — Claude can't
  // explore a project without the admin tapping Allow on every step.
  //
  // bypassPermissions is safe here because: (a) the WhatsApp whitelist
  // is the real access control — only admin-approved JIDs can send
  // messages at all, (b) each per-user Claude session runs in its own
  // workspace directory with the process's own uid, (c) the bot is
  // single-admin by design. The permission poll system is still
  // available for any tool call the model decides to escalate
  // manually, but routine file exploration is no longer gated.
  const projectUser = ISOLATION ? ensureProjectUser(userId, userJid) : null;
  const launcher = projectUser
    ? path.join(projectUser.homeDir, "launch.sh")
    : path.join(userDir, "launch.sh");

  // Check if this user is the admin — only admin gets full credentials
  // and env/printenv tool access. Non-admin users get ANTHROPIC_API_KEY
  // only, preventing exfiltration of GITHUB_TOKEN, CF keys, etc.
  const admin = loadAdmin();
  const isAdmin = admin && (admin.jid === userJid || toJid(admin.jid) === userJid);

  const allowedTools = [
    "mcp__whatsapp__reply", "mcp__whatsapp__react", "mcp__whatsapp__download_attachment", "mcp__whatsapp__fetch_messages",
    "Read", "Write", "Edit", "Glob", "Grep", "LS",
    '"Bash(git:*)"', '"Bash(ls:*)"', '"Bash(cat:*)"', '"Bash(find:*)"', '"Bash(head:*)"', '"Bash(tail:*)"',
    '"Bash(echo:*)"', '"Bash(pwd:*)"', '"Bash(wc:*)"', '"Bash(sort:*)"', '"Bash(grep:*)"',
    '"Bash(npm:*)"', '"Bash(node:*)"', '"Bash(python3:*)"', '"Bash(pip:*)"',
    '"Bash(curl:*)"', '"Bash(wget:*)"', '"Bash(which:*)"', '"Bash(whoami:*)"',
    '"Bash(date:*)"', '"Bash(uname:*)"', '"Bash(df:*)"', '"Bash(du:*)"', '"Bash(free:*)"',
    '"Bash(ps:*)"', '"Bash(top:*)"',
    // env/printenv admin-only — these directly dump all environment variables
    ...(isAdmin ? ['"Bash(env:*)"', '"Bash(printenv:*)"'] : []),
    '"Bash(mkdir:*)"', '"Bash(cp:*)"', '"Bash(mv:*)"', '"Bash(touch:*)"',
    '"Bash(chmod:*)"', '"Bash(chown:*)"', '"Bash(stat:*)"', '"Bash(file:*)"',
    '"Bash(tar:*)"', '"Bash(zip:*)"', '"Bash(unzip:*)"',
    '"Bash(apt:*)"', '"Bash(apt-get:*)"', '"Bash(dpkg:*)"',
    '"Bash(systemctl:*)"', '"Bash(journalctl:*)"',
    '"Bash(docker:*)"', '"Bash(ssh:*)"', '"Bash(scp:*)"',
    '"Bash(make:*)"', '"Bash(gcc:*)"', '"Bash(cargo:*)"', '"Bash(go:*)"',
    '"Bash(gh:*)"',
  ].join(" ");
  let envPreamble;
  if (ISOLATION && !isAdmin) {
    // Isolation mode: project user has clean env via sudo -u, no stripping needed
    envPreamble = "";
  } else if (isAdmin) {
    // Admin: inherit full environment (all tokens from ~/.env)
    envPreamble = "";
  } else {
    // Single-user mode non-admin: strip all sensitive env vars, keep only ANTHROPIC_API_KEY
    envPreamble = [
      '_ANTHROPIC_KEY="$ANTHROPIC_API_KEY"',
      'for _v in $(env | grep -oP "^(GITHUB_TOKEN|CLOUDFLARE_|CF_GLOBAL_|CF_TOKEN_|CF_ACCOUNT_|VERCEL_TOKEN|FLY_API_TOKEN|SUPABASE_ACCESS_TOKEN|SENTRY_AUTH_TOKEN|NPM_TOKEN|SMTP_|MAILBABY_|DISCORD_BOT_TOKEN|TELEGRAM_BOT_TOKEN)[^=]*" 2>/dev/null); do unset "$_v"; done',
      'export ANTHROPIC_API_KEY="$_ANTHROPIC_KEY"',
      'unset _ANTHROPIC_KEY',
    ].join("\n");
  }

  const launchWorkDir = projectUser
    ? path.join(projectUser.homeDir, "workspace")
    : userWorkDir;

  // If domains is on and this user has a port, expose it as $PORT
  let portExport = "";
  if (projectUser && projectUser.port) {
    portExport = `export PORT=${projectUser.port}`;
  }

  // sudo -u <user> bash <launcher> doesn't reset HOME by default —
  // it stays as root's $HOME, which makes claude look for credentials
  // at /root/.claude/.credentials.json instead of the project user's
  // own home. Even though the symlink would chain through to admin's
  // creds, claude's interactive flow gives up and falls back to OAuth
  // when HOME-relative discovery fails. Set HOME explicitly so claude
  // resolves creds via its own user's home → .credentials.json symlink
  // → admin's accounts/*.json (group-readable through ccm-auth).
  //
  // Channel routing in 2.1.109 has two flags:
  //   --channels <server:NAME>                       — for plugins on
  //     the approved channels allowlist (managed-settings only)
  //   --dangerously-load-development-channels <...>  — escape hatch
  //     for self-hosted MCP servers that aren't on the allowlist
  //
  // Our whatsapp bridge is the latter (self-hosted), so we MUST use
  // the dangerously-load form. Without channel routing, the bridge's
  // mcp.notification("notifications/claude/channel") *resolves
  // cleanly* but cli silently drops the payload — visible only in
  // mcp-logs-whatsapp/*.jsonl as "Channel notifications skipped:
  // server whatsapp is not on the approved channels allowlist (use
  // --dangerously-load-development-channels for local dev)". The
  // reconciler then retries 3x and quarantines every message.
  const homeExport = projectUser ? `export HOME="${projectUser.homeDir}"` : "";
  const mcpConfigPath = path.join(launchWorkDir, ".mcp.json");
  // Group sessions get their own env file set via /group-token. Source
  // it BEFORE cc-watchdog so claude inherits the per-group tokens, but
  // AFTER homeExport so the env file path resolves correctly. Not
  // exposed for non-group users — they either use /root/.env (admin)
  // or get no tokens.
  const groupEnvFile = userJid.endsWith("@g.us")
    ? path.join(USERS_DIR, sanitizeUserId(userJid), "env")
    : null;
  const groupEnvSource = groupEnvFile
    ? `if [ -r "${groupEnvFile}" ]; then set -a; . "${groupEnvFile}"; set +a; fi`
    : "";
  const launcherBody = [
    "#!/bin/bash",
    envPreamble,
    homeExport,
    portExport,
    groupEnvSource,
    `cd "${launchWorkDir}"`,
    `exec cc-watchdog --mcp-config "${mcpConfigPath}" --dangerously-load-development-channels server:whatsapp --permission-mode bypassPermissions --allowedTools ${allowedTools}`,
  ].filter(Boolean).join("\n") + "\n";

  fs.writeFileSync(launcher, launcherBody);
  fs.chmodSync(launcher, 0o755);
  // In isolation mode, the launcher lives in project user's home — fix ownership
  if (projectUser) {
    try { execFileSync("chown", [`${projectUser.username}:${projectUser.username}`, launcher]); } catch {}
  }

  // In isolation mode: tmux session is owned by admin, command inside runs as project user via sudo
  const tmuxArgs = projectUser
    ? ["new-session", "-d", "-s", sessionName, "-x", "200", "-y", "50", "sudo", "-u", projectUser.username, "bash", launcher]
    : ["new-session", "-d", "-s", sessionName, "-x", "200", "-y", "50", launcher];

  execFile("tmux", tmuxArgs, (err) => {
    if (err) { log(`spawn failed for ${userId}: ${err}`); return; }
    log(`spawned ${sessionName}${projectUser ? ` as ${projectUser.username}` : ""}`);
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

let sock = null; let connectionReady = false; let retryCount = 0; let connectedAt = 0; let lastInboundAt = 0; let watchdogTimer = null; let wasPairing = false;
function computeDelay(n) { const b = Math.min(RECONNECT.initialMs * Math.pow(RECONNECT.factor, n), RECONNECT.maxMs); return Math.max(250, Math.round(b + b * RECONNECT.jitter * (Math.random() * 2 - 1))); }
function cleanupSocket() { if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; } if (sock) { try { sock.ev.removeAllListeners(); } catch {} try { sock.end(undefined); } catch {} sock = null; } connectionReady = false; }

async function connectWhatsApp() {
  cleanupSocket(); maybeRestoreCredsFromBackup();
  const authState = await useMultiFileAuthState(AUTH_DIR);
  saveCreds = authState.saveCreds;
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ auth: { creds: authState.state.creds, keys: makeCacheableSignalKeyStore(authState.state.keys, logger) }, version, logger, printQRInTerminal: false, browser: ["Mac OS", "Safari", "1.0.0"], syncFullHistory: false, markOnlineOnConnect: true, getMessage: async (key) => { const c = rawMessages.get(key.id); return c?.message || { conversation: "" }; } });

  sock.ev.on("creds.update", enqueueSaveCreds);
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { wasPairing = true; qrcode.generate(qr, { small: true }, (code) => { log("scan QR code"); process.stderr.write(code + "\n"); }); }
    if (connection === "close") {
      connectionReady = false; const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === 440) { log("session conflict (440) — exiting to let launcher restart with cooldown"); saveConnTimestamp(); cleanupSocket(); process.exit(1); }
      if (reason === DisconnectReason.loggedOut) { log("logged out (401)"); return; }
      if (reason === 515) { log("restart (515)"); setTimeout(connectWhatsApp, 2000); return; }
      if (connectedAt && Date.now() - connectedAt > HEALTHY_THRESHOLD) retryCount = 0;
      if (retryCount >= 5) { log("max retries (5) — waiting 5 min"); retryCount = 0; setTimeout(connectWhatsApp, 300000); return; }
      setTimeout(connectWhatsApp, computeDelay(retryCount++));
    }
    if (connection === "open") {
      connectionReady = true; connectedAt = Date.now(); retryCount = 0;
      // Verify registration status
      try {
        const creds = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, "creds.json"), "utf8"));
        if (creds.registered === false) {
          log("WARNING: connected but registered=false — device may be deregistered. Re-pair needed.");
          log("Clear auth dir and restart to show QR code.");
        }
      } catch {}
      log("connected");
      saveConnTimestamp();
      // Auto-detach tmux only after fresh QR pairing (not on reconnects)
      if (wasPairing) {
        wasPairing = false;
        if (process.env.TMUX) {
          setTimeout(() => {
            log("paired successfully — detaching tmux session");
            execFile("tmux", ["detach-client"], () => {});
          }, 2000);
        }
      }
      if (watchdogTimer) clearInterval(watchdogTimer);
      watchdogTimer = setInterval(() => {
        if (!connectionReady || !lastInboundAt) return;
        if (Date.now() - lastInboundAt <= STALE_TIMEOUT) return;
        // Don't reconnect if device is deregistered — reconnecting won't help, just burns credentials
        try {
          const c = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, "creds.json"), "utf8"));
          if (c.registered === false) return;
        } catch {}
        log("stale — reconnecting");
        // Reset lastInboundAt so the new connection gets a full
        // STALE_TIMEOUT window to receive messages. Otherwise the
        // watchdog fires every WATCHDOG_INTERVAL (60s) forever because
        // lastInboundAt never advances while inbound traffic is idle,
        // burning reconnects and spamming the log.
        lastInboundAt = Date.now();
        connectWhatsApp();
      }, WATCHDOG_INTERVAL);
    }
  });
  sock.ev.on('messages.update', (updates) => {
    try {
      if (!Array.isArray(updates)) return;
      for (const u of updates) {
        if (!u?.key?.id || !u?.update) continue;
        if (u.key.fromMe !== true) continue;
        const { event, target } = dispatchAck(u.update.status);
        if (!event) continue;
        const attr = msgIdToFilename.get(u.key.id);
        const extras = { msg_id: u.key.id };
        if (attr) { extras.filename = attr.filename; extras.chat_id = attr.chatId; }
        const auditor = attr ? outboxAuditors.get(attr.dir) : null;
        if (auditor) auditor(event, extras);
        if (target === "acked") markAcked(u.key.id);
        else if (target === "errored") markErrored(u.key.id);
      }
    } catch (e) { log(`messages.update handler error: ${e}`); }
  });
  if (sock.ws && typeof sock.ws.on === "function") sock.ws.on("error", (err) => log(`ws error: ${err}`));

  // ── Message handler ─────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages }) => {
    // log(`messages.upsert: ${messages.length} message(s)`);
    for (const msg of messages) {
      const rjid = msg.key?.remoteJid || "";
      // Debug: if (rjid.endsWith("@g.us")) log(`group: ${rjid} text="${extractText(msg.message||{}).slice(0,30)}"`);
      if (!msg.message || msg.key.fromMe) continue;
      // Handle poll votes — match to pending permission polls
      if (msg.message.pollUpdateMessage) {
        const pollKey = msg.message.pollUpdateMessage.pollCreationMessageKey;
        if (pollKey?.id && pendingPolls.has(pollKey.id)) {
          const pending = pendingPolls.get(pollKey.id);
          pendingPolls.delete(pollKey.id);
          // Try to decrypt the vote
          let behavior = "allow"; // default to allow if we can't decrypt
          try {
            const { decryptPollVote } = require("@whiskeysockets/baileys");
            const pollCreationMsg = rawMessages.get(pollKey.id);
            if (pollCreationMsg?.message) {
              const pollCreate = pollCreationMsg.message.pollCreationMessageV3 || pollCreationMsg.message.pollCreationMessage;
              if (pollCreate?.encKey) {
                const vote = decryptPollVote(
                  { encPayload: msg.message.pollUpdateMessage.vote?.encPayload, encIv: msg.message.pollUpdateMessage.vote?.encIv },
                  { pollCreatorJid: pollKey.remoteJid, pollMsgId: pollKey.id, pollEncKey: pollCreate.encKey, voterJid: msg.key.remoteJid || msg.key.participant }
                );
                if (vote?.selectedOptions?.length) {
                  const selected = vote.selectedOptions.map((o) => Buffer.from(o).toString("utf8"));
                  if (selected.some((s) => s.includes("Deny"))) behavior = "deny";
                  else if (selected.some((s) => s.includes("Always"))) behavior = "always";
                }
              }
            }
          } catch (e) { log(`poll decrypt error: ${e}`); }

          const actualBehavior = behavior === "always" ? "allow" : behavior;
          log(`poll vote: ${behavior} for ${pending.requestId} (user ${pending.userId})`);

          // Write response for bridge
          fs.writeFileSync(path.join(USERS_DIR, pending.userId, "permissions", `response-${pending.requestId}.json`), JSON.stringify({ request_id: pending.requestId, behavior: actualBehavior }));
          try { fs.unlinkSync(path.join(USERS_DIR, pending.userId, "permissions", `request-${pending.requestId}.json`)); } catch {}

          if (behavior === "deny") {
            execFile("tmux", ["send-keys", "-t", getUserSessionName(pending.userId), "Escape"], () => {});
          } else if (behavior === "always" && pending.patternSig) {
            // Save pattern for auto-approve
            if (!approvedPatterns.has(pending.userId)) approvedPatterns.set(pending.userId, []);
            approvedPatterns.get(pending.userId).push({ tool: pending.toolName, pattern: pending.patternSig });
            log(`pattern saved: ${pending.toolName}:${pending.patternSig} for ${pending.userId}`);
          }
        }
        continue;
      }
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith("@broadcast") || jid.endsWith("@status")) continue;
      const msgId = msg.key.id; const participant = msg.key.participant;
      if (msgId && isDuplicate(`${jid}:${msgId}`)) continue;

      // OTP — works for anyone
      if (!jid.endsWith("@g.us")) {
        const otp = loadOtp();
        if (otp && extractText(msg.message || {}).trim().toUpperCase() === otp.code) {
          if (otp.type === "admin") {
            // Write both the per-channel admin (legacy consumers still
            // read ADMIN_FILE directly) AND the global admin file (the
            // new source of truth for /usage quota, cross-channel polls,
            // and future ccm admin management).
            const adminJson = JSON.stringify({ jid }) + "\n";
            fs.writeFileSync(ADMIN_FILE, adminJson);
            try {
              fs.mkdirSync(path.dirname(GLOBAL_ADMIN_FILE), { recursive: true });
              fs.writeFileSync(GLOBAL_ADMIN_FILE, adminJson);
            } catch (e) { log(`global admin write failed: ${e}`); }
            addToWhitelist(jid);
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

      // Discover groups before access check — save meta so they appear in the menu
      if (jid.endsWith("@g.us")) {
        const gUserId = sanitizeUserId(jid);
        const gDir = getUserDir(gUserId);
        const gMeta = path.join(gDir, "meta.json");
        let gm = {}; try { gm = JSON.parse(fs.readFileSync(gMeta, "utf8")); } catch {}
        gm.jid = jid; gm.isGroup = true; gm.lastSeen = new Date().toISOString();
        try { const gInfo = await sock.groupMetadata(jid); if (gInfo?.subject) gm.name = gInfo.subject; } catch {}
        fs.writeFileSync(gMeta, JSON.stringify(gm, null, 2) + "\n");
      }

      // /invite + /redeem — must run BEFORE the whitelist gate so a user
      // who isn't on the whitelist yet can redeem their way in. DM-only
      // (group invites would leak the code on a single screen).
      if (!jid.endsWith("@g.us")) {
        const inviteHandled = await handleInviteCommands({ sock, msg, jid });
        if (inviteHandled) continue;
        const adminCmdHandled = await handleAdminUserCommands({ sock, msg, jid });
        if (adminCmdHandled) continue;
      }

      // /enable-group + /disable-group + /trigger — in-group admin commands.
      // Also run BEFORE the whitelist gate so the first /enable-group in a
      // fresh group can register it.
      if (jid.endsWith("@g.us")) {
        const groupAdminHandled = await handleGroupAdminCommands({ sock, msg, jid, participant });
        if (groupAdminHandled) continue;
      }

      if (!isAllowed(jid, participant || undefined)) continue;

      // Group messages: only respond when triggered
      if (jid.endsWith("@g.us")) {
        const access = loadAccess();
        const groupText = extractText(msg.message || {});
        const cleanText = groupText.replace(/[\u2066\u2067\u2068\u2069\u200E\u200F\u200B\u200C\u200D\uFEFF]/g, "");
        const trigger = (access.groupTrigger || "@ai").toLowerCase();
        const botLidNum = (sock?.user?.lid || "").split(":")[0];
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.some(
          (m) => m.includes(PHONE) || (sock?.user?.id && m.includes(sock.user.id.split(":")[0])) || (botLidNum && m.includes(botLidNum))
        );
        const prefixed = cleanText.toLowerCase().startsWith(trigger);
        const containsTrigger = cleanText.toLowerCase().includes(trigger);
        // Check if replying to a message from the bot
        const quotedCtx = msg.message?.extendedTextMessage?.contextInfo || {};
        const quotedParticipant = quotedCtx.participant || "";
        const botId = sock?.user?.id || "";
        const botLid = sock?.user?.lid || "";
        const isReplyToBot = !!quotedCtx.stanzaId && (
          quotedParticipant.includes(PHONE) ||
          (botId && quotedParticipant.includes(botId.split(":")[0])) ||
          (botLid && quotedParticipant.includes(botLid.split(":")[0]))
        );
        // Slash commands ("/help", "/usage", …) are self-declaring — no
        // @ai mention needed. The `/` prefix already says "this is a
        // command for the bot", matching every major chat product.
        const isSlashCommand = cleanText.trimStart().startsWith("/");
        const isDirectMode = (access.directGroups || []).includes(jid);
        if (!isDirectMode && !isSlashCommand && !mentioned && !prefixed && !containsTrigger && !isReplyToBot) {
          continue;
        }
      }

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
              }
              break;
            }
          }
        } catch {}
        continue;
      }

      try { await sock.readMessages([msg.key]); } catch {}
      lastInboundAt = Date.now(); storeRaw(msg);

      // Route to session — groups share one session, DMs get per-user sessions
      const isGroup = jid.endsWith("@g.us");
      const senderJid = participant || jid;
      const sessionJid = isGroup ? jid : senderJid;  // groups: use group JID
      const userId = sanitizeUserId(sessionJid);
      const userDir = getUserDir(userId);
      userActivity.set(userId, Date.now());
      try { sock.sendPresenceUpdate("composing", jid); } catch {}

      // Save/update meta
      const metaFile = path.join(userDir, "meta.json");
      const pushName = msg.pushName || "";
      let userMeta = {};
      try { userMeta = JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch {}
      userMeta.jid = sessionJid;
      userMeta.lastSeen = new Date().toISOString();
      if (isGroup) {
        userMeta.isGroup = true;
        // Always sync group name so renames are reflected
        try { const gMeta = await sock.groupMetadata(jid); if (gMeta?.subject) userMeta.name = gMeta.subject; } catch {}
      } else {
        if (pushName) { userMeta.pushName = pushName; userMeta.name = pushName; }
      }
      fs.writeFileSync(metaFile, JSON.stringify(userMeta, null, 2) + "\n");

      // ── TOS acceptance gate ─────────────────────────────────────
      // Each user must individually agree to TOS before using the bot.
      // In groups, tracked per-sender in meta.json.tosAcceptedUsers[].
      // In DMs, tracked as tosAccepted on the user's own meta.
      // Admin is always exempt.
      const adminCheck = loadAdmin();
      const isAdminSender = adminCheck && (
        adminCheck.jid === senderJid || toJid(adminCheck.jid) === senderJid
        || formatJid(adminCheck.jid) === formatJid(senderJid)
      );
      if (!isAdminSender) {
        const acceptedUsers = userMeta.tosAcceptedUsers || [];
        // Groups: check per-user list OR group-level flag (grandfathered groups)
        const senderAccepted = isGroup
          ? userMeta.tosAccepted || acceptedUsers.includes(senderJid) || acceptedUsers.includes(formatJid(senderJid))
          : userMeta.tosAccepted;
        if (!senderAccepted) {
          const rawText = (extractText(msg.message) || "").trim();
          // Strict match: exactly "agree" or "I agree" (not "I don't agree")
          const isAccept = /^(i\s+)?agree\.?$/i.test(rawText);
          if (isAccept) {
            if (isGroup) {
              if (!userMeta.tosAcceptedUsers) userMeta.tosAcceptedUsers = [];
              userMeta.tosAcceptedUsers.push(senderJid);
            } else {
              userMeta.tosAccepted = true;
            }
            userMeta.tosLastAcceptedAt = new Date().toISOString();
            fs.writeFileSync(metaFile, JSON.stringify(userMeta, null, 2) + "\n");
            try {
              await sock.sendMessage(jid, { text: "✅ Terms accepted. Let's get started! How can I help?" });
            } catch {}
            log(`tos: accepted by ${formatJid(senderJid)} in ${userId}`);
            continue;
          }
          // Not yet accepted — send TOS prompt (once per sender via _tosSentTo)
          const tosSentTo = userMeta._tosSentTo || [];
          if (!tosSentTo.includes(senderJid)) {
            try {
              await sock.sendMessage(jid, { text:
                "👋 Welcome! Before we begin, please review our terms:\n\n"
                + "• All code and assets generated here are intellectual property of HOKO CORP LIMITED\n"
                + "• AI-generated prototypes require professional review before production use\n"
                + "• Deployment and source code licensing available through HOKOCORP\n\n"
                + "Full terms: https://ccm.hokocorp.com/terms\n\n"
                + "Reply *agree* to continue."
              });
            } catch {}
            if (!userMeta._tosSentTo) userMeta._tosSentTo = [];
            userMeta._tosSentTo.push(senderJid);
            fs.writeFileSync(metaFile, JSON.stringify(userMeta, null, 2) + "\n");
          } else {
            try {
              await sock.sendMessage(jid, { text: "Please reply *agree* to accept the terms before we can get started.\n\nFull terms: https://ccm.hokocorp.com/terms" });
            } catch {}
          }
          continue;
        }
      }

      let text = extractText(msg.message); const media = extractMediaInfo(msg.message);
      // Strip invisible Unicode and trigger from group messages
      if (isGroup && text) {
        text = text.replace(/[\u2066\u2067\u2068\u2069\u200E\u200F\u200B\u200C\u200D\uFEFF]/g, "");
        const trigger = (loadAccess().groupTrigger || "@ai");
        text = text.replace(new RegExp(trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim();
      }
      // If text is empty after trigger stripping but the message quotes
      // another message, include the quoted text so Claude has context.
      // Common case: user sends a message without @ai, then quotes it
      // and types only "@ai" — without this, Claude would get "(empty)".
      if (isGroup && !text) {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quotedMsg) {
          const quotedText = extractText(quotedMsg);
          if (quotedText) {
            text = `[Quoted message] ${quotedText}`;
          }
        }
      }
      // Channel slash commands (/help, /clear, /compact, OTP confirm) — check
      // before /usage so they short-circuit cleanly. Falls through (returns
      // false) for any text that isn't one of these commands or a pending OTP.
      {
        // Mirror findUserSessionFiles() — in isolation mode the project user's
        // session files live under /home/<isolation-user>/, not admin's home.
        const projectUserHome = ISOLATION
          ? `/home/${isolationGetUsername(userId)}`
          : os.homedir();
        const userWorkDir = ISOLATION
          ? path.join(projectUserHome, "workspace")
          : path.join(getUserDir(userId), "workspace");
        const projectDirCandidates = [
          userWorkDir.replace(/\//g, "-"),
          userWorkDir.replace(/[/.]/g, "-"),
          userWorkDir.replace(/\//g, "-").replace(/-\./g, "."),
        ].map(slug => path.join(projectUserHome, ".claude", "projects", slug));
        const sessionName = getUserSessionName(userId);
        const slashAdmin = loadAdmin();
        const slashIsAdmin = slashAdmin && (slashAdmin.jid === jid || toJid(slashAdmin.jid) === jid);
        const handled = await channelSlash.handleChannelSlashCommand({
          userId,
          text,
          reply: async (t) => {
            try { await sock.sendMessage(jid, { text: t }); }
            catch (e) { log(`channel-slash reply failed: ${e}`); }
          },
          tmux: tmuxHelper,
          paths: { projectDirCandidates, sessionName },
          isAdmin: slashIsAdmin,
        });
        if (handled) continue;
      }

      // /domain — show the user their hosted project URL.
      if (text && text.trim().toLowerCase() === "/domain") {
        const url = getUserSubdomainUrl(userId);
        const reply = url
          ? `🌐 Your project URL: ${url}\n\nBind your dev server to \`$PORT\` (already exported in your shell) and I can run it on this URL.`
          : "🌐 No subdomain assigned yet — you don't have an isolated project space on this server.";
        try { await sock.sendMessage(jid, { text: reply }); } catch {}
        continue;
      }

      // /topup (bare) — user-facing credits message. Admin with this bare
      // form gets a usage hint instead; /topup HASH USD for actual admin
      // top-up is handled earlier in handleAdminUserCommands.
      if (text && text.trim().toLowerCase() === "/topup") {
        const topupAdmin = loadAdmin();
        const topupIsAdmin = topupAdmin && (topupAdmin.jid === jid || toJid(topupAdmin.jid) === jid);
        const reply = topupIsAdmin
          ? "💰 Admin top-up usage: `/topup HASH USD` — see /users for hashes.\n\n(Bare /topup from a non-admin user shows the beta credit-request message.)"
          : "💰 HOKO Coder is in beta.\n\nPlease contact the admin if you need more API credits.";
        try { await sock.sendMessage(jid, { text: reply }); } catch {}
        continue;
      }

      // /usage command — check BEFORE sender prefix so it works in groups too
      // (text has already been trigger-stripped at this point, e.g. "@ai /usage" → "/usage")
      if (text && /^\/usage\s+history$/i.test(text.trim())) {
        const u = syncUserUsage(userId);
        const fmtN = (n) => { const a = Math.abs(n); return a >= 1e6 ? `${(n/1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(n/1e3)}K` : String(n); };
        const fmtUSD = (n) => n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;

        const lines = [`📋 Usage History`];

        // Monthly summaries
        const months = Object.keys(u.months || {}).sort().reverse();
        if (months.length > 0) {
          lines.push(``);
          lines.push(`Monthly:`);
          for (const m of months) {
            const mo = u.months[m];
            const billable = (mo.input_tokens || 0) + (mo.output_tokens || 0) + (mo.cache_5m || 0) + (mo.cache_1h || 0);
            lines.push(`  ${m}: ${fmtN(billable)} tokens`);
          }
        }

        // Top-up history
        if (u.history && u.history.length > 0) {
          lines.push(``);
          lines.push(`Top-ups:`);
          for (const h of u.history.slice(-10)) {
            const note = h.note ? ` — ${h.note}` : "";
            lines.push(`  ${h.date}: ${fmtUSD(h.amount)}${note}`);
          }
        }

        lines.push(``);
        lines.push(`Balance: ${fmtUSD(u.balance || 0)} | Total added: ${fmtUSD(u.total_added || 0)} | Total spent: ${fmtUSD(u.total_cost || 0)}`);

        try { await sock.sendMessage(jid, { text: lines.join("\n") }); } catch {}
        continue;
      }
      if (text && text.trim().toLowerCase() === "/usage") {
        const u = syncUserUsage(userId);
        const adminCheck = loadAdmin();
        const isAdminUser = adminCheck && userId === sanitizeUserId(adminCheck.jid);
        const mo = u.months?.[monthKey()] || { input_tokens: 0, output_tokens: 0, cache_5m: 0, cache_1h: 0, cache_read: 0, models: {} };

        // Formatting helpers
        const fmtN = (n) => { const a = Math.abs(n); return a >= 1e6 ? `${(n/1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(n/1e3)}K` : String(n); };
        const fmtUSD = (n) => n < 0.01 ? `<$0.01` : `$${n.toFixed(2)}`;

        // API pricing per million tokens (current Anthropic rates)
        const PRICING = {
          "claude-opus-4-6":   { input: 15, output: 75, cache_5m: 18.75, cache_1h: 22.50, cache_read: 1.50 },
          "claude-sonnet-4-6": { input: 3, output: 15, cache_5m: 3.75, cache_1h: 4.50, cache_read: 0.30 },
          "claude-haiku-4-5":  { input: 0.80, output: 4, cache_5m: 1.00, cache_1h: 1.20, cache_read: 0.08 },
        };
        // Match model name to pricing tier (e.g., "claude-opus-4-6[1m]" → "claude-opus-4-6")
        const matchPricing = (model) => {
          for (const key of Object.keys(PRICING)) { if (model.startsWith(key)) return PRICING[key]; }
          return PRICING["claude-sonnet-4-6"]; // default
        };

        // Calculate cost per model
        let totalCost = 0;
        const modelLines = [];
        for (const [model, mu] of Object.entries(mo.models || {})) {
          const p = matchPricing(model);
          const cost = (mu.input_tokens * p.input + mu.output_tokens * p.output + mu.cache_5m * p.cache_5m + mu.cache_1h * p.cache_1h + mu.cache_read * p.cache_read) / 1e6;
          totalCost += cost;
          const shortName = model.replace("claude-", "").replace(/\[.*\]/, "");
          modelLines.push(`  ${shortName}: in=${fmtN(mu.input_tokens)} out=${fmtN(mu.output_tokens)} 5m=${fmtN(mu.cache_5m)} 1h=${fmtN(mu.cache_1h)} read=${fmtN(mu.cache_read)} → ${fmtUSD(cost)}`);
        }

        const billable = (mo.input_tokens || 0) + (mo.output_tokens || 0) + (mo.cache_5m || 0) + (mo.cache_1h || 0);

        const lines = [
          isAdminUser ? `📊 Usage (Admin — Unlimited)` : `📊 Usage`,
        ];
        if (!isAdminUser) {
          lines.push(`💰 Balance: $${(u.balance || 0).toFixed(2)}${u.balance <= 0 ? " ⚠️" : ""}`);
        }
        lines.push(``);
        lines.push(`This month (${monthKey()}):`);
        lines.push(`  Input:       ${fmtN(mo.input_tokens || 0)}`);
        lines.push(`  Output:      ${fmtN(mo.output_tokens || 0)}`);
        lines.push(`  Cache 5m:    ${fmtN(mo.cache_5m || 0)}`);
        lines.push(`  Cache 1h:    ${fmtN(mo.cache_1h || 0)}`);
        lines.push(`  Cache read:  ${fmtN(mo.cache_read || 0)}`);
        if (modelLines.length > 0) {
          lines.push(``);
          lines.push(`Per model:`);
          lines.push(...modelLines);
        }
        lines.push(``);
        lines.push(`Month cost: ${fmtUSD(totalCost)}`);
        lines.push(`All time: ${fmtUSD(u.total_cost || 0)} spent`);

        if (isAdminUser) {
          try {
            const q = await captureAdminQuota();
            if (q) {
              lines.push(``);
              lines.push(`📊 Admin quota`);
              const sessionLabel = q.sessionResetsAt ? ` (resets ${q.sessionResetsAt})` : ``;
              const weekLabel    = q.weekResetsAt    ? ` (resets ${q.weekResetsAt})`    : ``;
              lines.push(`Session: ${q.sessionRemainingPct}% remaining${sessionLabel}`);
              lines.push(`Weekly: ${q.weekRemainingPct}% remaining${weekLabel}`);
            } else {
              lines.push(``);
              lines.push(`📊 Admin quota: (unavailable)`);
            }
          } catch { /* ignore scrape errors in /usage path */ }
        }

        try { await sock.sendMessage(jid, { text: lines.join("\n") }); } catch {}
        continue;
      }

      const senderName = pushName || formatJid(senderJid);
      // In groups, prefix the message with sender name so Claude knows who's talking
      if (isGroup && text) text = `[${senderName}] ${text}`;
      const meta = { chat_id: jid, message_id: msgId, user: formatJid(senderJid), ts: new Date((Number(msg.messageTimestamp) || Date.now() / 1000) * 1000).toISOString() };
      if (isGroup) { meta.group = "true"; meta.sender_name = senderName; }
      if (media) { meta.attachment_count = "1"; meta.attachments = `${media.filename || media.type + "." + mimeToExt(media.mimetype)} (${media.mimetype}, ${(media.size / 1024).toFixed(0)}KB)`; }

      // Block terminal-only slash commands that hijack the Claude Code session
      // (e.g. /btw opens a side conversation that hangs waiting for terminal input)
      const BLOCKED_COMMANDS = ["/btw", "/login", "/logout", "/doctor", "/config", "/fast", "/slow", "/effort"];
      const trimmedText = (text || "").trimStart().toLowerCase();
      const blockedCmd = BLOCKED_COMMANDS.find((cmd) => trimmedText === cmd || trimmedText.startsWith(cmd + " "));
      if (blockedCmd) {
        try {
          await sock.sendMessage(jid, { text: `⚠️ \`${blockedCmd}\` is a terminal-only command and can't be used via WhatsApp. Just send your message normally.` });
        } catch {}
        continue;
      }

      const inboxMsg = { content: text || (media ? `(${media.type})` : "(empty)"), meta, raw_msg_id: msgId };
      const tmp = path.join(userDir, "inbox", `.${Date.now()}-${msgId}.tmp`);
      const final = path.join(userDir, "inbox", `${Date.now()}-${msgId}.json`);
      fs.writeFileSync(tmp, JSON.stringify(inboxMsg)); fs.renameSync(tmp, final);

      // Check token balance before dispatching
      const usageCheck = checkUserLimit(userId);
      if (!usageCheck.allowed) {
        log(`user ${userId} blocked — balance: $${usageCheck.balance.toFixed(2)}`);
        try { fs.unlinkSync(final); } catch {}
        const balStr = usageCheck.balance < 0
          ? `Negative balance: $${usageCheck.balance.toFixed(2)} (overshoot from last call).`
          : "No credit. Ask admin to top up your wallet.";
        try { await sock.sendMessage(jid, { text: balStr }); } catch (e) { log(`failed to send limit msg: ${e}`); }
        continue;
      }
      if (usageCheck.warned) {
        log(`user ${userId} low balance: $${usageCheck.balance.toFixed(2)}`);
        try { await sock.sendMessage(jid, { text: `[Low balance: $${usageCheck.balance.toFixed(2)} remaining]` }); } catch {}
      }

      // Capacity check: if all Claude accounts exhausted, reply directly via outbox
      // and do not spawn a Claude session (it would just error out).
      if (fs.existsSync(CAPACITY_FLAG)) {
        const admin = loadAdmin();
        const isAdmin = admin && (admin.jid === sessionJid || toJid(admin.jid) === sessionJid);
        sendCapacityMessage(sessionJid, isAdmin);
        continue;  // do not spawn; keep processing other messages in this batch
      }

      // Auto-unfreeze: if the group was frozen (bot removed/group deleted)
      // but we're now receiving a message, the bot was re-added. Unfreeze
      // so the session resumes with its existing workspace intact.
      const frozenFile = path.join(userDir, "frozen.json");
      if (fs.existsSync(frozenFile)) {
        log(`auto-unfreeze: ${userId} — received message in frozen session`);
        unfreezeGroupSession(userId);
      }

      spawnUserSession(userId, sessionJid);
      armStallWatchdog(userId, sessionJid);
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

  // ── Group lifecycle: freeze on bot removal or group deletion ────
  // Baileys fires group-participants.update when members are added/removed.
  // If the bot itself is removed, freeze the group's session + workspace.
  //
  // Safety: ignore group events that arrive within 30s of connection open.
  // On reconnect, Baileys may replay stale participant events from history
  // sync — these are not real-time removals and must not trigger a freeze.
  const GROUP_EVENT_GRACE_MS = 30000;

  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    if (action !== "remove") return;
    // Ignore events during reconnect grace period
    if (!connectedAt || Date.now() - connectedAt < GROUP_EVENT_GRACE_MS) {
      log(`group-participants.update ignored (grace period) for ${id}`);
      return;
    }
    // Check if the bot was removed
    const botNumber = String(PHONE);
    const botRemoved = participants.some(
      (p) => p.includes(botNumber) || (sock?.user?.id && p.includes(sock.user.id.split(":")[0]))
    );
    if (!botRemoved) return;

    // Double-check: try to fetch group metadata. If we're still in the
    // group, this was a stale event — do not freeze.
    try {
      await sock.groupMetadata(id);
      log(`freeze aborted for ${id} — bot still in group (stale event)`);
      return;
    } catch {
      // groupMetadata throws if we're not in the group — proceed with freeze
    }

    const userId = sanitizeUserId(id);
    log(`bot removed from group ${id} — freezing session ${userId}`);
    freezeGroupSession(userId, "bot_removed_from_group");

    // Notify admin
    const admin = loadAdmin();
    if (admin?.jid) {
      let groupName = id;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(USERS_DIR, userId, "meta.json"), "utf8"));
        if (meta.name) groupName = meta.name;
      } catch {}
      try {
        await sock.sendMessage(toJid(admin.jid), {
          text: `🧊 Bot was removed from group *${groupName}*.\n\nSession frozen. Workspace data retained for ${FREEZE_RETENTION_DAYS} days.\nTo unfreeze (if re-added): the session will auto-resume on next message.`,
        });
      } catch {}
    }
  });

  // Baileys fires groups.update when group metadata changes — including deletion.
  // A deleted group has announce === undefined and subject === undefined.
  sock.ev.on("groups.update", async (updates) => {
    // Ignore during reconnect grace period
    if (!connectedAt || Date.now() - connectedAt < GROUP_EVENT_GRACE_MS) return;

    for (const update of updates) {
      // Detect group deletion: Baileys sends an update where the group
      // is essentially emptied. We check if subject becomes empty/null.
      if (update.id && update.subject === null) {
        const userId = sanitizeUserId(update.id);
        const userDir = path.join(USERS_DIR, userId);
        if (!fs.existsSync(userDir)) continue;

        log(`group ${update.id} appears deleted — freezing session ${userId}`);
        freezeGroupSession(userId, "group_deleted");

        const admin = loadAdmin();
        if (admin?.jid) {
          let groupName = update.id;
          try {
            const meta = JSON.parse(fs.readFileSync(path.join(USERS_DIR, userId, "meta.json"), "utf8"));
            if (meta.name) groupName = meta.name;
          } catch {}
          try {
            await sock.sendMessage(toJid(admin.jid), {
              text: `🧊 Group *${groupName}* was deleted.\n\nSession frozen. Data retained for ${FREEZE_RETENTION_DAYS} days.`,
            });
          } catch {}
        }
      }
    }
  });
}

// ── Per-user outbox processor — redelivery-aware ────────────────────
// Reconciler-based: each outbox dir has its own createOutboxReconciler
// instance. On sendFn success, msgIds go into sendState; messages.update
// populates outboxAckedIds; next tick unlinks the file. On send throw,
// file stays and is retried. Gateway restart re-sends unacked files
// (possible visible duplicate — see spec §5.5). Fire-and-forget actions
// (typing indicators, download) bypass the ack-tracking path.

const outboxReconcilers = new Map(); // dir -> reconciler tick fn

// ── Stall-watchdog: surface silent upstream failures ────────────────
// When a user DMs the bot and the underlying assistant hits an API
// error (500, quota, auth) before it can call mcp__whatsapp__reply,
// there's no outbox file and the user just sits in silence. We arm a
// per-user timer on inbox; any outbox action disarms it. When the
// timer fires we diff the session pane against its snapshot-at-arm:
//
//   - pane changed & contains an error pattern  → fire error-specific
//     fallback (the assistant was working on it but hit a failure we
//     can recognise)
//   - pane changed & no error pattern           → the assistant is
//     still producing output; re-arm for another window instead of
//     pre-empting the user with a false "stuck" message
//   - pane unchanged                             → genuinely stuck,
//     send the generic fallback
//
// Cap the total re-arm count so a runaway build can't silently loop.
const STALL_WATCHDOG_MS = 3 * 60 * 1000;
const STALL_MAX_REARMS = 4; // 5 windows × 3 min = 15 min of patience
const stallWatchdogs = new Map(); // uid -> { timer, chatJid, paneSnapshot, rearmCount }
const STALL_ERROR_PATTERNS = [
  { re: /API Error:\s*5\d\d\s+([^\n]+)/i,                     label: "Upstream API error" },
  { re: /Internal Server Error/i,                              label: "Upstream server error" },
  { re: /(?:Request|Connection) failed:\s*([^\n]+)/i,          label: "Upstream request failed" },
  { re: /Credit balance (?:is\s*)?too low/i,                   label: "Upstream credit exhausted" },
  { re: /rate[\s-]?limit(?:ed)?/i,                             label: "Upstream rate limited" },
  { re: /authentication[_\s-]?error/i,                         label: "Upstream auth error" },
];

function armStallWatchdog(uid, chatJid) {
  disarmStallWatchdog(uid);
  // Snapshot the pane NOW so the fire-path can diff against it and tell
  // "quiet stall" from "actively producing output." paneSnapshotPromise
  // resolves before the timer fires because 3min >> tmux capture latency.
  const paneSnapshotPromise = captureUserPane(uid);
  const timer = setTimeout(() => tickStallWatchdog(uid, chatJid), STALL_WATCHDOG_MS);
  stallWatchdogs.set(uid, { timer, chatJid, paneSnapshotPromise, rearmCount: 0 });
}

function disarmStallWatchdog(uid) {
  const w = stallWatchdogs.get(uid);
  if (!w) return;
  clearTimeout(w.timer);
  stallWatchdogs.delete(uid);
}

async function captureUserPane(uid) {
  const session = getUserSessionName(uid);
  return new Promise((resolve) => {
    execFile("tmux", ["capture-pane", "-t", `${session}.0`, "-p", "-S", "-200"], (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}

function detectStallError(paneText) {
  for (const p of STALL_ERROR_PATTERNS) {
    const m = paneText.match(p.re);
    if (m) return p.label + (m[1] ? `: ${m[1].trim()}` : "");
  }
  return "";
}

async function tickStallWatchdog(uid, chatJid) {
  const w = stallWatchdogs.get(uid);
  if (!w) return; // disarmed between setTimeout callback and now
  try {
    const [priorPane, currentPane] = await Promise.all([
      w.paneSnapshotPromise,
      captureUserPane(uid),
    ]);
    const errorDetail = detectStallError(currentPane);
    const paneChanged = priorPane !== currentPane;

    // Case 1: recognisable error text → fire immediately, no re-arm.
    if (errorDetail) {
      emitStallFallback(uid, chatJid, `⚠️ ${errorDetail}. Please try again in a moment.`);
      stallWatchdogs.delete(uid);
      return;
    }
    // Case 2: pane still changing and no error found → assistant is
    // still working. Re-arm instead of interrupting with a false alarm.
    if (paneChanged && w.rearmCount < STALL_MAX_REARMS) {
      const nextPaneSnapshotPromise = Promise.resolve(currentPane);
      const nextTimer = setTimeout(() => tickStallWatchdog(uid, chatJid), STALL_WATCHDOG_MS);
      stallWatchdogs.set(uid, {
        timer: nextTimer,
        chatJid,
        paneSnapshotPromise: nextPaneSnapshotPromise,
        rearmCount: w.rearmCount + 1,
      });
      return;
    }
    // Case 3: pane unchanged (genuinely stuck) OR rearm budget exhausted
    // → send the generic fallback.
    emitStallFallback(uid, chatJid, `⚠️ No response yet — something may be stuck. Please try rephrasing or retry.`);
    stallWatchdogs.delete(uid);
  } catch (e) {
    log(`stall watchdog tick error for ${uid}: ${e.stack || e}`);
    stallWatchdogs.delete(uid);
  }
}

function emitStallFallback(uid, chatJid, text) {
  try {
    const userDir = path.join(USERS_DIR, uid);
    const outboxFile = path.join(userDir, "outbox", `${Date.now()}-stall-fallback.json`);
    fs.mkdirSync(path.dirname(outboxFile), { recursive: true });
    fs.writeFileSync(outboxFile, JSON.stringify({ action: "reply", chat_id: chatJid, text }));
    log(`stall fallback emitted for ${uid}: ${text}`);
  } catch (e) {
    log(`stall fallback write error for ${uid}: ${e.stack || e}`);
  }
}

async function sendFnGlobal(data) {
  if (!data || !data.jid || !data.text) return { fireAndForget: true };
  const msg = await sock.sendMessage(data.jid, { text: data.text });
  return { msgIds: msg && msg.key && msg.key.id ? [msg.key.id] : [] };
}

function makeSendFnUser(uid) {
  return async function sendFnUser(data) {
    if (!data || !data.action) return { fireAndForget: true };
    userActivity.set(uid, Date.now());

    if (data.action === "typing_start") {
      try { sock.sendPresenceUpdate("composing", data.chat_id); } catch {}
      return { fireAndForget: true };
    }
    if (data.action === "typing_stop") {
      try { sock.sendPresenceUpdate("paused", data.chat_id); } catch {}
      return { fireAndForget: true };
    }
    if (data.action === "download") {
      try {
        const raw = rawMessages.get(data.message_id);
        if (raw?.message) {
          const media = extractMediaInfo(raw.message);
          if (media) {
            const buf = await downloadMediaMessage(raw, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
            const fn = media.filename || `${Date.now()}.${mimeToExt(media.mimetype)}`;
            fs.writeFileSync(path.join(USERS_DIR, uid, "downloads", `${data.message_id}-${fn}`), buf);
          }
        }
      } catch (e) {
        log(`download failed for ${data.message_id}: ${e.message}`);
      }
      return { fireAndForget: true };
    }
    if (data.action === "react") {
      const msg = await sock.sendMessage(data.chat_id, {
        react: { text: data.emoji, key: { remoteJid: data.chat_id, id: data.message_id } }
      });
      return { msgIds: msg && msg.key && msg.key.id ? [msg.key.id] : [] };
    }
    // Any outbox action whatsoever counts as "assistant is alive and
    // producing side effects," so disarm the stall watchdog. This
    // catches not just `reply` but also `typing_start`, `react`, and
    // `download` — without this, long operations that start with a
    // typing indicator still trigger the false-stall fallback.
    disarmStallWatchdog(uid);

    if (data.action === "reply") {
      const msgIds = [];
      if (data.text) {
        const q = data.reply_to ? rawMessages.get(data.reply_to) : undefined;
        const msg = await sock.sendMessage(data.chat_id, { text: data.text }, q ? { quoted: q } : undefined);
        if (msg && msg.key && msg.key.id) msgIds.push(msg.key.id);
      }
      for (const file of (data.files || [])) {
        const ext = path.extname(file).toLowerCase();
        const buf = fs.readFileSync(file);
        let msg;
        if ([".jpg",".jpeg",".png",".gif",".webp"].includes(ext)) {
          msg = await sock.sendMessage(data.chat_id, { image: buf });
        } else if ([".ogg",".mp3",".m4a",".wav"].includes(ext)) {
          msg = await sock.sendMessage(data.chat_id, { audio: buf, mimetype: ext === ".ogg" ? "audio/ogg; codecs=opus" : "audio/mpeg", ptt: ext === ".ogg" });
        } else if ([".mp4",".mov",".avi"].includes(ext)) {
          msg = await sock.sendMessage(data.chat_id, { video: buf });
        } else {
          msg = await sock.sendMessage(data.chat_id, { document: buf, mimetype: "application/octet-stream", fileName: path.basename(file) });
        }
        if (msg && msg.key && msg.key.id) msgIds.push(msg.key.id);
      }
      try { sock.sendPresenceUpdate("paused", data.chat_id); } catch {}
      return { msgIds };
    }
    log(`outbox: unknown action "${data.action}" for ${uid} — discarding`);
    return { fireAndForget: true };
  };
}

function reconcilerFor(dir, sendFn) {
  let r = outboxReconcilers.get(dir);
  if (!r) {
    const audit = createAuditLogger({ outboxDir: dir, log });
    outboxAuditors.set(dir, audit);
    r = outboxReconciler.createOutboxReconciler({
      outboxDir: dir,
      sendFn,
      ackedIds: outboxAckedIds,
      erroredIds: outboxErroredIds,
      now: () => Date.now(),
      stalenessMs: 15000,
      maxAgeMs: 5 * 60 * 1000,
      maxRetries: 3,
      auditEvent: audit,
      registerMsgIds: (filename, msgIds, chatId) => registerMsgIds(dir, filename, msgIds, chatId),
      unregisterFile: (filename) => unregisterFile(dir, filename),
      log,
    });
    outboxReconcilers.set(dir, r);
  }
  return r;
}

let outboxBusy = false;
setInterval(async () => {
  if (!sock || !connectionReady || outboxBusy) return;
  outboxBusy = true;
  try {
    await reconcilerFor(OUTBOX_DIR, sendFnGlobal)();
    for (const uid of (fs.readdirSync(USERS_DIR) || [])) {
      const odir = path.join(USERS_DIR, uid, "outbox");
      try { fs.accessSync(odir); } catch { continue; }
      await reconcilerFor(odir, makeSendFnUser(uid))();
    }
  } catch (e) { log(`outbox scan: ${e}`); }
  finally { outboxBusy = false; }
}, 1500);

async function quotaTick() {
  try {
    const admin = loadAdmin();
    if (!admin || !admin.jid) return;
    const current = await captureAdminQuota();
    if (!current) return;
    const cachePath = adminQuotaFilePath();
    const existing = quotaCache.readQuota(cachePath);
    const { alertsToFire, resetsToClear } = detectTransitions({
      previous: existing?.current || null,
      current,
      lastAlerted: existing?.lastAlerted || { session_25: null, session_10: null, week_25: null, week_10: null },
    });
    const now = Date.now();
    const lastAlerted = {};
    for (const breach of alertsToFire) lastAlerted[`${breach.window}_${breach.threshold}`] = now;
    for (const reset of resetsToClear)  lastAlerted[`${reset.window}_${reset.threshold}`] = null;
    quotaCache.writeQuota(cachePath, { current, lastAlerted });
    if (alertsToFire.length > 0) {
      const adminUserDir = getUserDir(sanitizeUserId(admin.jid));
      for (const breach of alertsToFire) emitQuotaAlert(breach, admin.jid, adminUserDir);
    }
  } catch (e) { log(`quota tick error: ${e.stack || e}`); }
}
setInterval(quotaTick, QUOTA_POLL_INTERVAL_MS);

// ── Permission request relay (via polls) ────────────────────────────

// Map poll message IDs to { requestId, userId, userJid }
const pendingPolls = new Map();
// Pattern-based auto-approve: userId → [{ tool, pattern }]
const approvedPatterns = new Map();

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
          if (d._sent) continue;

          // Check if this matches an already-approved pattern
          const patterns = approvedPatterns.get(uid) || [];
          const toolName = d.tool_name || "";
          let inputSig = "";
          try {
            const p = JSON.parse(d.input_preview);
            if (toolName.toLowerCase().includes("bash")) inputSig = p.command || d.input_preview;
            else inputSig = d.input_preview;
          } catch { inputSig = d.input_preview; }

          const matched = patterns.some((p) => {
            if (p.tool !== toolName) return false;
            if (p.pattern === "*") return true;
            return inputSig.startsWith(p.pattern);
          });
          if (matched) {
            log(`auto-approved ${d.request_id} for ${uid} (pattern match)`);
            fs.writeFileSync(path.join(pdir, `response-${d.request_id}.json`), JSON.stringify({ request_id: d.request_id, behavior: "allow" }));
            fs.unlinkSync(path.join(pdir, f));
            continue;
          }

          d._sent = true;
          fs.writeFileSync(path.join(pdir, f), JSON.stringify(d));

          let action = d.description || "";
          try { const p = JSON.parse(d.input_preview); if ((d.tool_name||"").includes("reply")||(d.tool_name||"").includes("whatsapp")) action = `Send reply: "${(p.text||"").slice(0,100)}"`; else if ((d.tool_name||"").toLowerCase().includes("bash")) action = `Run command: ${(p.command||d.input_preview).slice(0,100)}`; else action = `${d.description}: ${d.input_preview.slice(0,100)}`; } catch { if ((d.tool_name||"").toLowerCase().includes("bash")) action = `Run command: ${d.input_preview.slice(0,100)}`; }

          let displayName = d.user_number || uid;
          try { const meta = JSON.parse(fs.readFileSync(path.join(USERS_DIR, uid, "meta.json"), "utf8")); if (meta.name) displayName = meta.name; } catch {}

          // Route the poll: in isolation mode, users approve their own actions
          // (damage is scoped to their own Unix user). Without isolation, admin
          // remains the gatekeeper since users share the admin's filesystem.
          const pollTargetJid = (ISOLATION && d.user_jid) ? d.user_jid : admin.jid;
          const isSelfApproval = pollTargetJid === d.user_jid;

          // Send context message — "From: <name>" doesn't make sense when the
          // user is approving their own action
          const contextText = isSelfApproval
            ? `\uD83D\uDD10 *Permission Request*\n${d.user_message ? `\uD83D\uDCAC Your message: "${d.user_message.slice(0,100)}"\n` : ""}\n\u26A1 ${action}`
            : `\uD83D\uDD10 *Permission Request*\n\n\uD83D\uDC64 From: ${displayName}\n${d.user_message ? `\uD83D\uDCAC "${d.user_message.slice(0,100)}"\n` : ""}\n\u26A1 ${action}`;
          await sock.sendMessage(pollTargetJid, { text: contextText });

          // Build a signature for "allow all similar" pattern
          let patternSig = "";
          try {
            const p = JSON.parse(d.input_preview);
            if (toolName.toLowerCase().includes("bash")) {
              // Use the command prefix (first word or up to first space)
              const cmd = p.command || d.input_preview;
              patternSig = cmd.split(" ")[0]; // e.g. "curl", "cat", "npm"
            } else {
              patternSig = toolName;
            }
          } catch { patternSig = toolName; }

          const pollMsg = await sock.sendMessage(pollTargetJid, {
            poll: {
              name: "Approve?",
              selectableCount: 1,
              values: ["\u2705 Allow", `\u2705 Always allow ${patternSig}`, "\u274C Deny"],
            },
          });

          if (pollMsg?.key?.id) {
            pendingPolls.set(pollMsg.key.id, { requestId: d.request_id, userId: uid, userJid: d.user_jid, toolName, patternSig });
            storeRaw(pollMsg);
          }

          // Send "waiting" only when the approver is someone OTHER than the
          // requester (admin-gatekeeper mode). When the user is self-approving,
          // the poll itself is the prompt — no separate waiting message needed.
          if (!isSelfApproval && d.user_jid && !d.user_jid.endsWith("@g.us")) {
            try { await sock.sendMessage(d.user_jid, { text: "\u23F3 Waiting for admin approval..." }); } catch {}
          }
        } catch (e) { log(`perm relay ${uid}/${f}: ${e}`); }
      }
    }
  } catch {}
}, 1000);

// ── Idle session cleanup ────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [uid, last] of userActivity) {
    if (now - last <= SESSION_IDLE_MS) continue;
    // Check if there are pending permission requests — don't kill if admin might still approve
    try {
      const permDir = path.join(USERS_DIR, uid, "permissions");
      const pending = fs.readdirSync(permDir).filter((f) => f.startsWith("request-"));
      if (pending.length > 0) {
        log(`session ${uid} idle but has pending permission — skipping kill`);
        continue;
      }
    } catch {}
    execFile("tmux", ["kill-session", "-t", getUserSessionName(uid)], () => {});
    userActivity.delete(uid);
    log(`killed idle session for ${uid}`);
  }
}, 60000);

// ── Startup ─────────────────────────────────────────────────────────

process.on("unhandledRejection", (err) => { const m = String(err).toLowerCase(); if ((m.includes("unable to authenticate data")||m.includes("bad mac"))&&(m.includes("baileys")||m.includes("noise-handler")||m.includes("signal"))) { log("crypto error — reconnecting"); setTimeout(connectWhatsApp, 2000); return; } log(`rejection: ${err}`); });
process.on("uncaughtException", (err) => log(`exception: ${err}`));
process.setMaxListeners(50);
let shuttingDown = false;
const LAST_CONN_FILE = path.join(STATE_DIR, ".last_connected");
const RECONNECT_COOLDOWN_MS = 30000; // 30s cooldown between restarts

function saveConnTimestamp() {
  try { fs.writeFileSync(LAST_CONN_FILE, String(Date.now())); } catch {}
}

function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  log("shutting down");
  saveConnTimestamp();
  cleanupSocket();
  setTimeout(() => process.exit(0), 2000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", () => { log("SIGINT ignored — use tmux kill-session or SIGTERM to stop"); });

// Startup with cooldown — prevent rapid reconnects that deregister the device
(async () => {
  let lastConn = 0;
  try { lastConn = Number(fs.readFileSync(LAST_CONN_FILE, "utf8")); } catch {}
  const elapsed = Date.now() - lastConn;
  if (lastConn > 0 && elapsed < RECONNECT_COOLDOWN_MS) {
    const wait = RECONNECT_COOLDOWN_MS - elapsed;
    log(`waiting ${Math.ceil(wait / 1000)}s before reconnecting (cooldown)...`);
    await new Promise((r) => setTimeout(r, wait));
  }
  log("starting gateway...");
  connectWhatsApp();
})();
