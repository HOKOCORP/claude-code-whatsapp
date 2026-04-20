# CCM Per-Workspace Database Provisioning

**Date:** 2026-04-20
**Status:** Approved

## Overview

CCM auto-provisions databases for each isolated workspace. Admin installs database engines via the `ccm` menu; every isolated workspace then auto-gets its own database, user, and connection URLs injected into the session environment.

## Supported Engines

| Engine     | Isolation Model                          | Env Vars                              |
|------------|------------------------------------------|---------------------------------------|
| PostgreSQL | Shared instance, per-workspace db + user | `DATABASE_URL`, `PG*`                 |
| MariaDB    | Shared instance, per-workspace db + user | `MYSQL_URL`, `MYSQL_*`                |
| Redis      | Shared instance, no per-workspace isolation | `REDIS_URL`                        |

### Why shared instances

Per-workspace containers (~100-200MB RAM each) are wasteful for dev workspaces that may only run a few queries. Shared instances with per-workspace SQL users is the standard pattern (RDS, Supabase, PlanetScale). PostgreSQL and MariaDB enforce real isolation via `GRANT` — a workspace user literally cannot see other databases.

### Why Redis has no per-workspace isolation

Redis ACLs force key prefixing (`ccm_hash:*`) which breaks every library's defaults. Per-workspace Redis instances add systemd complexity for negligible benefit. Redis in dev workspaces stores ephemeral data (cache, sessions). Real data lives in PostgreSQL/MariaDB.

## Admin Installation Flow

New `ccm` menu section: **Database Services**.

```
Database Services
─────────────────
1. PostgreSQL  [not installed]
2. MariaDB     [not installed]
3. Redis       [not installed]
4. Back
```

### Installation steps (per engine)

**PostgreSQL:**
```bash
apt install -y postgresql postgresql-client
systemctl enable --now postgresql
# Bind to localhost only (default on Debian)
# Set admin password, store in databases.json
sudo -u postgres psql -c "ALTER USER postgres PASSWORD '<random>';"
```

**MariaDB:**
```bash
apt install -y mariadb-server
systemctl enable --now mariadb
# Run secure installation equivalent:
#   - Set root password
#   - Remove anonymous users
#   - Remove test database
#   - Bind to 127.0.0.1
```

**Redis:**
```bash
apt install -y redis-server
systemctl enable --now redis-server
# Set requirepass in /etc/redis/redis.conf
# Bind to 127.0.0.1 (default)
```

### Config file: `~/.ccm/databases.json`

```json
{
  "postgresql": {
    "installed": true,
    "version": "16",
    "adminPassword": "<random>",
    "installedAt": "2026-04-20T21:30:00Z"
  },
  "mariadb": {
    "installed": true,
    "version": "11",
    "adminPassword": "<random>",
    "installedAt": "2026-04-20T21:30:00Z"
  },
  "redis": {
    "installed": true,
    "version": "7",
    "password": "<random>",
    "installedAt": "2026-04-20T21:30:00Z"
  }
}
```

## Per-Workspace Provisioning

### Trigger points

1. **`ensureProjectUser()`** — on new user creation (initial provisioning)
2. **`ensureUserConfig()`** — on every message for isolated users (catches newly-installed engines for existing workspaces)

### Provisioning logic

For each installed engine that the workspace doesn't have yet:

**PostgreSQL:**
```sql
CREATE USER ccm_<hash> WITH PASSWORD '<random-32-char>';
CREATE DATABASE ccm_<hash> OWNER ccm_<hash>;
```

**MariaDB:**
```sql
CREATE DATABASE IF NOT EXISTS ccm_<hash>;
CREATE USER IF NOT EXISTS 'ccm_<hash>'@'localhost' IDENTIFIED BY '<random-32-char>';
GRANT ALL PRIVILEGES ON ccm_<hash>.* TO 'ccm_<hash>'@'localhost';
FLUSH PRIVILEGES;
```

**Redis:**
No per-workspace provisioning. All workspaces share the same instance + password.

### Naming convention

- Database name: `ccm_<12-char-hash>` (same hash as Linux username, minus the `ccm-` prefix dash → underscore for SQL compatibility)
- Database user: same as database name
- Example: Linux user `ccm-b88c306c536a` → database `ccm_b88c306c536a`

### Credential storage

Authoritative record in the isolation map (`~/.ccm/isolation-users.json`):

```json
{
  "ccm-b88c306c536a": {
    "userId": "120363409624562210",
    "channel": "whatsapp-85258080138",
    "created": 1776712824,
    "port": 10005,
    "subdomain": "b88c306c536a.clawdas.com",
    "databases": {
      "postgresql": { "password": "Kx9mP..." },
      "mariadb": { "password": "Mf7qR..." }
    }
  }
}
```

Redis password is shared (from `databases.json`), not per-workspace.

## Credential Delivery

### Env file

Written to: `/var/lib/ccm/channels/<channel>/users/<userId>/env`

Already sourced by the session launcher:
```bash
if [ -r ".../<userId>/env" ]; then set -a; . ".../<userId>/env"; set +a; fi
```

### Env var format

Both URL format (universal) and individual components (framework-specific):

```bash
# PostgreSQL
DATABASE_URL=postgresql://ccm_b88c306c536a:Kx9mP...@localhost:5432/ccm_b88c306c536a
PGDATABASE=ccm_b88c306c536a
PGUSER=ccm_b88c306c536a
PGPASSWORD=Kx9mP...
PGHOST=localhost
PGPORT=5432

# MariaDB
MYSQL_URL=mysql://ccm_b88c306c536a:Mf7qR...@localhost:3306/ccm_b88c306c536a
MYSQL_DATABASE=ccm_b88c306c536a
MYSQL_USER=ccm_b88c306c536a
MYSQL_PASSWORD=Mf7qR...
MYSQL_HOST=localhost
MYSQL_PORT=3306

# Redis
REDIS_URL=redis://:redispass@localhost:6379
```

### `DATABASE_URL` priority

- If PostgreSQL is installed: `DATABASE_URL` → PostgreSQL
- If only MariaDB is installed: `DATABASE_URL` → MariaDB
- If both: `DATABASE_URL` → PostgreSQL, `MYSQL_URL` → MariaDB

## Claude Discovery

Append to the isolated user's `~/.claude/CLAUDE.md` during provisioning:

```markdown
## Available Databases

Pre-configured databases for this workspace. Use environment variables — never hardcode credentials.

- **PostgreSQL**: `$DATABASE_URL` or individual `$PGUSER`, `$PGPASSWORD`, `$PGDATABASE`, `$PGHOST`
- **MariaDB**: `$MYSQL_URL` or individual `$MYSQL_USER`, `$MYSQL_PASSWORD`, `$MYSQL_DATABASE`, `$MYSQL_HOST`
- **Redis**: `$REDIS_URL`
```

Only lists engines that are actually installed.

## Lifecycle

### Provision (on workspace creation / new engine install)

```
ensureProjectUser() or ensureUserConfig()
  → databasesInstalled()        // read ~/.ccm/databases.json
  → databasesProvision(hash)    // CREATE DATABASE + USER for each
  → databasesWriteEnv(userId)   // write connection URLs to env file
  → update isolation map         // store passwords
```

### Freeze (bot removed / group deleted)

No database action. Data retained during 60-day freeze period. Frozen workspaces can be unfrozen and resume with their data intact.

### Cleanup (after 60-day retention)

```
cleanupFrozenSessions()
  → databasesDeprovision(hash)  // DROP DATABASE + USER
  → userdel -r <username>       // delete Linux user + home
  → update isolation map         // remove entry
```

**PostgreSQL cleanup:**
```sql
DROP DATABASE IF EXISTS ccm_<hash>;
DROP USER IF EXISTS ccm_<hash>;
```

**MariaDB cleanup:**
```sql
DROP DATABASE IF EXISTS ccm_<hash>;
DROP USER IF EXISTS 'ccm_<hash>'@'localhost';
```

## Gateway Functions

### `databasesInstalled()`
Reads `~/.ccm/databases.json`. Returns `{ postgresql: bool, mariadb: bool, redis: bool }`.

### `databasesProvision(hash, isolationEntry)`
For each installed engine: create database + user if not exists. Generate random password. Store in isolation map. Idempotent — safe to call repeatedly.

### `databasesDeprovision(hash)`
Drop database + user for each engine. Idempotent.

### `databasesWriteEnv(userId, isolationEntry)`
Write connection URL env vars to the workspace env file. Called on every `ensureUserConfig` to keep env in sync (handles engine installs/uninstalls).

### `databasesAppendClaudeMd(claudeDir, engines)`
Append database availability section to the user's `~/.claude/CLAUDE.md`. Only runs once (checks if section already exists).

## Security

- All engines bind to `127.0.0.1` only — no external access
- PostgreSQL/MariaDB: per-workspace user can only access its own database
- Redis: shared password, localhost only
- Passwords: 32-character random alphanumeric
- Credentials stored in isolation map (root-owned, 0600)
- Delivered via per-workspace env file (owned by ccm user)
- Admin passwords in `databases.json` (root-owned, 0600)

## Idempotency

All functions check before acting:
- `CREATE USER IF NOT EXISTS` / check `pg_roles`
- `CREATE DATABASE IF NOT EXISTS`
- Env file: rewrite if engines changed, skip if current
- CLAUDE.md: append once, check for existing section
