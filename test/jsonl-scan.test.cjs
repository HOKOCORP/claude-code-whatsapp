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
