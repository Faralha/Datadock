// Lingkungan test: engine asli dari compose (lewat env), metadata SQLite in-memory, GitLab palsu
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { buildContext } from '../src/index.ts'
import { bootstrapPostgres, bootstrapMariadb, bootstrapMongo } from '../src/bootstrap.ts'
import { startFakeGitlab } from './fake-gitlab.ts'

export const ORIGIN = 'http://datadock.test'
export const BOT_TOKEN = 'bot-token-test'

let bootstrapped = false
export async function ensureBootstrap() {
  if (bootstrapped) return
  await bootstrapPostgres(process.env.PG_ROOT_URL!, process.env.PG_ADMIN_URL!)
  await bootstrapMariadb(process.env.MARIADB_ROOT_URL!, process.env.MARIADB_ADMIN_URL!)
  await bootstrapMongo(process.env.MONGO_ROOT_URL!, process.env.MONGO_ADMIN_URL!)
  bootstrapped = true
}

// Id project acak supaya nama fisik tidak bentrok dengan sisa run sebelumnya
export const randomProjectId = () => 100_000 + Math.floor(Math.random() * 899_999)

export async function createTestContext(env: Record<string, string> = {}) {
  await ensureBootstrap()
  const gitlab = startFakeGitlab(BOT_TOKEN)
  Object.assign(process.env, {
    PUBLIC_URL: ORIGIN,
    SQLITE_PATH: ':memory:',
    BACKUP_DIR: mkdtempSync(join(tmpdir(), 'datadock-backups-')),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    COOKIE_SECURE: 'false',
    GITLAB_URL: gitlab.url,
    GITLAB_CLIENT_ID: 'test-client',
    GITLAB_CLIENT_SECRET: 'test-secret',
    GITLAB_BOT_TOKEN: BOT_TOKEN,
    ADMIN_USERNAMES: 'root-admin',
    ADMIN_GROUP: 'demo/admins',
    ...env,
  })
  const ctx = buildContext(loadConfig())

  async function call(method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null } = {}) {
    const headers: Record<string, string> = {}
    if (opts.cookie) headers.cookie = opts.cookie
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const res = await ctx.app.handle(new Request(`${ORIGIN}${path}`, {
      method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }))
    const text = await res.text()
    let data: any = text
    try { data = JSON.parse(text) } catch {}
    return { status: res.status, data, headers: res.headers }
  }

  // Login lewat alur OAuth lengkap; mengembalikan header cookie
  async function login(userId: number) {
    const start = await ctx.app.handle(new Request(`${ORIGIN}/auth/login`))
    const { code, state } = gitlab.approve(start.headers.get('location')!, userId)
    const cb = await ctx.app.handle(new Request(`${ORIGIN}/auth/callback?code=${code}&state=${state}`))
    if (cb.status !== 302) throw new Error(`login gagal ${cb.status}: ${await cb.text()}`)
    const setCookie = cb.headers.get('set-cookie')!
    return setCookie.split(';')[0]
  }

  return {
    ctx, gitlab, call, login,
    async close() {
      gitlab.stop()
      await ctx.close()
    },
  }
}
