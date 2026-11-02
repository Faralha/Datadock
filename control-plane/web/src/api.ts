// Klien API: same-origin, cookie sesi dikirim otomatis, error server jadi ApiError
export class ApiError extends Error {
  constructor(public status: number, message: string, public data: Record<string, unknown> = {}) { super(message) }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = { error: text } }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`, data ?? {})
  return data as T
}

export type Role = 'developer' | 'maintainer'
export type Engine = 'postgres' | 'mariadb' | 'mongo'
// /health hanya memuat engine yang diaktifkan di server (env ENGINES)
export type Health = { ok: boolean; engines: Partial<Record<Engine, 'up' | 'down'>> }
export const healthQuery = {
  queryKey: ['health'] as const,
  queryFn: async () => (await fetch('/health')).json() as Promise<Health>,
  retry: false,
}
export type Me = { user: { id: number; username: string; name: string; isAdmin: boolean }; projects: { id: number; path: string; name: string; role: Role }[] }
export type DatabaseInfo = {
  id: string; projectId: number; engine: Engine; environment: string; name: string
  status: 'provisioning' | 'ready' | 'read_only' | 'blocked' | 'deleting'
  sizeBytes: number | null; sizeCheckedAt: string | null; createdAt: string
  connection: { host: string; port: number; database: string; user: string; passwordRotatedAt: string; connectionString: string } | null
}
// GET /api/projects: ringkasan semua project user dalam satu request
export type ProjectSummary = {
  id: number; path: string; name: string; role: Role
  databases: number; maxDatabases: number; sizeBytes: number; limited: number; engines: Engine[]
}
export type ProjectDetail = {
  project: { id: number; path: string; name: string }; role: Role
  quota: { maxDatabases: number; maxSizeMb: number; maxConnections: number }
  usage: { databases: number; sizeBytes: number }
  databases: DatabaseInfo[]
}

export const ENGINE_LABEL: Record<Engine, string> = { postgres: 'PostgreSQL', mariadb: 'MariaDB', mongo: 'MongoDB' }

export function formatBytes(n: number | string | null | undefined) {
  if (n === null || n === undefined) return '—'
  let v = Number(n)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

// Waktu dari server dalam UTC ("YYYY-MM-DD HH:MM:SS" atau ISO); ditampilkan dalam zona lokal
export function formatTime(s: string | null | undefined) {
  if (!s) return '—'
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
  return d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
}
