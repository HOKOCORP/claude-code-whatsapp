#!/usr/bin/env node
/**
 * WhatsApp Bridge for Claude Code — per-user MCP server
 *
 * Lightweight bridge between a single Claude Code session and the gateway.
 * Communicates via filesystem IPC (inbox/outbox/permissions directories).
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { z } = require("zod");
const fs = require("fs");
const path = require("path");
const os = require("node:os");
const jsonlScan = require("./lib/jsonl-scan.cjs");
const inboxReconciler = require("./lib/inbox-reconciler.cjs");

const USER_DIR = process.env.BRIDGE_USER_DIR;
const USER_JID = process.env.BRIDGE_USER_JID || "";
const PHONE = process.env.BRIDGE_PHONE || "";

if (!USER_DIR) { process.stderr.write("bridge: BRIDGE_USER_DIR not set\n"); process.exit(1); }

const INBOX_DIR = path.join(USER_DIR, "inbox");
const OUTBOX_DIR = path.join(USER_DIR, "outbox");
const PERM_DIR = path.join(USER_DIR, "permissions");
const DOWNLOADS_DIR = path.join(USER_DIR, "downloads");

for (const d of [INBOX_DIR, OUTBOX_DIR, PERM_DIR, DOWNLOADS_DIR]) fs.mkdirSync(d, { recursive: true });

const log = (msg) => process.stderr.write(`wa-bridge[${path.basename(USER_DIR)}]: ${msg}\n`);

// One-shot recovery on bridge startup: drain inbox/failed/ → inbox/ for
// recent items. The reconciler quarantines a message when the gateway
// spawns its tmux session but the MCP notification drops it (e.g. the
// gateway hits a WhatsApp 440 conflict mid-spawn, restarts before
// claude is ready). Each fresh bridge picks up its own backlog so
// admin messages aren't silently lost. Items older than
// FAILED_REPLAY_MAX_AGE_MS stay quarantined — clearly stale, no point
// firing them at claude.
const FAILED_REPLAY_MAX_AGE_MS = parseInt(process.env.FAILED_REPLAY_MAX_AGE_MS || "", 10) || (24 * 60 * 60 * 1000);
function drainFailedInbox() {
  const failedDir = path.join(INBOX_DIR, "failed");
  let files;
  try { files = fs.readdirSync(failedDir).filter((f) => f.endsWith(".json")); } catch { return; }
  if (files.length === 0) return;
  const cutoff = Date.now() - FAILED_REPLAY_MAX_AGE_MS;
  let revived = 0;
  let stale = 0;
  for (const f of files) {
    const src = path.join(failedDir, f);
    let mtime;
    try { mtime = fs.statSync(src).mtimeMs; } catch { continue; }
    if (mtime < cutoff) { stale++; continue; }
    try {
      fs.renameSync(src, path.join(INBOX_DIR, f));
      revived++;
    } catch (e) {
      log(`drain: rename failed for ${f}: ${e.message}`);
    }
  }
  if (revived > 0) log(`drain: revived ${revived} message(s) from failed/ (${stale} too old, kept quarantined)`);
}
drainFailedInbox();

let jsonlPath = null;
let jsonlPathResolvedAt = 0;
const jsonlCache = {};
const JSONL_RESOLVE_INTERVAL_MS = 30000;
const JSONL_TAIL_BYTES = 262144;

function resolveJsonlPath() {
  const now = Date.now();
  if (jsonlPath && fs.existsSync(jsonlPath) && now - jsonlPathResolvedAt < JSONL_RESOLVE_INTERVAL_MS) {
    return jsonlPath;
  }
  jsonlPath = jsonlScan.findSessionJsonl(process.cwd(), os.homedir());
  jsonlPathResolvedAt = now;
  if (!jsonlPath) log(`warn: no session.jsonl found for cwd=${process.cwd()}`);
  return jsonlPath;
}

function loadJsonlTail() {
  const p = resolveJsonlPath();
  if (!p) return "";
  return jsonlScan.readJsonlTail(p, JSONL_TAIL_BYTES, jsonlCache);
}

// Track last message for permission context
let lastMessage = { text: "", number: "" };

// ── MCP reply guard (cross-chat leak prevention) ──────────────────
// When a primary group is bridged to one or more secondary groups
// via /connect-group, multiple chats route into THIS bridge. Claude
// must reply each message in its originating chat — but if the model
// fumbles, the bridge corrects the chat_id. State:
//
//   - knownChatIds: set of chat_ids this bridge has ever seen inbound.
//     Reply tool rejects (or auto-corrects) any chat_id not in this set.
//   - pendingByChat: timestamped record of inbound messages awaiting
//     a reply, keyed by chat_id. Bridge auto-corrects to the freshest
//     entry when Claude omits or misspecifies chat_id.
//   - recentByChat: per-chat history for fetch_messages scoping
//     (chat A's fetch_messages must not return chat B's history).
const knownChatIds = new Set();
const pendingByChat = new Map();   // chat_id → ts of most-recent inbound
const PENDING_REPLY_TTL_MS = 60_000;
const recentByChat = new Map();    // chat_id → [{id, from, text, ts, hasMedia}]
const MAX_RECENT_PER_CHAT = 50;

function recordInbound(chatId, text, msgId) {
  knownChatIds.add(chatId);
  pendingByChat.set(chatId, Date.now());
  if (!recentByChat.has(chatId)) recentByChat.set(chatId, []);
  const arr = recentByChat.get(chatId);
  arr.push({ id: msgId, from: "user", text: text || "", ts: Date.now(), hasMedia: false });
  if (arr.length > MAX_RECENT_PER_CHAT) arr.shift();
}

function recordOutbound(chatId, text, hasMedia) {
  if (!recentByChat.has(chatId)) recentByChat.set(chatId, []);
  const arr = recentByChat.get(chatId);
  arr.push({ id: `out-${Date.now()}`, from: "bot", text: text || "", ts: Date.now(), hasMedia: !!hasMedia });
  if (arr.length > MAX_RECENT_PER_CHAT) arr.shift();
  // Don't pop pendingByChat on first outbound — Claude often replies
  // in multiple chunks. Entry naturally ages out via PENDING_REPLY_TTL_MS.
}

// Most-recent inbound chat_id within TTL. Used as the default when
// Claude omits chat_id or gives a bogus one. Returns null if no
// recent inbound — the tool call should error out cleanly in that
// case rather than guess.
function freshestPendingChatId() {
  const cutoff = Date.now() - PENDING_REPLY_TTL_MS;
  let bestChat = null;
  let bestTs = 0;
  for (const [chat, ts] of pendingByChat) {
    if (ts < cutoff) continue;
    if (ts > bestTs) { bestTs = ts; bestChat = chat; }
  }
  return bestChat;
}

// Verify Claude's chat_id against the known set; correct silently
// (with a log line) if outside. Returns the corrected chat_id or
// null if no fallback is available.
function guardChatId(toolName, requested) {
  if (requested && knownChatIds.has(requested)) return requested;
  const fallback = freshestPendingChatId();
  if (!fallback) {
    log(`mcp-guard: ${toolName} called with unknown chat_id=${JSON.stringify(requested)} and no recent inbound to fall back to — rejecting`);
    return null;
  }
  if (requested && requested !== fallback) {
    log(`mcp-guard: ${toolName} chat_id mismatch — claude said ${requested}, redirecting to ${fallback} (most recent inbound)`);
  } else if (!requested) {
    log(`mcp-guard: ${toolName} missing chat_id — substituting ${fallback}`);
  }
  return fallback;
}

// ── MCP Server ──────────────────────────────────────────────────────

const mcp = new Server(
  { name: "whatsapp", version: "0.1.0" },
  {
    capabilities: { tools: {}, experimental: { "claude/channel": {}, "claude/channel/permission": {} } },
    instructions: [
      "The sender reads WhatsApp, not this session. Anything you want them to see must go through the reply tool.",
      "",
      'Messages from WhatsApp arrive as <channel source="whatsapp" chat_id="..." message_id="..." user="..." ts="...">.',
      "chat_id is the WhatsApp JID. If the tag has attachment_count, call download_attachment to fetch them.",
      "",
      "reply accepts file paths (files: []) for attachments. Use react to add emoji reactions.",
      "WhatsApp has no search API. fetch_messages returns only messages received during this session.",
    ].join("\n"),
  }
);

// ── Inbox watcher — deliver messages to Claude Code ─────────────────

let mcpReady = false;

// sendNotification's writeOutbox reference is safe: function declarations are hoisted.
const reconcilerTick = inboxReconciler.createReconciler({
  userDir: USER_DIR,
  loadJsonl: loadJsonlTail,
  sendNotification: ({ content, meta }) => {
    lastMessage = { text: content || "", number: meta?.user || "" };
    if (meta?.chat_id) {
      recordInbound(meta.chat_id, content, meta.message_id);
      writeOutbox({ action: "typing_start", chat_id: meta.chat_id });
    }
    mcp.notification({ method: "notifications/claude/channel", params: { content, meta } })
      .catch((err) => log(`deliver failed: ${err}`));
  },
  now: () => Date.now(),
  stalenessMs: 20000,
  maxAgeMs: 5 * 60 * 1000,
  maxRetries: 3,
  log,
});

function processInbox() {
  if (!mcpReady) return;
  reconcilerTick();
}

const inboxPoll = setInterval(processInbox, 1000);

// ── Outbox helper ───────────────────────────────────────────────────

let _outboxSeq = 0;
function writeOutbox(data) {
  // Two writeOutbox calls within the same millisecond used to collide:
  // second rename atomically overwrote the first, silently dropping a
  // message. Typical pattern — a reply action fires writeOutbox twice
  // in quick succession (typing_stop + reply). Append a monotonically
  // increasing sequence so filenames are always unique.
  const ts = Date.now();
  const seq = (++_outboxSeq).toString().padStart(4, "0");
  const tmp = path.join(OUTBOX_DIR, `.${ts}-${seq}.tmp`);
  const final = path.join(OUTBOX_DIR, `${ts}-${seq}.json`);
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, final);
}

// ── Permission relay: Claude Code -> gateway (via files) -> admin ───

// Track pending denies to suppress retry spam
let lastDenyAt = 0;
const DENY_COOLDOWN_MS = 30000;

mcp.setNotificationHandler(
  z.object({
    method: z.literal("notifications/claude/channel/permission_request"),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    // Auto-suppress after recent deny
    if (Date.now() - lastDenyAt < DENY_COOLDOWN_MS) return;

    const reqFile = path.join(PERM_DIR, `request-${params.request_id}.json`);
    fs.writeFileSync(reqFile, JSON.stringify({
      request_id: params.request_id,
      tool_name: params.tool_name,
      description: params.description,
      input_preview: params.input_preview,
      user_number: lastMessage.number,
      user_message: lastMessage.text,
      user_jid: USER_JID,
    }));

    // Poll for response from gateway — no timeout, admin can approve anytime
    const respFile = path.join(PERM_DIR, `response-${params.request_id}.json`);

    const poll = () => {
      try {
        if (fs.existsSync(respFile)) {
          const resp = JSON.parse(fs.readFileSync(respFile, "utf8"));
          fs.unlinkSync(respFile);
          if (resp.behavior === "deny") lastDenyAt = Date.now();
          mcp.notification({
            method: "notifications/claude/channel/permission",
            params: { request_id: resp.request_id, behavior: resp.behavior },
          }).catch(() => {});
          return;
        }
      } catch {}
      setTimeout(poll, 500);
    };
    poll();
  },
);

// ── Tools ───────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Reply on WhatsApp. Pass chat_id from the inbound message you're answering — the bridge enforces that replies go to the chat that prompted them; cross-chat reply is rejected.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "WhatsApp JID — must match an inbound chat_id you've received from in this session." },
          text: { type: "string" },
          reply_to: { type: "string", description: "Message ID to quote-reply to." },
          files: { type: "array", items: { type: "string" }, description: "Absolute file paths to attach." },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "react",
      description: "Add an emoji reaction to a WhatsApp message.",
      inputSchema: {
        type: "object",
        properties: { chat_id: { type: "string" }, message_id: { type: "string" }, emoji: { type: "string" } },
        required: ["chat_id", "message_id", "emoji"],
      },
    },
    {
      name: "download_attachment",
      description: "Download media from a WhatsApp message. Returns file path ready to Read.",
      inputSchema: {
        type: "object",
        properties: { chat_id: { type: "string" }, message_id: { type: "string" } },
        required: ["chat_id", "message_id"],
      },
    },
    {
      name: "fetch_messages",
      description: "Fetch recent messages from a specific WhatsApp chat (session cache only). Returns messages SCOPED to chat_id — never leaks history across chats. If chat_id is omitted, defaults to the chat of the most recent inbound message.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "WhatsApp JID to fetch history for. Defaults to the most recent inbound chat." },
          limit: { type: "number" },
        },
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments || {};
  try {
    switch (req.params.name) {
      case "reply": {
        const chatId = guardChatId("reply", args.chat_id);
        if (!chatId) {
          return { content: [{ type: "text", text: "reply rejected: no recent inbound chat to reply to, and provided chat_id is unknown to this session" }], isError: true };
        }
        writeOutbox({ action: "typing_stop", chat_id: chatId });
        writeOutbox({
          action: "reply",
          chat_id: chatId,
          text: args.text,
          files: args.files || [],
          reply_to: args.reply_to,
        });
        recordOutbound(chatId, args.text, (args.files || []).length > 0);
        return { content: [{ type: "text", text: `sent to ${chatId}` }] };
      }
      case "react": {
        const chatId = guardChatId("react", args.chat_id);
        if (!chatId) {
          return { content: [{ type: "text", text: "react rejected: unknown chat_id" }], isError: true };
        }
        writeOutbox({ action: "react", chat_id: chatId, message_id: args.message_id, emoji: args.emoji });
        return { content: [{ type: "text", text: "reacted" }] };
      }
      case "download_attachment": {
        const chatId = guardChatId("download_attachment", args.chat_id);
        if (!chatId) {
          return { content: [{ type: "text", text: "download rejected: unknown chat_id" }], isError: true };
        }
        writeOutbox({ action: "download", chat_id: chatId, message_id: args.message_id });
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          try {
            const files = fs.readdirSync(DOWNLOADS_DIR).filter((f) => f.startsWith(args.message_id));
            if (files.length > 0) {
              const fp = path.join(DOWNLOADS_DIR, files[0]);
              return { content: [{ type: "text", text: `downloaded: ${fp}` }] };
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 500));
        }
        return { content: [{ type: "text", text: "download timed out — media may have expired" }], isError: true };
      }
      case "fetch_messages": {
        // Scope to a single chat — secondary's history MUST NOT leak
        // into primary's responses (or vice versa). Defaults to the
        // most-recent inbound chat when chat_id is omitted.
        const requested = args.chat_id || freshestPendingChatId();
        if (!requested) {
          return { content: [{ type: "text", text: "(no chats with recent activity in this session)" }] };
        }
        if (!knownChatIds.has(requested)) {
          log(`mcp-guard: fetch_messages rejected — chat_id=${requested} not seen in this session`);
          return { content: [{ type: "text", text: `(no history for chat_id ${requested} — only chats that have messaged the bot in this session are available)` }] };
        }
        const limit = Math.min(args.limit || 20, MAX_RECENT_PER_CHAT);
        const arr = recentByChat.get(requested) || [];
        const slice = arr.slice(-limit);
        if (slice.length === 0) {
          return { content: [{ type: "text", text: `(no messages cached for ${requested})` }] };
        }
        const out = slice.map((m) => `[${new Date(m.ts).toISOString()}] ${m.from}: ${m.text}`).join("\n");
        log(`mcp-guard: fetch_messages scoped to chat_id=${requested}, returned ${slice.length} msgs`);
        return { content: [{ type: "text", text: `messages from ${requested}:\n${out}` }] };
      }
      default:
        return { content: [{ type: "text", text: `unknown tool: ${req.params.name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: "text", text: `${req.params.name} failed: ${err.message || err}` }], isError: true };
  }
});

// ── Startup ─────────────────────────────────────────────────────────

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down");
  clearInterval(inboxPoll);
  setTimeout(() => process.exit(0), 1000);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function main() {
  await mcp.connect(new StdioServerTransport());
  log("bridge connected, waiting for channel listener...");
  // Give Claude Code a moment to set up its channel listener after MCP connects
  setTimeout(() => {
    mcpReady = true;
    log("bridge ready — processing inbox");
    processInbox();
  }, 3000);
}

main().catch((err) => { log(`fatal: ${err}`); process.exit(1); });
