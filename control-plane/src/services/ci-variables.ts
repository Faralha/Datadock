// Credential otomatis jadi CI/CD variable GitLab (FR-13..15, OT-3): masked, environment scope = environment DB,
// diperbarui saat rotasi dan dihapus saat DB dihapus. Gagal sinkron tidak menggagalkan operasi DB; dicoba ulang oleh job.
import type { Db } from '../db.ts'
import type { Gitlab } from '../gitlab.ts'
import type { Audit } from '../audit.ts'
import type { Cipher } from '../crypto.ts'
import type { Config } from '../config.ts'
import { engineConfig } from '../config.ts'
import type { Engines, EngineName } from '../engines/index.ts'
import { engineDriver } from '../engines/index.ts'

type Row = { id: string; project_id: number; engine: EngineName; environment: string; name: string; physical_name: string; status: string }

// Pola tetap per database: <NAMA>_DATABASE_URL, <NAMA>_DB_HOST, ..., mis. APP_DATABASE_URL
export function variableKeys(name: string) {
  const p = name.toUpperCase()
  return {
    url: `${p}_DATABASE_URL`, host: `${p}_DB_HOST`, port: `${p}_DB_PORT`,
    database: `${p}_DB_NAME`, user: `${p}_DB_USER`, password: `${p}_DB_PASSWORD`,
  }
}

export function createCiVariableService(deps: { db: Db; gitlab: Gitlab; audit: Audit; cipher: Cipher; cfg: Config; engines: Engines }) {
  const { db, gitlab, audit, cipher, cfg, engines } = deps

  const record = db.prepare(`INSERT INTO ci_variables (database_id, key, environment_scope, status, last_error, synced_at)
    VALUES ($databaseId, $key, $scope, $status, $error, datetime('now'))
    ON CONFLICT(database_id, key) DO UPDATE SET environment_scope = excluded.environment_scope, status = excluded.status,
      last_error = excluded.last_error, synced_at = excluded.synced_at`)

  function values(row: Row) {
    const c = db.query(`SELECT db_user, password_enc FROM credentials WHERE database_id = ?`).get(row.id) as
      { db_user: string; password_enc: string } | null
    if (!c) throw new Error('credential tidak ditemukan')
    const password = cipher.decrypt(c.password_enc)
    const e = engineConfig(cfg, row.engine)
    const k = variableKeys(row.name)
    return [
      { key: k.url, value: engineDriver(engines, row.engine).connectionString(e.publicHost, e.publicPort, row.physical_name, c.db_user, password), masked: true },
      { key: k.host, value: e.publicHost, masked: false },
      { key: k.port, value: String(e.publicPort), masked: false },
      { key: k.database, value: row.physical_name, masked: false },
      { key: k.user, value: c.db_user, masked: false },
      { key: k.password, value: password, masked: true },
    ]
  }

  async function sync(row: Row) {
    if (!cfg.ciVariablesEnabled) return { failed: 0 }
    let failed = 0
    for (const v of values(row)) {
      try {
        await gitlab.upsertVariable(row.project_id, { ...v, environment_scope: row.environment })
        record.run({ databaseId: row.id, key: v.key, scope: row.environment, status: 'ok', error: null })
      } catch (e: any) {
        failed++
        record.run({ databaseId: row.id, key: v.key, scope: row.environment, status: 'error', error: e.message })
      }
    }
    audit.log({ actor: null, action: 'ci.sync', target: `database:${row.id}`, projectId: row.project_id, result: failed ? 'error' : 'ok',
      detail: { failed } })
    return { failed }
  }

  async function remove(row: Row) {
    if (!cfg.ciVariablesEnabled) return { failed: 0 }
    const vars = db.query(`SELECT key, environment_scope FROM ci_variables WHERE database_id = ? AND status != 'deleted'`).all(row.id) as
      { key: string; environment_scope: string }[]
    let failed = 0
    for (const v of vars) {
      try {
        await gitlab.deleteVariable(row.project_id, v.key, v.environment_scope)
        record.run({ databaseId: row.id, key: v.key, scope: v.environment_scope, status: 'deleted', error: null })
      } catch (e: any) {
        failed++
        record.run({ databaseId: row.id, key: v.key, scope: v.environment_scope, status: 'error', error: e.message })
      }
    }
    audit.log({ actor: null, action: 'ci.remove', target: `database:${row.id}`, projectId: row.project_id, result: failed ? 'error' : 'ok',
      detail: { removed: vars.length - failed, failed } })
    return { failed }
  }

  return {
    sync,
    remove,
    list(databaseId: string) {
      return db.query(`SELECT key, environment_scope, status, last_error, synced_at FROM ci_variables
        WHERE database_id = ? AND status != 'deleted' ORDER BY key`).all(databaseId)
    },
    // Job berkala: ulangi sinkron yang gagal (DB aktif → upsert, DB terhapus → hapus)
    async retryFailed() {
      const rows = db.query(`SELECT DISTINCT d.* FROM ci_variables v JOIN databases d ON d.id = v.database_id WHERE v.status = 'error'`).all() as Row[]
      let failed = 0
      for (const r of rows) {
        // Engine yang dinonaktifkan (env ENGINES) tidak punya konfigurasi untuk membangun nilai variable
        if (r.status !== 'deleted' && !cfg.engines[r.engine]) { failed++; continue }
        failed += (r.status === 'deleted' ? await remove(r) : await sync(r)).failed
      }
      if (failed) throw new Error(`${failed} variable masih gagal disinkronkan`)
      return { databases: rows.length }
    },
  }
}
export type CiVariableService = ReturnType<typeof createCiVariableService>
