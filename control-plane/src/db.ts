// Metadata platform di SQLite (bun:sqlite). Migrasi berurutan, dicatat di PRAGMA user_version.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,               -- id user GitLab
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );

  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,               -- id project GitLab
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE memberships (
    user_id INTEGER NOT NULL REFERENCES users(id),
    project_id INTEGER NOT NULL REFERENCES projects(id),
    role TEXT NOT NULL CHECK (role IN ('developer', 'maintainer')),
    last_synced_at TEXT NOT NULL,
    PRIMARY KEY (user_id, project_id)
  );

  CREATE TABLE quotas (
    project_id INTEGER PRIMARY KEY REFERENCES projects(id),
    max_databases INTEGER NOT NULL,
    max_size_mb INTEGER NOT NULL,
    max_connections INTEGER NOT NULL
  );

  CREATE TABLE databases (
    id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    engine TEXT NOT NULL CHECK (engine IN ('postgres', 'mariadb', 'mongo')),
    environment TEXT NOT NULL,
    name TEXT NOT NULL,
    physical_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'read_only', 'blocked', 'deleting', 'deleted', 'failed')),
    size_bytes INTEGER,
    size_checked_at TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  -- Satu nama logis per project/engine/environment selama DB masih ada
  CREATE UNIQUE INDEX databases_logical ON databases(project_id, engine, environment, name) WHERE status NOT IN ('deleted', 'failed');
  CREATE UNIQUE INDEX databases_physical ON databases(engine, physical_name) WHERE status NOT IN ('deleted', 'failed');

  CREATE TABLE credentials (
    database_id TEXT PRIMARY KEY REFERENCES databases(id),
    db_user TEXT NOT NULL,
    password_enc TEXT NOT NULL,
    rotated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE backups (
    id TEXT PRIMARY KEY,
    database_id TEXT NOT NULL REFERENCES databases(id),
    kind TEXT NOT NULL CHECK (kind IN ('daily', 'final', 'manual')),
    path TEXT NOT NULL,
    size_bytes INTEGER,
    status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'expired')),
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX backups_database ON backups(database_id, started_at);

  -- Append-only (FR-28, NFR-12): UPDATE/DELETE ditolak oleh trigger
  CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    actor_id INTEGER,
    actor_username TEXT,
    action TEXT NOT NULL,
    target TEXT,
    project_id INTEGER,
    result TEXT NOT NULL CHECK (result IN ('ok', 'error', 'denied')),
    ip TEXT,
    detail TEXT
  );
  CREATE INDEX audit_project ON audit_events(project_id, id);
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events append-only'); END;

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE job_runs (
    name TEXT PRIMARY KEY,
    last_started_at TEXT,
    last_finished_at TEXT,
    last_status TEXT,
    last_error TEXT
  );
  `,
  `
  -- CI/CD variable yang dibuat platform di GitLab (FR-13..15)
  CREATE TABLE ci_variables (
    database_id TEXT NOT NULL REFERENCES databases(id),
    key TEXT NOT NULL,
    environment_scope TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'deleted')),
    last_error TEXT,
    synced_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (database_id, key)
  );
  `,
]

export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { strict: true, create: true })
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  const { user_version } = db.query('PRAGMA user_version').get() as { user_version: number }
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
    })()
  }
  return db
}

export type Db = Database

// Waktu dalam format datetime() SQLite (UTC, "YYYY-MM-DD HH:MM:SS") supaya bisa dibandingkan dengan datetime('now')
export const sqlTime = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19)
