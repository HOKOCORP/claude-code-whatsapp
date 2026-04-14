# Outbox Redelivery with Baileys-Ack Confirmation — Design

**Date:** 2026-04-14
**Status:** Draft, awaiting user review
**Scope:** Fix the silent drop of outbound WhatsApp messages in `gateway.cjs`. Gateway currently `unlinkSync`s the outbox file BEFORE awaiting `sock.sendMessage`, so any send failure (stale socket, thrown exception, server-side drop) loses the message with no retry path. The fix keeps the outbox file until Baileys confirms the message reached the server (`messages.update` event with `status >= 2 (SERVER_ACK)`), retries in-flight sends, and quarantines unsendable files.

---

## 1. The Bug

**Symptom (confirmed today):** A WhatsApp reply the bridge reported as sent never reached the user. Admin noticed silent drop and asked to investigate. No gateway log entry for the drop (neither success nor failure).

**Root cause:** `gateway.cjs:1399`

```js
const d = fs.readFileSync(fp, "utf8"); fs.unlinkSync(fp); const a = JSON.parse(d);
// ...
await sock.sendMessage(a.chat_id, { text: a.text }, q ? { quoted: q } : undefined);
```

The `unlinkSync` runs synchronously before `await sock.sendMessage`. If the send throws (e.g., Baileys detects a stale WebSocket — `if (!ws.isOpen) throw ConnectionClosed`), the error is caught and logged at line 1422 but the file is already gone. Message lost.

Even if `sendMessage` resolves without throwing, the `WAMessage` return value only means Baileys formatted and queued the frame locally (status 1, `PENDING`). Server-side ACK (status 2, `SERVER_ACK`) arrives asynchronously on `messages.update`, typically 100-150 ms later. A silent server-side rejection leaves the file gone and the message undelivered.

**The same pattern applies to the global outbox (line 1390, admin OTP messages).**

## 2. Goals

- Zero silent outbound loss across: stale socket, Baileys exception, gateway restart, cc-watchdog respawn.
- Deliver every queued outbox file OR quarantine it after bounded retries.
- Fix covers both the global outbox (`<IPC_BASE>/outbox/`) and each per-user outbox (`<IPC_BASE>/users/<uid>/outbox/`).
- Single-file change where possible (`gateway.cjs` plus one new `lib/outbox-reconciler.cjs`).
- Preserve current behavior for ephemeral actions (typing indicators). Those are fire-and-forget.

## 3. Non-Goals

- Guaranteed exactly-once delivery. Gateway restart mid-send can still cause ONE visible duplicate (same message arrives twice on the user's WhatsApp). Accepted trade-off vs. silent loss.
- Upstream changes to Baileys.
- Retry of `download` actions (local filesystem write, no WhatsApp send).
- Retry of `typing_start` / `typing_stop` actions (ephemeral hints; a lost typing indicator causes no data loss).
- Persisting in-memory ack tracking across gateway restart — restart re-sends unconfirmed files instead.

## 4. Verified Baileys behavior

From inspecting `@whiskeysockets/baileys@7.0.0-rc.9` against the running gateway:

- `sock.sendMessage(jid, content, options)` returns `Promise<WAMessage | undefined>`. Success resolves with `{ key: { id, remoteJid, fromMe }, messageTimestamp, ... }`. Failure throws (stale socket → `Boom('Connection Closed')`).
- `sock.ev.on('messages.update', updates => {...})` fires when the server ACKs. Each update has `{ key: { id, ... }, update: { status } }`. Status values: `0=ERROR, 1=PENDING, 2=SERVER_ACK, 3=DELIVERY_ACK, 4=READ, 5=PLAYED`.
- Typical `SERVER_ACK` latency: 100–150 ms after `sendMessage` resolves. Can be longer under poor network conditions.
- `sock.ws.isOpen` (boolean) signals whether the WebSocket is currently alive.

These facts drive the design.

## 5. Design

### 5.1 State model

- **Outbox files** (`<dir>/outbox/*.json`): pending messages whose delivery is not yet confirmed.
- **In-memory `sendState` map**: `Map<filename, { msgIds: Set<string>, firstSentAt, lastSentAt, attempts }>`. A single outbox file can trigger multiple `sendMessage` calls (text body plus N attachments), each yielding its own `msg.key.id`. All of them are tracked in `msgIds`. Populated after each `sendMessage` returns.
- **In-memory `ackedIds` set**: short-lived set of `msg.key.id` values seen via `messages.update` with `status >= 2`. Covers the race where the ACK fires before the post-`sendMessage` state update lands. Entries expire after 60s.

A file is considered fully delivered when EVERY id in its `msgIds` appears in `ackedIds`. Partial acks (e.g., text body acked but attachment not) leave the file in place; the reconciler's staleness logic will eventually resend the whole bundle if any id stays un-acked. Re-sending a bundle that was partially successful will cause visible duplicates for the acked parts — accepted trade-off vs. silent loss of the failed parts.

### 5.2 Send flow (per outbox file, per tick)

1. Poll scans `<dir>/outbox/` every 1500 ms (unchanged cadence).
2. For each `*.json` file:
   a. Read the file content (do NOT unlink yet).
   b. Consult the reconciler's decision fn with `{ id: sendState.get(filename)?.msgId || null, attempts, firstSentAt, lastSentAt, ackedIds, now, stalenessMs, maxAgeMs, maxRetries }`.
   c. Action is one of: `delete` | `send` | `resend` | `quarantine` | `wait`.
3. Action dispatch:
   - **`delete`** → `fs.unlinkSync(fp)`, remove from `sendState`.
   - **`send`** or **`resend`** → call `sock.sendMessage(...)` for each part (text + each attachment, sequentially). After each part returns, add `msg.key.id` to the file's `sendState.msgIds` set. After all parts attempted, check whether every id in the set is in `ackedIds`; if so, `delete` immediately (handles the ack-before-state-write race). If any part throws, log and keep the file — the whole bundle will be retried on the next staleness tick (accepting duplicates for already-acked parts).
   - **`quarantine`** → `mv` file into `<dir>/outbox/failed/<filename>`, remove from `sendState`, log.
   - **`wait`** → no-op.

### 5.3 Ack listener

Attach once on gateway init, right after `sock` is created:

```js
sock.ev.on('messages.update', (updates) => {
  for (const u of updates) {
    if (!u?.key?.id || !u?.update) continue;
    if (u.key.fromMe !== true) continue; // only care about our own sent messages
    const status = u.update.status;
    if (typeof status === "number" && status >= 2) {
      ackedIds.add(u.key.id);
      setTimeout(() => ackedIds.delete(u.key.id), 60_000);
      // Check if any tracked file now has all its msgIds acked
      for (const [filename, s] of sendState) {
        if (s.msgIds.has(u.key.id)) {
          const allAcked = [...s.msgIds].every(id => ackedIds.has(id));
          if (allAcked) deliverFileUnlink(filename);
        }
      }
    }
  }
});
```

### 5.4 Retry, quarantine, and aging

Mirror the inbox reconciler's thresholds:
- `stalenessMs = 5000` — if `lastSentAt` > 5 s ago and no ack, resend.
- `maxAgeMs = 5 * 60 * 1000` — total time in outbox before quarantine.
- `maxRetries = 5` — send attempts before quarantine (slightly higher than inbox's 3 because outbox is I/O-bound and a brief WhatsApp outage shouldn't trigger quarantine).

Staleness shorter than inbox (inbox used 20s) because SERVER_ACK is fast and a >5s absence is a real signal.

### 5.5 Restart semantics

Gateway restart discards `sendState` and `ackedIds`. On next outbox scan:
- Any file without `sendState` entry → `send`. If the message was actually delivered before restart (ack arrived but gateway died before unlink), this triggers a visible duplicate. **Accepted trade-off.**
- Pre-restart attempts counter is lost. The post-restart counter starts fresh (worst case: a file that was about to quarantine survives longer).

### 5.6 Actions that bypass the reconciler

Two action types do NOT go through `sendMessage` and should keep their current fire-and-forget semantics:

- `typing_start` / `typing_stop` — emit `sock.sendPresenceUpdate(...)` only. Wrap in try/catch, unlink immediately regardless of outcome. Noisy to retry, ephemeral signal.
- `download` — local filesystem write; no WhatsApp send. Unlink after write completes (as today).

The reconciler only covers: `reply` (text + files) and `react`. File attachments inside a `reply` are treated as a group — if ANY of the sends in the group throws, keep the file, mark for retry. On retry, re-send all parts. (WhatsApp will show duplicates of the successfully-sent parts. Acceptable.)

### 5.7 Module layout

- `lib/outbox-reconciler.cjs` — new. Exports `{ reconcileOutboxFile, createOutboxReconciler }`. Pure decision fn + stateful factory with `tick()`. Takes deps by injection: `{ sock, outboxDir, userDir, now, stalenessMs, maxAgeMs, maxRetries, ackedIds, sendState, log }`.
- `gateway.cjs` — modify outbox poll loop. Delegate to `createOutboxReconciler(...)` per outbox dir. Attach `messages.update` listener once.

### 5.8 Success metric

Every outbox file ends in exactly one of these states:
- Unlinked because `msg.key.id` landed in `ackedIds` — **delivered**.
- Moved to `outbox/failed/` after retry/age exhaustion — **quarantined**, admin can inspect.

No file should remain in `outbox/` indefinitely.

## 6. Edge cases

| Case | Behavior |
|---|---|
| `sock.sendMessage` throws (stale socket) | File kept. Next tick (1.5s later) retries. Ack listener is unaffected. |
| `sock.sendMessage` resolves but server silently drops | No ack arrives. After `stalenessMs=5s`, reconciler resends (new `msg.key.id`). Eventually acks or quarantines. |
| Ack fires between `sendMessage` resolve and `sendState.set` | `ackedIds.has(msg.key.id)` is true → immediate unlink. |
| Gateway crashes between ack and unlink | File still present on restart. Re-sent. User sees duplicate (accepted). |
| WhatsApp socket disconnect mid-send | `sendMessage` throws. File kept. On reconnect, reconciler retries. |
| Out-of-order ticks (multiple files at once) | Tick is synchronous per outbox dir; files processed in lex order. Concurrent sends to different chats are fine. |
| User's chat blocks our number | `sendMessage` throws or ack never arrives → quarantine after 5 min. |
| Admin outbox (global OTP path, line 1390) | Same treatment. Uses the same reconciler against `<IPC_BASE>/outbox/`. |

## 7. Test plan

### Unit tests (new, `test/outbox-reconciler.test.cjs`)

Pure decision fn:
- Delivered id → `delete`
- Never sent → `send`
- Sent recently → `wait`
- Sent `> stalenessMs` ago → `resend`
- `attempts >= maxRetries` → `quarantine`
- Age `> maxAgeMs` → `quarantine`
- Id in `ackedIds` race set → `delete`

Factory tick:
- Normal flow: tick sends, ack arrives, next tick unlinks
- Stale socket: sendMessage throws → file kept, retry next tick
- Pre-ack race: ack fires before `sendState.set`; reconciler unlinks on next tick
- Quarantine after 5 retries
- Quarantine after 5 min age
- `typing_start` bypass: unlinked immediately
- Malformed JSON: quarantined

### Integration test (`test/outbox-integration.test.cjs`)

Use a fake Baileys socket object (mock `sendMessage` + expose an `emit('messages.update')` helper). Real `outbox-reconciler` module. Real filesystem (tmp dirs).

- Scenario A — happy path: tick sends, emit ack with `status=2`, next tick unlinks.
- Scenario B — stale-socket simulation: first tick's `sendMessage` throws; after N ticks, socket "recovers" and sendMessage succeeds; ack arrives; file unlinked.
- Scenario C — gateway restart simulation: tick once (file stays, no ack), discard reconciler state, create fresh reconciler, tick again → resend; ack arrives; file unlinked. (Documents the "rare duplicate" trade-off.)
- Scenario D — full quarantine: sendMessage always throws; file ends up in `outbox/failed/` after `maxRetries`.

## 8. Rollout

Transparent after gateway restart. Behaviors observable to the admin:
- No more silent drops (visible change: less "why didn't X get through?" moments).
- Possible rare duplicates on gateway restart or crash (documented).
- Quarantine artifacts in `<dir>/outbox/failed/` if anything truly broken.

No migration needed. Existing inbox reconciler is untouched.

## 9. Open questions

- Should `react` actions use the reconciler, or skip it? Reactions are semi-ephemeral but user-visible. **Decision:** include them for consistency — they're rare enough that retry cost is trivial.
- Media re-sends on retry can blow up data if the attachment is large. **Decision:** accept for v1. If any user ever re-sends a 50MB video three times due to flaky WhatsApp, we can add per-file suppression later.
- Should `sock.ws.isOpen` be checked before attempting `sendMessage`? **Decision:** no — let Baileys throw; the reconciler handles the retry. An explicit pre-check adds a race (socket might close between check and send).
