const cp = require("node:child_process");

function capturePane(sessionName) {
  try {
    return cp.execFileSync("tmux", ["capture-pane", "-p", "-t", sessionName], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function sendKeys(sessionName, ...keys) {
  try {
    cp.execFileSync("tmux", ["send-keys", "-t", sessionName, ...keys]);
  } catch {}
}

function killSession(sessionName) {
  try {
    cp.execFileSync("tmux", ["kill-session", "-t", sessionName]);
  } catch {}
}

module.exports = { capturePane, sendKeys, killSession };
