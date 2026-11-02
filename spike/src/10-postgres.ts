// Test 1 — PostgreSQL 18.3 dengan driver `postgres`, semua langkah memakai dbaas_admin (bukan superuser)
import postgres from 'postgres'
import { check, expectReject, assert, saveResults, env, withCreds } from './lib.ts'

const ADMIN = env('PG_ADMIN_URL')
const ROOT = env('PG_ROOT_URL')
const P1_PASS = 'p1pass', P2_PASS = 'p2pass', P1_NEW = 'p1pass_baru'
const opts = { max: 1, onnotice: () => {}, connect_timeout: 5 }
const tenant = (db: string, user: string, pass: string) => postgres(withCreds(ROOT, user, pass, db), opts)

// Bersihkan sisa run sebelumnya pakai root
async function cleanup() {
  const root = postgres(ROOT, opts)
  try {
    for (const p of ['p1', 'p2']) {
      await root.unsafe(`DROP DATABASE IF EXISTS ${p}_dev_app WITH (FORCE)`)
      await root.unsafe(`DROP ROLE IF EXISTS ${p}_dev_app_u`)
    }
  } finally {
    await root.end()
  }
}

await cleanup()
const admin = postgres(ADMIN, opts)
try {
  await check('PG-1', async () => {
    const [r] = await admin`SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`
    assert(r.current_user === 'dbaas_admin', `current_user=${r.current_user}`)
    assert(r.su === false, 'dbaas_admin adalah superuser')
    return 'current_user=dbaas_admin, rolsuper=false'
  })

  await check('PG-2', async () => {
    await admin.unsafe(`CREATE ROLE p1_dev_app_u LOGIN PASSWORD '${P1_PASS}' CONNECTION LIMIT 20`)
  })

  await check('PG-3', async () => {
    await admin.unsafe(`CREATE DATABASE p1_dev_app OWNER p1_dev_app_u`)
  })

  await check('PG-4', async () => {
    await admin.unsafe(`REVOKE CONNECT, TEMPORARY ON DATABASE p1_dev_app FROM PUBLIC`)
    await admin.unsafe(`GRANT CONNECT ON DATABASE p1_dev_app TO p1_dev_app_u`)
  })

  await check('PG-5', async () => {
    const inDb = postgres(withCreds(ADMIN, 'dbaas_admin', 'adminpass', 'p1_dev_app'), opts)
    try {
      await inDb.unsafe(`REVOKE ALL ON SCHEMA public FROM PUBLIC`)
      await inDb.unsafe(`GRANT ALL ON SCHEMA public TO p1_dev_app_u`)
    } finally {
      await inDb.end()
    }
  })

  await check('PG-6', async () => {
    await admin.unsafe(`ALTER DATABASE p1_dev_app SET statement_timeout = '30s'`)
    const t = tenant('p1_dev_app', 'p1_dev_app_u', P1_PASS)
    try {
      const [r] = await t`SHOW statement_timeout`
      assert(r.statement_timeout === '30s', `statement_timeout=${r.statement_timeout}`)
      return 'tenant melihat statement_timeout=30s'
    } finally {
      await t.end()
    }
  })

  await check('PG-7', async () => {
    await admin.unsafe(`CREATE ROLE p2_dev_app_u LOGIN PASSWORD '${P2_PASS}' CONNECTION LIMIT 20`)
    await admin.unsafe(`CREATE DATABASE p2_dev_app OWNER p2_dev_app_u`)
    await admin.unsafe(`REVOKE CONNECT, TEMPORARY ON DATABASE p2_dev_app FROM PUBLIC`)
    await admin.unsafe(`GRANT CONNECT ON DATABASE p2_dev_app TO p2_dev_app_u`)
  })

  await check('PG-8', async () => {
    const t = tenant('p2_dev_app', 'p1_dev_app_u', P1_PASS)
    try {
      return await expectReject(() => t`SELECT 1`, /permission denied for database/)
    } finally {
      await t.end()
    }
  })

  // Tambahan: tenant p1 tidak boleh bisa konek ke DB default `postgres` dan melihat/membuat objek di sana
  await check('PG-8b', async () => {
    const t = tenant('postgres', 'p1_dev_app_u', P1_PASS)
    try {
      await t`SELECT 1`
      const r = await expectReject(() => t.unsafe(`CREATE TABLE public.leak(id int)`), /permission denied/)
      const dbs = await t`SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1`
      return `tenant BISA konek ke DB postgres (CONNECT default PUBLIC); create table ${r}; pg_database terlihat: ${dbs.map(d => d.datname).join(',')}`
    } finally {
      await t.end()
    }
  })

  await check('PG-9', async () => {
    const t = tenant('p1_dev_app', 'p1_dev_app_u', P1_PASS)
    try {
      await t`CREATE TABLE t(id int)`
      await t`INSERT INTO t SELECT generate_series(1, 100)`
      const [r] = await t`SELECT count(*)::int AS n FROM t`
      assert(r.n === 100, `count=${r.n}`)
      return '100 baris'
    } finally {
      await t.end()
    }
  })

  await check('PG-10', async () => {
    const t = tenant('p1_dev_app', 'p1_dev_app_u', P1_PASS)
    const t0 = Date.now()
    try {
      const msg = await expectReject(() => t`SELECT pg_sleep(35)`, /statement timeout/)
      return `${msg} setelah ${((Date.now() - t0) / 1000).toFixed(1)}s`
    } finally {
      await t.end()
    }
  })

  // Tambahan: statement_timeout per-database bisa ditimpa tenant sendiri
  await check('PG-10b', async () => {
    const t = tenant('p1_dev_app', 'p1_dev_app_u', P1_PASS)
    try {
      await t`SET statement_timeout = 0`
      const [r] = await t`SHOW statement_timeout`
      return `tenant bisa SET statement_timeout=${r.statement_timeout} (batas hanya default, bukan paksaan)`
    } finally {
      await t.end()
    }
  })

  await check('PG-11', async () => {
    const [r] = await admin`SELECT pg_database_size('p1_dev_app')::bigint AS size`
    assert(Number(r.size) > 0, 'size 0')
    return `${r.size} bytes`
  })

  await check('PG-12', async () => {
    await admin.unsafe(`ALTER DATABASE p1_dev_app SET default_transaction_read_only = on`)
    const t = tenant('p1_dev_app', 'p1_dev_app_u', P1_PASS)
    try {
      return await expectReject(() => t`INSERT INTO t VALUES (1)`, /read-only transaction/)
    } finally {
      await t.end()
    }
  })

  // Tambahan: tenant bisa mematikan read-only sendiri → bukan penegakan quota yang aman
  await check('PG-12b', async () => {
    const t = tenant('p1_dev_app', 'p1_dev_app_u', P1_PASS)
    try {
      await t`SET default_transaction_read_only = off`
      await t`INSERT INTO t VALUES (999)`
      return 'BYPASS: tenant SET default_transaction_read_only=off lalu INSERT berhasil'
    } catch (e: any) {
      return `tidak bisa di-bypass: ${e.message}`
    } finally {
      await t.end()
      await admin.unsafe(`ALTER DATABASE p1_dev_app RESET default_transaction_read_only`)
    }
  })

  // Alternatif quota yang tidak bisa di-bypass: cabut CREATE di schema + revoke INSERT/UPDATE dari owner tidak mungkin
  // (owner selalu punya hak penuh atas tabelnya). Yang efektif: ALTER ROLE ... CONNECTION LIMIT 0 + terminate sesi.
  await check('PG-12c', async () => {
    await admin.unsafe(`ALTER ROLE p1_dev_app_u CONNECTION LIMIT 0`)
    const t = tenant('p1_dev_app', 'p1_dev_app_u', P1_PASS)
    try {
      return await expectReject(() => t`SELECT 1`, /too many connections/)
    } finally {
      await t.end()
      await admin.unsafe(`ALTER ROLE p1_dev_app_u CONNECTION LIMIT 20`)
    }
  })

  await check('PG-13', async () => {
    await admin.unsafe(`ALTER ROLE p1_dev_app_u PASSWORD '${P1_NEW}'`)
    const old = tenant('p1_dev_app', 'p1_dev_app_u', P1_PASS)
    const t = tenant('p1_dev_app', 'p1_dev_app_u', P1_NEW)
    try {
      await expectReject(() => old`SELECT 1`, /password authentication failed/)
      const [r] = await t`SELECT current_user`
      assert(r.current_user === 'p1_dev_app_u', 'user salah')
      return 'password lama ditolak, password baru berhasil'
    } finally {
      await old.end()
      await t.end()
    }
  })

  await check('PG-14', async () => {
    // Sesi tenant yang masih terbuka harus diputus oleh WITH (FORCE)
    const t = tenant('p1_dev_app', 'p1_dev_app_u', P1_NEW)
    await t`SELECT 1`
    await admin.unsafe(`DROP DATABASE p1_dev_app WITH (FORCE)`)
    await admin.unsafe(`DROP ROLE p1_dev_app_u`)
    await t.end().catch(() => {})
    const [r] = await admin`SELECT count(*)::int AS n FROM pg_database WHERE datname = 'p1_dev_app'`
    assert(r.n === 0, 'database masih ada')
    return 'drop dengan sesi tenant aktif berhasil'
  })
} finally {
  await admin.end()
  await cleanup()
}
saveResults('10-postgres')
