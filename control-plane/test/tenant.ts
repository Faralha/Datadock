// Operasi sebagai tenant (bukan admin) untuk memverifikasi isolasi dan mode tulis
import postgres from 'postgres'
import mysql from 'mysql2/promise'
import { MongoClient } from 'mongodb'
import type { EngineName } from '../src/engines/index.ts'

const adminUrl = (engine: EngineName) =>
  ({ postgres: process.env.PG_ADMIN_URL!, mariadb: process.env.MARIADB_ADMIN_URL!, mongo: process.env.MONGO_ADMIN_URL! })[engine]

// Coba buat tabel/koleksi lalu insert satu baris; kembalikan 'ok' atau pesan error
export async function tenantWrite(engine: EngineName, database: string, user: string, password: string): Promise<string> {
  const u = new URL(adminUrl(engine))
  try {
    if (engine === 'postgres') {
      u.username = user; u.password = password; u.pathname = '/' + database
      const s = postgres(u.toString(), { max: 1, connect_timeout: 5, onnotice: () => {} })
      try {
        await s`CREATE TABLE IF NOT EXISTS t (id int)`
        await s`INSERT INTO t VALUES (1)`
      } finally { await s.end() }
    } else if (engine === 'mariadb') {
      const c = await mysql.createConnection({ host: u.hostname, port: Number(u.port || 3306), user, password, database, connectTimeout: 5000 })
      c.on('error', () => {})
      try {
        await c.query('CREATE TABLE IF NOT EXISTS t (id int)')
        await c.query('INSERT INTO t VALUES (1)')
      } finally { await c.end().catch(() => {}) }
    } else {
      u.username = user; u.password = password; u.searchParams.set('authSource', database)
      const c = new MongoClient(u.toString(), { serverSelectionTimeoutMS: 5000 })
      try { await c.db(database).collection('t').insertOne({ id: 1 }) } finally { await c.close() }
    }
    return 'ok'
  } catch (e: any) {
    return String(e?.message ?? e).split('\n')[0]
  }
}

// Isi data supaya ukuran database naik (untuk uji quota)
export async function tenantFill(engine: EngineName, database: string, user: string, password: string, rows = 20000) {
  const u = new URL(adminUrl(engine))
  if (engine === 'postgres') {
    u.username = user; u.password = password; u.pathname = '/' + database
    const s = postgres(u.toString(), { max: 1, onnotice: () => {} })
    try {
      await s`CREATE TABLE IF NOT EXISTS fill (id int, s text)`
      await s`INSERT INTO fill SELECT g, repeat(md5(g::text), 8) FROM generate_series(1, ${rows}) g`
    } finally { await s.end() }
  } else if (engine === 'mariadb') {
    const c = await mysql.createConnection({ host: u.hostname, port: Number(u.port || 3306), user, password, database })
    try {
      await c.query('CREATE TABLE IF NOT EXISTS fill (id int, s text)')
      await c.query(`SET SESSION max_recursive_iterations = ${rows + 1}`)
      await c.query(`INSERT INTO fill WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM g WHERE n < ${rows}) SELECT n, repeat(md5(n), 8) FROM g`)
      await c.query('ANALYZE TABLE fill')
    } finally { await c.end() }
  } else {
    u.username = user; u.password = password; u.searchParams.set('authSource', database)
    const c = new MongoClient(u.toString())
    try {
      await c.db(database).collection('fill').insertMany(Array.from({ length: rows }, (_, i) => ({ i, s: 'x'.repeat(256) })))
    } finally { await c.close() }
  }
}
