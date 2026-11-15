// The security baseline as this app serves it: headers on every answer, CORS only for listed origins, limits.
import { describe, expect, it } from 'vitest'
import { SecurityConfigError } from '../src/kit/security/security.js'
import { useApp } from './helpers.js'

const t = useApp()
const ALLOWED = 'https://app.example.com'

describe('secure headers', () => {
  it.each(['/health/live', '/api/v1/items', '/nope'])('%s carries them, whatever the status', async (path) => {
    const res = await t.build().api.get(path)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('strict-transport-security')).toContain('max-age=')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
  })
})

describe('CORS', () => {
  it('no origins configured: no CORS header for anyone', async () => {
    const res = await t.build().api.get('/api/v1/items', { headers: { origin: ALLOWED } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('a listed origin is echoed with credentials; any other origin gets nothing', async () => {
    const { api } = t.build({}, { CORS_ORIGINS: `${ALLOWED}, http://localhost:3000` })
    const ok = await api.get('/api/v1/items', { headers: { origin: ALLOWED } })
    expect(ok.headers.get('access-control-allow-origin')).toBe(ALLOWED)
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true')
    for (const origin of ['https://evil.example.com', 'https://app.example.com.evil.example', 'null']) {
      const res = await api.get('/api/v1/items', { headers: { origin } })
      expect(res.headers.get('access-control-allow-origin'), origin).toBeNull()
    }
  })

  it('a wildcard is refused at boot, never served with credentials', () => {
    expect(() => t.build({}, { CORS_ORIGINS: '*' })).toThrow(SecurityConfigError)
    expect(() => t.build({}, { CORS_ORIGINS: 'https://*.example.com' })).toThrow(/wildcards are not allowed/)
  })
})

describe('limits', () => {
  it('a body over BODY_LIMIT_BYTES is 413 VALIDATION', async () => {
    const { api } = t.build({}, { BODY_LIMIT_BYTES: '200' })
    expect((await api.post('/api/v1/items', { name: 'small' })).status).toBe(201)
    const res = await api.post('/api/v1/items', { name: 'big', description: 'x'.repeat(500) })
    expect(res.status).toBe(413)
    expect(res.body.error).toMatchObject({ code: 'VALIDATION', traceId: res.traceId })
  })

  it('more than RATE_LIMIT_MAX requests in a window is 429 RATE_LIMITED with retry-after; probes are exempt', async () => {
    const { api } = t.build({}, { RATE_LIMIT_MAX: '3' })
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await api.get('/api/v1/items')).status)
    expect(statuses).toEqual([200, 200, 200, 429, 429])
    const limited = await api.get('/api/v1/items')
    expect(limited.body.error).toMatchObject({ code: 'RATE_LIMITED', traceId: limited.traceId })
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await api.get('/health/live')).status).toBe(200)
  })

  it('RATE_LIMIT_MAX=0 switches it off', async () => {
    const { api } = t.build({}, { RATE_LIMIT_MAX: '0' })
    for (let i = 0; i < 20; i++) expect((await api.get('/health/ready')).status).toBe(200)
    expect((await api.get('/api/v1/items')).headers.get('ratelimit-limit')).toBeNull()
  })
})
