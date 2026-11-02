// Backup logis per database (FR-26). Engine adalah instance bare-metal di server, jadi dump dijalankan dari
// container control plane dengan tool klien yang versinya disamakan dengan server (lihat Dockerfile), lewat
// jaringan memakai akun admin. File ditulis ke BACKUP_DIR (direktori host yang di-mount).
import { mkdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Db } from '../db.ts'
import { sqlTime } from '../db.ts'
import type { Config } from '../config.ts'
import { engineConfig } from '../config.ts'
import type { Audit } from '../audit.ts'
import type { EngineName } from '../engines/index.ts'

type Row = { id: string; project_id: number; engine: EngineName; physical_name: string }
export type BackupRecord = {
  id: string; database_id: string; kind: string; path: string; size_bytes: number | null
  status: 'running' | 'ok' | 'failed' | 'expired'; error: string | null; started_at: string; finished_at: string | null; expires_at: string
}

const EXT: Record<EngineName, string> = { postgres: 'dump', mariadb: 'sql.gz', mongo: 'archive.gz' }

// Perintah dump per engine; kredensial lewat env, bukan argv (tidak terlihat di daftar proses)
function dumpCommand(cfg: Config, engine: EngineName, database: string, file: string) {
  const u = new URL(engineConfig(cfg, engine).adminUrl)
  const user = decodeURIComponent(u.username), password = decodeURIComponent(u.password)
  const env = { FILE: file, DB: database, HOST: u.hostname, PORT: u.port }
  switch (engine) {
    case 'postgres':
      return {
        cmd: ['sh', '-c', 'pg_dump -h "$HOST" -p "${PORT:-5432}" -U "$PGUSER" -Fc -f "$FILE" "$DB"'],
        env: { ...env, PGUSER: user, PGPASSWORD: password, PGCONNECT_TIMEOUT: '10' },
      }
    case 'mariadb':
      // MariaDB ≥ 11 tidak lagi menyediakan alias mysqldump (spike DX-4)
      return {
        cmd: ['sh', '-c', 'mariadb-dump -h "$HOST" -P "${PORT:-3306}" -u "$MYUSER" --single-transaction --routines --events "$DB" > "$FILE.tmp" && gzip -c "$FILE.tmp" > "$FILE"; rc=$?; rm -f "$FILE.tmp"; exit $rc'],
        env: { ...env, MYUSER: user, MYSQL_PWD: password },
      }
    case 'mongo': {
      const uri = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${u.host}/?authSource=admin`
      return {
        cmd: ['sh', '-c', 'mongodump --quiet --uri="$URI" --db="$DB" --archive="$FILE" --gzip'],
        env: { ...env, URI: uri },
      }
    }
  }
}

async function exec(cmd: string[], env: Record<string, string>) {
  const p = Bun.spawn(cmd, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, stdout: 'ignore', stderr: 'pipe' })
  const [exitCode, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()])
  return { exitCode, stderr }
}

export function createBackupService(deps: { db: Db; cfg: Config; audit: Audit }) {
  const { db, cfg, audit } = deps
  const get = (id: string) => db.query(`SELECT * FROM backups WHERE id = ?`).get(id) as BackupRecord

  async function run(row: Row, kind: 'daily' | 'final' | 'manual'): Promise<BackupRecord> {
    const id = crypto.randomUUID()
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')
    const file = `${cfg.backup.dir}/${row.engine}/${row.physical_name}/${stamp}-${kind}.${EXT[row.engine]}`
    const expires = new Date(Date.now() + cfg.backup.retentionDays * 86400_000)
    db.query(`INSERT INTO backups (id, database_id, kind, path, status, expires_at) VALUES (?, ?, ?, ?, 'running', ?)`)
      .run(id, row.id, kind, file, sqlTime(expires))

    try {
      mkdirSync(dirname(file), { recursive: true })
      const { cmd, env } = dumpCommand(cfg, row.engine, row.physical_name, file)
      const r = await exec(cmd, env)
      if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`)
      const size = statSync(file).size
      if (!(size > 0)) throw new Error('file backup kosong')
      db.query(`UPDATE backups SET status = 'ok', size_bytes = ?, finished_at = datetime('now') WHERE id = ?`).run(size, id)
    } catch (e: any) {
      db.query(`UPDATE backups SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`).run(e.message, id)
      audit.log({ actor: null, action: 'backup.run', target: `database:${row.id}`, projectId: row.project_id, result: 'error',
        detail: { kind, error: e.message } })
    }
    return get(id)
  }

  return {
    run,

    list(databaseId: string) {
      return db.query(`SELECT id, kind, size_bytes, status, error, started_at, finished_at, expires_at FROM backups
        WHERE database_id = ? AND status != 'expired' ORDER BY started_at DESC`).all(databaseId)
    },

    // Job harian (02.00 WIB): satu file per database aktif, berurutan supaya tidak membebani server
    async runDaily() {
      const rows = db.query(`SELECT id, project_id, engine, physical_name FROM databases WHERE status IN ('ready', 'read_only', 'blocked')`).all() as Row[]
      let ok = 0, failed = 0
      for (const r of rows) ((await run(r, 'daily')).status === 'ok' ? ok++ : failed++)
      audit.log({ actor: null, action: 'backup.daily', result: failed ? 'error' : 'ok', detail: { ok, failed } })
      if (failed) throw new Error(`${failed} dari ${rows.length} backup gagal`)
      return { ok, failed }
    },

    // Hapus file yang melewati retensi, termasuk backup akhir database yang sudah dihapus
    async expire() {
      const due = db.query(`SELECT b.id, b.path, d.engine FROM backups b JOIN databases d ON d.id = b.database_id
        WHERE b.status IN ('ok', 'failed') AND b.expires_at <= datetime('now')`).all() as { id: string; path: string; engine: EngineName }[]
      let removed = 0
      for (const b of due) {
        if (!b.path.startsWith(cfg.backup.dir + '/')) continue
        try {
          unlinkSync(b.path)
        } catch (e: any) {
          if (e?.code !== 'ENOENT') continue
        }
        db.query(`UPDATE backups SET status = 'expired' WHERE id = ?`).run(b.id)
        removed++
      }
      return { removed }
    },
  }
}
export type BackupService = ReturnType<typeof createBackupService>
