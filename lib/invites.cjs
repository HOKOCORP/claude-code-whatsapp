const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Crockford-ish base32 minus easily confused chars (0/O, 1/I/L).
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN = 8;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function invitesPath(stateDir) {
  return path.join(stateDir, "invites.json");
}

function loadInvites(stateDir) {
  try {
    const raw = fs.readFileSync(invitesPath(stateDir), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.invites)) return parsed.invites;
  } catch (e) {
    if (e.code !== "ENOENT") {
      try { fs.renameSync(invitesPath(stateDir), `${invitesPath(stateDir)}.corrupt-${Date.now()}`); } catch {}
    }
  }
  return [];
}

function saveInvites(stateDir, invites) {
  const target = invitesPath(stateDir);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ invites }, null, 2) + "\n");
  fs.renameSync(tmp, target);
}

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function createInvite(stateDir, createdByJid, opts = {}) {
  const ttlMs = typeof opts.ttlMs === "number" ? opts.ttlMs : DEFAULT_TTL_MS;
  const preFundUsd = typeof opts.preFundUsd === "number" && opts.preFundUsd > 0 ? opts.preFundUsd : 0;
  const invites = loadInvites(stateDir);
  const now = Date.now();
  let code;
  do { code = generateCode(); } while (invites.some((i) => i.code === code));
  const invite = {
    code,
    created_at: now,
    expires_at: now + ttlMs,
    created_by_jid: createdByJid,
    pre_fund_usd: preFundUsd,
    redeemed_at: null,
    redeemed_by_jid: null,
  };
  invites.push(invite);
  saveInvites(stateDir, invites);
  return invite;
}

function redeemInvite(stateDir, code, redeemerJid) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return { ok: false, reason: "missing_code" };
  const invites = loadInvites(stateDir);
  const idx = invites.findIndex((i) => i.code === normalized);
  if (idx === -1) return { ok: false, reason: "unknown" };
  const invite = invites[idx];
  if (invite.redeemed_at) return { ok: false, reason: "already_used", invite };
  if (Date.now() > invite.expires_at) return { ok: false, reason: "expired", invite };
  invite.redeemed_at = Date.now();
  invite.redeemed_by_jid = redeemerJid;
  invites[idx] = invite;
  saveInvites(stateDir, invites);
  return { ok: true, invite };
}

module.exports = { createInvite, redeemInvite, loadInvites, generateCode, DEFAULT_TTL_MS };
