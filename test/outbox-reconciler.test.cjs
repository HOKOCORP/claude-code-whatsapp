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
  assert.equal(action.kind, "wait");
});

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
  clock = 3000;
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
  await tick();
  clock += 20; await tick();
  clock += 20; await tick();
  clock += 20; await tick();
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

test("tick: file older than maxAgeMs is quarantined even within retry budget", async () => {
  const outboxDir = mkTmp("outbox-recon-");
  const fp = writeOutboxFile(outboxDir, "1000-old.json", { action: "reply", chat_id: "c", text: "hi" });
  let clock = 1000;
  const tick = r.createOutboxReconciler({
    outboxDir,
    sendFn: async () => { throw new Error("still broken"); },
    ackedIds: new Set(),
    now: () => clock,
    stalenessMs: 100, maxAgeMs: 500, maxRetries: 100,
  });
  await tick();                          // attempt 1 — throws, state recorded
  clock = 200; await tick();             // attempt 2 (past staleness) — throws
  clock = 1700; await tick();            // age exceeded → quarantine (firstSentAt=1000, now=1700, maxAge=500)

  assert.equal(fs.existsSync(fp), false, "file moved to failed/");
  const failed = path.join(outboxDir, "failed");
  assert.ok(fs.existsSync(failed));
  assert.deepEqual(fs.readdirSync(failed), ["1000-old.json"]);
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

test("tick: fresh reconciler redelivers un-acked file (simulates gateway restart)", async () => {
  const outboxDir = mkTmp("outbox-recon-");
  writeOutboxFile(outboxDir, "1000-a.json", { action: "reply", chat_id: "c", text: "hi" });

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
