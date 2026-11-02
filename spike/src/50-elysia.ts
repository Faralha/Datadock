// Test 5 — server Elysia jangka panjang: /health ping 3 engine dengan pool admin, provisioning per engine
import { Elysia } from 'elysia'
import postgres from 'postgres'
import mysql from 'mysql2/promise'
import { MongoClient } from 'mongodb'
import { writeFileSync } from 'node:fs'
import { env } from './lib.ts'
import { pgProvision, pgDeprovision, myProvision, myDeprovision, mgProvision, mgDeprovision } from './provision.ts'

const pg = postgres(env('PG_ADMIN_URL'), { max: 5, connect_timeout: 2, idle_timeout: 30, onnotice: () => {} })
const my = mysql.createPool({ uri: env('MARIADB_ADMIN_URL'), connectionLimit: 5, connectTimeout: 2000, enableKeepAlive: true })
const mg = new MongoClient(env('MONGO_ADMIN_URL'), { maxPoolSize: 5, serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 })

const withTimeout = <T>(p: Promise<T>, ms = 2000) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))])

async function ping(name: string, fn: () => Promise<unknown>) {
  const t0 = performance.now()
  try {
    await withTimeout(fn())
    return [name, { up: true, ms: Math.round(performance.now() - t0) }] as const
  } catch (e: any) {
    return [name, { up: false, error: String(e?.message ?? e).split('\n')[0] }] as const
  }
}

const rand = () => Math.random().toString(36).slice(2, 8)

const app = new Elysia()
  .get('/health', async ({ set }) => {
    const engines = Object.fromEntries(await Promise.all([
      ping('postgres', () => pg`SELECT 1`),
      ping('mariadb', () => my.query('SELECT 1')),
      ping('mongo', () => mg.db('admin').command({ ping: 1 })),
    ]))
    const ok = Object.values(engines).every(e => e.up)
    if (!ok) set.status = 503
    return { ok, engines }
  })
  .post('/spike/provision/:engine', async ({ params, set }) => {
    const name = `spk_${rand()}`, pass = `pw_${rand()}${rand()}`
    switch (params.engine) {
      case 'postgres': return { name, ...(await pgProvision(pg, env('PG_ADMIN_URL'), name, pass)), pass }
      case 'mariadb': return { name, ...(await myProvision(my, name, pass)), pass }
      case 'mongo': return { name, ...(await mgProvision(mg, name, pass)), pass }
    }
    set.status = 404
    return { error: 'engine tidak dikenal' }
  })
  .delete('/spike/provision/:engine/:name', async ({ params, set }) => {
    switch (params.engine) {
      case 'postgres': await pgDeprovision(pg, params.name); return { dropped: params.name }
      case 'mariadb': await myDeprovision(my, params.name); return { dropped: params.name }
      case 'mongo': await mgDeprovision(mg, params.name); return { dropped: params.name }
    }
    set.status = 404
    return { error: 'engine tidak dikenal' }
  })
  .onError(({ error, code }) => ({ error: String((error as any)?.message ?? error), code }))
  .listen(3000)

writeFileSync('/tmp/elysia.pid', String(process.pid))
console.log(`elysia ${app.server?.url} pid ${process.pid}`)
