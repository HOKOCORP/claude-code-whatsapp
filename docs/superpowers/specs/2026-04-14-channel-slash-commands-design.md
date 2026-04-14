# Channel Slash Commands — Design

**Date:** 2026-04-14
**Status:** Draft, awaiting user review
**Scope:** Add `/clear`, `/compact`, and `/help` slash commands to the WhatsApp channel gateway, alongside the existing `/usage` handler. Both destructive commands gated by an OTP-style double confirmation.

---

## 1. Goals

- Let channel users issue `/clear` and `/compact` from WhatsApp to manage their per-user Claude session, mirroring the equivalents in the Claude Code terminal harness.
- Let users discover available commands via `/help`.
- Make destructive commands safe over a remote channel: never fire on a single tap or on stale scrollback messages.
- Reuse existing infrastructure (`gateway.cjs`, the per-user tmux session manager, `sock.sendMessage`) with no upstream forks elsewhere.

## 2. Non-Goals

- `/resume` — out of scope. `cc-watchdog` already auto-continues each session via `--continue`, so a manual resume command is redundant for this architecture.
- `/usage` — already implemented in `gateway.cjs` lines 1167-1263; not modified here.
- Group-mode behavior — the new commands are personal-session controls; same trigger-strip rules as `/usage` apply (commands work inside `@ai /clear` etc.) but the action only affects the sender's own session.
- Restoring from a checkpoint — checkpoints are written for safety, but a `/restore-last` command is deferred to a future spec.
- Admin-only gating — each user controls their own session, so any whitelisted user can use these commands.

## 3. Commands

### 3.1 `/help`

Non-destructive, instant reply. Lists all channel slash commands with a one-line description each. Destructive commands marked with ⚠️.

**Reply text (verbatim):**
```
🤖 *Channel commands*

📊 /usage          Show your monthly tokens & cost
📋 /usage history  Show top-up history
🤖 /help           Show this list

⚠️ /clear          Wipe my conversation memory (OTP required)
⚠️ /compact        Summarize & shrink my context (OTP required)

Destructive commands ask you to confirm with a 4-digit code.
```

### 3.2 `/clear`

Destructive. Wipes the user's Claude session JSONL. Auto-checkpoints first.

**First message — user sends `/clear`:**
```
⚠️ *Clear conversation*

✅ *Why use it:* Wipes context window. Token usage drops to near zero, replies get faster, great when switching projects.

⚠️ *Risk:* I will forget *everything* — files explored, decisions made, what you just asked me to do. Not undoable from chat.

Reply with code *NNNN* within 90s to confirm.
```

**Second message — user sends matching 4-digit code within 90s:**
1. Reply: `🛟 Checkpointing your conversation…`
2. Copy `~/.claude/projects/<workspace-slug>/` → `~/.ccm/checkpoints/<userId>/<UTC-timestamp>/` (preserves all `.jsonl` plus a small `meta.json`).
3. `tmux kill-session -t <getUserSessionName(userId)>` — terminates the live Claude process.
4. Delete the original `*.jsonl` files in `~/.claude/projects/<workspace-slug>/` (so the next spawn does NOT pass `--continue`).
5. Reply: `✅ Cleared. Send any message to start fresh.`
6. Next inbound message triggers gateway's existing user-session spawn path (`isSessionRunning` returns false → fresh tmux + `cc-watchdog` → fresh `claude` with no `--continue`).

### 3.3 `/compact`

Destructive (lossy). Triggers Claude's built-in `/compact` via tmux send-keys.

**First message — user sends `/compact`:**
```
🗜️ *Compact conversation*

✅ *Why use it:* Shrinks token usage while keeping the gist. Less aggressive than /clear.

⚠️ *Risk:* I may lose specific details — exact file paths, line numbers, subtle decisions. The summary is lossy.

Reply with code *NNNN* within 90s to confirm.
```

**Second message — user sends matching code:**
1. Reply: `🗜️ Compacting…`
2. Capture pane via `tmux capture-pane -p -t <session>`. Claude is considered idle at input when (a) the captured text contains the prompt-box border characters (`╭` and `╰`) AND (b) does NOT contain `Enter to confirm` (the marker used by `cc-watchdog`'s prompt poller, indicating a blocking dialog). If idle, send keys immediately. Otherwise schedule a single retry after 1s; if still not idle, abort and reply `⚠️ Couldn't compact — Claude is busy. Try again in a moment.`
3. `tmux send-keys -t <session> "/compact" Enter`.
4. No second reply — Claude itself will respond when compaction completes.

## 4. State Model

### 4.1 Pending action

One file per user: `~/.ccm/pending/<userId>.json`

```json
{
  "action": "clear" | "compact",
  "code": "4827",
  "created_at": 1776512345,
  "expires_at": 1776512435
}
```

- **Atomic write:** write to `<userId>.json.tmp`, then `rename`.
- **TTL:** `expires_at = created_at + 90`. On read, if `now > expires_at`, treat as no pending action and unlink the file.
- **Single-use:** delete the file as soon as the OTP is consumed (success or rejection on a different code).
- **Re-issue:** if the user sends `/clear` (or `/compact`) while a pending action exists, overwrite atomically with a new code and reply with the new code. Never wait the old TTL out.

### 4.2 Code generation

Generated as: `crypto.randomInt(0, 10000).toString().padStart(4, "0")` (`crypto.randomInt` is cryptographically uniform, unlike `Math.random()`).
Range `0000`-`9999`. Single-use within 90s — collision risk is negligible.

### 4.3 Checkpoints

`~/.ccm/checkpoints/<userId>/<UTC-timestamp>/`
- Mirror copy of the user's project dir at `~/.claude/projects/<workspace-slug>/`.
- Plus `meta.json`: `{ workspace_slug, session_name, jsonl_count, total_bytes, cleared_at }`.
- No automated cleanup yet — disk grows over time. Acceptable for v1 (each checkpoint is small kilobytes-to-MB; user can prune manually). Future: cron retention.

## 5. Code Layout in `gateway.cjs`

A single new helper, placed above the per-message loop:

```js
async function handleSlashCommand(sock, jid, userId, userDir, text) {
  // returns true if message was consumed (caller should `continue`)
  // returns false otherwise
}
```

Inside, dispatch on:
1. Pending OTP code match (`/^\d{4}$/.test(text.trim())` and matching pending file)
2. `/help`
3. `/clear`
4. `/compact`
5. (Existing `/usage` cases will be migrated INTO this helper in the same patch, to keep the dispatch logic in one place. The user-visible behavior of `/usage` stays identical.)

Call site in the per-message loop replaces lines 1167-1263:
```js
if (await handleSlashCommand(sock, jid, userId, userDir, text)) continue;
```

The helpers `isSessionRunning(sessionName)` (line 668), `getUserSessionName(userId)`, and `tmux kill-session` (already used at line 1512) are reused.

## 6. Data Flow

### 6.1 `/clear` end-to-end

```
WhatsApp → gateway socket → per-message loop
  → handleSlashCommand sees "/clear"
    → write pending-action.json {action:"clear", code, expires_at}
    → sock.sendMessage(jid, warning + code)
    → return true (consumed)

WhatsApp → user types "4827" within 90s
  → handleSlashCommand sees /^\d{4}$/, reads pending file
    → match? → continue. No match? → fall through to normal message path.
    → reply "Checkpointing…"
    → cp -a project dir → ~/.ccm/checkpoints/<userId>/<ts>/
    → tmux kill-session -t <name>
    → unlink the *.jsonl files
    → unlink pending file
    → reply "Cleared. Send any message to start fresh."
    → return true
```

### 6.2 `/compact` end-to-end

Same as `/clear` up to OTP match, then:
- Verify pane is at input (capture-pane heuristic) — retry once after 1s if not.
- `tmux send-keys -t <name> "/compact" Enter`.
- Claude itself produces the next chat message.

## 7. Edge Cases

| Case | Behavior |
|---|---|
| User sends `4827` with no pending action | Fall through to normal message path (Claude sees it). |
| User sends `4827` but pending code is `3915` | Reject: reply `⚠️ Code didn't match. Send /clear or /compact again to get a new code.` Delete pending file (single-use). |
| Pending action expired (>90s) on read | Treat as no pending. Delete stale file. Code message falls through to normal path. |
| User sends `/clear` while `/compact` is pending | Overwrite pending with new clear action + new code. Reply with new clear warning. |
| User sends `/clear` twice in a row | Second one re-issues a new code; old code is invalidated. |
| `tmux kill-session` fails (session doesn't exist) | Log + continue with JSONL cleanup + reply success. The fresh-spawn path doesn't care. |
| JSONL `unlink` fails (permissions, etc.) | Log + reply `⚠️ Cleared but couldn't fully remove old session. SSH in to clean up.` — never crash gateway. |
| `sock.sendMessage` fails | Log only. The user will retry. |
| Claude is mid-tool-call when `/compact` confirmed | `tmux send-keys` queues; Claude processes when idle. Acceptable. |
| Claude is at a permission prompt when `/compact` confirmed | Capture-pane heuristic detects this, defers + retries once. If still busy, abort with a "try again" reply rather than risk hijacking the prompt. |
| Group chat | Trigger-strip already happens in line 1162-1166. Commands work in groups exactly like `/usage` does today; only the sender's own session is affected. |
| User on cooldown / out of balance | Slash commands bypass `checkUserLimit` because they're channel meta-commands (not Claude turns). Same as `/usage`. |

## 8. Testing

No test framework exists in the project, so testing is manual + a small standalone Node script for the pure helper logic.

**Unit-level (Node script `test/slash-commands.test.cjs`, run with `node test/...`):**
- Code generation produces zero-padded 4-digit strings.
- Pending file: write, read, expire, re-issue, atomic rename are correct.
- OTP match comparison is constant-time-ish (use `crypto.timingSafeEqual` to avoid a marginal timing leak even though the codes are short-lived).

**Manual test matrix on a real WhatsApp number:**
1. `/help` → returns help text.
2. `/clear` → warning with code → `/clear` again → new code → submit code → confirmation → next message starts fresh (verify by asking "what did we just discuss?").
3. `/compact` → warning with code → submit code → Claude visibly compacts (next message should reference summarized history).
4. `/clear` then submit wrong code → rejection → submit right code (after another /clear) → success.
5. `/clear` then wait >90s → submit code → falls through to normal message.
6. `/clear` → kill the gateway process mid-flow → restart gateway → submit code → expired or accepted (acceptable either way; document actual behavior).
7. Group test: in a group with `@ai` trigger, `@ai /help` returns help.
8. Verify checkpoints land at `~/.ccm/checkpoints/<userId>/<ts>/` after `/clear`.

## 9. Assumptions

- The user's tmux session name returned by `getUserSessionName(userId)` matches what `cc-watchdog` and `cc-login.sh` expect (verified: pattern is `cc-ch-wa-{phone}-u-{uid}`).
- `~/.claude/projects/<slug>/*.jsonl` is the canonical session storage (verified in `cc-watchdog` line 71-84).
- `cc-watchdog`'s `--continue` logic is presence-based on `*.jsonl` files, so deleting them is sufficient to force a fresh session (verified: line 80-84 of cc-watchdog).
- The per-user gateway runs as the user, so it has filesystem write access to `~/.claude/projects/...` for that user. (Holds in the current per-user-process model. Would need revisiting if isolation mode separates UIDs differently.)
- WhatsApp `sock.sendMessage` is reliable enough that a single send is acceptable; no retry queue.

## 10. Open Questions

None blocking. To revisit post-v1:
- Should we surface checkpoint disk usage in `/usage`?
- Should `/clear` accept an optional reason (`/clear switching to project X`) recorded in the checkpoint meta for later review?
- Should the next-message-after-clear get an automatic system-reminder-like greeting (`👋 Fresh session. Last cleared 30s ago.`)?
