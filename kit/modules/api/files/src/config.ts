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
  // @kit:if notify
  // The notification hub (POST <url>/notify). Empty = notifications are off.
  NOTIFIER_URL: z.string().url().optional(),
  NOTIFIER_TOKEN: z.string().optional(),
  // @kit:end
  // @kit:if security
  CORS_ORIGINS: z.string().optional(),
  // Requests per window per client; 0 = off. The client is the TCP peer unless the request came through the trusted
  // reverse proxy (usage.md, "Security baseline").
  // @kit:if kind:fullstack
  // Off by default here: the peer of this API is the UI server, so without proxy trust every user would share one budget.
  RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(0),
  // @kit:else
  RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(300),
  // @kit:end
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1).default(1_048_576),
  // @kit:end
  // @kit:if auth
  // Forward-auth headers are believed only with one of these two (see usage.md, "Auth"). Neither = service tokens only.
  AUTH_PROXY_SECRET: z.string().min(16).optional(),
  AUTH_TRUSTED_PROXIES: z.string().optional(),
  AUTH_ROLE_MAP: z.string().optional(),
  AUTH_DEV_MODE: z.enum(['0', '1']).default('0'),
  // @kit:end
}

/** Keys that hold secrets: masked in logs, no detail in config errors. DATABASE_URL may carry a password. */
// @kit:if auth notify
export const SECRETS: readonly (keyof typeof shape)[] = ['DATABASE_URL', 'AUTH_PROXY_SECRET', 'NOTIFIER_TOKEN']
// @kit:end
// @kit:if auth !notify
export const SECRETS: readonly (keyof typeof shape)[] = ['DATABASE_URL', 'AUTH_PROXY_SECRET']
// @kit:end
// @kit:if !auth notify
export const SECRETS: readonly (keyof typeof shape)[] = ['DATABASE_URL', 'NOTIFIER_TOKEN']
// @kit:end
// @kit:if !auth !notify
export const SECRETS: readonly (keyof typeof shape)[] = ['DATABASE_URL']
// @kit:end

export type Config = z.infer<z.ZodObject<typeof shape>>
export type DatabaseConfig = z.infer<z.ZodObject<typeof database>>

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  return loadEnv(shape, { source, secrets: SECRETS })
}

/** Only the database keys — what the db commands (src/db/cli.ts) need; they must not depend on PORT. */
export function loadDatabaseConfig(source: Record<string, string | undefined> = process.env): DatabaseConfig {
  return loadEnv(database, { source, secrets: ['DATABASE_URL'] })
}

// @kit:if jobs
const jobShape = {
  ...database,
  NODE_ENV: shape.NODE_ENV,
  LOG_LEVEL: shape.LOG_LEVEL,
  // Lock files of running jobs — on a volume every instance shares (the default sits next to the SQLite file).
  JOB_LOCK_DIR: z.string().default('./data/locks'),
}
export type JobConfig = z.infer<z.ZodObject<typeof jobShape>>

/** What the job runner (src/jobs/run.ts) needs — like the db commands, it must not depend on PORT. */
export function loadJobConfig(source: Record<string, string | undefined> = process.env): JobConfig {
  return loadEnv(jobShape, { source, secrets: ['DATABASE_URL'] })
}

// @kit:end
/** The config with secrets masked — the only form that may be logged. */
export const describeConfig = (config: Config) => redactEnv(config, SECRETS)
