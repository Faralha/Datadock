// Hapus semua database tenant milik instance ini dari engine. HANYA untuk instance dev yang akan dibuang
// (dipanggil cleanup.sh); tanpa backup akhir. Ditolak bila TENANT_PREFIX kosong, supaya tidak pernah
// menyentuh database production yang tidak berprefiks.
import { loadConfig } from './config.ts'
import { buildContext } from './index.ts'
import { engineDriver } from './engines/index.ts'

const cfg = loadConfig()
if (!cfg.tenantPrefix) {
  console.error('purge ditolak: TENANT_PREFIX kosong (instance ini bukan instance dev)')
  process.exit(1)
}

const ctx = buildContext(cfg)
const rows = ctx.db.query(`SELECT d.id, d.project_id, d.engine, d.physical_name, c.db_user FROM databases d
  JOIN credentials c ON c.database_id = d.id WHERE d.status NOT IN ('deleted', 'failed')`).all() as
  { id: string; project_id: number; engine: 'postgres' | 'mariadb' | 'mongo'; physical_name: string; db_user: string }[]

let failed = 0
for (const r of rows) {
  if (!r.physical_name.startsWith(cfg.tenantPrefix)) continue
  try {
    await engineDriver(ctx.engines, r.engine).deprovision(r.physical_name, r.db_user)
    ctx.db.query(`UPDATE databases SET status = 'deleted', deleted_at = datetime('now') WHERE id = ?`).run(r.id)
    ctx.audit.log({ actor: null, action: 'instance.purge', target: `database:${r.id}`, projectId: r.project_id, result: 'ok' })
    console.log(`dihapus: ${r.engine} ${r.physical_name}`)
  } catch (e: any) {
    failed++
    console.error(`gagal: ${r.engine} ${r.physical_name}: ${e.message}`)
  }
}
console.log(`${rows.length - failed} database dihapus, ${failed} gagal`)
await ctx.close()
process.exit(failed ? 1 : 0)
