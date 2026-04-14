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

const fs = require("node:fs");
const path = require("node:path");

function createReconciler({ userDir, loadJsonl, sendNotification, now, stalenessMs, maxAgeMs, maxRetries, log }) {
  const inboxDir = path.join(userDir, "inbox");
  const failedDir = path.join(inboxDir, "failed");
  const sendAttempts = new Map();
  const logFn = log || (() => {});

  function quarantine(filename, reason) {
    try {
      fs.mkdirSync(failedDir, { recursive: true });
      fs.renameSync(path.join(inboxDir, filename), path.join(failedDir, filename));
      sendAttempts.delete(filename);
      logFn(`quarantined ${filename}: ${reason}`);
    } catch (e) {
      logFn(`quarantine failed for ${filename}: ${e.message}`);
      // Intentionally retain sendAttempts so the next tick re-enters quarantine
      // rather than starting a fresh send cycle.
    }
  }

  function deliver(filename, data) {
    const t = now();
    const prev = sendAttempts.get(filename);
    sendAttempts.set(filename, {
      count: (prev?.count || 0) + 1,
      firstSentAt: prev?.firstSentAt || t,
      lastSentAt: t,
    });
    try {
      sendNotification({ content: data.content, meta: data.meta });
    } catch (e) {
      logFn(`send failed for ${filename}: ${e.message}`);
    }
  }

  return function tick() {
    let files;
    try {
      files = fs.readdirSync(inboxDir).filter((f) => f.endsWith(".json")).sort();
    } catch { return; }

    let jsonlText = "";
    try { jsonlText = loadJsonl() || ""; } catch (e) { logFn(`loadJsonl error: ${e.message}`); }

    for (const filename of files) {
      const fp = path.join(inboxDir, filename);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(fp, "utf8"));
      } catch (e) {
        logFn(`malformed inbox file ${filename}: ${e.message} — quarantining`);
        quarantine(filename, "malformed json");
        continue;
      }
      const id = data?.meta?.message_id;
      if (!id) {
        logFn(`inbox file ${filename} has no meta.message_id — quarantining`);
        quarantine(filename, "missing message_id");
        continue;
      }
      const action = reconcileFile({
        id, jsonlText,
        sendAttempts: sendAttempts.get(filename) || null,
        now: now(),
        stalenessMs, maxAgeMs, maxRetries,
      });
      if (action.kind === "delete") {
        try { fs.unlinkSync(fp); } catch {}
        sendAttempts.delete(filename);
      } else if (action.kind === "send" || action.kind === "resend") {
        deliver(filename, data);
      } else if (action.kind === "quarantine") {
        quarantine(filename, action.reason);
      }
      // "wait" → no-op
    }
  };
}

module.exports = { reconcileFile, createReconciler };
