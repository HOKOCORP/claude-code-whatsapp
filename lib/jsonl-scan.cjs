const fs = require("node:fs");
const path = require("node:path");

function slugify(cwd) {
  return String(cwd || "").replace(/[^a-zA-Z0-9]/g, "-");
}

module.exports = { slugify };
