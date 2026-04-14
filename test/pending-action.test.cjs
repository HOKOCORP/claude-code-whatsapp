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
