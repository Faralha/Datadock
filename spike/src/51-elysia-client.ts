// Klien untuk Test 5: EL-1, EL-2 (provision + login tenant + deprovision), EL-3 load, EL-4 RSS
// PHASE=main (default) | rss-late
import postgres from 'postgres'
import mysql from 'mysql2/promise'
import { MongoClient } from 'mongodb'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { check, assert, saveResults, results, env, withCreds } from './lib.ts'

const BASE = 'http://localhost:3000'
const pid = readFileSync('/tmp/elysia.pid', 'utf8').trim()
const rssKb = () => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))![1])
const RSS_FILE = 'results/el-rss.json'

if (process.env.PHASE === 'rss-late') {
  const rss = JSON.parse(readFileSync(RSS_FILE, 'utf8'))
  rss.late = rssKb()
  writeFileSync(RSS_FILE, JSON.stringify(rss))
  console.log('RSS (KB)', rss)
  process.exit(0)
}

await check('EL-1', async () => {
  const r = await fetch(`${BASE}/health`)
  const body = await r.json()
  assert(r.status === 200 && body.ok, JSON.stringify(body))
  return JSON.stringify(body.engines)
})

async function tenantLogin(engine: string, p: { database: string; user: string; pass: string }) {
  if (engine === 'postgres') {
    const c = postgres(withCreds(env('PG_ROOT_URL'), p.user, p.pass, p.database), { max: 1 })
    try { await c`CREATE TABLE x(id int)`; await c`INSERT INTO x VALUES (1)` } finally { await c.end() }
  } else if (engine === 'mariadb') {
    const c = await mysql.createConnection({ uri: withCreds(env('MARIADB_ROOT_URL'), p.user, p.pass, p.database) })
    try { await c.query('CREATE TABLE x(id int)'); await c.query('INSERT INTO x VALUES (1)') } finally { await c.end() }
  } else {
    const c = new MongoClient(withCreds(env('MONGO_ROOT_URL'), p.user, p.pass, '', { authSource: p.database }))
    try { await c.db(p.database).collection('x').insertOne({ id: 1 }) } finally { await c.close() }
  }
}

await check('EL-2', async () => {
  const out: string[] = []
  for (const engine of ['postgres', 'mariadb', 'mongo']) {
    const r = await fetch(`${BASE}/spike/provision/${engine}`, { method: 'POST' })
    const p = await r.json()
    assert(r.status === 200 && p.user, `${engine}: ${JSON.stringify(p)}`)
    try {
      await tenantLogin(engine, p)
      out.push(`${engine}:${p.name} OK`)
    } finally {
      const d = await fetch(`${BASE}/spike/provision/${engine}/${p.name}`, { method: 'DELETE' })
      assert(d.status === 200, `${engine} deprovision: ${await d.text()}`)
    }
  }
  return out.join(', ')
})

const before = rssKb()

// EL-3: 2.000 request, konkurensi 20, ukur latensi per request
await check('EL-3', async () => {
  const N = 2000, C = 20
  const lat: number[] = []
  let errors = 0, next = 0
  const t0 = performance.now()
  await Promise.all(Array.from({ length: C }, async () => {
    while (next < N) {
      next++
      const s = performance.now()
      try {
        const r = await fetch(`${BASE}/health`)
        await r.arrayBuffer()
        if (r.status !== 200) errors++
      } catch { errors++ }
      lat.push(performance.now() - s)
    }
  }))
  const total = (performance.now() - t0) / 1000
  lat.sort((a, b) => a - b)
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(1)
  assert(errors === 0, `${errors} error`)
  return `${lat.length} req, ${errors} error, ${(lat.length / total).toFixed(0)} req/s, p50 ${pct(0.5)}ms, p95 ${pct(0.95)}ms, p99 ${pct(0.99)}ms`
})

const after = rssKb()
writeFileSync(RSS_FILE, JSON.stringify({ before, after }))
console.log('RSS (KB)', { before, after })
saveResults('50-elysia')
