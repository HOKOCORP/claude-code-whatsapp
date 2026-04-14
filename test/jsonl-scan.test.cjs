const test = require("node:test");
const assert = require("node:assert/strict");
const js = require("../lib/jsonl-scan.cjs");

test("slugify replaces non-alphanumerics with dashes", () => {
  assert.equal(js.slugify("/home/wp-fundraising/workspace"), "-home-wp-fundraising-workspace");
  assert.equal(js.slugify("/a/b.c"), "-a-b-c");
  assert.equal(js.slugify("plain"), "plain");
  assert.equal(js.slugify(""), "");
});
