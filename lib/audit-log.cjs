const fs = require("node:fs");
const path = require("node:path");

function createAuditLogger({ outboxDir, now, log }) {
  const clock = now || (() => Date.now());
  const logFn = log || (() => {});
  const logPath = path.join(outboxDir, "audit.jsonl");
  let warned = false;
  return function auditEvent(event, extras) {
    const entry = { ts: clock(), event };
    if (extras && typeof extras === "object") {
      for (const [k, v] of Object.entries(extras)) {
        if (v !== undefined) entry[k] = v;
      }
    }
    try {
      fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
    } catch (e) {
      if (!warned) {
        warned = true;
        logFn(`audit log write failed for ${logPath}: ${e.message}`);
      }
    }
  };
}

module.exports = { createAuditLogger };
