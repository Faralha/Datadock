import { test, expect } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { makeCipher, generatePassword } from '../src/crypto.ts'
import { openDb } from '../src/db.ts'
import { createAudit } from '../src/audit.ts'
import { createScheduler } from '../src/scheduler.ts'
import { physicalName, tenantUser } from '../src/services/databases.ts'
import { ident } from '../src/engines/types.ts'
import { roleFromAccess } from '../src/gitlab.ts'

test('AES-256-GCM: roundtrip, IV acak, dan ciphertext yang diubah ditolak', () => {
  const c = makeCipher(randomBytes(32).toString('base64'))
  const a = c.encrypt('rahasia'), b = c.encrypt('rahasia')
  expect(a).not.toBe(b)
  expect(c.decrypt(a)).toBe('rahasia')
  const parts = a.split('.')
  parts[3] = Buffer.from('lain').toString('base64url')
  expect(() => c.decrypt(parts.join('.'))).toThrow()
  expect(() => makeCipher(randomBytes(16).toString('base64'))).toThrow()
})

test('password acak: panjang tetap, hanya karakter aman', () => {
  const p = generatePassword()
  expect(p).toHaveLength(32)
  expect(p).toMatch(/^[A-Za-z0-9]+$/)
})

test('nama fisik mengikuti pola dan lolos validasi identifier', () => {
  const db = physicalName(142, 'staging', 'app')
  expect(db).toBe('p142_staging_app')
  expect(tenantUser(db)).toBe('p142_staging_app_u')
  expect(ident(tenantUser(physicalName(9999999999, 'abcdefghijkl', 'a'.repeat(24))))).toHaveLength(51)
  // Prefiks instance terpanjang (8 karakter) tetap di bawah batas identifier PostgreSQL (63)
  expect(ident(tenantUser(physicalName(9999999999, 'abcdefghijkl', 'a'.repeat(24), 'd1234567_')))).toHaveLength(60)
  expect(physicalName(142, 'dev', 'app', 'd9f3c1_')).toBe('d9f3c1_p142_dev_app')
  expect(() => ident('x; DROP DATABASE y')).toThrow()
  expect(() => ident('Upper')).toThrow()
})

test('pemetaan access level GitLab ke role platform', () => {
  expect(roleFromAccess(50)).toBe('maintainer')
  expect(roleFromAccess(40)).toBe('maintainer')
  expect(roleFromAccess(30)).toBe('developer')
  expect(roleFromAccess(20)).toBeNull()
  expect(roleFromAccess(10)).toBeNull()
})

test('audit log append-only: UPDATE dan DELETE ditolak', () => {
  const db = openDb(':memory:')
  const audit = createAudit(db)
  audit.log({ actor: { id: 1, username: 'a' }, action: 'x', result: 'ok' })
  expect(() => db.query(`UPDATE audit_events SET action = 'y'`).run()).toThrow(/append-only/)
  expect(() => db.query(`DELETE FROM audit_events`).run()).toThrow(/append-only/)
  expect(audit.list()).toHaveLength(1)
})

test('scheduler: job harian jalan sekali per hari, job interval sesuai jeda', async () => {
  const db = openDb(':memory:')
  let daily = 0, every = 0
  const hour = new Date().getUTCHours()
  const s = createScheduler(db, [
    { name: 'daily', dailyAtUtcHour: hour, run: async () => { daily++ } },
    { name: 'every', everyMinutes: 60, run: async () => { every++ } },
  ], 20)
  s.start()
  await Bun.sleep(150)
  s.stop()
  expect(daily).toBe(1)
  expect(every).toBe(1)
  await s.runNow('daily')
  expect(daily).toBe(2)
})

test('ENGINES: hanya engine aktif yang butuh konfigurasi, nilai tidak dikenal ditolak', async () => {
  const { loadConfig, engineConfig } = await import('../src/config.ts')
  const keys = ['ENGINES', 'ENCRYPTION_KEY', 'GITLAB_URL', 'GITLAB_CLIENT_ID', 'GITLAB_CLIENT_SECRET', 'GITLAB_BOT_TOKEN',
    'PG_ADMIN_URL', 'PG_ADMIN_PASSWORD', 'MARIADB_ADMIN_URL', 'MARIADB_ADMIN_PASSWORD', 'MONGO_ADMIN_URL', 'MONGO_ADMIN_PASSWORD']
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  try {
    for (const k of keys) delete process.env[k]
    Object.assign(process.env, { ENCRYPTION_KEY: 'x', GITLAB_URL: 'https://g', GITLAB_CLIENT_ID: 'i', GITLAB_CLIENT_SECRET: 's',
      GITLAB_BOT_TOKEN: 't', PG_ADMIN_PASSWORD: 'p@ss' })

    process.env.ENGINES = 'postgres'
    const cfg = loadConfig()
    expect(cfg.enabledEngines).toEqual(['postgres'])
    expect(Object.keys(cfg.engines)).toEqual(['postgres'])
    expect(engineConfig(cfg, 'postgres').adminUrl).toContain('dbaas_admin:p%40ss@')
    expect(() => engineConfig(cfg, 'mariadb')).toThrow('tidak aktif')

    process.env.ENGINES = 'mongo, postgres'
    process.env.MONGO_ADMIN_PASSWORD = 'm'
    expect(loadConfig().enabledEngines).toEqual(['postgres', 'mongo'])

    process.env.ENGINES = 'postgres,mysql'
    expect(() => loadConfig()).toThrow('ENGINES tidak valid: mysql')

    delete process.env.ENGINES
    expect(() => loadConfig()).toThrow('MARIADB_ADMIN_URL atau MARIADB_ADMIN_PASSWORD wajib diisi')
  } finally {
    for (const k of keys) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])
  }
})
