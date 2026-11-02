// Adapter tipis supaya test MariaDB bisa dijalankan dengan mysql2 maupun mariadb (MY_DRIVER=mysql2|mariadb)
import mysql2 from 'mysql2/promise'
import * as mariadb from 'mariadb'

export const driver = (process.env.MY_DRIVER ?? 'mysql2') as 'mysql2' | 'mariadb'

export type MyConn = { query(sql: string, params?: unknown[]): Promise<any[]>; end(): Promise<void> }

export async function myConnect(url: string, opts: { user?: string; password?: string; database?: string } = {}): Promise<MyConn> {
  const u = new URL(url)
  const cfg = {
    host: u.hostname, port: Number(u.port || 3306),
    user: opts.user ?? decodeURIComponent(u.username),
    password: opts.password ?? decodeURIComponent(u.password),
    database: opts.database,
    connectTimeout: 5000,
  }
  if (driver === 'mariadb') {
    const c = await mariadb.createConnection(cfg)
    return {
      query: async (sql, params) => {
        const r = await c.query(sql, params)
        return Array.isArray(r) ? [...r] : [r]
      },
      end: () => c.end(),
    }
  }
  const c = await mysql2.createConnection(cfg)
  // mysql2: koneksi yang diputus server memancarkan 'error'; tanpa listener bisa jadi uncaught
  c.on('error', () => {})
  return {
    query: async (sql, params) => {
      const [rows] = await c.query(sql, params)
      return Array.isArray(rows) ? (rows as any[]) : [rows]
    },
    end: () => c.end(),
  }
}
