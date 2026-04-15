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
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

module.exports = { readQuota, writeQuota };
