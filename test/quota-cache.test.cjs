const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { readQuota, writeQuota } = require("../lib/quota-cache.cjs");

function mkTmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-cache-"));
  return path.join(dir, "quota.json");
}

test("readQuota returns null when file does not exist", () => {
  const fp = mkTmpFile();
  assert.equal(readQuota(fp), null);
  fs.rmSync(path.dirname(fp), { recursive: true, force: true });
});

test("writeQuota then readQuota round-trips fields", () => {
  const fp = mkTmpFile();
  const snap = { sessionRemainingPct: 62, weekRemainingPct: 88, capturedAt: 1000 };
  writeQuota(fp, { current: snap });
  const r = readQuota(fp);
  assert.deepEqual(r.current, snap);
  assert.equal(r.previous, null);
  assert.deepEqual(r.lastAlerted, { session_25: null, session_10: null, week_25: null, week_10: null });
  fs.rmSync(path.dirname(fp), { recursive: true, force: true });
});

test("second writeQuota shifts current into previous", () => {
  const fp = mkTmpFile();
  const s1 = { sessionRemainingPct: 62, weekRemainingPct: 88, capturedAt: 1000 };
  const s2 = { sessionRemainingPct: 40, weekRemainingPct: 80, capturedAt: 2000 };
  writeQuota(fp, { current: s1 });
  writeQuota(fp, { current: s2 });
  const r = readQuota(fp);
  assert.deepEqual(r.current, s2);
  assert.deepEqual(r.previous, s1);
  fs.rmSync(path.dirname(fp), { recursive: true, force: true });
});

test("writeQuota updates lastAlerted markers selectively", () => {
  const fp = mkTmpFile();
  const snap = { sessionRemainingPct: 22, weekRemainingPct: 88, capturedAt: 1000 };
  writeQuota(fp, { current: snap, lastAlerted: { session_25: 1000 } });
  const r = readQuota(fp);
  assert.equal(r.lastAlerted.session_25, 1000);
  assert.equal(r.lastAlerted.session_10, null);
  assert.equal(r.lastAlerted.week_25, null);
  assert.equal(r.lastAlerted.week_10, null);
  fs.rmSync(path.dirname(fp), { recursive: true, force: true });
});

test("writeQuota merges lastAlerted with existing markers", () => {
  const fp = mkTmpFile();
  writeQuota(fp, { current: { sessionRemainingPct: 22, weekRemainingPct: 88, capturedAt: 1 }, lastAlerted: { session_25: 1 } });
  writeQuota(fp, { current: { sessionRemainingPct: 8, weekRemainingPct: 88, capturedAt: 2 }, lastAlerted: { session_10: 2 } });
  const r = readQuota(fp);
  assert.equal(r.lastAlerted.session_25, 1, "earlier marker preserved");
  assert.equal(r.lastAlerted.session_10, 2, "new marker set");
  fs.rmSync(path.dirname(fp), { recursive: true, force: true });
});

test("writeQuota clears markers via null in lastAlerted", () => {
  const fp = mkTmpFile();
  writeQuota(fp, { current: { sessionRemainingPct: 22, weekRemainingPct: 88, capturedAt: 1 }, lastAlerted: { session_25: 1 } });
  writeQuota(fp, { current: { sessionRemainingPct: 95, weekRemainingPct: 88, capturedAt: 2 }, lastAlerted: { session_25: null } });
  const r = readQuota(fp);
  assert.equal(r.lastAlerted.session_25, null);
  fs.rmSync(path.dirname(fp), { recursive: true, force: true });
});

test("readQuota returns null on corrupt JSON", () => {
  const fp = mkTmpFile();
  fs.writeFileSync(fp, "{ not valid json");
  assert.equal(readQuota(fp), null);
  fs.rmSync(path.dirname(fp), { recursive: true, force: true });
});
