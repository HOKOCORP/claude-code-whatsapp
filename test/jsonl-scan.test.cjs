const test = require("node:test");
const assert = require("node:assert/strict");
const js = require("../lib/jsonl-scan.cjs");

test("slugify replaces non-alphanumerics with dashes", () => {
  assert.equal(js.slugify("/home/wp-fundraising/workspace"), "-home-wp-fundraising-workspace");
  assert.equal(js.slugify("/a/b.c"), "-a-b-c");
  assert.equal(js.slugify("plain"), "plain");
  assert.equal(js.slugify(""), "");
});

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
  await new Promise(r => setTimeout(r, 20));
  fs.writeFileSync(newer, "new");
  const result = js.findSessionJsonl(cwd, home);
  assert.equal(result, newer);
  fs.rmSync(home, { recursive: true, force: true });
});

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

test("hasMessageId finds a literal message_id=\"...\" occurrence", () => {
  const haystack = '{"content":"<channel message_id=\\"ABC123\\" ts=\\"...\\">"}';
  assert.equal(js.hasMessageId(haystack, "ABC123"), true);
});

test("hasMessageId returns false on absence", () => {
  const haystack = '{"content":"<channel message_id=\\"XYZ\\" >"}';
  assert.equal(js.hasMessageId(haystack, "ABC123"), false);
});

test("hasMessageId does not match a substring of a longer id", () => {
  const haystack = '{"content":"<channel message_id=\\"ABC1234567\\">"}';
  assert.equal(js.hasMessageId(haystack, "ABC123"), false);
});

test("hasMessageId rejects empty id", () => {
  assert.equal(js.hasMessageId("anything", ""), false);
  assert.equal(js.hasMessageId("anything", null), false);
});
