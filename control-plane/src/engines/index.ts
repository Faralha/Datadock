import type { Config } from '../config.ts'
import type { EngineDriver, EngineName } from './types.ts'
import { createPostgresDriver } from './postgres.ts'
import { createMariadbDriver } from './mariadb.ts'
import { createMongoDriver } from './mongo.ts'

// Hanya engine yang diaktifkan (env ENGINES) yang punya driver
export type Engines = Partial<Record<EngineName, EngineDriver>>

const DRIVERS: Record<EngineName, (adminUrl: string) => EngineDriver> = {
  postgres: createPostgresDriver,
  mariadb: createMariadbDriver,
  mongo: createMongoDriver,
}

export function createEngines(cfg: Config): Engines {
  return Object.fromEntries(Object.entries(cfg.engines).map(([e, c]) => [e, DRIVERS[e as EngineName](c.adminUrl)]))
}

export function engineDriver(engines: Engines, name: EngineName): EngineDriver {
  const d = engines[name]
  if (!d) throw new Error(`engine ${name} tidak aktif (env ENGINES)`)
  return d
}

export async function closeEngines(e: Engines) {
  await Promise.allSettled(Object.values(e).map(d => d.close()))
}

export * from './types.ts'
