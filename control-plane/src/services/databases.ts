// Siklus hidup database tenant: provisioning (FR-06..08), credential (FR-11, FR-12), hapus (FR-09), quota (FR-24)
import type { Db } from '../db.ts'
import type { Audit, Actor } from '../audit.ts'
import type { Cipher } from '../crypto.ts'
import { generatePassword } from '../crypto.ts'
import type { Config } from '../config.ts'
import { engineConfig } from '../config.ts'
import type { Engines, EngineName, WriteMode } from '../engines/index.ts'
import { engineDriver } from '../engines/index.ts'
import type { BackupService } from './backups.ts'
import type { CiVariableService } from './ci-variables.ts'

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message) }
}

export type DatabaseRow = {
  id: string; project_id: number; engine: EngineName; environment: string; name: string; physical_name: string
  status: 'provisioning' | 'ready' | 'read_only' | 'blocked' | 'deleting' | 'deleted' | 'failed'
  size_bytes: number | null; size_checked_at: string | null; created_by: number | null; created_at: string; deleted_at: string | null
}

const ENV_RE = /^[a-z][a-z0-9]{0,11}$/
const NAME_RE = /^[a-z][a-z0-9_]{0,23}$/
const ACTIVE = `status IN ('provisioning', 'ready', 'read_only', 'blocked', 'deleting')`

// Nama fisik unik dan aman di ketiga engine, mis. p142_staging_app / p142_staging_app_u
export const physicalName = (projectId: number, environment: string, name: string, prefix = '') => `${prefix}p${projectId}_${environment}_${name}`
export const tenantUser = (physical: string) => `${physical}_u`

const statusFor = (mode: WriteMode): DatabaseRow['status'] => (mode === 'none' ? 'ready' : mode)
const modeFor = (status: DatabaseRow['status']): WriteMode =>
  status === 'read_only' ? 'read_only' : status === 'blocked' ? 'blocked' : 'none'

export function createDatabaseService(deps: {
  db: Db; engines: Engines; cipher: Cipher; audit: Audit; cfg: Config; backups: BackupService; ci: CiVariableService
}) {
  const { db, engines, cipher, audit, cfg, backups, ci } = deps
  // Sinkron GitLab tidak boleh menggagalkan operasi DB; kegagalan tercatat dan dicoba ulang oleh job
  const ciSafely = (fn: () => Promise<unknown>) => fn().catch(e => console.error('sinkron CI gagal:', e))

  const get = (id: string) => db.query(`SELECT * FROM databases WHERE id = ?`).get(id) as DatabaseRow | null
  const setStatus = (id: string, status: DatabaseRow['status']) =>
    db.query(`UPDATE databases SET status = ? WHERE id = ?`).run(status, id)
  const quotaOf = (projectId: number) => db.query(`SELECT * FROM quotas WHERE project_id = ?`).get(projectId) as
    { max_databases: number; max_size_mb: number; max_connections: number } | null

  function credentials(id: string) {
    const c = db.query(`SELECT db_user, password_enc, rotated_at FROM credentials WHERE database_id = ?`).get(id) as
      { db_user: string; password_enc: string; rotated_at: string } | null
    if (!c) throw new HttpError(404, 'credential tidak ditemukan')
    return c
  }

  function usage(projectId: number) {
    return db.query(`SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS size FROM databases WHERE project_id = ? AND ${ACTIVE}`)
      .get(projectId) as { count: number; size: number }
  }

  function publicInfo(row: DatabaseRow) {
    const e = engineConfig(cfg, row.engine)
    const c = row.status === 'deleted' ? null : credentials(row.id)
    return {
      id: row.id, projectId: row.project_id, engine: row.engine, environment: row.environment, name: row.name,
      status: row.status, sizeBytes: row.size_bytes, sizeCheckedAt: row.size_checked_at, createdAt: row.created_at,
      connection: c && {
        host: e.publicHost, port: e.publicPort, database: row.physical_name, user: c.db_user, passwordRotatedAt: c.rotated_at,
        // Password disembunyikan sampai diminta (FR-11)
        connectionString: engineDriver(engines, row.engine).connectionString(e.publicHost, e.publicPort, row.physical_name, c.db_user, '********'),
      },
    }
  }

  return {
    get,
    publicInfo,
    usage,

    // Ringkasan per project untuk dashboard; dihitung dari dua query, bukan satu query per project
    summaries<P extends { id: number }>(projects: P[]) {
      const rows = db.query(`SELECT project_id, engine, status, size_bytes FROM databases WHERE ${ACTIVE} ORDER BY created_at`)
        .all() as Pick<DatabaseRow, 'project_id' | 'engine' | 'status' | 'size_bytes'>[]
      const quotas = new Map((db.query(`SELECT project_id, max_databases FROM quotas`).all() as
        { project_id: number; max_databases: number }[]).map(q => [q.project_id, q.max_databases]))
      const byProject = new Map<number, typeof rows>()
      for (const r of rows) byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), r])
      return projects.map(p => {
        const own = byProject.get(p.id) ?? []
        return {
          ...p,
          databases: own.length,
          maxDatabases: quotas.get(p.id) ?? cfg.quotaDefaults.maxDatabases,
          sizeBytes: own.reduce((s, r) => s + (r.size_bytes ?? 0), 0),
          limited: own.filter(r => r.status === 'read_only' || r.status === 'blocked').length,
          engines: [...new Set(own.map(r => r.engine))],
        }
      })
    },

    list(projectId: number) {
      return (db.query(`SELECT * FROM databases WHERE project_id = ? AND ${ACTIVE} ORDER BY created_at`).all(projectId) as DatabaseRow[])
        .map(publicInfo)
    },

    async create(actor: Actor, projectId: number, input: { engine: string; environment: string; name: string }, ip: string | null) {
      const engine = input.engine as EngineName
      if (!cfg.enabledEngines.includes(engine)) throw new HttpError(400, `engine harus salah satu dari: ${cfg.enabledEngines.join(', ')}`)
      if (!ENV_RE.test(input.environment ?? '')) throw new HttpError(400, 'environment: huruf kecil/angka, diawali huruf, maks 12 karakter')
      if (!NAME_RE.test(input.name ?? '')) throw new HttpError(400, 'nama: huruf kecil/angka/_, diawali huruf, maks 24 karakter')

      const physical = physicalName(projectId, input.environment, input.name, cfg.tenantPrefix)
      const user = tenantUser(physical)
      const password = generatePassword()
      const id = crypto.randomUUID()
      const t0 = performance.now()

      // Cek quota + reservasi baris dalam satu transaksi sinkron, supaya dua request paralel tidak lolos bersama
      db.transaction(() => {
        const quota = quotaOf(projectId)
        if (!quota) throw new HttpError(404, 'project tidak dikenal')
        const u = usage(projectId)
        if (u.count >= quota.max_databases)
          throw new HttpError(409, `quota penuh: project sudah punya ${u.count} dari ${quota.max_databases} database. Ajukan kenaikan quota ke admin.`)
        if (u.size >= quota.max_size_mb * 1024 * 1024)
          throw new HttpError(409, `quota ukuran penuh (${Math.round(u.size / 1048576)} dari ${quota.max_size_mb} MB). Kosongkan data atau ajukan kenaikan quota.`)
        // Nama unik per environment lintas engine, karena nama CI variable diturunkan dari nama ini
        const dup = db.query(`SELECT engine FROM databases WHERE project_id = ? AND environment = ? AND name = ? AND ${ACTIVE}`)
          .get(projectId, input.environment, input.name) as { engine: string } | null
        if (dup) throw new HttpError(409, `nama "${input.name}" sudah dipakai database ${dup.engine} di environment ${input.environment}`)
        db.query(`INSERT INTO databases (id, project_id, engine, environment, name, physical_name, status, created_by)
          VALUES (?, ?, ?, ?, ?, ?, 'provisioning', ?)`).run(id, projectId, engine, input.environment, input.name, physical, actor?.id ?? null)
        db.query(`INSERT INTO credentials (database_id, db_user, password_enc) VALUES (?, ?, ?)`).run(id, user, cipher.encrypt(password))
      })()

      const quota = quotaOf(projectId)!
      const driver = engineDriver(engines, engine)
      try {
        await driver.provision({ database: physical, user, password, maxConnections: quota.max_connections, timeoutS: cfg.queryTimeoutS })
        if (!(await driver.tenantCanConnect(physical, user, password))) throw new Error('verifikasi login tenant gagal')
        setStatus(id, 'ready')
      } catch (e: any) {
        // Rollback di engine; nama bisa dipakai lagi karena baris 'failed' tidak dihitung unik
        await driver.deprovision(physical, user).catch(() => {})
        db.query(`DELETE FROM credentials WHERE database_id = ?`).run(id)
        setStatus(id, 'failed')
        audit.log({ actor, action: 'database.create', target: `database:${id}`, projectId, result: 'error', ip,
          detail: { engine, environment: input.environment, name: input.name, error: e.message } })
        throw new HttpError(502, `provisioning gagal: ${e.message}`)
      }
      const ms = Math.round(performance.now() - t0)
      audit.log({ actor, action: 'database.create', target: `database:${id}`, projectId, result: 'ok', ip,
        detail: { engine, environment: input.environment, name: input.name, physical, ms } })
      await ciSafely(() => ci.sync(get(id)!))
      return publicInfo(get(id)!)
    },

    revealPassword(actor: Actor, row: DatabaseRow, ip: string | null) {
      const c = credentials(row.id)
      const e = engineConfig(cfg, row.engine)
      const password = cipher.decrypt(c.password_enc)
      audit.log({ actor, action: 'credential.reveal', target: `database:${row.id}`, projectId: row.project_id, result: 'ok', ip })
      return {
        password,
        connectionString: engineDriver(engines, row.engine).connectionString(e.publicHost, e.publicPort, row.physical_name, c.db_user, password),
      }
    },

    async rotatePassword(actor: Actor, row: DatabaseRow, ip: string | null) {
      if (!['ready', 'read_only', 'blocked'].includes(row.status)) throw new HttpError(409, `database berstatus ${row.status}`)
      const c = credentials(row.id)
      const password = generatePassword()
      const enc = cipher.encrypt(password)
      try {
        await engineDriver(engines, row.engine).rotatePassword(c.db_user, password)
      } catch (e: any) {
        audit.log({ actor, action: 'credential.rotate', target: `database:${row.id}`, projectId: row.project_id, result: 'error', ip, detail: { error: e.message } })
        throw new HttpError(502, `rotasi gagal: ${e.message}`)
      }
      db.query(`UPDATE credentials SET password_enc = ?, rotated_at = datetime('now') WHERE database_id = ?`).run(enc, row.id)
      audit.log({ actor, action: 'credential.rotate', target: `database:${row.id}`, projectId: row.project_id, result: 'ok', ip })
      await ciSafely(() => ci.sync(row))
      return publicInfo(get(row.id)!)
    },

    async remove(actor: Actor, row: DatabaseRow, confirmName: string, ip: string | null) {
      if (confirmName !== row.name) throw new HttpError(400, `konfirmasi tidak cocok: ketik nama database "${row.name}"`)
      if (!['ready', 'read_only', 'blocked'].includes(row.status)) throw new HttpError(409, `database berstatus ${row.status}`)
      const prev = row.status
      setStatus(row.id, 'deleting')
      // Backup terakhir disimpan sesuai retensi (FR-09); kalau gagal, penghapusan dibatalkan
      const backup = await backups.run(row, 'final')
      if (backup.status !== 'ok') {
        setStatus(row.id, prev)
        audit.log({ actor, action: 'database.delete', target: `database:${row.id}`, projectId: row.project_id, result: 'error', ip,
          detail: { error: `backup akhir gagal: ${backup.error}` } })
        throw new HttpError(502, `backup akhir gagal, database tidak dihapus: ${backup.error}`)
      }
      const c = credentials(row.id)
      try {
        await engineDriver(engines, row.engine).deprovision(row.physical_name, c.db_user)
      } catch (e: any) {
        setStatus(row.id, prev)
        audit.log({ actor, action: 'database.delete', target: `database:${row.id}`, projectId: row.project_id, result: 'error', ip, detail: { error: e.message } })
        throw new HttpError(502, `hapus gagal: ${e.message}`)
      }
      db.transaction(() => {
        db.query(`UPDATE databases SET status = 'deleted', deleted_at = datetime('now') WHERE id = ?`).run(row.id)
        db.query(`DELETE FROM credentials WHERE database_id = ?`).run(row.id)
      })()
      audit.log({ actor, action: 'database.delete', target: `database:${row.id}`, projectId: row.project_id, result: 'ok', ip,
        detail: { physical: row.physical_name, finalBackup: backup.id } })
      await ciSafely(() => ci.remove(row))
    },

    // Job tiap 5 menit: perbarui ukuran, lalu tegakkan quota ukuran per project (FR-24, OT-7)
    async enforceQuotas() {
      const rows = db.query(`SELECT * FROM databases WHERE status IN ('ready', 'read_only', 'blocked')`).all() as DatabaseRow[]
      let errors = 0
      for (const r of rows) {
        try {
          const size = await engineDriver(engines, r.engine).sizeBytes(r.physical_name)
          db.query(`UPDATE databases SET size_bytes = ?, size_checked_at = datetime('now') WHERE id = ?`).run(size, r.id)
          r.size_bytes = size
        } catch { errors++ }
      }
      const transitions: { id: string; from: string; to: string }[] = []
      for (const projectId of new Set(rows.map(r => r.project_id))) {
        const quota = quotaOf(projectId)
        if (!quota) continue
        const used = rows.filter(r => r.project_id === projectId).reduce((s, r) => s + (r.size_bytes ?? 0), 0)
        const percent = (used / (quota.max_size_mb * 1024 * 1024)) * 100
        for (const r of rows.filter(x => x.project_id === projectId)) {
          const mode: WriteMode = percent < 100 ? 'none'
            : r.engine === 'postgres' && percent >= cfg.pgHardBlockPercent ? 'blocked' : 'read_only'
          if (modeFor(r.status) === mode) continue
          try {
            await engineDriver(engines, r.engine).setWriteMode(r.physical_name, credentials(r.id).db_user, mode)
            setStatus(r.id, statusFor(mode))
            transitions.push({ id: r.id, from: r.status, to: statusFor(mode) })
            audit.log({ actor: null, action: 'quota.enforce', target: `database:${r.id}`, projectId, result: 'ok',
              detail: { from: r.status, to: statusFor(mode), usedBytes: used, limitMb: quota.max_size_mb, percent: Math.round(percent) } })
          } catch (e: any) {
            errors++
            audit.log({ actor: null, action: 'quota.enforce', target: `database:${r.id}`, projectId, result: 'error', detail: { error: e.message } })
          }
        }
      }
      return { checked: rows.length, transitions, errors }
    },

    setQuota(actor: Actor, projectId: number, q: { maxDatabases: number; maxSizeMb: number; maxConnections: number }, ip: string | null) {
      for (const [k, v] of Object.entries(q)) if (!Number.isInteger(v) || v < 0 || v > 1_000_000) throw new HttpError(400, `${k} tidak valid`)
      const r = db.query(`UPDATE quotas SET max_databases = ?, max_size_mb = ?, max_connections = ? WHERE project_id = ?`)
        .run(q.maxDatabases, q.maxSizeMb, q.maxConnections, projectId)
      if (!r.changes) throw new HttpError(404, 'project tidak dikenal')
      audit.log({ actor, action: 'quota.set', target: `project:${projectId}`, projectId, result: 'ok', ip, detail: q })
      return quotaOf(projectId)
    },

    quotaOf,
  }
}
export type DatabaseService = ReturnType<typeof createDatabaseService>
