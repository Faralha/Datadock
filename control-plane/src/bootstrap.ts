// Dengan akun root instance yang sudah ada: buat/selaraskan akun admin hak minimum per engine (NFR-04). Idempoten.
// Butuh env: *_ROOT_URL untuk tiap engine di ENGINES (PG_ROOT_URL, MARIADB_ROOT_URL, MONGO_ROOT_URL), dan konfigurasi admin yang sama dengan control plane
// (*_ADMIN_URL, atau *_ADMIN_PASSWORD + *_HOST/*_PORT).
import postgres from 'postgres'
import mysql from 'mysql2/promise'
import { MongoClient } from 'mongodb'

const need = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`env ${k} wajib diisi`)
  return v
}
const creds = (url: string) => {
  const u = new URL(url)
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
}

export async function bootstrapPostgres(rootUrl: string, adminUrl: string) {
  const { user, password } = creds(adminUrl)
  const sql = postgres(rootUrl, { max: 1, onnotice: () => {} })
  try {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`
    const [r] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${user}`
    await sql.unsafe(`${r ? 'ALTER' : 'CREATE'} ROLE "${user}" LOGIN PASSWORD ${q(password)} CREATEDB CREATEROLE NOSUPERUSER`)
    // PG16+: role buatan admin otomatis di-grant ke admin (SET, INHERIT), supaya admin bisa
    // CREATE DATABASE ... OWNER <tenant>, membaca untuk pg_dump, dan memutus sesi tenant
    await sql.unsafe(`ALTER ROLE "${user}" SET createrole_self_grant = 'set, inherit'`)
    // Tenant tidak boleh konek ke DB `postgres` (spike PG-8b); admin tetap boleh
    await sql.unsafe(`REVOKE CONNECT ON DATABASE postgres FROM PUBLIC`)
    await sql.unsafe(`GRANT CONNECT ON DATABASE postgres TO "${user}"`)
  } finally {
    await sql.end()
  }
}

// Daftar minimum yang terbukti cukup untuk GRANT ALL ON db.* (spike), plus CONNECTION ADMIN untuk
// memutus sesi tenant setelah REVOKE. Catatan: CREATE USER global tetap mengizinkan ALTER/DROP
// akun lain mana pun (spike ESC-MY-1/3), jadi kredensial ini setara root dan harus dijaga.
const MARIADB_ADMIN_PRIVS = `SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER, CREATE TEMPORARY TABLES,
  LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, EVENT, TRIGGER, REFERENCES,
  DELETE HISTORY, SHOW CREATE ROUTINE, CREATE USER, RELOAD, PROCESS, CONNECTION ADMIN`

export async function bootstrapMariadb(rootUrl: string, adminUrl: string) {
  const { user, password } = creds(adminUrl)
  const c = await mysql.createConnection({ uri: rootUrl })
  try {
    await c.query(`CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?`, [user, password])
    await c.query(`ALTER USER ?@'%' IDENTIFIED BY ?`, [user, password])
    await c.query(`GRANT ${MARIADB_ADMIN_PRIVS} ON *.* TO ?@'%' WITH GRANT OPTION`, [user])
  } finally {
    await c.end()
  }
}

// userAdminAnyDatabase setara root (spike ESC-MG-1/2): kredensial ini harus dijaga seperti root
export async function bootstrapMongo(rootUrl: string, adminUrl: string) {
  const { user, password } = creds(adminUrl)
  const c = new MongoClient(rootUrl)
  try {
    const admin = c.db('admin')
    const roles = ['userAdminAnyDatabase', 'dbAdminAnyDatabase', 'readWriteAnyDatabase', 'clusterMonitor']
    const { users } = await admin.command({ usersInfo: user })
    if (users.length) await admin.command({ updateUser: user, pwd: password, roles })
    else await admin.command({ createUser: user, pwd: password, roles })
  } finally {
    await c.close()
  }
}

if (import.meta.main) {
  const { loadConfig } = await import('./config.ts')
  const { engines } = loadConfig()
  // Hanya engine yang diaktifkan (env ENGINES); root URL engine lain tidak dibutuhkan
  if (engines.postgres) {
    await bootstrapPostgres(need('PG_ROOT_URL'), engines.postgres.adminUrl)
    console.log('postgres: admin siap')
  }
  if (engines.mariadb) {
    await bootstrapMariadb(need('MARIADB_ROOT_URL'), engines.mariadb.adminUrl)
    console.log('mariadb: admin siap')
  }
  if (engines.mongo) {
    await bootstrapMongo(need('MONGO_ROOT_URL'), engines.mongo.adminUrl)
    console.log('mongo: admin siap')
  }
  process.exit(0) // driver bisa menahan event loop di Bun (spike Masalah #2)
}
