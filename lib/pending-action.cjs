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
