// Env schema of {{kit.name}}. Validated once at boot (src/index.ts): a missing or invalid key stops the process and
// names the key. A key without `.default()` / `.optional()` is required. Keep .env.example in sync.
import { z } from 'zod'
import { loadEnv, redactEnv } from './kit/env.js'

const shape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
}

/** Keys that hold secrets: masked in logs, no detail in config errors. */
export const SECRETS: readonly (keyof typeof shape)[] = []

export type Config = z.infer<z.ZodObject<typeof shape>>

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  return loadEnv(shape, { source, secrets: SECRETS })
}

/** The config with secrets masked — the only form that may be logged. */
export const describeConfig = (config: Config) => redactEnv(config, SECRETS)
