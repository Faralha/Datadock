// Test 3 — MongoDB dengan driver `mongodb`. Semua langkah admin memakai dbaas_admin.
import { MongoClient } from 'mongodb'
import { check, expectReject, assert, saveResults, env, withCreds } from './lib.ts'

const ADMIN = env('MONGO_ADMIN_URL')
const ROOT = env('MONGO_ROOT_URL')
const P1_PASS = 'p1pass', P2_PASS = 'p2pass', P1_NEW = 'p1pass_baru'
const clientOpts = { serverSelectionTimeoutMS: 5000 }
const tenant = (pass = P1_PASS) =>
  new MongoClient(withCreds(ROOT, 'p1_dev_app_u', pass, '', { authSource: 'p1_dev_app' }), clientOpts)

async function cleanup() {
  const root = new MongoClient(ROOT, clientOpts)
  try {
    for (const p of ['p1', 'p2']) {
      const db = root.db(`${p}_dev_app`)
      try { await db.command({ dropUser: `${p}_dev_app_u` }) } catch {}
      await db.dropDatabase()
    }
  } finally {
    await root.close()
  }
}

async function using<T>(c: MongoClient, fn: (c: MongoClient) => Promise<T>) {
  try { return await fn(c) } finally { await c.close() }
}

await cleanup()
const admin = new MongoClient(ADMIN, clientOpts)
try {
  await check('MG-1', async () => {
    await admin.connect()
    const s = await admin.db('admin').command({ connectionStatus: 1 })
    const u = s.authInfo.authenticatedUsers[0]
    assert(u?.user === 'dbaas_admin', `user=${u?.user}`)
    return `${u.user}@${u.db}, roles: ${s.authInfo.authenticatedUserRoles.map((r: any) => r.role).join(',')}`
  })

  const createTenant = (p: string, pwd: string) => admin.db(`${p}_dev_app`).command({
    createUser: `${p}_dev_app_u`, pwd,
    roles: [{ role: 'readWrite', db: `${p}_dev_app` }, { role: 'dbAdmin', db: `${p}_dev_app` }],
  })

  await check('MG-2', async () => { await createTenant('p1', P1_PASS) })
  await check('MG-3', async () => {
    await createTenant('p2', P2_PASS)
    await admin.db('p2_dev_app').collection('secret').insertOne({ x: 1 })
  })

  await check('MG-4', () => using(tenant(), async c => {
    const col = c.db('p1_dev_app').collection('t')
    await col.insertMany(Array.from({ length: 100 }, (_, i) => ({ i })))
    const n = await col.countDocuments()
    assert(n === 100, `count=${n}`)
    return '100 dokumen'
  }))

  await check('MG-5', () => using(tenant(), async c => {
    const r = await expectReject(() => c.db('p2_dev_app').collection('secret').find().toArray(), /not authorized/)
    const dbs = await c.db('admin').command({ listDatabases: 1, nameOnly: true, authorizedDatabases: true })
    return `${r}; listDatabases: ${dbs.databases.map((d: any) => d.name).join(',')}`
  }))

  await check('MG-6', () => using(tenant(), async c => {
    const col = c.db('p1_dev_app').collection('t')
    try {
      const msg = await expectReject(() => col.find({ $where: 'sleep(100) || true' }).maxTimeMS(1).toArray(), /MaxTimeMSExpired|exceeded time limit/)
      return `$where sleep: ${msg}`
    } catch (e: any) {
      // $where/sleep tidak tersedia → pakai koleksi besar + regex mahal
      const big = c.db('p1_dev_app').collection('big')
      await big.insertMany(Array.from({ length: 200_000 }, (_, i) => ({ i, s: `item-${i}-${'x'.repeat(50)}` })))
      const msg = await expectReject(() => big.find({ s: /^(.*x)*y$/ }).maxTimeMS(1).toArray(), /MaxTimeMSExpired|exceeded time limit/)
      return `fallback koleksi besar (${e.message.split('\n')[0]}): ${msg}`
    }
  }))

  await check('MG-7', async () => {
    const s = await admin.db('p1_dev_app').command({ dbStats: 1 })
    assert(typeof s.dataSize === 'number' && typeof s.storageSize === 'number', 'field hilang')
    return `dataSize=${s.dataSize}, storageSize=${s.storageSize}`
  })

  await check('MG-8', async () => {
    const s = await admin.db('admin').command({ serverStatus: 1 })
    return `connections: ${JSON.stringify(s.connections).slice(0, 120)}`
  })

  await check('MG-9', async () => {
    const before = tenant()
    try {
      await before.db('p1_dev_app').collection('t').insertOne({ before: true })
      await admin.db('p1_dev_app').command({ revokeRolesFromUser: 'p1_dev_app_u', roles: [{ role: 'readWrite', db: 'p1_dev_app' }] })
      await admin.db('p1_dev_app').command({ grantRolesToUser: 'p1_dev_app_u', roles: [{ role: 'read', db: 'p1_dev_app' }] })
      const fresh = await using(tenant(), c =>
        expectReject(() => c.db('p1_dev_app').collection('t').insertOne({ x: 1 }), /not authorized/))
      const existing = await before.db('p1_dev_app').collection('t').insertOne({ x: 2 })
        .then(() => 'koneksi lama MASIH bisa insert', () => 'koneksi lama juga ditolak (langsung berlaku)')
      // dbAdmin masih melekat: apa saja yang masih bisa dilakukan tenant saat "read-only"?
      const ddl = await using(tenant(), async c => {
        const out: string[] = []
        const db = c.db('p1_dev_app')
        await db.createCollection('ro_new').then(() => out.push('createCollection OK'), () => out.push('createCollection ditolak'))
        await db.collection('t').createIndex({ i: 1 }).then(() => out.push('createIndex OK'), () => out.push('createIndex ditolak'))
        return out.join(', ')
      })
      return `koneksi baru ${fresh}; ${existing}; dengan dbAdmin: ${ddl}`
    } finally {
      await before.close()
    }
  })

  await check('MG-10', async () => {
    await admin.db('p1_dev_app').command({ updateUser: 'p1_dev_app_u', pwd: P1_NEW })
    await using(tenant(P1_PASS), c => expectReject(() => c.connect(), /Authentication failed/))
    await using(tenant(P1_NEW), async c => { await c.db('p1_dev_app').collection('t').findOne() })
    return 'password lama ditolak, password baru berhasil'
  })

  await check('MG-11', async () => {
    await admin.db('p1_dev_app').command({ dropUser: 'p1_dev_app_u' })
    await admin.db('p1_dev_app').dropDatabase()
    const { databases } = await admin.db('admin').command({ listDatabases: 1, nameOnly: true })
    assert(!databases.some((d: any) => d.name === 'p1_dev_app'), 'database masih ada')
  })
} finally {
  await admin.close()
  await cleanup()
}
saveResults('30-mongo')
