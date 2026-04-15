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
