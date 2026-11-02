// CI/CD variable GitLab (FR-13..15) dan query console + skema (FR-16..19, FR-29)
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestContext, randomProjectId } from './helpers.ts'
import { tenantWrite } from './tenant.ts'
import { isDestructiveSql, isDestructiveMongo } from '../src/services/console.ts'

let t: Awaited<ReturnType<typeof createTestContext>>
const P = randomProjectId(), OTHER = P + 1
const DEV = 21, MAINT = 22, OUTSIDER = 23, ADMIN = 24
const cookies: Record<number, string> = {}
const dbs: Record<string, any> = {}

beforeAll(async () => {
  // Timeout console pendek supaya uji timeout tidak menunggu 30 detik
  t = await createTestContext({ QUERY_TIMEOUT_S: '2' })
  const g = t.gitlab
  g.addUser(DEV, 'dev2'); g.addUser(MAINT, 'maint2'); g.addUser(OUTSIDER, 'luar2'); g.addUser(ADMIN, 'root-admin')
  g.addProject(P, 'lab/tim-c'); g.addProject(OTHER, 'lab/tim-d')
  g.setMember(P, DEV, 30); g.setMember(P, MAINT, 40); g.setMember(OTHER, OUTSIDER, 40)
  for (const u of [DEV, MAINT, OUTSIDER, ADMIN]) cookies[u] = await t.login(u)
  t.ctx.databases.setQuota(null, P, { maxDatabases: 10, maxSizeMb: 1024, maxConnections: 20 }, null)
})

afterAll(async () => {
  for (const d of Object.values(dbs)) {
    const row = t.ctx.databases.get(d.id)
    const c = t.ctx.db.query(`SELECT db_user FROM credentials WHERE database_id = ?`).get(d.id) as any
    if (row && row.status !== 'deleted' && c) await t.ctx.engines[row.engine]!.deprovision(row.physical_name, c.db_user).catch(() => {})
  }
  await t.close()
})

const create = async (engine: string, environment: string, name: string) => {
  const r = await t.call('POST', `/api/projects/${P}/databases`, { cookie: cookies[DEV], body: { engine, environment, name } })
  if (r.status !== 201) throw new Error(`${r.status} ${JSON.stringify(r.data)}`)
  dbs[`${engine}:${environment}:${name}`] = r.data
  return r.data
}
const run = (id: string, body: unknown, who = DEV) => t.call('POST', `/api/databases/${id}/console`, { cookie: cookies[who], body })
const varsOf = (scope: string) => Object.fromEntries(t.gitlab.variables(P).filter(v => v.environment_scope === scope).map(v => [v.key, v]))

describe('CI/CD variable (FR-13..15)', () => {
  test('membuat database membuat 6 variable dengan scope environment; URL dan password masked', async () => {
    const pg = await create('postgres', 'staging', 'app')
    const v = varsOf('staging')
    expect(Object.keys(v).sort()).toEqual(['APP_DATABASE_URL', 'APP_DB_HOST', 'APP_DB_NAME', 'APP_DB_PASSWORD', 'APP_DB_PORT', 'APP_DB_USER'])
    expect(v.APP_DATABASE_URL.masked).toBe(true)
    expect(v.APP_DB_PASSWORD.masked).toBe(true)
    expect(v.APP_DB_USER.masked).toBe(false)
    expect(v.APP_DB_NAME.value).toBe(pg.connection.database)
    expect(await tenantWrite('postgres', v.APP_DB_NAME.value, v.APP_DB_USER.value, v.APP_DB_PASSWORD.value)).toBe('ok')
    const list = await t.call('GET', `/api/databases/${pg.id}/ci-variables`, { cookie: cookies[DEV] })
    expect(list.data.every((x: any) => x.status === 'ok')).toBe(true)
  })

  test('URL MongoDB bisa di-mask (tanpa ?authSource) dan tetap bisa dipakai login', async () => {
    const mg = await create('mongo', 'staging', 'docs')
    const v = varsOf('staging')
    expect(v.DOCS_DATABASE_URL.value).not.toContain('?')
    const list = await t.call('GET', `/api/databases/${mg.id}/ci-variables`, { cookie: cookies[DEV] })
    expect(list.data.map((x: any) => x.status)).toEqual(Array(6).fill('ok'))
    expect(await tenantWrite('mongo', v.DOCS_DB_NAME.value, v.DOCS_DB_USER.value, v.DOCS_DB_PASSWORD.value)).toBe('ok')
  })

  test('nama yang sama di environment yang sama ditolak lintas engine; environment lain boleh', async () => {
    const r = await t.call('POST', `/api/projects/${P}/databases`, { cookie: cookies[DEV], body: { engine: 'mariadb', environment: 'staging', name: 'app' } })
    expect(r.status).toBe(409)
    const prod = await create('postgres', 'production', 'app')
    expect(varsOf('production').APP_DB_NAME.value).toBe(prod.connection.database)
    expect(varsOf('staging').APP_DB_NAME.value).toBe(dbs['postgres:staging:app'].connection.database)
  })

  test('rotasi memperbarui variable password dan URL', async () => {
    const before = varsOf('staging').APP_DB_PASSWORD.value
    expect((await t.call('POST', `/api/databases/${dbs['postgres:staging:app'].id}/password/rotate`, { cookie: cookies[MAINT] })).status).toBe(200)
    const v = varsOf('staging')
    expect(v.APP_DB_PASSWORD.value).not.toBe(before)
    expect(v.APP_DATABASE_URL.value).toContain(v.APP_DB_PASSWORD.value)
    expect(await tenantWrite('postgres', v.APP_DB_NAME.value, v.APP_DB_USER.value, v.APP_DB_PASSWORD.value)).toBe('ok')
  })

  test('GitLab gagal: database tetap dibuat, status variable error, lalu job retry memulihkan', async () => {
    t.gitlab.setVariablesDown(true)
    const my = await create('mariadb', 'staging', 'cache')
    expect(my.status).toBe('ready')
    let list = await t.call('GET', `/api/databases/${my.id}/ci-variables`, { cookie: cookies[DEV] })
    expect(list.data.every((x: any) => x.status === 'error')).toBe(true)
    t.gitlab.setVariablesDown(false)
    expect((await t.call('POST', '/api/admin/jobs/retry-ci-variables/run', { cookie: cookies[ADMIN] })).status).toBe(200)
    list = await t.call('GET', `/api/databases/${my.id}/ci-variables`, { cookie: cookies[DEV] })
    expect(list.data.every((x: any) => x.status === 'ok')).toBe(true)
    expect(varsOf('staging').CACHE_DB_NAME.value).toBe(my.connection.database)
  })

  test('menghapus database menghapus variable-nya', async () => {
    const id = dbs['postgres:staging:app'].id
    // Bandingkan body, bukan status saja, supaya pesan error server terlihat bila gagal
    expect((await t.call('DELETE', `/api/databases/${id}`, { cookie: cookies[MAINT], body: { confirm: 'app' } })).data).toEqual({ ok: true })
    expect(Object.keys(varsOf('staging')).filter(k => k.startsWith('APP_'))).toEqual([])
    expect(varsOf('production').APP_DB_NAME).toBeDefined()
  })
})

describe('deteksi perintah destruktif (FR-18)', () => {
  test('SQL', () => {
    expect(isDestructiveSql('DROP TABLE t')).toBe(true)
    expect(isDestructiveSql('  truncate t')).toBe(true)
    expect(isDestructiveSql('/* aman */ drop table t')).toBe(true)
    expect(isDestructiveSql('-- komentar\nDELETE FROM t')).toBe(true)
    expect(isDestructiveSql('UPDATE t SET a = 1')).toBe(true)
    expect(isDestructiveSql('DELETE FROM t WHERE id = 1')).toBe(false)
    expect(isDestructiveSql('SELECT * FROM drop_log')).toBe(false)
  })
  test('MongoDB', () => {
    expect(isDestructiveMongo({ operation: 'deleteMany', collection: 'c', filter: {} })).toBe(true)
    expect(isDestructiveMongo({ operation: 'updateMany', collection: 'c', update: { $set: { a: 1 } } })).toBe(true)
    expect(isDestructiveMongo({ operation: 'drop', collection: 'c' })).toBe(true)
    expect(isDestructiveMongo({ operation: 'deleteMany', collection: 'c', filter: { a: 1 } })).toBe(false)
  })
})

describe('console SQL (FR-16, FR-29)', () => {
  for (const engine of ['postgres', 'mariadb'] as const) {
    describe(engine, () => {
      let id: string
      beforeAll(async () => { id = (await create(engine, 'dev', engine === 'postgres' ? 'pgc' : 'myc')).id })

      test('memakai user project, bukan admin', async () => {
        const r = await run(id, { query: engine === 'postgres' ? 'SELECT current_user' : 'SELECT CURRENT_USER()' })
        expect(r.status).toBe(200)
        expect(String(r.data.rows[0][0])).toStartWith(dbs[`${engine}:dev:${engine === 'postgres' ? 'pgc' : 'myc'}`].connection.user)
      })

      test('read-write: create, insert, select; hasil dibatasi 1.000 baris', async () => {
        expect((await run(id, { query: 'CREATE TABLE t (id int, s varchar(20))' })).status).toBe(200)
        const ins = await run(id, { query: engine === 'postgres'
          ? `INSERT INTO t SELECT g, 'x' || g FROM generate_series(1, 1500) g`
          : `INSERT INTO t SELECT seq, CONCAT('x', seq) FROM seq_1_to_1500` })
        expect(ins.status).toBe(200)
        expect(ins.data.affected).toBe(1500)
        const sel = await run(id, { query: 'SELECT id, s FROM t ORDER BY id' })
        expect(sel.data.columns).toEqual(['id', 's'])
        expect(sel.data.rows).toHaveLength(1000)
        expect(sel.data.truncated).toBe(true)
        expect(sel.data.rows[0]).toEqual([1, 'x1'])
      })

      test('timeout query ditegakkan per sesi console', async () => {
        const r = await run(id, { query: engine === 'postgres' ? 'SELECT pg_sleep(5)' : 'SELECT SLEEP(5) FROM t LIMIT 1' })
        if (engine === 'postgres') {
          expect(r.status).toBe(400)
          expect(r.data.error).toContain('statement timeout')
        } else {
          // MariaDB: SLEEP yang dihentikan max_statement_time mengembalikan error 1969
          expect(r.status).toBe(400)
          expect(r.data.error).toMatch(/max_statement_time|execution time limit|interrupted/)
        }
        expect(r.data.durationMs).toBeLessThan(4500)
      })

      test('perintah destruktif butuh ketik ulang nama database', async () => {
        const name = engine === 'postgres' ? 'pgc' : 'myc'
        const r = await run(id, { query: 'DELETE FROM t' })
        expect(r.status).toBe(409)
        expect(r.data.needsConfirmation).toBe(true)
        expect((await run(id, { query: 'DELETE FROM t', confirm: 'salah' })).status).toBe(409)
        const ok = await run(id, { query: 'DELETE FROM t', confirm: name })
        expect(ok.status).toBe(200)
        expect(ok.data.affected).toBe(1500)
      })

      test('multi-statement ditolak', async () => {
        expect((await run(id, { query: 'SELECT 1; SELECT 2' })).status).toBe(400)
      })

      test('skema: tabel, kolom, ukuran', async () => {
        const r = await t.call('GET', `/api/databases/${id}/schema`, { cookie: cookies[DEV] })
        expect(r.status).toBe(200)
        const tbl = r.data.find((x: any) => x.name === 't')
        expect(tbl.type).toBe('table')
        expect(tbl.columns.map((c: any) => c.name)).toEqual(['id', 's'])
      })
    })
  }

  test('setiap query tercatat di audit dengan durasi dan jumlah baris', async () => {
    const a = await t.call('GET', `/api/admin/audit?project=${P}&limit=500`, { cookie: cookies[ADMIN] })
    const q = a.data.filter((e: any) => e.action === 'console.query')
    expect(q.length).toBeGreaterThanOrEqual(10)
    const sel = q.find((e: any) => JSON.parse(e.detail).query === 'SELECT id, s FROM t ORDER BY id')
    expect(JSON.parse(sel.detail)).toMatchObject({ rows: 1000 })
    expect(q.some((e: any) => e.result === 'error')).toBe(true)
  })

  test('anggota project lain tidak bisa memakai console', async () => {
    expect((await run(dbs['postgres:dev:pgc'].id, { query: 'SELECT 1' }, OUTSIDER)).status).toBe(404)
  })
})

describe('console MongoDB (FR-17)', () => {
  let id: string
  beforeAll(async () => { id = (await create('mongo', 'dev', 'mgc')).id })

  test('insert, find dengan filter, count; ObjectId lewat EJSON', async () => {
    const ins = await run(id, { mongo: { operation: 'insertMany', collection: 'c', documents: Array.from({ length: 1200 }, (_, i) => ({ i, even: i % 2 === 0 })) } })
    expect(ins.data.affected).toBe(1200)
    const one = await run(id, { mongo: { operation: 'insertOne', collection: 'c', document: { tag: 'khusus' } } })
    const oid = one.data.documents[0].insertedId.$oid
    expect(oid).toMatch(/^[0-9a-f]{24}$/)
    const byId = await run(id, { mongo: { operation: 'find', collection: 'c', filter: { _id: { $oid: oid } } } })
    expect(byId.data.documents).toHaveLength(1)
    expect(byId.data.documents[0].tag).toBe('khusus')
    const all = await run(id, { mongo: { operation: 'find', collection: 'c' } })
    expect(all.data.documents).toHaveLength(1000)
    expect(all.data.truncated).toBe(true)
    const cnt = await run(id, { mongo: { operation: 'count', collection: 'c', filter: { even: true } } })
    expect(cnt.data.documents[0].count).toBe(600)
    const agg = await run(id, { mongo: { operation: 'aggregate', collection: 'c', pipeline: [{ $group: { _id: '$even', n: { $sum: 1 } } }] } })
    expect(agg.data.documents).toHaveLength(3)
  })

  test('maxTimeMS menghentikan query lambat', async () => {
    const r = await run(id, { mongo: { operation: 'find', collection: 'c', filter: { $where: 'sleep(10) || true' } } })
    expect(r.status).toBe(400)
    expect(r.data.error).toMatch(/time limit/)
  })

  test('deleteMany tanpa filter butuh konfirmasi', async () => {
    expect((await run(id, { mongo: { operation: 'deleteMany', collection: 'c', filter: {} } })).status).toBe(409)
    const ok = await run(id, { mongo: { operation: 'deleteMany', collection: 'c', filter: {} }, confirm: 'mgc' })
    expect(ok.data.affected).toBe(1201)
  })

  test('skema koleksi dari dokumen contoh', async () => {
    await run(id, { mongo: { operation: 'insertOne', collection: 'orang', document: { nama: 'A', umur: 3 } } })
    const r = await t.call('GET', `/api/databases/${id}/schema`, { cookie: cookies[DEV] })
    const c = r.data.find((x: any) => x.name === 'orang')
    expect(c.columns.map((x: any) => x.name)).toEqual(['_id', 'nama', 'umur'])
  })
})
