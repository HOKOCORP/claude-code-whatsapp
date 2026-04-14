const fs = require("node:fs");
const path = require("node:path");

function slugify(cwd) {
  return String(cwd || "").replace(/[^a-zA-Z0-9]/g, "-");
}

function findSessionJsonl(cwd, homeDir) {
  const slug = slugify(cwd);
  const projDir = path.join(homeDir, ".claude/projects", slug);
  let entries;
  try {
    entries = fs.readdirSync(projDir);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const jsonls = entries.filter((f) => f.endsWith(".jsonl"));
  if (jsonls.length === 0) return null;
  let newest = null;
  let newestMtime = -Infinity;
  for (const f of jsonls) {
    const fp = path.join(projDir, f);
    const stat = fs.statSync(fp);
    if (stat.mtimeMs > newestMtime) {
      newestMtime = stat.mtimeMs;
      newest = fp;
    }
  }
  return newest;
}

module.exports = { slugify, findSessionJsonl };
