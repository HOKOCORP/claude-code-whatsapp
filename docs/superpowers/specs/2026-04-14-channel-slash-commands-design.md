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

**Second message — user sends matching 4-digit code within 90s. Order is chosen for crash-safety: claude session state is moved out of the project dir BEFORE the tmux kill, so a gateway crash mid-flow can never leave a half-cleared session that resumes on next spawn.**

1. Reply: `🛟 Checkpointing your conversation…`
2. `mkdir -p ~/.ccm/checkpoints/<userId>/<UTC-timestamp>/`
3. **Atomic move** the project dir into the checkpoint: `mv ~/.claude/projects/<workspace-slug> ~/.ccm/checkpoints/<userId>/<UTC-timestamp>/originals` (same filesystem, single rename — atomic on local fs). claude's open file descriptors keep working against the renamed inode; the new spawn will see no project dir.
4. `mkdir ~/.claude/projects/<workspace-slug>` — recreate empty (so cc-watchdog's `compgen -G "*.jsonl"` finds nothing → no `--continue`).
5. Write `meta.json` into the checkpoint dir: `{ workspace_slug, session_name, jsonl_count, total_bytes, cleared_at }`.
6. `tmux kill-session -t <getUserSessionName(userId)>` — terminates the live Claude process.
7. Unlink the pending file.
8. Reply: `✅ Cleared. Send any message to start fresh.`
9. Next inbound message triggers gateway's existing user-session spawn path (`isSessionRunning` returns false → fresh tmux + `cc-watchdog` → fresh `claude` with no `--continue`).

**Crash safety:** Step 3 is a single `rename` syscall on a local fs (atomic). After that step succeeds, the user's session is effectively cleared from cc-watchdog's perspective — even if every subsequent step fails, the next inbound message will spawn a fresh claude (empty project dir → no `--continue`). The only step whose failure aborts the operation is the move itself (handled in §7 edge cases).

**Workspace-slug computation:** Use the same encoding `cc-watchdog` does at line 78 (`pwd | sed 's|[^a-zA-Z0-9]|-|g'`) and that `gateway.cjs` already uses around line 751. Don't reimplement — call the existing helper if one is exported, otherwise extract a small util.

**Disk pressure:** Keep the *last 10 checkpoints per user*. After step 5, list `~/.ccm/checkpoints/<userId>/`, sort by name (UTC-timestamp sorts lexicographically), `rm -rf` everything beyond the 10 most recent. Bounds disk growth without losing the recent history.

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
2. Capture pane via `tmux capture-pane -p -t <session>`. Claude is considered idle at input when (a) the captured text contains the prompt-box border characters (`╭` and `╰`) AND (b) does NOT contain `Enter to confirm` (the marker used by `cc-watchdog`'s prompt poller, indicating a blocking dialog). If idle, proceed. Otherwise schedule a single retry after 1s; if still not idle, abort and reply `⚠️ Couldn't compact — Claude is busy. Try again in a moment.`
3. **Clear the input box first** with `tmux send-keys -t <session> Escape` — defensive in case the user (or another process) had keystrokes pending in the input. Same pattern as gateway.cjs lines 1031, 1120, 1337.
4. `tmux send-keys -t <session> "/compact" Enter`.
5. Unlink the pending file.
6. No second reply from gateway — Claude itself will respond when compaction completes.

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
- **Lifetime:** delete the file when (a) the action completes successfully, or (b) the user sends a wrong 4-digit code (single-use), or (c) a new `/clear`/`/compact` overwrites it. **Do NOT delete** if the action fails partway through (checkpoint error, etc.) — the user may want to retry the same code.
- **Re-issue:** if the user sends `/clear` (or `/compact`) while a pending action exists, overwrite atomically with a new code and reply with the new code. Never wait the old TTL out.

### 4.2 Code generation

Generated as: `crypto.randomInt(0, 10000).toString().padStart(4, "0")` (`crypto.randomInt` is cryptographically uniform, unlike `Math.random()`).
Range `0000`-`9999`. Single-use within 90s — collision risk is negligible.

### 4.3 Checkpoints

`~/.ccm/checkpoints/<userId>/<UTC-timestamp>/`
- Contains `originals/` — the entire former project dir, moved in by `mv` (see §3.2 step 3).
- Plus `meta.json` written after the move: `{ workspace_slug, session_name, jsonl_count, total_bytes, cleared_at }`.
- **Retention:** keep last 10 per user, prune older. Bounds disk growth without losing recent history. Implementation: after writing, `readdir` the user's checkpoints dir, sort lexicographically (UTC-timestamps sort correctly), `rm -rf` everything beyond the 10 newest.

### 4.4 `userId` filename safety

All paths embed `<userId>` (a WhatsApp JID like `204406284935400@lid`). `gateway.cjs` already exports a `sanitizeUserId` helper (used at line 1207) to make JIDs filesystem-safe — reuse it for every path that includes `<userId>`. Do not concatenate raw JIDs into paths.

## 5. Code Layout in `gateway.cjs`

**Do not refactor the existing `/usage` handlers.** They work, they're tested, and moving them carries risk for zero user-visible benefit. The new commands get their own helper, placed adjacent to the existing `/usage` blocks.

```js
async function handleChannelSlashCommand(sock, jid, userId, userDir, text) {
  // Handles: pending OTP, /help, /clear, /compact.
  // Returns true if message was consumed (caller should `continue`),
  //         false otherwise (fall through to /usage block, then to claude).
}
```

Inside, dispatch order matters (most specific first):
1. **Pending OTP match** — `/^\d{4}$/.test(text.trim())` AND a non-expired pending file exists for this user with that code → execute the pending action.
2. `/help` (any case)
3. `/clear` (any case)
4. `/compact` (any case)
5. Otherwise return false.

Call site: insert immediately *before* the existing `/usage history` check at line 1169:
```js
if (await handleChannelSlashCommand(sock, jid, userId, userDir, text)) continue;
```

This keeps `/usage` working untouched and lets the new dispatcher short-circuit before the rest of the loop. Reused helpers: `isSessionRunning(sessionName)` (line 668), `getUserSessionName(userId)`, `sanitizeUserId(...)` (line 1207), `tmux kill-session` (already used at line 1512).

## 6. Data Flow

### 6.1 `/clear` end-to-end

```
WhatsApp → gateway socket → per-message loop
  → handleChannelSlashCommand sees "/clear"
    → write pending-action.json {action:"clear", code, expires_at}
    → sock.sendMessage(jid, warning + code)
    → return true (consumed)

WhatsApp → user types "4827" within 90s
  → handleChannelSlashCommand sees /^\d{4}$/, reads pending file
    → match? → continue. No match (single-use)? → reject + unlink + return true.
    → no pending? → return false (falls through to /usage block, then to claude).
    → reply "Checkpointing…"
    → mkdir checkpoint dir
    → mv project dir → checkpoint dir/originals (ATOMIC)
    → mkdir empty project dir
    → write checkpoint meta.json
    → tmux kill-session
    → unlink pending file
    → prune checkpoints beyond 10 newest
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
| User legitimately sends a 4-digit number that happens to match the pending OTP | Action fires unintentionally. Probability is 1/10000 per pending action. Accepted limitation for v1. Mitigation if it ever bites: require `code 4827` prefix, or expand to 6 digits. |
| Checkpoint `cp`/`mv` fails (disk full, permissions) | Reply `⚠️ Couldn't checkpoint — aborting clear to keep your session safe.` Leave pending file alone so the user can retry by sending the code again. |

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
