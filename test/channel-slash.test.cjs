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
      capturePane: (name) => { tmuxCalls.push(["cap", name]); return "──────\n❯ \n──────"; },
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
test("/clear with no existing project dir skips Checkpointing reply but still clears", async () => {
  const m = makeMocks();
  await cs.handleChannelSlashCommand({
    userId: "u1", text: "/clear", reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: ["/nonexistent/path/zzz"], sessionName: "s1" },
  });
  const code = (await pa.read("u1")).code;
  m.replies.length = 0;
  m.tmuxCalls.length = 0;
  const handled = await cs.handleChannelSlashCommand({
    userId: "u1", text: code, reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: ["/nonexistent/path/zzz"], sessionName: "s1" },
  });
  assert.equal(handled, true);
  // Only "Cleared." reply — no "Checkpointing…" since there was nothing to checkpoint
  assert.equal(m.replies.length, 1);
  assert.match(m.replies[0], /Cleared/);
  assert.deepEqual(m.tmuxCalls.find(c => c[0] === "kill"), ["kill", "s1"]);
  assert.equal(await pa.read("u1"), null);
});

test("/clear keeps pending file when checkpoint fails", async () => {
  const projectDir = await makeProjectDir("slug-fail");
  // Pre-create a checkpoint dir with the same UTC stamp will be hard to time.
  // Instead, make the project dir read-only so fs.rename fails.
  // Simpler: use a path that's actually a file, not a dir, so fs.rename throws.
  const fakeFile = path.join(ROOT, "projects", "is-a-file");
  await fs.mkdir(path.dirname(fakeFile), { recursive: true });
  await fs.writeFile(fakeFile, "I am a file, not a dir");
  const m = makeMocks();
  await cs.handleChannelSlashCommand({
    userId: "u1", text: "/clear", reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: [fakeFile], sessionName: "s1" },
  });
  const code = (await pa.read("u1")).code;
  m.replies.length = 0;
  const handled = await cs.handleChannelSlashCommand({
    userId: "u1", text: code, reply: m.reply, tmux: m.tmux,
    paths: { projectDirCandidates: [fakeFile], sessionName: "s1" },
  });
  assert.equal(handled, true);
  // Should have sent "Checkpointing…" then the failure apology
  assert.match(m.replies[0], /Checkpointing/);
  assert.match(m.replies[1], /Couldn't checkpoint/);
  // Pending KEPT (mid-flight failure)
  const stillPending = await pa.read("u1");
  assert.equal(stillPending.code, code);
});

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
