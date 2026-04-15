const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { createOutboxReconciler } = require("../lib/outbox-reconciler.cjs");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeSock() {
  const sent = [];
  let nextId = 1;
  return {
    sent,
    async sendMessage(jid, content) {
      const id = `M-${nextId++}`;
      sent.push({ jid, content, id });
      return { key: { id, remoteJid: jid, fromMe: true }, messageTimestamp: Date.now() };
    },
    ackLast(ackedIds) { const last = sent[sent.length - 1]; if (last) ackedIds.add(last.id); },
  };
}

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

  await tick();
  assert.equal(sock.sent.length, 0, "stale socket: nothing sent");
  assert.ok(fs.existsSync(path.join(outboxDir, "1-a.json")), "file kept after throw");

  throwMode = false;
  clock += 200;
  await tick();
  assert.equal(sock.sent.length, 1, "socket recovered, send succeeded");

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
  clock += 20; await tick();

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
  assert.equal(sock.sent.length, 0);
  assert.equal(fs.existsSync(path.join(outboxDir, "1-a.json")), false);
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

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
