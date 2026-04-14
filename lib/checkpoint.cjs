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
