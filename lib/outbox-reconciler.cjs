function reconcileOutboxFile({ sendState, ackedIds, erroredIds, now, stalenessMs, maxAgeMs, maxRetries }) {
  if (sendState && sendState.msgIds && sendState.msgIds.size > 0 && erroredIds) {
    for (const id of sendState.msgIds) {
      if (erroredIds.has(id)) return { kind: "quarantine", reason: "server error" };
    }
  }
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

function createOutboxReconciler({
  outboxDir, sendFn,
  ackedIds, erroredIds,
  now, stalenessMs, maxAgeMs, maxRetries,
  auditEvent, registerMsgIds, unregisterFile,
  log,
}) {
  const failedDir = path.join(outboxDir, "failed");
  const sendState = new Map();
  const logFn = log || (() => {});
  const audit = auditEvent || (() => {});
  const register = registerMsgIds || (() => {});
  const unregister = unregisterFile || (() => {});
  const errored = erroredIds || new Set();

  function quarantine(filename, reason, chatId) {
    try {
      fs.mkdirSync(failedDir, { recursive: true });
      fs.renameSync(path.join(outboxDir, filename), path.join(failedDir, filename));
      audit("quarantine", { filename, chat_id: chatId, reason });
      unregister(filename);
      sendState.delete(filename);
      logFn(`outbox quarantined ${filename}: ${reason}`);
    } catch (e) {
      logFn(`outbox quarantine failed for ${filename}: ${e.message}`);
      // Intentionally retain sendState so the next tick re-enters quarantine
      // rather than resetting to a fresh send cycle.
    }
  }

  async function attemptSend(filename, data, isRetry) {
    const t = now();
    const prev = sendState.get(filename);
    const nextAttempts = (prev?.attempts || 0) + 1;
    const firstSentAt = prev?.firstSentAt || t;
    if (isRetry) audit("retry", { filename, chat_id: data.chat_id, attempts: nextAttempts });
    let result;
    try {
      // Hard timeout on sendFn. Baileys sock.sendMessage can hang
      // indefinitely if the underlying socket is half-open during a
      // reconnect or if link-preview generation stalls. Since the
      // reconciler tick holds an outbox-wide busy lock while awaiting
      // this, a single hang used to silently block every outbound
      // message across all chats until something unstuck it. Racing
      // against a timer promotes a hang into a normal send failure
      // so the retry/quarantine state machine can do its job.
      const SEND_TIMEOUT_MS = 20000;
      result = await Promise.race([
        sendFn(data),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`sendFn timeout after ${SEND_TIMEOUT_MS}ms`)), SEND_TIMEOUT_MS)),
      ]);
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
      unregister(filename);
      sendState.delete(filename);
      return;
    }
    const newIds = Array.from(result?.msgIds || []);
    // On retry, replace tracked IDs with only the new message's ID(s).
    // The old message ID is superseded; delivery_ack will only arrive for the resent msg.
    const msgIds = isRetry ? new Set() : new Set(prev?.msgIds || []);
    for (const id of newIds) msgIds.add(id);
    if (newIds.length > 0) {
      register(filename, newIds, data.chat_id);
      audit("send", { filename, chat_id: data.chat_id, msg_ids: newIds });
    }
    sendState.set(filename, { msgIds, firstSentAt, lastSentAt: t, attempts: nextAttempts });
    if (msgIds.size > 0) {
      let allAcked = true;
      for (const id of msgIds) if (!ackedIds.has(id)) { allAcked = false; break; }
      if (allAcked) {
        try { fs.unlinkSync(path.join(outboxDir, filename)); } catch {}
        unregister(filename);
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
        quarantine(filename, "malformed json", undefined);
        continue;
      }
      const action = reconcileOutboxFile({
        sendState: sendState.get(filename) || null,
        ackedIds, erroredIds: errored,
        now: now(),
        stalenessMs, maxAgeMs, maxRetries,
      });
      if (action.kind === "delete") {
        try { fs.unlinkSync(fp); } catch {}
        unregister(filename);
        sendState.delete(filename);
      } else if (action.kind === "send") {
        await attemptSend(filename, data, false);
      } else if (action.kind === "resend") {
        await attemptSend(filename, data, true);
      } else if (action.kind === "quarantine") {
        quarantine(filename, action.reason, data.chat_id);
      }
    }
  };
}

module.exports = { reconcileOutboxFile, createOutboxReconciler };
