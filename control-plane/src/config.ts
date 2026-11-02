// Semua konfigurasi dari environment (NFR-14). Nilai wajib dibaca lazily supaya test bisa menimpa env.
import { ENGINES, type EngineName } from './engines/types.ts'

const str = (k: string, d?: string) => {
  const v = process.env[k] ?? d
  if (v === undefined || v === '') throw new Error(`env ${k} wajib diisi`)
  return v
}
const opt = (k: string) => process.env[k] || undefined
const num = (k: string, d: number) => {
  const v = process.env[k]
  if (!v) return d
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`env ${k} bukan angka: ${v}`)
  return n
}
const bool = (k: string, d: boolean) => (process.env[k] ? process.env[k] === 'true' : d)
const tenantPrefix = (v: string) => {
  if (v && !/^[a-z][a-z0-9]{0,7}_$/.test(v)) throw new Error(`env TENANT_PREFIX tidak valid: ${v} (contoh: d1a2b3_)`)
  return v
}
// Engine adalah instance yang sudah ada di server (bare-metal), dijangkau lewat host:port. URL admin bisa diberikan
// utuh (dev lokal), atau dirakit dari password + host/port (deploy: password tetap di env file privat).
const engine = (k: 'PG' | 'MARIADB' | 'MONGO', defaultHost: string, defaultPort: number,
  build: (pw: string, host: string, port: number) => string) => {
  const host = str(`${k}_HOST`, defaultHost)
  const port = num(`${k}_PORT`, defaultPort)
  const full = process.env[`${k}_ADMIN_URL`]
  const pw = process.env[`${k}_ADMIN_PASSWORD`]
  if (!full && !pw) throw new Error(`env ${k}_ADMIN_URL atau ${k}_ADMIN_PASSWORD wajib diisi`)
  return {
    adminUrl: full ?? build(encodeURIComponent(pw!), host, port),
    // Alamat yang dipakai aplikasi tenant; bisa berbeda dari alamat yang dipakai control plane
    publicHost: str(`PUBLIC_${k}_HOST`, host),
    publicPort: num(`PUBLIC_${k}_PORT`, port),
  }
}
const list = (k: string) => (process.env[k] ?? '').split(',').map(s => s.trim()).filter(Boolean)
// ENGINES: engine yang dipakai (default semuanya). Engine lain tidak butuh konfigurasi dan tidak dihubungi.
const enabledEngines = (): EngineName[] => {
  const v = list('ENGINES')
  if (!v.length) return [...ENGINES]
  const bad = v.filter(e => !(ENGINES as readonly string[]).includes(e))
  if (bad.length) throw new Error(`env ENGINES tidak valid: ${bad.join(', ')} (pilihan: ${ENGINES.join(', ')})`)
  return ENGINES.filter(e => v.includes(e))
}
type EngineConfig = ReturnType<typeof engine>
const ENGINE_DEFS: Record<EngineName, () => EngineConfig> = {
  postgres: () => engine('PG', 'localhost', 5432, (pw, h, p) => `postgres://dbaas_admin:${pw}@${h}:${p}/postgres`),
  mariadb: () => engine('MARIADB', 'localhost', 3306, (pw, h, p) => `mysql://dbaas_admin:${pw}@${h}:${p}`),
  mongo: () => engine('MONGO', 'localhost', 27017, (pw, h, p) => `mongodb://dbaas_admin:${pw}@${h}:${p}/?authSource=admin`),
}

export function loadConfig() {
  return {
    port: num('PORT', 3000),
    publicUrl: str('PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''),
    cookieSecure: bool('COOKIE_SECURE', true),
    trustProxy: bool('TRUST_PROXY', false),
    sqlitePath: str('SQLITE_PATH', './data/datadock.sqlite'),
    encryptionKey: str('ENCRYPTION_KEY'),
    sessionTtlHours: num('SESSION_TTL_HOURS', 12),

    gitlab: {
      url: str('GITLAB_URL').replace(/\/$/, ''),
      clientId: str('GITLAB_CLIENT_ID'),
      clientSecret: str('GITLAB_CLIENT_SECRET'),
      botToken: str('GITLAB_BOT_TOKEN'),
    },
    adminUsernames: list('ADMIN_USERNAMES'),
    adminGroup: opt('ADMIN_GROUP'),

    enabledEngines: enabledEngines(),
    engines: Object.fromEntries(enabledEngines().map(e => [e, ENGINE_DEFS[e]()])) as Partial<Record<EngineName, EngineConfig>>,

    backup: {
      dir: str('BACKUP_DIR', '/backups').replace(/\/$/, ''),
      hourUtc: num('BACKUP_HOUR_UTC', 19),
      retentionDays: num('BACKUP_RETENTION_DAYS', 7),
    },

    quotaDefaults: {
      maxDatabases: num('QUOTA_MAX_DATABASES', 3),
      maxSizeMb: num('QUOTA_MAX_SIZE_MB', 1024),
      maxConnections: num('QUOTA_MAX_CONNECTIONS', 20),
    },
    queryTimeoutS: num('QUERY_TIMEOUT_S', 30),
    pgHardBlockPercent: num('PG_HARD_BLOCK_PERCENT', 120),

    // Instance dev/stage berbagi engine: prefiks memisahkan nama fisik antar-instance, dan CI variable
    // dimatikan supaya tidak menimpa variable production di project GitLab yang sama
    tenantPrefix: tenantPrefix(process.env.TENANT_PREFIX ?? ''),
    ciVariablesEnabled: bool('CI_VARIABLES_ENABLED', true),
  }
}

export type Config = ReturnType<typeof loadConfig>

export function engineConfig(cfg: Config, name: EngineName): EngineConfig {
  const c = cfg.engines[name]
  if (!c) throw new Error(`engine ${name} tidak aktif (env ENGINES)`)
  return c
}
