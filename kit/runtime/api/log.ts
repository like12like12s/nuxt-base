// DO NOT EDIT — locked file from the nuxt-base kit (runtime/api/log.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// One JSON object per line on stdout (pm2 / docker collect it as is), plus a request-log middleware for hono.
import type { MiddlewareHandler } from 'hono'

const LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LEVELS)[number]
export type LogFields = Record<string, unknown>
export type Logger = Record<LogLevel, (msg: string, fields?: LogFields) => void>

export function createLogger(minLevel: LogLevel = 'info', write: (line: string) => void = (line) => process.stdout.write(line + '\n')): Logger {
  const min = LEVELS.indexOf(minLevel)
  const at = (level: LogLevel) => (msg: string, fields: LogFields = {}) => {
    if (LEVELS.indexOf(level) < min) return
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }))
  }
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
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
