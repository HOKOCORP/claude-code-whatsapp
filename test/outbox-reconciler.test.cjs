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
