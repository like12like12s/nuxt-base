// @vitest-environment node
// The locked security baseline (kit/runtime/security/**) at the source.
import { describe, expect, it } from 'vitest'
import { createApi } from '../runtime/api/app'
import { createLogger } from '../runtime/api/log'
import { SecurityConfigError, parseOrigins, rateLimit, security, type SecurityOptions } from '../runtime/security/security'
import { testClient } from '../runtime/testing/client'

function app(options: Partial<SecurityOptions> = {}, extra: Parameters<typeof createApi>[0]['middleware'] = []) {
  const lines: Record<string, any>[] = []
  const logger = createLogger('info', (line) => lines.push(JSON.parse(line)), { service: 'svc', env: 'test' })
  const api = createApi({ name: 'svc', version: '1.0.0', logger, middleware: [...security({ corsOrigins: [], rateLimit: null, bodyLimitBytes: 1024, ...options }), ...extra] })
  api.get('/api/v1/things', (c) => c.json({ data: [] }))
  api.post('/api/v1/things', async (c) => c.json({ data: await c.req.json() }, 201))
  return { api: testClient(api), lines }
}

describe('createApi middleware slots', () => {
  it('`middleware` runs inside the request scope and in front of every route, system routes included', async () => {
    const seen: string[] = []
    const { api, lines } = app({}, [async (c, next) => { seen.push(c.req.path); c.header('x-probe', 'yes'); await next() }])
    for (const path of ['/health/live', '/version', '/openapi.json', '/api/v1/things', '/nope']) expect((await api.get(path)).headers.get('x-probe'), path).toBe('yes')
    expect(seen).toEqual(['/health/live', '/version', '/openapi.json', '/api/v1/things', '/nope'])
    expect(lines.filter((l) => l.msg === 'request')).toHaveLength(5) // still one log line per request
  })

  it('`before` wraps the request scope: it runs first and sees the final response', async () => {
    const order: string[] = []
    const logger = createLogger('error', () => undefined)
    const api = createApi({
      name: 'svc', version: '1', logger,
      before: [async (c, next) => { order.push('before'); await next(); order.push(`after ${c.res.status} ${c.res.headers.get('x-trace-id') ? 'traced' : 'untraced'}`) }],
      middleware: [async (_c, next) => { order.push('middleware'); await next() }],
    })
    await testClient(api).get('/health/live')
    expect(order).toEqual(['before', 'middleware', 'after 200 traced'])
  })
})

describe('secure headers', () => {
  it('are on every response: 200, 404 and system routes', async () => {
    const { api } = app()
    for (const path of ['/api/v1/things', '/nope', '/health/live', '/openapi.json']) {
      const h = (await api.get(path)).headers
      expect([h.get('x-content-type-options'), h.get('x-frame-options'), h.get('referrer-policy')], path).toEqual(['nosniff', 'DENY', 'no-referrer'])
      expect(h.get('strict-transport-security'), path).toBe('max-age=15552000; includeSubDomains')
      expect(h.get('content-security-policy'), path).toBe("default-src 'none'; frame-ancestors 'none'")
      expect(h.get('x-powered-by'), path).toBeNull()
    }
  })
})

describe('CORS allowlist', () => {
  it('parseOrigins: exact origins only — wildcards, paths and non-http schemes are config errors', () => {
    expect(parseOrigins(undefined)).toEqual([])
    expect(parseOrigins(' https://app.example.com , http://localhost:3000/, https://app.example.com')).toEqual(['https://app.example.com', 'http://localhost:3000'])
    for (const bad of ['*', 'https://*.example.com', 'app.example.com', 'https://app.example.com/path', 'ftp://app.example.com', 'null']) {
      expect(() => parseOrigins(bad), bad).toThrow(SecurityConfigError)
    }
    expect(() => security({ corsOrigins: ['*'], rateLimit: null, bodyLimitBytes: 1 })).toThrow(/wildcards/)
  })

  it('an allowed origin is echoed with credentials; a preflight is answered; others get no CORS header', async () => {
    const { api } = app({ corsOrigins: ['https://app.example.com'] })
    const ok = await api.get('/api/v1/things', { headers: { origin: 'https://app.example.com' } })
    expect([ok.headers.get('access-control-allow-origin'), ok.headers.get('access-control-allow-credentials')]).toEqual(['https://app.example.com', 'true'])
    expect(ok.headers.get('access-control-allow-origin')).not.toBe('*')
    expect(ok.headers.get('access-control-expose-headers')).toContain('x-trace-id')

    const preflight = await api.call('OPTIONS', '/api/v1/things', undefined, { headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')

    for (const origin of ['https://evil.example.com', 'http://app.example.com', 'https://app.example.com:8443', 'null']) {
      const res = await api.get('/api/v1/things', { headers: { origin } })
      expect(res.status).toBe(200) // CORS is enforced by the browser: the answer is simply not readable there
      expect(res.headers.get('access-control-allow-origin'), origin).toBeNull()
      expect(res.headers.get('access-control-allow-credentials'), origin).toBeNull()
    }
  })

  it('no origins = no CORS headers at all', async () => {
    const res = await app().api.get('/api/v1/things', { headers: { origin: 'https://app.example.com' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('body size limit', () => {
  it('rejects a body above the limit with 413 in the error shape; one at the limit passes', async () => {
    const { api } = app({ bodyLimitBytes: 64 })
    expect((await api.post('/api/v1/things', { a: 'x'.repeat(10) })).status).toBe(201)
    const res = await api.post('/api/v1/things', { a: 'x'.repeat(100) })
    expect(res.status).toBe(413)
    expect(res.body).toEqual({ error: { code: 'VALIDATION', message: 'Request body too large (limit 64 bytes)', traceId: res.traceId } })
  })
})

describe('rate limit', () => {
  it('allows `max` per window per client, then 429 with retry-after; the window resets', async () => {
    let at = 1_000_000
    let client = 'a'
    const { api } = app({ rateLimit: { max: 2, windowMs: 10_000, key: () => client, now: () => at } })
    const hit = async () => api.get('/api/v1/things')
    expect([(await hit()).status, (await hit()).status]).toEqual([200, 200])
    at += 4_000
    const limited = await hit()
    expect(limited.status).toBe(429)
    expect(limited.body.error).toMatchObject({ code: 'RATE_LIMITED', traceId: limited.traceId })
    expect(limited.headers.get('retry-after')).toBe('6')
    expect([limited.headers.get('ratelimit-limit'), limited.headers.get('ratelimit-remaining')]).toEqual(['2', '0'])
    client = 'b' // another client has its own budget
    expect((await hit()).status).toBe(200)
    client = 'a'
    at += 6_000 // window over
    const again = await hit()
    expect([again.status, again.headers.get('ratelimit-remaining')]).toEqual([200, '1'])
  })

  it('health probes never count and are never throttled', async () => {
    const { api } = app({ rateLimit: { max: 1, windowMs: 60_000, key: () => 'a' } })
    for (let i = 0; i < 5; i++) expect((await api.get('/health/live')).status).toBe(200)
    expect((await api.get('/api/v1/things')).status).toBe(200)
    expect((await api.get('/api/v1/things')).status).toBe(429)
    expect((await api.get('/health/ready')).status).toBe(200)
  })

  it('the default client is the TCP peer, never a header', async () => {
    const { api } = app({ rateLimit: { max: 1, windowMs: 60_000 } })
    expect((await api.get('/api/v1/things', { headers: { 'x-forwarded-for': '198.51.100.1' } })).status).toBe(200)
    expect((await api.get('/api/v1/things', { headers: { 'x-forwarded-for': '198.51.100.2' } })).status).toBe(429)
  })

  it('tracks a bounded number of clients; bad settings are config errors', async () => {
    let n = 0
    const limiter = rateLimit({ max: 1, windowMs: 60_000, key: () => `c${n++}`, maxKeys: 3 })
    const api = createApi({ name: 'svc', version: '1', logger: createLogger('error', () => undefined), middleware: [limiter] })
    api.get('/x', (c) => c.json({ ok: true }))
    for (let i = 0; i < 50; i++) expect((await testClient(api).get('/x')).status).toBe(200) // never throws, never grows past the bound
    expect(() => rateLimit({ max: 0, windowMs: 1000 })).toThrow(SecurityConfigError)
  })
})
