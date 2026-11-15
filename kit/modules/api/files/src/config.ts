// Env schema of {{kit.name}}. Validated once at boot (src/index.ts): a missing or invalid key stops the process and
// names the key. A key without `.default()` / `.optional()` is required. Keep .env.example in sync.
import { z } from 'zod'
import { loadEnv, redactEnv } from './kit/api/env.js'

const database = {
  DATABASE_URL: z.string().min(1),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  DB_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
}

const shape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  ...database,
  APP_COMMIT: z.string().optional(),
  APP_BUILT_AT: z.string().optional(),
}

/** Keys that hold secrets: masked in logs, no detail in config errors. DATABASE_URL may carry a password. */
export const SECRETS: readonly (keyof typeof shape)[] = ['DATABASE_URL']

export type Config = z.infer<z.ZodObject<typeof shape>>
export type DatabaseConfig = z.infer<z.ZodObject<typeof database>>

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  return loadEnv(shape, { source, secrets: SECRETS })
}

/** Only the database keys — what the db commands (src/db/cli.ts) need; they must not depend on PORT. */
export function loadDatabaseConfig(source: Record<string, string | undefined> = process.env): DatabaseConfig {
  return loadEnv(database, { source, secrets: ['DATABASE_URL'] })
}

/** The config with secrets masked — the only form that may be logged. */
export const describeConfig = (config: Config) => redactEnv(config, SECRETS)
