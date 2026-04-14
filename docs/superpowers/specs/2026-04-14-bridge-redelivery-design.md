# Bridge Redelivery with JSONL Dedup — Design

**Date:** 2026-04-14
**Status:** Draft, awaiting user review
**Scope:** Fix the bug where a channel message sent during or immediately after Claude's auto-compact is silently lost. Bridge will retain inbox files until it confirms Claude committed the message to `session.jsonl`, redeliver leftovers on startup, and retry stalled in-flight messages.

---

## 1. The Bug

**Symptom:** After an auto-compact, the next WhatsApp message the user sends never reaches Claude. No reply, no trace in the terminal. Future messages work only after the user nudges the session manually.

**Root cause (confirmed):** In `bridge.cjs` lines 73-74, the inbox file is deleted the moment the MCP notification promise resolves:

```js
mcp.notification({ method: "notifications/claude/channel", params: {...} })
  .then(() => { try { fs.unlinkSync(fp); } catch {} })
```

Resolution of that promise only confirms the notification was written to the bridge's stdio. It does **not** confirm Claude accepted it into `session.jsonl`. During auto-compact, Claude exits before committing the notification. `cc-watchdog` respawns it with `--continue`, which resumes from the last persisted jsonl state — which does not include the in-flight notification. Meanwhile the bridge already deleted the file. Message lost.

**Process evidence:** Observed during this session — my own claude PID started at 18:39 (minutes before diagnosis, despite hours-long conversation), meaning cc-watchdog had respawned me. The inbox file for the pre-compact message was gone.

## 2. Goals

- Zero silent message loss across auto-compact, claude crash, bridge crash, and cc-watchdog respawn.
- No changes required to Claude Code, the MCP SDK, gateway, or cc-watchdog.
- Single-file change: `bridge.cjs`.
- Rare, bounded duplicate delivery is acceptable; silent loss is not.

## 3. Non-Goals

- Guaranteed exactly-once delivery. Crash between notification and jsonl write can still cause one visible duplicate. Accepted trade-off.
- Redelivery across *reboots* of the whole host — the inbox dir persists across reboots, so this is free, but not a stated goal.
- Message ordering guarantees stronger than what the gateway already provides (lexicographic inbox filename sort).
- A new MCP ack tool. Deliberately rejected — relying on claude to call an ack tool every message is fragile.

## 4. Verified assumptions

**Claude writes channel notifications to session.jsonl.** Confirmed by grepping the current session's jsonl for a known WhatsApp message_id:

```
{"type":"queue-operation","operation":"enqueue","timestamp":"...","sessionId":"...",
 "content":"<channel source=\"whatsapp\" chat_id=\"...@lid\"
            message_id=\"ACFA9EA6419D4BC2FA1795E760B49734\"
            user=\"...\" ts=\"...\">\nProceed\n</channel>"}
```

The `message_id` attribute is present verbatim in the enqueued content. That is our dedup marker.

**JSONL path is discoverable from the bridge.** `cc-watchdog` and `gateway.cjs` already derive the slug: `pwd | sed 's|[^a-zA-Z0-9]|-|g'`. The bridge's `BRIDGE_USER_DIR` + a pass of the same slug function resolves `~/.claude/projects/<slug>/`. Newest `*.jsonl` in that dir is the active session.

## 5. Design

### 5.1 State model

Two sources of truth:

- **Inbox files** (`<userDir>/inbox/*.json`): undelivered or in-flight messages.
- **session.jsonl**: delivered messages (any `message_id` that appears in the file is considered delivered).

The bridge reconciles them. A file is deleted only once its `message_id` is observed in jsonl.

### 5.2 Reconciliation loop

Replace the current "delete on notification promise resolve" with a polling reconciler:

1. Every 1s, list all `*.json` in inbox.
2. For each file, parse to get `meta.message_id` (already present in the inbox payload — gateway.cjs line 1305).
3. Read jsonl tail (see §5.5) and check for `message_id="<id>"`.
   - **Found** → `fs.unlinkSync(file)`. Done.
   - **Not found, file never sent** → send notification, mark in-memory as "in-flight" with timestamp.
   - **Not found, file in-flight >20s** → resend notification, bump retry counter.
   - **Not found, retries ≥3 or file age >5min** → move to `<userDir>/inbox/failed/<file>` and log. Does not block the loop.

### 5.3 Startup recovery

On `mcpReady` firing (current code delays this 3s after MCP connect), run the reconciler once immediately. Any file left from a prior bridge/claude life either:

- has its `message_id` already in jsonl → deleted silently (was delivered before crash, bridge just didn't get to unlink).
- is missing from jsonl → re-notified. This is the bug fix.

### 5.4 Pre-send dedup

Before sending a notification for the first time, check jsonl. If the id is already there, skip the notification and delete the file. Protects against the startup case where the file *and* the jsonl entry both survived but the bridge forgot the in-memory "sent" flag.

### 5.5 JSONL tail scan

Reading a multi-megabyte jsonl on every tick is wasteful. Strategy:

- Keep a cached `{ path, mtimeMs, inode, text }` tuple.
- On each scan: `fs.stat` the jsonl. If `mtimeMs` and `inode` unchanged, reuse cached text. Otherwise re-read tail.
- "Tail" = last 256 KB. Enough to cover dozens of recent turns; msg-ids appear in `enqueue` entries that are usually near the end of the file when freshly delivered. Older files would already have been dedup'd and unlinked.
- If a file is >5 min old and still not in jsonl, we quarantine anyway, so the tail-window cap doesn't cause false negatives.

### 5.6 JSONL path discovery

Helper `findSessionJsonl()`:

1. Derive workspace slug from `process.cwd()` using the same encoding as cc-watchdog (`[^a-zA-Z0-9]|-`).
2. Resolve `path.join(os.homedir(), ".claude/projects", slug)`.
3. `fs.readdirSync()`, filter `.jsonl` (not `.jsonl.bak`), sort by `mtimeMs`, pick newest.
4. Cache the resolved path. Re-resolve if the cached path disappears (post-clear case) or on explicit invalidation.

If the dir/file doesn't exist, log once and treat all messages as "never delivered" — the reconciler will attempt redelivery indefinitely up to the 5-min quarantine, which degrades gracefully in that edge case.

### 5.7 Removing the old delete

Lines 73-75 in bridge.cjs change from:

```js
mcp.notification({ method: "notifications/claude/channel", params: {...} })
  .then(() => { try { fs.unlinkSync(fp); } catch {} })
  .catch((err) => log(`deliver failed: ${err}`));
```

to:

```js
const sent = sendAttempts.get(file) || { count: 0, firstSentAt: null };
sent.count += 1;
sent.firstSentAt = sent.firstSentAt || Date.now();
sendAttempts.set(file, sent);
mcp.notification({ method: "notifications/claude/channel", params: {...} })
  .catch((err) => log(`deliver failed: ${err}`));
```

Unlink is handled by the reconciler when it sees the id in jsonl. `sendAttempts` is an in-memory `Map<filename, {count, firstSentAt}>` — rebuilt from scratch on bridge restart (startup pass re-notifies anything not in jsonl, so losing the map is fine).

## 6. Edge cases

| Case | Behavior |
|------|----------|
| User sends a msg, claude processes it, bridge crashes before unlink | Restart → reconciler sees id in jsonl → deletes file. Invisible to user. |
| User sends a msg, claude auto-compacts before committing | File stays. After respawn, reconciler re-sends notification. User may see slight delay but no loss. |
| Two messages arrive, auto-compact happens between them | Both files retained. Both re-sent on recovery. Ordering preserved by lexicographic filename sort (already the case). |
| `session.jsonl` doesn't exist (post-`/clear`) | `findSessionJsonl()` fails. Messages treated as not delivered. After a fresh claude spawns and processes one, its id appears in the new jsonl → reconciler dedups. The window where this is uncertain is bounded by claude spawn time (~5s). |
| Claude genuinely rejects the notification (malformed payload) | Bridge retries 3× over 5 min, then quarantines. User never sees reply; admin sees `inbox/failed/` file + log. |
| jsonl rotates or path changes mid-session | Cache invalidation via `mtimeMs + inode` comparison catches this. Worst case: one reconciler tick uses stale cache, next tick re-resolves. |
| Double delivery (crash window) | User receives the WhatsApp message, claude's reply arrives, claude crashes before jsonl flush, bridge re-sends → user sees the same message twice in claude's thinking. Acceptable. |

## 7. Test plan

Unit tests for new helpers (`test/bridge-redeliver.test.cjs`):

- `findSessionJsonl(cwd, home)` — happy path, nested slug, missing dir, multiple jsonl files (picks newest).
- `extractMessageIds(jsonlText)` — finds `message_id="..."` in enqueue entries, ignores commentary/escaped quotes, handles partial trailing line.
- Reconciler logic exercised with mocked fs + mocked `mcp.notification`:
  - File present, id in jsonl → unlinked, no send.
  - File present, id not in jsonl, not sent yet → send called once.
  - File present, sent 21s ago, still not in jsonl → send called again.
  - File present, 3 retries, still not in jsonl → moved to `failed/`.
  - Startup: files pre-populated before reconciler runs → correct send/dedup split.

Integration test (`test/bridge-redeliver-integration.test.cjs`):

- Spawn a fake stdio peer that "accepts" notifications by writing a mock jsonl.
- Put two messages in inbox, start bridge, confirm both delivered + unlinked.
- Kill bridge mid-flight, delete the mock jsonl's last entry (simulating uncommitted compact), restart bridge, confirm missing one is re-sent.

## 8. Rollout

No feature flag needed. The change is transparent when everything works; the only observable behaviors are:

- Rare duplicate messages visible in Claude's context on crash
- Recovered messages after auto-compact (new behavior — this is the fix)
- `inbox/failed/<file>` artifacts if something genuinely breaks (new — helps debugging)

Gateway and cc-watchdog are untouched. Existing bridges in the field will get the fix on next restart (gateway respawns them per-user).

## 9. Open questions

None blocking. Noted for future consideration:

- Should quarantined (`inbox/failed/`) files be surfaced to the user or admin? For v1, log-only; revisit if we see any in practice.
- Tail window size (256 KB) — is this enough for heavy sessions? Instrument with a counter ("dedup cache miss rate"), tune later.
