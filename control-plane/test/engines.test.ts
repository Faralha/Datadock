// Driver engine terhadap PG 18.3, MariaDB 12.2.2, Mongo 8.0 asli, dengan akun admin hak minimum
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createPostgresDriver } from '../src/engines/postgres.ts'
import { createMariadbDriver } from '../src/engines/mariadb.ts'
import { createMongoDriver } from '../src/engines/mongo.ts'
import { ENGINES, type EngineDriver } from '../src/engines/index.ts'
import { ensureBootstrap } from './helpers.ts'
import { tenantWrite } from './tenant.ts'

const make = {
  postgres: () => createPostgresDriver(process.env.PG_ADMIN_URL!),
  mariadb: () => createMariadbDriver(process.env.MARIADB_ADMIN_URL!),
  mongo: () => createMongoDriver(process.env.MONGO_ADMIN_URL!),
}

for (const engine of ENGINES) {
  describe(engine, () => {
    let d: EngineDriver
    const run = Date.now().toString(36)
    const a = { database: `tst_${run}_a`, user: `tst_${run}_a_u`, password: 'pwA1234567', maxConnections: 20, timeoutS: 30 }
    const b = { database: `tst_${run}_b`, user: `tst_${run}_b_u`, password: 'pwB1234567', maxConnections: 20, timeoutS: 30 }

    beforeAll(async () => {
      await ensureBootstrap()
      d = make[engine]()
    })
    afterAll(async () => {
      for (const t of [a, b]) await d.deprovision(t.database, t.user).catch(() => {})
      await d.close()
    })

    test('provision idempoten dan tenant bisa menulis', async () => {
      await d.provision(a)
      await d.provision(a) // ulang tanpa error (OT-1)
      await d.provision(b)
      expect(await d.tenantCanConnect(a.database, a.user, a.password)).toBe(true)
      expect(await tenantWrite(engine, a.database, a.user, a.password)).toBe('ok')
    })

    test('isolasi tenant (NFR-01): user A tidak bisa masuk DB B', async () => {
      expect(await d.tenantCanConnect(b.database, a.user, a.password)).toBe(false)
      expect(await tenantWrite(engine, b.database, a.user, a.password)).not.toBe('ok')
    })

    test('ukuran database terbaca', async () => {
      expect(await d.sizeBytes(a.database)).toBeGreaterThan(0)
    })

    test('mode read_only menolak tulis, lalu pulih', async () => {
      await d.setWriteMode(a.database, a.user, 'read_only')
      await d.setWriteMode(a.database, a.user, 'read_only') // idempoten
      expect(await tenantWrite(engine, a.database, a.user, a.password)).not.toBe('ok')
      await d.setWriteMode(a.database, a.user, 'none')
      expect(await tenantWrite(engine, a.database, a.user, a.password)).toBe('ok')
    })

    test('mode blocked menolak tulis; di PostgreSQL koneksi pun ditolak', async () => {
      await d.setWriteMode(a.database, a.user, 'blocked')
      expect(await tenantWrite(engine, a.database, a.user, a.password)).not.toBe('ok')
      if (engine === 'postgres') expect(await d.tenantCanConnect(a.database, a.user, a.password)).toBe(false)
      await d.setWriteMode(a.database, a.user, 'none')
      expect(await tenantWrite(engine, a.database, a.user, a.password)).toBe('ok')
    })

    test('rotasi password langsung berlaku', async () => {
      await d.rotatePassword(a.user, 'pwBaru987654')
      expect(await d.tenantCanConnect(a.database, a.user, a.password)).toBe(false)
      expect(await d.tenantCanConnect(a.database, a.user, 'pwBaru987654')).toBe(true)
      a.password = 'pwBaru987654'
    })

    test('deprovision menghapus DB dan user', async () => {
      await d.deprovision(a.database, a.user)
      await d.deprovision(a.database, a.user) // idempoten
      expect(await d.tenantCanConnect(a.database, a.user, a.password)).toBe(false)
    })
  })
}
