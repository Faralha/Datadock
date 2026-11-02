import { loadConfig, type Config } from './config.ts'
import { openDb } from './db.ts'
import { createAudit } from './audit.ts'
import { makeCipher } from './crypto.ts'
import { createEngines, closeEngines, type Engines } from './engines/index.ts'
import { createGitlab, type Gitlab } from './gitlab.ts'
import { createAuthService } from './services/auth.ts'
import { createBackupService } from './services/backups.ts'
import { createDatabaseService } from './services/databases.ts'
import { createScheduler } from './scheduler.ts'
import { createCiVariableService } from './services/ci-variables.ts'
import { createConsoleService } from './services/console.ts'
import { createApp } from './app.ts'

// Dirakit di satu tempat supaya test bisa mengganti GitLab dengan versi palsu
export function buildContext(cfg: Config, overrides: { gitlab?: Gitlab; engines?: Engines } = {}) {
  const db = openDb(cfg.sqlitePath)
  const audit = createAudit(db)
  const cipher = makeCipher(cfg.encryptionKey)
  const engines = overrides.engines ?? createEngines(cfg)
  const gitlab = overrides.gitlab ?? createGitlab({ ...cfg.gitlab, redirectUri: `${cfg.publicUrl}/auth/callback` })
  const auth = createAuthService({ db, gitlab, audit, cfg })
  const backups = createBackupService({ db, cfg, audit })
  const ci = createCiVariableService({ db, gitlab, audit, cipher, cfg, engines })
  const databases = createDatabaseService({ db, engines, cipher, audit, cfg, backups, ci })
  const queryConsole = createConsoleService({ db, audit, cipher, cfg })
  const scheduler = createScheduler(db, [
    { name: 'sync-memberships', everyMinutes: 15, run: () => auth.syncMemberships() },
    { name: 'enforce-quotas', everyMinutes: 5, run: () => databases.enforceQuotas() },
    { name: 'backup-daily', dailyAtUtcHour: cfg.backup.hourUtc, run: () => backups.runDaily() },
    { name: 'backup-expire', everyMinutes: 60, run: () => backups.expire() },
    { name: 'purge-sessions', everyMinutes: 60, run: async () => auth.purgeExpired() },
    { name: 'retry-ci-variables', everyMinutes: 15, run: () => ci.retryFailed() },
  ])
  const app = createApp({ cfg, db, audit, engines, auth, databases, backups, scheduler, ci, console: queryConsole })
  return {
    cfg, db, audit, engines, gitlab, auth, backups, databases, ci, console: queryConsole, scheduler, app,
    async close() {
      scheduler.stop()
      if (app.server) await app.stop()
      await closeEngines(engines)
      db.close()
    },
  }
}

if (import.meta.main) {
  const ctx = buildContext(loadConfig())
  ctx.app.listen(ctx.cfg.port)
  ctx.scheduler.start()
  console.log(`datadock control plane di ${ctx.cfg.publicUrl} (port ${ctx.cfg.port})`)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      await ctx.close()
      process.exit(0)
    })
  }
}
