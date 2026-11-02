import postgres from 'postgres'
import { ident, type EngineDriver, type TenantSpec, type WriteMode } from './types.ts'

// Akun admin: CREATEDB CREATEROLE + createrole_self_grant='set, inherit' (lihat bootstrap.ts), bukan superuser
export function createPostgresDriver(adminUrl: string): EngineDriver {
  const sql = postgres(adminUrl, { max: 5, connect_timeout: 5, idle_timeout: 30, onnotice: () => {} })
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

  async function inDatabase<T>(database: string, fn: (s: postgres.Sql) => Promise<T>) {
    const u = new URL(adminUrl)
    u.pathname = '/' + database
    const s = postgres(u.toString(), { max: 1, connect_timeout: 5, onnotice: () => {} })
    try { return await fn(s) } finally { await s.end() }
  }

  async function terminateSessions(user: string) {
    // Admin anggota role tenant, jadi boleh memutus sesinya tanpa superuser
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${user} AND pid <> pg_backend_pid()`
  }

  return {
    engine: 'postgres',

    async ping() { await sql`SELECT 1` },

    async provision(t: TenantSpec) {
      const db = ident(t.database), user = ident(t.user)
      const [role] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${user}`
      if (role) await sql.unsafe(`ALTER ROLE ${user} LOGIN PASSWORD ${lit(t.password)} CONNECTION LIMIT ${t.maxConnections | 0}`)
      else await sql.unsafe(`CREATE ROLE ${user} LOGIN PASSWORD ${lit(t.password)} CONNECTION LIMIT ${t.maxConnections | 0}`)

      const [exists] = await sql`SELECT 1 FROM pg_database WHERE datname = ${db}`
      if (!exists) await sql.unsafe(`CREATE DATABASE ${db} OWNER ${user}`)
      await sql.unsafe(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`)
      await sql.unsafe(`GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${user}`)
      // Hanya default: tenant bisa SET statement_timeout sendiri (spike PG-10b)
      await sql.unsafe(`ALTER DATABASE ${db} SET statement_timeout = '${t.timeoutS | 0}s'`)
      await inDatabase(db, async s => {
        await s.unsafe(`REVOKE ALL ON SCHEMA public FROM PUBLIC`)
        await s.unsafe(`GRANT ALL ON SCHEMA public TO ${user}`)
      })
    },

    async deprovision(database, user) {
      const db = ident(database), u = ident(user)
      await sql.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
      // Objek milik role di DB lain (mis. hasil restore) akan menggagalkan DROP ROLE; biarkan error naik
      await sql.unsafe(`DROP ROLE IF EXISTS ${u}`)
    },

    async rotatePassword(user, password) {
      await sql.unsafe(`ALTER ROLE ${ident(user)} PASSWORD ${lit(password)}`)
    },

    async sizeBytes(database) {
      const [r] = await sql`SELECT pg_database_size(${ident(database)})::bigint AS size`
      return Number(r.size)
    },

    async setWriteMode(database, user, mode: WriteMode) {
      const db = ident(database), u = ident(user)
      // read_only lewat default_transaction_read_only bisa di-bypass tenant (spike PG-12b), jadi ini hanya
      // pengingat lunak; penegakan keras = blocked (CONNECTION LIMIT 0 + putus sesi, spike PG-12c)
      if (mode === 'none') {
        await sql.unsafe(`ALTER DATABASE ${db} RESET default_transaction_read_only`)
        await sql.unsafe(`ALTER ROLE ${u} RESET default_transaction_read_only`)
      } else {
        await sql.unsafe(`ALTER DATABASE ${db} SET default_transaction_read_only = on`)
        await sql.unsafe(`ALTER ROLE ${u} SET default_transaction_read_only = on`)
      }
      const [r] = await sql`SELECT rolconnlimit FROM pg_roles WHERE rolname = ${u}`
      if (mode === 'blocked' && r.rolconnlimit !== 0) {
        // Simpan limit asli di comment role supaya bisa dikembalikan
        await sql.unsafe(`COMMENT ON ROLE ${u} IS ${lit(`datadock:connlimit=${r.rolconnlimit}`)}`)
        await sql.unsafe(`ALTER ROLE ${u} CONNECTION LIMIT 0`)
      } else if (mode !== 'blocked' && r.rolconnlimit === 0) {
        const [c] = await sql`SELECT shobj_description(oid, 'pg_authid') AS c FROM pg_roles WHERE rolname = ${u}`
        const limit = Number(/datadock:connlimit=(-?\d+)/.exec(c?.c ?? '')?.[1] ?? 20)
        await sql.unsafe(`ALTER ROLE ${u} CONNECTION LIMIT ${limit | 0}`)
      }
      // Sesi lama masih memakai setelan lama; putus supaya mode baru langsung berlaku
      if (mode !== 'none') await terminateSessions(u)
    },

    async tenantCanConnect(database, user, password) {
      const u = new URL(adminUrl)
      u.username = user; u.password = password; u.pathname = '/' + database
      const s = postgres(u.toString(), { max: 1, connect_timeout: 5, onnotice: () => {} })
      try { await s`SELECT 1`; return true } catch { return false } finally { await s.end() }
    },

    connectionString(host, port, database, user, password) {
      return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`
    },

    async close() { await sql.end() },
  }
}
