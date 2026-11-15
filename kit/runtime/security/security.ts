// DO NOT EDIT — locked file from the nuxt-base kit (runtime/security/security.ts). Its hash is recorded in
// .scaffold.json; `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// The baseline every API gets, as one list of middleware for createApi({ middleware: security({...}) }):
//   secure headers   nosniff, no framing, no referrer, HSTS, a CSP that allows nothing (this is an API, not a page)
//   CORS             an allowlist of exact origins, with credentials — so `*` is refused when the config is read.
//                    No origins configured = no CORS headers at all (same-origin callers only).
//   body limit       413 before a large body is read
//   rate limit       a fixed window per client (the TCP peer), 429 + retry-after. Basic on purpose: it lives in this
//                    process (not shared between instances) and is a backstop, not a replacement for limits at the edge.
// Every refusal uses the API's error shape (VALIDATION for 413, RATE_LIMITED for 429).
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import { ApiError, rateLimited } from '../api/errors.js'

export class SecurityConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecurityConfigError'
  }
}

/**
 * CORS_ORIGINS: comma-separated exact origins (`https://app.example.com, http://localhost:3000`).
 * `*` and `null` are refused: the API answers with credentials allowed, and a wildcard with credentials hands every
 * site on the internet the user's session.
 */
export function parseOrigins(value: string | undefined): string[] {
  const origins: string[] = []
  for (const raw of (value ?? '').split(',')) {
    const entry = raw.trim()
    if (!entry) continue
    if (entry === '*' || entry.includes('*')) throw new SecurityConfigError('CORS_ORIGINS: wildcards are not allowed (the API allows credentials) — list the exact origins')
    let url: URL
    try {
      url = new URL(entry)
    } catch {
      throw new SecurityConfigError(`CORS_ORIGINS: "${entry}" is not an origin (expected scheme://host[:port])`)
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== entry.replace(/\/$/, '')) {
      throw new SecurityConfigError(`CORS_ORIGINS: "${entry}" is not an origin (expected scheme://host[:port], no path)`)
    }
    if (!origins.includes(url.origin)) origins.push(url.origin)
  }
  return origins
}

export interface RateLimitOptions {
  /** Requests per window per client. */
  max: number
  windowMs: number
  /** Which client a request counts against. Default: the TCP peer (never a header a client can set). */
  key?: (c: Context) => string
  /** Paths that never count (default: /health/* — a probe must not be throttled, nor eat the budget). */
  skip?: (c: Context) => boolean
  now?: () => number
  /** Upper bound of tracked clients; beyond it the oldest windows are dropped (default 10 000). */
  maxKeys?: number
}

const peer = (c: Context): string => (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? 'unknown'

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const { max, windowMs, key = peer, skip = (c) => c.req.path.startsWith('/health/'), now = Date.now, maxKeys = 10_000 } = options
  if (!(max > 0) || !(windowMs > 0)) throw new SecurityConfigError('rate limit: max and windowMs must be positive')
  const windows = new Map<string, { count: number; resetAt: number }>()
  return async (c, next) => {
    if (skip(c)) return next()
    const at = now()
    const id = key(c)
    let window = windows.get(id)
    if (!window || window.resetAt <= at) {
      if (windows.size >= maxKeys) {
        for (const [k, w] of windows) if (w.resetAt <= at) windows.delete(k)
        // Still full of live windows: drop the oldest insertions rather than grow without bound.
        for (const k of windows.keys()) {
          if (windows.size < maxKeys) break
          windows.delete(k)
        }
      }
      window = { count: 0, resetAt: at + windowMs }
      windows.delete(id)
      windows.set(id, window)
    }
    window.count++
    const seconds = Math.max(1, Math.ceil((window.resetAt - at) / 1000))
    c.header('ratelimit-limit', String(max))
    c.header('ratelimit-remaining', String(Math.max(0, max - window.count)))
    c.header('ratelimit-reset', String(seconds))
    if (window.count > max) {
      c.header('retry-after', String(seconds))
      throw rateLimited()
    }
    return next()
  }
}

/**
 * CORS for an allowlist. The origin is echoed (with credentials) only when it is on the list; any other origin gets
 * no CORS header at all, so the browser refuses to hand the answer to the page that asked.
 */
function corsAllowlist(allowed: ReadonlySet<string>): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin')
    const ok = origin !== undefined && allowed.has(origin)
    c.header('vary', 'Origin', { append: true }) // a cache must not serve one origin's answer to another
    if (ok) {
      c.header('access-control-allow-origin', origin)
      c.header('access-control-allow-credentials', 'true')
      c.header('access-control-expose-headers', 'x-trace-id, retry-after')
    }
    if (c.req.method === 'OPTIONS' && c.req.header('access-control-request-method')) {
      if (ok) {
        c.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        c.header('access-control-allow-headers', c.req.header('access-control-request-headers') ?? 'content-type, authorization')
        c.header('access-control-max-age', '600')
      }
      return c.body(null, 204)
    }
    return next()
  }
}

export interface SecurityOptions {
  /** From parseOrigins(). Empty = no CORS headers. */
  corsOrigins: readonly string[]
  /** null = no rate limit in this process. */
  rateLimit: RateLimitOptions | null
  bodyLimitBytes: number
}

export function security(options: SecurityOptions): MiddlewareHandler[] {
  const allowed = new Set(options.corsOrigins)
  if ([...allowed].some((origin) => origin.includes('*'))) throw new SecurityConfigError('CORS: wildcards are not allowed with credentials')
  const list: MiddlewareHandler[] = [
    secureHeaders({
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
      strictTransportSecurity: 'max-age=15552000; includeSubDomains',
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    }),
  ]
  if (allowed.size) list.push(corsAllowlist(allowed))
  if (options.rateLimit) list.push(rateLimit(options.rateLimit))
  list.push(
    bodyLimit({
      maxSize: options.bodyLimitBytes,
      onError: () => {
        throw new ApiError('VALIDATION', `Request body too large (limit ${options.bodyLimitBytes} bytes)`, { status: 413 })
      },
    }),
  )
  return list
}
