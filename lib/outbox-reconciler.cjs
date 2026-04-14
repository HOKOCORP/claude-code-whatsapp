function reconcileOutboxFile({ sendState, ackedIds, now, stalenessMs, maxAgeMs, maxRetries }) {
  if (sendState && sendState.msgIds && sendState.msgIds.size > 0) {
    let allAcked = true;
    for (const id of sendState.msgIds) {
      if (!ackedIds.has(id)) { allAcked = false; break; }
    }
    if (allAcked) return { kind: "delete" };
  }
  if (!sendState) return { kind: "send" };
  if (sendState.attempts >= maxRetries) {
    return { kind: "quarantine", reason: "retries exhausted" };
  }
  if (now - sendState.firstSentAt > maxAgeMs) {
    return { kind: "quarantine", reason: "age exceeded" };
  }
  if (now - sendState.lastSentAt > stalenessMs) return { kind: "resend" };
  return { kind: "wait" };
}

module.exports = { reconcileOutboxFile };
