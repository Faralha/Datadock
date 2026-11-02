// Penjadwal job in-process (pengganti pg-boss karena metadata di SQLite). Jadwal terakhir disimpan di
// job_runs, jadi restart tidak membuat job harian terlewat atau berjalan dua kali.
import type { Db } from './db.ts'

export type Job = {
  name: string
  everyMinutes?: number
  dailyAtUtcHour?: number
  run: () => Promise<unknown>
}

export function createScheduler(db: Db, jobs: Job[], tickMs = 30_000) {
  const running = new Set<string>()
  let timer: Timer | undefined

  const lastStarted = (name: string) => {
    const r = db.query(`SELECT last_started_at FROM job_runs WHERE name = ?`).get(name) as { last_started_at: string | null } | null
    return r?.last_started_at ? new Date(r.last_started_at.replace(' ', 'T') + 'Z') : null
  }

  function isDue(job: Job, now: Date) {
    const last = lastStarted(job.name)
    if (job.everyMinutes) return !last || now.getTime() - last.getTime() >= job.everyMinutes * 60_000
    if (job.dailyAtUtcHour !== undefined) {
      const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), job.dailyAtUtcHour))
      return now >= slot && (!last || last < slot)
    }
    return false
  }

  async function runJob(job: Job) {
    if (running.has(job.name)) return { skipped: 'sedang berjalan' }
    running.add(job.name)
    db.query(`INSERT INTO job_runs (name, last_started_at) VALUES (?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET last_started_at = excluded.last_started_at`).run(job.name)
    try {
      const result = await job.run()
      db.query(`UPDATE job_runs SET last_finished_at = datetime('now'), last_status = 'ok', last_error = NULL WHERE name = ?`).run(job.name)
      return result
    } catch (e: any) {
      db.query(`UPDATE job_runs SET last_finished_at = datetime('now'), last_status = 'error', last_error = ? WHERE name = ?`)
        .run(String(e?.message ?? e), job.name)
      console.error(`job ${job.name} gagal:`, e)
      throw e
    } finally {
      running.delete(job.name)
    }
  }

  return {
    start() {
      const tick = () => {
        const now = new Date()
        for (const job of jobs) if (isDue(job, now)) runJob(job).catch(() => {})
      }
      tick()
      timer = setInterval(tick, tickMs)
    },
    stop() { clearInterval(timer) },
    async runNow(name: string) {
      const job = jobs.find(j => j.name === name)
      if (!job) throw new Error(`job tidak dikenal: ${name}`)
      return runJob(job)
    },
    status() {
      return jobs.map(j => ({ name: j.name, running: running.has(j.name),
        ...(db.query(`SELECT * FROM job_runs WHERE name = ?`).get(j.name) as object ?? {}) }))
    },
  }
}
export type Scheduler = ReturnType<typeof createScheduler>
