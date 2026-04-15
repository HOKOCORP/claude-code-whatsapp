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
  const pane = panePct(34, 21);

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

  await quotaTick({ paneText: panePct(30, 20), cachePath, adminUserDir, adminJid: "admin@jid", now: 1000 });
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
  await quotaTick({ paneText: panePct(78, 20), cachePath, adminUserDir, adminJid: "admin@jid", now: 2000 });
  const r3 = await quotaTick({ paneText: panePct(82, 20), cachePath, adminUserDir, adminJid: "admin@jid", now: 3000 });
  assert.equal(r3.alertsEmitted, 0, "already below threshold, marker set → no re-alert");

  const outboxFiles = fs.readdirSync(path.join(adminUserDir, "outbox"));
  assert.equal(outboxFiles.length, 1, "still only one alert file from the original breach");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scenario D — reset (below 10 → above 25) clears both markers", async () => {
  const dir = mkTmp("admin-quota-integ-");
  const cachePath = path.join(dir, "admin-quota.json");
  const adminUserDir = path.join(dir, "users", "admin");

  await quotaTick({ paneText: panePct(30, 20), cachePath, adminUserDir, adminJid: "admin@jid", now: 1000 });
  await quotaTick({ paneText: panePct(94, 20), cachePath, adminUserDir, adminJid: "admin@jid", now: 2000 });
  const r3 = await quotaTick({ paneText: panePct(5, 20), cachePath, adminUserDir, adminJid: "admin@jid", now: 3000 });
  assert.equal(r3.alertsEmitted, 0);

  const cached = readQuota(cachePath);
  assert.equal(cached.lastAlerted.session_10, null);
  assert.equal(cached.lastAlerted.session_25, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
