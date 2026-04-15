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

    const transitionedThresholds = [];
    for (const t of THRESHOLDS) {
      const key = `${win}_${t}`;
      if (prevPct >= t && curPct < t && lastAlerted[key] == null) {
        transitionedThresholds.push(t);
      }
    }
    if (transitionedThresholds.length > 0) {
      const threshold = Math.min(...transitionedThresholds);
      alertsToFire.push({ window: win, threshold, remaining: curPct });
    }

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
