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
