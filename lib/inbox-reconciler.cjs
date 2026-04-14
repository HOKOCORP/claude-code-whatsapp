const jsonlScan = require("./jsonl-scan.cjs");

function reconcileFile({ id, jsonlText, sendAttempts, now, stalenessMs, maxAgeMs, maxRetries }) {
  if (jsonlScan.hasMessageId(jsonlText, id)) return { kind: "delete" };
  if (!sendAttempts) return { kind: "send" };
  if (sendAttempts.count >= maxRetries) {
    return { kind: "quarantine", reason: "retries exhausted" };
  }
  if (now - sendAttempts.firstSentAt > maxAgeMs) {
    return { kind: "quarantine", reason: "age exceeded" };
  }
  if (now - sendAttempts.lastSentAt > stalenessMs) return { kind: "resend" };
  return { kind: "wait" };
}

module.exports = { reconcileFile };
