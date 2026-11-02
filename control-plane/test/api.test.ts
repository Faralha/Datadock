// Alur end-to-end lewat HTTP: GitLab palsu + engine asli + backup lewat Docker socket
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestContext, randomProjectId } from './helpers.ts'
import { tenantWrite, tenantFill } from './tenant.ts'
import { ENGINES } from '../src/engines/index.ts'

let t: Awaited<ReturnType<typeof createTestContext>>
const P = randomProjectId(), OTHER = P + 1
const DEV = 11, MAINT = 12, REPORTER = 13, ADMIN = 14, OUTSIDER = 15
const cookies: Record<number, string> = {}
const created: Record<string, any> = {}
// Nama unik per environment lintas engine (dipakai sebagai prefiks CI variable)
const NAME = { postgres: 'pgapp', mariadb: 'myapp', mongo: 'mgapp' } as const

beforeAll(async () => {
  t = await createTestContext()
  const g = t.gitlab
  g.addUser(DEV, 'dev'); g.addUser(MAINT, 'maint'); g.addUser(REPORTER, 'rep'); g.addUser(ADMIN, 'ops'); g.addUser(OUTSIDER, 'luar')
  g.addProject(P, 'lab/tim-a'); g.addProject(OTHER, 'lab/tim-b')
  g.setMember(P, DEV, 30); g.setMember(P, MAINT, 40); g.setMember(P, REPORTER, 20)
  g.setMember(OTHER, OUTSIDER, 50)
  g.addGroupMember('demo/admins', ADMIN)
  for (const u of [DEV, MAINT, REPORTER, ADMIN, OUTSIDER]) cookies[u] = await t.login(u)
})

afterAll(async () => {
  // Bersihkan database yang masih tersisa di engine
  for (const db of Object.values(created)) {
    const row = t.ctx.databases.get(db.id)
    if (row && row.status !== 'deleted') {
      const c = t.ctx.db.query(`SELECT db_user FROM credentials WHERE database_id = ?`).get(db.id) as any
      if (c) await t.ctx.engines[row.engine]!.deprovision(row.physical_name, c.db_user).catch(() => {})
    }
  }
  await t.close()
})

describe('auth dan role', () => {
  test('login GitLab memberi cookie httpOnly; /api/me berisi project dengan role', async () => {
    const me = await t.call('GET', '/api/me', { cookie: cookies[DEV] })
    expect(me.status).toBe(200)
    expect(me.data.projects).toEqual([{ id: P, path: 'lab/tim-a', name: 'tim-a', role: 'developer' }])
    const maint = await t.call('GET', '/api/me', { cookie: cookies[MAINT] })
    expect(maint.data.projects[0].role).toBe('maintainer')
  })

  test('Reporter tidak melihat project; tanpa login → 401', async () => {
    expect((await t.call('GET', '/api/me', { cookie: cookies[REPORTER] })).data.projects).toEqual([])
    expect((await t.call('GET', `/api/projects/${P}`, { cookie: cookies[REPORTER] })).status).toBe(404)
    expect((await t.call('GET', '/api/me')).status).toBe(401)
  })

  test('admin dari grup GitLab (FR-02) melihat semua project', async () => {
    const me = await t.call('GET', '/api/me', { cookie: cookies[ADMIN] })
    expect(me.data.user.isAdmin).toBe(true)
    expect(me.data.projects.map((p: any) => p.id).sort()).toEqual([P, OTHER].sort())
  })

  test('CSRF: POST tanpa origin yang benar ditolak', async () => {
    const body = { engine: 'postgres', environment: 'dev', name: 'csrf' }
    expect((await t.call('POST', `/api/projects/${P}/databases`, { cookie: cookies[DEV], body, origin: null })).status).toBe(403)
    expect((await t.call('POST', `/api/projects/${P}/databases`, { cookie: cookies[DEV], body, origin: 'http://evil.test' })).status).toBe(403)
  })

  test('state OAuth tidak bisa dipakai ulang', async () => {
    const r = await t.call('GET', '/auth/callback?code=x&state=palsu')
    expect(r.status).toBe(400)
  })
})

describe('provisioning (FR-06..08, FR-24)', () => {
  test('Developer membuat database di ketiga engine < 10 detik', async () => {
    for (const engine of ENGINES) {
      const t0 = performance.now()
      const r = await t.call('POST', `/api/projects/${P}/databases`, { cookie: cookies[DEV], body: { engine, environment: 'dev', name: NAME[engine] } })
      expect(r.status).toBe(201)
      expect(performance.now() - t0).toBeLessThan(10_000)
      expect(r.data.status).toBe('ready')
      expect(r.data.connection.database).toBe(`p${P}_dev_${NAME[engine]}`)
      expect(r.data.connection.connectionString).toContain('********')
      created[engine] = r.data
    }
  })

  test('quota jumlah database (default 3) ditolak dengan pesan jelas', async () => {
    const r = await t.call('POST', `/api/projects/${P}/databases`, { cookie: cookies[DEV], body: { engine: 'postgres', environment: 'dev', name: 'lagi' } })
    expect(r.status).toBe(409)
    expect(r.data.error).toContain('quota penuh')
  })

  test('input tidak valid ditolak', async () => {
    const r = await t.call('POST', `/api/projects/${OTHER}/databases`, { cookie: cookies[OUTSIDER], body: { engine: 'postgres', environment: 'Dev', name: 'x' } })
    expect(r.status).toBe(400)
    const r2 = await t.call('POST', `/api/projects/${OTHER}/databases`, { cookie: cookies[OUTSIDER], body: { engine: 'redis', environment: 'dev', name: 'x' } })
    expect(r2.status).toBe(400)
  })

  test('anggota project lain tidak bisa melihat database ini', async () => {
    expect((await t.call('GET', `/api/databases/${created.postgres.id}`, { cookie: cookies[OUTSIDER] })).status).toBe(404)
    expect((await t.call('GET', `/api/projects/${P}`, { cookie: cookies[OUTSIDER] })).status).toBe(404)
  })

  test('ringkasan project memuat quota dan pemakaian', async () => {
    const r = await t.call('GET', `/api/projects/${P}`, { cookie: cookies[DEV] })
    expect(r.data.quota).toEqual({ maxDatabases: 3, maxSizeMb: 1024, maxConnections: 20 })
    expect(r.data.usage.databases).toBe(3)
    expect(r.data.databases).toHaveLength(3)
  })

  test('ringkasan semua project untuk dashboard: hanya project yang terlihat user', async () => {
    const dev = await t.call('GET', '/api/projects', { cookie: cookies[DEV] })
    expect(dev.data.projects).toEqual([{ id: P, path: 'lab/tim-a', name: 'tim-a', role: 'developer', databases: 3, maxDatabases: 3,
      sizeBytes: expect.any(Number), limited: 0, engines: ['postgres', 'mariadb', 'mongo'] }])
    const admin = await t.call('GET', '/api/projects', { cookie: cookies[ADMIN] })
    expect(admin.data.projects.map((p: any) => [p.id, p.databases])).toEqual([[P, 3], [OTHER, 0]])
    expect((await t.call('GET', '/api/projects')).status).toBe(401)
  })
})

describe('credential (FR-11, FR-12)', () => {
  test('reveal password: password asli bisa dipakai, tercatat di audit', async () => {
    for (const engine of ENGINES) {
      const r = await t.call('POST', `/api/databases/${created[engine].id}/password/reveal`, { cookie: cookies[DEV] })
      expect(r.status).toBe(200)
      created[engine].password = r.data.password
      expect(await tenantWrite(engine, created[engine].connection.database, created[engine].connection.user, r.data.password)).toBe('ok')
    }
    const audit = await t.call('GET', `/api/admin/audit?project=${P}`, { cookie: cookies[ADMIN] })
    expect(audit.data.filter((e: any) => e.action === 'credential.reveal')).toHaveLength(3)
  })

  test('Developer tidak boleh rotasi (403, tercatat denied); Maintainer boleh', async () => {
    const id = created.mariadb.id
    const denied = await t.call('POST', `/api/databases/${id}/password/rotate`, { cookie: cookies[DEV] })
    expect(denied.status).toBe(403)
    const audit = await t.call('GET', `/api/admin/audit?project=${P}`, { cookie: cookies[ADMIN] })
    expect(audit.data.some((e: any) => e.action === 'credential.rotate' && e.result === 'denied' && e.actor_username === 'dev')).toBe(true)

    for (const engine of ENGINES) {
      const c = created[engine]
      const r = await t.call('POST', `/api/databases/${c.id}/password/rotate`, { cookie: cookies[MAINT] })
      expect(r.status).toBe(200)
      expect(await tenantWrite(engine, c.connection.database, c.connection.user, c.password)).not.toBe('ok')
      const fresh = await t.call('POST', `/api/databases/${c.id}/password/reveal`, { cookie: cookies[MAINT] })
      expect(fresh.data.password).not.toBe(c.password)
      c.password = fresh.data.password
      expect(await tenantWrite(engine, c.connection.database, c.connection.user, c.password)).toBe('ok')
    }
  })

  test('password tersimpan terenkripsi di metadata (NFR-03)', () => {
    const rows = t.ctx.db.query(`SELECT password_enc FROM credentials`).all() as { password_enc: string }[]
    for (const r of rows) {
      expect(r.password_enc.startsWith('v1.')).toBe(true)
      for (const c of Object.values(created)) expect(r.password_enc).not.toContain(c.password)
    }
  })
})

describe('quota ukuran (FR-24, OT-7)', () => {
  test('melewati batas ukuran → read-only (PG di atas batas keras → blocked), lalu pulih', async () => {
    for (const engine of ENGINES) {
      const c = created[engine]
      await tenantFill(engine, c.connection.database, c.connection.user, c.password)
    }
    // Batas 1 MB: semua engine sudah lewat (PG > 120% → blocked)
    const q = await t.call('PUT', `/api/admin/projects/${P}/quota`, { cookie: cookies[ADMIN], body: { maxDatabases: 3, maxSizeMb: 1, maxConnections: 20 } })
    expect(q.status).toBe(200)
    const run = await t.call('POST', '/api/admin/jobs/enforce-quotas/run', { cookie: cookies[ADMIN] })
    expect(run.status).toBe(200)

    const statuses = Object.fromEntries(ENGINES.map(e => [e, t.ctx.databases.get(created[e].id)!.status]))
    expect(statuses).toEqual({ postgres: 'blocked', mariadb: 'read_only', mongo: 'read_only' })
    for (const engine of ENGINES) {
      const c = created[engine]
      expect(await tenantWrite(engine, c.connection.database, c.connection.user, c.password)).not.toBe('ok')
    }

    // Admin menaikkan quota → job berikutnya mengembalikan akses tulis
    await t.call('PUT', `/api/admin/projects/${P}/quota`, { cookie: cookies[ADMIN], body: { maxDatabases: 3, maxSizeMb: 1024, maxConnections: 20 } })
    await t.call('POST', '/api/admin/jobs/enforce-quotas/run', { cookie: cookies[ADMIN] })
    for (const engine of ENGINES) {
      const c = created[engine]
      expect(t.ctx.databases.get(c.id)!.status).toBe('ready')
      expect(await tenantWrite(engine, c.connection.database, c.connection.user, c.password)).toBe('ok')
    }
  })
})

describe('backup (FR-26) dan hapus (FR-09)', () => {
  test('backup harian lewat docker exec untuk ketiga engine; status terlihat anggota', async () => {
    const r = await t.call('POST', '/api/admin/jobs/backup-daily/run', { cookie: cookies[ADMIN] })
    expect(r.status).toBe(200)
    expect(r.data.result).toEqual({ ok: 3, failed: 0 })
    for (const engine of ENGINES) {
      const b = await t.call('GET', `/api/databases/${created[engine].id}/backups`, { cookie: cookies[DEV] })
      expect(b.data[0].status).toBe('ok')
      expect(b.data[0].size_bytes).toBeGreaterThan(0)
    }
  })

  test('hapus: Developer ditolak, konfirmasi salah ditolak, Maintainer berhasil dengan backup akhir', async () => {
    const id = created.postgres.id
    expect((await t.call('DELETE', `/api/databases/${id}`, { cookie: cookies[DEV], body: { confirm: 'pgapp' } })).status).toBe(403)
    expect((await t.call('DELETE', `/api/databases/${id}`, { cookie: cookies[MAINT], body: { confirm: 'salah' } })).status).toBe(400)

    for (const engine of ENGINES) {
      const c = created[engine]
      const r = await t.call('DELETE', `/api/databases/${c.id}`, { cookie: cookies[MAINT], body: { confirm: NAME[engine] } })
      expect(r.status).toBe(200)
      expect(t.ctx.databases.get(c.id)!.status).toBe('deleted')
      expect(await tenantWrite(engine, c.connection.database, c.connection.user, c.password)).not.toBe('ok')
      const finals = t.ctx.db.query(`SELECT * FROM backups WHERE database_id = ? AND kind = 'final'`).all(c.id) as any[]
      expect(finals).toHaveLength(1)
      expect(finals[0].status).toBe('ok')
    }
    expect((await t.call('GET', `/api/projects/${P}`, { cookie: cookies[DEV] })).data.usage.databases).toBe(0)
  })

  test('retensi: backup kedaluwarsa dihapus dari disk', async () => {
    t.ctx.db.query(`UPDATE backups SET expires_at = datetime('now', '-1 minute') WHERE status = 'ok'`).run()
    const r = await t.call('POST', '/api/admin/jobs/backup-expire/run', { cookie: cookies[ADMIN] })
    expect(r.data.result.removed).toBeGreaterThanOrEqual(6)
    const left = t.ctx.db.query(`SELECT COUNT(*) AS n FROM backups WHERE status = 'ok'`).get() as { n: number }
    expect(left.n).toBe(0)
  })
})

describe('sinkron anggota (FR-04, FR-05)', () => {
  test('anggota yang dicabut atau diturunkan di GitLab kehilangan akses setelah sinkron', async () => {
    t.gitlab.setMember(P, DEV, null)
    t.gitlab.setMember(P, MAINT, 30)
    const r = await t.call('POST', '/api/admin/jobs/sync-memberships/run', { cookie: cookies[ADMIN] })
    expect(r.status).toBe(200)
    expect((await t.call('GET', `/api/projects/${P}`, { cookie: cookies[DEV] })).status).toBe(404)
    expect((await t.call('GET', `/api/projects/${P}`, { cookie: cookies[MAINT] })).data.role).toBe('developer')
  })

  test('logout menghapus sesi', async () => {
    expect((await t.call('POST', '/auth/logout', { cookie: cookies[OUTSIDER] })).status).toBe(200)
    expect((await t.call('GET', '/api/me', { cookie: cookies[OUTSIDER] })).status).toBe(401)
  })
})
