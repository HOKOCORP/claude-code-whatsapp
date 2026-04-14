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

test("create and pruneOld reject unsafe userIds (path traversal guard)", async () => {
  const projectDir = await makeProjectDir("slug");
  for (const bad of ["../escape", "user/sub", "user\0", "", null, undefined, "user with space"]) {
    await assert.rejects(
      async () => { await cp.create(bad, projectDir, "s"); },
      /unsafe userId/,
      `create should reject ${JSON.stringify(bad)}`,
    );
    await assert.rejects(
      async () => { await cp.pruneOld(bad); },
      /unsafe userId/,
      `pruneOld should reject ${JSON.stringify(bad)}`,
    );
  }
});
