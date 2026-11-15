// @vitest-environment node
// The locked API runtime (kit/runtime/api/**) — the API standard itself, tested at the source.
import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { afterEach, describe, expect, it, vi } from 'vitest'
import rootPkg from '../../package.json'
import { API_V1, createApi, mountV1, openApiDocument, stringifyOpenApi } from '../runtime/api/app'
import { currentActor, currentTraceId, getContext, parseTraceparent, resolveTraceId, runWithContext, setTraceIdProvider } from '../runtime/api/context'
import { ApiError, ERROR_CODES, codeForStatus, conflict, errorBody, errorResponses, forbidden, notFound, rateLimited, unauthorized, validation } from '../runtime/api/errors'
import { CHECK_TIMEOUT_MS, HealthCheckError, runChecks, type HealthCheck } from '../runtime/api/health'
import { KIT_VERSION } from '../runtime/api/kit-version'
import { createLogger } from '../runtime/api/log'
import { DEFAULT_LIMIT, MAX_IDS, MAX_LIMIT, listQuery, one, page, parseSort } from '../runtime/api/pagination'
import { testClient } from '../runtime/testing/client'

const HEX32 = /^[0-9a-f]{32}$/

function setup(checks: HealthCheck[] = [], options: Partial<Parameters<typeof createApi>[0]> = {}) {
  const lines: Record<string, any>[] = []
  const logger = createLogger('info', (line) => lines.push(JSON.parse(line)), { service: 'svc', env: 'test' })
  const app = createApi({ name: 'svc', version: '1.2.3', logger, checks, build: { commit: 'abc1234', builtAt: '2026-01-01T00:00:00Z' }, ...options })
  return { app, api: testClient(app), lines }
}

afterEach(() => setTraceIdProvider(() => undefined))

describe('kit version', () => {
  it('KIT_VERSION (what GET /version reports) equals the repo version — bump both with every release', () => {
    expect(KIT_VERSION).toBe(rootPkg.version)
  })
})

describe('trace id', () => {
  it('parses a W3C traceparent and rejects anything else', () => {
    const id = '4bf92f3577b34da6a3ce929d0e0e4736'
    expect(parseTraceparent(`00-${id}-00f067aa0ba902b7-01`)).toBe(id)
    expect(parseTraceparent(`00-${id.toUpperCase()}-00F067AA0BA902B7-01`)).toBe(id)
    // L1: version ff and an all-zero parent id are invalid per the W3C spec, like an all-zero trace id
    for (const bad of [undefined, null, '', 'abc', `00-${id}-00f067aa0ba902b7`, `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`, `00-${id}x-00f067aa0ba902b7-01`, `ff-${id}-00f067aa0ba902b7-01`, `00-${id}-0000000000000000-01`, `00-${id}-00f067aa0ba902b7-01-extra`]) {
      expect(parseTraceparent(bad), String(bad)).toBeUndefined()
    }
  })

  it('order: active span (trace module seam) -> traceparent -> generated', () => {
    const header = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`
    expect(resolveTraceId(undefined)).toMatch(HEX32)
    expect(resolveTraceId(undefined)).not.toBe(resolveTraceId(undefined))
    expect(resolveTraceId(header)).toBe('a'.repeat(32))
    setTraceIdProvider(() => 'c'.repeat(32))
    expect(resolveTraceId(header)).toBe('c'.repeat(32))
  })

  it('the context carries the trace id and the user slot; the actor falls back to anonymous / system', async () => {
    expect(currentTraceId()).toBeUndefined()
    expect(currentActor()).toBe('system')
    await runWithContext({ traceId: 't1' }, async () => {
      await Promise.resolve()
      expect(currentTraceId()).toBe('t1')
      expect(currentActor()).toBe('anonymous')
      getContext()!.user = { subject: 'u-42', roles: ['admin'] } // what the auth module will do
      expect(currentActor()).toBe('u-42')
    })
    expect(getContext()).toBeUndefined()
  })
})

describe('logger', () => {
  it('adds the base fields to every line and the trace id inside a request scope', () => {
    const lines: any[] = []
    const log = createLogger('info', (l) => lines.push(JSON.parse(l)), { service: 'svc', env: 'production' })
    log.info('outside')
    runWithContext({ traceId: 'trace-1' }, () => log.warn('inside', { extra: 1 }))
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'outside', service: 'svc', env: 'production' })
    expect(lines[0]).not.toHaveProperty('traceId')
    expect(lines[1]).toMatchObject({ level: 'warn', msg: 'inside', service: 'svc', env: 'production', traceId: 'trace-1', extra: 1 })
    expect(Number.isNaN(Date.parse(lines[1].ts))).toBe(false)
  })
})

describe('errors', () => {
  it('the code set is fixed and every helper maps to its status', () => {
    expect(ERROR_CODES).toEqual(['VALIDATION', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED', 'INTERNAL'])
    const cases: [ApiError, string, number][] = [
      [validation('bad'), 'VALIDATION', 400], [unauthorized(), 'UNAUTHORIZED', 401], [forbidden(), 'FORBIDDEN', 403],
      [notFound('Item', 'x'), 'NOT_FOUND', 404], [conflict('dup'), 'CONFLICT', 409], [rateLimited(), 'RATE_LIMITED', 429],
    ]
    for (const [err, code, status] of cases) expect([err.code, err.status]).toEqual([code, status])
    expect(notFound('Item', 'x').message).toBe('Item x not found')
  })

  it('any status >= 400 has a code', () => {
    expect([400, 401, 403, 404, 405, 409, 413, 422, 429, 500, 502, 503].map(codeForStatus)).toEqual([
      'VALIDATION', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION', 'CONFLICT', 'VALIDATION', 'VALIDATION', 'RATE_LIMITED', 'INTERNAL', 'INTERNAL', 'INTERNAL',
    ])
  })

  it('the body has exactly code, message, traceId — and details only when there are any', () => {
    expect(errorBody('NOT_FOUND', 'nope', 't')).toEqual({ error: { code: 'NOT_FOUND', message: 'nope', traceId: 't' } })
    expect(errorBody('VALIDATION', 'bad', 't', [])).toEqual({ error: { code: 'VALIDATION', message: 'bad', traceId: 't' } })
    expect(errorBody('VALIDATION', 'bad', 't', [{ path: 'a' }]).error.details).toEqual([{ path: 'a' }])
    expect(Object.keys(errorResponses(400, 404)).sort()).toEqual(['400', '404', '500'])
  })
})

describe('pagination', () => {
  const list = listQuery({ sortable: ['createdAt', 'name'] as const, defaultSort: '-createdAt' })
  const parse = (query: Record<string, string>) => {
    const r = list.schema.safeParse(query)
    return r.success ? list.parse(r.data) : r.error.issues.map((i) => i.path.join('.'))
  }

  it('defaults: limit 50, offset 0, the default sort', () => {
    expect(parse({})).toEqual({ limit: DEFAULT_LIMIT, offset: 0, sort: [{ column: 'createdAt', direction: 'desc' }] })
    expect(DEFAULT_LIMIT).toBe(50)
    expect(MAX_LIMIT).toBe(200)
  })

  it('parses limit, offset, multi-column sort and ids (deduplicated)', () => {
    expect(parse({ limit: '200', offset: '40', sort: 'name,-createdAt', ids: 'a, b,a' })).toEqual({
      limit: 200, offset: 40, sort: [{ column: 'name', direction: 'asc' }, { column: 'createdAt', direction: 'desc' }], ids: ['a', 'b'],
    })
  })

  it.each([
    [{ limit: '201' }, 'limit'], [{ limit: '0' }, 'limit'], [{ limit: '-5' }, 'limit'], [{ limit: 'x' }, 'limit'], [{ limit: '1.5' }, 'limit'],
    [{ offset: '-1' }, 'offset'], [{ offset: 'x' }, 'offset'],
    [{ sort: 'password' }, 'sort'], [{ sort: 'name,name' }, 'sort'], [{ sort: '' }, 'sort'], [{ sort: '--name' }, 'sort'],
    [{ ids: 'a,,b' }, 'ids'], [{ ids: Array.from({ length: MAX_IDS + 1 }, (_, i) => `i${i}`).join(',') }, 'ids'],
  ])('rejects %j (never clamps)', (query, field) => {
    expect(parse(query as Record<string, string>)).toEqual([field])
  })

  it('parseSort and the envelopes', () => {
    expect(parseSort('-a,b', ['a', 'b'])).toEqual([{ column: 'a', direction: 'desc' }, { column: 'b', direction: 'asc' }])
    expect(parseSort('c', ['a', 'b'])).toBeNull()
    expect(() => listQuery({ sortable: ['a'], defaultSort: 'b' })).toThrow(/defaultSort/)
    expect(one({ id: 1 })).toEqual({ data: { id: 1 } })
    expect(page([1, 2], { limit: 2, offset: 4 }, 9)).toEqual({ data: [1, 2], meta: { limit: 2, offset: 4, total: 9 } })
  })
})

describe('health checks', () => {
  it('reports each check with its duration; a public failure message passes through, any other cause does not', async () => {
    const seen: string[] = []
    const report = await runChecks(
      [
        { name: 'a', run: async () => {} },
        { name: 'b', run: async () => { throw new HealthCheckError('behind: 0002_x') } },
        { name: 'c', run: async () => { throw new Error('connect ECONNREFUSED db-internal:3306') } },
      ],
      (name, err) => seen.push(`${name}: ${(err as Error).message}`),
    )
    expect(report.ok).toBe(false)
    expect(report.checks.map(({ ms: _ms, ...rest }) => rest)).toEqual([
      { name: 'a', status: 'ok' },
      { name: 'b', status: 'fail', message: 'behind: 0002_x' },
      { name: 'c', status: 'fail', message: 'failed' },
    ])
    expect(seen).toEqual(['c: connect ECONNREFUSED db-internal:3306'])
    expect((await runChecks([])).ok).toBe(true)
  })

  it('gives up on a check that never settles, instead of hanging with it', async () => {
    vi.useFakeTimers()
    try {
      const pending = runChecks([{ name: 'db', run: () => new Promise(() => {}) }])
      await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS + 10)
      expect((await pending).checks[0]).toMatchObject({ name: 'db', status: 'fail', message: 'timed out' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createApi', () => {
  it('liveness runs no check; readiness 200 lists them; 503 carries the failing list in the error shape', async () => {
    const run = vi.fn(async () => {})
    const ok = setup([{ name: 'db', run }])
    expect((await ok.api.get('/health/live')).body).toEqual({ status: 'ok' })
    expect(run).not.toHaveBeenCalled()
    const ready = await ok.api.get('/health/ready')
    expect(ready.status).toBe(200)
    expect(ready.body).toMatchObject({ status: 'ok', checks: [{ name: 'db', status: 'ok' }] })

    const down = setup([{ name: 'db', run: async () => { throw new HealthCheckError('unreachable') } }, { name: 'schema', run: async () => {} }])
    const res = await down.api.get('/health/ready')
    expect(res.status).toBe(503)
    expect(Object.keys(res.body)).toEqual(['error'])
    expect(res.body.error).toMatchObject({ code: 'INTERNAL', message: 'Not ready', traceId: res.traceId })
    expect(res.body.error.details.map((c: any) => [c.name, c.status, c.message])).toEqual([['db', 'fail', 'unreachable'], ['schema', 'ok', undefined]])
    expect((await down.api.get('/health/live')).status).toBe(200)
  })

  it('GET /version', async () => {
    expect((await setup().api.get('/version')).body).toEqual({ name: 'svc', version: '1.2.3', commit: 'abc1234', builtAt: '2026-01-01T00:00:00Z', kit: KIT_VERSION })
  })

  it('one log line per request with exactly the standard fields; the trace id is on the response too', async () => {
    const { api, lines } = setup()
    const res = await api.get('/version?secret=abc')
    expect(lines).toHaveLength(1)
    expect(Object.keys(lines[0]!).sort()).toEqual(['env', 'level', 'method', 'ms', 'msg', 'path', 'service', 'status', 'traceId', 'ts'])
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'request', service: 'svc', env: 'test', method: 'GET', path: '/version', status: 200, traceId: res.traceId })
    expect(res.traceId).toMatch(HEX32)
  })

  // L1: the trace id is written into audit rows and logs — a caller is not trusted to choose it unless the app says so
  it('traceparent is continued only for a caller the app trusts (trustTraceparent); by default every request gets a new id', async () => {
    const headers = { traceparent: `00-${'d'.repeat(32)}-${'e'.repeat(16)}-01` }
    const untrusted = setup()
    const res = await untrusted.api.get('/version', { headers })
    expect(res.traceId).toMatch(HEX32)
    expect(res.traceId).not.toBe('d'.repeat(32))
    expect(untrusted.lines[0]!.traceId).toBe(res.traceId)
    expect((await untrusted.api.get('/nope', { headers })).body.error.traceId).not.toBe('d'.repeat(32))

    const trusted = setup([], { trustTraceparent: (c) => c.req.header('x-from-proxy') === 'yes' })
    const viaProxy = await trusted.api.get('/version', { headers: { ...headers, 'x-from-proxy': 'yes' } })
    expect(viaProxy.traceId).toBe('d'.repeat(32))
    expect(trusted.lines[0]!.traceId).toBe('d'.repeat(32))
    expect((await trusted.api.get('/version', { headers })).traceId).not.toBe('d'.repeat(32))
  })

  it('every status >= 400 has the error shape with the trace id of the response header', async () => {
    const { app, api, lines } = setup()
    app.get('/t/401', () => { throw unauthorized() })
    app.get('/t/403', () => { throw forbidden('Admins only') })
    app.get('/t/409', () => { throw conflict('Already exists', [{ field: 'name' }]) })
    app.get('/t/429', () => { throw rateLimited() })
    app.get('/t/413', () => { throw new HTTPException(413, { message: 'Payload too large' }) })
    app.get('/t/502', () => { throw new HTTPException(502, { message: 'upstream at internal-host said no' }) })
    app.get('/t/500', () => { throw new Error('ER_NO_SUCH_TABLE: select * from secrets') })
    app.get('/t/throw-string', () => { throw 'plain string' as unknown as Error })

    const expected: [string, number, string, string][] = [
      ['/t/401', 401, 'UNAUTHORIZED', 'Authentication required'],
      ['/t/403', 403, 'FORBIDDEN', 'Admins only'],
      ['/nope', 404, 'NOT_FOUND', 'No route for GET /nope'],
      ['/t/409', 409, 'CONFLICT', 'Already exists'],
      ['/t/429', 429, 'RATE_LIMITED', 'Too many requests'],
      ['/t/413', 413, 'VALIDATION', 'Payload too large'],
      ['/t/502', 500, 'INTERNAL', 'Internal server error'],
      ['/t/500', 500, 'INTERNAL', 'Internal server error'],
      ['/t/throw-string', 500, 'INTERNAL', 'Internal server error'],
    ]
    for (const [path, status, code, message] of expected) {
      const res = await api.get(path)
      expect(res.status, path).toBe(status)
      expect(Object.keys(res.body), path).toEqual(['error'])
      expect(res.body.error, path).toMatchObject({ code, message, traceId: res.traceId })
      expect(Object.keys(res.body.error).filter((k) => k !== 'details').sort(), path).toEqual(['code', 'message', 'traceId'])
    }
    expect((await api.get('/t/409')).body.error.details).toEqual([{ field: 'name' }])

    // 500s: nothing of the cause in the body, all of it in the log
    const res = await api.get('/t/500')
    expect(JSON.stringify(res.body)).not.toMatch(/secrets|select|ER_NO_SUCH_TABLE|stack|\.ts:/)
    const logged = lines.filter((l) => l.msg === 'unhandled error' && l.traceId === res.traceId)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ level: 'error', error: 'ER_NO_SUCH_TABLE: select * from secrets', path: '/t/500' })
    expect(logged[0]!.stack).toContain('runtime-api.spec')
    expect(lines.find((l) => l.msg === 'request' && l.path === '/t/500')).toMatchObject({ level: 'error', status: 500 })
  })

  it('validates contract-first routes under /api/v1 and names the failing field', async () => {
    const { app, api } = setup()
    const Thing = z.object({ name: z.string().min(2), size: z.number().int() }).openapi('Thing')
    const list = listQuery({ sortable: ['name'] as const, defaultSort: 'name' })
    mountV1(app, (v1) => {
      v1.openapi(
        createRoute({ method: 'get', path: '/things', request: { query: list.schema }, responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({ data: z.array(Thing) }) } } }, ...errorResponses(400) } }),
        (c) => c.json({ data: [{ name: `limit ${list.parse(c.req.valid('query')).limit}`, size: 1 }] }, 200),
      )
      v1.openapi(
        createRoute({ method: 'post', path: '/things', request: { body: { required: true, content: { 'application/json': { schema: Thing } } } }, responses: { 201: { description: 'ok', content: { 'application/json': { schema: z.object({ data: Thing }) } } }, ...errorResponses(400) } }),
        (c) => c.json({ data: c.req.valid('json') }, 201),
      )
    })
    expect(API_V1).toBe('/api/v1')
    expect((await api.get('/api/v1/things?limit=7')).body).toEqual({ data: [{ name: 'limit 7', size: 1 }] })
    expect((await api.post('/api/v1/things', { name: 'ok', size: 2 })).status).toBe(201)

    const bad = await api.post('/api/v1/things', { name: 'x', size: 'big' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatchObject({ code: 'VALIDATION', message: 'Request validation failed', traceId: bad.traceId })
    expect(bad.body.error.details.map((d: any) => d.path).sort()).toEqual(['json.name', 'json.size'])
    // L8: query numbers are decimal digits only — nothing Number() merely tolerates
    for (const query of ['limit=0x10', 'limit=1e2', 'limit=%205', 'limit=5.0', 'limit=', 'offset=', 'offset=1e1', 'offset=-0', 'limit=99999999999999999999']) {
      const res = await api.get(`/api/v1/things?${query}`)
      expect(res.status, query).toBe(400)
      expect(res.body.error.details[0].path, query).toBe(`query.${query.split('=')[0]}`)
    }
    expect((await api.get('/api/v1/things?limit=007&offset=0')).body).toEqual({ data: [{ name: 'limit 7', size: 1 }] })
    // ?ids= with more ids than the default page: all of them fit one page instead of a silent cut at 50
    const ids = Array.from({ length: 120 }, (_, i) => `id-${i}`).join(',')
    expect((await api.get(`/api/v1/things?ids=${ids}`)).body).toEqual({ data: [{ name: 'limit 120', size: 1 }] })
    expect((await api.get(`/api/v1/things?ids=a,b,a&limit=1`)).body).toEqual({ data: [{ name: 'limit 2', size: 1 }] })
    expect((await api.get('/api/v1/things?ids=a,b')).body).toEqual({ data: [{ name: 'limit 50', size: 1 }] })
    // the contract still documents limit / offset as integers with their defaults
    const params = (await api.get('/openapi.json')).body.paths['/api/v1/things'].get.parameters
    expect(params.find((p: any) => p.name === 'limit').schema).toMatchObject({ type: 'integer', minimum: 1, maximum: 200, default: 50 })
    expect(params.find((p: any) => p.name === 'offset').schema).toMatchObject({ type: 'integer', minimum: 0, default: 0 })
    const over = await api.get('/api/v1/things?limit=201&offset=-1')
    expect(over.status).toBe(400)
    expect(over.body.error.details.map((d: any) => d.path).sort()).toEqual(['query.limit', 'query.offset'])
    const malformed = await api.post('/api/v1/things', undefined, { raw: '{oops' })
    expect([malformed.status, malformed.body.error.code]).toEqual([400, 'VALIDATION'])

    // the contract: served, stable, and it describes what was mounted
    const served = (await api.get('/openapi.json')).body
    expect(served.info).toEqual({ title: 'svc', version: '1.2.3' })
    expect(Object.keys(served.paths).sort()).toEqual(['/api/v1/things', '/health/live', '/health/ready', '/version'])
    expect(stringifyOpenApi(served)).toBe(stringifyOpenApi(openApiDocument(app, { name: 'svc', version: '1.2.3' })))
    expect(served.components.schemas.Error.properties.error.properties.code.enum).toEqual([...ERROR_CODES])
  })
})
