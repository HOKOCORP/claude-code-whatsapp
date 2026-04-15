const SESSION_RE       = /Current session[\s\S]*?\b(\d{1,3})%\s*used/i;
const WEEK_RE          = /Current week \(all models\)[\s\S]*?\b(\d{1,3})%\s*used/i;
const SESSION_RESET_RE = /Current session[\s\S]*?Resets\s+([^\n]+)/i;
const WEEK_RESET_RE    = /Current week \(all models\)[\s\S]*?Resets\s+([^\n]+)/i;
const LOADING_RE       = /Loading usage data/i;

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

async function doCapture({ tmuxSession, sendKeys, capturePane, sleep, now, renderDelayMs, tabDelayMs, loadDelayMs, loadRetries }) {
  let snapshot = null;
  try {
    await sendKeys(tmuxSession, ["/status", "Enter"]);
    await sleep(renderDelayMs);
    await sendKeys(tmuxSession, ["Right"]);
    await sleep(tabDelayMs);
    await sendKeys(tmuxSession, ["Right"]);
    await sleep(tabDelayMs);
    let pane = await capturePane(tmuxSession);
    let attempts = 0;
    while (LOADING_RE.test(pane) && attempts < loadRetries) {
      await sleep(loadDelayMs);
      pane = await capturePane(tmuxSession);
      attempts++;
    }
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
  loadDelayMs = 500,
  loadRetries = 6,
}) {
  if (inFlight) return inFlight;
  inFlight = doCapture({ tmuxSession, sendKeys, capturePane, sleep, now, renderDelayMs, tabDelayMs, loadDelayMs, loadRetries });
  try { return await inFlight; }
  finally { inFlight = null; }
}

module.exports = { captureQuota };
