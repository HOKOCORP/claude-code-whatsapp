const test = require("node:test");
const assert = require("node:assert/strict");
const { captureQuota } = require("../lib/quota-scraper.cjs");

const REAL_USAGE_PANE = `
   Status   Config   Usage   Stats

  Current session
  █████████████████                                  34% used
  Resets 10am (UTC)

  Current week (all models)
  ██████████▌                                        21% used
  Resets Apr 21, 5am (UTC)

  Current week (Sonnet only)
  ███                                                6% used
  Resets Apr 19, 11am (UTC)

  Esc to cancel
`;

function makeStubRunner(paneText) {
  const calls = { sendKeys: [], capturePane: 0, sleeps: [] };
  return {
    calls,
    deps: {
      sendKeys: (session, keys) => { calls.sendKeys.push({ session, keys }); },
      capturePane: (session) => { calls.capturePane++; return paneText; },
      sleep: (ms) => { calls.sleeps.push(ms); return Promise.resolve(); },
      now: () => 1776240000000,
    },
  };
}

test("happy path: parses both sections, ignores Sonnet-only, returns percentages + reset strings", async () => {
  const { deps, calls } = makeStubRunner(REAL_USAGE_PANE);
  const r = await captureQuota({ tmuxSession: "admin-session", ...deps });
  assert.equal(r.sessionRemainingPct, 66, "100 - 34 used");
  assert.equal(r.weekRemainingPct, 79, "100 - 21 used (all-models, not Sonnet)");
  assert.equal(r.sessionResetsAt, "10am (UTC)");
  assert.equal(r.weekResetsAt, "Apr 21, 5am (UTC)");
  assert.equal(r.capturedAt, 1776240000000);
  assert.equal(calls.sendKeys.length, 4);
  assert.deepEqual(calls.sendKeys[0].keys, ["/status", "Enter"]);
  assert.deepEqual(calls.sendKeys[1].keys, ["Right"]);
  assert.deepEqual(calls.sendKeys[2].keys, ["Right"]);
  assert.deepEqual(calls.sendKeys[3].keys, ["Escape"]);
  assert.equal(calls.capturePane, 1);
});

test("pane missing 'Current session' block → returns null", async () => {
  const { deps } = makeStubRunner("   Status   Config   Usage   Stats\nOnly Current week (all models)\n█ 21% used\nResets never\n");
  const r = await captureQuota({ tmuxSession: "x", ...deps });
  assert.equal(r, null);
});

test("pane missing 'Current week (all models)' block (only Sonnet-only present) → returns null", async () => {
  const pane = `
   Status   Config   Usage   Stats

  Current session
  █████ 34% used
  Resets 10am

  Current week (Sonnet only)
  ███ 6% used
  Resets later
  `;
  const { deps } = makeStubRunner(pane);
  const r = await captureQuota({ tmuxSession: "x", ...deps });
  assert.equal(r, null);
});

test("escape is sent even when parse fails", async () => {
  const { deps, calls } = makeStubRunner("garbage");
  await captureQuota({ tmuxSession: "x", ...deps });
  const lastSendKeys = calls.sendKeys[calls.sendKeys.length - 1];
  assert.deepEqual(lastSendKeys.keys, ["Escape"]);
});

test("sendKeys throws → returns null, does not propagate", async () => {
  const deps = {
    sendKeys: () => { throw new Error("tmux session missing"); },
    capturePane: () => "",
    sleep: () => Promise.resolve(),
    now: () => 0,
  };
  const r = await captureQuota({ tmuxSession: "x", ...deps });
  assert.equal(r, null);
});

test("concurrent calls share one capture (inFlight dedup)", async () => {
  const { deps, calls } = makeStubRunner(REAL_USAGE_PANE);
  const [a, b] = await Promise.all([
    captureQuota({ tmuxSession: "x", ...deps }),
    captureQuota({ tmuxSession: "x", ...deps }),
  ]);
  assert.strictEqual(a, b, "same object reference — shared promise, not two captures");
  assert.equal(calls.capturePane, 1, "only one capture happened");
});

test("reset-time fields omitted when parse succeeds for pcts but reset regex fails", async () => {
  const pane = `
   Status   Config   Usage   Stats
  Current session
  █████ 34% used

  Current week (all models)
  █████ 21% used

  Esc to cancel
  `;
  const { deps } = makeStubRunner(pane);
  const r = await captureQuota({ tmuxSession: "x", ...deps });
  assert.equal(r.sessionRemainingPct, 66);
  assert.equal(r.weekRemainingPct, 79);
  assert.equal(r.sessionResetsAt, undefined);
  assert.equal(r.weekResetsAt, undefined);
});
