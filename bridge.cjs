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

const reconcilerTick = inboxReconciler.createReconciler({
  userDir: USER_DIR,
  loadJsonl: loadJsonlTail,
  sendNotification: ({ content, meta }) => {
    lastMessage = { text: content || "", number: meta?.user || "" };
    if (meta?.chat_id) writeOutbox({ action: "typing_start", chat_id: meta.chat_id });
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

function writeOutbox(data) {
  const ts = Date.now();
  const tmp = path.join(OUTBOX_DIR, `.${ts}.tmp`);
  const final = path.join(OUTBOX_DIR, `${ts}.json`);
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

const recentMessages = [];
const MAX_RECENT = 100;

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Reply on WhatsApp. Pass chat_id from the inbound message.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "WhatsApp JID" },
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
      description: "Fetch recent messages from this WhatsApp chat (session cache only).",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments || {};
  try {
    switch (req.params.name) {
      case "reply": {
        // Stop typing
        writeOutbox({ action: "typing_stop", chat_id: args.chat_id });
        // Send reply via gateway
        writeOutbox({
          action: "reply",
          chat_id: args.chat_id,
          text: args.text,
          files: args.files || [],
          reply_to: args.reply_to,
        });
        // Track for fetch_messages
        recentMessages.push({
          id: `out-${Date.now()}`, from: "bot", text: args.text,
          ts: Date.now(), hasMedia: (args.files || []).length > 0,
        });
        if (recentMessages.length > MAX_RECENT) recentMessages.shift();
        return { content: [{ type: "text", text: "sent" }] };
      }
      case "react": {
        writeOutbox({ action: "react", chat_id: args.chat_id, message_id: args.message_id, emoji: args.emoji });
        return { content: [{ type: "text", text: "reacted" }] };
      }
      case "download_attachment": {
        // Request download from gateway
        writeOutbox({ action: "download", chat_id: args.chat_id, message_id: args.message_id });
        // Poll for the downloaded file
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
        const limit = Math.min(args.limit || 20, MAX_RECENT);
        const slice = recentMessages.slice(-limit);
        if (slice.length === 0) return { content: [{ type: "text", text: "(no messages in session cache)" }] };
        const out = slice.map((m) => `[${new Date(m.ts).toISOString()}] ${m.from}: ${m.text}`).join("\n");
        return { content: [{ type: "text", text: out }] };
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
