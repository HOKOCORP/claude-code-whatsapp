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

// ── Config ──────────────────────────────────────────────────────────

const STATE_DIR = process.env.WHATSAPP_STATE_DIR || path.join(os.homedir(), ".claude", "channels", "whatsapp");
const ACCESS_FILE = path.join(STATE_DIR, "access.json");
const AUTH_DIR = path.join(STATE_DIR, "auth");
const OTP_LOG_FILE = path.join(STATE_DIR, "otp.log");
const OTP_FILE = path.join(STATE_DIR, "otp.json");
const ADMIN_FILE = path.join(STATE_DIR, "admin.json");
const OUTBOX_DIR = path.join(STATE_DIR, "outbox");
const PHONE = path.basename(STATE_DIR).replace("whatsapp-", "");
const SESSION_IDLE_MS = 30 * 60 * 1000;
const USAGE_DIR = path.join(os.homedir(), ".ccm", "usage");
const USAGE_LIMITS_FILE = path.join(USAGE_DIR, "limits.json");

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
  // In isolation mode, the project user owns the IPC directory; admin (gateway) accesses via root
  if (ISOLATION) {
    const username = isolationGetUsername(userId);
    // Owner: project user (can read/write their own IPC)
    // Group: ccm-gw (admin/gateway can read/write, other project users cannot)
    try { execFileSync("chown", ["-R", `${username}:ccm-gw`, dir]); } catch {}
    try { execFileSync("chmod", ["770", dir]); } catch {}
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

  // Copy base settings
  const adminSettings = path.join(os.homedir(), ".claude", "settings.json");
  if (fs.existsSync(adminSettings)) {
    fs.copyFileSync(adminSettings, path.join(claudeDir, "settings.json"));
  }

  // User-global security CLAUDE.md
  fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), [
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
  ].join("\n"));

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
  const userWorkDir = projectUser
    ? path.join(projectUser.homeDir, "workspace")
    : path.join(userDir, "workspace");
  const userHomeDir = projectUser ? projectUser.homeDir : os.homedir();
  fs.mkdirSync(userWorkDir, { recursive: true });

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

  // Pre-populate .claude.json project entry so Claude Code auto-trusts the MCP server
  const claudeJsonPath = path.join(userHomeDir, ".claude.json");
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

  const launcherBody = [
    "#!/bin/bash",
    envPreamble,
    portExport,
    `cd "${launchWorkDir}"`,
    `exec cc-watchdog --dangerously-load-development-channels "server:whatsapp" --permission-mode bypassPermissions --allowedTools ${allowedTools}`,
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

      // Discover groups before access check — save meta so they appear in the menu
      if (jid.endsWith("@g.us")) {
        const gUserId = sanitizeUserId(jid);
        const gDir = getUserDir(gUserId);
        const gMeta = path.join(gDir, "meta.json");
        let gm = {}; try { gm = JSON.parse(fs.readFileSync(gMeta, "utf8")); } catch {}
        gm.jid = jid; gm.isGroup = true; gm.lastSeen = new Date().toISOString();
        if (!gm.name) { try { const gInfo = await sock.groupMetadata(jid); if (gInfo?.subject) gm.name = gInfo.subject; } catch {} }
        fs.writeFileSync(gMeta, JSON.stringify(gm, null, 2) + "\n");
      }

      if (!isAllowed(jid, participant || undefined)) continue;

      // Group messages: only respond when triggered
      if (jid.endsWith("@g.us")) {
        const access = loadAccess();
        const groupText = extractText(msg.message || {});
        const cleanText = groupText.replace(/[\u2066\u2067\u2068\u2069\u200E\u200F\u200B\u200C\u200D\uFEFF]/g, "");
        const trigger = (access.groupTrigger || "@ai").toLowerCase();
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.some(
          (m) => m.includes(PHONE) || (sock?.user?.id && m.includes(sock.user.id.split(":")[0]))
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
        if (!mentioned && !prefixed && !containsTrigger && !isReplyToBot) {
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
        // Try to get group name via sock
        if (!userMeta.name) {
          try { const gMeta = await sock.groupMetadata(jid); if (gMeta?.subject) userMeta.name = gMeta.subject; } catch {}
        }
      } else {
        if (pushName) userMeta.pushName = pushName;
        if (!userMeta.name && pushName) userMeta.name = pushName;
      }
      fs.writeFileSync(metaFile, JSON.stringify(userMeta, null, 2) + "\n");

      let text = extractText(msg.message); const media = extractMediaInfo(msg.message);
      // Strip invisible Unicode and trigger from group messages
      if (isGroup && text) {
        text = text.replace(/[\u2066\u2067\u2068\u2069\u200E\u200F\u200B\u200C\u200D\uFEFF]/g, "");
        const trigger = (loadAccess().groupTrigger || "@ai");
        text = text.replace(new RegExp(trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim();
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

        try { await sock.sendMessage(jid, { text: lines.join("\n") }); } catch {}
        continue;
      }

      const senderName = pushName || formatJid(senderJid);
      // In groups, prefix the message with sender name so Claude knows who's talking
      if (isGroup && text) text = `[${senderName}] ${text}`;
      const meta = { chat_id: jid, message_id: msgId, user: formatJid(senderJid), ts: new Date((Number(msg.messageTimestamp) || Date.now() / 1000) * 1000).toISOString() };
      if (isGroup) { meta.group = "true"; meta.sender_name = senderName; }
      if (media) { meta.attachment_count = "1"; meta.attachments = `${media.filename || media.type + "." + mimeToExt(media.mimetype)} (${media.mimetype}, ${(media.size / 1024).toFixed(0)}KB)`; }

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

      spawnUserSession(userId, sessionJid);
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
          // Track outbound activity so active sessions don't get killed as idle
          userActivity.set(uid, Date.now());
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
