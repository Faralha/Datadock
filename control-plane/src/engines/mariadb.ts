import mysql from 'mysql2/promise'
import { ident, type EngineDriver, type TenantSpec, type WriteMode } from './types.ts'

// Hak yang dicabut saat quota penuh. DELETE dan DROP sengaja dibiarkan supaya tenant bisa
// mengosongkan data sendiri untuk kembali di bawah quota.
const GROWTH_PRIVS = 'INSERT, UPDATE, CREATE, ALTER, INDEX, CREATE VIEW, CREATE ROUTINE, CREATE TEMPORARY TABLES, EVENT, TRIGGER'

export function createMariadbDriver(adminUrl: string): EngineDriver {
  const pool = mysql.createPool({ uri: adminUrl, connectionLimit: 5, connectTimeout: 5000, enableKeepAlive: true })
  const lit = (s: string) => pool.escape(s)

  async function killSessions(user: string) {
    // REVOKE tidak berlaku untuk koneksi yang sudah terbuka (spike MY-11) → putus. Butuh CONNECTION ADMIN.
    const [rows] = await pool.query(`SELECT id FROM information_schema.processlist WHERE user = ?`, [user])
    for (const r of rows as { id: number }[]) {
      await pool.query(`KILL CONNECTION ${Number(r.id)}`).catch(e => {
        if (e?.errno !== 1094) throw e // 1094 = thread sudah hilang
      })
    }
  }

  return {
    engine: 'mariadb',

    async ping() { await pool.query('SELECT 1') },

    async provision(t: TenantSpec) {
      const db = ident(t.database), user = ident(t.user)
      await pool.query(`CREATE DATABASE IF NOT EXISTS \`${db}\``)
      await pool.query(`CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY ${lit(t.password)}`)
      // MariaDB: max_statement_time (detik), bukan max_execution_time milik MySQL. Tenant bisa
      // menimpanya per sesi (spike MY-8), jadi ini default, bukan batas keras.
      await pool.query(`ALTER USER '${user}'@'%' IDENTIFIED BY ${lit(t.password)}
        WITH MAX_USER_CONNECTIONS ${t.maxConnections | 0} MAX_STATEMENT_TIME ${t.timeoutS | 0}`)
      await pool.query(`GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${user}'@'%'`)
    },

    async deprovision(database, user) {
      const db = ident(database), u = ident(user)
      await killSessions(u)
      await pool.query(`DROP DATABASE IF EXISTS \`${db}\``)
      await pool.query(`DROP USER IF EXISTS '${u}'@'%'`)
    },

    async rotatePassword(user, password) {
      await pool.query(`ALTER USER '${ident(user)}'@'%' IDENTIFIED BY ${lit(password)}`)
    },

    async sizeBytes(database) {
      const [rows] = await pool.query(
        `SELECT COALESCE(SUM(data_length + index_length), 0) AS size FROM information_schema.tables WHERE table_schema = ?`,
        [ident(database)])
      return Number((rows as any[])[0].size)
    },

    async setWriteMode(database, user, mode: WriteMode) {
      const db = ident(database), u = ident(user)
      if (mode === 'none') {
        await pool.query(`GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${u}'@'%'`)
        return
      }
      // REVOKE hak yang tidak dimiliki memberi error 1141; hak di atas selalu ada sejak GRANT ALL
      await pool.query(`REVOKE ${GROWTH_PRIVS} ON \`${db}\`.* FROM '${u}'@'%'`).catch(e => {
        if (e?.errno !== 1141) throw e
      })
      await killSessions(u)
    },

    async tenantCanConnect(database, user, password) {
      const u = new URL(adminUrl)
      const c = await mysql.createConnection({
        host: u.hostname, port: Number(u.port || 3306), user, password, database, connectTimeout: 5000,
      }).catch(() => null)
      if (!c) return false
      c.on('error', () => {})
      await c.end().catch(() => {})
      return true
    },

    connectionString(host, port, database, user, password) {
      return `mysql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`
    },

    async close() { await pool.end() },
  }
}
