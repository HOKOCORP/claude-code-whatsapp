# Admin Quota Info — 5-Hour + Weekly Remaining % in `/usage` + Proactive Alerts

**Date:** 2026-04-15
**Status:** Draft, awaiting user review
**Scope:** Extend the existing `/usage` channel command with an "Admin quota" section showing 5-hour and weekly remaining percentages sourced from Claude Code's `/status` TUI overlay. Add a background poller that proactively alerts the admin via WhatsApp when either window transitions below 25% or 10%. Admin-only feature; non-admin users' `/usage` output is unchanged.

---

## 1. Motivation

The admin (channel phone owner) burns through Claude Code's 5-hour and 7-day rate-limit windows invisibly. Today the only way to check remaining capacity is to SSH to the server and run `/status` inside the admin's Claude session. By the time the window hits 0%, the session silently blocks on API calls and the admin has to discover the cause from the outside.

This spec closes the visibility gap. Two complementary surfaces:

- **Pull (`/usage`)** — admin asks, gets a fresh snapshot in the same reply.
- **Push (alerts)** — admin gets a proactive WhatsApp DM when either window crosses 25% or 10% remaining.

## 2. Goals

- Admin can see 5hr and 7d remaining % by running `/usage` in WhatsApp.
- Admin receives a WhatsApp alert within ~5 min of 5hr or 7d remaining % crossing the 25% or 10% threshold.
- Zero new API keys or external services — sourced from Claude Code's own `/status` output.
- Admin-only. Non-admin `/usage` output is untouched.

## 3. Non-Goals

- Per-user rate-limit tracking (each non-admin user has their own Claude session with its own windows; not surfacing those in v1).
- Historical graphs, trend charts, projections.
- Budget enforcement — existing USD wallet already does this; quota is orthogonal.
- Alerts on increase (window reset). Reset is handled silently by clearing dedup state.
- Scraping `/status` for non-admin sessions. Admin session is the only source.

## 4. Assumptions

Verified during exploration of `gateway.cjs` and a live capture of the `/status` overlay in Claude Code 2.1.101:

- The admin's Claude Code runs inside a tmux session named `cc-ch-wa-{PHONE}-u-{sanitizedAdminId}` (see `gateway.cjs:383`). The gateway already knows `ADMIN_JID` and the sanitization logic.
- `/status` is a Claude Code slash command that opens a tabbed overlay. Tabs: `Status · Config · Usage · Stats`. The Status tab is the default and does NOT show rate-limit info — we must navigate to the `Usage` tab (two Right-arrow presses from default).
- Live capture of the `Usage` tab on 2026-04-15:

  ```
   Status   Config   Usage   Stats

  Current session
  █████████████████                                  34% used
  Resets 10am (UTC)

  Current week (all models)
  ██████████▌                                        21% used
  Resets Apr 21, 5am (UTC)

  Current week (Sonnet only)
  ███                                                6% used
  Resets Apr 19, 11am (UTC)

  Esc to cancel
  ```

  The spec targets `Current session` (the 5-hour window) and `Current week (all models)` (primary weekly budget). `Current week (Sonnet only)` is ignored — Sonnet is a sub-bucket that doesn't block Opus usage.

- Navigation sequence: `tmux send-keys -t {session}.0 "/status" Enter`, 400 ms settle, `Right Right`, 200 ms settle, `capture-pane -p`, parse, `Escape`.
- The overlay does NOT add anything to Claude's chat transcript — it is a TUI overlay only. Claude's conversation context is not polluted. The overlay's tab selection does not persist across invocations; every capture starts at `Status` and must re-navigate.

## 5. Design

### 5.1 Components

Three files, scoped narrowly:

- **`lib/quota-scraper.cjs`** (new) — stateless I/O module. One exported fn:
  ```js
  async function captureQuota({ tmuxSession, tmuxBin = "tmux", renderDelayMs = 400, tabDelayMs = 200 }) → {
    sessionRemainingPct: number,   // 0-100, from "Current session" block
    weekRemainingPct: number,      // 0-100, from "Current week (all models)" block
    capturedAt: number,            // Date.now()
  } | null
  ```
  Returns `null` on any failure (session gone, parse failed, tmux not installed). Performs the full send-keys sequence documented in §4.

- **`lib/quota-cache.cjs`** (new) — two exported fns backed by a JSON file at `<IPC_BASE>/admin-quota.json`:
  ```js
  readQuota() → { current, previous, lastAlerted } | null
  writeQuota(current) → updates file atomically; shifts old current → previous
  ```
  Shape of `lastAlerted`: `{ "session_25": tsMs | null, "session_10": tsMs | null, "week_25": tsMs | null, "week_10": tsMs | null }`.

- **`gateway.cjs`** (modify) — wire a background poller + extend the existing `/usage` handler:
  - `setInterval(quotaTick, 5 * 60 * 1000)` — every 5 min, call `captureQuota`, `writeQuota`, run `detectTransitions(previous, current)` pure fn, if any threshold breached write alert payload to admin's outbox.
  - `/usage` handler (existing at `gateway.cjs:1292-1351`) — before returning the reply text, call `captureQuota` once and append an "Admin quota" section if the caller is admin.

### 5.2 Data flow

#### 5.2.1 Happy poll (5-min tick)

1. `captureQuota` → `{sessionRemainingPct: 62, weekRemainingPct: 88, capturedAt: ts}`.
2. `writeQuota(current)` — previous snapshot shifts into `previous`; new snapshot becomes `current`.
3. `detectTransitions(previous, current)` compares per-window per-threshold:
   - `prev.session ≥ 25 && cur.session < 25 && lastAlerted["session_25"] == null` → alert.
   - `cur.session ≥ 25 && lastAlerted["session_25"] != null` → clear `lastAlerted["session_25"]` (window reset).
   - Same four cases for `session_10`, `week_25`, `week_10`.
4. For each breach returned: write a JSON file to `<ADMIN_USER_DIR>/outbox/{ts}-quota-{window}_{threshold}.json` with the schema already used elsewhere in the repo:
   ```json
   {"action": "reply", "chat_id": "<ADMIN_JID>", "text": "⚠️ Session quota at 24% remaining (crossed 25% threshold)"}
   ```
   Filename carries the `ts + window + threshold` tuple so concurrent breaches never collide. The existing outbox reconciler (see `2026-04-15-delivery-reliability-design.md`) handles retry, ack, and quarantine — this spec adds no new send path.
5. Mark `lastAlerted[key] = capturedAt` for each fired alert; persist.

#### 5.2.2 `/usage` call by admin

1. Existing code gathers USD wallet data as today.
2. `captureQuota` called synchronously; if it returns null, append `(quota unavailable)`.
3. Admin quota section formatted:
   ```

   📊 Admin quota
   Session: 62% remaining (resets 10am UTC)
   Weekly: 88% remaining (resets Apr 21 5am UTC)
   ```
   Reset-time strings come from the capture and are carried through as-is. If they fail to parse, omit the parenthetical.
4. Reply sent via existing outbox path.

#### 5.2.3 `/usage` call by non-admin

No change. The admin quota section is appended only when the caller's JID matches `ADMIN_JID`.

### 5.3 Concurrency

- `captureQuota` is NOT thread-safe against itself — if two callers race, they step on each other's tmux send-keys sequence. Guard with a module-level `inFlight: Promise | null`: subsequent callers await the same promise, receive the same snapshot. Once resolved, the next caller starts a fresh capture.
- Cache file writes use the "write to `.tmp`, then rename" pattern for atomicity.

### 5.4 Parsing

The regexes live in `lib/quota-scraper.cjs`. Block-scoped patterns — each targets a named section header and captures the first `NN% used` after it:

```js
// Anchor on each section header, then find the next "NN% used" line within ~3 lines.
const SESSION_RE = /Current session\s*(?:\r?\n[^\n]*){0,3}?(\d{1,3})\s*%\s*used/i;
const WEEK_RE    = /Current week \(all models\)\s*(?:\r?\n[^\n]*){0,3}?(\d{1,3})\s*%\s*used/i;
```

Both patterns run with `multiline = false` (default). The captured group is the `used` percentage; `remaining = 100 - used`. If either regex fails, `captureQuota` returns `null` — we never surface a half-populated quota to the caller.

Reset-time extraction (optional, for `/usage` formatting):
```js
const SESSION_RESET_RE = /Current session[\s\S]*?Resets\s+([^\n]+)/i;
const WEEK_RESET_RE    = /Current week \(all models\)[\s\S]*?Resets\s+([^\n]+)/i;
```

The `Current week (Sonnet only)` bucket is intentionally not parsed — anchoring on the `(all models)` literal prevents the week regex from matching the Sonnet-only block.

If Claude Code changes the header wording, the fix is localized to these four patterns.

### 5.5 Admin identification

The gateway already has:
- `ADMIN_JID` — the phone owner's WhatsApp JID (from env / config).
- `sanitizeUserId(jid)` — JID → filesystem-safe id.
- Session naming convention at `gateway.cjs:383`.

Derive admin tmux session name once at gateway boot, cache the string. On missing env, disable the feature (log + skip all quota work).

### 5.6 Alert message format

Each breach is one WhatsApp message. Wording is terse:

- Below 25%: `⚠️ Session quota at {N}% remaining (crossed 25% threshold)`
- Below 10%: `🚨 Session quota at {N}% remaining — near exhaustion (crossed 10% threshold)`
- Same patterns for "Weekly quota" (replacing "Session" with "Weekly").

If both 25% and 10% thresholds are crossed in the SAME poll (e.g., 32% → 8%), emit ONE alert — the 10% one. Rule: per window, fire the lowest-threshold alert transitioned on this tick.

### 5.7 Configuration knobs

Inline constants in `gateway.cjs` at module scope:

```js
const QUOTA_POLL_INTERVAL_MS = 5 * 60 * 1000;
const QUOTA_THRESHOLDS = [25, 10];  // percent remaining
const QUOTA_RENDER_DELAY_MS = 400;  // post-/status overlay settle time
```

No env vars, no admin-settable overrides. Revisit if polling rate becomes a problem.

## 6. Edge cases

| Case | Behavior |
|---|---|
| Admin tmux session doesn't exist yet (admin hasn't DM'd the bot since gateway restart) | `captureQuota` returns null; poll silently no-ops; `/usage` appends "(quota unavailable)". |
| `tmux` binary missing | Same as above — single log-once warning at boot. |
| `/status` format change breaks regex | Same null path; one-time log per 24h via a timer-gated flag. Admin notices "(quota unavailable)" in next `/usage`. |
| Claude Code is mid-response when `/status` sent | tmux send-keys still delivers; the overlay stacks on top. The Escape key post-capture dismisses it. The in-progress reply is not interrupted because `/status` is a TUI-level command not a message to Claude. Verified during exploration. |
| Admin dismisses the overlay manually (hits Escape before we capture) | Capture runs after the overlay closes, pane shows normal Claude view, regex fails, `captureQuota` returns null. Next 5-min tick tries again. |
| Right-arrow navigation lands on wrong tab (Claude Code reordered tabs) | Regex fails, `captureQuota` returns null. Fix is to adjust the arrow count in `lib/quota-scraper.cjs`. |
| Terminal too narrow — section headers wrap differently | The regex uses a bounded `{0,3}` lookahead so a moderate amount of wrapping is tolerated. Extreme narrowing (< 30 chars) may still break; unlikely for a server-side tmux (column count ≥ 80 by default). |
| Cache file corrupt on boot | `readQuota` returns null; next successful poll re-creates it. No alerts fire on the first post-corruption poll (no `previous` to compare). |
| Both windows cross 25% at the same poll | Two separate alert messages (one per window). |
| Window resets from 3% to 100% between polls | `detectTransitions` notices the jump; clears `lastAlerted["5h_10"]` and `lastAlerted["5h_25"]`. No alert sent on a reset. |
| Poll fires while `/usage` in flight | Capture is guarded by `inFlight` promise; second caller awaits the first. |
| Rapid `/usage` calls (admin spams it) | Each call hits `captureQuota`; in-flight dedup merges concurrent calls; no extra tmux activity. |

## 7. Test plan

### 7.1 `lib/quota-scraper.cjs` — unit tests (`test/quota-scraper.test.cjs`)

Parsing (mock the tmux commands by injecting a `capturePane` callback):
- Fixture = full live-captured Usage tab (session 34%, week all-models 21%, week Sonnet-only 6%) → `{sessionRemainingPct: 66, weekRemainingPct: 79}` (Sonnet-only ignored).
- Pane missing "Current session" section → returns null.
- Pane missing "Current week (all models)" section → returns null.
- Pane contains only "Current week (Sonnet only)" (no all-models block) → returns null (week anchor misses).
- Pane has both blocks but with extra whitespace in the header → regex still matches.
- Reset-time strings round-trip into the optional return fields.
- Concurrency: two concurrent `captureQuota` calls share one tmux invocation (inject a spy counting send-keys calls).

### 7.2 `lib/quota-cache.cjs` — unit tests (`test/quota-cache.test.cjs`)

- Read on missing file returns null.
- Write then read round-trips fields exactly.
- Write shifts `current` → `previous` and puts new data into `current`.
- `lastAlerted` keys that aren't explicitly modified persist across writes.
- Corrupt JSON → `readQuota` returns null without throwing.

### 7.3 Transition logic — unit tests (shared fn, `test/quota-transitions.test.cjs`)

Pure fn `detectTransitions(prev, cur, lastAlerted)` → `{ alertsToFire: Array<{window, threshold, remaining}>, resetsToClear: Array<{window, threshold}> }`:
- No prev → empty alerts, empty resets.
- 30% → 22% with no prior alert → one alert `{window: "session", threshold: 25}`.
- 22% → 18% with prior 25%-alert → no alert (already below).
- 22% → 8% with prior 25%-alert → one alert for 10% (lowest threshold transitioned).
- 95% → 80% (no threshold crossed) → empty.
- 8% → 95% (window reset) → empty alerts, resets include `session_25` and `session_10`.
- Both windows cross 25% in one poll → two alerts.

### 7.4 Integration — gateway wiring (`test/admin-quota-integration.test.cjs`)

Fake tmux (spawn a dummy script that echoes a fixture on `capture-pane -p`), real cache + real scraper + real gateway code path (by extracting `quotaTick` as a testable fn injected with deps):
- Happy 5-min tick: fixture shows 62%/88%, cache updated, no alert payload written.
- Threshold tick: previous shows 30%/90%, fixture shows 22%/88%, one alert file appears in admin outbox.
- `/usage` integration: call the extended handler as admin, assert output includes "Admin quota" section with matching values; call as non-admin, assert output unchanged.

## 8. Rollout

- Gateway restart picks up new code.
- First 5-min tick populates the cache — no alerts (no `previous`).
- Subsequent ticks behave per spec.
- `admin-quota.json` survives restarts — `lastAlerted` persists so alerts don't re-fire across restarts.
- No migration, no new env vars.

## 9. Open questions

- **Should `/usage` cache the scrape for ~30 s so repeated calls are cheap?** **Decision:** no. `/usage` is an admin command, used at most a few times per hour. The in-flight dedup already prevents two concurrent scrapes. Explicit caching adds staleness without benefit.
- **What if admin shares the bot with a team later (non-admin privileged roles)?** Out of scope. The admin-only check is a `jid === ADMIN_JID` comparison in one place; easy to extend to a role system later.
- **Should the poll frequency adapt (faster when near 10%)?** Out of scope. Fixed 5 min is simple and good enough; can revisit once we see real-world behavior.
