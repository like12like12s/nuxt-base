// DO NOT EDIT — locked file from the nuxt-base kit (runtime/api/env.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Env schema: validate process.env once at boot. A missing or invalid key stops the process with a message that names
// the key — and never contains a value, so a secret cannot leak into a log through a config error.
import { z } from 'zod'

export class EnvError extends Error {
  readonly keys: string[]
  constructor(problems: { key: string; problem: string }[]) {
    super(`Invalid environment — ${problems.map((p) => p.problem).join('; ')}`)
    this.name = 'EnvError'
    this.keys = problems.map((p) => p.key)
  }
}

export interface EnvOptions<K extends string = string> {
  /** Defaults to process.env. An empty string counts as "not set". */
  source?: Record<string, string | undefined>
  /** Keys whose values must never be shown (masked by redactEnv, no detail in errors). */
  secrets?: readonly K[]
}

export function loadEnv<S extends z.ZodRawShape>(shape: S, options: EnvOptions<keyof S & string> = {}): z.infer<z.ZodObject<S>> {
  const source = options.source ?? process.env
  const secrets = new Set<string>(options.secrets ?? [])
  const input: Record<string, string> = {}
  for (const key of Object.keys(shape)) {
    const value = source[key]
    if (value !== undefined && value !== '') input[key] = value
  }
  const parsed = z.object(shape).safeParse(input)
  if (parsed.success) return parsed.data
  const problems = new Map<string, string>()
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? '(root)')
    if (problems.has(key)) continue
    if (!(key in input)) problems.set(key, `missing ${key}`)
    // Zod messages describe the expectation, not the input — still, say nothing at all about a secret.
    else problems.set(key, secrets.has(key) ? `invalid ${key}` : `invalid ${key} (${issue.message})`)
  }
  throw new EnvError([...problems].map(([key, problem]) => ({ key, problem })))
}

/** Copy of the config that is safe to log: secret values replaced by "***". */
export function redactEnv<T extends Record<string, unknown>>(config: T, secrets: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) out[key] = secrets.includes(key) && value !== undefined ? '***' : value
  return out
}
