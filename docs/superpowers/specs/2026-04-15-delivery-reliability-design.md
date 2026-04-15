# Outbound Delivery Reliability — DELIVERY_ACK Threshold + Error Handling + Audit Log

**Date:** 2026-04-15
**Status:** Draft, awaiting user review
**Scope:** Extend the existing outbox reconciler (shipped 2026-04-14, see `2026-04-14-outbox-redelivery-design.md`) so outbound WhatsApp messages are unlinked only once the recipient's device confirms receipt, explicit server errors are handled deterministically, and every delivery attempt is auditable. Closes the gap where a message marked "sent" by Baileys never reaches the user's phone.

---

## 1. The Remaining Gap

The 2026-04-14 fix stopped silent drops from stale sockets and server-side rejections *before* `messages.update` status 2. But `status >= 2` (SERVER_ACK) only means "WhatsApp servers accepted the frame for relay". Device-level delivery is signalled by `status >= 3` (DELIVERY_ACK, the visible second grey tick).

**Symptom observed today (2026-04-15):** Admin sent "Is there any ways to avoid this?"; user never saw the reply. Today's drop is **not conclusively diagnosed** — it could be (a) SERVER_ACK arrived but DELIVERY_ACK never did (the gap this spec addresses), (b) `status=0` arrived silently and was ignored (secondary gap below), or (c) Claude never produced a reply after auto-compact/respawn (unrelated, upstream of the gateway). The audit log introduced in §5.4 is specifically designed to disambiguate these causes on the *next* occurrence.

**Root cause of the known gap:** Our "delivered" definition stops one hop short — we unlink on SERVER_ACK, which is "WhatsApp accepted for relay", not "recipient device has it".

**Secondary gap:** `status === 0` (explicit server error, e.g., blocked number, malformed payload) is currently ignored. The reconciler silently retries until `maxRetries=5`, wasting ~25 s of retries on cases that will never succeed.

**Diagnostic gap:** Post-mortem today is impossible because nothing logs the per-message ack timeline.

## 2. Goals

- Outbox file unlinks only after **every** tracked `msg.key.id` reaches `status >= 3`.
- Explicit server errors (`status === 0`) quarantine immediately — no retry loop.
- Every send/ack/retry/quarantine event writes a structured line to `<outboxDir>/audit.jsonl` for diagnosis.
- User is willing to accept rare visible duplicates (stated preference 2026-04-15) in exchange for zero silent outbound loss.

## 3. Non-Goals

- Guaranteed zero duplicates. Phone offline > 10 min or gateway restart mid-flight can produce duplicates. Accepted.
- Read-receipt tracking (`status === 4`). Not useful for delivery guarantees.
- Log rotation. Append-only JSONL; revisit if the file grows beyond a few MB.
- Admin slash-command to view the log. Deferred; tail from SSH is enough for v1.
- Inbound reliability. Already covered by `2026-04-14-bridge-redelivery-design.md`.

## 4. Verified Baileys behavior (delta from 2026-04-14)

From `@whiskeysockets/baileys@7.0.0-rc.9` and runtime observation:

- `status` values: `0=ERROR, 1=PENDING, 2=SERVER_ACK, 3=DELIVERY_ACK, 4=READ, 5=PLAYED`.
- Typical `DELIVERY_ACK` latency when recipient online: 500 ms – 2 s.
- If recipient offline, `status=2` still arrives (server queued the message); `status=3` arrives when the device reconnects — may be minutes or hours.
- `status=0` has been observed on: blocked-number sends, malformed content. Arrives once; retries against the same underlying condition yield the same error.
- Update events can arrive out-of-order within the same event loop tick; assume monotonic advancement over a few seconds but handle late `status=0` (see §5.3).

## 5. Design

### 5.1 State model

Existing:
- `sendState: Map<filename, { msgIds: Set<string>, firstSentAt, lastSentAt, attempts }>` — unchanged.
- `outboxAckedIds: Set<string>` — **behavior change**: populated only on `status >= 3` (was `>= 2`).

New:
- `outboxErroredIds: Set<string>` — populated on `status === 0`. 60 s TTL, matching `outboxAckedIds`.

### 5.2 Reconciler decision tree

`reconcileOutboxFile({ sendState, ackedIds, erroredIds, now, stalenessMs, maxAgeMs, maxRetries })` — in precedence order:

1. **errored** → if `sendState != null` AND `sendState.msgIds ∩ erroredIds ≠ ∅`: `{ kind: "quarantine", reason: "server error" }`. **New. Highest precedence.** (Cannot trigger without `sendState`, since erroredIds is keyed by msgId which only exists after a send.)
2. **delivered** → if `sendState.msgIds ⊆ ackedIds`: `{ kind: "delete" }`. Unchanged semantics; threshold tightened by ackedIds population change.
3. **never sent** → if `sendState == null`: `{ kind: "send" }`. Unchanged.
4. **retries exhausted** → if `attempts >= maxRetries`: `{ kind: "quarantine", reason: "retries exhausted" }`. Unchanged.
5. **age exceeded** → if `now - firstSentAt > maxAgeMs`: `{ kind: "quarantine", reason: "age exceeded" }`. Unchanged.
6. **stale** → if `now - lastSentAt > stalenessMs`: `{ kind: "resend" }`. Unchanged.
7. **wait** → default. Unchanged.

### 5.3 Ack listener (`gateway.cjs`)

Current:

```js
sock.ev.on('messages.update', (updates) => {
  for (const u of updates) {
    if (u.key?.fromMe !== true) continue;
    const status = u.update?.status;
    if (typeof status === "number" && status >= 2) markAcked(u.key.id);
  }
});
```

Replacement:

```js
sock.ev.on('messages.update', (updates) => {
  for (const u of updates) {
    if (u.key?.fromMe !== true) continue;
    const status = u.update?.status;
    if (typeof status !== "number") continue;
    auditForMsg(u.key.id, statusEventName(status));  // "server_ack" | "delivery_ack" | "error" | "read" | "played"
    if (status === 0) markErrored(u.key.id);
    else if (status >= 3) markAcked(u.key.id);
    // status === 2 is informational only: logged, no state change.
  }
});
```

`markErrored(id)` mirrors `markAcked`: add to `outboxErroredIds`, `setTimeout(delete, 60_000)`.

**Late status=0 after status=3:** The reconciler already unlinked the file. `erroredIds` has no effect. Audit log still records the error for visibility. Acceptable — the message was delivered and a subsequent server-side error (e.g., retroactive spam flag) is not actionable from our side.

### 5.4 Audit log

Location: `<outboxDir>/audit.jsonl` — one file per outbox dir (one for global admin OTP outbox, one per user outbox). Append-only JSONL.

Line schema (all fields optional except `ts` and `event`):

```json
{"ts": 1744700000000, "event": "send", "filename": "1744700000-abc.json", "msg_ids": ["3EB0..."], "chat_id": "852...@s.whatsapp.net"}
```

Events and required fields:
- `send` — reconciler-emitted before `sendMessage`; carries `filename`, `chat_id`, `msg_ids` (post-send, from result).
- `server_ack` / `delivery_ack` / `error` — listener-emitted; always carries the single `msg_id` (scalar, not array). Carries `filename` + `chat_id` if found via the reverse index; omitted if attribution failed (e.g., ack arrived after `sendState.delete`).
- `retry` — reconciler-emitted when it chose `resend`; carries `filename`, `chat_id`, `attempts`.
- `quarantine` — reconciler-emitted; carries `filename`, `chat_id`, `reason`.

The gateway maintains a small reverse index `msgId → { filename, chat_id }` while `sendState` has the id, so ack events can be attributed. Entries purged when `sendState.delete(filename)` runs. Unattributed acks (late arrivals after delete, or for msg_ids we never tracked) log a line with just `msg_id` + `event`.

Writes are synchronous `fs.appendFileSync` — low volume (<10 events per message), simplifies ordering, matches the reconciler's existing sync fs patterns.

### 5.5 Tuning changes

| Knob | Before | After | Reason |
|---|---|---|---|
| `stalenessMs` | 5000 | 15000 | DELIVERY_ACK latency is 500 ms – 2 s typical; 5 s was too aggressive for the new threshold. 15 s gives 7× typical headroom while still catching real drops fast. |
| `maxRetries` | 5 | 3 | Blast radius when recipient phone is offline for a minute: 4 total sends (1 initial + 3 retries) over ~45 s → at most 4 visible duplicates when phone returns. Was 6 at 10 s / 5 retries. |
| `maxAgeMs` | 300000 (5 min) | 300000 | Unchanged. |

**Duplicate budget worked example** (recipient phone offline 60 s, messages all eventually deliver from WhatsApp's queue): initial send at `t=0` gets SERVER_ACK, retries at `t=15/30/45`, quarantine at `t=~60`. Phone returns at `t=60`; up to 4 duplicates land together. The 4th is the quarantined one (WhatsApp may or may not deliver it — quarantine just means we stop *tracking* it, we don't tell WhatsApp to cancel).

### 5.6 Restart semantics

Unchanged from 2026-04-14 §5.5: on restart `sendState`, `ackedIds`, `erroredIds` all discarded. Unlinked-by-prior-instance files stay gone. Files still in `outbox/` are resent, possibly producing duplicates. `audit.jsonl` persists — post-restart entries append.

### 5.7 Module layout

- `lib/outbox-reconciler.cjs` — add `erroredIds` to factory signature and `reconcileOutboxFile` signature. Add the errored-precedence branch. Expose a factory-level `auditEvent(event, extras)` callback for the reconciler to log `retry`/`quarantine` events without needing direct fs access.
- `gateway.cjs`:
  - Add `outboxErroredIds` Set + `markErrored(id)` helper next to existing `outboxAckedIds`.
  - Rewrite `messages.update` handler per §5.3.
  - Add `makeAuditLogger(outboxDir)` returning an `auditEvent(event, extras)` function that appends to `<outboxDir>/audit.jsonl`.
  - Maintain `msgIdToFilename` Map for ack-to-file attribution; wire alongside `sendState`.
  - Pass `erroredIds` + audit logger to `createOutboxReconciler`.

## 6. Edge cases

| Case | Behavior |
|---|---|
| `status=0` arrives before `sendState` populated (ack-before-state race) | `erroredIds.add(id)` wins; next tick sees id in erroredIds → quarantine. Same race-safety as existing `ackedIds`. |
| `status=0` arrives for one msg in a multi-part bundle (text+attachment) | Entire bundle quarantined. Text send wasted but no data loss — file is in `failed/` for manual inspection. |
| `status=3` arrives out-of-order before `status=2` | Treated normally. `ackedIds.add` fires, file eligible for unlink on next tick. No harm. |
| Late `status=0` after `status=3` | `sendState` already deleted, `erroredIds.add(id)` is a no-op against reconciler state. Audit log records the oddity. |
| Phone offline 30 min | After 3 retries × 15 s staleness = ~45 s, quarantine with reason "retries exhausted". When phone returns, any still-queued messages on WhatsApp side deliver; quarantined file can be manually re-sent from `failed/` if needed. |
| `audit.jsonl` write throws (disk full) | `try/catch` around `appendFileSync`; log to gateway stderr once per error. Reconciler continues. |
| Gateway boots with existing `audit.jsonl` | Appends. No rotation. File size monitored manually for v1. |
| User reacts to a message before DELIVERY_ACK | Unrelated — reactions are separate events on a different code path. |

## 7. Test plan

### 7.1 Unit tests (extend `test/outbox-reconciler.test.cjs`)

Pure decision fn:
- Errored id present → `quarantine` with `reason: "server error"` (new).
- Errored id present AND ackedIds also matches → `quarantine` wins (errored beats delivered).
- Errored id from different file (not in this file's `msgIds`) → no effect, normal flow.

Factory tick:
- Error path: emit `erroredIds.add` before tick → file moved to `failed/` in one tick.
- status=3 threshold: ackedIds populated from status=3 emission unlinks; ackedIds populated from status=2-only does NOT unlink (test harness calls the post-listener helper directly).

### 7.2 Integration tests (extend `test/outbox-integration.test.cjs`)

Update existing scenarios:
- Scenario A (happy path) — emit `status=3` (was `status=2`). Also expect one `server_ack` + one `delivery_ack` line in audit log.
- Scenario C (restart duplicate) — same status flow; verify audit log persists across fresh reconciler.

Add:
- Scenario E — **explicit error**: fake socket emits `status=0` after sendMessage; assert file in `failed/`, audit log has `error` + `quarantine`.
- Scenario F — **server_ack without delivery_ack**: emit `status=2` only; advance clock past staleness; assert resend; then emit `status=3` for new msgId; assert unlink.
- Scenario G — **audit log format**: run Scenario A; read `audit.jsonl`; assert schema, event ordering (`send` → `server_ack` → `delivery_ack`).
- Scenario H — **unattributed ack**: file sent, then unlinked (status=3), then a late `status=0` arrives for the same `msg_id` after `sendState.delete(filename)`; assert an audit line is written with only `ts` + `event: "error"` + `msg_id`, and the reconciler's next tick does *not* observe any new quarantine or resend.

All integration tests continue to use real filesystem + real reconciler + fake socket.

## 8. Rollout

- No migration. Existing `sendState`, `ackedIds` reset on restart as always.
- Existing `outbox/failed/` artefacts unaffected.
- First `audit.jsonl` created on first outbound message after restart.
- Observable effects for admin:
  - No more "I replied but you didn't get it" silently.
  - Occasional duplicate on phone returning from offline (documented).
  - `tail -f <IPC_BASE>/users/<uid>/outbox/audit.jsonl` shows every send with its ack timeline.

## 9. Open questions

- **Should the audit log live outside the outbox dir** (e.g., `<IPC_BASE>/delivery-log.jsonl`) so it survives `rm -rf outbox/`? **Decision:** keep it inside `outbox/` for v1 — colocation makes per-user debugging easier, and nobody is `rm -rf`-ing this dir in normal ops. Revisit if that assumption breaks.
- **Why not also retry on `status=0`?** Baileys surfaces `status=0` when the server says "this won't deliver". Retrying the same payload yields the same error. Quarantining is faster, quieter, and leaves the file for manual inspection. Revisit if real-world `status=0` cases turn out to be transient.
- **Does `status >= 3` threshold cause problems when recipient blocks read receipts?** No. DELIVERY_ACK is distinct from READ (`status=4`); delivery tick fires regardless of read-receipt privacy settings.
