# CCM Per-Workspace Database Provisioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-provision PostgreSQL, MariaDB, and Redis databases for each CCM isolated workspace, with admin installation via `ccm` menu and per-workspace credential delivery via env vars.

**Architecture:** Shared database engine instances with per-workspace databases and SQL users. Admin installs engines via bash menu; gateway.cjs provisions/deprovisions on workspace lifecycle. Credentials flow through per-user env files already sourced by the session launcher.

**Tech Stack:** Node.js (gateway.cjs), Bash (ccm menu), PostgreSQL 16, MariaDB 11, Redis 7. All SQL commands via `execFileSync` (no shell injection — matches existing gateway patterns).

**Spec:** `docs/superpowers/specs/2026-04-20-database-provisioning-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `gateway.cjs` | Modify | Add database provisioning/deprovisioning/env functions and integration hooks |
| `~/.ccm/lib/databases-menu.sh` | Create | Admin menu for installing/managing database engines |
| `~/.ccm/lib/settings-menu.sh` | Modify | Add `[db] Databases` entry to settings menu |

---

### Task 1: Add DATABASES_CONFIG constant and databasesInstalled()

**Files:**
- Modify: `gateway.cjs:68` (add constant after USAGE_LIMITS_FILE)
- Modify: `gateway.cjs:~988` (add function before syncAdminSkills)

- [ ] **Step 1: Add the DATABASES_CONFIG constant**

In gateway.cjs, after the USAGE_LIMITS_FILE constant (around line 68), add:

```javascript
const DATABASES_CONFIG = path.join(os.homedir(), ".ccm", "databases.json");
```

- [ ] **Step 2: Add databasesInstalled() function**

Before the syncAdminSkills function (around line 988), add:

```javascript
function databasesInstalled() {
  try {
    const cfg = JSON.parse(fs.readFileSync(DATABASES_CONFIG, "utf8"));
    return {
      postgresql: !!(cfg.postgresql && cfg.postgresql.installed),
      mariadb: !!(cfg.mariadb && cfg.mariadb.installed),
      redis: !!(cfg.redis && cfg.redis.installed),
    };
  } catch {
    return { postgresql: false, mariadb: false, redis: false };
  }
}
```

- [ ] **Step 3: Add helpers — dbName() and dbRandomPassword()**

```javascript
function dbName(username) {
  return username.replace(/-/g, "_");
}

function dbRandomPassword() {
  return crypto.randomBytes(24).toString("base64url").slice(0, 32);
}
```

- [ ] **Step 4: Verify syntax**

Run: `node -c gateway.cjs` — expected: no errors.

- [ ] **Step 5: Commit**

```
git add gateway.cjs && git commit -m "feat(databases): add DATABASES_CONFIG, databasesInstalled, helpers"
```

---

### Task 2: Add databasesProvision()

**Files:**
- Modify: `gateway.cjs` (add function after helpers from Task 1)

- [ ] **Step 1: Add databasesProvision()**

Insert after dbRandomPassword():

```javascript
function databasesProvision(username) {
  const engines = databasesInstalled();
  if (!engines.postgresql && !engines.mariadb && !engines.redis) return null;

  const sqlName = dbName(username);
  const result = {};

  if (engines.postgresql) {
    try {
      const check = execFileSync("sudo", ["-u", "postgres", "psql", "-tAc",
        `SELECT 1 FROM pg_roles WHERE rolname='${sqlName}'`], { encoding: "utf8" }).trim();
      if (check !== "1") {
        const pw = dbRandomPassword();
        execFileSync("sudo", ["-u", "postgres", "psql", "-c",
          `CREATE USER ${sqlName} WITH PASSWORD '${pw}'`], { stdio: "ignore" });
        execFileSync("sudo", ["-u", "postgres", "psql", "-c",
          `CREATE DATABASE ${sqlName} OWNER ${sqlName}`], { stdio: "ignore" });
        result.postgresql = { password: pw };
        log(`databases: provisioned PostgreSQL db+user ${sqlName}`);
      } else {
        log(`databases: PostgreSQL user ${sqlName} already exists`);
      }
    } catch (e) {
      log(`databases: PostgreSQL provision failed for ${sqlName}: ${e.message}`);
    }
  }

  if (engines.mariadb) {
    try {
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(DATABASES_CONFIG, "utf8")); } catch {}
      const adminPw = cfg.mariadb?.adminPassword || "";
      const check = execFileSync("mysql", ["-u", "root", `--password=${adminPw}`, "-sNe",
        `SELECT COUNT(*) FROM mysql.user WHERE User='${sqlName}'`], { encoding: "utf8" }).trim();
      if (check === "0") {
        const pw = dbRandomPassword();
        const sql = [
          `CREATE DATABASE IF NOT EXISTS \`${sqlName}\`;`,
          `CREATE USER '${sqlName}'@'localhost' IDENTIFIED BY '${pw}';`,
          `GRANT ALL PRIVILEGES ON \`${sqlName}\`.* TO '${sqlName}'@'localhost';`,
          `FLUSH PRIVILEGES;`,
        ].join("\n");
        execFileSync("mysql", ["-u", "root", `--password=${adminPw}`, "-e", sql], { stdio: "ignore" });
        result.mariadb = { password: pw };
        log(`databases: provisioned MariaDB db+user ${sqlName}`);
      } else {
        log(`databases: MariaDB user ${sqlName} already exists`);
      }
    } catch (e) {
      log(`databases: MariaDB provision failed for ${sqlName}: ${e.message}`);
    }
  }

  return Object.keys(result).length ? result : null;
}
```

- [ ] **Step 2: Verify syntax**

Run: `node -c gateway.cjs` — expected: no errors.

- [ ] **Step 3: Commit**

```
git add gateway.cjs && git commit -m "feat(databases): add databasesProvision() for PG and MariaDB"
```

---

### Task 3: Add databasesDeprovision()

**Files:**
- Modify: `gateway.cjs` (add after databasesProvision)

- [ ] **Step 1: Add databasesDeprovision()**

```javascript
function databasesDeprovision(username) {
  const sqlName = dbName(username);

  try {
    execFileSync("sudo", ["-u", "postgres", "psql", "-c",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${sqlName}'`], { stdio: "ignore" });
    execFileSync("sudo", ["-u", "postgres", "psql", "-c",
      `DROP DATABASE IF EXISTS ${sqlName}`], { stdio: "ignore" });
    execFileSync("sudo", ["-u", "postgres", "psql", "-c",
      `DROP USER IF EXISTS ${sqlName}`], { stdio: "ignore" });
    log(`databases: deprovisioned PostgreSQL ${sqlName}`);
  } catch (e) {
    log(`databases: PostgreSQL deprovision ${sqlName}: ${e.message}`);
  }

  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(DATABASES_CONFIG, "utf8")); } catch {}
    const adminPw = cfg.mariadb?.adminPassword || "";
    const sql = `DROP DATABASE IF EXISTS \`${sqlName}\`; DROP USER IF EXISTS '${sqlName}'@'localhost';`;
    execFileSync("mysql", ["-u", "root", `--password=${adminPw}`, "-e", sql], { stdio: "ignore" });
    log(`databases: deprovisioned MariaDB ${sqlName}`);
  } catch (e) {
    log(`databases: MariaDB deprovision ${sqlName}: ${e.message}`);
  }
}
```

- [ ] **Step 2: Verify syntax and commit**

```
node -c gateway.cjs && git add gateway.cjs && git commit -m "feat(databases): add databasesDeprovision()"
```

---

### Task 4: Add databasesWriteEnv() and databasesAppendClaudeMd()

**Files:**
- Modify: `gateway.cjs` (add after databasesDeprovision)

- [ ] **Step 1: Add databasesWriteEnv()**

```javascript
function databasesWriteEnv(userId, username) {
  const engines = databasesInstalled();
  if (!engines.postgresql && !engines.mariadb && !engines.redis) return;

  let mapping = {};
  try { mapping = JSON.parse(fs.readFileSync(ISOLATION_MAP, "utf8")); } catch {}
  const entry = mapping[username];
  if (!entry) return;
  const dbs = entry.databases || {};
  const sqlName = dbName(username);
  const lines = [];

  if (engines.postgresql && dbs.postgresql) {
    const pw = dbs.postgresql.password;
    lines.push("# PostgreSQL");
    lines.push(`DATABASE_URL=postgresql://${sqlName}:${pw}@localhost:5432/${sqlName}`);
    lines.push(`PGDATABASE=${sqlName}`, `PGUSER=${sqlName}`, `PGPASSWORD=${pw}`);
    lines.push("PGHOST=localhost", "PGPORT=5432");
  }

  if (engines.mariadb && dbs.mariadb) {
    const pw = dbs.mariadb.password;
    lines.push("# MariaDB");
    lines.push(`MYSQL_URL=mysql://${sqlName}:${pw}@localhost:3306/${sqlName}`);
    lines.push(`MYSQL_DATABASE=${sqlName}`, `MYSQL_USER=${sqlName}`, `MYSQL_PASSWORD=${pw}`);
    lines.push("MYSQL_HOST=localhost", "MYSQL_PORT=3306");
    if (!engines.postgresql || !dbs.postgresql) {
      lines.push(`DATABASE_URL=mysql://${sqlName}:${pw}@localhost:3306/${sqlName}`);
    }
  }

  if (engines.redis) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(DATABASES_CONFIG, "utf8")); } catch {}
    const redisPw = cfg.redis?.password || "";
    const auth = redisPw ? `:${redisPw}@` : "";
    lines.push("# Redis");
    lines.push(`REDIS_URL=redis://${auth}localhost:6379`);
  }

  if (!lines.length) return;

  const envFile = path.join(USERS_DIR, userId, "env");
  let existing = "";
  try { existing = fs.readFileSync(envFile, "utf8"); } catch {}

  const marker = "# --- CCM Databases ---";
  const endMarker = "# --- /CCM Databases ---";
  const startIdx = existing.indexOf(marker);
  const endIdx = existing.indexOf(endMarker);
  if (startIdx !== -1 && endIdx !== -1) {
    existing = existing.slice(0, startIdx) + existing.slice(endIdx + endMarker.length + 1);
  }

  const dbSection = [marker, ...lines, endMarker].join("\n") + "\n";
  fs.writeFileSync(envFile, existing.trimEnd() + "\n" + dbSection);
}
```

- [ ] **Step 2: Add databasesAppendClaudeMd()**

```javascript
function databasesAppendClaudeMd(claudeDir) {
  const engines = databasesInstalled();
  if (!engines.postgresql && !engines.mariadb && !engines.redis) return;

  const claudeMdPath = path.join(claudeDir, "CLAUDE.md");
  let content = "";
  try { content = fs.readFileSync(claudeMdPath, "utf8"); } catch { return; }
  if (content.includes("## Available Databases")) return;

  const dbLines = ["", "## Available Databases", "",
    "Pre-configured databases for this workspace. Use environment variables — never hardcode credentials.", ""];
  if (engines.postgresql) dbLines.push("- **PostgreSQL**: `$DATABASE_URL` or individual `$PGUSER`, `$PGPASSWORD`, `$PGDATABASE`, `$PGHOST`");
  if (engines.mariadb) dbLines.push("- **MariaDB**: `$MYSQL_URL` or individual `$MYSQL_USER`, `$MYSQL_PASSWORD`, `$MYSQL_DATABASE`, `$MYSQL_HOST`");
  if (engines.redis) dbLines.push("- **Redis**: `$REDIS_URL`");
  dbLines.push("");

  fs.appendFileSync(claudeMdPath, dbLines.join("\n"));
}
```

- [ ] **Step 3: Verify syntax and commit**

```
node -c gateway.cjs && git add gateway.cjs && git commit -m "feat(databases): add databasesWriteEnv() and databasesAppendClaudeMd()"
```

---

### Task 5: Wire into ensureProjectUser, ensureUserConfig, and cleanup

**Files:**
- Modify: `gateway.cjs` — three insertion points

- [ ] **Step 1: Wire into ensureProjectUser() — new user path**

After `syncAdminSkills(claudeDir, username);` (around line 1260), before the chown block, add:

```javascript
  // Provision databases for this workspace
  const _newDbs = databasesProvision(username);
```

Then, after the line `mapping[username] = { userId, channel: ... }` (around line 1274), add:

```javascript
  if (_newDbs) mapping[username].databases = _newDbs;
```

Then, after the isolation map is written to disk (`fs.writeFileSync(ISOLATION_MAP, ...)`), add:

```javascript
  if (mapping[username].databases) {
    databasesWriteEnv(userId, username);
    databasesAppendClaudeMd(claudeDir);
  }
```

- [ ] **Step 2: Wire into ensureUserConfig() — existing isolated users**

After the `syncAdminSkills` block for isolated users (around line 1610), add:

```javascript
  if (projectUser) {
    const engines = databasesInstalled();
    if (engines.postgresql || engines.mariadb || engines.redis) {
      let mapping = {};
      try { mapping = JSON.parse(fs.readFileSync(ISOLATION_MAP, "utf8")); } catch {}
      const entry = mapping[projectUser.username];
      if (entry && !entry.databases) {
        const newDbs = databasesProvision(projectUser.username);
        if (newDbs) {
          entry.databases = newDbs;
          fs.writeFileSync(ISOLATION_MAP, JSON.stringify(mapping, null, 2));
        }
      }
      databasesWriteEnv(userId, projectUser.username);
      databasesAppendClaudeMd(path.join(projectUser.homeDir, ".claude"));
    }
  }
```

- [ ] **Step 3: Wire into cleanupFrozenSessions() — before userdel**

After `domainsDeprovision(username);` and before `execFileSync("userdel", ...)`, add:

```javascript
      databasesDeprovision(username);
```

- [ ] **Step 4: Verify syntax**

Run: `node -c gateway.cjs` — expected: no errors.

- [ ] **Step 5: Commit**

```
git add gateway.cjs && git commit -m "feat(databases): wire provisioning into lifecycle hooks"
```

---

### Task 6: Create ccm Database Services menu

**Files:**
- Create: `~/.ccm/lib/databases-menu.sh`
- Modify: `~/.ccm/lib/settings-menu.sh`

- [ ] **Step 1: Create databases-menu.sh**

Create `~/.ccm/lib/databases-menu.sh` with the full menu script. It should include:
- `_db_read_config()` / `_db_write_config()` — JSON config helpers
- `_db_is_installed()` — check if an engine is installed
- `_db_random_password()` — generate 32-char password
- `_install_postgresql()` — apt install, set admin password, write config
- `_install_mariadb()` — apt install, secure installation, write config
- `_install_redis()` — apt install, set requirepass, write config
- `show_databases_menu()` — interactive menu loop with [1] PG, [2] MariaDB, [3] Redis, [q] Back

Each install function: apt install, enable systemd service, set admin password, store in databases.json.

- [ ] **Step 2: Make executable**

```bash
chmod +x ~/.ccm/lib/databases-menu.sh
```

- [ ] **Step 3: Add [db] entry to settings-menu.sh**

In the display section, add a line showing database status.
In the case statement, add a `db)` case that sources databases-menu.sh and calls `show_databases_menu`.

- [ ] **Step 4: Commit**

```
git add ~/.ccm/lib/databases-menu.sh ~/.ccm/lib/settings-menu.sh
git commit -m "feat(databases): add Database Services menu to ccm settings"
```

---

### Task 7: Deploy and test on Hetzner

- [ ] **Step 1: Push and pull**

```bash
cd ~/claude-code-whatsapp && node -c gateway.cjs && git push origin main
# On Hetzner:
cd ~/claude-code-whatsapp && git pull origin main
```

- [ ] **Step 2: Copy menu scripts to Hetzner**

```bash
scp ~/.ccm/lib/databases-menu.sh root@195.201.221.142:~/.ccm/lib/
scp ~/.ccm/lib/settings-menu.sh root@195.201.221.142:~/.ccm/lib/
```

- [ ] **Step 3: Restart gateway**

```bash
kill $(pgrep -f "node.*gateway.cjs" | head -1)
# Verify reconnected in gateway.log
```

- [ ] **Step 4: Install PostgreSQL via menu**

```bash
source ~/.ccm/lib/databases-menu.sh && _install_postgresql
cat ~/.ccm/databases.json  # verify config
sudo -u postgres psql -c "SELECT version();"  # verify running
```

- [ ] **Step 5: Test provisioning — send message in a group**

Verify after message:
- Database created: `sudo -u postgres psql -c "\l" | grep ccm_`
- Env file updated: `cat /var/lib/ccm/.../users/<id>/env | grep DATABASE`
- CLAUDE.md updated: `grep "Available Databases" /home/ccm-<hash>/.claude/CLAUDE.md`

- [ ] **Step 6: Commit any test fixes**

```
git add -A && git commit -m "fix(databases): adjustments from e2e testing" && git push origin main
```
