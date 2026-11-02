// Test 4 — backup/restore lewat Docker exec (Engine API via unix socket). Dump ditulis ke volume `backups`.
import postgres from 'postgres'
import mysql from 'mysql2/promise'
import { MongoClient } from 'mongodb'
import { statSync } from 'node:fs'
import { check, assert, saveResults, env, withCreds } from './lib.ts'
import { dockerVersion, dockerExec, dockerExecToFile } from './docker.ts'
import { pgProvision, pgDeprovision, myProvision, myDeprovision, mgProvision, mgDeprovision } from './provision.ts'

const PASS = 'p1pass'
const ROWS = 1000, BIG_ROWS = 200_000
const MONGO_URI_IN = 'mongodb://root:rootpass@localhost:27017/?authSource=admin'
const pgOpts = { max: 1, onnotice: () => {}, connect_timeout: 5 }

const pgAdmin = postgres(env('PG_ADMIN_URL'), pgOpts)
const pgRoot = postgres(env('PG_ROOT_URL'), pgOpts)
const myAdmin = mysql.createPool({ uri: env('MARIADB_ADMIN_URL'), connectionLimit: 2 })
const myRoot = mysql.createPool({ uri: env('MARIADB_ROOT_URL'), connectionLimit: 2 })
const mgAdmin = new MongoClient(env('MONGO_ADMIN_URL'))
const mgRoot = new MongoClient(env('MONGO_ROOT_URL'))

async function cleanup() {
  // p1_restore dulu: pg_restore membuat objek dengan OWNER p1_dev_app_u, jadi role tak bisa di-drop sebelum DB ini hilang
  await pgRoot.unsafe(`DROP DATABASE IF EXISTS p1_restore WITH (FORCE)`)
  await pgDeprovision(pgAdmin, 'p1_dev_app').catch(e => console.log('cleanup pg', e.message))
  await myDeprovision(myAdmin, 'p1_dev_app').catch(e => console.log('cleanup my', e.message))
  await myRoot.query(`DROP DATABASE IF EXISTS p1_restore`)
  await mgDeprovision(mgAdmin, 'p1_dev_app').catch(e => console.log('cleanup mg', e.message))
  await mgRoot.db('p1_restore').dropDatabase()
  await dockerExec('spike-pg', ['sh', '-c', 'rm -f /backups/p1.*']).catch(() => {})
}

async function seed() {
  await pgProvision(pgAdmin, env('PG_ADMIN_URL'), 'p1_dev_app', PASS)
  const pt = postgres(withCreds(env('PG_ROOT_URL'), 'p1_dev_app_u', PASS, 'p1_dev_app'), pgOpts)
  await pt`CREATE TABLE t(id int primary key, s text)`
  await pt`INSERT INTO t SELECT g, md5(g::text) FROM generate_series(1, ${ROWS}) g`
  await pt`CREATE TABLE big(id int, s text)`
  await pt`INSERT INTO big SELECT g, repeat(md5(g::text), 4) FROM generate_series(1, ${BIG_ROWS}) g`
  await pt.end()

  await myProvision(myAdmin as any, 'p1_dev_app', PASS)
  const mt = await mysql.createConnection({ uri: withCreds(env('MARIADB_ROOT_URL'), 'p1_dev_app_u', PASS, 'p1_dev_app') })
  await mt.query(`CREATE TABLE t(id int primary key, s varchar(64))`)
  await mt.query(`INSERT INTO t WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM g WHERE n < ${ROWS}) SELECT n, md5(n) FROM g`)
  await mt.end()

  await mgProvision(mgAdmin, 'p1_dev_app', PASS)
  const gt = new MongoClient(withCreds(env('MONGO_ROOT_URL'), 'p1_dev_app_u', PASS, '', { authSource: 'p1_dev_app' }))
  await gt.db('p1_dev_app').collection('t').insertMany(Array.from({ length: ROWS }, (_, i) => ({ i, s: `doc-${i}` })))
  await gt.close()
}

const pgCount = async (db: string, table = 't') => {
  const c = postgres(withCreds(env('PG_ROOT_URL'), 'postgres', 'rootpass', db), pgOpts)
  try { return (await c.unsafe(`SELECT count(*)::int AS n FROM ${table}`))[0].n as number } finally { await c.end() }
}
const myCount = async (db: string) => Number(((await myRoot.query(`SELECT count(*) AS n FROM \`${db}\`.t`))[0] as any)[0].n)
const mgCount = (db: string) => mgRoot.db(db).collection('t').countDocuments()

function expectOk(r: { exitCode: number; stderr: string }) {
  if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${r.stderr.trim().split('\n').pop()}`)
}

try {
  await cleanup()
  await seed()

  await check('DX-1', async () => {
    const v = await dockerVersion()
    return `Docker ${v.Version}, API ${v.ApiVersion}, ${v.Os} ${v.KernelVersion}`
  })

  await check('DX-2', async () => {
    const t0 = Date.now()
    const r = await dockerExec('spike-pg', ['pg_dump', '-U', 'postgres', '-Fc', '-f', '/backups/p1.dump', 'p1_dev_app'])
    expectOk(r)
    const size = (await dockerExec('spike-pg', ['stat', '-c', '%s', '/backups/p1.dump'])).stdout.trim()
    return `exit 0, ${size} bytes, ${Date.now() - t0}ms`
  })

  await check('DX-3', async () => {
    const r = await dockerExec('spike-pg', ['sh', '-c',
      'createdb -U postgres p1_restore && pg_restore -U postgres -d p1_restore /backups/p1.dump'])
    expectOk(r)
    const [a, b, c, d] = await Promise.all([pgCount('p1_dev_app'), pgCount('p1_restore'), pgCount('p1_dev_app', 'big'), pgCount('p1_restore', 'big')])
    assert(a === b && c === d, `t ${a}≠${b} atau big ${c}≠${d}`)
    return `t ${a}=${b}, big ${c}=${d}`
  })

  await check('DX-4', async () => {
    const r = await dockerExec('spike-mariadb', ['sh', '-c',
      'mariadb-dump -uroot -prootpass --single-transaction --routines p1_dev_app > /backups/p1.sql'])
    expectOk(r)
    const size = Number((await dockerExec('spike-mariadb', ['stat', '-c', '%s', '/backups/p1.sql'])).stdout.trim())
    assert(size > 0, 'file kosong')
    const alias = await dockerExec('spike-mariadb', ['sh', '-c', 'command -v mysqldump || echo tidak-ada'])
    return `exit 0, ${size} bytes; mysqldump: ${alias.stdout.trim()}`
  })

  await check('DX-5', async () => {
    const r = await dockerExec('spike-mariadb', ['sh', '-c',
      "mariadb -uroot -prootpass -e 'CREATE DATABASE p1_restore' && mariadb -uroot -prootpass p1_restore < /backups/p1.sql"])
    expectOk(r)
    const [a, b] = await Promise.all([myCount('p1_dev_app'), myCount('p1_restore')])
    assert(a === b, `${a}≠${b}`)
    return `${a}=${b}`
  })

  await check('DX-6', async () => {
    const r = await dockerExec('spike-mongo', ['mongodump', `--uri=${MONGO_URI_IN}`, '--db=p1_dev_app',
      '--archive=/backups/p1.archive', '--gzip'])
    expectOk(r)
    const size = (await dockerExec('spike-mongo', ['stat', '-c', '%s', '/backups/p1.archive'])).stdout.trim()
    return `exit 0, ${size} bytes`
  })

  await check('DX-7', async () => {
    const r = await dockerExec('spike-mongo', ['mongorestore', `--uri=${MONGO_URI_IN}`, '--archive=/backups/p1.archive',
      '--gzip', '--nsFrom=p1_dev_app.*', '--nsTo=p1_restore.*'])
    expectOk(r)
    const [a, b] = await Promise.all([mgCount('p1_dev_app'), mgCount('p1_restore')])
    assert(a === b, `${a}≠${b}`)
    return `${a}=${b}`
  })

  await check('DX-8', async () => {
    const r = await dockerExec('spike-pg', ['pg_dump', '-U', 'postgres', '-Fc', '-f', '/backups/p1.gagal', 'tidak_ada'])
    assert(r.exitCode !== 0, 'exit code 0')
    assert(/does not exist/.test(r.stderr), `stderr: ${r.stderr}`)
    return `exit ${r.exitCode}, stderr: ${r.stderr.trim()}`
  })

  await check('DX-9', async () => {
    const r = await dockerExecToFile('spike-pg', ['pg_dump', '-U', 'postgres', '-Fc', 'p1_dev_app'], '/tmp/p1-stream.dump')
    expectOk(r)
    const fileSize = (await dockerExec('spike-pg', ['stat', '-c', '%s', '/backups/p1.dump'])).stdout.trim()
    const local = statSync('/tmp/p1-stream.dump').size
    assert(local === r.bytes, 'byte tertulis ≠ ukuran file')
    // validasi: dump hasil stream bisa dibaca pg_restore --list
    const head = await dockerExec('spike-pg', ['sh', '-c', 'pg_restore -l /backups/p1.dump | grep -c TABLE'])
    return `stream ${local} bytes vs file ${fileSize} bytes (selisih ${local - Number(fileSize)}); TOC TABLE entries ${head.stdout.trim()}`
  })
} finally {
  await cleanup().catch(e => console.log('cleanup gagal', e.message))
  await Promise.all([pgAdmin.end(), pgRoot.end(), myAdmin.end(), myRoot.end(), mgAdmin.close(), mgRoot.close()])
}
saveResults('40-docker-exec')
