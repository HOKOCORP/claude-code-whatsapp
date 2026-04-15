const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createAuditLogger } = require("../lib/audit-log.cjs");

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("auditEvent appends a JSONL line with ts + event + extras", () => {
  const dir = mkTmp("audit-");
  const audit = createAuditLogger({ outboxDir: dir, now: () => 1744700000000 });
  audit("send", { filename: "a.json", chat_id: "c", msg_ids: ["X"] });
  const content = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 1);
  const obj = JSON.parse(lines[0]);
  assert.equal(obj.ts, 1744700000000);
  assert.equal(obj.event, "send");
  assert.equal(obj.filename, "a.json");
  assert.equal(obj.chat_id, "c");
  assert.deepEqual(obj.msg_ids, ["X"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auditEvent appends multiple lines in order", () => {
  const dir = mkTmp("audit-");
  let t = 1000;
  const audit = createAuditLogger({ outboxDir: dir, now: () => t });
  audit("send", { filename: "a" }); t += 10;
  audit("server_ack", { msg_id: "X" }); t += 10;
  audit("delivery_ack", { msg_id: "X" });
  const lines = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).event, "send");
  assert.equal(JSON.parse(lines[1]).event, "server_ack");
  assert.equal(JSON.parse(lines[2]).event, "delivery_ack");
  assert.equal(JSON.parse(lines[0]).ts, 1000);
  assert.equal(JSON.parse(lines[2]).ts, 1020);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auditEvent tolerates write errors without throwing", () => {
  const dir = mkTmp("audit-");
  const audit = createAuditLogger({ outboxDir: dir, now: () => 1000 });
  // Make the dir unwritable by removing it after the logger is created.
  fs.rmSync(dir, { recursive: true, force: true });
  let threw = false;
  try { audit("send", { filename: "a" }); } catch { threw = true; }
  assert.equal(threw, false, "auditEvent must not propagate write errors");
});

test("auditEvent omits extras that are undefined", () => {
  const dir = mkTmp("audit-");
  const audit = createAuditLogger({ outboxDir: dir, now: () => 1000 });
  audit("error", { msg_id: "X", filename: undefined, chat_id: undefined });
  const obj = JSON.parse(fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim());
  assert.equal(obj.msg_id, "X");
  assert.equal("filename" in obj, false, "undefined extras excluded");
  assert.equal("chat_id" in obj, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
