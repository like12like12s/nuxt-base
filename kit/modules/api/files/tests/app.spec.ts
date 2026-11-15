// The API standard, as this app serves it: trace id, request log, the one error shape, health, version.
import { describe, expect, it } from 'vitest'
import { SERVICE, VERSION } from '../src/app.js'
import { forbidden, unauthorized } from '../src/kit/api/errors.js'
// @kit:if auth
import { publicRoute } from '../src/kit/auth/guard.js'
// @kit:end
import { KIT_VERSION } from '../src/kit/api/kit-version.js'
import { TRACE_ID, useApp } from './helpers.js'

const t = useApp()

describe('health and version', () => {
  it('liveness answers without touching the database', async () => {
    const { api } = t.build({ database: { ...t.database, ping: () => Promise.reject(new Error('db is gone')) } })
    const res = await api.get('/health/live')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })

  it('readiness is 200 with every check ok when the database is reachable and migrated', async () => {
    const res = await t.build().api.get('/health/ready')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.checks.map((c: { name: string; status: string }) => [c.name, c.status])).toEqual([['db', 'ok'], ['schema', 'ok']])
  })

  it('GET /version says what is running', async () => {
    const res = await t.build().api.get('/version')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ name: SERVICE, version: VERSION, commit: 'unknown', builtAt: 'unknown', kit: KIT_VERSION })
  })
})

describe('trace id and request log', () => {
  it('generates a trace id, returns it in x-trace-id and logs it', async () => {
    const { api, lines } = t.build()
    const res = await api.get('/health/live?token=abc')
    expect(res.traceId).toMatch(TRACE_ID)
    const requests = lines.filter((line) => line.msg === 'request') // one line per request
    expect(requests).toHaveLength(1)
    expect(Object.keys(requests[0]!).sort()).toEqual(['env', 'level', 'method', 'ms', 'msg', 'path', 'service', 'status', 'traceId', 'ts'])
    expect(requests[0]).toMatchObject({ level: 'info', msg: 'request', service: SERVICE, env: 'test', traceId: res.traceId, method: 'GET', path: '/health/live', status: 200 })
    expect(JSON.stringify(lines)).not.toContain('abc') // the query string may carry tokens
  })

  it('a caller does not choose the trace id: traceparent is continued only with TRUST_TRACEPARENT=1 (or through the trusted proxy)', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    const headers = { traceparent: `00-${traceId}-00f067aa0ba902b7-01` }
    const untrusted = await t.build().api.get('/health/live', { headers })
    expect(untrusted.traceId).toMatch(TRACE_ID)
    expect(untrusted.traceId).not.toBe(traceId)
    expect((await t.build({}, { TRUST_TRACEPARENT: '1' }).api.get('/health/live', { headers })).traceId).toBe(traceId)
  })

  it('ignores a malformed traceparent', async () => {
    const res = await t.build().api.get('/health/live', { headers: { traceparent: 'nonsense' } })
    expect(res.traceId).toMatch(TRACE_ID)
  })
})

describe('error shape — { error: { code, message, details?, traceId } } on every status >= 400', () => {
  function expectError(res: { status: number; body: any; traceId: string | null }, status: number, code: string) {
    expect(res.status).toBe(status)
    expect(Object.keys(res.body)).toEqual(['error'])
    expect(Object.keys(res.body.error).filter((k) => k !== 'details').sort()).toEqual(['code', 'message', 'traceId'])
    expect(res.body.error.code).toBe(code)
    expect(res.body.error.traceId).toMatch(TRACE_ID)
    expect(res.body.error.traceId).toBe(res.traceId)
  }

  // @kit:if sample
  it('400 VALIDATION with details that name the field', async () => {
    const res = await t.build().api.post('/api/v1/items', { name: '', quantity: -1 })
    expectError(res, 400, 'VALIDATION')
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['json.name', 'json.quantity'])
  })

  it('400 VALIDATION for a body that is not JSON', async () => {
    const res = await t.build().api.post('/api/v1/items', undefined, { raw: '{not json' })
    expectError(res, 400, 'VALIDATION')
  })

  // @kit:end
  it('401 UNAUTHORIZED and 403 FORBIDDEN', async () => {
    const { app, api } = t.build()
    // @kit:if auth
    // (every route declares who may call it — also a test route outside /api/v1, or the auth guard refuses it)
    app.get('/_test/401', publicRoute(), () => { throw unauthorized() })
    app.get('/_test/403', publicRoute(), () => { throw forbidden() })
    // @kit:else
    app.get('/_test/401', () => { throw unauthorized() })
    app.get('/_test/403', () => { throw forbidden() })
    // @kit:end
    expectError(await api.get('/_test/401'), 401, 'UNAUTHORIZED')
    expectError(await api.get('/_test/403'), 403, 'FORBIDDEN')
  })

  // @kit:if sample
  it('404 NOT_FOUND for an unknown route and for a missing resource', async () => {
    const { api } = t.build()
    expectError(await api.get('/nope'), 404, 'NOT_FOUND')
    expectError(await api.get('/api/v1/items/missing'), 404, 'NOT_FOUND')
  })

  it('409 CONFLICT', async () => {
    const { api } = t.build()
    await api.post('/api/v1/items', { name: 'Widget' })
    expectError(await api.post('/api/v1/items', { name: 'Widget' }), 409, 'CONFLICT')
  })
  // @kit:else
  // (400 with details, 404 for a missing record and 409 are in the test of each resource — `scaffold add resource`)
  it('404 NOT_FOUND for an unknown route', async () => {
    const { api } = t.build()
    expectError(await api.get('/nope'), 404, 'NOT_FOUND')
    expectError(await api.get('/api/v1/nope'), 404, 'NOT_FOUND')
  })
  // @kit:end

  it('500 INTERNAL never leaks the cause: no message, no stack, no SQL — the log has it, under the same trace id', async () => {
    const { app, api, lines } = t.build()
    // @kit:if auth
    app.get('/_test/500', publicRoute(), () => { throw new Error('select * from users where password = hunter2') })
    // @kit:else
    app.get('/_test/500', () => { throw new Error('select * from users where password = hunter2') })
    // @kit:end
    const res = await api.get('/_test/500')
    expectError(res, 500, 'INTERNAL')
    expect(res.body.error.message).toBe('Internal server error')
    const text = JSON.stringify(res.body)
    for (const leak of ['hunter2', 'select', 'at ', '.ts']) expect(text).not.toContain(leak)
    const logged = lines.find((l) => l.msg === 'unhandled error')
    expect(logged).toMatchObject({ level: 'error', traceId: res.traceId })
    expect(String(logged?.error)).toContain('hunter2')
  })

  // @kit:if sample
  it('a failing query surfaces as 500 without the SQL', async () => {
    const { api } = t.build()
    await t.db.schema.alterTable('items').renameTo('items_gone').execute()
    try {
      const res = await api.get('/api/v1/items')
      expectError(res, 500, 'INTERNAL')
      expect(JSON.stringify(res.body)).not.toMatch(/items|select|table/i)
    } finally {
      await t.db.schema.alterTable('items_gone').renameTo('items').execute()
    }
  })
  // @kit:end
})
