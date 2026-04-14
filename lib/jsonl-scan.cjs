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

function readJsonlTail(filePath, maxBytes, cache) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    if (e.code === "ENOENT") {
      cache.path = filePath;
      cache.mtimeMs = 0;
      cache.ino = 0;
      cache.text = "";
      return "";
    }
    throw e;
  }
  if (cache.path === filePath && cache.mtimeMs === stat.mtimeMs && cache.ino === stat.ino) {
    return cache.text;
  }
  const size = stat.size;
  const readFrom = Math.max(0, size - maxBytes);
  const length = size - readFrom;
  let text = "";
  if (length > 0) {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, readFrom);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }
  cache.path = filePath;
  cache.mtimeMs = stat.mtimeMs;
  cache.ino = stat.ino;
  cache.text = text;
  return text;
}

function hasMessageId(tailText, id) {
  if (!id || typeof id !== "string") return false;
  const needle = `message_id=\\"${id}\\"`;
  return tailText.indexOf(needle) !== -1;
}

module.exports = { slugify, findSessionJsonl, readJsonlTail, hasMessageId };
