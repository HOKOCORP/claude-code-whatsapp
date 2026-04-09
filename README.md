# WhatsApp Channel for Claude Code

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Claude Code 2.1.80+](https://img.shields.io/badge/Claude_Code-2.1.80%2B-6B4FBB)](https://docs.anthropic.com/en/docs/claude-code)
[![Security Audited](https://img.shields.io/badge/Security-Audited-brightgreen)]()

> Talk to Claude Code from WhatsApp. Each user gets their own isolated Claude Code session, with admin approval for sensitive operations via WhatsApp polls.

Built on [Baileys](https://github.com/WhiskeySockets/Baileys) v7 (WhatsApp Web Multi-Device protocol) and [Claude Code Channels](https://docs.anthropic.com/en/docs/claude-code/channels). Fork of [diogo85/claude-code-whatsapp](https://github.com/diogo85/claude-code-whatsapp) with multi-user sessions, OTP verification, admin controls, and security hardening.

---

## Why use this?

- **Code from anywhere** — fix a bug from your phone while walking the dog
- **Per-user sessions** — each WhatsApp user gets their own isolated Claude Code instance
- **OTP verification** — admin generates a code, shares a link, users tap to whitelist themselves
- **Admin controls** — approve or deny tool calls via WhatsApp polls (tap, don't type)
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

### Step 3 — Launch the gateway

```bash
WHATSAPP_STATE_DIR=~/.claude/channels/whatsapp-14155551234 node gateway.cjs
```

That's it. The gateway handles everything:
- Receives WhatsApp messages
- Spawns a per-user Claude Code session for each sender
- Routes messages to the right session via the bridge MCP server
- Sends replies back to WhatsApp

### Architecture

```
Your phone (WhatsApp)
    ↕  Baileys v7 — WhatsApp Web Multi-Device protocol
gateway.cjs — standalone daemon, routes messages per-user
    ↕  filesystem IPC (inbox/outbox directories)
bridge.cjs — per-user MCP server (one per user session)
    ↕  notifications/claude/channel (stdio)
Claude Code — one instance per user, isolated sessions
```

### Legacy single-session mode

If you prefer the old single-session setup (all users share one Claude Code):

```bash
claude --dangerously-load-development-channels "server:whatsapp"
```

With `server.cjs` configured in `.mcp.json`. See the v0.0.4 README for details.

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

The gateway runs as a standalone daemon with a single WhatsApp connection. When a message arrives from a whitelisted user, the gateway:

1. Creates a per-user directory with inbox/outbox/permissions folders
2. Writes the message to the user's inbox
3. Spawns a dedicated Claude Code tmux session if not already running
4. The bridge MCP server (one per user) reads from inbox, delivers to Claude Code
5. Claude Code's reply goes through the bridge to the user's outbox
6. The gateway picks up outbox messages and sends them via WhatsApp

No HTTP servers. No webhooks. No third-party relay. All IPC is local filesystem.

---

## Features

| Feature | Details |
|---------|---------|
| **Per-user sessions** | Each WhatsApp user gets their own isolated Claude Code instance |
| **OTP whitelist** | Admin generates code, shares wa.me link — user taps to verify |
| **Admin system** | Set an admin via OTP, they control all user permissions |
| **Poll-based approvals** | Admin taps Allow/Deny on WhatsApp polls instead of typing codes |
| **Display names** | Auto-detected from WhatsApp push name, admin can rename |
| **Group chat support** | Add the bot to groups — responds when mentioned or triggered with a configurable prefix |
| **Group trigger prefix** | Set a custom trigger word (default `@ai`) so the bot only responds when addressed |
| **Idle cleanup** | User sessions killed after 30min idle, respawn on next message |
| **File sharing** | Send and receive images, documents, audio, video |
| **Multi-number** | Connect multiple WhatsApp accounts to one server |
| **Auto-reconnect** | Exponential backoff with jitter, max 30s between retries |
| **Reconnect cooldown** | 30s startup cooldown prevents rapid reconnects that can deregister the device |
| **Watchdog** | Detects stale connections after 30min of silence |
| **Credential backup** | Auto-backup before each save, auto-restore if corrupted |
| **Registration check** | Warns on connect if device appears deregistered |

### Tools available to Claude

| Tool | What it does |
|------|-------------|
| `reply` | Send text and file attachments back to the chat |
| `react` | Add an emoji reaction to a message |
| `download_attachment` | Save media from a received message to disk |
| `fetch_messages` | List recent messages from the session cache |

### Permission relay

When Claude needs approval for a sensitive operation, the admin receives:

1. A context message showing who triggered it and what the action is
2. A WhatsApp poll with **Allow** and **Deny** options — just tap

If denied, Claude Code's current task is aborted (Escape sent to the session) and the user is notified.

Text-based `yes <code>` / `no <code>` replies also work as a fallback.

---

## Access Control

### OTP Verification (recommended)

The gateway supports OTP-based whitelisting. The admin generates a code, and shares a `wa.me` link with the user. The user taps the link, WhatsApp opens with the code pre-filled, they hit send, and they're whitelisted.

OTP codes are written to `otp.json` in the state directory. The gateway checks incoming messages against the active OTP before checking the whitelist, so it works for unknown numbers too.

### Admin system

Set an admin via OTP — the admin's WhatsApp number receives all permission requests and can approve/deny via polls. The admin is stored in `admin.json`.

### Manual access control

You can also edit `access.json` directly:

```json
{
  "allowFrom": ["14155551234", "204406284935400@lid"],
  "allowGroups": false,
  "allowedGroups": [],
  "requireAllowFromInGroups": false,
  "groupTrigger": "@ai"
}
```

| Setting | Effect |
|---------|--------|
| `allowFrom: []` | Accept messages from anyone |
| `allowFrom: ["14155551234"]` | Only accept from this number |
| `allowGroups: true` | Enable group chat support |
| `allowedGroups: ["120363...@g.us"]` | Only respond in these specific groups (required when groups enabled) |
| `groupTrigger: "@ai"` | Custom prefix to trigger the bot in groups (default: `@ai`) |

> **Note:** WhatsApp may use LID-based JIDs (e.g., `204406284935400@lid`) instead of phone numbers. OTP verification handles this automatically.

---

## Security

This plugin has been **independently security audited**. Here's what was checked and confirmed clean:

| Check | Result |
|-------|--------|
| Data exfiltration | **None.** Zero outbound HTTP calls. Only WhatsApp WebSocket + local MCP stdio. |
| Backdoors | **None.** No dynamic code execution. execFile used only for tmux management with hardcoded arguments. |
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

### v0.2.0 (2026-04-09)
**Group chat support and reliability improvements**
- **Group chat sessions** — add the bot to WhatsApp groups, each group gets its own shared Claude Code session
- **Trigger-based activation** — bot only responds in groups when mentioned or when message contains a configurable trigger prefix (default `@ai`)
- **Group metadata discovery** — auto-detects group names and saves metadata for discovered groups
- **Sender attribution in groups** — messages are prefixed with `[SenderName]` so Claude knows who's talking
- **Improved poll vote handling** — poll votes now handled in `messages.upsert` with proper decryption via Baileys' `decryptPollVote`
- **Reconnect cooldown** — 30s startup cooldown prevents rapid reconnects that can deregister the WhatsApp device
- **Registration status check** — warns on connect if `registered=false` in credentials, indicating re-pairing is needed
- **Auto-detach tmux** — after successful pairing, tmux session auto-detaches so users don't get stuck
- **SIGINT protection** — SIGINT is ignored in the gateway process to prevent accidental termination; use SIGTERM or tmux kill-session
- **Stricter group ACL** — groups must be explicitly listed in `allowedGroups` (no longer allows all groups when list is empty)
- **Mark online on connect** — WhatsApp presence now shows online when the bot connects
- **Group trigger stripping** — trigger prefix and invisible Unicode characters are cleaned from messages before delivery to Claude
- **Poll message storage** — sent polls are stored in the raw message cache so Baileys can decrypt vote responses

### v0.1.0 (2026-04-09)
**Major architecture update: per-user sessions**
- **Gateway/bridge split** — `gateway.cjs` handles WhatsApp connection and routing, `bridge.cjs` is a lightweight per-user MCP server
- **Per-user Claude Code sessions** — each WhatsApp user gets an isolated Claude Code instance in its own tmux session
- **OTP verification** — admin generates a code, shares a `wa.me` click-to-send link, users verify with one tap
- **Admin system** — set an admin via OTP, they receive all permission requests
- **Poll-based permission approvals** — admin taps Allow/Deny on WhatsApp polls instead of typing codes
- **Display names** — auto-detected from WhatsApp push name, admin can rename via SSH menu
- **Typing indicators** — users see "typing..." while Claude processes their message
- **Idle session cleanup** — user sessions killed after 30min idle, respawn on next message
- **Abort on deny** — when admin denies a permission, Claude Code's task is aborted (Escape sent), with 30s cooldown to prevent retry spam
- **User session menu** — SSH login menu shows active user sessions, selectable to attach and observe

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
