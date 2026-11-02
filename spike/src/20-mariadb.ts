// Test 2 — MariaDB 12.2.2. MY_DRIVER=mysql2 (default) | mariadb. Semua langkah sebagai dbaas_admin.
import { check, expectReject, assert, saveResults, env } from './lib.ts'
import { driver, myConnect, type MyConn } from './mydriver.ts'

const ADMIN = env('MARIADB_ADMIN_URL')
const ROOT = env('MARIADB_ROOT_URL')
const P1_PASS = 'p1pass', P2_PASS = 'p2pass', P1_NEW = 'p1pass_baru'
const tenant = (pass = P1_PASS, database?: string) => myConnect(ROOT, { user: 'p1_dev_app_u', password: pass, database })

async function cleanup() {
  const root = await myConnect(ROOT)
  try {
    for (const p of ['p1', 'p2']) {
      await root.query(`DROP DATABASE IF EXISTS ${p}_dev_app`)
      await root.query(`DROP USER IF EXISTS '${p}_dev_app_u'@'%'`)
    }
  } finally {
    await root.end()
  }
}

async function using<T>(c: Promise<MyConn>, fn: (c: MyConn) => Promise<T>) {
  const conn = await c
  try { return await fn(conn) } finally { await conn.end().catch(() => {}) }
}

console.log(`driver: ${driver}`)
await cleanup()
let admin: MyConn | undefined
try {
  await check('MY-1', async () => {
    admin = await myConnect(ADMIN)
    const [r] = await admin.query(`SELECT CURRENT_USER() AS u, VERSION() AS v,
      (SELECT plugin FROM mysql.global_priv WHERE User='dbaas_admin' LIMIT 1) AS p`).catch(async () =>
      admin!.query(`SELECT CURRENT_USER() AS u, VERSION() AS v, NULL AS p`))
    return `driver ${driver}, ${r.u}, ${r.v}${r.p ? `, plugin ${r.p}` : ''}`
  })
  assert(admin, 'MY-1 gagal, test MY lain dilewati')
  const a = admin

  await check('MY-2', async () => { await a.query(`CREATE DATABASE p1_dev_app`) })

  await check('MY-3', async () => {
    await a.query(`CREATE USER 'p1_dev_app_u'@'%' IDENTIFIED BY '${P1_PASS}' WITH MAX_USER_CONNECTIONS 20`)
  })

  await check('MY-4', async () => {
    await a.query(`GRANT ALL PRIVILEGES ON p1_dev_app.* TO 'p1_dev_app_u'@'%'`)
  })

  await check('MY-5', async () => {
    await a.query(`CREATE DATABASE p2_dev_app`)
    await a.query(`CREATE USER 'p2_dev_app_u'@'%' IDENTIFIED BY '${P2_PASS}' WITH MAX_USER_CONNECTIONS 20`)
    await a.query(`GRANT ALL PRIVILEGES ON p2_dev_app.* TO 'p2_dev_app_u'@'%'`)
    await a.query(`CREATE TABLE p2_dev_app.secret(id int)`)
  })

  await check('MY-6', async () => {
    const r1 = await expectReject(() => tenant(P1_PASS, 'p2_dev_app'), /Access denied/)
    const r2 = await using(tenant(), c => expectReject(() => c.query(`SELECT * FROM p2_dev_app.secret`), /denied/))
    const dbs = await using(tenant(), c => c.query(`SHOW DATABASES`))
    return `konek ke p2 ${r1}; SELECT lintas ${r2}; SHOW DATABASES: ${dbs.map(d => Object.values(d)[0]).join(',')}`
  })

  await check('MY-7', async () => using(tenant(P1_PASS, 'p1_dev_app'), async c => {
    await c.query(`CREATE TABLE t(id int primary key, s varchar(50))`)
    await c.query(`INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c')`)
    const rows = await c.query(`SELECT count(*) AS n FROM t`)
    assert(Number(rows[0].n) === 3, `count=${rows[0].n}`)
    return '3 baris'
  }))

  await check('MY-8', async () => {
    await a.query(`ALTER USER 'p1_dev_app_u'@'%' WITH MAX_STATEMENT_TIME 30`)
    return using(tenant(P1_PASS, 'p1_dev_app'), async c => {
      const [v] = await c.query(`SELECT @@max_statement_time AS m`)
      const t0 = Date.now()
      let outcome: string
      try {
        const r = await c.query(`SELECT SLEEP(35) AS s`)
        outcome = `SLEEP selesai dengan s=${r[0].s}`
      } catch (e: any) {
        outcome = `error: ${e.message}`
      }
      const dt = (Date.now() - t0) / 1000
      assert(dt < 33, `query tidak dihentikan (${dt}s)`)
      // SET SESSION max_statement_time oleh tenant: apakah batas per-user bisa ditimpa?
      await c.query(`SET SESSION max_statement_time = 0`)
      const [v2] = await c.query(`SELECT @@max_statement_time AS m`)
      return `@@max_statement_time=${v.m}; ${outcome} setelah ${dt.toFixed(1)}s; tenant SET SESSION → ${v2.m}`
    })
  })

  await check('MY-9', async () => {
    const conns: MyConn[] = []
    try {
      for (let i = 0; i < 20; i++) conns.push(await tenant())
      return await expectReject(() => tenant().then(c => { conns.push(c) }), /max_user_connections/)
    } finally {
      await Promise.all(conns.map(c => c.end().catch(() => {})))
    }
  })

  await check('MY-10', async () => {
    const [r] = await a.query(`SELECT SUM(data_length+index_length) AS size FROM information_schema.tables WHERE table_schema='p1_dev_app'`)
    assert(r.size !== null && Number(r.size) > 0, `size=${r.size}`)
    return `${r.size} bytes`
  })

  await check('MY-11', async () => {
    // koneksi yang sudah terbuka sebelum REVOKE, untuk melihat kapan perubahan berlaku
    const before = await tenant(P1_PASS, 'p1_dev_app')
    try {
      await a.query(`REVOKE INSERT, UPDATE, DELETE, CREATE ON p1_dev_app.* FROM 'p1_dev_app_u'@'%'`)
      const fresh = await using(tenant(P1_PASS, 'p1_dev_app'), c =>
        expectReject(() => c.query(`INSERT INTO t VALUES (10,'x')`), /denied/))
      let existing: string
      try {
        await before.query(`INSERT INTO t VALUES (11,'y')`)
        existing = 'koneksi lama MASIH bisa INSERT'
      } catch (e: any) {
        existing = `koneksi lama juga ditolak`
      }
      return `koneksi baru ${fresh}; ${existing}`
    } finally {
      await before.end().catch(() => {})
    }
  })

  await check('MY-12', async () => {
    await a.query(`ALTER USER 'p1_dev_app_u'@'%' IDENTIFIED BY '${P1_NEW}'`)
    await expectReject(() => tenant(P1_PASS), /Access denied/)
    await using(tenant(P1_NEW), c => c.query(`SELECT 1`))
    return 'password lama ditolak, password baru berhasil'
  })

  await check('MY-13', async () => {
    await a.query(`DROP DATABASE p1_dev_app`)
    await a.query(`DROP USER 'p1_dev_app_u'@'%'`)
  })
} finally {
  await admin?.end().catch(() => {})
  await cleanup()
}
saveResults(`20-mariadb-${driver}${process.env.MARIADB_ADMIN_MODE ? '-' + process.env.MARIADB_ADMIN_MODE : ''}`)
