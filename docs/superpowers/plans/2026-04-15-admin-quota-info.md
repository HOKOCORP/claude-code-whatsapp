# Admin Quota Info Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface 5-hour ("Current session") and 7-day ("Current week — all models") remaining quota to the admin — pulled on-demand via `/usage` and pushed proactively via WhatsApp alerts when either window crosses below 25% or 10%.

**Architecture:** Three new pure/near-pure modules that scrape, cache, and decide, plus a narrow `gateway.cjs` wiring layer. Data source is the `/status` TUI Usage tab in the admin's existing Claude Code tmux session — no new API keys. Alerts piggyback on the existing outbox reconciler (commit 8293b21); quota is just another producer of outbox files.

**Tech Stack:** Node.js (CommonJS `.cjs`), `node:test` (via `npm test`), `tmux` CLI (already required by the gateway), Node's built-in `execFile` (already used elsewhere in the gateway, see `gateway.cjs:378`). No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-15-admin-quota-info-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/quota-scraper.cjs` (NEW) | Single exported async fn `captureQuota({tmuxSession, sendKeys, capturePane, sleep, now, renderDelayMs, tabDelayMs})`. Runs the `/status` → Right×2 → capture → Escape sequence and parses the captured pane. Returns `{sessionRemainingPct, weekRemainingPct, sessionResetsAt?, weekResetsAt?, capturedAt} \| null`. All I/O is injected so tests never spawn a real tmux. |
| `lib/quota-cache.cjs` (NEW) | `readQuota(path)` / `writeQuota(path, {current, lastAlerted})` against a single JSON file. Shape: `{current, previous, lastAlerted}`. Atomic writes via tmp+rename. Corrupt JSON → return null, don't throw. |
| `lib/quota-transitions.cjs` (NEW) | Pure fn `detectTransitions({previous, current, lastAlerted})` → `{alertsToFire, resetsToClear}`. Implements the threshold-crossing logic exactly as spec §5.2 + §5.6. |
| `test/quota-scraper.test.cjs` (NEW) | Unit tests for `captureQuota` via injected runner — 7 cases covering happy path, missing sections, Sonnet-only week ambiguity, reset-time extraction, concurrent-call dedup. |
| `test/quota-cache.test.cjs` (NEW) | Unit tests for read/write/corruption recovery. |
| `test/quota-transitions.test.cjs` (NEW) | Unit tests for all seven transition rules. |
| `test/admin-quota-integration.test.cjs` (NEW) | End-to-end test: real scraper + real cache + real transition fn, stubbed tmux, assert alert payload and `/usage` section render. |
| `gateway.cjs` (MODIFY) | Require the 3 new modules. Resolve admin tmux session name + quota cache path at boot. Extend existing `/usage` handler (line 1349, just before the existing `sock.sendMessage`) to append the admin quota section when caller is admin. Add background `setInterval` for the 5-min poll. On breach, write quota alert files into admin outbox. |

---

## Task 1: quota-transitions — pure decision fn

**Files:**
- Create: `/home/wp-fundraising/claude-code-whatsapp/lib/quota-transitions.cjs`
- Create: `/home/wp-fundraising/claude-code-whatsapp/test/quota-transitions.test.cjs`

### Context

The threshold-crossing logic is small enough to isolate as a pure function. Takes the previous snapshot, current snapshot, and the lastAlerted map; returns which alerts to fire and which reset-markers to clear. No file I/O, no timestamps, no side effects.

Per the spec:
- Alert fires ONLY on first transition below threshold (`prev.session ≥ 25 && cur.session < 25 && lastAlerted["session_25"] == null`).
- When BOTH thresholds (25 and 10) cross in one tick, emit only the 10% alert (lowest wins).
- Window reset (current ≥ threshold while lastAlerted[key] is set) clears the marker so future re-breaches alert again.

### Steps

- [ ] **Step 1: Write the failing tests**

Create `/home/wp-fundraising/claude-code-whatsapp/test/quota-transitions.test.cjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/quota-transitions.test.cjs 2>&1 | tail -20`

Expected: `MODULE_NOT_FOUND` (module doesn't exist yet).

- [ ] **Step 3: Implement the module**

Create `/home/wp-fundraising/claude-code-whatsapp/lib/quota-transitions.cjs`:

```js
const WINDOWS = ["session", "week"];
const THRESHOLDS = [25, 10];

function detectTransitions({ previous, current, lastAlerted }) {
  const alertsToFire = [];
  const resetsToClear = [];
  if (!previous) return { alertsToFire, resetsToClear };

  for (const win of WINDOWS) {
    const prevPct = previous[`${win}RemainingPct`];
    const curPct  = current[`${win}RemainingPct`];
    if (typeof prevPct !== "number" || typeof curPct !== "number") continue;

    // Collect thresholds this tick crossed downward (prev >= t && cur < t),
    // and only those whose marker is unset (meaning no prior alert).
    const transitionedThresholds = [];
    for (const t of THRESHOLDS) {
      const key = `${win}_${t}`;
      if (prevPct >= t && curPct < t && lastAlerted[key] == null) {
        transitionedThresholds.push(t);
      }
    }
    // If both 25 and 10 crossed in the same tick, emit only the 10 (lowest).
    if (transitionedThresholds.length > 0) {
      const threshold = Math.min(...transitionedThresholds);
      alertsToFire.push({ window: win, threshold, remaining: curPct });
    }

    // Reset markers for any threshold where current returns at-or-above it.
    for (const t of THRESHOLDS) {
      const key = `${win}_${t}`;
      if (curPct >= t && lastAlerted[key] != null) {
        resetsToClear.push({ window: win, threshold: t });
      }
    }
  }
  return { alertsToFire, resetsToClear };
}

module.exports = { detectTransitions };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/quota-transitions.test.cjs 2>&1 | tail -20`

Expected: `pass 9`.

- [ ] **Step 5: Commit**

```bash
cd /home/wp-fundraising/claude-code-whatsapp
git add lib/quota-transitions.cjs test/quota-transitions.test.cjs
git commit -m "$(cat <<'EOF'
feat(quota): pure detectTransitions fn for threshold crossings

Given previous/current quota snapshots and the lastAlerted marker map,
returns which alerts to fire and which markers to clear for window
resets. When both 25% and 10% cross in the same tick, only the 10%
alert fires (lowest transitioned wins) to avoid duplicate notifications.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: quota-cache — file-backed state

**Files:**
- Create: `/home/wp-fundraising/claude-code-whatsapp/lib/quota-cache.cjs`
- Create: `/home/wp-fundraising/claude-code-whatsapp/test/quota-cache.test.cjs`

### Context

Single JSON file. Reads return `{current, previous, lastAlerted}` or `null` on absence/corruption. Writes shift old `current` to `previous` and optionally update `lastAlerted`. Atomic via tmp+rename.

### Steps

- [ ] **Step 1: Write failing tests**

Create `/home/wp-fundraising/claude-code-whatsapp/test/quota-cache.test.cjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/quota-cache.test.cjs 2>&1 | tail -20`

Expected: `MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the module**

Create `/home/wp-fundraising/claude-code-whatsapp/lib/quota-cache.cjs`:

```js
const fs = require("node:fs");
const path = require("node:path");

const EMPTY_LAST_ALERTED = { session_25: null, session_10: null, week_25: null, week_10: null };

function readQuota(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); }
  catch { return null; }
  let obj;
  try { obj = JSON.parse(raw); }
  catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  return {
    current: obj.current || null,
    previous: obj.previous || null,
    lastAlerted: { ...EMPTY_LAST_ALERTED, ...(obj.lastAlerted || {}) },
  };
}

function writeQuota(filePath, { current, lastAlerted }) {
  const existing = readQuota(filePath);
  const previous = existing?.current || null;
  const mergedLastAlerted = { ...EMPTY_LAST_ALERTED, ...(existing?.lastAlerted || {}), ...(lastAlerted || {}) };
  const payload = { current: current || null, previous, lastAlerted: mergedLastAlerted };
  const tmp = filePath + ".tmp";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, filePath);
}

module.exports = { readQuota, writeQuota };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/quota-cache.test.cjs 2>&1 | tail -20`

Expected: `pass 7`.

- [ ] **Step 5: Commit**

```bash
cd /home/wp-fundraising/claude-code-whatsapp
git add lib/quota-cache.cjs test/quota-cache.test.cjs
git commit -m "$(cat <<'EOF'
feat(quota): file-backed cache for quota snapshots + alert markers

readQuota returns {current, previous, lastAlerted} or null on absence
or corruption. writeQuota atomically replaces the file (tmp+rename),
shifts old current -> previous, merges new lastAlerted markers into
the existing set. Null in lastAlerted clears a marker.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: quota-scraper — tmux capture + parse

**Files:**
- Create: `/home/wp-fundraising/claude-code-whatsapp/lib/quota-scraper.cjs`
- Create: `/home/wp-fundraising/claude-code-whatsapp/test/quota-scraper.test.cjs`

### Context

Scraper does 3 things in one pass: runs tmux send-keys + capture-pane via injected callbacks, parses the captured pane for `Current session` and `Current week (all models)` blocks, returns a normalized snapshot. All I/O injected so tests never spawn a real tmux. Concurrent-call dedup via an `inFlight` promise.

### Steps

- [ ] **Step 1: Write failing tests**

Create `/home/wp-fundraising/claude-code-whatsapp/test/quota-scraper.test.cjs`:

```js
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
  // Navigation: /status + Enter, Right, Right, capture, Escape
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
  assert.deepEqual(a, b, "both callers get the same snapshot");
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/quota-scraper.test.cjs 2>&1 | tail -20`

Expected: `MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the module**

Create `/home/wp-fundraising/claude-code-whatsapp/lib/quota-scraper.cjs`:

```js
const SESSION_RE     = /Current session\s*(?:\r?\n[^\n]*){0,3}?(\d{1,3})\s*%\s*used/i;
const WEEK_RE        = /Current week \(all models\)\s*(?:\r?\n[^\n]*){0,3}?(\d{1,3})\s*%\s*used/i;
const SESSION_RESET_RE = /Current session[\s\S]*?Resets\s+([^\n]+)/i;
const WEEK_RESET_RE    = /Current week \(all models\)[\s\S]*?Resets\s+([^\n]+)/i;

let inFlight = null;

function parsePane(pane) {
  const sm = SESSION_RE.exec(pane);
  const wm = WEEK_RE.exec(pane);
  if (!sm || !wm) return null;
  const sessionUsed = Number(sm[1]);
  const weekUsed    = Number(wm[1]);
  if (!Number.isFinite(sessionUsed) || !Number.isFinite(weekUsed)) return null;
  const snapshot = {
    sessionRemainingPct: 100 - sessionUsed,
    weekRemainingPct: 100 - weekUsed,
  };
  const sr = SESSION_RESET_RE.exec(pane);
  const wr = WEEK_RESET_RE.exec(pane);
  if (sr) snapshot.sessionResetsAt = sr[1].trim();
  if (wr) snapshot.weekResetsAt = wr[1].trim();
  return snapshot;
}

async function doCapture({ tmuxSession, sendKeys, capturePane, sleep, now, renderDelayMs, tabDelayMs }) {
  let snapshot = null;
  try {
    await sendKeys(tmuxSession, ["/status", "Enter"]);
    await sleep(renderDelayMs);
    await sendKeys(tmuxSession, ["Right"]);
    await sleep(tabDelayMs);
    await sendKeys(tmuxSession, ["Right"]);
    await sleep(tabDelayMs);
    const pane = await capturePane(tmuxSession);
    snapshot = parsePane(pane);
  } catch { /* fallthrough — escape still sent below */ }
  try { await sendKeys(tmuxSession, ["Escape"]); } catch {}
  if (!snapshot) return null;
  return { ...snapshot, capturedAt: now() };
}

async function captureQuota({
  tmuxSession,
  sendKeys,
  capturePane,
  sleep,
  now = () => Date.now(),
  renderDelayMs = 400,
  tabDelayMs = 200,
}) {
  if (inFlight) return inFlight;
  inFlight = doCapture({ tmuxSession, sendKeys, capturePane, sleep, now, renderDelayMs, tabDelayMs });
  try { return await inFlight; }
  finally { inFlight = null; }
}

module.exports = { captureQuota, parsePane };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/quota-scraper.test.cjs 2>&1 | tail -20`

Expected: `pass 7`.

- [ ] **Step 5: Commit**

```bash
cd /home/wp-fundraising/claude-code-whatsapp
git add lib/quota-scraper.cjs test/quota-scraper.test.cjs
git commit -m "$(cat <<'EOF'
feat(quota): tmux scraper for /status Usage tab

captureQuota runs /status -> Right->Right -> capture -> Escape against
the admin's tmux session (all I/O injected for testability). Parses
"Current session" and "Current week (all models)" blocks with bounded
multi-line regexes; ignores the Sonnet-only bucket. Returns null on
parse/tmux failure. Concurrent calls share one capture via inFlight
promise. Escape always fires so the overlay never sticks around.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: gateway wiring — poller, /usage extension, alert emit

**File:**
- Modify: `/home/wp-fundraising/claude-code-whatsapp/gateway.cjs`

### Context

Four additions to gateway.cjs; no subtractions. They need to land together because the `/usage` extension and the poller both depend on the helper functions this task introduces.

1. **Imports + constants**. Require the 3 new modules. Define `QUOTA_POLL_INTERVAL_MS`, `QUOTA_RENDER_DELAY_MS`, `QUOTA_TAB_DELAY_MS` as module-level consts.

2. **Helper fns** (all at module scope, near the existing admin helpers around line 342):
   - `adminQuotaFilePath()` — returns `<IPC_BASE>/admin-quota.json`. One line.
   - `adminTmuxSession()` — returns the admin's tmux session name: reads `loadAdmin()`, `sanitizeUserId()`, `getUserSessionName()`. Returns null if no admin configured.
   - `runTmuxSendKeys(session, keys)` / `runTmuxCapturePane(session)` / `quotaSleep(ms)` — real impls using the `execFile` already imported at the top of `gateway.cjs`.
   - `captureAdminQuota()` — wires the scraper with real tmux deps.
   - `emitQuotaAlert(breach, adminJid, adminUserDir)` — writes an outbox file for the admin.

3. **Poller**. One `setInterval(quotaTick, QUOTA_POLL_INTERVAL_MS)`. `quotaTick` is an async fn that calls the scraper, cache, and transition fn in sequence. Wrapped in `try/catch` so a single failure doesn't stop future ticks.

4. **`/usage` extension**. At the existing `/usage` handler (gateway.cjs line 1349, just before the `sock.sendMessage(jid, ...)` call): if the caller is admin, await `captureAdminQuota` once (respects inFlight dedup with any running poll) and append the "📊 Admin quota" lines.

### Steps

- [ ] **Step 1: Add imports + module-level constants**

Open `/home/wp-fundraising/claude-code-whatsapp/gateway.cjs`. Near the other `require("./lib/...")` lines (immediately after `const { createAuditLogger } = require("./lib/audit-log.cjs");`, which was added in an earlier commit), add:

```js
const quotaScraper = require("./lib/quota-scraper.cjs");
const quotaCache = require("./lib/quota-cache.cjs");
const { detectTransitions } = require("./lib/quota-transitions.cjs");

const QUOTA_POLL_INTERVAL_MS = 5 * 60 * 1000;
const QUOTA_RENDER_DELAY_MS = 400;
const QUOTA_TAB_DELAY_MS = 200;
```

- [ ] **Step 2: Add helper fns near the existing admin helpers**

Find the existing `loadAdmin()` function (around line 342). Immediately after it, add:

```js
function adminQuotaFilePath() { return path.join(IPC_BASE, "admin-quota.json"); }

function adminTmuxSession() {
  const admin = loadAdmin();
  if (!admin || !admin.jid) return null;
  return getUserSessionName(sanitizeUserId(admin.jid));
}

async function runTmuxSendKeys(session, keys) {
  return new Promise((resolve, reject) => {
    execFile("tmux", ["send-keys", "-t", `${session}.0`, ...keys], (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

async function runTmuxCapturePane(session) {
  return new Promise((resolve, reject) => {
    execFile("tmux", ["capture-pane", "-t", `${session}.0`, "-p"], (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

const quotaSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureAdminQuota() {
  const session = adminTmuxSession();
  if (!session) return null;
  return quotaScraper.captureQuota({
    tmuxSession: session,
    sendKeys: runTmuxSendKeys,
    capturePane: runTmuxCapturePane,
    sleep: quotaSleep,
    renderDelayMs: QUOTA_RENDER_DELAY_MS,
    tabDelayMs: QUOTA_TAB_DELAY_MS,
  });
}

function emitQuotaAlert(breach, adminJid, adminUserDir) {
  const icon = breach.threshold === 10 ? "🚨" : "⚠️";
  const label = breach.window === "session" ? "Session" : "Weekly";
  const tail = breach.threshold === 10 ? " — near exhaustion" : "";
  const text = `${icon} ${label} quota at ${breach.remaining}% remaining${tail} (crossed ${breach.threshold}% threshold)`;
  const filename = `${Date.now()}-quota-${breach.window}_${breach.threshold}.json`;
  const fp = path.join(adminUserDir, "outbox", filename);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ action: "reply", chat_id: adminJid, text }));
}
```

Verify the file already imports `execFile` at the top (search for the existing `execFile` call around line 378 — it's already there). Also verify `path`, `fs` are already imported — they are.

- [ ] **Step 3: Add the 5-min poller**

Find the existing outbox poller `setInterval(async () => { ... }, 1500);` block (around line 1502-1514). Immediately after its closing `}, 1500);`, add:

```js
async function quotaTick() {
  try {
    const admin = loadAdmin();
    if (!admin || !admin.jid) return;
    const current = await captureAdminQuota();
    if (!current) return;
    const cachePath = adminQuotaFilePath();
    const existing = quotaCache.readQuota(cachePath);
    const { alertsToFire, resetsToClear } = detectTransitions({
      previous: existing?.current || null,
      current,
      lastAlerted: existing?.lastAlerted || { session_25: null, session_10: null, week_25: null, week_10: null },
    });
    const now = Date.now();
    const lastAlerted = {};
    for (const breach of alertsToFire) lastAlerted[`${breach.window}_${breach.threshold}`] = now;
    for (const reset of resetsToClear)  lastAlerted[`${reset.window}_${reset.threshold}`] = null;
    quotaCache.writeQuota(cachePath, { current, lastAlerted });
    if (alertsToFire.length > 0) {
      const adminUserDir = getUserDir(sanitizeUserId(admin.jid));
      for (const breach of alertsToFire) emitQuotaAlert(breach, admin.jid, adminUserDir);
    }
  } catch (e) { log(`quota tick error: ${e}`); }
}
setInterval(quotaTick, QUOTA_POLL_INTERVAL_MS);
```

- [ ] **Step 4: Extend `/usage` handler for admin**

Find the existing `/usage` handler (around line 1292). Find the block that ends with:

```js
        lines.push(`Month cost: ${fmtUSD(totalCost)}`);
        lines.push(`All time: ${fmtUSD(u.total_cost || 0)} spent`);

        try { await sock.sendMessage(jid, { text: lines.join("\n") }); } catch {}
```

Immediately before the `try { await sock.sendMessage ... }` line, insert:

```js
        if (isAdminUser) {
          try {
            const q = await captureAdminQuota();
            if (q) {
              lines.push(``);
              lines.push(`📊 Admin quota`);
              const sessionLabel = q.sessionResetsAt ? ` (resets ${q.sessionResetsAt})` : ``;
              const weekLabel    = q.weekResetsAt    ? ` (resets ${q.weekResetsAt})`    : ``;
              lines.push(`Session: ${q.sessionRemainingPct}% remaining${sessionLabel}`);
              lines.push(`Weekly: ${q.weekRemainingPct}% remaining${weekLabel}`);
            } else {
              lines.push(``);
              lines.push(`📊 Admin quota: (unavailable)`);
            }
          } catch { /* ignore scrape errors in /usage path */ }
        }
```

- [ ] **Step 5: Syntax check**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && node --check gateway.cjs && echo OK`

Expected: `OK`.

- [ ] **Step 6: Run the full test suite**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npm test 2>&1 | tail -15`

Expected: all existing + new tests pass. Count depends on how many tests each of Tasks 1-3 added, but the full suite must be green (>= 120 tests).

- [ ] **Step 7: Commit**

```bash
cd /home/wp-fundraising/claude-code-whatsapp
git add gateway.cjs
git commit -m "$(cat <<'EOF'
feat(gateway): wire admin quota poller + /usage extension + alert emit

Adds 5-min background poller that scrapes the admin's /status Usage
tab via tmux, caches the snapshot, detects 25%/10% threshold crossings,
and writes alert messages to the admin's outbox (delivered via the
existing outbox reconciler). Extends /usage to show admin's session +
weekly remaining % inline when the caller is admin. No-op for non-admin
users.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: integration test — full cycle with stubbed tmux

**File:**
- Create: `/home/wp-fundraising/claude-code-whatsapp/test/admin-quota-integration.test.cjs`

### Context

Real scraper + real cache + real transition fn + stubbed tmux I/O. Four scenarios:
- **A**: Fresh start → capture → writes cache, no alert (no previous).
- **B**: Previous snapshot said 70% session, new capture says 22% → one alert file produced, cache marker set.
- **C**: Second breach tick (22% → 18%) with marker already set → NO new alert (dedup).
- **D**: Full reset sequence — clears both 25 and 10 markers.

This complements the unit tests — it exercises the end-to-end flow without requiring a live tmux.

### Steps

- [ ] **Step 1: Write the failing tests**

Create `/home/wp-fundraising/claude-code-whatsapp/test/admin-quota-integration.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { captureQuota } = require("../lib/quota-scraper.cjs");
const { readQuota, writeQuota } = require("../lib/quota-cache.cjs");
const { detectTransitions } = require("../lib/quota-transitions.cjs");

function mkTmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function panePct(sessionUsed, weekUsed) {
  return `
   Status   Config   Usage   Stats

  Current session
  █ ${sessionUsed}% used
  Resets 10am (UTC)

  Current week (all models)
  █ ${weekUsed}% used
  Resets Apr 21, 5am (UTC)

  Esc to cancel
`;
}

function makeDeps(paneText, nowFn) {
  return {
    sendKeys: () => Promise.resolve(),
    capturePane: () => Promise.resolve(paneText),
    sleep: () => Promise.resolve(),
    now: nowFn,
  };
}

function quotaTick({ paneText, cachePath, adminUserDir, adminJid, now = 1000 }) {
  // Inline version of gateway.cjs quotaTick() — same logic, exposed for test.
  return (async () => {
    const current = await captureQuota({ tmuxSession: "admin", ...makeDeps(paneText, () => now) });
    if (!current) return { alertsEmitted: 0 };
    const existing = readQuota(cachePath);
    const { alertsToFire, resetsToClear } = detectTransitions({
      previous: existing?.current || null,
      current,
      lastAlerted: existing?.lastAlerted || { session_25: null, session_10: null, week_25: null, week_10: null },
    });
    const lastAlerted = {};
    for (const b of alertsToFire) lastAlerted[`${b.window}_${b.threshold}`] = now;
    for (const r of resetsToClear) lastAlerted[`${r.window}_${r.threshold}`] = null;
    writeQuota(cachePath, { current, lastAlerted });
    let alertsEmitted = 0;
    for (const b of alertsToFire) {
      const icon = b.threshold === 10 ? "🚨" : "⚠️";
      const label = b.window === "session" ? "Session" : "Weekly";
      const tail = b.threshold === 10 ? " — near exhaustion" : "";
      const text = `${icon} ${label} quota at ${b.remaining}% remaining${tail} (crossed ${b.threshold}% threshold)`;
      const fp = path.join(adminUserDir, "outbox", `${now + alertsEmitted}-quota-${b.window}_${b.threshold}.json`);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, JSON.stringify({ action: "reply", chat_id: adminJid, text }));
      alertsEmitted++;
    }
    return { alertsEmitted };
  })();
}

test("scenario A — fresh start: one tick writes cache, no alert", async () => {
  const dir = mkTmp("admin-quota-integ-");
  const cachePath = path.join(dir, "admin-quota.json");
  const adminUserDir = path.join(dir, "users", "admin");
  const pane = panePct(34, 21);  // 66% session, 79% week — no breach

  const r = await quotaTick({ paneText: pane, cachePath, adminUserDir, adminJid: "admin@jid", now: 1000 });
  assert.equal(r.alertsEmitted, 0);
  const cached = readQuota(cachePath);
  assert.equal(cached.current.sessionRemainingPct, 66);
  assert.equal(cached.current.weekRemainingPct, 79);
  assert.equal(cached.previous, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scenario B — breach after prior snapshot: one alert emitted, marker set", async () => {
  const dir = mkTmp("admin-quota-integ-");
  const cachePath = path.join(dir, "admin-quota.json");
  const adminUserDir = path.join(dir, "users", "admin");

  // Tick 1 at 70% session, 80% week.
  await quotaTick({ paneText: panePct(30, 20), cachePath, adminUserDir, adminJid: "admin@jid", now: 1000 });
  // Tick 2 at 22% session, 80% week — session crosses 25 down.
  const r = await quotaTick({ paneText: panePct(78, 20), cachePath, adminUserDir, adminJid: "admin@jid", now: 2000 });
  assert.equal(r.alertsEmitted, 1);

  const outboxFiles = fs.readdirSync(path.join(adminUserDir, "outbox"));
  assert.equal(outboxFiles.length, 1);
  const alertFile = JSON.parse(fs.readFileSync(path.join(adminUserDir, "outbox", outboxFiles[0]), "utf8"));
  assert.equal(alertFile.action, "reply");
  assert.equal(alertFile.chat_id, "admin@jid");
  assert.match(alertFile.text, /Session quota at 22% remaining \(crossed 25% threshold\)/);

  const cached = readQuota(cachePath);
  assert.equal(cached.lastAlerted.session_25, 2000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scenario C — second breach tick with marker set: NO new alert (dedup)", async () => {
  const dir = mkTmp("admin-quota-integ-");
  const cachePath = path.join(dir, "admin-quota.json");
  const adminUserDir = path.join(dir, "users", "admin");

  await quotaTick({ paneText: panePct(30, 20), cachePath, adminUserDir, adminJid: "admin@jid", now: 1000 });
  await quotaTick({ paneText: panePct(78, 20), cachePath, adminUserDir, adminJid: "admin@jid", now: 2000 }); // first alert
  const r3 = await quotaTick({ paneText: panePct(82, 20), cachePath, adminUserDir, adminJid: "admin@jid", now: 3000 }); // 18% session, still below 25
  assert.equal(r3.alertsEmitted, 0, "already below threshold, marker set → no re-alert");

  const outboxFiles = fs.readdirSync(path.join(adminUserDir, "outbox"));
  assert.equal(outboxFiles.length, 1, "still only one alert file from the original breach");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scenario D — reset (below 10 → above 25) clears both markers", async () => {
  const dir = mkTmp("admin-quota-integ-");
  const cachePath = path.join(dir, "admin-quota.json");
  const adminUserDir = path.join(dir, "users", "admin");

  await quotaTick({ paneText: panePct(30, 20), cachePath, adminUserDir, adminJid: "admin@jid", now: 1000 });  // baseline 70/80
  await quotaTick({ paneText: panePct(94, 20), cachePath, adminUserDir, adminJid: "admin@jid", now: 2000 });  // 6% session → one alert at 10 (both thresholds crossed)
  const r3 = await quotaTick({ paneText: panePct(5, 20), cachePath, adminUserDir, adminJid: "admin@jid", now: 3000 });   // 95% session — reset
  assert.equal(r3.alertsEmitted, 0);

  const cached = readQuota(cachePath);
  assert.equal(cached.lastAlerted.session_10, null);
  assert.equal(cached.lastAlerted.session_25, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npx --no-install node --test test/admin-quota-integration.test.cjs 2>&1 | tail -15`

Expected: `pass 4`.

- [ ] **Step 3: Run the full suite**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && npm test 2>&1 | tail -10`

Expected: all tests pass. Count includes the 9 + 7 + 7 unit tests plus 4 integration tests plus everything pre-existing.

- [ ] **Step 4: Commit**

```bash
cd /home/wp-fundraising/claude-code-whatsapp
git add test/admin-quota-integration.test.cjs
git commit -m "$(cat <<'EOF'
test(quota): integration scenarios A-D for admin quota poller

A: Fresh start -> cache populated, no alert.
B: Baseline 70% -> breach at 22% -> one session_25 alert file written.
C: Second tick at 18% with marker set -> no re-alert (dedup holds).
D: Reset (below 10 -> above 25) clears both markers so future
   re-breaches fire again.

Wires real scraper + real cache + real transitions through a
test-local quotaTick() that mirrors the gateway.cjs version. Stubs
only the tmux I/O.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Smoke test + gateway restart

**Files:** none (operational)

### Context

After Task 4 commits land, the gateway needs a restart for the new poller to activate and for the `/usage` extension to be live. Same restart pattern as the delivery-reliability rollout (see `2026-04-15-delivery-reliability.md` Task 7).

### Steps

- [ ] **Step 1: Confirm all commits are in**

Run: `cd /home/wp-fundraising/claude-code-whatsapp && git log --oneline -10`

Expected: top 5 commits are the ones from Tasks 1-5, in order, on top of the delivery-reliability HEAD.

- [ ] **Step 2: Push**

```bash
cd /home/wp-fundraising/claude-code-whatsapp
git -c credential.helper='!f(){ echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f' push origin main 2>&1 | tail -5
```

Expected: push succeeds.

- [ ] **Step 3: Restart gateway**

```bash
pkill -f "node.*gateway.cjs" 2>&1
sleep 1
WHATSAPP_STATE_DIR=/home/wp-fundraising/.claude/channels/whatsapp-85294949291 nohup node /home/wp-fundraising/claude-code-whatsapp/gateway.cjs > /tmp/gw.log 2>&1 &
disown
sleep 2
pgrep -af "node.*gateway.cjs" | grep -v "bash -c"
```

Expected: one fresh gateway pid, no zombies.

- [ ] **Step 4: Wait for Baileys connect + first quota tick**

Baileys takes ~30 s to reconnect after restart. The first quota poll runs 5 min after boot. Either:
- Wait 5+ min and check `<IPC_BASE>/admin-quota.json` exists.
- OR trigger `/usage` from admin's WhatsApp immediately; the handler calls `captureAdminQuota()` directly, which is faster than waiting for the poller.

- [ ] **Step 5: Verify `/usage` shows admin quota section**

Admin sends `/usage` in WhatsApp. Reply should contain a block:

```
📊 Admin quota
Session: NN% remaining (resets ...)
Weekly: NN% remaining (resets ...)
```

If "📊 Admin quota: (unavailable)" appears, check:
- `tmux ls` — is the admin session active?
- `tmux capture-pane -t <admin-session>.0 -p` — does `/status` Usage tab render correctly manually?
- Gateway log: `tail -50 /tmp/gw.log` for scrape errors.

- [ ] **Step 6: Verify cache file appears**

After 5 min (or after an admin-triggered `/usage`), the poller creates:

```
<IPC_BASE>/admin-quota.json
```

Inspect: `cat <IPC_BASE>/admin-quota.json | jq`. Should have `current`, `previous`, `lastAlerted` fields.

- [ ] **Step 7: Report to admin**

Message the admin via WhatsApp: feature live, quota visible in `/usage`, alerts fire at <25% and <10% per window. If smoke fails at any step, do NOT silently leave it — investigate `/tmp/gw.log` and the tmux session state, or revert by pushing `HEAD~5`.

---

## Appendix A — Rollback

If Task 6 smoke fails:

```bash
cd /home/wp-fundraising/claude-code-whatsapp
git revert --no-edit <sha-task-5>..<sha-task-1>
git -c credential.helper='!f(){ echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f' push origin main
# restart gateway
```

All new code is additive. Reverting restores the pre-feature state exactly. No data migration; the `admin-quota.json` cache file becomes inert.

## Appendix B — Post-ship tuning knobs

Constants in `gateway.cjs` at module scope:
- `QUOTA_POLL_INTERVAL_MS` — 5 min. Lower for faster alerts (more tmux noise for the admin); higher to save cycles.
- `QUOTA_RENDER_DELAY_MS` / `QUOTA_TAB_DELAY_MS` — 400/200 ms. Tune up if captures sometimes miss (slow render); down to reduce admin's screen flash duration.

If the regex breaks after a Claude Code version bump, fix in `lib/quota-scraper.cjs` only — all other modules are format-agnostic.
