// DO NOT EDIT — locked file from the nuxt-base kit (runtime/api/log.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// One JSON object per line on stdout (pm2 / docker collect it as is), plus a request-log middleware for hono.
// Every line carries ts, level, msg, the base fields (service, env) and — inside a request — the trace id.
import type { MiddlewareHandler } from 'hono'
import { currentTraceId } from './context.js'

const LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LEVELS)[number]
export type LogFields = Record<string, unknown>
export type Logger = Record<LogLevel, (msg: string, fields?: LogFields) => void>

/** `base` = fields on every line; the API standard passes `{ service, env }`. */
export function createLogger(
  minLevel: LogLevel = 'info',
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
  base: LogFields = {},
): Logger {
  const min = LEVELS.indexOf(minLevel)
  const at = (level: LogLevel) => (msg: string, fields: LogFields = {}) => {
    if (LEVELS.indexOf(level) < min) return
    const traceId = currentTraceId()
    // The standard fields come last: a caller's `fields` can add to a line, never replace ts / level / msg / service /
    // env / traceId (a log pipeline keys on them, and `fields` may be built from request data).
    write(JSON.stringify({ ...fields, ts: new Date().toISOString(), level, msg, ...base, ...(traceId ? { traceId } : {}) }))
  }
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
}

/**
 * Message and stack of an error, safe to log. A database driver's message can quote row values (MySQL: "Duplicate
 * entry 'jane@example.com' for key …" — personal data): for driver errors the quoted values are masked and the error
 * code is put in front. Everything else is logged as it is.
 */
export function describeError(error: unknown): { error: string; stack?: string } {
  if (!(error instanceof Error)) return { error: String(error) }
  const e = error as Error & { code?: unknown; errno?: unknown; sqlMessage?: unknown }
  const driver = typeof e.sqlMessage === 'string' || typeof e.errno === 'number' || e.code === 'ERR_SQLITE_ERROR'
  if (!driver) return { error: error.message, stack: error.stack }
  const mask = (text: string) => text.replace(/'(?:[^'\\]|\\.)*'/g, "'?'").replace(/"(?:[^"\\]|\\.)*"/g, '"?"')
  const message = mask(error.message)
  // the first line of a stack repeats the message
  const stack = error.stack?.split('\n').filter((line) => /^\s+at /.test(line)).join('\n')
  return { error: typeof e.code === 'string' ? `${e.code}: ${message}` : message, stack: stack ? `${error.name}: ${message}\n${stack}` : undefined }
}

/** Logs one line per request: method, path (no query string — it may carry tokens), status, duration. */
export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now()
    try {
      await next()
    } finally {
      const status = c.res?.status ?? 500
      const fields = { method: c.req.method, path: c.req.path, status, ms: Math.round(performance.now() - start) }
      if (status >= 500) logger.error('request', fields)
      else logger.info('request', fields)
    }
  }
}
