# Outbound Delivery Reliability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the remaining silent-drop class from the 2026-04-14 outbox fix — unlink outbox files only after recipient device confirms (`status >= 3`, DELIVERY_ACK), quarantine on explicit server error (`status === 0`), and emit a per-outbox JSONL audit trail so next time "didn't get your reply" happens we can diagnose in seconds.

**Architecture:** Four small additions that layer onto the existing reconciler. One new pure module (`lib/ack-dispatcher.cjs`) translates Baileys status codes to (audit event, set-to-populate) pairs. One new module (`lib/audit-log.cjs`) is a trivial append-JSONL writer. The existing `lib/outbox-reconciler.cjs` gains an `erroredIds` input + callbacks for audit/register/unregister. `gateway.cjs` rewires its `messages.update` listener through the dispatcher, maintains a `msgId → { filename, chat_id, dir }` reverse index, and passes the new deps into each reconciler instance. Knobs tuned: `stalenessMs` 5000→15000, `maxRetries` 5→3.

**Tech Stack:** Node.js (CommonJS `.cjs`), `node:test` (via `npm test`), Baileys v7.0.0-rc.9 (existing dep). No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-15-delivery-reliability-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/ack-dispatcher.cjs` (NEW) | Pure fn: given a Baileys `status` number, returns `{ event, target }` where `event ∈ {"server_ack","delivery_ack","error","read","played",null}` and `target ∈ {"acked","errored",null}`. Caller does the side effect. |
| `test/ack-dispatcher.test.cjs` (NEW) | Unit tests for every status value + non-numbers. |
| `lib/audit-log.cjs` (NEW) | `createAuditLogger(outboxDir) → auditEvent(event, extras)` that appends `{ts, event, ...extras}\n` to `<outboxDir>/audit.jsonl`. try/catch swallow write errors (log to stderr once). |
| `test/audit-log.test.cjs` (NEW) | Unit tests: line format, ts auto-injection, append semantics, write-error tolerance. |
| `lib/outbox-reconciler.cjs` (MODIFY) | Extend `reconcileOutboxFile` signature with `erroredIds`. Add errored-precedence branch. Extend `createOutboxReconciler` to accept `erroredIds`, `auditEvent`, `registerMsgIds`, `unregisterFile` (all optional). Emit `send`/`retry`/`quarantine` audit events; call register/unregister around `sendState` mutations. |
| `test/outbox-reconciler.test.cjs` (MODIFY) | Add unit tests for errored-precedence decision branch + factory tick that quarantines on errored set. |
| `test/outbox-integration.test.cjs` (MODIFY) | Add scenarios F (status=0 quarantine), G (server_ack without delivery_ack → resend), H (audit log format), I (unattributed late ack). |
| `gateway.cjs` (MODIFY) | Add `outboxErroredIds` Set + `markErrored(id)` with TTL. Add `msgIdToFilename` Map + `registerMsgIds` / `unregisterFile` callbacks. Rewrite `messages.update` listener through `ack-dispatcher`. Create per-dir audit logger in `reconcilerFor`. Bump `stalenessMs` 5000→15000, `maxRetries` 5→3. |

---

## Task 1: reconcileOutboxFile — errored-precedence branch

**Files:**
- Modify: `lib/outbox-reconciler.cjs`
- Modify: `test/outbox-reconciler.test.cjs`

### Context

The current `reconcileOutboxFile` has six decision branches (delete, send, quarantine-retries, quarantine-age, resend, wait) in that precedence order. We add one new branch at the top: if any tracked `msgId` is in `erroredIds`, quarantine immediately. Everything else stays identical.

### Steps

- [ ] **Step 1: Add failing tests for errored precedence**

Append to `test/outbox-reconciler.test.cjs` (after the existing `test("delete requires at least one msgId tracked...")` block, before the `const fs = ...` line):

```js
test("quarantine when any msgId is in erroredIds", () => {
  const action = r.reconcileOutboxFile({
    sendState: {
      msgIds: new Set(["A", "B"]),
      firstSentAt: 500, lastSentAt: 600, attempts: 1,
    },
    ackedIds: new Set(),
    erroredIds: new Set(["B"]),
    now: 1000, stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  assert.equal(action.kind, "quarantine");
  assert.match(action.reason, /error/);
});

test("errored beats delivered (both sets match) — quarantine wins", () => {
  const action = r.reconcileOutboxFile({
    sendState: {
      msgIds: new Set(["A"]),
      firstSentAt: 500, lastSentAt: 600, attempts: 1,
    },
    ackedIds: new Set(["A"]),
    erroredIds: new Set(["A"]),
    now: 1000, stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  assert.equal(action.kind, "quarantine");
  assert.match(action.reason, /error/);
});

test("erroredIds entries for other files do not trigger (intersection is empty)", () => {
  const action = r.reconcileOutboxFile({
    sendState: {
      msgIds: new Set(["A"]),
      firstSentAt: 500, lastSentAt: 600, attempts: 1,
    },
    ackedIds: new Set(),
    erroredIds: new Set(["X", "Y"]),
    now: 1000, stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  assert.equal(action.kind, "wait");
});

test("erroredIds omitted (undefined) is safe — treated as empty", () => {
  const action = r.reconcileOutboxFile({
    sendState: {
      msgIds: new Set(["A"]),
      firstSentAt: 500, lastSentAt: 600, attempts: 1,
    },
    ackedIds: new Set(["A"]),
    now: 1000, stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  assert.equal(action.kind, "delete");
});
```

- [ ] **Step 2: Run tests — verify the four new ones fail**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/outbox-reconciler.test.cjs 2>&1 | tail -40`

Expected: 4 failures in the newly-added tests. The existing tests still pass (backward compat).

- [ ] **Step 3: Add the errored-precedence branch**

Edit `lib/outbox-reconciler.cjs`. Replace the function header and body of `reconcileOutboxFile` (lines 1-18):

```js
function reconcileOutboxFile({ sendState, ackedIds, erroredIds, now, stalenessMs, maxAgeMs, maxRetries }) {
  if (sendState && sendState.msgIds && sendState.msgIds.size > 0 && erroredIds) {
    for (const id of sendState.msgIds) {
      if (erroredIds.has(id)) return { kind: "quarantine", reason: "server error" };
    }
  }
  if (sendState && sendState.msgIds && sendState.msgIds.size > 0) {
    let allAcked = true;
    for (const id of sendState.msgIds) {
      if (!ackedIds.has(id)) { allAcked = false; break; }
    }
    if (allAcked) return { kind: "delete" };
  }
  if (!sendState) return { kind: "send" };
  if (sendState.attempts >= maxRetries) {
    return { kind: "quarantine", reason: "retries exhausted" };
  }
  if (now - sendState.firstSentAt > maxAgeMs) {
    return { kind: "quarantine", reason: "age exceeded" };
  }
  if (now - sendState.lastSentAt > stalenessMs) return { kind: "resend" };
  return { kind: "wait" };
}
```

- [ ] **Step 4: Run tests — all pass**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/outbox-reconciler.test.cjs 2>&1 | tail -20`

Expected: `pass N` (all tests pass, including the 4 new ones and all pre-existing ones).

- [ ] **Step 5: Commit**

```bash
cd /home/wp-fundraising/claude-code-whatsapp
git add lib/outbox-reconciler.cjs test/outbox-reconciler.test.cjs
git commit -m "$(cat <<'EOF'
feat(reconciler): errored-precedence branch for status=0 quarantine

New highest-precedence decision branch: any tracked msgId found in
erroredIds → quarantine with reason "server error". Sits above the
delivered/retries/age/stale checks so explicit server errors are
handled deterministically instead of silently retried.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: createOutboxReconciler — accept erroredIds + audit + register callbacks

**Files:**
- Modify: `lib/outbox-reconciler.cjs`
- Modify: `test/outbox-reconciler.test.cjs`

### Context

Factory needs four new (all optional) inputs: `erroredIds`, `auditEvent`, `registerMsgIds`, `unregisterFile`.
- `erroredIds`: Set<string>, passed through to the decision fn each tick.
- `auditEvent(event, extras)`: called with `("send", {filename, chat_id, msg_ids})`, `("retry", {filename, chat_id, attempts})`, `("quarantine", {filename, chat_id, reason})`.
- `registerMsgIds(filename, msgIds, chatId)`: called after a successful send, before `sendState.set`. Gateway uses it to populate its `msgId → {filename, chat_id, dir}` reverse index.
- `unregisterFile(filename)`: called whenever the reconciler removes `sendState` (delete branch or quarantine).

All four default to no-op if omitted — existing integration tests keep passing unchanged.

### Steps

- [ ] **Step 1: Add failing tests for the new factory behaviors**

Append to `test/outbox-reconciler.test.cjs` (at the end of file):

```js
test("factory tick: erroredIds triggers quarantine on next tick", async () => {
  const outboxDir = mkTmp("outbox-recon-");
  const fp = writeOutboxFile(outboxDir, "1000-a.json", { action: "reply", chat_id: "c", text: "hi" });
  const ackedIds = new Set();
  const erroredIds = new Set();
  const tick = r.createOutboxReconciler({
    outboxDir,
    sendFn: async () => ({ msgIds: ["ID-A"] }),
    ackedIds, erroredIds,
    now: () => 1000,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  await tick();
  assert.ok(fs.existsSync(fp), "file kept post-send");
  erroredIds.add("ID-A");
  await tick();
  assert.equal(fs.existsSync(fp), false, "original file removed");
  const failedPath = path.join(outboxDir, "failed", "1000-a.json");
  assert.ok(fs.existsSync(failedPath), "moved to failed/");
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("factory tick: auditEvent receives send/retry/quarantine events", async () => {
  const outboxDir = mkTmp("outbox-recon-");
  writeOutboxFile(outboxDir, "1000-a.json", { action: "reply", chat_id: "c", text: "hi" });
  const events = [];
  let clock = 1000;
  let call = 0;
  const tick = r.createOutboxReconciler({
    outboxDir,
    sendFn: async () => {
      call += 1;
      if (call === 1) return { msgIds: ["ID-A"] };
      throw new Error("boom");
    },
    ackedIds: new Set(),
    erroredIds: new Set(),
    now: () => clock,
    stalenessMs: 100, maxAgeMs: 10000, maxRetries: 2,
    auditEvent: (event, extras) => { events.push({ event, ...extras }); },
  });
  await tick();                    // send
  clock += 200; await tick();      // retry (stale, sendFn throws)
  clock += 200; await tick();      // retries exhausted → quarantine
  const kinds = events.map((e) => e.event);
  assert.deepEqual(kinds, ["send", "retry", "quarantine"]);
  assert.equal(events[0].filename, "1000-a.json");
  assert.deepEqual(events[0].msg_ids, ["ID-A"]);
  assert.equal(events[0].chat_id, "c");
  assert.equal(events[2].reason, "retries exhausted");
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("factory tick: registerMsgIds + unregisterFile called at boundaries", async () => {
  const outboxDir = mkTmp("outbox-recon-");
  writeOutboxFile(outboxDir, "1000-a.json", { action: "reply", chat_id: "c", text: "hi" });
  const registered = [];
  const unregistered = [];
  const ackedIds = new Set();
  const tick = r.createOutboxReconciler({
    outboxDir,
    sendFn: async () => ({ msgIds: ["ID-A"] }),
    ackedIds,
    erroredIds: new Set(),
    now: () => 1000,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
    registerMsgIds: (filename, msgIds, chatId) => { registered.push({ filename, msgIds, chatId }); },
    unregisterFile: (filename) => { unregistered.push(filename); },
  });
  await tick();
  assert.deepEqual(registered, [{ filename: "1000-a.json", msgIds: ["ID-A"], chatId: "c" }]);
  assert.deepEqual(unregistered, []);
  ackedIds.add("ID-A");
  await tick();
  assert.deepEqual(unregistered, ["1000-a.json"], "unregister called on delete branch");
  fs.rmSync(outboxDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests — verify new tests fail**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/outbox-reconciler.test.cjs 2>&1 | tail -30`

Expected: 3 failures in new tests.

- [ ] **Step 3: Extend the factory**

Edit `lib/outbox-reconciler.cjs`. Replace the factory signature and body (lines 23-107):

```js
function createOutboxReconciler({
  outboxDir, sendFn,
  ackedIds, erroredIds,
  now, stalenessMs, maxAgeMs, maxRetries,
  auditEvent, registerMsgIds, unregisterFile,
  log,
}) {
  const failedDir = path.join(outboxDir, "failed");
  const sendState = new Map();
  const logFn = log || (() => {});
  const audit = auditEvent || (() => {});
  const register = registerMsgIds || (() => {});
  const unregister = unregisterFile || (() => {});
  const errored = erroredIds || new Set();

  function quarantine(filename, reason, chatId) {
    try {
      fs.mkdirSync(failedDir, { recursive: true });
      fs.renameSync(path.join(outboxDir, filename), path.join(failedDir, filename));
      audit("quarantine", { filename, chat_id: chatId, reason });
      unregister(filename);
      sendState.delete(filename);
      logFn(`outbox quarantined ${filename}: ${reason}`);
    } catch (e) {
      logFn(`outbox quarantine failed for ${filename}: ${e.message}`);
      // Intentionally retain sendState so the next tick re-enters quarantine
      // rather than resetting to a fresh send cycle.
    }
  }

  async function attemptSend(filename, data, isRetry) {
    const t = now();
    const prev = sendState.get(filename);
    const nextAttempts = (prev?.attempts || 0) + 1;
    const firstSentAt = prev?.firstSentAt || t;
    if (isRetry) audit("retry", { filename, chat_id: data.chat_id, attempts: nextAttempts });
    let result;
    try {
      result = await sendFn(data);
    } catch (e) {
      logFn(`outbox send failed for ${filename}: ${e.message}`);
      sendState.set(filename, {
        msgIds: prev?.msgIds || new Set(),
        firstSentAt, lastSentAt: t, attempts: nextAttempts,
      });
      return;
    }
    if (result && result.fireAndForget === true) {
      try { fs.unlinkSync(path.join(outboxDir, filename)); } catch {}
      unregister(filename);
      sendState.delete(filename);
      return;
    }
    const newIds = Array.from(result?.msgIds || []);
    const msgIds = new Set(prev?.msgIds || []);
    for (const id of newIds) msgIds.add(id);
    sendState.set(filename, { msgIds, firstSentAt, lastSentAt: t, attempts: nextAttempts });
    if (newIds.length > 0) {
      register(filename, newIds, data.chat_id);
      audit("send", { filename, chat_id: data.chat_id, msg_ids: newIds });
    }
    if (msgIds.size > 0) {
      let allAcked = true;
      for (const id of msgIds) if (!ackedIds.has(id)) { allAcked = false; break; }
      if (allAcked) {
        try { fs.unlinkSync(path.join(outboxDir, filename)); } catch {}
        unregister(filename);
        sendState.delete(filename);
      }
    }
  }

  return async function tick() {
    let files;
    try {
      files = fs.readdirSync(outboxDir).filter((f) => f.endsWith(".json")).sort();
    } catch { return; }

    for (const filename of files) {
      const fp = path.join(outboxDir, filename);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(fp, "utf8"));
      } catch (e) {
        logFn(`outbox malformed JSON ${filename}: ${e.message}`);
        quarantine(filename, "malformed json", undefined);
        continue;
      }
      const action = reconcileOutboxFile({
        sendState: sendState.get(filename) || null,
        ackedIds, erroredIds: errored,
        now: now(),
        stalenessMs, maxAgeMs, maxRetries,
      });
      if (action.kind === "delete") {
        try { fs.unlinkSync(fp); } catch {}
        unregister(filename);
        sendState.delete(filename);
      } else if (action.kind === "send") {
        await attemptSend(filename, data, false);
      } else if (action.kind === "resend") {
        await attemptSend(filename, data, true);
      } else if (action.kind === "quarantine") {
        quarantine(filename, action.reason, data.chat_id);
      }
    }
  };
}
```

- [ ] **Step 4: Run tests — all pass**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/outbox-reconciler.test.cjs 2>&1 | tail -20`

Expected: all tests pass, including the 3 new factory tests and all pre-existing ones.

- [ ] **Step 5: Run the integration tests to confirm backward compat**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/outbox-integration.test.cjs 2>&1 | tail -20`

Expected: all 5 existing integration scenarios still pass (A happy, B stale socket, C restart duplicate, D quarantine, E typing bypass).

- [ ] **Step 6: Commit**

```bash
cd /home/wp-fundraising/claude-code-whatsapp
git add lib/outbox-reconciler.cjs test/outbox-reconciler.test.cjs
git commit -m "$(cat <<'EOF'
feat(reconciler): erroredIds + audit/register/unregister callbacks

Factory now accepts erroredIds Set (passed through to decision fn) and
three optional callbacks: auditEvent(event, extras), registerMsgIds,
unregisterFile. Emits send/retry/quarantine audit events at the right
boundaries. All callbacks default to no-op so existing call sites keep
working. Integration tests unchanged; unit tests cover the new paths.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: ack-dispatcher — pure status→action helper

**Files:**
- Create: `lib/ack-dispatcher.cjs`
- Create: `test/ack-dispatcher.test.cjs`

### Context

A trivial pure function. Given a Baileys `status` code (number or nonsense), returns `{ event, target }`:

| status | event | target |
|---|---|---|
| 0 | `"error"` | `"errored"` |
| 1 | null (PENDING, ignore) | null |
| 2 | `"server_ack"` | null (no state change, informational) |
| 3 | `"delivery_ack"` | `"acked"` |
| 4 | `"read"` | `"acked"` (READ implies delivered) |
| 5 | `"played"` | `"acked"` (PLAYED implies delivered) |
| anything else (NaN, undefined, negative) | null | null |

Caller is responsible for the side effect (appending audit line, mutating the Set).

### Steps

- [ ] **Step 1: Write the failing tests**

Create `test/ack-dispatcher.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { dispatchAck } = require("../lib/ack-dispatcher.cjs");

test("status 0 → error + errored", () => {
  assert.deepEqual(dispatchAck(0), { event: "error", target: "errored" });
});

test("status 1 (PENDING) → no-op", () => {
  assert.deepEqual(dispatchAck(1), { event: null, target: null });
});

test("status 2 (SERVER_ACK) → server_ack event, no state target", () => {
  assert.deepEqual(dispatchAck(2), { event: "server_ack", target: null });
});

test("status 3 (DELIVERY_ACK) → delivery_ack + acked", () => {
  assert.deepEqual(dispatchAck(3), { event: "delivery_ack", target: "acked" });
});

test("status 4 (READ) → read + acked (READ implies delivered)", () => {
  assert.deepEqual(dispatchAck(4), { event: "read", target: "acked" });
});

test("status 5 (PLAYED) → played + acked", () => {
  assert.deepEqual(dispatchAck(5), { event: "played", target: "acked" });
});

test("non-number → no-op", () => {
  assert.deepEqual(dispatchAck(undefined), { event: null, target: null });
  assert.deepEqual(dispatchAck(null), { event: null, target: null });
  assert.deepEqual(dispatchAck("3"), { event: null, target: null });
  assert.deepEqual(dispatchAck(NaN), { event: null, target: null });
});

test("negative / unknown number → no-op", () => {
  assert.deepEqual(dispatchAck(-1), { event: null, target: null });
  assert.deepEqual(dispatchAck(99), { event: null, target: null });
});
```

- [ ] **Step 2: Run tests — verify they all fail**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/ack-dispatcher.test.cjs 2>&1 | tail -20`

Expected: `MODULE_NOT_FOUND` or all failures (module doesn't exist yet).

- [ ] **Step 3: Implement the module**

Create `lib/ack-dispatcher.cjs`:

```js
function dispatchAck(status) {
  if (typeof status !== "number" || Number.isNaN(status)) return { event: null, target: null };
  switch (status) {
    case 0: return { event: "error",        target: "errored" };
    case 1: return { event: null,           target: null };
    case 2: return { event: "server_ack",   target: null };
    case 3: return { event: "delivery_ack", target: "acked" };
    case 4: return { event: "read",         target: "acked" };
    case 5: return { event: "played",       target: "acked" };
    default: return { event: null, target: null };
  }
}

module.exports = { dispatchAck };
```

- [ ] **Step 4: Run tests — all pass**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/ack-dispatcher.test.cjs 2>&1 | tail -20`

Expected: `pass 8`.

- [ ] **Step 5: Commit**

```bash
cd /home/wp-fundraising/claude-code-whatsapp
git add lib/ack-dispatcher.cjs test/ack-dispatcher.test.cjs
git commit -m "$(cat <<'EOF'
feat(ack-dispatcher): pure status→action helper for messages.update

Maps Baileys status codes to {event, target}: 0→error/errored,
2→server_ack/null, 3→delivery_ack/acked, 4→read/acked, 5→played/acked,
everything else → null/null. Caller owns the side effect so the mapping
is trivially testable in isolation.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: audit-log — append-JSONL writer

**Files:**
- Create: `lib/audit-log.cjs`
- Create: `test/audit-log.test.cjs`

### Context

Tiny factory that returns an `auditEvent(event, extras)` function. Each call writes `{ts: Date.now(), event, ...extras}\n` to `<outboxDir>/audit.jsonl` via `fs.appendFileSync`. Errors are caught and logged to stderr once (don't spam, don't throw — reconciler must not crash because disk filled up).

The factory receives a `now` function (defaults to `Date.now`) for testability.

### Steps

- [ ] **Step 1: Write the failing tests**

Create `test/audit-log.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createAuditLogger } = require("../lib/audit-log.cjs");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("auditEvent appends a JSONL line with ts + event + extras", () => {
  const dir = mkTmp("audit-");
  const audit = createAuditLogger({ outboxDir: dir, now: () => 1744700000000 });
  audit("send", { filename: "a.json", chat_id: "c", msg_ids: ["X"] });
  const content = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 1);
  const obj = JSON.parse(lines[0]);
  assert.equal(obj.ts, 1744700000000);
  assert.equal(obj.event, "send");
  assert.equal(obj.filename, "a.json");
  assert.equal(obj.chat_id, "c");
  assert.deepEqual(obj.msg_ids, ["X"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auditEvent appends multiple lines in order", () => {
  const dir = mkTmp("audit-");
  let t = 1000;
  const audit = createAuditLogger({ outboxDir: dir, now: () => t });
  audit("send", { filename: "a" }); t += 10;
  audit("server_ack", { msg_id: "X" }); t += 10;
  audit("delivery_ack", { msg_id: "X" });
  const lines = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).event, "send");
  assert.equal(JSON.parse(lines[1]).event, "server_ack");
  assert.equal(JSON.parse(lines[2]).event, "delivery_ack");
  assert.equal(JSON.parse(lines[0]).ts, 1000);
  assert.equal(JSON.parse(lines[2]).ts, 1020);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auditEvent tolerates write errors without throwing", () => {
  const dir = mkTmp("audit-");
  const audit = createAuditLogger({ outboxDir: dir, now: () => 1000 });
  // Make the dir unwritable by removing it after the logger is created.
  fs.rmSync(dir, { recursive: true, force: true });
  let threw = false;
  try { audit("send", { filename: "a" }); } catch { threw = true; }
  assert.equal(threw, false, "auditEvent must not propagate write errors");
});

test("auditEvent omits extras that are undefined", () => {
  const dir = mkTmp("audit-");
  const audit = createAuditLogger({ outboxDir: dir, now: () => 1000 });
  audit("error", { msg_id: "X", filename: undefined, chat_id: undefined });
  const obj = JSON.parse(fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim());
  assert.equal(obj.msg_id, "X");
  assert.equal("filename" in obj, false, "undefined extras excluded");
  assert.equal("chat_id" in obj, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/audit-log.test.cjs 2>&1 | tail -20`

Expected: `MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the module**

Create `lib/audit-log.cjs`:

```js
const fs = require("node:fs");
const path = require("node:path");

function createAuditLogger({ outboxDir, now, log }) {
  const clock = now || (() => Date.now());
  const logFn = log || (() => {});
  const logPath = path.join(outboxDir, "audit.jsonl");
  let warned = false;
  return function auditEvent(event, extras) {
    const entry = { ts: clock(), event };
    if (extras && typeof extras === "object") {
      for (const [k, v] of Object.entries(extras)) {
        if (v !== undefined) entry[k] = v;
      }
    }
    try {
      fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
    } catch (e) {
      if (!warned) {
        warned = true;
        logFn(`audit log write failed for ${logPath}: ${e.message}`);
      }
    }
  };
}

module.exports = { createAuditLogger };
```

- [ ] **Step 4: Run tests — all pass**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/audit-log.test.cjs 2>&1 | tail -20`

Expected: `pass 4`.

- [ ] **Step 5: Commit**

```bash
cd /home/wp-fundraising/claude-code-whatsapp
git add lib/audit-log.cjs test/audit-log.test.cjs
git commit -m "$(cat <<'EOF'
feat(audit-log): per-dir append-JSONL audit logger

createAuditLogger({outboxDir, now, log}) returns auditEvent(event,
extras) that appends {ts, event, ...extras}\n to audit.jsonl. Swallows
write errors (warns once) so reconciler keeps ticking if disk fills.
Undefined extras are excluded from the serialized line.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: gateway.cjs — wire errored set, audit logger, and ack-dispatcher

**Files:**
- Modify: `gateway.cjs`

### Context

Five changes in one commit (the pieces all have to move together to leave gateway coherent):

1. **New state**: `outboxErroredIds` Set + `markErrored(id)` helper with 60 s TTL, sibling to existing `outboxAckedIds` and `markAcked(id)`.
2. **Reverse index**: `msgIdToFilename` — `Map<msgId, {filename, chatId, dir}>`. Two helpers: `registerMsgIds(dir, filename, msgIds, chatId)` and `unregisterFile(filename)` that purges every msgId for a given filename. **Caveat:** filename is shared across dirs only if the same timestamp+suffix collides in the global outbox and a user outbox — unlikely given `<ts>-<uid>` naming, but we key the Map value by `{dir, filename}` to stay safe.
3. **Listener rewrite**: the main `messages.update` handler at `gateway.cjs:1000` goes through `dispatchAck`. On `target === "acked"` we `markAcked(id)`; on `target === "errored"` we `markErrored(id)`. On any non-null `event` we look up the reverse index and call the matching dir's audit logger.
4. **Per-dir audit loggers**: `reconcilerFor(dir, sendFn)` creates (and caches) one `auditEvent` per dir. Stored in a module-level `Map<dir, auditEvent>` so the listener can reach it.
5. **Tuning**: `stalenessMs` 5000 → 15000, `maxRetries` 5 → 3. `maxAgeMs` stays 5 min.

### Steps

- [ ] **Step 1: Add erroredIds state + markErrored**

Find the block that starts with `const outboxAckedIds = new Set();` (around `gateway.cjs:68`). Immediately after the existing `markAcked` function (ends around line 75), add:

```js
const outboxErroredIds = new Set();
function markErrored(id) {
  if (!id || typeof id !== "string") return;
  outboxErroredIds.add(id);
  setTimeout(() => outboxErroredIds.delete(id), OUTBOX_ACKED_TTL_MS);
}

// msgId → {filename, chatId, dir} — purged by unregisterFile on sendState removal.
const msgIdToFilename = new Map();
function registerMsgIds(dir, filename, msgIds, chatId) {
  for (const id of (msgIds || [])) {
    if (typeof id !== "string") continue;
    msgIdToFilename.set(id, { filename, chatId, dir });
  }
}
function unregisterFile(dir, filename) {
  for (const [id, v] of msgIdToFilename) {
    if (v.dir === dir && v.filename === filename) msgIdToFilename.delete(id);
  }
}

// dir → auditEvent(event, extras)
const outboxAuditors = new Map();
```

- [ ] **Step 2: Add module imports at top**

Find the existing `const outboxReconciler = require("./lib/outbox-reconciler.cjs");` line. Add below it:

```js
const { dispatchAck } = require("./lib/ack-dispatcher.cjs");
const { createAuditLogger } = require("./lib/audit-log.cjs");
```

- [ ] **Step 3: Rewrite the `messages.update` listener**

Find the listener block at `gateway.cjs:1000` (starts with `sock.ev.on('messages.update', (updates) => {`). Replace the whole `sock.ev.on('messages.update', ...)` through its closing `});` (the FIRST one — there is a second one for poll handling around line 1362 that stays untouched) with:

```js
  sock.ev.on('messages.update', (updates) => {
    try {
      if (!Array.isArray(updates)) return;
      for (const u of updates) {
        if (!u?.key?.id || !u?.update) continue;
        if (u.key.fromMe !== true) continue;
        const { event, target } = dispatchAck(u.update.status);
        if (!event) continue;
        const attr = msgIdToFilename.get(u.key.id);
        const extras = { msg_id: u.key.id };
        if (attr) { extras.filename = attr.filename; extras.chat_id = attr.chatId; }
        const auditor = attr ? outboxAuditors.get(attr.dir) : null;
        if (auditor) auditor(event, extras);
        if (target === "acked") markAcked(u.key.id);
        else if (target === "errored") markErrored(u.key.id);
      }
    } catch (e) { log(`messages.update handler error: ${e}`); }
  });
```

(The audit write is conditional on attribution — unattributed acks are intentionally dropped because we have no dir to write them to. This is the spec's Scenario H trade-off; it's documented in §5.4. An alternative would be a global fallback audit log, but the spec decided against that for v1.)

- [ ] **Step 4: Rewrite `reconcilerFor` to wire audit + callbacks + tuning**

Replace the existing `reconcilerFor` function (around line 1483-1499) with:

```js
function reconcilerFor(dir, sendFn) {
  let r = outboxReconcilers.get(dir);
  if (!r) {
    const audit = createAuditLogger({ outboxDir: dir, log });
    outboxAuditors.set(dir, audit);
    r = outboxReconciler.createOutboxReconciler({
      outboxDir: dir,
      sendFn,
      ackedIds: outboxAckedIds,
      erroredIds: outboxErroredIds,
      now: () => Date.now(),
      stalenessMs: 15000,
      maxAgeMs: 5 * 60 * 1000,
      maxRetries: 3,
      auditEvent: audit,
      registerMsgIds: (filename, msgIds, chatId) => registerMsgIds(dir, filename, msgIds, chatId),
      unregisterFile: (filename) => unregisterFile(dir, filename),
      log,
    });
    outboxReconcilers.set(dir, r);
  }
  return r;
}
```

- [ ] **Step 5: Run existing test suites — verify still green**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npm test 2>&1 | tail -30`

Expected: all existing tests pass. Gateway isn't test-covered end-to-end (it's a running service), but the refactored modules (`outbox-reconciler`, `ack-dispatcher`, `audit-log`) have unit coverage from Tasks 1–4.

- [ ] **Step 6: Syntax-check the gateway**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && node --check gateway.cjs && echo OK`

Expected: `OK`.

- [ ] **Step 7: Commit**

```bash
cd /home/wp-fundraising/claude-code-whatsapp
git add gateway.cjs
git commit -m "$(cat <<'EOF'
feat(gateway): DELIVERY_ACK threshold + errored set + per-dir audit log

Wire the new reconciler callbacks and ack-dispatcher. messages.update
listener now: (a) treats status=3/4/5 as acked (was status>=2), (b)
treats status=0 as errored (new set, mirrors ackedIds with 60s TTL),
(c) emits per-event audit lines to <dir>/audit.jsonl via a per-dir
logger, attributed via a msgId→file reverse index.

Tuning: stalenessMs 5000→15000, maxRetries 5→3 to cap duplicate blast
radius on prolonged offline windows (worst case 4 dups in 45s → quarantine).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Integration tests — scenarios F, G, H, I

**Files:**
- Modify: `test/outbox-integration.test.cjs`

### Context

The existing integration harness uses a fake socket with `ackLast(ackedIds)`. We add an `errorLast(erroredIds)` helper and use it for Scenario F. The audit log tests exercise the `auditEvent` callback directly — the gateway's status→set translation is already unit-covered by `ack-dispatcher.test.cjs`, so we don't re-test it end-to-end.

### Steps

- [ ] **Step 1: Add failing tests**

Append to `test/outbox-integration.test.cjs` (end of file):

```js
test("integration F — status=0 path: errored set triggers quarantine + audit", async () => {
  const outboxDir = mkTmp("outbox-integ-");
  fs.writeFileSync(path.join(outboxDir, "1-a.json"),
    JSON.stringify({ action: "reply", chat_id: "c", text: "hello" }));

  const sock = makeFakeSock();
  const ackedIds = new Set();
  const erroredIds = new Set();
  const events = [];
  const tick = createOutboxReconciler({
    outboxDir,
    sendFn: makeSendFn(sock),
    ackedIds, erroredIds,
    now: () => 1000,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
    auditEvent: (event, extras) => events.push({ event, ...extras }),
  });

  await tick();
  assert.equal(sock.sent.length, 1);
  const sentId = sock.sent[0].id;
  erroredIds.add(sentId);
  await tick();

  const failedPath = path.join(outboxDir, "failed", "1-a.json");
  assert.ok(fs.existsSync(failedPath), "file moved to failed/");
  assert.equal(fs.existsSync(path.join(outboxDir, "1-a.json")), false);
  const kinds = events.map((e) => e.event);
  assert.deepEqual(kinds, ["send", "quarantine"]);
  assert.equal(events[1].reason, "server error");
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("integration G — server_ack without delivery_ack: resends, then delivery_ack unlinks", async () => {
  const outboxDir = mkTmp("outbox-integ-");
  fs.writeFileSync(path.join(outboxDir, "1-a.json"),
    JSON.stringify({ action: "reply", chat_id: "c", text: "hello" }));

  const sock = makeFakeSock();
  const ackedIds = new Set();       // <- this is the "delivery_ack" set in this test
  const events = [];
  let clock = 1000;
  const tick = createOutboxReconciler({
    outboxDir,
    sendFn: makeSendFn(sock),
    ackedIds,
    erroredIds: new Set(),
    now: () => clock,
    stalenessMs: 100, maxAgeMs: 300000, maxRetries: 5,
    auditEvent: (event, extras) => events.push({ event, ...extras }),
  });

  await tick();                         // first send
  assert.equal(sock.sent.length, 1);
  // Simulate "server_ack only" — no ackedIds mutation, no erroredIds mutation.
  clock += 500;                         // advance past stalenessMs=100
  await tick();                         // resend
  assert.equal(sock.sent.length, 2, "resend after staleness with no delivery ack");
  const secondId = sock.sent[1].id;

  ackedIds.add(secondId);               // now simulate DELIVERY_ACK for the resent msg
  clock += 50;
  await tick();
  assert.equal(fs.existsSync(path.join(outboxDir, "1-a.json")), false);
  const kinds = events.map((e) => e.event);
  assert.deepEqual(kinds, ["send", "retry", "send"]);
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("integration H — audit log JSONL format: send → delivery unlink", async () => {
  const outboxDir = mkTmp("outbox-integ-");
  fs.writeFileSync(path.join(outboxDir, "1-a.json"),
    JSON.stringify({ action: "reply", chat_id: "c", text: "hello" }));

  const { createAuditLogger } = require("../lib/audit-log.cjs");
  const sock = makeFakeSock();
  const ackedIds = new Set();
  let clock = 1000;
  const audit = createAuditLogger({ outboxDir, now: () => clock });
  const tick = createOutboxReconciler({
    outboxDir,
    sendFn: makeSendFn(sock),
    ackedIds,
    erroredIds: new Set(),
    now: () => clock,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
    auditEvent: audit,
  });

  await tick();
  clock += 1;
  // Simulate the gateway's listener audit-writing on delivery_ack:
  const sentId = sock.sent[0].id;
  audit("server_ack", { msg_id: sentId, filename: "1-a.json", chat_id: "c" });
  clock += 1;
  audit("delivery_ack", { msg_id: sentId, filename: "1-a.json", chat_id: "c" });
  ackedIds.add(sentId);
  clock += 1;
  await tick();

  const lines = fs.readFileSync(path.join(outboxDir, "audit.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse);
  const events = lines.map((l) => l.event);
  assert.deepEqual(events, ["send", "server_ack", "delivery_ack"]);
  assert.equal(lines[0].filename, "1-a.json");
  assert.deepEqual(lines[0].msg_ids, [sentId]);
  assert.equal(lines[1].msg_id, sentId);
  assert.equal(lines[2].msg_id, sentId);
  assert.ok(lines[0].ts < lines[1].ts && lines[1].ts < lines[2].ts, "ts monotonic");
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("integration I — unattributed late ack: audit writes with only msg_id, reconciler unaffected", async () => {
  const outboxDir = mkTmp("outbox-integ-");
  fs.writeFileSync(path.join(outboxDir, "1-a.json"),
    JSON.stringify({ action: "reply", chat_id: "c", text: "hello" }));

  const { createAuditLogger } = require("../lib/audit-log.cjs");
  const sock = makeFakeSock();
  const ackedIds = new Set();
  const erroredIds = new Set();
  let clock = 1000;
  const audit = createAuditLogger({ outboxDir, now: () => clock });
  const tick = createOutboxReconciler({
    outboxDir,
    sendFn: makeSendFn(sock),
    ackedIds, erroredIds,
    now: () => clock,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
    auditEvent: audit,
  });

  // Send, deliver, unlink.
  await tick();
  const sentId = sock.sent[0].id;
  ackedIds.add(sentId);
  clock += 10;
  await tick();
  assert.equal(fs.existsSync(path.join(outboxDir, "1-a.json")), false, "file unlinked");

  // Now simulate a late status=0 ack for the same id (post-delete).
  // Gateway's listener would write audit with only msg_id (no reverse index).
  clock += 100;
  audit("error", { msg_id: sentId });  // no filename/chat_id
  erroredIds.add(sentId);               // even if set populated, no sendState to trigger quarantine

  // Next tick must be a no-op for this file (already gone) and must not spawn new state.
  await tick();
  assert.equal(sock.sent.length, 1, "no new sends");

  const lines = fs.readFileSync(path.join(outboxDir, "audit.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse);
  const errLine = lines.find((l) => l.event === "error");
  assert.ok(errLine, "error line present");
  assert.equal(errLine.msg_id, sentId);
  assert.equal("filename" in errLine, false, "unattributed — filename omitted");
  assert.equal("chat_id" in errLine, false, "unattributed — chat_id omitted");
  fs.rmSync(outboxDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests — verify new ones fail**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/outbox-integration.test.cjs 2>&1 | tail -30`

Expected: the 4 new scenarios (F, G, H, I) may pass already because the reconciler changes in Tasks 1–2 already support them. If they all pass, skip to Step 4. If any fail, investigate — the reconciler implementation is the source of truth; tests should match the semantics of Tasks 1–2.

(Design note: unlike a strict TDD flow, the reconciler's new semantics landed in Task 2 with its own unit tests. Integration tests here are end-to-end sanity checks; they shouldn't fail unless something about the higher-level flow is wrong. If they do fail, re-read the failing assertion and check whether the reconciler needs adjustment or the test expectation was wrong.)

- [ ] **Step 3: Fix any failures**

If tests fail, read the error messages and either adjust the reconciler (making sure unit tests still pass) or correct test expectations. Do not paper over — every failure here is signal.

- [ ] **Step 4: All tests green**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npm test 2>&1 | tail -10`

Expected: `# pass` count includes all pre-existing tests plus 4 new ones. No failures.

- [ ] **Step 5: Commit**

```bash
cd /home/wp-fundraising/claude-code-whatsapp
git add test/outbox-integration.test.cjs
git commit -m "$(cat <<'EOF'
test(outbox): integration scenarios F-I for delivery reliability

F: status=0 → immediate quarantine + audit.
G: server_ack without delivery_ack → resend, then delivery_ack unlinks.
H: audit log JSONL format + event ordering (send→server_ack→delivery_ack).
I: unattributed late ack writes audit line with only msg_id and does
   not resurrect state for an already-deleted file.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Smoke test + restart gateway

**Files:** none (operational)

### Context

After code lands, verify on the running gateway:
1. A real reply delivers end-to-end and writes the expected 3-line audit trace.
2. `outbox/failed/` is not populated (no false-positive quarantines).
3. The reconciler doesn't spin CPU on startup (staleness math is right).

Gateway is managed by `pm2` / `systemd` / `cc-watchdog` depending on host. The user's channel uses whatever pattern is already shipping — follow the same restart flow as the prior `cfdb30d` outbox fix.

### Steps

- [ ] **Step 1: Confirm git log is clean and linear**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && git log --oneline -10`

Expected: the last six commits are the six from Tasks 1–6, in order, on top of `cfdb30d` / `0c31d02` (spec commit).

- [ ] **Step 2: Push**

```bash
cd /home/wp-fundraising/claude-code-whatsapp && git push origin main
```

Expected: push succeeds without hook errors.

- [ ] **Step 3: Restart gateway**

Check the current restart command in the channel ops (look for prior `cfdb30d` restart). Run the same thing. Common options:

- If pm2: `pm2 restart gateway`
- If systemd: `sudo systemctl restart claude-code-whatsapp`
- If cc-watchdog only: kill the gateway pid; cc-watchdog respawns

Do NOT guess — read `/home/wp-fundraising/claude-code-whatsapp/README.md` or `package.json` scripts for the canonical command. Ask the admin if uncertain.

- [ ] **Step 4: Verify smoke**

Send a test message from the admin's WhatsApp to the bot. Observe:
- Reply arrives on WhatsApp (confirms the happy path still works).
- `tail -n 20 <IPC_BASE>/users/<uid>/outbox/audit.jsonl` shows exactly: one `send`, one `server_ack`, one `delivery_ack`. In that order. Within a few hundred ms.

Also:
- `ls <IPC_BASE>/users/<uid>/outbox/failed/ 2>/dev/null | wc -l` is 0 or only pre-existing entries.
- `ls <IPC_BASE>/users/<uid>/outbox/*.json 2>/dev/null | wc -l` returns 0 after a couple seconds (all files unlinked post-delivery).

- [ ] **Step 5: Report to admin**

If smoke passes, message the admin that the fix is live, and point them at the audit log location so they can tail it next time anything feels off. If smoke fails, do NOT silence it — capture the audit log + gateway stderr and revert by deploying `cfdb30d` (or the prior HEAD).

---

## Appendix A — Rollback

If Task 7 smoke fails and we need to revert fast:

```bash
cd /home/wp-fundraising/claude-code-whatsapp
git revert --no-edit <sha-task-6>..<sha-task-1>
git push origin main
# restart gateway
```

The reconciler's pre-Task-1 behavior is preserved by reverting: existing callers that didn't pass `erroredIds` / callbacks still work because all new params are optional. The audit log stops being written (new files gone) — no data corruption risk.

## Appendix B — Tuning knobs post-ship

If real-world data from `audit.jsonl` shows:

- **Too many `retry` events for normal network hiccups** → bump `stalenessMs` further (15000 → 30000).
- **Persistent `delivery_ack` lag** (>2 s typical) → investigate Baileys socket health separately; not a reconciler issue.
- **Frequent `error` quarantines for benign content** → investigate whether a retry-once policy is warranted for specific error subtypes (Baileys doesn't expose structured error reasons in `messages.update`, but the global `presence.update` or `connection.update` stream may).

None of these are ship-blockers — they're feedback loops the audit log enables.
