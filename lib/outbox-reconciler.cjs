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

const fs = require("node:fs");
const path = require("node:path");

function createOutboxReconciler({ outboxDir, sendFn, ackedIds, now, stalenessMs, maxAgeMs, maxRetries, log }) {
  const failedDir = path.join(outboxDir, "failed");
  const sendState = new Map();
  const logFn = log || (() => {});

  function quarantine(filename, reason) {
    try {
      fs.mkdirSync(failedDir, { recursive: true });
      fs.renameSync(path.join(outboxDir, filename), path.join(failedDir, filename));
      sendState.delete(filename);
      logFn(`outbox quarantined ${filename}: ${reason}`);
    } catch (e) {
      logFn(`outbox quarantine failed for ${filename}: ${e.message}`);
      // Intentionally retain sendState so the next tick re-enters quarantine
      // rather than resetting to a fresh send cycle.
    }
  }

  async function attemptSend(filename, data) {
    const t = now();
    const prev = sendState.get(filename);
    const nextAttempts = (prev?.attempts || 0) + 1;
    const firstSentAt = prev?.firstSentAt || t;
    let result;
    try {
      result = await sendFn(data);
    } catch (e) {
      logFn(`outbox send failed for ${filename}: ${e.message}`);
      sendState.set(filename, {
        msgIds: prev?.msgIds || new Set(),
        firstSentAt, lastSentAt: t, attempts: nextAttempts,
      });
      return;
    }
    if (result && result.fireAndForget === true) {
      try { fs.unlinkSync(path.join(outboxDir, filename)); } catch {}
      sendState.delete(filename);
      return;
    }
    const msgIds = new Set(prev?.msgIds || []);
    for (const id of (result?.msgIds || [])) msgIds.add(id);
    sendState.set(filename, { msgIds, firstSentAt, lastSentAt: t, attempts: nextAttempts });
    if (msgIds.size > 0) {
      let allAcked = true;
      for (const id of msgIds) if (!ackedIds.has(id)) { allAcked = false; break; }
      if (allAcked) {
        try { fs.unlinkSync(path.join(outboxDir, filename)); } catch {}
        sendState.delete(filename);
      }
    }
  }

  return async function tick() {
    let files;
    try {
      files = fs.readdirSync(outboxDir).filter((f) => f.endsWith(".json")).sort();
    } catch { return; }

    for (const filename of files) {
      const fp = path.join(outboxDir, filename);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(fp, "utf8"));
      } catch (e) {
        logFn(`outbox malformed JSON ${filename}: ${e.message}`);
        quarantine(filename, "malformed json");
        continue;
      }
      const action = reconcileOutboxFile({
        sendState: sendState.get(filename) || null,
        ackedIds,
        now: now(),
        stalenessMs, maxAgeMs, maxRetries,
      });
      if (action.kind === "delete") {
        try { fs.unlinkSync(fp); } catch {}
        sendState.delete(filename);
      } else if (action.kind === "send" || action.kind === "resend") {
        await attemptSend(filename, data);
      } else if (action.kind === "quarantine") {
        quarantine(filename, action.reason);
      }
    }
  };
}

module.exports = { reconcileOutboxFile, createOutboxReconciler };
