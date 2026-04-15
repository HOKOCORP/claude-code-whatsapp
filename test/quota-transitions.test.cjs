const test = require("node:test");
const assert = require("node:assert/strict");
const { detectTransitions } = require("../lib/quota-transitions.cjs");

const ALL_UNMARKED = { session_25: null, session_10: null, week_25: null, week_10: null };

test("no previous snapshot → empty alerts and resets", () => {
  const r = detectTransitions({
    previous: null,
    current: { sessionRemainingPct: 40, weekRemainingPct: 80 },
    lastAlerted: ALL_UNMARKED,
  });
  assert.deepEqual(r.alertsToFire, []);
  assert.deepEqual(r.resetsToClear, []);
});

test("session crosses 25% down → one alert at threshold 25", () => {
  const r = detectTransitions({
    previous: { sessionRemainingPct: 30, weekRemainingPct: 80 },
    current: { sessionRemainingPct: 22, weekRemainingPct: 80 },
    lastAlerted: ALL_UNMARKED,
  });
  assert.deepEqual(r.alertsToFire, [{ window: "session", threshold: 25, remaining: 22 }]);
  assert.deepEqual(r.resetsToClear, []);
});

test("session already below 25% with marker set → no alert", () => {
  const r = detectTransitions({
    previous: { sessionRemainingPct: 22, weekRemainingPct: 80 },
    current: { sessionRemainingPct: 18, weekRemainingPct: 80 },
    lastAlerted: { ...ALL_UNMARKED, session_25: 1000 },
  });
  assert.deepEqual(r.alertsToFire, []);
});

test("session drops through both 25 and 10 in one tick → 10%-alert wins (lowest transitioned)", () => {
  const r = detectTransitions({
    previous: { sessionRemainingPct: 32, weekRemainingPct: 80 },
    current: { sessionRemainingPct: 8, weekRemainingPct: 80 },
    lastAlerted: ALL_UNMARKED,
  });
  assert.deepEqual(r.alertsToFire, [{ window: "session", threshold: 10, remaining: 8 }]);
});

test("movement without crossing thresholds → empty", () => {
  const r = detectTransitions({
    previous: { sessionRemainingPct: 95, weekRemainingPct: 80 },
    current: { sessionRemainingPct: 80, weekRemainingPct: 75 },
    lastAlerted: ALL_UNMARKED,
  });
  assert.deepEqual(r.alertsToFire, []);
  assert.deepEqual(r.resetsToClear, []);
});

test("window reset (8% → 95%) with both markers set → clear both markers, no alert", () => {
  const r = detectTransitions({
    previous: { sessionRemainingPct: 8, weekRemainingPct: 80 },
    current: { sessionRemainingPct: 95, weekRemainingPct: 80 },
    lastAlerted: { ...ALL_UNMARKED, session_25: 100, session_10: 200 },
  });
  assert.deepEqual(r.alertsToFire, []);
  assert.deepEqual(r.resetsToClear, [{ window: "session", threshold: 25 }, { window: "session", threshold: 10 }]);
});

test("both windows cross 25% in same tick → two alerts", () => {
  const r = detectTransitions({
    previous: { sessionRemainingPct: 30, weekRemainingPct: 30 },
    current: { sessionRemainingPct: 22, weekRemainingPct: 22 },
    lastAlerted: ALL_UNMARKED,
  });
  assert.deepEqual(r.alertsToFire, [
    { window: "session", threshold: 25, remaining: 22 },
    { window: "week", threshold: 25, remaining: 22 },
  ]);
});

test("session resets from below-10 directly to above-25 → only 10 marker cleared, since 25 marker was not set", () => {
  const r = detectTransitions({
    previous: { sessionRemainingPct: 8, weekRemainingPct: 80 },
    current: { sessionRemainingPct: 95, weekRemainingPct: 80 },
    lastAlerted: { ...ALL_UNMARKED, session_10: 200 },
  });
  assert.deepEqual(r.alertsToFire, []);
  assert.deepEqual(r.resetsToClear, [{ window: "session", threshold: 10 }]);
});

test("week crosses 10% while session still okay → one week 10%-alert", () => {
  const r = detectTransitions({
    previous: { sessionRemainingPct: 80, weekRemainingPct: 12 },
    current: { sessionRemainingPct: 78, weekRemainingPct: 8 },
    lastAlerted: { ...ALL_UNMARKED, week_25: 500 },
  });
  assert.deepEqual(r.alertsToFire, [{ window: "week", threshold: 10, remaining: 8 }]);
});
