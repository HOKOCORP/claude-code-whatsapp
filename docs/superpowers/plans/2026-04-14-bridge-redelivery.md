# Bridge Redelivery with JSONL Dedup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix post-auto-compact message loss. Bridge retains inbox files until it sees the message-id committed to `session.jsonl`, redelivers leftovers on startup, and retries stalled in-flight messages.

**Architecture:** Two new CommonJS modules under `lib/` (`jsonl-scan`, `inbox-reconciler`) plus a rewire of `bridge.cjs` — the existing "delete on notification success" path is replaced with a reconciler loop that reconciles inbox files against `session.jsonl`. No changes to gateway, cc-watchdog, or the MCP SDK.

**Tech Stack:** Node.js (CommonJS, `.cjs`), `node:test` for unit tests (already wired via `npm test`), `node:fs`, `node:path`, `node:os`. No new deps.

**Spec reference:** `docs/superpowers/specs/2026-04-14-bridge-redelivery-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/jsonl-scan.cjs` (NEW) | Session-jsonl discovery (`findSessionJsonl`), tail reader with mtime+inode cache (`readJsonlTail`), message-id presence check (`hasMessageId`), pure slug helper (`slugify`) |
| `lib/inbox-reconciler.cjs` (NEW) | Pure decision fn (`reconcileFile`) returning one of `"delete"`, `"send"`, `"resend"`, `"quarantine"`, or `"wait"`; factory (`createReconciler`) that wraps the fn with fs IO and state |
| `test/jsonl-scan.test.cjs` (NEW) | Unit tests for jsonl-scan |
| `test/inbox-reconciler.test.cjs` (NEW) | Unit tests for reconciler (pure fn + factory with mocked deps) |
| `bridge.cjs` (MODIFY) | Remove the `.then(unlinkSync)` delete. Replace the `setInterval(processInbox, 500)` with a 1s reconciler tick. Run the tick once immediately when `mcpReady` flips. |
| `README.md` (MODIFY, optional) | One-line note under the existing architecture section: bridge now redelivers across auto-compact via jsonl dedup |

---

## Task 1: jsonl-scan — slugify

**Files:**
- Create: `lib/jsonl-scan.cjs`
- Create: `test/jsonl-scan.test.cjs`

- [ ] **Step 1: Write the failing test**

Create `test/jsonl-scan.test.cjs`:
```js
const test = require("node:test");
const assert = require("node:assert/strict");
const js = require("../lib/jsonl-scan.cjs");

test("slugify replaces non-alphanumerics with dashes", () => {
  assert.equal(js.slugify("/home/wp-fundraising/workspace"), "-home-wp-fundraising-workspace");
  assert.equal(js.slugify("/a/b.c"), "-a-b-c");
  assert.equal(js.slugify("plain"), "plain");
  assert.equal(js.slugify(""), "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/jsonl-scan.test.cjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/jsonl-scan.cjs`:
```js
function slugify(cwd) {
  return String(cwd || "").replace(/[^a-zA-Z0-9]/g, "-");
}

module.exports = { slugify };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/jsonl-scan.test.cjs`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add lib/jsonl-scan.cjs test/jsonl-scan.test.cjs
git commit -m "feat(bridge): add jsonl-scan.slugify helper"
```

---

## Task 2: jsonl-scan — findSessionJsonl

**Files:**
- Modify: `lib/jsonl-scan.cjs`
- Modify: `test/jsonl-scan.test.cjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/jsonl-scan.test.cjs`:
```js
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("findSessionJsonl returns null when project dir missing", () => {
  const home = mkTmp("jsonl-scan-");
  const result = js.findSessionJsonl("/nonexistent/cwd", home);
  assert.equal(result, null);
  fs.rmSync(home, { recursive: true, force: true });
});

test("findSessionJsonl returns null when dir has no .jsonl files", () => {
  const home = mkTmp("jsonl-scan-");
  const cwd = "/some/workspace";
  const slug = js.slugify(cwd);
  const projDir = path.join(home, ".claude/projects", slug);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "notes.txt"), "x");
  const result = js.findSessionJsonl(cwd, home);
  assert.equal(result, null);
  fs.rmSync(home, { recursive: true, force: true });
});

test("findSessionJsonl ignores .jsonl.bak and returns newest .jsonl", async () => {
  const home = mkTmp("jsonl-scan-");
  const cwd = "/some/workspace";
  const slug = js.slugify(cwd);
  const projDir = path.join(home, ".claude/projects", slug);
  fs.mkdirSync(projDir, { recursive: true });
  const older = path.join(projDir, "aaa.jsonl");
  const newer = path.join(projDir, "zzz.jsonl");
  const bak = path.join(projDir, "bbb.jsonl.bak");
  fs.writeFileSync(older, "old");
  fs.writeFileSync(bak, "bak");
  // Force newer mtime on the new file
  await new Promise(r => setTimeout(r, 20));
  fs.writeFileSync(newer, "new");
  const result = js.findSessionJsonl(cwd, home);
  assert.equal(result, newer);
  fs.rmSync(home, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/jsonl-scan.test.cjs`
Expected: FAIL on the three new tests (`findSessionJsonl is not a function`).

- [ ] **Step 3: Add the implementation**

Add to `lib/jsonl-scan.cjs`:
```js
const fs = require("node:fs");
const path = require("node:path");

function findSessionJsonl(cwd, homeDir) {
  const slug = slugify(cwd);
  const projDir = path.join(homeDir, ".claude/projects", slug);
  let entries;
  try {
    entries = fs.readdirSync(projDir);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const jsonls = entries.filter((f) => f.endsWith(".jsonl"));
  if (jsonls.length === 0) return null;
  let newest = null;
  let newestMtime = -Infinity;
  for (const f of jsonls) {
    const fp = path.join(projDir, f);
    const stat = fs.statSync(fp);
    if (stat.mtimeMs > newestMtime) {
      newestMtime = stat.mtimeMs;
      newest = fp;
    }
  }
  return newest;
}

module.exports = { slugify, findSessionJsonl };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/jsonl-scan.test.cjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/jsonl-scan.cjs test/jsonl-scan.test.cjs
git commit -m "feat(bridge): add jsonl-scan.findSessionJsonl discovery"
```

---

## Task 3: jsonl-scan — readJsonlTail with cache

**Files:**
- Modify: `lib/jsonl-scan.cjs`
- Modify: `test/jsonl-scan.test.cjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/jsonl-scan.test.cjs`:
```js
test("readJsonlTail returns empty string when file missing", () => {
  const cache = {};
  const out = js.readJsonlTail("/nope/nope.jsonl", 1024, cache);
  assert.equal(out, "");
});

test("readJsonlTail returns full content when file smaller than window", () => {
  const home = mkTmp("jsonl-scan-");
  const fp = path.join(home, "small.jsonl");
  fs.writeFileSync(fp, "hello world");
  const cache = {};
  const out = js.readJsonlTail(fp, 1024, cache);
  assert.equal(out, "hello world");
  fs.rmSync(home, { recursive: true, force: true });
});

test("readJsonlTail returns only the tail bytes when file is larger than window", () => {
  const home = mkTmp("jsonl-scan-");
  const fp = path.join(home, "big.jsonl");
  fs.writeFileSync(fp, "A".repeat(100) + "TAIL_MARKER");
  const cache = {};
  const out = js.readJsonlTail(fp, 20, cache);
  assert.ok(out.endsWith("TAIL_MARKER"), `got: ${out}`);
  assert.equal(out.length, 20);
  fs.rmSync(home, { recursive: true, force: true });
});

test("readJsonlTail reuses cached text when mtime/inode unchanged", () => {
  const home = mkTmp("jsonl-scan-");
  const fp = path.join(home, "cached.jsonl");
  fs.writeFileSync(fp, "first-read");
  const cache = {};
  const first = js.readJsonlTail(fp, 1024, cache);
  // Mutate file contents on disk but DON'T touch mtime — readJsonlTail should hit cache.
  // (In practice mtime changes on write. We simulate a cache hit by not changing anything.)
  const second = js.readJsonlTail(fp, 1024, cache);
  assert.equal(first, "first-read");
  assert.equal(second, "first-read");
  assert.equal(cache.text, "first-read");
  fs.rmSync(home, { recursive: true, force: true });
});

test("readJsonlTail re-reads when mtime changes", async () => {
  const home = mkTmp("jsonl-scan-");
  const fp = path.join(home, "changing.jsonl");
  fs.writeFileSync(fp, "v1");
  const cache = {};
  const first = js.readJsonlTail(fp, 1024, cache);
  await new Promise(r => setTimeout(r, 20));
  fs.writeFileSync(fp, "v2");
  const second = js.readJsonlTail(fp, 1024, cache);
  assert.equal(first, "v1");
  assert.equal(second, "v2");
  fs.rmSync(home, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/jsonl-scan.test.cjs`
Expected: FAIL — `readJsonlTail is not a function`.

- [ ] **Step 3: Add the implementation**

Add to `lib/jsonl-scan.cjs` (before `module.exports`):
```js
function readJsonlTail(filePath, maxBytes, cache) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    if (e.code === "ENOENT") {
      cache.path = filePath;
      cache.mtimeMs = 0;
      cache.ino = 0;
      cache.text = "";
      return "";
    }
    throw e;
  }
  if (cache.path === filePath && cache.mtimeMs === stat.mtimeMs && cache.ino === stat.ino) {
    return cache.text;
  }
  const size = stat.size;
  const readFrom = Math.max(0, size - maxBytes);
  const length = size - readFrom;
  let text = "";
  if (length > 0) {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, readFrom);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }
  cache.path = filePath;
  cache.mtimeMs = stat.mtimeMs;
  cache.ino = stat.ino;
  cache.text = text;
  return text;
}
```

And update the export line:
```js
module.exports = { slugify, findSessionJsonl, readJsonlTail };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/jsonl-scan.test.cjs`
Expected: PASS, 9 tests total.

- [ ] **Step 5: Commit**

```bash
git add lib/jsonl-scan.cjs test/jsonl-scan.test.cjs
git commit -m "feat(bridge): add jsonl-scan.readJsonlTail with mtime cache"
```

---

## Task 4: jsonl-scan — hasMessageId

**Files:**
- Modify: `lib/jsonl-scan.cjs`
- Modify: `test/jsonl-scan.test.cjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/jsonl-scan.test.cjs`:
```js
test("hasMessageId finds a literal message_id=\"...\" occurrence", () => {
  const haystack = '{"content":"<channel message_id=\\"ABC123\\" ts=\\"...\\">"}';
  assert.equal(js.hasMessageId(haystack, "ABC123"), true);
});

test("hasMessageId returns false on absence", () => {
  const haystack = '{"content":"<channel message_id=\\"XYZ\\" >"}';
  assert.equal(js.hasMessageId(haystack, "ABC123"), false);
});

test("hasMessageId does not match a substring of a longer id", () => {
  // Longer id that merely contains "ABC123" as a prefix.
  const haystack = '{"content":"<channel message_id=\\"ABC1234567\\">"}';
  assert.equal(js.hasMessageId(haystack, "ABC123"), false);
});

test("hasMessageId rejects empty id", () => {
  assert.equal(js.hasMessageId("anything", ""), false);
  assert.equal(js.hasMessageId("anything", null), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/jsonl-scan.test.cjs`
Expected: FAIL — `hasMessageId is not a function`.

- [ ] **Step 3: Add the implementation**

Add to `lib/jsonl-scan.cjs`:
```js
function hasMessageId(tailText, id) {
  if (!id || typeof id !== "string") return false;
  // JSONL escapes the attribute as: message_id=\"<id>\"
  // A literal-string search for the exact escaped token disambiguates substring hits.
  const needle = `message_id=\\"${id}\\"`;
  return tailText.indexOf(needle) !== -1;
}
```

And update the export line:
```js
module.exports = { slugify, findSessionJsonl, readJsonlTail, hasMessageId };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/jsonl-scan.test.cjs`
Expected: PASS, 13 tests total.

- [ ] **Step 5: Commit**

```bash
git add lib/jsonl-scan.cjs test/jsonl-scan.test.cjs
git commit -m "feat(bridge): add jsonl-scan.hasMessageId dedup check"
```

---

## Task 5: reconciler — pure reconcileFile decision fn

**Files:**
- Create: `lib/inbox-reconciler.cjs`
- Create: `test/inbox-reconciler.test.cjs`

- [ ] **Step 1: Write the failing tests**

Create `test/inbox-reconciler.test.cjs`:
```js
const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("../lib/inbox-reconciler.cjs");

test("delete when id is already in jsonl", () => {
  const action = r.reconcileFile({
    id: "ABC", jsonlText: 'x message_id=\\"ABC\\" y',
    sendAttempts: null, now: 1000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });
  assert.equal(action.kind, "delete");
});

test("send when id not in jsonl and never sent", () => {
  const action = r.reconcileFile({
    id: "ABC", jsonlText: "no match here",
    sendAttempts: null, now: 1000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });
  assert.equal(action.kind, "send");
});

test("wait when id not in jsonl but sent recently", () => {
  const action = r.reconcileFile({
    id: "ABC", jsonlText: "no match",
    sendAttempts: { count: 1, firstSentAt: 500, lastSentAt: 500 }, now: 1000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });
  assert.equal(action.kind, "wait");
});

test("resend when last send is older than stalenessMs", () => {
  const action = r.reconcileFile({
    id: "ABC", jsonlText: "no match",
    sendAttempts: { count: 1, firstSentAt: 500, lastSentAt: 500 }, now: 22000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });
  assert.equal(action.kind, "resend");
});

test("quarantine when retries exhausted", () => {
  const action = r.reconcileFile({
    id: "ABC", jsonlText: "no match",
    sendAttempts: { count: 3, firstSentAt: 500, lastSentAt: 25000 }, now: 50000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });
  assert.equal(action.kind, "quarantine");
  assert.match(action.reason, /retries/);
});

test("quarantine when file age exceeds maxAgeMs", () => {
  const action = r.reconcileFile({
    id: "ABC", jsonlText: "no match",
    sendAttempts: { count: 1, firstSentAt: 500, lastSentAt: 1000 }, now: 400000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });
  assert.equal(action.kind, "quarantine");
  assert.match(action.reason, /age/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/inbox-reconciler.test.cjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `lib/inbox-reconciler.cjs`:
```js
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/inbox-reconciler.test.cjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/inbox-reconciler.cjs test/inbox-reconciler.test.cjs
git commit -m "feat(bridge): add reconcileFile pure decision function"
```

---

## Task 6: reconciler — tick loop factory

**Files:**
- Modify: `lib/inbox-reconciler.cjs`
- Modify: `test/inbox-reconciler.test.cjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/inbox-reconciler.test.cjs`:
```js
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeInbox(inboxDir, id, content) {
  const fp = path.join(inboxDir, `${Date.now()}-${id}.json`);
  fs.writeFileSync(fp, JSON.stringify({ content, meta: { message_id: id, chat_id: "c" } }));
  return fp;
}

test("tick: delivered files get unlinked, undelivered trigger send", () => {
  const userDir = mkTmp("recon-");
  const inbox = path.join(userDir, "inbox");
  fs.mkdirSync(inbox);
  const delivered = writeInbox(inbox, "DONE", "hi");
  const undelivered = writeInbox(inbox, "NEW", "hello");
  const jsonlText = 'pre message_id=\\"DONE\\" post';

  const sends = [];
  const tick = r.createReconciler({
    userDir,
    loadJsonl: () => jsonlText,
    sendNotification: (payload) => { sends.push(payload.meta.message_id); },
    now: () => 1000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });

  tick();
  assert.equal(fs.existsSync(delivered), false);
  assert.equal(fs.existsSync(undelivered), true);
  assert.deepEqual(sends, ["NEW"]);
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("tick: quarantined files are moved to inbox/failed/", () => {
  const userDir = mkTmp("recon-");
  const inbox = path.join(userDir, "inbox");
  fs.mkdirSync(inbox);
  const fp = writeInbox(inbox, "STUCK", "hello");

  let clock = 1000;
  const tick = r.createReconciler({
    userDir,
    loadJsonl: () => "no match",
    sendNotification: () => {},
    now: () => clock,
    stalenessMs: 5, maxAgeMs: 10000, maxRetries: 3,
  });

  // First tick: send
  tick();
  // Trigger two resends to exhaust retries
  clock += 10; tick();
  clock += 10; tick();
  clock += 10; tick(); // this triggers quarantine

  assert.equal(fs.existsSync(fp), false);
  const failedDir = path.join(inbox, "failed");
  assert.ok(fs.existsSync(failedDir));
  const failedFiles = fs.readdirSync(failedDir);
  assert.equal(failedFiles.length, 1);
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("tick: resends after staleness window", () => {
  const userDir = mkTmp("recon-");
  const inbox = path.join(userDir, "inbox");
  fs.mkdirSync(inbox);
  writeInbox(inbox, "SLOW", "hello");

  let clock = 1000;
  const sends = [];
  const tick = r.createReconciler({
    userDir,
    loadJsonl: () => "no match",
    sendNotification: (p) => { sends.push([p.meta.message_id, clock]); },
    now: () => clock,
    stalenessMs: 100, maxAgeMs: 10000, maxRetries: 10,
  });

  tick();              // send #1
  clock += 50;
  tick();              // wait — within staleness window
  clock += 100;
  tick();              // resend #2 — past staleness window

  assert.equal(sends.length, 2);
  assert.equal(sends[0][0], "SLOW");
  assert.equal(sends[1][0], "SLOW");
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("tick: gracefully skips files with malformed JSON", () => {
  const userDir = mkTmp("recon-");
  const inbox = path.join(userDir, "inbox");
  fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(inbox, "bad.json"), "{ not json");

  const tick = r.createReconciler({
    userDir,
    loadJsonl: () => "",
    sendNotification: () => { throw new Error("should not be called"); },
    now: () => 1000,
    stalenessMs: 20000, maxAgeMs: 300000, maxRetries: 3,
  });

  // Should not throw.
  tick();
  fs.rmSync(userDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/inbox-reconciler.test.cjs`
Expected: FAIL — `createReconciler is not a function`.

- [ ] **Step 3: Add the implementation**

Add to `lib/inbox-reconciler.cjs` (before `module.exports`):
```js
const fs = require("node:fs");
const path = require("node:path");

function createReconciler({ userDir, loadJsonl, sendNotification, now, stalenessMs, maxAgeMs, maxRetries, log }) {
  const inboxDir = path.join(userDir, "inbox");
  const failedDir = path.join(inboxDir, "failed");
  const sendAttempts = new Map(); // filename -> { count, firstSentAt, lastSentAt }
  const logFn = log || (() => {});

  function quarantine(filename, reason) {
    try {
      fs.mkdirSync(failedDir, { recursive: true });
      fs.renameSync(path.join(inboxDir, filename), path.join(failedDir, filename));
      logFn(`quarantined ${filename}: ${reason}`);
    } catch (e) {
      logFn(`quarantine failed for ${filename}: ${e.message}`);
    }
    sendAttempts.delete(filename);
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/inbox-reconciler.test.cjs`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/inbox-reconciler.cjs test/inbox-reconciler.test.cjs
git commit -m "feat(bridge): add reconciler tick loop factory"
```

---

## Task 7: Wire reconciler into bridge.cjs

**Files:**
- Modify: `bridge.cjs`

- [ ] **Step 1: Read the current bridge.cjs to confirm line numbers**

Read `bridge.cjs`. Confirm:
- Requires are lines 9-14.
- `processInbox` function is lines 56-82.
- `const inboxPoll = setInterval(processInbox, 500);` is line 84.
- `mcpReady` flips inside `main()` at line ~278 with the 3s delay.

- [ ] **Step 2: Add new requires at the top of bridge.cjs**

Locate the existing requires block (around lines 9-14) and append:
```js
const os = require("node:os");
const jsonlScan = require("./lib/jsonl-scan.cjs");
const inboxReconciler = require("./lib/inbox-reconciler.cjs");
```

- [ ] **Step 3: Add the jsonl-path resolver helper**

Immediately after the `log` helper (around line 29), add:
```js
let jsonlPath = null;
let jsonlPathResolvedAt = 0;
const jsonlCache = {};

function resolveJsonlPath() {
  const now = Date.now();
  if (jsonlPath && fs.existsSync(jsonlPath) && now - jsonlPathResolvedAt < 30000) {
    return jsonlPath;
  }
  jsonlPath = jsonlScan.findSessionJsonl(process.cwd(), os.homedir());
  jsonlPathResolvedAt = now;
  if (!jsonlPath) log(`warn: no session.jsonl found for cwd=${process.cwd()}`);
  return jsonlPath;
}

function loadJsonlTail() {
  const p = resolveJsonlPath();
  if (!p) return "";
  return jsonlScan.readJsonlTail(p, 262144, jsonlCache);
}
```

- [ ] **Step 4: Replace processInbox with reconciler-backed version**

Replace the body of `processInbox` (lines 56-82) and the `setInterval` line 84 with:
```js
const reconcilerTick = inboxReconciler.createReconciler({
  userDir: USER_DIR,
  loadJsonl: loadJsonlTail,
  sendNotification: ({ content, meta }) => {
    lastMessage = { text: content || "", number: meta?.user || "" };
    if (meta?.chat_id) writeOutbox({ action: "typing_start", chat_id: meta.chat_id });
    mcp.notification({ method: "notifications/claude/channel", params: { content, meta } })
      .catch((err) => log(`deliver failed: ${err}`));
  },
  now: () => Date.now(),
  stalenessMs: 20000,
  maxAgeMs: 5 * 60 * 1000,
  maxRetries: 3,
  log,
});

function processInbox() {
  if (!mcpReady) return;
  reconcilerTick();
}

const inboxPoll = setInterval(processInbox, 1000);
```

Note: `writeOutbox` is defined below `processInbox` in the original file. Function declarations are hoisted so this still works, but double-check during the edit that the `writeOutbox` ref is in scope when the closure runs (it will be — JS function declarations are hoisted within the module).

- [ ] **Step 5: Run the existing tests to make sure nothing regressed**

Run: `npm test`
Expected: all tests pass (29 from channel-slash, plus the 13+10 new ones from Tasks 1-6).

- [ ] **Step 6: Syntax-check bridge.cjs itself**

Run: `node --check bridge.cjs`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add bridge.cjs
git commit -m "feat(bridge): replace delete-on-notify with jsonl-dedup reconciler

Fixes post-auto-compact message loss. Bridge now keeps inbox files
until it observes the message_id in session.jsonl, retries stalled
in-flight messages, and redelivers leftovers after crash/respawn."
```

---

## Task 8: Manual smoke test

**Files:** none (runtime check)

- [ ] **Step 1: Pick the target user-dir to test against**

Run: `ls -lah ~/.ccm/users/`
Identify the workspace user dir (the one matching the test WhatsApp account). Call it `$UD`.

- [ ] **Step 2: Confirm no stale inbox files before the test**

Run: `ls "$UD/inbox" 2>/dev/null | grep -v failed || echo empty`
Expected: `empty`, or only `.tmp` crumbs (none).

- [ ] **Step 3: Restart the gateway to pick up the new bridge code**

Run: the project's usual gateway-restart command (e.g., `sudo systemctl restart ccm-gateway` or the restart script under `bin/`). cc-watchdog will respawn claude, claude will respawn the bridge with the new code.

- [ ] **Step 4: Live test — normal delivery**

Send a WhatsApp message ("hello test 1"). Confirm claude replies. Then:
```bash
ls "$UD/inbox" | grep -v failed
```
Expected: empty (reconciler unlinked after seeing the id in jsonl).

- [ ] **Step 5: Live test — auto-compact redelivery**

From the user's WhatsApp, run `/compact` (once that feature is wired up) or force a compact in the terminal. Then while the compact is in-flight, send "test during compact". After compact completes, confirm the message is answered rather than silently dropped.

If the feature isn't convenient to trigger live, simulate it:
1. `tmux kill-session -t <session-name-for-the-user>` while an inbox file is present.
2. Wait for cc-watchdog to respawn.
3. Confirm within ~5s the inbox file disappears and claude replies to the pending message.

- [ ] **Step 6: Failure-path check**

Drop a deliberately-malformed file into inbox:
```bash
echo '{ broken' > "$UD/inbox/manual-bad.json"
```
Within 1-2s it should move to `$UD/inbox/failed/`. Confirm:
```bash
ls "$UD/inbox/failed/"
```
Expected: `manual-bad.json` present. Bridge log shows `quarantined`.

- [ ] **Step 7: Revert the failure-path artifact**

```bash
rm "$UD/inbox/failed/manual-bad.json"
```

---

## Task 9: README touch-up (optional, skip if not maintaining README)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Locate the architecture section in README**

Search for the section describing `bridge.cjs`. Typically under "Architecture" or "Components".

- [ ] **Step 2: Add a one-line note**

Insert under the bridge description:
> The bridge retains each inbox message until it confirms Claude committed the message-id to `session.jsonl`, then dedups. This survives auto-compact and cc-watchdog respawns.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: note bridge redelivery/dedup behavior"
```

---

## Done

Full test suite should now show ~52 passing tests. Bridge no longer loses messages across auto-compact. No upstream changes required.
