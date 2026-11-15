// @vitest-environment node
// The test kit (kit/runtime/testing/**): deterministic fixtures, a throwaway database per test file, the in-process
// client and the playwright helpers.
import { existsSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { newId, now } from '../runtime/db/clock'
import { baseMigration } from '../runtime/db/schema'
import { testClient } from '../runtime/testing/client'
import { captureErrors, failure, list, one, stubApi } from '../runtime/testing/e2e'
import { FIXED_START, defineFactory, deterministic, fixedClock, seededRandom, sequentialIds } from '../runtime/testing/factory'
import { createTestDb, describeTestUrl, mysqlTestUrl, testDialect, useDeterministic, useTestDb } from '../runtime/testing/test-db'

describe('deterministic fixtures', () => {
  it('the seeded random source gives the same sequence for the same seed, on every run', () => {
    const take = (seed: number) => { const r = seededRandom(seed); return Array.from({ length: 5 }, () => r()) }
    expect(take(1)).toEqual(take(1))
    expect(take(1)).not.toEqual(take(2))
    // pinned values: a change of the algorithm (and so of every fixture) cannot go unnoticed
    expect(take(1).map((v) => v.toFixed(6))).toEqual(['0.627074', '0.002736', '0.527447', '0.981051', '0.968378'])
    for (const v of take(7)) expect(v >= 0 && v < 1).toBe(true)
  })

  it('a factory builds the same objects every time it is defined', () => {
    const define = () => defineFactory<{ name: string; role: string; score: number; active?: boolean }>(({ n, random, pick }) => ({
      name: `User ${n}`, role: pick(['admin', 'editor', 'viewer']), score: Math.floor(random() * 100),
    }))
    const first = define().buildList(4)
    expect(define().buildList(4)).toEqual(first)
    expect(first.map((u) => u.name)).toEqual(['User 1', 'User 2', 'User 3', 'User 4'])
    expect(define().build({ role: 'owner', active: true })).toEqual({ ...first[0], role: 'owner', active: true })
    expect(() => defineFactory(({ pick }) => ({ v: pick([]) })).build()).toThrow(/non-empty/)
  })

  it('the fixed clock starts at a fixed instant and steps; ids count up as valid UUIDs', () => {
    const clock = fixedClock()
    expect([clock().toISOString(), clock().toISOString()]).toEqual([FIXED_START, '2026-01-01T00:00:01.000Z'])
    expect(fixedClock('2030-01-01T00:00:00.000Z', 60_000)().toISOString()).toBe('2030-01-01T00:00:00.000Z')
    const ids = sequentialIds()
    expect([ids(), ids()]).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'])
  })

  it('deterministic() pins the data layer\'s clock and ids, and restore() gives the real ones back', () => {
    const pinned = deterministic()
    expect([now(), newId(), now(), newId()]).toEqual([FIXED_START, '00000000-0000-4000-8000-000000000001', '2026-01-01T00:00:01.000Z', '00000000-0000-4000-8000-000000000002'])
    pinned.restore()
    expect(Date.parse(now())).toBeGreaterThan(Date.parse('2026-06-01T00:00:00Z'))
    expect(newId()).not.toMatch(/^00000000-0000-4000-8000-/)
  })

  describe('useDeterministic()', () => {
    useDeterministic({ start: '2031-01-01T00:00:00.000Z' })
    it('every test starts from the same clock and the same first id', () => {
      expect([now(), newId()]).toEqual(['2031-01-01T00:00:00.000Z', '00000000-0000-4000-8000-000000000001'])
    })
    it('... the second test too', () => {
      expect([now(), newId()]).toEqual(['2031-01-01T00:00:00.000Z', '00000000-0000-4000-8000-000000000001'])
    })
  })
})

describe(`throwaway test database (${testDialect()})`, () => {
  const migrations = { '0001_base': baseMigration }
  const user = (id: string) => ({ id, subject: id, email: null, name: null, roles: '[]', createdAt: FIXED_START, updatedAt: FIXED_START, deletedAt: null })
  const extra: { cleanup(): Promise<void> }[] = []
  afterAll(async () => { for (const db of extra) await db.cleanup() })

  it('each database is separate, migrated, and gone after cleanup()', async () => {
    const a = await createTestDb({ migrations, label: 'iso a' })
    const b = await createTestDb({ migrations, label: 'iso-b' })
    extra.push(a, b)
    expect(a.url).not.toBe(b.url)
    expect(describeTestUrl(a.url)).toMatch(testDialect() === 'mysql' ? /^mysql test_iso_a_[0-9a-f]{12}$/ : /^sqlite .*kit-test-iso_a-.*test\.db$/)
    await a.db.insertInto('users').values(user('only-in-a')).execute()
    expect(await a.db.selectFrom('users').select('id').execute()).toEqual([{ id: 'only-in-a' }])
    expect(await b.db.selectFrom('users').select('id').execute()).toEqual([])

    await a.cleanup()
    await a.cleanup() // twice is fine
    if (a.target.dialect === 'sqlite') expect(existsSync(a.target.file)).toBe(false)
    else await expect(createTestDb({ dialect: 'mysql' }).then(async (probe) => { extra.push(probe); return (await probe.db.introspection.getSchemas()).map((s) => s.name) })).resolves.not.toContain(a.target.database)
    expect(await b.db.selectFrom('users').select('id').execute()).toEqual([]) // the other one is untouched
  })

  it('can be forced to SQLite, and refuses MySQL without TEST_MYSQL_URL', async () => {
    const sqlite = await createTestDb({ dialect: 'sqlite' })
    extra.push(sqlite)
    expect(sqlite.dialect).toBe('sqlite')
    if (!mysqlTestUrl()) await expect(createTestDb({ dialect: 'mysql' })).rejects.toThrow(/TEST_MYSQL_URL/)
  })

  describe('useTestDb()', () => {
    const t = useTestDb({ migrations })
    it('hands out one migrated database for the file', async () => {
      await t.db.insertInto('users').values(user('u1')).execute()
      expect(await t.db.selectFrom('users').select('id').execute()).toEqual([{ id: 'u1' }])
      expect(t.database.url).toMatch(/^(sqlite|mysql):/)
    })
  })

  it('useTestDb() outside a running test explains itself', () => {
    expect(() => useTestDb().db).toThrow(/only while tests run/)
  })
})

describe('testClient', () => {
  const app = {
    request: async (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (path === '/empty') return new Response(null, { status: 204 })
      if (path === '/text') return new Response('plain', { status: 200 })
      return new Response(JSON.stringify({ method: init?.method, path, body: init?.body ?? null, type: headers.get('content-type'), auth: headers.get('authorization') }), { headers: { 'x-trace-id': 'trace-9' } })
    },
  }

  it('sends JSON, merges default headers, parses the answer and exposes the trace id', async () => {
    const api = testClient(app, { headers: { authorization: 'token-from-test' } })
    const res = await api.post('/things?x=1', { a: 1 })
    expect(res).toMatchObject({ status: 200, traceId: 'trace-9' })
    expect(res.body).toEqual({ method: 'POST', path: '/things?x=1', body: '{"a":1}', type: 'application/json', auth: 'token-from-test' })
    expect((await api.get('/x', { headers: { authorization: 'other' } })).body).toMatchObject({ method: 'GET', body: null, auth: 'other' })
    expect((await api.patch('/x', undefined, { raw: '{broken' })).body.body).toBe('{broken')
    expect((await api.delete('/empty')).body).toBeNull()
    expect((await api.get('/text')).body).toBe('plain')
    expect((await api.put('/x', {})).body.method).toBe('PUT')
  })
})

describe('playwright helpers', () => {
  // The helpers only use page.on() and page.route(); a stand-in page keeps this in the fast suite. The same helpers
  // run in a real browser in the fullstack combo of the kit gate (tests/e2e/api.spec.ts of the generated UI).
  function fakePage() {
    const listeners: Record<string, ((arg: any) => void)[]> = {}
    let router: { matches: (url: URL) => boolean; handler: (route: any) => Promise<void> } | undefined
    const page = {
      on(event: string, fn: (arg: any) => void) { (listeners[event] ??= []).push(fn) },
      async route(matches: (url: URL) => boolean, handler: (route: any) => Promise<void>) { router = { matches, handler } },
    }
    const emit = (event: string, arg: unknown) => { for (const fn of listeners[event] ?? []) fn(arg) }
    async function request(method: string, url: string, body?: string) {
      if (!router?.matches(new URL(url))) return 'passed through'
      let fulfilled: any
      await router.handler({
        request: () => ({ method: () => method, url: () => url, postData: () => body ?? null, postDataJSON: () => (body ? JSON.parse(body) : null) }),
        fulfill: async (response: any) => { fulfilled = { ...response, body: response.body ? JSON.parse(response.body) : null } },
      })
      return fulfilled
    }
    return { page: page as any, emit, request }
  }

  it('captureErrors collects page errors and console errors, and nothing else', () => {
    const { page, emit } = fakePage()
    const errors = captureErrors(page, { ignore: [/favicon/] })
    errors.assertNone()
    emit('console', { type: () => 'log', text: () => 'fine' })
    emit('console', { type: () => 'error', text: () => 'Failed to load favicon.ico' })
    errors.assertNone()
    emit('pageerror', new Error('boom'))
    emit('console', { type: () => 'error', text: () => 'bad thing' })
    expect(errors.errors).toEqual(['pageerror: boom', 'console: bad thing'])
    expect(() => errors.assertNone()).toThrow(/2 error\(s\):\npageerror: boom\nconsole: bad thing/)
  })

  it('stubApi answers stubbed calls in the standard envelopes, records them, and fails unknown calls with 501', async () => {
    const { page, request } = fakePage()
    const { calls } = await stubApi(page, {
      'GET /api/v1/items': list([{ id: '1' }], { total: 40 }),
      'GET /api/v1/items/1': one({ id: '1' }),
      'POST /api/v1/items': (req) => ({ status: 201, body: { data: { id: '2', ...(req.postDataJSON() as object) } } }),
      'DELETE /api/v1/items/1': failure(409, 'CONFLICT', 'in use'),
    })
    expect(await request('GET', 'http://ui.test/api/v1/items?limit=1')).toMatchObject({ status: 200, contentType: 'application/json', body: { data: [{ id: '1' }], meta: { limit: 50, offset: 0, total: 40 } } })
    expect((await request('GET', 'http://ui.test/api/v1/items/1')).body).toEqual({ data: { id: '1' } })
    expect(await request('POST', 'http://ui.test/api/v1/items', '{"name":"n"}')).toMatchObject({ status: 201, body: { data: { id: '2', name: 'n' } } })
    expect(await request('DELETE', 'http://ui.test/api/v1/items/1')).toMatchObject({ status: 409, body: { error: { code: 'CONFLICT', message: 'in use', traceId: 'e2e-stub' } } })
    expect(await request('GET', 'http://ui.test/api/v1/unknown')).toMatchObject({ status: 501, body: { error: { code: 'INTERNAL' } } })
    expect(await request('GET', 'http://ui.test/assets/app.js')).toBe('passed through')
    expect(calls.map((c) => `${c.method} ${c.path}${c.query}`)).toEqual(['GET /api/v1/items?limit=1', 'GET /api/v1/items/1', 'POST /api/v1/items', 'DELETE /api/v1/items/1', 'GET /api/v1/unknown'])
    expect(calls[2]!.body).toEqual({ name: 'n' })
  })
})
