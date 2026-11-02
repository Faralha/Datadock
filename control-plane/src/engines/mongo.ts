import { MongoClient } from 'mongodb'
import { ident, type EngineDriver, type TenantSpec, type WriteMode } from './types.ts'

// Driver dipin ke mongodb@6: mongodb@7 (bson ≥ 7.3) gagal di-load di Bun 1.3 (spike Masalah #1)
export function createMongoDriver(adminUrl: string): EngineDriver {
  const client = new MongoClient(adminUrl, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 })
  const rolesFor = (db: string, mode: WriteMode) =>
    mode === 'none'
      ? [{ role: 'readWrite', db }, { role: 'dbAdmin', db }]
      // dbAdmin juga dicabut: tanpa itu tenant read-only masih bisa createCollection/createIndex (spike MG-9)
      : mode === 'read_only' ? [{ role: 'read', db }] : []

  async function userExists(db: string, user: string) {
    const r = await client.db(db).command({ usersInfo: user })
    return r.users.length > 0
  }

  return {
    engine: 'mongo',

    async ping() { await client.db('admin').command({ ping: 1 }) },

    async provision(t: TenantSpec) {
      const db = ident(t.database), user = ident(t.user)
      // Mongo tidak punya batas koneksi per user maupun timeout query per user; dipantau control plane
      const roles = rolesFor(db, 'none')
      if (await userExists(db, user)) await client.db(db).command({ updateUser: user, pwd: t.password, roles })
      else await client.db(db).command({ createUser: user, pwd: t.password, roles })
    },

    async deprovision(database, user) {
      const db = ident(database), u = ident(user)
      if (await userExists(db, u)) await client.db(db).command({ dropUser: u })
      await client.db(db).dropDatabase()
    },

    async rotatePassword(user, password) {
      // User Mongo tenant disimpan di DB miliknya sendiri, dengan nama <db>_u
      const db = user.replace(/_u$/, '')
      await client.db(ident(db)).command({ updateUser: ident(user), pwd: password })
    },

    async sizeBytes(database) {
      const s = await client.db(ident(database)).command({ dbStats: 1 })
      return Number(s.storageSize ?? 0) + Number(s.indexSize ?? 0)
    },

    async setWriteMode(database, user, mode: WriteMode) {
      // Perubahan role langsung berlaku juga untuk koneksi yang sudah terbuka (spike MG-9)
      const db = ident(database)
      await client.db(db).command({ updateUser: ident(user), roles: rolesFor(db, mode) })
    },

    async tenantCanConnect(database, user, password) {
      const u = new URL(adminUrl)
      u.username = user; u.password = password; u.searchParams.set('authSource', database)
      const c = new MongoClient(u.toString(), { serverSelectionTimeoutMS: 5000 })
      try {
        await c.db(database).command({ ping: 1 })
        return true
      } catch {
        return false
      } finally {
        await c.close()
      }
    },

    connectionString(host, port, database, user, password) {
      // Tanpa ?authSource: default-nya DB di path, dan GitLab tidak bisa me-mask nilai yang memuat '?'
      return `mongodb://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`
    },

    async close() { await client.close() },
  }
}
