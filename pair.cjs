#!/usr/bin/env node
// WhatsApp pairing script
// Usage: node pair.cjs <phone_number> [state_dir]
// Example: node pair.cjs 14155551234
// Example: node pair.cjs 14155551234 /root/.claude/channels/whatsapp-2
const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");

const PHONE = process.argv[2];
if (!PHONE) {
  console.error("Usage: node pair.cjs <phone_number> [state_dir]");
  console.error("  phone_number: digits only, with country code (e.g. 14155551234)");
  console.error("  state_dir:    optional, defaults to /root/.claude/channels/whatsapp-<phone>");
  process.exit(1);
}

const STATE_DIR = process.argv[3] || process.env.WHATSAPP_STATE_DIR || "/root/.claude/channels/whatsapp-" + PHONE;
const AUTH_DIR = STATE_DIR + "/auth";

const fs = require("fs");
fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });

console.log("WhatsApp pairing");
console.log("  Phone:    +" + PHONE);
console.log("  Auth dir: " + AUTH_DIR);
console.log("Connecting...\n");

(async () => {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: "silent" });

  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    version,
    logger,
    browser: ["Mac OS", "Safari", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  if (!state.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE);
        console.log(`\n📱 PAIRING CODE: ${code}\n`);
        console.log("WhatsApp > Linked Devices > Link a Device > Link with phone number");
        console.log("Enter the code above.\n");
      } catch (e) {
        console.error("Pairing code failed, waiting for QR instead...");
      }
    }, 3000);
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true }, (code) => {
        console.log("\n📱 Or scan this QR:\n");
        console.log(code);
      });
    }

    if (connection === "open") {
      console.log("\n✅ WhatsApp connected! Auth saved. Closing in 3s...");
      setTimeout(() => process.exit(0), 3000);
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut || reason === 440 || reason === 515) {
        console.log(`❌ Error ${reason}. Delete auth/ and try again after a few minutes.`);
        process.exit(1);
      }
      console.log(`Connection closed (${reason}), retrying...`);
      setTimeout(() => process.exit(1), 1000);
    }
  });
})();
