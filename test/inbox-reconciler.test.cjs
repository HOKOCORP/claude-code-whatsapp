const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("../lib/inbox-reconciler.cjs");

test("delete when id is already in jsonl", () => {
  const action = r.reconcileFile({
    id: "ABC", jsonlText: 'x message_id=\\"ABC\\" y',
    sendAttempts: null, now: 1000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });
  assert.equal(action.kind, "delete");
});

test("send when id not in jsonl and never sent", () => {
  const action = r.reconcileFile({
    id: "ABC", jsonlText: "no match here",
    sendAttempts: null, now: 1000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });
  assert.equal(action.kind, "send");
});

test("wait when id not in jsonl but sent recently", () => {
  const action = r.reconcileFile({
    id: "ABC", jsonlText: "no match",
    sendAttempts: { count: 1, firstSentAt: 500, lastSentAt: 500 }, now: 1000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });
  assert.equal(action.kind, "wait");
});

test("resend when last send is older than stalenessMs", () => {
  const action = r.reconcileFile({
    id: "ABC", jsonlText: "no match",
    sendAttempts: { count: 1, firstSentAt: 500, lastSentAt: 500 }, now: 22000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });
  assert.equal(action.kind, "resend");
});

test("quarantine when retries exhausted", () => {
  const action = r.reconcileFile({
    id: "ABC", jsonlText: "no match",
    sendAttempts: { count: 3, firstSentAt: 500, lastSentAt: 25000 }, now: 50000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });
  assert.equal(action.kind, "quarantine");
  assert.match(action.reason, /retries/);
});

test("quarantine when file age exceeds maxAgeMs", () => {
  const action = r.reconcileFile({
    id: "ABC", jsonlText: "no match",
    sendAttempts: { count: 1, firstSentAt: 500, lastSentAt: 1000 }, now: 400000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });
  assert.equal(action.kind, "quarantine");
  assert.match(action.reason, /age/);
});

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeInbox(inboxDir, id, content) {
  const fp = path.join(inboxDir, `${Date.now()}-${id}.json`);
  fs.writeFileSync(fp, JSON.stringify({ content, meta: { message_id: id, chat_id: "c" } }));
  return fp;
}

test("tick: delivered files get unlinked, undelivered trigger send", () => {
  const userDir = mkTmp("recon-");
  const inbox = path.join(userDir, "inbox");
  fs.mkdirSync(inbox);
  const delivered = writeInbox(inbox, "DONE", "hi");
  const undelivered = writeInbox(inbox, "NEW", "hello");
  const jsonlText = 'pre message_id=\\"DONE\\" post';

  const sends = [];
  const tick = r.createReconciler({
    userDir,
    loadJsonl: () => jsonlText,
    sendNotification: (payload) => { sends.push(payload.meta.message_id); },
    now: () => 1000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });

  tick();
  assert.equal(fs.existsSync(delivered), false);
  assert.equal(fs.existsSync(undelivered), true);
  assert.deepEqual(sends, ["NEW"]);
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("tick: quarantined files are moved to inbox/failed/", () => {
  const userDir = mkTmp("recon-");
  const inbox = path.join(userDir, "inbox");
  fs.mkdirSync(inbox);
  const fp = writeInbox(inbox, "STUCK", "hello");

  let clock = 1000;
  const tick = r.createReconciler({
    userDir,
    loadJsonl: () => "no match",
    sendNotification: () => {},
    now: () => clock,
    stalenessMs: 5, maxAgeMs: 10000, maxRetries: 3,
  });

  tick();            // send #1
  clock += 10; tick(); // resend #2
  clock += 10; tick(); // resend #3
  clock += 10; tick(); // quarantine

  assert.equal(fs.existsSync(fp), false);
  const failedDir = path.join(inbox, "failed");
  assert.ok(fs.existsSync(failedDir));
  const failedFiles = fs.readdirSync(failedDir);
  assert.equal(failedFiles.length, 1);
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("tick: resends after staleness window", () => {
  const userDir = mkTmp("recon-");
  const inbox = path.join(userDir, "inbox");
  fs.mkdirSync(inbox);
  writeInbox(inbox, "SLOW", "hello");

  let clock = 1000;
  const sends = [];
  const tick = r.createReconciler({
    userDir,
    loadJsonl: () => "no match",
    sendNotification: (p) => { sends.push([p.meta.message_id, clock]); },
    now: () => clock,
    stalenessMs: 100, maxAgeMs: 10000, maxRetries: 10,
  });

  tick();
  clock += 50;
  tick();
  clock += 100;
  tick();

  assert.equal(sends.length, 2);
  assert.equal(sends[0][0], "SLOW");
  assert.equal(sends[1][0], "SLOW");
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("tick: gracefully skips files with malformed JSON", () => {
  const userDir = mkTmp("recon-");
  const inbox = path.join(userDir, "inbox");
  fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(inbox, "bad.json"), "{ not json");

  const tick = r.createReconciler({
    userDir,
    loadJsonl: () => "",
    sendNotification: () => { throw new Error("should not be called"); },
    now: () => 1000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });

  tick();
  fs.rmSync(userDir, { recursive: true, force: true });
});
