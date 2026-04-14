# Outbox Redelivery with Baileys-Ack Confirmation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop silent loss of outbound WhatsApp messages. Gateway keeps each outbox file until Baileys confirms `SERVER_ACK` for every `msg.key.id` produced from that file; retries stalled sends; quarantines after retry/age exhaustion.

**Architecture:** One new CommonJS module `lib/outbox-reconciler.cjs` with a pure decision fn + a stateful factory that takes a send callback by injection. `gateway.cjs` gets a `messages.update` ack listener attached once on socket creation, plus a rewrite of the outbox poll loop that delegates per-outbox-dir to a reconciler instance. Fire-and-forget actions (typing indicators, download) bypass the reconciler.

**Tech Stack:** Node.js (CommonJS, `.cjs`), `node:test` (already wired via `npm test`), Baileys v7.0.0-rc.9 (existing dep). No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-14-outbox-redelivery-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/outbox-reconciler.cjs` (NEW) | Pure decision fn (`reconcileOutboxFile`) and stateful factory (`createOutboxReconciler`). Schema-agnostic — takes a `sendFn(data)` by injection that returns `{msgIds}` or `{fireAndForget: true}`. |
| `test/outbox-reconciler.test.cjs` (NEW) | Unit tests for decision fn + factory tick |
| `test/outbox-integration.test.cjs` (NEW) | Integration test with a fake Baileys socket. Covers happy path, stale-socket retry, gateway-restart duplicate, and quarantine. |
| `gateway.cjs` (MODIFY) | Attach `messages.update` listener to `sock.ev` once. Replace the outbox poll loop (lines 1380-1427) with delegation to `createOutboxReconciler` per outbox directory. Separate schema-aware `sendFn` for global OTP outbox vs. per-user outbox. |

---

## Task 1: reconcileOutboxFile — pure decision fn

**Files:**
- Create: `lib/outbox-reconciler.cjs`
- Create: `test/outbox-reconciler.test.cjs`

- [ ] **Step 1: Write the failing tests**

Create `test/outbox-reconciler.test.cjs`:
```js
const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("../lib/outbox-reconciler.cjs");

test("send when sendState is null (never sent)", () => {
  const action = r.reconcileOutboxFile({
    sendState: null, ackedIds: new Set(), now: 1000,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  assert.equal(action.kind, "send");
});

test("delete when every tracked msgId is acked", () => {
  const action = r.reconcileOutboxFile({
    sendState: {
      msgIds: new Set(["A", "B"]),
      firstSentAt: 500, lastSentAt: 600, attempts: 1,
    },
    ackedIds: new Set(["A", "B"]),
    now: 1000, stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  assert.equal(action.kind, "delete");
});

test("wait when some msgIds acked but not all, and send is recent", () => {
  const action = r.reconcileOutboxFile({
    sendState: {
      msgIds: new Set(["A", "B"]),
      firstSentAt: 500, lastSentAt: 600, attempts: 1,
    },
    ackedIds: new Set(["A"]),
    now: 1000, stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  assert.equal(action.kind, "wait");
});

test("resend when no ack for any msgId and lastSentAt exceeds stalenessMs", () => {
  const action = r.reconcileOutboxFile({
    sendState: {
      msgIds: new Set(["A"]),
      firstSentAt: 500, lastSentAt: 500, attempts: 1,
    },
    ackedIds: new Set(),
    now: 6000, stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  assert.equal(action.kind, "resend");
});

test("wait when sendState exists but all tracked ids acked only partially and still in staleness window", () => {
  const action = r.reconcileOutboxFile({
    sendState: {
      msgIds: new Set(["A", "B"]),
      firstSentAt: 500, lastSentAt: 500, attempts: 1,
    },
    ackedIds: new Set(),
    now: 1000, stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  assert.equal(action.kind, "wait");
});

test("quarantine when attempts exhaust maxRetries", () => {
  const action = r.reconcileOutboxFile({
    sendState: {
      msgIds: new Set(["A"]),
      firstSentAt: 500, lastSentAt: 7000, attempts: 5,
    },
    ackedIds: new Set(),
    now: 13000, stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  assert.equal(action.kind, "quarantine");
  assert.match(action.reason, /retries/);
});

test("quarantine when firstSentAt age exceeds maxAgeMs", () => {
  const action = r.reconcileOutboxFile({
    sendState: {
      msgIds: new Set(["A"]),
      firstSentAt: 100, lastSentAt: 200, attempts: 2,
    },
    ackedIds: new Set(),
    now: 301000, stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  assert.equal(action.kind, "quarantine");
  assert.match(action.reason, /age/);
});

test("delete takes precedence over quarantine (late ack for exhausted-retry file)", () => {
  const action = r.reconcileOutboxFile({
    sendState: {
      msgIds: new Set(["A"]),
      firstSentAt: 500, lastSentAt: 7000, attempts: 5,
    },
    ackedIds: new Set(["A"]),
    now: 13000, stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  assert.equal(action.kind, "delete");
});

test("delete requires at least one msgId tracked (empty set = not delivered)", () => {
  const action = r.reconcileOutboxFile({
    sendState: {
      msgIds: new Set(),
      firstSentAt: 500, lastSentAt: 500, attempts: 1,
    },
    ackedIds: new Set(),
    now: 1000, stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  // Empty msgIds means we tried to send but got no msg.key.id back — treat as not delivered.
  // Wait (within staleness) or resend (past staleness).
  assert.equal(action.kind, "wait");
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npm test -- test/outbox-reconciler.test.cjs`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Write the implementation**

Create `lib/outbox-reconciler.cjs`:
```js
function reconcileOutboxFile({ sendState, ackedIds, now, stalenessMs, maxAgeMs, maxRetries }) {
  // Delivered: every tracked msgId is acked. Delete takes precedence over quarantine.
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

module.exports = { reconcileOutboxFile };
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npm test -- test/outbox-reconciler.test.cjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/outbox-reconciler.cjs test/outbox-reconciler.test.cjs
git commit -m "feat(gateway): add reconcileOutboxFile pure decision function"
```

---

## Task 2: createOutboxReconciler — stateful tick factory

**Files:**
- Modify: `lib/outbox-reconciler.cjs`
- Modify: `test/outbox-reconciler.test.cjs`

- [ ] **Step 1: Append failing tests**

Append to `test/outbox-reconciler.test.cjs`:
```js
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeOutboxFile(dir, filename, payload) {
  const fp = path.join(dir, filename);
  fs.writeFileSync(fp, JSON.stringify(payload));
  return fp;
}

test("tick: fresh file triggers sendFn, state recorded with msgIds", async () => {
  const outboxDir = mkTmp("outbox-recon-");
  const fp = writeOutboxFile(outboxDir, "1000-a.json", { action: "reply", chat_id: "c", text: "hi" });
  const ackedIds = new Set();
  const sends = [];
  const tick = r.createOutboxReconciler({
    outboxDir,
    sendFn: async (data) => { sends.push(data); return { msgIds: ["ID-A"] }; },
    ackedIds,
    now: () => 1000,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  await tick();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, "hi");
  assert.ok(fs.existsSync(fp), "file still present pre-ack");
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("tick: file unlinked once all msgIds are in ackedIds", async () => {
  const outboxDir = mkTmp("outbox-recon-");
  const fp = writeOutboxFile(outboxDir, "1000-a.json", { action: "reply", chat_id: "c", text: "hi" });
  const ackedIds = new Set();
  const tick = r.createOutboxReconciler({
    outboxDir,
    sendFn: async () => ({ msgIds: ["ID-A"] }),
    ackedIds,
    now: () => 1000,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  await tick();
  assert.ok(fs.existsSync(fp), "file still present pre-ack");
  ackedIds.add("ID-A");
  await tick();
  assert.equal(fs.existsSync(fp), false, "file unlinked after ack");
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("tick: ack arriving before sendState write (race) is handled via immediate post-send check", async () => {
  const outboxDir = mkTmp("outbox-recon-");
  const fp = writeOutboxFile(outboxDir, "1000-a.json", { action: "reply", chat_id: "c", text: "hi" });
  const ackedIds = new Set();
  const tick = r.createOutboxReconciler({
    outboxDir,
    sendFn: async () => {
      // Simulate ack firing during the await — ackedIds already contains the id
      // by the time sendFn returns.
      ackedIds.add("ID-A");
      return { msgIds: ["ID-A"] };
    },
    ackedIds,
    now: () => 1000,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  await tick();
  assert.equal(fs.existsSync(fp), false, "file unlinked immediately because ack already present");
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("tick: sendFn throws — file kept, state records attempt", async () => {
  const outboxDir = mkTmp("outbox-recon-");
  const fp = writeOutboxFile(outboxDir, "1000-a.json", { action: "reply", chat_id: "c", text: "hi" });
  let clock = 1000;
  let sendCalls = 0;
  const tick = r.createOutboxReconciler({
    outboxDir,
    sendFn: async () => { sendCalls += 1; throw new Error("Connection Closed"); },
    ackedIds: new Set(),
    now: () => clock,
    stalenessMs: 1000, maxAgeMs: 300000, maxRetries: 10,
  });
  await tick();
  assert.equal(sendCalls, 1);
  assert.ok(fs.existsSync(fp), "file kept after throw");
  clock = 3000; // past staleness window
  await tick();
  assert.equal(sendCalls, 2, "resend on staleness");
  assert.ok(fs.existsSync(fp));
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("tick: sendFn returning {fireAndForget: true} unlinks immediately (no tracking)", async () => {
  const outboxDir = mkTmp("outbox-recon-");
  const fp = writeOutboxFile(outboxDir, "1000-a.json", { action: "typing_start", chat_id: "c" });
  const tick = r.createOutboxReconciler({
    outboxDir,
    sendFn: async () => ({ fireAndForget: true }),
    ackedIds: new Set(),
    now: () => 1000,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  await tick();
  assert.equal(fs.existsSync(fp), false, "fire-and-forget file unlinked");
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("tick: quarantined files moved to outbox/failed/", async () => {
  const outboxDir = mkTmp("outbox-recon-");
  const fp = writeOutboxFile(outboxDir, "1000-a.json", { action: "reply", chat_id: "c", text: "hi" });
  let clock = 1000;
  const tick = r.createOutboxReconciler({
    outboxDir,
    sendFn: async () => { throw new Error("always fails"); },
    ackedIds: new Set(),
    now: () => clock,
    stalenessMs: 10, maxAgeMs: 10000, maxRetries: 3,
  });
  await tick();                     // send attempt 1
  clock += 20; await tick();        // resend -> attempt 2
  clock += 20; await tick();        // resend -> attempt 3
  clock += 20; await tick();        // quarantine (attempts >= maxRetries)
  assert.equal(fs.existsSync(fp), false, "original file moved");
  const failedDir = path.join(outboxDir, "failed");
  assert.ok(fs.existsSync(failedDir), "failed dir created");
  const files = fs.readdirSync(failedDir);
  assert.equal(files.length, 1, "one quarantined file");
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("tick: malformed JSON quarantined, not crashed", async () => {
  const outboxDir = mkTmp("outbox-recon-");
  fs.writeFileSync(path.join(outboxDir, "bad.json"), "{ not json");
  const tick = r.createOutboxReconciler({
    outboxDir,
    sendFn: async () => { throw new Error("should not be called"); },
    ackedIds: new Set(),
    now: () => 1000,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  await tick();
  const failedDir = path.join(outboxDir, "failed");
  assert.ok(fs.existsSync(failedDir));
  assert.deepEqual(fs.readdirSync(failedDir), ["bad.json"]);
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("tick: fresh reconciler redelivers un-acked file (simulates gateway restart)", async () => {
  const outboxDir = mkTmp("outbox-recon-");
  writeOutboxFile(outboxDir, "1000-a.json", { action: "reply", chat_id: "c", text: "hi" });

  // Phase 1: first reconciler sends
  const ackedIds = new Set();
  const sends1 = [];
  const tick1 = r.createOutboxReconciler({
    outboxDir,
    sendFn: async (data) => { sends1.push(data); return { msgIds: ["ID-1"] }; },
    ackedIds,
    now: () => 1000,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  await tick1();
  assert.equal(sends1.length, 1);

  // Phase 2: fresh reconciler (gateway restart) — no sendState — must redeliver
  const sends2 = [];
  const tick2 = r.createOutboxReconciler({
    outboxDir,
    sendFn: async (data) => { sends2.push(data); return { msgIds: ["ID-2"] }; },
    ackedIds,
    now: () => 2000,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  await tick2();
  assert.equal(sends2.length, 1, "fresh reconciler re-sends (the trade-off: possible duplicate)");
  fs.rmSync(outboxDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test -- test/outbox-reconciler.test.cjs`
Expected: FAIL — `createOutboxReconciler is not a function`.

- [ ] **Step 3: Append implementation**

Append to `lib/outbox-reconciler.cjs` (before `module.exports`):
```js
const fs = require("node:fs");
const path = require("node:path");

function createOutboxReconciler({ outboxDir, sendFn, ackedIds, now, stalenessMs, maxAgeMs, maxRetries, log }) {
  const failedDir = path.join(outboxDir, "failed");
  const sendState = new Map();
  const logFn = log || (() => {});

  function quarantine(filename, reason) {
    try {
      fs.mkdirSync(failedDir, { recursive: true });
      fs.renameSync(path.join(outboxDir, filename), path.join(failedDir, filename));
      sendState.delete(filename);
      logFn(`outbox quarantined ${filename}: ${reason}`);
    } catch (e) {
      logFn(`outbox quarantine failed for ${filename}: ${e.message}`);
    }
  }

  async function attemptSend(filename, data) {
    const t = now();
    const prev = sendState.get(filename);
    const nextAttempts = (prev?.attempts || 0) + 1;
    const firstSentAt = prev?.firstSentAt || t;
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
      // Don't track; unlink immediately.
      try { fs.unlinkSync(path.join(outboxDir, filename)); } catch {}
      sendState.delete(filename);
      return;
    }
    const msgIds = new Set(prev?.msgIds || []);
    for (const id of (result?.msgIds || [])) msgIds.add(id);
    sendState.set(filename, { msgIds, firstSentAt, lastSentAt: t, attempts: nextAttempts });
    // Check immediate-ack race: if every tracked id is already in ackedIds, unlink now.
    if (msgIds.size > 0) {
      let allAcked = true;
      for (const id of msgIds) if (!ackedIds.has(id)) { allAcked = false; break; }
      if (allAcked) {
        try { fs.unlinkSync(path.join(outboxDir, filename)); } catch {}
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
        quarantine(filename, "malformed json");
        continue;
      }
      const action = reconcileOutboxFile({
        sendState: sendState.get(filename) || null,
        ackedIds,
        now: now(),
        stalenessMs, maxAgeMs, maxRetries,
      });
      if (action.kind === "delete") {
        try { fs.unlinkSync(fp); } catch {}
        sendState.delete(filename);
      } else if (action.kind === "send" || action.kind === "resend") {
        await attemptSend(filename, data);
      } else if (action.kind === "quarantine") {
        quarantine(filename, action.reason);
      }
      // "wait" → no-op
    }
  };
}

module.exports = { reconcileOutboxFile, createOutboxReconciler };
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npm test -- test/outbox-reconciler.test.cjs`
Expected: PASS, 17 tests (9 from Task 1 + 8 new).

- [ ] **Step 5: Run full suite, confirm no regression**

Run: `npm test`
Expected: PASS, 57 prior + 17 new = 74, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add lib/outbox-reconciler.cjs test/outbox-reconciler.test.cjs
git commit -m "feat(gateway): add createOutboxReconciler tick factory with ack tracking"
```

---

## Task 3: Integration test with fake Baileys socket

**Files:**
- Create: `test/outbox-integration.test.cjs`

This test uses the REAL `outbox-reconciler` module + a fake Baileys socket object. The fake socket exposes `sendMessage` and an emit function for `messages.update`. Tests the four canonical scenarios end-to-end.

- [ ] **Step 1: Create the test file**

Create `test/outbox-integration.test.cjs`:
```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { createOutboxReconciler } = require("../lib/outbox-reconciler.cjs");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Tiny fake Baileys socket: exposes sendMessage (configurable impl) and an emit helper
// that publishes messages.update events into the caller-provided ackedIds set.
function makeFakeSock(opts = {}) {
  const sendResults = []; // [{jid, content, result, throws}]
  const sent = [];
  let nextId = 1;
  return {
    sent,
    async sendMessage(jid, content) {
      if (opts.throws) { const e = new Error(opts.throws); throw e; }
      const id = `M-${nextId++}`;
      sent.push({ jid, content, id });
      return { key: { id, remoteJid: jid, fromMe: true }, messageTimestamp: Date.now() };
    },
    // Helper to simulate server ack after N ms
    ackLast(ackedIds) { const last = sent[sent.length - 1]; if (last) ackedIds.add(last.id); },
    ackAll(ackedIds) { for (const s of sent) ackedIds.add(s.id); },
  };
}

// Build a sendFn that mirrors what the gateway will do: for a "reply" action,
// call sock.sendMessage and return {msgIds: [key.id]}.
function makeSendFn(sock) {
  return async function sendFn(data) {
    if (data.action === "typing_start" || data.action === "typing_stop") {
      return { fireAndForget: true };
    }
    if (data.action === "reply") {
      const msgIds = [];
      if (data.text) {
        const msg = await sock.sendMessage(data.chat_id, { text: data.text });
        if (msg?.key?.id) msgIds.push(msg.key.id);
      }
      return { msgIds };
    }
    return { msgIds: [] };
  };
}

test("integration A — happy path: tick sends, ack arrives, next tick unlinks", async () => {
  const outboxDir = mkTmp("outbox-integ-");
  fs.writeFileSync(path.join(outboxDir, "1-a.json"),
    JSON.stringify({ action: "reply", chat_id: "c", text: "hello" }));

  const sock = makeFakeSock();
  const ackedIds = new Set();
  const tick = createOutboxReconciler({
    outboxDir,
    sendFn: makeSendFn(sock),
    ackedIds,
    now: () => 1000,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });

  await tick();
  assert.equal(sock.sent.length, 1, "first tick sent");
  assert.ok(fs.existsSync(path.join(outboxDir, "1-a.json")), "file kept pre-ack");

  sock.ackLast(ackedIds);
  await tick();
  assert.equal(fs.existsSync(path.join(outboxDir, "1-a.json")), false, "file unlinked post-ack");
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("integration B — stale socket: first tick throws, socket recovers, eventual success", async () => {
  const outboxDir = mkTmp("outbox-integ-");
  fs.writeFileSync(path.join(outboxDir, "1-a.json"),
    JSON.stringify({ action: "reply", chat_id: "c", text: "hello" }));

  // Socket throws initially, then starts working
  let throwMode = true;
  const realSock = makeFakeSock();
  const sock = {
    sent: realSock.sent,
    async sendMessage(jid, content) {
      if (throwMode) throw new Error("Connection Closed");
      return realSock.sendMessage(jid, content);
    },
    ackLast: (s) => realSock.ackLast(s),
  };

  let clock = 1000;
  const ackedIds = new Set();
  const tick = createOutboxReconciler({
    outboxDir,
    sendFn: makeSendFn(sock),
    ackedIds,
    now: () => clock,
    stalenessMs: 100, maxAgeMs: 300000, maxRetries: 10,
  });

  await tick();                // attempt 1 (throws)
  assert.equal(sock.sent.length, 0);
  assert.ok(fs.existsSync(path.join(outboxDir, "1-a.json")), "file kept after throw");

  throwMode = false;           // "socket recovered"
  clock += 200;                // past stalenessMs
  await tick();                // attempt 2 (succeeds)
  assert.equal(sock.sent.length, 1);

  sock.ackLast(ackedIds);
  clock += 10;
  await tick();
  assert.equal(fs.existsSync(path.join(outboxDir, "1-a.json")), false);
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("integration C — gateway restart: fresh reconciler re-sends unacked file (accepted duplicate)", async () => {
  const outboxDir = mkTmp("outbox-integ-");
  fs.writeFileSync(path.join(outboxDir, "1-a.json"),
    JSON.stringify({ action: "reply", chat_id: "c", text: "hello" }));

  const ackedIds = new Set();
  const sock1 = makeFakeSock();
  const tick1 = createOutboxReconciler({
    outboxDir,
    sendFn: makeSendFn(sock1),
    ackedIds,
    now: () => 1000,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  await tick1();
  assert.equal(sock1.sent.length, 1, "first gateway sent once");

  // Simulate restart: discard tick1 state, create fresh reconciler with a new socket
  const sock2 = makeFakeSock();
  const tick2 = createOutboxReconciler({
    outboxDir,
    sendFn: makeSendFn(sock2),
    ackedIds,
    now: () => 2000,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  await tick2();
  assert.equal(sock2.sent.length, 1, "fresh gateway re-sent (the trade-off: visible duplicate)");
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("integration D — persistent failure quarantines after retries", async () => {
  const outboxDir = mkTmp("outbox-integ-");
  fs.writeFileSync(path.join(outboxDir, "1-a.json"),
    JSON.stringify({ action: "reply", chat_id: "c", text: "hello" }));

  const sock = {
    sent: [],
    async sendMessage() { throw new Error("always fails"); },
  };

  let clock = 1000;
  const tick = createOutboxReconciler({
    outboxDir,
    sendFn: makeSendFn(sock),
    ackedIds: new Set(),
    now: () => clock,
    stalenessMs: 10, maxAgeMs: 10000, maxRetries: 3,
  });
  await tick();
  clock += 20; await tick();
  clock += 20; await tick();
  clock += 20; await tick();  // quarantine

  assert.equal(fs.existsSync(path.join(outboxDir, "1-a.json")), false);
  const failed = path.join(outboxDir, "failed");
  assert.ok(fs.existsSync(failed));
  assert.equal(fs.readdirSync(failed).length, 1);
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("integration E — typing_start bypasses tracking (fireAndForget)", async () => {
  const outboxDir = mkTmp("outbox-integ-");
  fs.writeFileSync(path.join(outboxDir, "1-a.json"),
    JSON.stringify({ action: "typing_start", chat_id: "c" }));

  const sock = makeFakeSock();
  const tick = createOutboxReconciler({
    outboxDir,
    sendFn: makeSendFn(sock),
    ackedIds: new Set(),
    now: () => 1000,
    stalenessMs: 5000, maxAgeMs: 300000, maxRetries: 5,
  });
  await tick();
  // sendMessage never called (typing_start returns fireAndForget via makeSendFn)
  assert.equal(sock.sent.length, 0);
  assert.equal(fs.existsSync(path.join(outboxDir, "1-a.json")), false);
  fs.rmSync(outboxDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the integration tests**

Run: `npm test -- test/outbox-integration.test.cjs`
Expected: PASS, 5 tests.

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: PASS, 74 prior + 5 new = 79, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add test/outbox-integration.test.cjs
git commit -m "test(gateway): integration tests for outbox redelivery scenarios"
```

---

## Task 4: Wire the reconciler into gateway.cjs

**Files:**
- Modify: `gateway.cjs`

### Step 1 — Read the current gateway.cjs to confirm landmarks

Read `gateway.cjs`. Confirm the following approximate line numbers (they may have drifted since this plan was written):

- Requires block: near lines 1-35
- `log()` helper: line 64 (`process.stderr.write`)
- `sock.ev.on('connection.update', ...)` handler: search for `connection.update` (near line 930)
- `sock.ev.on('messages.upsert', ...)`: search for that (near line 993)
- Outbox poll setInterval: lines 1382-1427

- [ ] **Step 2: Add the require for the new module**

Locate the existing requires at the top of `gateway.cjs`. Add the following alongside them (group with other `./lib/...` requires if any exist; else just after the last top-level require):

```js
const outboxReconciler = require("./lib/outbox-reconciler.cjs");
```

- [ ] **Step 3: Add the module-level ackedIds set and a send-state-shared reference**

Just under the require block (before any function definition), add:

```js
// Outbox redelivery state (see docs/superpowers/specs/2026-04-14-outbox-redelivery-design.md)
const outboxAckedIds = new Set();
const OUTBOX_ACKED_TTL_MS = 60_000;

function markAcked(id) {
  if (!id || typeof id !== "string") return;
  outboxAckedIds.add(id);
  setTimeout(() => outboxAckedIds.delete(id), OUTBOX_ACKED_TTL_MS);
}
```

- [ ] **Step 4: Attach the messages.update listener**

Locate the existing `sock.ev.on('connection.update', ...)` block (around line 930). Immediately AFTER that `sock.ev.on(...)` call, add the following:

```js
sock.ev.on('messages.update', (updates) => {
  try {
    if (!Array.isArray(updates)) return;
    for (const u of updates) {
      if (!u || !u.key || !u.key.id) continue;
      if (u.key.fromMe !== true) continue; // only track our own sent messages
      const status = u.update && typeof u.update.status === "number" ? u.update.status : null;
      if (status !== null && status >= 2) markAcked(u.key.id);
    }
  } catch (e) { log(`messages.update handler error: ${e}`); }
});
```

The try/catch guards against any unexpected event shape from Baileys v7-rc.

- [ ] **Step 5: Replace the outbox poll body with reconciler delegation**

Locate the full `setInterval` block for the outbox processor (lines 1382-1427). Replace it ENTIRELY with the following:

```js
// ── Per-user outbox processor — redelivery-aware ────────────────────
// Each outbox directory gets its own reconciler instance (keeps sendState scoped).
// Gateway restart drops state; files are re-sent (possible duplicates — see spec §5.5).

const outboxReconcilers = new Map(); // dir -> reconciler tick fn

function sendFnGlobal(data) {
  // Schema: { jid, text }  (admin OTP outbox)
  if (!data || !data.jid || !data.text) return Promise.resolve({ fireAndForget: true });
  return sock.sendMessage(data.jid, { text: data.text }).then(
    (msg) => ({ msgIds: msg?.key?.id ? [msg.key.id] : [] }),
    (err) => { throw err; }
  );
}

function makeSendFnUser(uid) {
  return async function sendFnUser(data) {
    if (!data || !data.action) return { fireAndForget: true };
    userActivity.set(uid, Date.now());

    if (data.action === "typing_start") {
      try { sock.sendPresenceUpdate("composing", data.chat_id); } catch {}
      return { fireAndForget: true };
    }
    if (data.action === "typing_stop") {
      try { sock.sendPresenceUpdate("paused", data.chat_id); } catch {}
      return { fireAndForget: true };
    }
    if (data.action === "download") {
      // Local write only — no WhatsApp send; retries meaningless.
      const raw = rawMessages.get(data.message_id);
      if (raw?.message) {
        const media = extractMediaInfo(raw.message);
        if (media) {
          const buf = await downloadMediaMessage(raw, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const fn = media.filename || `${Date.now()}.${mimeToExt(media.mimetype)}`;
          fs.writeFileSync(path.join(USERS_DIR, uid, "downloads", `${data.message_id}-${fn}`), buf);
        }
      }
      return { fireAndForget: true };
    }
    if (data.action === "react") {
      const msg = await sock.sendMessage(data.chat_id, {
        react: { text: data.emoji, key: { remoteJid: data.chat_id, id: data.message_id } }
      });
      return { msgIds: msg?.key?.id ? [msg.key.id] : [] };
    }
    if (data.action === "reply") {
      const msgIds = [];
      if (data.text) {
        const q = data.reply_to ? rawMessages.get(data.reply_to) : undefined;
        const msg = await sock.sendMessage(data.chat_id, { text: data.text }, q ? { quoted: q } : undefined);
        if (msg?.key?.id) msgIds.push(msg.key.id);
      }
      for (const file of (data.files || [])) {
        const ext = path.extname(file).toLowerCase();
        const buf = fs.readFileSync(file);
        let msg;
        if ([".jpg",".jpeg",".png",".gif",".webp"].includes(ext)) {
          msg = await sock.sendMessage(data.chat_id, { image: buf });
        } else if ([".ogg",".mp3",".m4a",".wav"].includes(ext)) {
          msg = await sock.sendMessage(data.chat_id, { audio: buf, mimetype: ext === ".ogg" ? "audio/ogg; codecs=opus" : "audio/mpeg", ptt: ext === ".ogg" });
        } else if ([".mp4",".mov",".avi"].includes(ext)) {
          msg = await sock.sendMessage(data.chat_id, { video: buf });
        } else {
          msg = await sock.sendMessage(data.chat_id, { document: buf, mimetype: "application/octet-stream", fileName: path.basename(file) });
        }
        if (msg?.key?.id) msgIds.push(msg.key.id);
      }
      try { sock.sendPresenceUpdate("paused", data.chat_id); } catch {}
      return { msgIds };
    }
    // Unknown action — don't retry.
    log(`outbox: unknown action "${data.action}" for ${uid} — discarding`);
    return { fireAndForget: true };
  };
}

function reconcilerFor(dir, sendFn) {
  let r = outboxReconcilers.get(dir);
  if (!r) {
    r = outboxReconciler.createOutboxReconciler({
      outboxDir: dir,
      sendFn,
      ackedIds: outboxAckedIds,
      now: () => Date.now(),
      stalenessMs: 5000,
      maxAgeMs: 5 * 60 * 1000,
      maxRetries: 5,
      log,
    });
    outboxReconcilers.set(dir, r);
  }
  return r;
}

let outboxBusy = false;
setInterval(async () => {
  if (!sock || !connectionReady || outboxBusy) return;
  outboxBusy = true;
  try {
    // Global outbox (admin OTP)
    await reconcilerFor(OUTBOX_DIR, sendFnGlobal)();
    // Per-user outboxes
    for (const uid of (fs.readdirSync(USERS_DIR) || [])) {
      const odir = path.join(USERS_DIR, uid, "outbox");
      try { fs.accessSync(odir); } catch { continue; }
      await reconcilerFor(odir, makeSendFnUser(uid))();
    }
  } catch (e) { log(`outbox scan: ${e}`); }
  finally { outboxBusy = false; }
}, 1500);
```

Important: the `finally { outboxBusy = false; }` is critical — the old code set it to false INSIDE the try, which meant an uncaught throw would leave `outboxBusy = true` and freeze the poller. The new code uses `finally` to guarantee release.

- [ ] **Step 6: Syntax check**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && node --check gateway.cjs`
Expected: silent exit 0.

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: 79 pass, 0 fail. (Gateway isn't directly test-covered; we rely on syntax check + module tests + integration tests.)

- [ ] **Step 8: Commit**

```bash
git add gateway.cjs
git commit -m "$(cat <<'EOF'
feat(gateway): replace outbox unlink-before-await with ack-driven reconciler

Fixes silent drop of outbound WhatsApp messages. Gateway now keeps
each outbox file until every msg.key.id it produced reaches
SERVER_ACK (status >= 2) via messages.update. Retries stalled sends,
quarantines after retry/age exhaustion. Bypasses reconciler for
ephemeral actions (typing indicators, local download).

Covers both the global OTP outbox and the per-user outbox.
EOF
)"
```

---

## Task 5: Manual smoke test

**Files:** none (runtime check)

- [ ] **Step 1: Pick the user outbox to watch**

Run: `ls -la /home/wp-fundraising/.claude/channels/whatsapp-85294949291/users/204406284935400/outbox/`

Expected: empty (no stuck files).

- [ ] **Step 2: Verify gateway is running**

Run: `ps -ef | grep "gateway.cjs" | grep -v grep`

If a gateway process exists with the OLD code, the fix is not yet active — it needs a restart. Only proceed if the admin explicitly approves the restart (it disconnects the WhatsApp Web socket briefly). Otherwise, skip to Step 5 (post-deployment observation).

- [ ] **Step 3 (conditional — only if restart approved): Restart the gateway**

```bash
kill $(pgrep -f "node.*gateway.cjs")
```

Then verify new gateway came up (via whatever launch mechanism applies — if systemd: wait for restart; if nohup wrapper: relaunch manually).

- [ ] **Step 4: Send a test message through the live bridge**

Send a short WhatsApp message to the bridge. Confirm claude replies. Confirm the reply arrives on WhatsApp.

- [ ] **Step 5: Check for lingering outbox files**

After the conversation settles (~30s), run:
```bash
ls -la /home/wp-fundraising/.claude/channels/whatsapp-85294949291/users/204406284935400/outbox/ 2>/dev/null
ls -la /home/wp-fundraising/.claude/channels/whatsapp-85294949291/users/204406284935400/outbox/failed/ 2>/dev/null
```

Expected: outbox empty, failed dir either absent or empty. No retries should be needed in a normal round-trip.

- [ ] **Step 6: Simulated partial outage (optional)**

Drop a bad outbox file to confirm quarantine works:
```bash
echo '{ not json' > /home/wp-fundraising/.claude/channels/whatsapp-85294949291/users/204406284935400/outbox/manual-bad.json
```

Within ~2s, confirm:
```bash
ls /home/wp-fundraising/.claude/channels/whatsapp-85294949291/users/204406284935400/outbox/failed/
```

Expected: `manual-bad.json` present.

Clean up:
```bash
rm /home/wp-fundraising/.claude/channels/whatsapp-85294949291/users/204406284935400/outbox/failed/manual-bad.json
```

---

## Task 6: README note (optional)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Locate the Gateway / Architecture section in README**

Grep for "gateway" or "outbox" in README to find the right place.

- [ ] **Step 2: Add a short paragraph**

> The gateway retains each outbox file until Baileys confirms the produced WhatsApp message-id via the `messages.update` event (`status >= 2 = SERVER_ACK`), then dedups. This survives momentary WhatsApp Web socket blips. On gateway restart, unconfirmed files are re-sent, which may result in a rare visible duplicate — accepted trade-off vs. silent loss.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: note outbox redelivery/ack-confirm behavior"
```

---

## Done

Final test count: 79 passing (28 new: 17 reconciler + 5 integration, plus prior 57).

Every outbox file will end in one of exactly two states: unlinked after SERVER_ACK (delivered) or moved to `outbox/failed/` (quarantined after bounded retries). No silent drops. Gateway and bridge now have symmetric redelivery guarantees.
