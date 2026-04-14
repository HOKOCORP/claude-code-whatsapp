# Channel Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/help`, `/clear`, and `/compact` slash commands to the WhatsApp channel gateway, alongside the existing `/usage` handler. Destructive commands are gated by an OTP-style 4-digit code with 90s TTL.

**Architecture:** Four new CommonJS modules under `lib/` (`pending-action`, `checkpoint`, `tmux`, `channel-slash`) plus a single dispatch insert in `gateway.cjs` immediately before the existing `/usage` handler at line 1169. The new dispatcher short-circuits handled messages and falls through everything else. Existing `/usage` code is NOT touched. The dispatcher takes its tmux dependency by injection so unit tests can stub it.

**Tech Stack:** Node.js (CommonJS, `.cjs`), `node:test` for unit tests (built-in, no new deps), `node:fs/promises`, `node:crypto`, `tmux` invoked via `execFileSync` (array-args form — no shell, no injection surface).

**Spec reference:** `docs/superpowers/specs/2026-04-14-channel-slash-commands-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/pending-action.cjs` (NEW) | Pending OTP state file: write, read with TTL check, clear, code generation |
| `lib/checkpoint.cjs` (NEW) | Checkpoint creation: mkdir, atomic `mv` of project dir, meta.json write, prune-to-10 retention |
| `lib/tmux.cjs` (NEW) | Thin wrapper around `tmux capture-pane`, `tmux send-keys`, `tmux kill-session` using `execFileSync` (array-args, no shell) |
| `lib/channel-slash.cjs` (NEW) | The `handleChannelSlashCommand` dispatcher: matches `/help`, `/clear`, `/compact`, and OTP code replies; orchestrates `pending-action` + `checkpoint` + injected `tmux` |
| `test/pending-action.test.cjs` (NEW) | Unit tests for pending-action |
| `test/checkpoint.test.cjs` (NEW) | Unit tests for checkpoint |
| `test/channel-slash.test.cjs` (NEW) | Unit tests for the dispatcher (stubbed tmux) |
| `gateway.cjs` (MODIFY: top + line 1167 area) | Two `require` lines, one dispatch block before line 1169 |
| `package.json` (MODIFY) | Add `"test": "node --test test/"` script |
| `README.md` (MODIFY) | Add a "Channel Commands" section listing the four commands |

---

## Task 0: Test infrastructure

**Files:**
- Modify: `package.json`
- Create: `test/.gitkeep`

- [ ] **Step 1: Verify Node version supports `node:test`**

Run: `node --version`
Expected: `v18.x.x` or higher (Node `node:test` is stable from 18+; the project's Baileys dep already requires modern Node).

- [ ] **Step 2: Add the test script to package.json**

Edit `package.json`, change the `scripts` block from:
```json
"scripts": {
  "start": "node server.cjs"
},
```
to:
```json
"scripts": {
  "start": "node server.cjs",
  "test": "node --test test/**/*.{cjs,js}"
},
```

(A glob is required because `node --test test/` errors out on an empty directory by treating the path as a single file argument. The glob expands to zero matches on the empty directory and Node exits 0.)

- [ ] **Step 3: Create the test directory placeholder**

Run: `mkdir -p test && touch test/.gitkeep`

- [ ] **Step 4: Sanity-check the runner on the empty suite**

Run: `npm test`
Expected: exits 0 with output like `# tests 0`, `# pass 0`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add package.json test/.gitkeep
git commit -m "test: add node:test runner via npm test"
```

---

## Task 1: Pending action module

**Files:**
- Create: `lib/pending-action.cjs`
- Test: `test/pending-action.test.cjs`

- [ ] **Step 1: Write the failing tests first**

Create `test/pending-action.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const TMP = path.join(os.tmpdir(), `pending-test-${process.pid}-${Date.now()}`);
process.env.CCM_PENDING_DIR = TMP;
const pa = require("../lib/pending-action.cjs");

test.beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});
test.after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

test("generateCode returns a 4-char zero-padded numeric string", () => {
  for (let i = 0; i < 100; i++) {
    const c = pa.generateCode();
    assert.match(c, /^\d{4}$/, `got ${c}`);
  }
});

test("write then read returns the action and code", async () => {
  const result = await pa.write("user_a", "clear");
  assert.match(result.code, /^\d{4}$/);
  const read = await pa.read("user_a");
  assert.equal(read.action, "clear");
  assert.equal(read.code, result.code);
  assert.equal(read.expires_at - read.created_at, 90);
});

test("read returns null when no pending file exists", async () => {
  const read = await pa.read("nobody");
  assert.equal(read, null);
});

test("read returns null and unlinks file when expired", async () => {
  await pa.write("user_b", "clear");
  const file = path.join(TMP, "user_b.json");
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  data.expires_at = Math.floor(Date.now() / 1000) - 1;
  await fs.writeFile(file, JSON.stringify(data));
  const read = await pa.read("user_b");
  assert.equal(read, null);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("write overwrites an existing pending action with the new action", async () => {
  await pa.write("user_c", "clear");
  const second = await pa.write("user_c", "compact");
  const read = await pa.read("user_c");
  assert.equal(read.action, "compact");
  assert.equal(read.code, second.code);
});

test("clear removes the pending file", async () => {
  await pa.write("user_d", "clear");
  await pa.clear("user_d");
  const read = await pa.read("user_d");
  assert.equal(read, null);
});

test("clear is idempotent when no file exists", async () => {
  await pa.clear("ghost");
});

test("write uses atomic rename (no .tmp file remains)", async () => {
  await pa.write("user_e", "clear");
  const entries = await fs.readdir(TMP);
  assert.deepEqual(entries.filter(e => e.endsWith(".tmp")), []);
});
```

- [ ] **Step 2: Run tests, expect failures**

Run: `npm test`
Expected: every test fails with `Cannot find module '../lib/pending-action.cjs'`.

- [ ] **Step 3: Create the module**

Create `lib/pending-action.cjs`:

```js
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const TTL_SECONDS = 90;

// Read env each call so test suites can override CCM_PENDING_DIR per file.
function pendingDir() {
  return process.env.CCM_PENDING_DIR
    || path.join(os.homedir(), ".ccm", "pending");
}

function generateCode() {
  return crypto.randomInt(0, 10000).toString().padStart(4, "0");
}

function fileFor(userId) {
  return path.join(pendingDir(), `${userId}.json`);
}

async function write(userId, action) {
  await fs.mkdir(pendingDir(), { recursive: true });
  const code = generateCode();
  const created_at = Math.floor(Date.now() / 1000);
  const expires_at = created_at + TTL_SECONDS;
  const data = { action, code, created_at, expires_at };
  const final = fileFor(userId);
  const tmp = `${final}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, final);
  return data;
}

async function read(userId) {
  const file = fileFor(userId);
  let raw;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
  const data = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  if (now > data.expires_at) {
    await clear(userId);
    return null;
  }
  return data;
}

async function clear(userId) {
  try { await fs.unlink(fileFor(userId)); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
}

module.exports = { generateCode, write, read, clear, pendingDir, TTL_SECONDS };
```

- [ ] **Step 4: Run tests, expect all to pass**

Run: `npm test`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/pending-action.cjs test/pending-action.test.cjs
git commit -m "feat(channel): add pending-action OTP state module"
```

---

## Task 2: Checkpoint module

**Files:**
- Create: `lib/checkpoint.cjs`
- Test: `test/checkpoint.test.cjs`

- [ ] **Step 1: Write the failing tests first**

Create `test/checkpoint.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.join(os.tmpdir(), `cp-test-${process.pid}-${Date.now()}`);
process.env.CCM_CHECKPOINTS_DIR = path.join(ROOT, "checkpoints");
const cp = require("../lib/checkpoint.cjs");

async function makeProjectDir(slug, files = ["a.jsonl", "b.jsonl"]) {
  const dir = path.join(ROOT, "projects", slug);
  await fs.mkdir(dir, { recursive: true });
  for (const f of files) {
    await fs.writeFile(path.join(dir, f), `dummy content of ${f}`);
  }
  return dir;
}

test.beforeEach(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });
test.after(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });

test("create moves the project dir into a new checkpoint and recreates an empty one", async () => {
  const projectDir = await makeProjectDir("slug-1");
  const result = await cp.create("user_a", projectDir, "session-1");
  const originals = await fs.readdir(path.join(result.checkpointDir, "originals"));
  assert.deepEqual(originals.sort(), ["a.jsonl", "b.jsonl"]);
  const after = await fs.readdir(projectDir);
  assert.deepEqual(after, []);
});

test("create writes meta.json with expected fields", async () => {
  const projectDir = await makeProjectDir("slug-2", ["x.jsonl"]);
  const result = await cp.create("user_b", projectDir, "session-2");
  const meta = JSON.parse(await fs.readFile(path.join(result.checkpointDir, "meta.json"), "utf8"));
  assert.equal(meta.workspace_slug, "slug-2");
  assert.equal(meta.session_name, "session-2");
  assert.equal(meta.jsonl_count, 1);
  assert.ok(meta.total_bytes > 0);
  assert.ok(typeof meta.cleared_at === "number");
});

test("create returns a checkpoint dir name that sorts lexicographically by time", async () => {
  const dir1 = await makeProjectDir("a");
  const r1 = await cp.create("user_c", dir1, "s");
  await new Promise(r => setTimeout(r, 1100));
  const dir2 = await makeProjectDir("a");
  const r2 = await cp.create("user_c", dir2, "s");
  assert.ok(r1.checkpointDir < r2.checkpointDir, `${r1.checkpointDir} should sort before ${r2.checkpointDir}`);
});

test("pruneOld keeps the 10 newest checkpoints and removes the rest", async () => {
  const userDir = path.join(process.env.CCM_CHECKPOINTS_DIR, "user_d");
  await fs.mkdir(userDir, { recursive: true });
  for (let i = 0; i < 12; i++) {
    await fs.mkdir(path.join(userDir, `cp-${String(i).padStart(3, "0")}`));
  }
  await cp.pruneOld("user_d");
  const remaining = (await fs.readdir(userDir)).sort();
  assert.equal(remaining.length, 10);
  assert.deepEqual(remaining, Array.from({ length: 10 }, (_, i) => `cp-${String(i + 2).padStart(3, "0")}`));
});

test("pruneOld is a no-op when fewer than retention checkpoints exist", async () => {
  const userDir = path.join(process.env.CCM_CHECKPOINTS_DIR, "user_e");
  await fs.mkdir(userDir, { recursive: true });
  for (let i = 0; i < 3; i++) await fs.mkdir(path.join(userDir, `cp-${i}`));
  await cp.pruneOld("user_e");
  const remaining = await fs.readdir(userDir);
  assert.equal(remaining.length, 3);
});

test("pruneOld is idempotent when the user dir does not exist", async () => {
  await cp.pruneOld("ghost");
});
```

- [ ] **Step 2: Run tests, expect failures**

Run: `npm test`
Expected: failures with `Cannot find module '../lib/checkpoint.cjs'`.

- [ ] **Step 3: Create the module**

Create `lib/checkpoint.cjs`:

```js
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const RETENTION = 10;

// Read env each call so test suites can override CCM_CHECKPOINTS_DIR per file.
function checkpointsDir() {
  return process.env.CCM_CHECKPOINTS_DIR
    || path.join(os.homedir(), ".ccm", "checkpoints");
}

function utcStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function dirSize(dir) {
  let total = 0;
  let count = 0;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (e) { if (e.code === "ENOENT") return { total: 0, count: 0 }; throw e; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile()) {
      const st = await fs.stat(p);
      total += st.size;
      if (e.name.endsWith(".jsonl")) count++;
    } else if (e.isDirectory()) {
      const sub = await dirSize(p);
      total += sub.total;
      count += sub.count;
    }
  }
  return { total, count };
}

async function create(userId, projectDir, sessionName) {
  const slug = path.basename(projectDir);
  const stamp = utcStamp();
  const checkpointDir = path.join(checkpointsDir(), userId, stamp);
  await fs.mkdir(path.dirname(checkpointDir), { recursive: true });
  await fs.mkdir(checkpointDir, { recursive: true });

  const originals = path.join(checkpointDir, "originals");
  const { total, count } = await dirSize(projectDir);
  await fs.rename(projectDir, originals);
  await fs.mkdir(projectDir, { recursive: true });

  const meta = {
    workspace_slug: slug,
    session_name: sessionName,
    jsonl_count: count,
    total_bytes: total,
    cleared_at: Math.floor(Date.now() / 1000),
  };
  await fs.writeFile(path.join(checkpointDir, "meta.json"), JSON.stringify(meta, null, 2));
  return { checkpointDir, meta };
}

async function pruneOld(userId) {
  const userDir = path.join(checkpointsDir(), userId);
  let entries;
  try { entries = await fs.readdir(userDir); }
  catch (e) { if (e.code === "ENOENT") return; throw e; }
  if (entries.length <= RETENTION) return;
  entries.sort();
  const toDelete = entries.slice(0, entries.length - RETENTION);
  for (const name of toDelete) {
    await fs.rm(path.join(userDir, name), { recursive: true, force: true });
  }
}

module.exports = { create, pruneOld, checkpointsDir, RETENTION };
```

- [ ] **Step 4: Run tests, expect all to pass**

Run: `npm test`
Expected: all 6 checkpoint tests pass (plus the 8 from Task 1 — total 14).

- [ ] **Step 5: Commit**

```bash
git add lib/checkpoint.cjs test/checkpoint.test.cjs
git commit -m "feat(channel): add checkpoint module with retention"
```

---

## Task 3: Tmux helper module

**Files:**
- Create: `lib/tmux.cjs`

This is a tiny wrapper used by both `gateway.cjs` (in production) and `channel-slash.cjs` (via injection). It uses `execFileSync` with array-args (no shell), so tmux session names and key arguments cannot inject shell metacharacters.

No unit tests — this is a passthrough wrapper around `tmux`. It will be exercised end-to-end in Task 5.

- [ ] **Step 1: Create the module**

Create `lib/tmux.cjs`:

```js
const cp = require("node:child_process");

function capturePane(sessionName) {
  try {
    return cp.execFileSync("tmux", ["capture-pane", "-p", "-t", sessionName], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function sendKeys(sessionName, ...keys) {
  try {
    cp.execFileSync("tmux", ["send-keys", "-t", sessionName, ...keys]);
  } catch {}
}

function killSession(sessionName) {
  try {
    cp.execFileSync("tmux", ["kill-session", "-t", sessionName]);
  } catch {}
}

module.exports = { capturePane, sendKeys, killSession };
```

- [ ] **Step 2: Sanity check it loads**

Run: `node -e 'const t = require("./lib/tmux.cjs"); console.log(Object.keys(t))'`
Expected: `[ 'capturePane', 'sendKeys', 'killSession' ]`

- [ ] **Step 3: Commit**

```bash
git add lib/tmux.cjs
git commit -m "feat(channel): add tmux execFile wrapper"
```

---

## Task 4: Channel-slash dispatcher

**Files:**
- Create: `lib/channel-slash.cjs`
- Test: `test/channel-slash.test.cjs`

The dispatcher signature:
```js
async function handleChannelSlashCommand({
  userId,        // sanitized id (string)
  text,          // trimmed inbound message text
  reply,         // async (string) => void   — sends a WhatsApp message back to the user
  tmux,          // { capturePane(name)→string, sendKeys(name, ...keys), killSession(name) }
  paths,         // { projectDirCandidates: string[], sessionName: string }
})
```
Returns `true` if the message was consumed, `false` otherwise.

- [ ] **Step 1: Write the failing tests first**

Create `test/channel-slash.test.cjs`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.join(os.tmpdir(), `cs-test-${process.pid}-${Date.now()}`);
process.env.CCM_PENDING_DIR = path.join(ROOT, "pending");
process.env.CCM_CHECKPOINTS_DIR = path.join(ROOT, "checkpoints");

const cs = require("../lib/channel-slash.cjs");
const pa = require("../lib/pending-action.cjs");

function makeMocks() {
  const replies = [];
  const tmuxCalls = [];
  return {
    replies,
    tmuxCalls,
    reply: async (text) => { replies.push(text); },
    tmux: {
      capturePane: (name) => { tmuxCalls.push(["cap", name]); return "╭ idle prompt ╰"; },
      sendKeys: (name, ...keys) => { tmuxCalls.push(["keys", name, ...keys]); },
      killSession: (name) => { tmuxCalls.push(["kill", name]); },
    },
  };
}

async function makeProjectDir(slug) {
  const dir = path.join(ROOT, "projects", slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "session.jsonl"), "x");
  return dir;
}

test.beforeEach(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });
test.after(async () => { await fs.rm(ROOT, { recursive: true, force: true }); });

test("returns false for plain non-slash text", async () => {
  const m = makeMocks();
  const handled = await cs.handleChannelSlashCommand({
    userId: "u1", text: "hello", reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: [], sessionName: "s" },
  });
  assert.equal(handled, false);
  assert.equal(m.replies.length, 0);
});

test("/help replies with the help text", async () => {
  const m = makeMocks();
  const handled = await cs.handleChannelSlashCommand({
    userId: "u1", text: "/help", reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: [], sessionName: "s" },
  });
  assert.equal(handled, true);
  assert.equal(m.replies.length, 1);
  assert.match(m.replies[0], /Channel commands/);
  assert.match(m.replies[0], /\/clear/);
  assert.match(m.replies[0], /\/compact/);
  assert.match(m.replies[0], /\/usage/);
});

test("/clear writes pending and replies with a 4-digit code", async () => {
  const m = makeMocks();
  const handled = await cs.handleChannelSlashCommand({
    userId: "u1", text: "/clear", reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: [], sessionName: "s" },
  });
  assert.equal(handled, true);
  const pending = await pa.read("u1");
  assert.equal(pending.action, "clear");
  assert.match(m.replies[0], new RegExp(`\\b${pending.code}\\b`));
  assert.match(m.replies[0], /Clear conversation/);
});

test("/compact writes pending and replies with a 4-digit code", async () => {
  const m = makeMocks();
  const handled = await cs.handleChannelSlashCommand({
    userId: "u1", text: "/compact", reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: [], sessionName: "s" },
  });
  assert.equal(handled, true);
  const pending = await pa.read("u1");
  assert.equal(pending.action, "compact");
  assert.match(m.replies[0], new RegExp(`\\b${pending.code}\\b`));
  assert.match(m.replies[0], /Compact conversation/);
});

test("matching OTP for /clear runs full clear flow", async () => {
  const projectDir = await makeProjectDir("the-slug");
  const m = makeMocks();
  await cs.handleChannelSlashCommand({
    userId: "u1", text: "/clear", reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: [projectDir], sessionName: "s1" },
  });
  const code = (await pa.read("u1")).code;
  const handled = await cs.handleChannelSlashCommand({
    userId: "u1", text: code, reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: [projectDir], sessionName: "s1" },
  });
  assert.equal(handled, true);
  assert.equal(m.replies.length, 3);
  assert.match(m.replies[1], /Checkpointing/);
  assert.match(m.replies[2], /Cleared/);
  assert.deepEqual(m.tmuxCalls.find(c => c[0] === "kill"), ["kill", "s1"]);
  const after = await fs.readdir(projectDir);
  assert.deepEqual(after, []);
  const checkpoints = await fs.readdir(path.join(ROOT, "checkpoints", "u1"));
  assert.equal(checkpoints.length, 1);
  assert.equal(await pa.read("u1"), null);
});

test("matching OTP for /compact sends Escape then /compact + Enter, no second reply", async () => {
  const m = makeMocks();
  await cs.handleChannelSlashCommand({
    userId: "u1", text: "/compact", reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: [], sessionName: "s1" },
  });
  const code = (await pa.read("u1")).code;
  m.replies.length = 0;
  m.tmuxCalls.length = 0;
  const handled = await cs.handleChannelSlashCommand({
    userId: "u1", text: code, reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: [], sessionName: "s1" },
  });
  assert.equal(handled, true);
  assert.equal(m.replies.length, 1);
  assert.match(m.replies[0], /Compacting/);
  const sendCalls = m.tmuxCalls.filter(c => c[0] === "keys");
  assert.deepEqual(sendCalls[0], ["keys", "s1", "Escape"]);
  assert.deepEqual(sendCalls[1], ["keys", "s1", "/compact", "Enter"]);
  assert.equal(await pa.read("u1"), null);
});

test("/compact aborts and apologizes when claude is busy after retry", async () => {
  const m = makeMocks();
  m.tmux.capturePane = () => "Enter to confirm";
  await cs.handleChannelSlashCommand({
    userId: "u1", text: "/compact", reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: [], sessionName: "s1" },
  });
  const code = (await pa.read("u1")).code;
  m.replies.length = 0;
  const handled = await cs.handleChannelSlashCommand({
    userId: "u1", text: code, reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: [], sessionName: "s1" },
  });
  assert.equal(handled, true);
  assert.match(m.replies[0], /Compacting/);
  assert.match(m.replies[1], /Couldn't compact/);
  const stillPending = await pa.read("u1");
  assert.equal(stillPending.code, code);
});

test("wrong OTP rejects and clears the pending file", async () => {
  const m = makeMocks();
  await cs.handleChannelSlashCommand({
    userId: "u1", text: "/clear", reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: [], sessionName: "s" },
  });
  const correct = (await pa.read("u1")).code;
  const wrong = String((parseInt(correct, 10) + 1) % 10000).padStart(4, "0");
  m.replies.length = 0;
  const handled = await cs.handleChannelSlashCommand({
    userId: "u1", text: wrong, reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: [], sessionName: "s" },
  });
  assert.equal(handled, true);
  assert.match(m.replies[0], /didn't match/i);
  assert.equal(await pa.read("u1"), null);
});

test("4-digit reply with no pending falls through (returns false)", async () => {
  const m = makeMocks();
  const handled = await cs.handleChannelSlashCommand({
    userId: "u1", text: "4827", reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: [], sessionName: "s" },
  });
  assert.equal(handled, false);
  assert.equal(m.replies.length, 0);
});

test("commands are case-insensitive", async () => {
  const m = makeMocks();
  for (const cmd of ["/HELP", "/Help", "/help"]) {
    m.replies.length = 0;
    const handled = await cs.handleChannelSlashCommand({
      userId: "u1", text: cmd, reply: m.reply, tmux: m.tmux,
      paths: { projectDirCandidates: [], sessionName: "s" },
    });
    assert.equal(handled, true, `expected ${cmd} to be handled`);
    assert.match(m.replies[0], /Channel commands/);
  }
});
```

- [ ] **Step 2: Run tests, expect failures**

Run: `npm test`
Expected: failures with `Cannot find module '../lib/channel-slash.cjs'`.

- [ ] **Step 3: Create the dispatcher module**

Create `lib/channel-slash.cjs`:

```js
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const pa = require("./pending-action.cjs");
const cp = require("./checkpoint.cjs");

const HELP_TEXT = `🤖 *Channel commands*

📊 /usage          Show your monthly tokens & cost
📋 /usage history  Show top-up history
🤖 /help           Show this list

⚠️ /clear          Wipe my conversation memory (OTP required)
⚠️ /compact        Summarize & shrink my context (OTP required)

Destructive commands ask you to confirm with a 4-digit code.`;

function clearWarning(code) {
  return `⚠️ *Clear conversation*

✅ *Why use it:* Wipes context window. Token usage drops to near zero, replies get faster, great when switching projects.

⚠️ *Risk:* I will forget *everything* — files explored, decisions made, what you just asked me to do. Not undoable from chat.

Reply with code *${code}* within 90s to confirm.`;
}

function compactWarning(code) {
  return `🗜️ *Compact conversation*

✅ *Why use it:* Shrinks token usage while keeping the gist. Less aggressive than /clear.

⚠️ *Risk:* I may lose specific details — exact file paths, line numbers, subtle decisions. The summary is lossy.

Reply with code *${code}* within 90s to confirm.`;
}

function codesMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isClaudeIdle(paneText) {
  return paneText.includes("╭")
      && paneText.includes("╰")
      && !paneText.includes("Enter to confirm");
}

async function pickExistingProjectDir(candidates) {
  for (const c of candidates) {
    try { await fs.stat(c); return c; }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  return null;
}

async function handleChannelSlashCommand({ userId, text, reply, tmux, paths }) {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;

  if (/^\d{4}$/.test(trimmed)) {
    const pending = await pa.read(userId);
    if (!pending) return false;
    if (!codesMatch(trimmed, pending.code)) {
      await pa.clear(userId);
      await reply("⚠️ Code didn't match. Send /clear or /compact again to get a new code.");
      return true;
    }
    if (pending.action === "clear") return runClear({ userId, reply, tmux, paths });
    if (pending.action === "compact") return runCompact({ userId, reply, tmux, paths });
    await pa.clear(userId);
    return true;
  }

  const lower = trimmed.toLowerCase();
  if (lower === "/help") {
    await reply(HELP_TEXT);
    return true;
  }
  if (lower === "/clear") {
    const { code } = await pa.write(userId, "clear");
    await reply(clearWarning(code));
    return true;
  }
  if (lower === "/compact") {
    const { code } = await pa.write(userId, "compact");
    await reply(compactWarning(code));
    return true;
  }

  return false;
}

async function runClear({ userId, reply, tmux, paths }) {
  const projectDir = await pickExistingProjectDir(paths.projectDirCandidates);
  await reply("🛟 Checkpointing your conversation…");
  if (projectDir) {
    try {
      await cp.create(userId, projectDir, paths.sessionName);
    } catch (e) {
      await reply(`⚠️ Couldn't checkpoint — aborting clear to keep your session safe. (${e.message})`);
      return true;
    }
  }
  try { tmux.killSession(paths.sessionName); } catch {}
  await pa.clear(userId);
  try { await cp.pruneOld(userId); } catch {}
  await reply("✅ Cleared. Send any message to start fresh.");
  return true;
}

async function runCompact({ userId, reply, tmux, paths }) {
  await reply("🗜️ Compacting…");
  let idle = isClaudeIdle(tmux.capturePane(paths.sessionName));
  if (!idle) {
    await new Promise(r => setTimeout(r, 1000));
    idle = isClaudeIdle(tmux.capturePane(paths.sessionName));
  }
  if (!idle) {
    await reply("⚠️ Couldn't compact — Claude is busy. Try again in a moment.");
    return true;
  }
  tmux.sendKeys(paths.sessionName, "Escape");
  tmux.sendKeys(paths.sessionName, "/compact", "Enter");
  await pa.clear(userId);
  return true;
}

module.exports = { handleChannelSlashCommand };
```

- [ ] **Step 4: Run tests, expect all to pass**

Run: `npm test`
Expected: all tests pass (8 + 6 + 10 = 24 total).

- [ ] **Step 5: Commit**

```bash
git add lib/channel-slash.cjs test/channel-slash.test.cjs
git commit -m "feat(channel): add slash-command dispatcher with /help, /clear, /compact"
```

---

## Task 5: Wire the dispatcher into `gateway.cjs`

**Files:**
- Modify: `gateway.cjs` (2 require lines near top, ~22 lines just before line 1169)

- [ ] **Step 1: Read the surrounding context to confirm `userWorkDir` is in scope**

Run: `sed -n '1100,1170p' gateway.cjs`
Look at what variables (`userId`, `userDir`, `userWorkDir`, `text`, `jid`, `sock`, `log`) are defined where in the per-message loop. If `userWorkDir` is NOT in scope at the dispatch insertion point, derive it inside the dispatch block: `const userWorkDir = require("path").join(getUserDir(userId), "workspace");`

- [ ] **Step 2: Add the requires at the top of gateway.cjs**

Find the existing require block (top of file). Add:

```js
const channelSlash = require("./lib/channel-slash.cjs");
const tmuxHelper = require("./lib/tmux.cjs");
```

- [ ] **Step 3: Insert the dispatch block immediately before the `/usage history` check at line 1169**

Find the comment `// /usage command — check BEFORE sender prefix` (around line 1167). Insert this block IMMEDIATELY BEFORE that comment:

```js
      // Channel slash commands (/help, /clear, /compact, OTP confirm) — check
      // before /usage so they short-circuit cleanly. Falls through (returns
      // false) for any text that isn't one of these commands or a pending OTP.
      {
        const projectDirCandidates = [
          userWorkDir.replace(/\//g, "-"),
          userWorkDir.replace(/[/.]/g, "-"),
          userWorkDir.replace(/\//g, "-").replace(/-\./g, "."),
        ].map(slug => path.join(os.homedir(), ".claude", "projects", slug));
        const sessionName = getUserSessionName(userId);
        const handled = await channelSlash.handleChannelSlashCommand({
          userId,
          text,
          reply: async (t) => {
            try { await sock.sendMessage(jid, { text: t }); }
            catch (e) { log(`channel-slash reply failed: ${e}`); }
          },
          tmux: tmuxHelper,
          paths: { projectDirCandidates, sessionName },
        });
        if (handled) continue;
      }
```

(If `userWorkDir` is not in scope, prepend `const userWorkDir = path.join(getUserDir(userId), "workspace");` to the block.)

- [ ] **Step 4: Verify gateway.cjs still parses**

Run: `node --check gateway.cjs`
Expected: no output (success).

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: all 24 unit tests still pass.

- [ ] **Step 6: Commit**

```bash
git add gateway.cjs
git commit -m "feat(gateway): dispatch channel slash commands before /usage handler"
```

---

## Task 6: Manual smoke test on a real WhatsApp number

**No code changes — verification only. Document any unexpected behavior in your own scratch notes; if a bug is found, branch off into a fix-up commit before continuing.**

- [ ] **Step 1: Restart the gateway with the new code**

```bash
ps -ef | grep "node gateway.cjs" | grep -v grep
# Note the PID, then:
pkill -f "node gateway.cjs"
sleep 2
cd ~/claude-code-whatsapp
nohup node gateway.cjs > /tmp/gateway-test.log 2>&1 &
echo "Gateway PID: $!"
sleep 3
tail -30 /tmp/gateway-test.log
```

Expected: gateway starts cleanly, no errors in the first 30 log lines, no `MODULE_NOT_FOUND`.

- [ ] **Step 2: Run the manual test matrix**

Send each message to the WhatsApp channel from a real phone, observe the reply, and tick the row:

| # | Send | Expected reply | ☐ |
|---|---|---|---|
| 1 | `/help` | List of commands including /clear, /compact, /usage, /help | ☐ |
| 2 | `/clear` | Warning + 4-digit code | ☐ |
| 3 | (the code from #2) | "Checkpointing…" then "Cleared. Send any message to start fresh." | ☐ |
| 4 | `hi` | Fresh Claude session — should NOT remember prior messages | ☐ |
| 5 | `/clear` then `/clear` again before submitting code | Two warnings with DIFFERENT codes; old code rejected | ☐ |
| 6 | `/clear` → wait 100s → submit the code | Code falls through (Claude treats it as a normal message) | ☐ |
| 7 | `/clear` → submit a wrong 4-digit code | "Code didn't match…" reply | ☐ |
| 8 | `/compact` → submit code (while Claude is idle) | "Compacting…" then Claude's next message reflects compacted history | ☐ |
| 9 | `ls ~/.ccm/checkpoints/` | At least one user-id dir, containing at least one timestamped checkpoint from test #3 | ☐ |
| 10 | `ls ~/.ccm/pending/` | After test #3 success, the user's pending file should be gone | ☐ |

- [ ] **Step 3: Update README**

Edit `README.md` and add a section near the top (after the intro paragraph):

```markdown
## Channel Commands

The WhatsApp gateway recognizes these slash commands inline. Send the command as a message; in groups, prefix with the configured trigger (`@ai /help`).

| Command | Description |
|---|---|
| `/help` | List all channel commands |
| `/usage` | Show monthly tokens & cost |
| `/usage history` | Show top-up history |
| `/clear` | Wipe Claude's conversation memory (OTP-confirmed; auto-checkpoints to `~/.ccm/checkpoints/`) |
| `/compact` | Summarize & shrink Claude's context (OTP-confirmed; lossy) |

Destructive commands send a 4-digit code and require a confirmation reply within 90 seconds.
```

- [ ] **Step 4: Commit the README**

```bash
git add README.md
git commit -m "docs: document channel slash commands"
```

- [ ] **Step 5: Final sanity sweep**

Run: `npm test && node --check gateway.cjs && git status`
Expected: tests pass, gateway parses, working tree clean.

---

## Done criteria

- All 24 unit tests pass (`npm test`).
- `gateway.cjs` parses (`node --check gateway.cjs`).
- All 10 manual test matrix rows are checked.
- README has the Channel Commands section.
- Working tree clean. Commits land in this order:
  1. `test: add node:test runner via npm test`
  2. `feat(channel): add pending-action OTP state module`
  3. `feat(channel): add checkpoint module with retention`
  4. `feat(channel): add tmux execFile wrapper`
  5. `feat(channel): add slash-command dispatcher with /help, /clear, /compact`
  6. `feat(gateway): dispatch channel slash commands before /usage handler`
  7. `docs: document channel slash commands`
