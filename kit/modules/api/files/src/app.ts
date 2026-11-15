// The API of {{kit.name}}. Pure: no listening, no process.env — src/index.ts boots it, tests call app.request().
// createApi() (locked kit runtime) brings the standard: trace id, request log, error shape, /health/*, /version,
// /openapi.json. This file only says what THIS app adds: its readiness checks and its resources under /api/v1.
import { readFileSync } from 'node:fs'
import type { Config } from './config.js'
import type { AppDatabase } from './db/index.js'
import { migrations as shippedMigrations } from './db/migrations/index.js'
import { createApi, mountV1 } from './kit/api/app.js'
import { createLogger, type Logger } from './kit/api/log.js'
import { databaseChecks } from './kit/db/checks.js'
import type { Migrations } from './kit/db/migrate.js'
import { registerItems } from './resources/items/items.routes.js'

export const SERVICE = '{{kit.name}}'
// package.json sits next to src/ and next to dist/, so this works under tsx, in tests and in the built image.
export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

export interface AppDeps {
  database: AppDatabase
  logger?: Logger
  /** What /health/ready compares the database with. Defaults to the migrations this build ships. */
  migrations?: Migrations
}

export const appLogger = (config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>, write?: (line: string) => void): Logger =>
  createLogger(config.LOG_LEVEL, write, { service: SERVICE, env: config.NODE_ENV })

export function createApp(config: Config, deps: AppDeps) {
  const logger = deps.logger ?? appLogger(config)
  const api = createApi({
    name: SERVICE,
    version: VERSION,
    logger,
    checks: databaseChecks(deps.database, deps.migrations ?? shippedMigrations),
    build: { commit: config.APP_COMMIT, builtAt: config.APP_BUILT_AT },
  })

  // Resources of the app. One register<Resource>() per resource, all under /api/v1.
  mountV1(api, (v1) => {
    registerItems(v1, { db: deps.database.db })
  })

  return api
}
