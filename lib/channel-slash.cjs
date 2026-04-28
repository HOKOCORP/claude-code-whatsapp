const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const pa = require("./pending-action.cjs");
const cp = require("./checkpoint.cjs");

const USER_HELP = `🤖 *HOKO Coder commands*

*Balance & top-up:*
💰 /balance            Current £ balance + mode
💳 /topup <amount>     Pay by card (Stripe Checkout)
🎫 /redeem <CODE>      Redeem a top-up or invite code
🧾 /receipts           Recent paid top-ups
🔑 /cckey              BYOK status (own Anthropic API key)
🔑 /cckey <APIKEY>     Set your own key (1× billing instead of 2×)

*Status:*
📊 /usage              This month's tokens & cost
📋 /usage history      Top-up history
🌐 /domain             Your hosted project URL

*Conversation:*
🧠 /model              Pick a Claude model (Haiku / Sonnet / Opus)
⚠️ /clear              Wipe my conversation memory (OTP required)
⚠️ /compact            Summarize & shrink my context (OTP required)

*Info:*
ℹ️ /about              AI disclosure, pricing, refund policy
🤖 /help               This list`;

const ADMIN_HELP = `🤖 *HOKO Coder commands* 👑

*Status (admin is unmetered):*
📊 /usage              This month's tokens & cost
📋 /usage history      Top-up history
🌐 /domain             Your hosted project URL
🧠 /model              Pick a Claude model (Haiku / Sonnet / Opus)
ℹ️ /about              AI disclosure, pricing, refund policy

*Conversation:*
⚠️ /clear              Wipe my conversation memory (OTP required)
⚠️ /compact            Summarize & shrink my context (OTP required)

*User management:*
🎟️ /invite [GBP]       Create invite link, optional pre-fund
👥 /users              List users with hash · name · balance
✏️ /rename HASH NAME   Rename a user
💰 /topup HASH GBP     Credit a user's balance
🎫 /code-create AMOUNT [N]  Mint N redeemable codes worth £AMOUNT each

*Admins:*
👑 /admin              List current admins
👑 /admin add +X       Start two-step add (same-person confirmation)
👑 /admin remove +X    Remove an admin

*In a group:*
🟢 /enable-group       Turn me on in this group
🔴 /disable-group      Turn me off
🔤 /trigger WORD       Change the mention keyword (default @ai)
🔐 /group-token KEY=VAL  Set per-group env token (safe, isolated)
🔐 /group-token list   List this group's tokens
🔐 /group-token unset KEY  Remove a token`;

const HELP_TEXT = USER_HELP;

function clearWarning(code) {
  return `⚠️ *Clear conversation*

✅ *Why use it:* Wipes context window. Token usage drops to near zero, replies get faster, great when switching projects.

⚠️ *Risk:* I will forget *everything* — files explored, decisions made, what you just asked me to do. Not undoable from chat.

Reply with code *${code}* within 90s to confirm.`;
}

function compactWarning(code) {
  return `🗜️ *Compact conversation*

✅ *Why use it:* Shrinks token usage while keeping the gist. Less aggressive than /clear.

⚠️ *Risk:* I may lose specific details — exact file paths, line numbers, subtle decisions. The summary is lossy.

Reply with code *${code}* within 90s to confirm.`;
}

function codesMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isClaudeIdle(paneText) {
  // Claude Code's input prompt shows a "❯" arrow inside a horizontal-bar box.
  // Old corner-character detection (╭/╰) was wrong for current versions, which
  // use ─ horizontal bars. The arrow itself is the most reliable idle marker.
  // "Enter to confirm" indicates a blocking dialog (cc-watchdog-style prompt).
  return paneText.includes("❯")
      && !paneText.includes("Enter to confirm");
}

async function pickExistingProjectDir(candidates) {
  for (const c of candidates) {
    try { await fs.stat(c); return c; }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  return null;
}

async function handleChannelSlashCommand({ userId, text, reply, tmux, paths, isAdmin }) {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;

  if (/^\d{4}$/.test(trimmed)) {
    const pending = await pa.read(userId);
    if (!pending) return false;
    if (!codesMatch(trimmed, pending.code)) {
      await pa.clear(userId);
      await reply("⚠️ Code didn't match. Send /clear or /compact again to get a new code.");
      return true;
    }
    if (pending.action === "clear") return await runClear({ userId, reply, tmux, paths });
    if (pending.action === "compact") return await runCompact({ userId, reply, tmux, paths });
    console.error(`channel-slash: unknown pending action "${pending.action}" for user ${userId} — discarding`);
    await pa.clear(userId);
    return true;
  }

  const lower = trimmed.toLowerCase();
  if (lower === "/help") {
    await reply(isAdmin ? ADMIN_HELP : USER_HELP);
    return true;
  }
  if (lower === "/clear") {
    const { code } = await pa.write(userId, "clear");
    await reply(clearWarning(code));
    return true;
  }
  if (lower === "/compact") {
    const { code } = await pa.write(userId, "compact");
    await reply(compactWarning(code));
    return true;
  }

  return false;
}

async function runClear({ userId, reply, tmux, paths }) {
  const projectDir = await pickExistingProjectDir(paths.projectDirCandidates);
  if (projectDir) {
    await reply("🛟 Checkpointing your conversation…");
    try {
      await cp.create(userId, projectDir, paths.sessionName);
    } catch (e) {
      await reply(`⚠️ Couldn't checkpoint — aborting clear to keep your session safe. (${e.message})`);
      return true;
    }
  }
  try { tmux.killSession(paths.sessionName); } catch {}
  await pa.clear(userId);
  try { await cp.pruneOld(userId); } catch {}
  await reply("✅ Cleared. Send any message to start fresh.");
  return true;
}

async function runCompact({ userId, reply, tmux, paths }) {
  await reply("🗜️ Compacting…");
  let idle = isClaudeIdle(tmux.capturePane(paths.sessionName));
  if (!idle) {
    await new Promise(r => setTimeout(r, 1000));
    idle = isClaudeIdle(tmux.capturePane(paths.sessionName));
  }
  if (!idle) {
    await reply("⚠️ Couldn't compact — agent is busy. Try again in a moment.");
    return true;
  }
  tmux.sendKeys(paths.sessionName, "Escape");
  tmux.sendKeys(paths.sessionName, "/compact", "Enter");
  await pa.clear(userId);
  return true;
}

module.exports = { handleChannelSlashCommand };
