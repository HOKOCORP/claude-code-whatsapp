# WhatsApp Channel for Claude Code

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Claude Code 2.1.80+](https://img.shields.io/badge/Claude_Code-2.1.80%2B-6B4FBB)](https://docs.anthropic.com/en/docs/claude-code)
[![Security Audited](https://img.shields.io/badge/Security-Audited-brightgreen)]()

> Talk to Claude Code from WhatsApp. Send a message from your phone, Claude does the work on your server, and replies back to your chat.

Built on [Baileys](https://github.com/WhiskeySockets/Baileys) v7 (WhatsApp Web Multi-Device protocol) and [Claude Code Channels](https://docs.anthropic.com/en/docs/claude-code/channels). Fork of [diogo85/claude-code-whatsapp](https://github.com/diogo85/claude-code-whatsapp) with multi-number support and security hardening.

---

## Why use this?

- **Code from anywhere** — fix a bug from your phone while walking the dog
- **Approve tool calls remotely** — Claude asks permission via WhatsApp, you reply "yes" or "no"
- **Multiple numbers** — connect personal and work WhatsApp to the same server
- **Runs 24/7** — production-grade reconnection, never crashes on transient errors
- **Private** — runs on your machine, no data goes through third-party servers

---

## Quick Start

Get up and running in under 5 minutes.

### Step 1 — Clone and install

```bash
git clone https://github.com/HOKOCORP/claude-code-whatsapp.git
cd claude-code-whatsapp
npm install --legacy-peer-deps
```

### Step 2 — Pair your phone

```bash
node pair.cjs <your_phone_number>
```

Use your full number with country code, digits only:
- US: `14155551234`
- UK: `447700900000`
- HK: `85212345678`

A pairing code will appear. On your phone, go to **WhatsApp > Linked Devices > Link a Device > Link with phone number** and enter it.

Wait for "Connected!" before closing.

> **Tip:** If you get error 515, wait 5-10 minutes and try once. WhatsApp rate-limits rapid attempts. IP-level rate limits may require trying from a different IP.

### Step 3 — Configure MCP

Add to your `.mcp.json` (or `~/.mcp.json` for global):

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/path/to/claude-code-whatsapp/server.cjs"],
      "env": {
        "WHATSAPP_STATE_DIR": "~/.claude/channels/whatsapp-14155551234"
      }
    }
  }
}
```

### Step 4 — Launch

```bash
claude --dangerously-load-development-channels "server:whatsapp"
```

That's it. Send a message from WhatsApp and Claude will respond.

---

## Multiple WhatsApp Numbers

Each number gets its own state directory automatically:

```bash
node pair.cjs 14155551234    # → ~/.claude/channels/whatsapp-14155551234/
node pair.cjs 447700900000   # → ~/.claude/channels/whatsapp-447700900000/
```

Add both to `.mcp.json` with unique server names:

```json
{
  "mcpServers": {
    "whatsapp-us": {
      "command": "node",
      "args": ["/path/to/claude-code-whatsapp/server.cjs"],
      "env": { "WHATSAPP_STATE_DIR": "~/.claude/channels/whatsapp-14155551234" }
    },
    "whatsapp-uk": {
      "command": "node",
      "args": ["/path/to/claude-code-whatsapp/server.cjs"],
      "env": { "WHATSAPP_STATE_DIR": "~/.claude/channels/whatsapp-447700900000" }
    }
  }
}
```

```bash
claude --dangerously-load-development-channels "server:whatsapp-us,server:whatsapp-uk"
```

---

## How It Works

```
Your phone (WhatsApp)
    ↕  Baileys v7 — WhatsApp Web Multi-Device protocol
server.cjs — MCP server with channel + permission relay
    ↕  notifications/claude/channel (stdio)
Claude Code — receives messages, does the work, replies back
```

The plugin runs as an MCP server alongside Claude Code. Baileys maintains a persistent WebSocket connection to WhatsApp's servers (the same protocol WhatsApp Web uses). When you send a message, it arrives via that WebSocket, gets pushed to Claude Code as a channel notification, and Claude's reply is sent back through the same connection.

No HTTP servers. No webhooks. No polling. No third-party relay.

---

## Features

| Feature | Details |
|---------|---------|
| **Remote coding** | Send tasks from WhatsApp, get results back |
| **Permission relay** | Approve or deny Claude's tool calls from your phone |
| **File sharing** | Send and receive images, documents, audio, video |
| **Multi-number** | Connect multiple WhatsApp accounts to one server |
| **Auto-reconnect** | Exponential backoff with jitter, max 30s between retries |
| **Watchdog** | Detects stale connections after 30min of silence |
| **Credential backup** | Auto-backup before each save, auto-restore if corrupted |
| **Graceful shutdown** | Clean exit on SIGTERM/SIGINT |

### Tools available to Claude

| Tool | What it does |
|------|-------------|
| `reply` | Send text and file attachments back to the chat |
| `react` | Add an emoji reaction to a message |
| `download_attachment` | Save media from a received message to disk |
| `fetch_messages` | List recent messages from the session cache |

### Permission relay in action

When Claude needs to run something that requires approval:

```
Permission request [tbxkq]
Bash: rm -rf /tmp/foo
Reply "yes tbxkq" or "no tbxkq"
```

Reply from your phone. Claude proceeds or stops. You stay in control even when you're away from your desk.

---

## Access Control

Restrict who can message your Claude instance. Create `access.json` in your state directory:

```bash
# Example: ~/.claude/channels/whatsapp-14155551234/access.json
```

```json
{
  "allowFrom": ["14155551234"],
  "allowGroups": false,
  "allowedGroups": [],
  "requireAllowFromInGroups": false
}
```

| Setting | Effect |
|---------|--------|
| `allowFrom: []` | Accept messages from anyone |
| `allowFrom: ["14155551234"]` | Only accept from this number |
| `allowGroups: true` | Enable group chat support |
| `allowedGroups: ["id@g.us"]` | Limit to specific groups |

---

## Security

This plugin has been **independently security audited**. Here's what was checked and confirmed clean:

| Check | Result |
|-------|--------|
| Data exfiltration | **None.** Zero outbound HTTP calls. Only WhatsApp WebSocket + local MCP stdio. |
| Backdoors | **None.** No `eval()`, no `child_process`, no remote code execution. |
| Credential theft | **None.** Env vars only read for state directory path. No access to `~/.ssh`, `.env`, or system files. |
| Obfuscated code | **None.** No base64 strings, no encoded URLs, no hidden logic. |
| Supply chain | **Clean.** All dependencies are well-known packages from npmjs.org. No typosquatting. |
| Install hooks | **None.** No malicious postinstall scripts. |

WhatsApp auth credentials (`creds.json`) are stored locally with `0600` permissions and never transmitted anywhere except back to Baileys for reconnection.

---

## Anthropic Terms of Service

This plugin is **compatible with Anthropic's Terms of Service** as of April 2026. Here's why:

**It uses the official API.** Claude Code has a documented [Channels system](https://docs.anthropic.com/en/docs/claude-code/channels) for connecting external messaging platforms. Anthropic ships official channel plugins for Telegram, Discord, and iMessage. This plugin uses the exact same MCP channel protocol (`notifications/claude/channel` capability) — it's a third-party channel, not a hack.

**It runs locally.** Your Claude Code session, your server, your WhatsApp account. No data is proxied through external services.

**You stay in control.** Messages come from you, not automated bots. Permission relay keeps you in the loop for sensitive operations. This maintains the human-in-the-loop design Claude Code is built around.

**It respects rate limits.** No automated message flooding, no abuse patterns.

> The `--dangerously-load-development-channels` flag indicates this is a research preview feature. If Anthropic changes their ToS or channel policy in the future, review compliance before continuing use.

---

## Reliability

Built on patterns from [OpenClaw's WhatsApp extension](https://github.com/openclaw/openclaw/tree/main/extensions/whatsapp), which runs 24/7 in production.

| Pattern | Why it matters |
|---------|---------------|
| **515 = normal** | WhatsApp sends 515 regularly as a restart signal. We reconnect in 2s, not crash. |
| **Never process.exit in reconnect** | Only fatal errors (440 conflict, 401 logout) stop the process. Everything else reconnects. |
| **Fresh socket every time** | Dead sockets are never reused. Each reconnect creates a clean connection. |
| **Backoff with jitter** | Prevents thundering herd problems. Resets after 60s of healthy connection. |
| **30min watchdog** | Detects zombie connections where no messages arrive despite being "connected". |
| **Credential backup** | Auto-backup before each save. If `creds.json` gets corrupted, the backup is restored automatically. |
| **Listener cleanup** | All event listeners are removed before creating a new socket. No memory leaks. |

---

## Troubleshooting

| Problem | Why | Fix |
|---------|-----|-----|
| "WhatsApp not connected" | Auth expired or never paired | Run `node pair.cjs <phone>` again |
| Error 515 on pairing | Too many attempts | Wait 10+ minutes, try once |
| Error 515 during use | Normal restart signal | Handled automatically — no action needed |
| Error 440 | Two devices competing for the session | Unlink in WhatsApp settings, re-pair |
| Error 401 | Session was logged out | Re-pair with `pair.cjs` |
| Messages stop silently | Zombie connection | Watchdog detects within 30min. Or restart manually. |
| creds.json corrupted | Crash during credential save | Auto-restored from backup |
| Rate limit across numbers | IP-level WhatsApp throttle | Wait, or try from a different IP (e.g. VPN) |

---

## Requirements

| Dependency | Version | Notes |
|-----------|---------|-------|
| Node.js | 20+ | **Bun is not supported** — Baileys needs WebSocket events Bun doesn't implement |
| Claude Code | 2.1.80+ | Channels support required |
| WhatsApp | Any | Personal or Business account |

---

## Changelog

### v0.0.4 (2026-04-09)
- `pair.cjs` now takes phone number as a CLI argument — no more hardcoded numbers
- Auto-creates per-number state directories (`whatsapp-<phone>/`)
- Supports `WHATSAPP_STATE_DIR` env var with sensible fallback
- Multiple WhatsApp numbers on the same server
- Independent security audit completed
- Added safety, security, and ToS compliance documentation

### v0.0.3 (2026-03-24)
- Rewrote connection lifecycle based on OpenClaw patterns
- 515 treated as normal reconnect (was fatal crash)
- Exponential backoff with jitter, reset after 60s healthy
- 30min watchdog for stale connections
- Credential backup/restore
- `getMessage` handler for E2EE retry (Baileys v7 requirement)
- Crypto error handler (reconnect, don't crash)
- Permission relay capability
- Full listener cleanup before reconnecting

### v0.0.2 (2026-03-23)
- Browser string fix for Baileys v7
- Basic exponential backoff
- Permission relay (outbound + inbound)

### v0.0.1 (2026-03-21)
- Initial release based on OpenClaw architecture
- Baileys v7.0.0-rc.9 with MCP channel capability
- Tools: reply, react, download_attachment, fetch_messages
- Access control via allowlist

---

## License

MIT — use it however you want.
