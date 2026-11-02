// Audit log append-only (FR-28): siapa, apa, kapan, dari IP mana, hasilnya
import type { Db } from './db.ts'

export type Actor = { id: number; username: string } | null
export type AuditEntry = {
  actor: Actor
  action: string
  target?: string
  projectId?: number
  result: 'ok' | 'error' | 'denied'
  ip?: string | null
  detail?: Record<string, unknown>
}

export function createAudit(db: Db) {
  const insert = db.prepare(`INSERT INTO audit_events (actor_id, actor_username, action, target, project_id, result, ip, detail)
    VALUES ($actorId, $actorUsername, $action, $target, $projectId, $result, $ip, $detail)`)
  return {
    log(e: AuditEntry) {
      insert.run({
        actorId: e.actor?.id ?? null,
        actorUsername: e.actor?.username ?? 'system',
        action: e.action,
        target: e.target ?? null,
        projectId: e.projectId ?? null,
        result: e.result,
        ip: e.ip ?? null,
        detail: e.detail ? JSON.stringify(e.detail) : null,
      })
    },
    list(opts: { projectId?: number; beforeId?: number; limit?: number } = {}) {
      const limit = Math.min(opts.limit ?? 100, 500)
      return db.query(`SELECT * FROM audit_events
        WHERE ($projectId IS NULL OR project_id = $projectId) AND ($beforeId IS NULL OR id < $beforeId)
        ORDER BY id DESC LIMIT $limit`).all({
        projectId: opts.projectId ?? null, beforeId: opts.beforeId ?? null, limit,
      })
    },
  }
}
export type Audit = ReturnType<typeof createAudit>
