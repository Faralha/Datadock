// Login GitLab (FR-01, FR-02), sesi cookie, dan sinkron anggota (FR-03..05)
import type { Db } from '../db.ts'
import { sqlTime } from '../db.ts'
import type { Gitlab, Role } from '../gitlab.ts'
import { roleFromAccess } from '../gitlab.ts'
import type { Audit } from '../audit.ts'
import { randomToken, sha256 } from '../crypto.ts'
import type { Config } from '../config.ts'

export type SessionUser = { id: number; username: string; name: string; isAdmin: boolean }

const STATE_TTL_MIN = 10

export function createAuthService(deps: { db: Db; gitlab: Gitlab; audit: Audit; cfg: Config }) {
  const { db, gitlab, audit, cfg } = deps

  const upsertProject = db.prepare(`INSERT INTO projects (id, path, name) VALUES ($id, $path, $name)
    ON CONFLICT(id) DO UPDATE SET path = excluded.path, name = excluded.name`)
  const ensureQuota = db.prepare(`INSERT OR IGNORE INTO quotas (project_id, max_databases, max_size_mb, max_connections)
    VALUES ($projectId, $maxDatabases, $maxSizeMb, $maxConnections)`)
  const upsertMembership = db.prepare(`INSERT INTO memberships (user_id, project_id, role, last_synced_at)
    VALUES ($userId, $projectId, $role, datetime('now'))
    ON CONFLICT(user_id, project_id) DO UPDATE SET role = excluded.role, last_synced_at = excluded.last_synced_at`)

  function saveProject(p: { id: number; path_with_namespace: string; name: string }) {
    upsertProject.run({ id: p.id, path: p.path_with_namespace, name: p.name })
    ensureQuota.run({ projectId: p.id, ...cfg.quotaDefaults })
  }

  return {
    startLogin() {
      const { url, state, verifier } = gitlab.authorizeUrl()
      db.query(`DELETE FROM oauth_states WHERE created_at < datetime('now', '-${STATE_TTL_MIN} minutes')`).run()
      db.query(`INSERT INTO oauth_states (state, code_verifier) VALUES (?, ?)`).run(state, verifier)
      return url
    },

    async finishLogin(code: string, state: string, ip: string | null) {
      const row = db.query(`DELETE FROM oauth_states WHERE state = ? AND created_at >= datetime('now', '-${STATE_TTL_MIN} minutes')
        RETURNING code_verifier`).get(state) as { code_verifier: string } | null
      if (!row) throw new Error('state OAuth tidak valid atau kedaluwarsa')

      const token = await gitlab.exchangeCode(code, row.code_verifier)
      const gu = await gitlab.currentUser(token)
      if (gu.state && gu.state !== 'active') throw new Error(`akun GitLab tidak aktif (${gu.state})`)

      const isAdmin = cfg.adminUsernames.includes(gu.username)
        || (cfg.adminGroup ? await gitlab.isGroupMember(token, cfg.adminGroup, gu.id) : false)
      const projects = await gitlab.userProjects(token)

      db.transaction(() => {
        db.query(`INSERT INTO users (id, username, name, is_admin, last_login_at) VALUES ($id, $username, $name, $isAdmin, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET username = excluded.username, name = excluded.name,
            is_admin = excluded.is_admin, last_login_at = excluded.last_login_at`)
          .run({ id: gu.id, username: gu.username, name: gu.name, isAdmin: isAdmin ? 1 : 0 })
        for (const { project, role } of projects) {
          saveProject(project)
          upsertMembership.run({ userId: gu.id, projectId: project.id, role })
        }
        // Akses yang hilang di GitLab langsung hilang saat login (FR-05)
        const keep = projects.map(p => p.project.id)
        db.query(`DELETE FROM memberships WHERE user_id = ? AND project_id NOT IN (SELECT value FROM json_each(?))`)
          .run(gu.id, JSON.stringify(keep))
      })()

      const sessionToken = randomToken(32)
      const expires = new Date(Date.now() + cfg.sessionTtlHours * 3600_000)
      db.query(`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)`).run(sha256(sessionToken), gu.id, sqlTime(expires))

      const user: SessionUser = { id: gu.id, username: gu.username, name: gu.name, isAdmin }
      audit.log({ actor: user, action: 'auth.login', result: 'ok', ip, detail: { projects: projects.length, isAdmin } })
      return { sessionToken, expires, user }
    },

    sessionUser(token: string | undefined): SessionUser | null {
      if (!token) return null
      const r = db.query(`SELECT u.id, u.username, u.name, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = ? AND s.expires_at > datetime('now')`).get(sha256(token)) as any
      return r ? { id: r.id, username: r.username, name: r.name, isAdmin: !!r.is_admin } : null
    },

    logout(token: string | undefined) {
      if (token) db.query(`DELETE FROM sessions WHERE id_hash = ?`).run(sha256(token))
    },

    purgeExpired() {
      db.query(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run()
      db.query(`DELETE FROM oauth_states WHERE created_at < datetime('now', '-${STATE_TTL_MIN} minutes')`).run()
    },

    roleIn(userId: number, projectId: number): Role | null {
      const r = db.query(`SELECT role FROM memberships WHERE user_id = ? AND project_id = ?`).get(userId, projectId) as { role: Role } | null
      return r?.role ?? null
    },

    // Job berkala tiap 15 menit dengan token bot (FR-04, FR-05, OT-2)
    async syncMemberships() {
      const projects = db.query(`SELECT DISTINCT project_id AS id FROM memberships
        UNION SELECT DISTINCT project_id FROM databases WHERE status NOT IN ('deleted', 'failed')`).all() as { id: number }[]
      const knownUsers = new Set((db.query(`SELECT id FROM users`).all() as { id: number }[]).map(u => u.id))
      let changed = 0, failed = 0
      for (const { id } of projects) {
        try {
          const project = await gitlab.project(id)
          if (!project) {
            changed += db.query(`DELETE FROM memberships WHERE project_id = ?`).run(id).changes
            continue
          }
          const members = await gitlab.projectMembers(id)
          db.transaction(() => {
            saveProject(project)
            const roles = new Map<number, Role>()
            for (const m of members) {
              const role = m.state === 'blocked' ? null : roleFromAccess(m.access_level)
              if (role && knownUsers.has(m.id)) roles.set(m.id, role)
            }
            const current = db.query(`SELECT user_id, role FROM memberships WHERE project_id = ?`).all(id) as { user_id: number; role: Role }[]
            for (const c of current) {
              if (!roles.has(c.user_id)) {
                db.query(`DELETE FROM memberships WHERE user_id = ? AND project_id = ?`).run(c.user_id, id)
                changed++
              }
            }
            for (const [userId, role] of roles) {
              if (current.find(c => c.user_id === userId)?.role !== role) changed++
              upsertMembership.run({ userId, projectId: id, role })
            }
          })()
        } catch (e: any) {
          failed++
          audit.log({ actor: null, action: 'sync.memberships', target: `project:${id}`, projectId: id, result: 'error', detail: { error: e.message } })
        }
      }
      return { projects: projects.length, changed, failed }
    },
  }
}
export type AuthService = ReturnType<typeof createAuthService>
