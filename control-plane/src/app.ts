// HTTP API control plane (Elysia). Role platform diturunkan dari access level GitLab (Kebijakan: pemetaan role).
import { Elysia } from 'elysia'
import { join, resolve, sep } from 'node:path'
import type { Config } from './config.ts'
import type { Db } from './db.ts'
import type { Audit } from './audit.ts'
import type { Engines } from './engines/index.ts'
import type { AuthService, SessionUser } from './services/auth.ts'
import type { DatabaseService, DatabaseRow } from './services/databases.ts'
import { HttpError } from './services/databases.ts'
import type { BackupService } from './services/backups.ts'
import type { Scheduler } from './scheduler.ts'
import type { Role } from './gitlab.ts'
import type { CiVariableService } from './services/ci-variables.ts'
import type { ConsoleService } from './services/console.ts'

export type AppDeps = {
  cfg: Config; db: Db; audit: Audit; engines: Engines; auth: AuthService
  databases: DatabaseService; backups: BackupService; scheduler: Scheduler
  ci: CiVariableService; console: ConsoleService
}

const COOKIE = 'dd_session'
const WEB_DIR = resolve(import.meta.dir, '../web/dist')
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
}
const RANK: Record<Role, number> = { developer: 1, maintainer: 2 }

export function createApp(deps: AppDeps) {
  const { cfg, db, audit, engines, auth, databases, backups, scheduler, ci, console: queryConsole } = deps
  const origin = new URL(cfg.publicUrl).origin

  const clientIp = (request: Request, server: any) =>
    (cfg.trustProxy ? request.headers.get('x-forwarded-for')?.split(',')[0].trim() : undefined)
      ?? server?.requestIP?.(request)?.address ?? null

  // Admin platform diperlakukan setara Maintainer di semua project
  function requireRole(user: SessionUser | null, projectId: number, min: Role, ip: string | null, action?: string): Role {
    if (!user) throw new HttpError(401, 'belum login')
    if (user.isAdmin) {
      if (!db.query(`SELECT 1 FROM projects WHERE id = ?`).get(projectId)) throw new HttpError(404, 'project tidak ditemukan')
      return 'maintainer'
    }
    const role = auth.roleIn(user.id, projectId)
    if (!role) throw new HttpError(404, 'project tidak ditemukan')
    if (RANK[role] < RANK[min]) {
      if (action) audit.log({ actor: user, action, target: `project:${projectId}`, projectId, result: 'denied', ip, detail: { role, required: min } })
      throw new HttpError(403, `butuh role ${min} (role kamu: ${role})`)
    }
    return role
  }

  function loadDatabase(id: string): DatabaseRow {
    const row = databases.get(id)
    if (!row || row.status === 'deleted' || row.status === 'failed') throw new HttpError(404, 'database tidak ditemukan')
    return row
  }

  function requireAdmin(user: SessionUser | null) {
    if (!user) throw new HttpError(401, 'belum login')
    if (!user.isAdmin) throw new HttpError(403, 'khusus admin platform')
    return user
  }

  // Project yang terlihat user (admin: semua project, setara Maintainer bila bukan anggota)
  function userProjects(user: SessionUser) {
    return (user.isAdmin
      ? db.query(`SELECT p.id, p.path, p.name, COALESCE(m.role, 'maintainer') AS role FROM projects p
          LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = ? ORDER BY p.path`).all(user.id)
      : db.query(`SELECT p.id, p.path, p.name, m.role FROM memberships m JOIN projects p ON p.id = m.project_id
          WHERE m.user_id = ? ORDER BY p.path`).all(user.id)) as { id: number; path: string; name: string; role: Role }[]
  }

  const projectId = (s: string) => {
    const n = Number(s)
    if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, 'id project tidak valid')
    return n
  }

  return new Elysia()
    .onRequest(({ set }) => { Object.assign(set.headers, SECURITY_HEADERS) })
    .error({ HttpError })
    .onError(({ code, error, set }) => {
      if (error instanceof HttpError) {
        set.status = error.status
        return { error: error.message, ...error.extra }
      }
      if (code === 'NOT_FOUND') { set.status = 404; return { error: 'tidak ditemukan' } }
      if (code === 'PARSE' || code === 'VALIDATION') { set.status = 400; return { error: 'request tidak valid' } }
      console.error(error)
      set.status = 500
      return { error: 'kesalahan internal' }
    })
    // CSRF: request yang mengubah state wajib dari origin web UI sendiri
    .onBeforeHandle(({ request }) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
      if (request.headers.get('origin') !== origin) throw new HttpError(403, 'origin tidak diizinkan')
    })
    .derive(({ cookie, request, server }) => ({
      user: auth.sessionUser(cookie[COOKIE]?.value as string | undefined),
      ip: clientIp(request, server),
    }))

    .get('/health', async ({ set }) => {
      const results = await Promise.all(Object.values(engines).map(async e => {
        try {
          await Promise.race([e.ping(), Bun.sleep(2000).then(() => { throw new Error('timeout') })])
          return [e.engine, 'up'] as const
        } catch {
          return [e.engine, 'down'] as const
        }
      }))
      const ok = results.every(([, s]) => s === 'up')
      if (!ok) set.status = 503
      return { ok, engines: Object.fromEntries(results) }
    })

    // --- Auth (FR-01)
    .get('/auth/login', ({ redirect }) => redirect(auth.startLogin(), 302))
    .get('/auth/callback', async ({ query, cookie, ip, redirect, set }) => {
      try {
        const { sessionToken, expires } = await auth.finishLogin(String(query.code ?? ''), String(query.state ?? ''), ip)
        cookie[COOKIE].set({ value: sessionToken, httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax', path: '/', expires })
        return redirect('/', 302)
      } catch (e: any) {
        audit.log({ actor: null, action: 'auth.login', result: 'error', ip, detail: { error: e.message } })
        set.status = 400
        return { error: `login gagal: ${e.message}` }
      }
    })
    .post('/auth/logout', ({ cookie, user, ip }) => {
      auth.logout(cookie[COOKIE]?.value as string | undefined)
      cookie[COOKIE].remove()
      if (user) audit.log({ actor: user, action: 'auth.logout', result: 'ok', ip })
      return { ok: true }
    })

    // --- Project dan database
    .get('/api/me', ({ user }) => {
      if (!user) throw new HttpError(401, 'belum login')
      return { user, projects: userProjects(user) }
    })
    // Ringkasan semua project user untuk dashboard: satu request, bukan satu per project
    .get('/api/projects', ({ user }) => {
      if (!user) throw new HttpError(401, 'belum login')
      return { projects: databases.summaries(userProjects(user)) }
    })
    .get('/api/projects/:pid', ({ params, user, ip }) => {
      const pid = projectId(params.pid)
      const role = requireRole(user, pid, 'developer', ip)
      const project = db.query(`SELECT id, path, name FROM projects WHERE id = ?`).get(pid)
      const q = databases.quotaOf(pid)!
      const u = databases.usage(pid)
      return {
        project, role,
        quota: { maxDatabases: q.max_databases, maxSizeMb: q.max_size_mb, maxConnections: q.max_connections },
        usage: { databases: u.count, sizeBytes: u.size },
        databases: databases.list(pid),
      }
    })
    .post('/api/projects/:pid/databases', async ({ params, body, user, ip, set }) => {
      const pid = projectId(params.pid)
      requireRole(user, pid, 'developer', ip, 'database.create')
      const b = (body ?? {}) as { engine?: string; environment?: string; name?: string }
      const created = await databases.create(user, pid, { engine: b.engine ?? '', environment: b.environment ?? '', name: b.name ?? '' }, ip)
      set.status = 201
      return created
    })
    .get('/api/databases/:id', ({ params, user, ip }) => {
      const row = loadDatabase(params.id)
      const role = requireRole(user, row.project_id, 'developer', ip)
      const project = db.query(`SELECT id, path, name FROM projects WHERE id = ?`).get(row.project_id)
      return { ...databases.publicInfo(row), role, project }
    })
    .post('/api/databases/:id/password/reveal', ({ params, user, ip }) => {
      const row = loadDatabase(params.id)
      requireRole(user, row.project_id, 'developer', ip, 'credential.reveal')
      return databases.revealPassword(user, row, ip)
    })
    .post('/api/databases/:id/password/rotate', ({ params, user, ip }) => {
      const row = loadDatabase(params.id)
      requireRole(user, row.project_id, 'maintainer', ip, 'credential.rotate')
      return databases.rotatePassword(user, row, ip)
    })
    .delete('/api/databases/:id', async ({ params, body, user, ip }) => {
      const row = loadDatabase(params.id)
      requireRole(user, row.project_id, 'maintainer', ip, 'database.delete')
      await databases.remove(user, row, String((body as any)?.confirm ?? ''), ip)
      return { ok: true }
    })
    .get('/api/databases/:id/backups', ({ params, user, ip }) => {
      const row = loadDatabase(params.id)
      requireRole(user, row.project_id, 'developer', ip)
      return backups.list(row.id)
    })
    .get('/api/databases/:id/ci-variables', ({ params, user, ip }) => {
      const row = loadDatabase(params.id)
      requireRole(user, row.project_id, 'developer', ip)
      return ci.list(row.id)
    })
    .post('/api/databases/:id/ci-variables/sync', async ({ params, user, ip }) => {
      const row = loadDatabase(params.id)
      requireRole(user, row.project_id, 'maintainer', ip, 'ci.sync')
      audit.log({ actor: user, action: 'ci.sync.request', target: `database:${row.id}`, projectId: row.project_id, result: 'ok', ip })
      return ci.sync(row)
    })

    // --- Console (FR-16..19): semua anggota read-write, memakai user database project
    .post('/api/databases/:id/console', ({ params, body, user, ip }) => {
      const row = loadDatabase(params.id)
      requireRole(user, row.project_id, 'developer', ip, 'console.query')
      return queryConsole.run(user, row, (body ?? {}) as any, ip)
    })
    .get('/api/databases/:id/schema', ({ params, user, ip }) => {
      const row = loadDatabase(params.id)
      requireRole(user, row.project_id, 'developer', ip)
      return queryConsole.schema(row)
    })

    // --- Admin platform
    .get('/api/admin/projects', ({ user }) => {
      requireAdmin(user)
      return db.query(`SELECT p.id, p.path, p.name, q.max_databases, q.max_size_mb, q.max_connections,
          (SELECT COUNT(*) FROM databases d WHERE d.project_id = p.id AND d.status NOT IN ('deleted', 'failed')) AS databases,
          (SELECT COALESCE(SUM(size_bytes), 0) FROM databases d WHERE d.project_id = p.id AND d.status NOT IN ('deleted', 'failed')) AS size_bytes
        FROM projects p JOIN quotas q ON q.project_id = p.id ORDER BY p.path`).all()
    })
    .put('/api/admin/projects/:pid/quota', ({ params, body, user, ip }) => {
      const admin = requireAdmin(user)
      const b = (body ?? {}) as Record<string, unknown>
      return databases.setQuota(admin, projectId(params.pid),
        { maxDatabases: Number(b.maxDatabases), maxSizeMb: Number(b.maxSizeMb), maxConnections: Number(b.maxConnections) }, ip)
    })
    .get('/api/admin/audit', ({ query, user }) => {
      requireAdmin(user)
      return audit.list({
        projectId: query.project ? projectId(String(query.project)) : undefined,
        beforeId: query.before ? Number(query.before) : undefined,
        limit: query.limit ? Number(query.limit) : undefined,
      })
    })
    .get('/api/admin/jobs', ({ user }) => {
      requireAdmin(user)
      return scheduler.status()
    })
    .post('/api/admin/jobs/:name/run', async ({ params, user, ip }) => {
      const admin = requireAdmin(user)
      try {
        const result = await scheduler.runNow(params.name)
        audit.log({ actor: admin, action: 'job.run', target: `job:${params.name}`, result: 'ok', ip })
        return { ok: true, result }
      } catch (e: any) {
        audit.log({ actor: admin, action: 'job.run', target: `job:${params.name}`, result: 'error', ip, detail: { error: e.message } })
        throw new HttpError(500, `job gagal: ${e.message}`)
      }
    })

    // --- Web UI (hasil `bun run build:web`); path lain jatuh ke index.html untuk routing sisi klien
    .get('/*', async ({ request, set }) => {
      const path = decodeURIComponent(new URL(request.url).pathname)
      if (path.startsWith('/api/') || path.startsWith('/auth/')) throw new HttpError(404, 'tidak ditemukan')
      const file = resolve(WEB_DIR, '.' + path)
      if (file.startsWith(WEB_DIR + sep) && !path.endsWith('/')) {
        const f = Bun.file(file)
        if (await f.exists()) {
          // Aset Vite punya hash di nama file, aman di-cache lama
          set.headers['cache-control'] = path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
          return f
        }
      }
      const index = Bun.file(join(WEB_DIR, 'index.html'))
      if (!(await index.exists())) throw new HttpError(404, 'web UI belum dibangun (bun run build:web)')
      set.headers['cache-control'] = 'no-cache'
      set.headers['content-type'] = 'text/html; charset=utf-8'
      return index
    })
}
