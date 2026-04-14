"use strict";
/**
 * Integration test: bridge redelivery fix — auto-compact-loss scenario.
 *
 * Uses REAL jsonl-scan.findSessionJsonl + readJsonlTail + inbox-reconciler.createReconciler.
 * Only sendNotification is mocked (captures calls to an array).
 *
 * Three scenarios:
 *   1. Normal delivery with dedup (inbox file unlinked once message_id appears in jsonl).
 *   2. Auto-compact simulation — bridge restart forces redelivery of an unconfirmed message.
 *   3. Retry after staleness window.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const jsonlScan = require("../lib/jsonl-scan.cjs");
const { createReconciler } = require("../lib/inbox-reconciler.cjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Append a line to a jsonl file that makes hasMessageId(text, id) return true.
 * The file must contain the literal byte sequence:  message_id=\"<id>\"
 * which in a JS string is written with \" for each escaped-quote.
 *
 * After appending, bump mtime by a few ms so that readJsonlTail's cache
 * is always invalidated, even when the append happens in the same
 * OS mtime-granularity window as the previous write (common in fast tests).
 */
function commitToJsonl(jsonlPath, id) {
  fs.appendFileSync(
    jsonlPath,
    `\n{"type":"queue-operation","content":"message_id=\\"${id}\\""}\n`
  );
  // Bump mtime so the readJsonlTail cache is invalidated reliably.
  const s = fs.statSync(jsonlPath);
  const bumped = new Date(s.mtimeMs + 4);
  fs.utimesSync(jsonlPath, bumped, bumped);
}

/**
 * Write an inbox JSON file.
 * filename format: <ts>-<id>.json  (sortable, matches the reconciler's sort order)
 */
function writeInboxFile(inboxDir, filename, id, content) {
  const fp = path.join(inboxDir, filename);
  fs.writeFileSync(
    fp,
    JSON.stringify({ content, meta: { message_id: id, chat_id: "c", user: "u" } })
  );
  return fp;
}

/**
 * Build the loadJsonl callback exactly as bridge.cjs does:
 *   findSessionJsonl(cwd, homeDir) → path → readJsonlTail(path, 256*1024, cache)
 */
function makeLoadJsonl(cwd, homeDir, cache) {
  return function loadJsonl() {
    const jsonlPath = jsonlScan.findSessionJsonl(cwd, homeDir);
    if (!jsonlPath) return "";
    return jsonlScan.readJsonlTail(jsonlPath, 256 * 1024, cache);
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 — normal delivery with dedup
// ---------------------------------------------------------------------------

test("scenario 1: normal delivery — inbox file unlinked after message_id appears in jsonl", () => {
  const homeDir = mkTmp("bridge-integ-home-");
  const cwd = "/fake/project/scenario1";

  // Set up the project jsonl under ~/.claude/projects/<slug>/
  const slug = jsonlScan.slugify(cwd);
  const projDir = path.join(homeDir, ".claude", "projects", slug);
  fs.mkdirSync(projDir, { recursive: true });
  const jsonlPath = path.join(projDir, "session.jsonl");
  fs.writeFileSync(jsonlPath, "initial jsonl content\n");

  // Set up userDir and inbox
  const userDir = mkTmp("bridge-integ-user-");
  const inboxDir = path.join(userDir, "inbox");
  fs.mkdirSync(inboxDir);

  // Write inbox file for MSG1
  const inboxFile = writeInboxFile(inboxDir, "1000-MSG1.json", "MSG1", "hi");

  // Wire reconciler with real jsonl-scan deps
  const cache = {};
  const sends = [];
  const tick = createReconciler({
    userDir,
    loadJsonl: makeLoadJsonl(cwd, homeDir, cache),
    sendNotification: (payload) => { sends.push(payload.meta.message_id); },
    now: () => 1000,
    stalenessMs: 20000,
    maxAgeMs: 300000,
    maxRetries: 5,
  });

  // First tick: MSG1 should be sent; inbox file still present (not yet in jsonl)
  tick();
  assert.deepEqual(sends, ["MSG1"], "first tick should send MSG1");
  assert.ok(fs.existsSync(inboxFile), "inbox file should still exist before jsonl commit");

  // Simulate Claude committing MSG1 to the jsonl
  commitToJsonl(jsonlPath, "MSG1");

  // Second tick: MSG1 now found in jsonl tail — no new send; file unlinked
  tick();
  assert.deepEqual(sends, ["MSG1"], "second tick should NOT resend MSG1");
  assert.equal(fs.existsSync(inboxFile), false, "inbox file should be unlinked after jsonl commit");

  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(userDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scenario 2 — auto-compact simulation (bridge restart forces redelivery)
// ---------------------------------------------------------------------------

test("scenario 2: auto-compact simulation — fresh reconciler redelivers unconfirmed message", () => {
  const homeDir = mkTmp("bridge-integ-home-");
  const cwd = "/fake/project/scenario2";

  const slug = jsonlScan.slugify(cwd);
  const projDir = path.join(homeDir, ".claude", "projects", slug);
  fs.mkdirSync(projDir, { recursive: true });
  const jsonlPath = path.join(projDir, "session.jsonl");
  fs.writeFileSync(jsonlPath, "initial jsonl content\n");

  const userDir = mkTmp("bridge-integ-user-");
  const inboxDir = path.join(userDir, "inbox");
  fs.mkdirSync(inboxDir);

  // --- Phase A: first reconciler sends MSG2 ---
  const inboxFile = writeInboxFile(inboxDir, "2000-MSG2.json", "MSG2", "hello");

  const cache1 = {};
  const sends1 = [];
  const tick1 = createReconciler({
    userDir,
    loadJsonl: makeLoadJsonl(cwd, homeDir, cache1),
    sendNotification: (payload) => { sends1.push(payload.meta.message_id); },
    now: () => 2000,
    stalenessMs: 20000,
    maxAgeMs: 300000,
    maxRetries: 5,
  });

  tick1();
  assert.deepEqual(sends1, ["MSG2"], "first reconciler tick should send MSG2");
  assert.ok(fs.existsSync(inboxFile), "inbox file still present — not yet confirmed in jsonl");

  // Auto-compact: MSG2 is NOT written to jsonl (simulates the lost-notification window).
  // Bridge process restarts — discard tick1 / sends1, create a fresh reconciler.

  // --- Phase B: fresh reconciler (simulates bridge restart) — must redeliver MSG2 ---
  const cache2 = {};
  const sends2 = [];
  const tick2 = createReconciler({
    userDir,
    loadJsonl: makeLoadJsonl(cwd, homeDir, cache2),
    sendNotification: (payload) => { sends2.push(payload.meta.message_id); },
    now: () => 3000,
    stalenessMs: 20000,
    maxAgeMs: 300000,
    maxRetries: 5,
  });

  // KEY assertion: fresh reconciler has no send-attempt state → reconcileFile sees
  // sendAttempts=null → action.kind="send" → redelivery happens.
  tick2();
  assert.deepEqual(sends2, ["MSG2"], "fresh reconciler must redeliver MSG2 (the fix under test)");
  assert.ok(fs.existsSync(inboxFile), "inbox file still present — MSG2 not yet in jsonl");

  // Now simulate Claude actually committing MSG2
  commitToJsonl(jsonlPath, "MSG2");

  // Next tick: confirmed — file unlinked
  tick2();
  assert.deepEqual(sends2, ["MSG2"], "no additional send after jsonl commit");
  assert.equal(fs.existsSync(inboxFile), false, "inbox file unlinked after commit");

  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(userDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scenario 3 — retry after staleness window
// ---------------------------------------------------------------------------

test("scenario 3: retry after staleness window", () => {
  const homeDir = mkTmp("bridge-integ-home-");
  const cwd = "/fake/project/scenario3";

  const slug = jsonlScan.slugify(cwd);
  const projDir = path.join(homeDir, ".claude", "projects", slug);
  fs.mkdirSync(projDir, { recursive: true });
  const jsonlPath = path.join(projDir, "session.jsonl");
  fs.writeFileSync(jsonlPath, "initial jsonl content\n");

  const userDir = mkTmp("bridge-integ-user-");
  const inboxDir = path.join(userDir, "inbox");
  fs.mkdirSync(inboxDir);

  const inboxFile = writeInboxFile(inboxDir, "3000-MSG3.json", "MSG3", "world");

  let clock = 1000;
  const cache = {};
  const sends = [];
  const tick = createReconciler({
    userDir,
    loadJsonl: makeLoadJsonl(cwd, homeDir, cache),
    sendNotification: (payload) => { sends.push({ id: payload.meta.message_id, t: clock }); },
    now: () => clock,
    stalenessMs: 100,
    maxAgeMs: 300000,
    maxRetries: 5,
  });

  // Tick at t=1000: first send
  tick();
  assert.equal(sends.length, 1, "should send once at t=1000");
  assert.equal(sends[0].id, "MSG3");
  assert.ok(fs.existsSync(inboxFile), "inbox file present after first send");

  // Tick at t=1050 (within staleness window of 100ms): no new send
  clock = 1050;
  tick();
  assert.equal(sends.length, 1, "no new send within staleness window (t=1050)");
  assert.ok(fs.existsSync(inboxFile), "inbox file still present");

  // Tick at t=1200 (past stalenessMs=100 from lastSentAt=1000): resend
  clock = 1200;
  tick();
  assert.equal(sends.length, 2, "resend after staleness window (t=1200)");
  assert.equal(sends[1].id, "MSG3");
  assert.ok(fs.existsSync(inboxFile), "inbox file still present after resend");

  // Commit MSG3 to jsonl
  commitToJsonl(jsonlPath, "MSG3");

  // Next tick: confirmed — file unlinked, no new send
  clock = 1300;
  tick();
  assert.equal(sends.length, 2, "no additional send after commit");
  assert.equal(fs.existsSync(inboxFile), false, "inbox file unlinked after commit");

  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(userDir, { recursive: true, force: true });
});
