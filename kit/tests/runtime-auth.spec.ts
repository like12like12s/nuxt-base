// @vitest-environment node
// The locked auth runtime (kit/runtime/auth/**) at the source: who is believed, what each route demands, and the
// rule that a route without a declaration never ships. Runs on SQLite, and on MySQL when TEST_MYSQL_URL is set.
import { createRoute, z } from '@hono/zod-openapi'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApi, mountV1 } from '../runtime/api/app'
import { createLogger } from '../runtime/api/log'
import { runAuthCli } from '../runtime/auth/cli'
import { createAuth, publicRoute, requireAuth, requireRole, routeRules, undeclaredRoutes, type AuthOptions } from '../runtime/auth/guard'
import { AuthConfigError, PROXY_SECRET_HEADER, parseRoleMap, proxyAuth, rolesFor, safeEqual, trustedSources } from '../runtime/auth/proxy'
import { TOKEN_PREFIX, createServiceToken, hashToken, listServiceTokens, revokeServiceToken, verifyServiceToken } from '../runtime/auth/tokens'
import { findUser, upsertUser } from '../runtime/auth/users'
import { setClock, setIdGenerator } from '../runtime/db/clock'
import type { Migrations } from '../runtime/db/migrate'
import { baseMigration, type BaseTables } from '../runtime/db/schema'
import { testClient } from '../runtime/testing/client'
import { createTestDb, mysqlSkipNotice, mysqlTestUrl, type TestDb } from '../runtime/testing/test-db'

const migrations: Migrations = { '0001_base': baseMigration }
const ROLES = ['admin', 'editor'] as const
const ROLE_MAP = { 'app-admins': ['admin'], 'app-editors': ['editor'] } as const
const SECRET = 'proxy-secret-for-tests'

const MYSQL = mysqlTestUrl() !== null
const DIALECTS = MYSQL ? (['sqlite', 'mysql'] as const) : (['sqlite'] as const)
if (!MYSQL) mysqlSkipNotice('every MySQL case of kit/tests/runtime-auth.spec.ts (npm run gate:kit runs them)')

const open: TestDb<any>[] = []
async function testDb(dialect: 'sqlite' | 'mysql'): Promise<TestDb<BaseTables>> {
  const db = await createTestDb<BaseTables>({ label: 'auth', migrations, dialect })
  open.push(db)
  return db
}
afterAll(async () => { for (const db of open.splice(0)) await db.cleanup() })
afterEach(() => { setClock(); setIdGenerator() })

const header = (headers: Record<string, string>) => (name: string) => headers[name]
const authentik = (username: string, groups = '', extra: Record<string, string> = {}) => ({
  'x-authentik-username': username,
  'x-authentik-uid': `uid-${username}`,
  'x-authentik-email': `${username}@example.com`,
  'x-authentik-name': username.toUpperCase(),
  'x-authentik-groups': groups,
  ...extra,
})

describe('forward-auth: the headers are believed only when the request came through the proxy', () => {
  it('nothing configured = never believed (fail closed), whatever the headers say', () => {
    const read = proxyAuth({})
    expect(read(header(authentik('mallory', 'app-admins')), '127.0.0.1')).toEqual({ kind: 'rejected', reason: 'not-configured' })
    expect(read(header({}), '127.0.0.1')).toEqual({ kind: 'none' })
    expect(proxyAuth({ secret: '   ', trustedProxies: [] })(header(authentik('mallory')), '127.0.0.1')).toEqual({ kind: 'rejected', reason: 'not-configured' })
  })

  it('shared secret: missing, wrong and almost-right secrets are rejected; the right one yields the identity', () => {
    const read = proxyAuth({ secret: SECRET })
    const spoofed = authentik('mallory', 'app-admins')
    expect(read(header(spoofed), '127.0.0.1')).toEqual({ kind: 'rejected', reason: 'bad-secret' })
    for (const guess of ['', 'x', SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase()]) {
      expect(read(header({ ...spoofed, [PROXY_SECRET_HEADER]: guess }), '127.0.0.1'), guess).toEqual({ kind: 'rejected', reason: 'bad-secret' })
    }
    expect(read(header(authentik('alice', 'app-admins|other group', { [PROXY_SECRET_HEADER]: SECRET })), undefined)).toEqual({
      kind: 'trusted',
      identity: { subject: 'uid-alice', username: 'alice', email: 'alice@example.com', name: 'ALICE', groups: ['app-admins', 'other group'] },
    })
  })

  it('trusted source list: only the TCP peer counts — addresses, CIDR ranges, IPv4-mapped IPv6', () => {
    const read = proxyAuth({ trustedProxies: ['192.0.2.10', '198.51.100.0/24', '::1'] })
    const h = header(authentik('alice'))
    for (const ok of ['192.0.2.10', '198.51.100.7', '::ffff:198.51.100.7', '::1']) expect(read(h, ok).kind, ok).toBe('trusted')
    for (const bad of ['192.0.2.11', '203.0.113.5', '::2', undefined, '', 'not-an-ip']) expect(read(h, bad), String(bad)).toEqual({ kind: 'rejected', reason: 'untrusted-source' })
    // a client cannot talk its way in with a header that names a trusted address
    expect(read(header({ ...authentik('mallory'), 'x-forwarded-for': '192.0.2.10', 'x-real-ip': '192.0.2.10' }), '203.0.113.5').kind).toBe('rejected')
  })

  it('secret and source list together: both must hold', () => {
    const read = proxyAuth({ secret: SECRET, trustedProxies: ['192.0.2.10'] })
    const withSecret = header(authentik('alice', '', { [PROXY_SECRET_HEADER]: SECRET }))
    expect(read(withSecret, '192.0.2.10').kind).toBe('trusted')
    expect(read(withSecret, '203.0.113.5')).toEqual({ kind: 'rejected', reason: 'untrusted-source' })
    expect(read(header(authentik('alice')), '192.0.2.10')).toEqual({ kind: 'rejected', reason: 'bad-secret' })
  })

  it('the subject falls back to the username; a bad source list is a config error', () => {
    const read = proxyAuth({ secret: SECRET })
    const r = read(header({ 'x-authentik-username': 'bob', [PROXY_SECRET_HEADER]: SECRET }), undefined)
    expect(r).toEqual({ kind: 'trusted', identity: { subject: 'bob', username: 'bob', email: undefined, name: undefined, groups: [] } })
    expect(() => trustedSources(['proxy.example.com'])).toThrow(AuthConfigError)
    expect(() => trustedSources(['192.0.2.0/33'])).toThrow(/invalid prefix/)
  })

  it('safeEqual compares whole values, also of different length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    for (const other of ['abd', 'ab', 'abcd', '']) expect(safeEqual('abc', other)).toBe(false)
  })
})

describe('roles from groups', () => {
  it('maps groups through the config map, in the order the app declares its roles; unmapped groups grant nothing', () => {
    expect(rolesFor(['app-editors', 'app-admins', 'nobody'], ROLE_MAP, ROLES)).toEqual(['admin', 'editor'])
    expect(rolesFor(['nobody', 'admin'], ROLE_MAP, ROLES)).toEqual([]) // a group NAMED like a role is not that role
    expect(rolesFor([], ROLE_MAP, ROLES)).toEqual([])
  })

  it('AUTH_ROLE_MAP: JSON object, a string or a list per group, only known roles', () => {
    expect(parseRoleMap('{"authentik Admins":["admin","editor"],"staff":"editor"}', ROLES)).toEqual({ 'authentik Admins': ['admin', 'editor'], staff: ['editor'] })
    expect(parseRoleMap(undefined, ROLES)).toEqual({})
    expect(parseRoleMap('  ', ROLES)).toEqual({})
    expect(() => parseRoleMap('{not json', ROLES)).toThrow(AuthConfigError)
    expect(() => parseRoleMap('["admin"]', ROLES)).toThrow(/JSON object/)
    expect(() => parseRoleMap('{"staff":["superuser"]}', ROLES)).toThrow(/"superuser".*not a role of this app/)
    expect(() => parseRoleMap('{"staff":[1]}', ROLES)).toThrow(/role or a list of roles/)
  })
})

describe.each(DIALECTS)('users (%s)', (dialect) => {
  it('first sight inserts, changed details update, an unchanged user is neither written nor audited', async () => {
    const { db } = await testDb(dialect)
    const identity = { subject: 'uid-alice', username: 'alice', email: 'alice@example.com', name: 'Alice', groups: [] }
    const audit = () => db.selectFrom('audit').select(['action', 'actor', 'target']).orderBy('ts').orderBy('id').execute()

    const first = await upsertUser(db, identity, ['editor'])
    expect(first).toMatchObject({ subject: 'uid-alice', email: 'alice@example.com', name: 'Alice', roles: ['editor'] })
    expect(await audit()).toEqual([{ action: 'user.create', actor: 'uid-alice', target: `user:${first.id}` }])

    const row = () => db.selectFrom('users').selectAll().where('subject', '=', 'uid-alice').executeTakeFirstOrThrow()
    const before = await row()
    for (let i = 0; i < 3; i++) expect(await upsertUser(db, identity, ['editor'])).toEqual(first)
    expect(await row()).toEqual(before) // updatedAt untouched
    expect(await audit()).toHaveLength(1)

    const promoted = await upsertUser(db, { ...identity, email: 'a@example.com' }, ['admin', 'editor'])
    expect(promoted).toMatchObject({ id: first.id, email: 'a@example.com', roles: ['admin', 'editor'] })
    const rows = await db.selectFrom('audit').selectAll().where('action', '=', 'user.sync').execute()
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.before!).roles).toEqual(['editor'])
    expect(JSON.parse(rows[0]!.after!).roles).toEqual(['admin', 'editor'])
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(1)
    expect(await findUser(db, 'nobody')).toBeNull()
  })

  it('two first requests of the same user end with one row', async () => {
    const { db } = await testDb(dialect)
    const identity = { subject: 'uid-bob', username: 'bob', groups: [] }
    const [a, b] = await Promise.all([upsertUser(db, identity, []), upsertUser(db, identity, [])])
    expect(a.id).toBe(b.id)
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(1)
  })
})

describe.each(DIALECTS)('service tokens (%s)', (dialect) => {
  it('the token is random, shown once, and only its hash is stored', async () => {
    const { db } = await testDb(dialect)
    const a = await createServiceToken(db, { name: 'nightly-sync', roles: ['editor'] })
    const b = await createServiceToken(db, { name: 'nightly-sync', roles: ['editor'] })
    expect(a.token).toMatch(new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`))
    expect(a.token).not.toBe(b.token)

    const rows = await db.selectFrom('service_tokens').selectAll().orderBy('createdAt').execute()
    const stored = JSON.stringify(rows)
    expect(stored).not.toContain(a.token)
    expect(stored).not.toContain(a.token.slice(TOKEN_PREFIX.length))
    expect(rows.find((r) => r.id === a.id)!.hash).toBe(hashToken(a.token))
    expect(rows.find((r) => r.id === a.id)!.hash).toMatch(/^[0-9a-f]{64}$/)
    // neither the list nor the audit trail can leak a secret or a hash
    const exposed = JSON.stringify([await listServiceTokens(db), await db.selectFrom('audit').selectAll().execute()])
    for (const secret of [a.token, hashToken(a.token)]) expect(exposed).not.toContain(secret)
    expect((await db.selectFrom('audit').select('action').execute()).map((r) => r.action)).toEqual(['service_token.create', 'service_token.create'])
  })

  it('verify: the right token passes; unknown, tampered, foreign and empty ones do not', async () => {
    const { db } = await testDb(dialect)
    const { token, id } = await createServiceToken(db, { name: 'ci', roles: ['admin'] })
    expect(await verifyServiceToken(db, token)).toMatchObject({ ok: true, token: { id, name: 'ci', roles: ['admin'] } })
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')
    for (const bad of [flipped, token.toUpperCase(), token.slice(TOKEN_PREFIX.length), `${token}x`, '', TOKEN_PREFIX, hashToken(token)]) {
      expect(await verifyServiceToken(db, bad), bad).toEqual({ ok: false, reason: 'unknown' })
    }
  })

  it('expiry: valid until the instant it expires, then rejected', async () => {
    const { db } = await testDb(dialect)
    let at = Date.parse('2026-03-01T00:00:00.000Z')
    setClock(() => new Date(at))
    const { token } = await createServiceToken(db, { name: 'short', roles: [], expiresAt: '2026-03-02T00:00:00.000Z' })
    at = Date.parse('2026-03-01T23:59:59.999Z')
    expect((await verifyServiceToken(db, token)).ok).toBe(true)
    at = Date.parse('2026-03-02T00:00:00.000Z')
    expect(await verifyServiceToken(db, token)).toEqual({ ok: false, reason: 'expired' })
    await expect(createServiceToken(db, { name: 'bad', roles: [], expiresAt: 'tomorrow' })).rejects.toThrow(/not a date/)
    await expect(createServiceToken(db, { name: '  ', roles: [] })).rejects.toThrow(/needs a name/)
  })

  // L10: expiry is a string comparison with now() — a value with an offset expired hours early or late
  it('expiresAt is stored as UTC whatever form it was given in', async () => {
    const database = await testDb('sqlite')
    setClock(() => new Date('2026-06-01T00:30:00.000Z'))
    // 07:00 in Bangkok = 00:00 UTC: already past at 00:30 UTC, although the string "2026-06-01T07:…" sorts after now()
    const past = await createServiceToken(database.db, { name: 'offset', roles: [], expiresAt: '2026-06-01T07:00:00+07:00' })
    expect(past.expiresAt).toBe('2026-06-01T00:00:00.000Z')
    expect(await verifyServiceToken(database.db, past.token)).toEqual({ ok: false, reason: 'expired' })
    const future = await createServiceToken(database.db, { name: 'offset-2', roles: [], expiresAt: '2026-06-01T08:00:00+07:00' })
    expect(future.expiresAt).toBe('2026-06-01T01:00:00.000Z')
    expect((await verifyServiceToken(database.db, future.token)).ok).toBe(true)
    await expect(createServiceToken(database.db, { name: 'bad', roles: [], expiresAt: 'tomorrow-ish' })).rejects.toThrow(/not a date/)
  })

  it('revoke: by id or by name, at once, audited, and the row stays', async () => {
    const { db } = await testDb(dialect)
    const a = await createServiceToken(db, { name: 'worker', roles: ['editor'] })
    const b = await createServiceToken(db, { name: 'worker', roles: ['editor'] })
    const c = await createServiceToken(db, { name: 'other', roles: [] })
    expect((await revokeServiceToken(db, a.id)).map((t) => t.id)).toEqual([a.id])
    expect(await verifyServiceToken(db, a.token)).toEqual({ ok: false, reason: 'revoked' })
    expect((await verifyServiceToken(db, b.token)).ok).toBe(true)
    expect((await revokeServiceToken(db, 'worker')).map((t) => t.id)).toEqual([b.id])
    expect(await verifyServiceToken(db, b.token)).toEqual({ ok: false, reason: 'revoked' })
    expect((await verifyServiceToken(db, c.token)).ok).toBe(true)
    expect(await revokeServiceToken(db, 'worker')).toEqual([]) // nothing live left under that name
    expect(await db.selectFrom('service_tokens').select('id').execute()).toHaveLength(3)
    expect((await db.selectFrom('audit').select('action').where('action', '=', 'service_token.revoke').execute())).toHaveLength(2)
  })

  it('lastUsedAt is set on use and refreshed at most once a minute', async () => {
    const { db } = await testDb(dialect)
    let at = Date.parse('2026-03-01T00:00:00.000Z')
    setClock(() => new Date(at))
    const { token, id } = await createServiceToken(db, { name: 'busy', roles: [] })
    const lastUsed = async () => (await db.selectFrom('service_tokens').select('lastUsedAt').where('id', '=', id).executeTakeFirstOrThrow()).lastUsedAt
    expect(await lastUsed()).toBeNull()
    await verifyServiceToken(db, token)
    expect(await lastUsed()).toBe('2026-03-01T00:00:00.000Z')
    at += 59_000
    await verifyServiceToken(db, token)
    expect(await lastUsed()).toBe('2026-03-01T00:00:00.000Z')
    at += 1_000
    await verifyServiceToken(db, token)
    expect(await lastUsed()).toBe('2026-03-01T00:01:00.000Z')
  })

  it('the token commands: create prints the token once, list never does, revoke works, bad input is usage (2)', async () => {
    const database = await testDb(dialect)
    const lines: string[] = []
    const cli = (...argv: string[]) => {
      lines.length = 0
      return runAuthCli(argv, { url: database.url, roles: ROLES, out: (line) => lines.push(line) })
    }
    expect(await cli('token', 'create', '--name', 'deploy-bot', '--roles', 'editor,admin', '--days', '30')).toBe(0)
    const token = /^token: (\S+)$/m.exec(lines.join('\n'))![1]!
    expect(lines.join('\n')).toMatch(/created \S+ {2}name=deploy-bot {2}roles=editor,admin {2}expires=\d{4}-/)
    expect((await verifyServiceToken(database.db, token)).ok).toBe(true)

    expect(await cli('token', 'list')).toBe(0)
    expect(lines.join('\n')).toMatch(/active {3}name=deploy-bot/)
    expect(lines.join('\n')).not.toContain(token)

    expect(await cli('token', 'revoke', 'deploy-bot')).toBe(0)
    expect(await verifyServiceToken(database.db, token)).toEqual({ ok: false, reason: 'revoked' })
    expect(await cli('token', 'revoke', 'deploy-bot')).toBe(1)
    expect(await cli('token', 'list')).toBe(0)
    expect(lines.join('\n')).toMatch(/revoked {2}name=deploy-bot/)

    for (const bad of [[], ['token'], ['token', 'create'], ['token', 'create', '--name', 'x'], ['token', 'create', '--name', 'x', '--roles', 'root'],
      ['token', 'create', '--name', 'x', '--roles', 'admin', '--days', '0'], ['token', 'revoke'], ['token', 'list', 'extra'], ['user', 'list'], ['token', 'create', '--nope']]) {
      expect(await cli(...bad), bad.join(' ')).toBe(2)
    }
    expect(await database.db.selectFrom('service_tokens').select('id').execute()).toHaveLength(1)
  })
})

// --- the guard on a real app ----------------------------------------------------------------------------------------
const json = { 'application/json': { schema: z.object({ data: z.unknown() }) } }
const route = (method: 'get' | 'post' | 'delete', path: string, middleware?: any) =>
  createRoute({ method, path, ...(middleware ? { middleware: [middleware] as const } : {}), responses: { 200: { description: 'ok', content: json } } })

async function setup(overrides: Partial<AuthOptions<(typeof ROLES)[number]>> = {}, dialect: 'sqlite' | 'mysql' = 'sqlite') {
  const database = await testDb(dialect)
  const lines: Record<string, any>[] = []
  const logger = createLogger('info', (line) => lines.push(JSON.parse(line)), { service: 'svc', env: 'test' })
  const auth = createAuth({ db: database.db, roles: ROLES, roleMap: ROLE_MAP, proxy: { secret: SECRET }, env: 'test', logger, ...overrides })
  const app = createApi({ name: 'svc', version: '1.0.0', logger })
  app.use('*', auth.middleware)
  const who = (c: any) => c.json({ data: 'ok' }, 200)
  mountV1(app, (v1) => {
    v1.openapi(route('get', '/open', publicRoute()), who)
    v1.openapi(route('get', '/things', requireAuth()), who)
    v1.openapi(route('post', '/things', requireRole('admin', 'editor')), who)
    v1.openapi(route('delete', '/things/{id}', requireRole('admin')), who)
  })
  const as = (username: string, groups = '') => testClient(app, { headers: authentik(username, groups, { [PROXY_SECRET_HEADER]: SECRET }) })
  return { app, auth, database, db: database.db, lines, anonymous: testClient(app), as }
}

describe('route declarations', () => {
  const ENDPOINTS = [['GET', '/api/v1/open'], ['GET', '/api/v1/things'], ['POST', '/api/v1/things'], ['DELETE', '/api/v1/things/42']] as const
  // role x endpoint: what each kind of caller gets
  const MATRIX: Record<string, number[]> = {
    anonymous: [200, 401, 401, 401],
    'no role': [200, 200, 403, 403],
    editor: [200, 200, 200, 403],
    admin: [200, 200, 200, 200],
    'token: editor': [200, 200, 200, 403],
    'token: no role': [200, 200, 403, 403],
  }

  it.each(Object.entries(MATRIX))('%s -> 200 / 401 / 403 per endpoint', async (who, expected) => {
    const t = await setup()
    const token = async (roles: string[]) => testClient(t.app, { headers: { authorization: `Bearer ${(await createServiceToken(t.db, { name: 'svc', roles })).token}` } })
    const client =
      who === 'anonymous' ? t.anonymous
        : who === 'no role' ? t.as('carol', 'some-other-group')
          : who === 'editor' ? t.as('erin', 'app-editors')
            : who === 'admin' ? t.as('alice', 'app-admins')
              : who === 'token: editor' ? await token(['editor']) : await token([])
    const got: number[] = []
    for (const [method, path] of ENDPOINTS) {
      const res = await client[method.toLowerCase() as 'get'](path)
      got.push(res.status)
      if (res.status >= 400) expect(res.body.error).toMatchObject({ code: res.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', traceId: res.traceId })
    }
    expect(got).toEqual(expected)
  })

  it('the matrix covers every route the app has (a new route must be added to it)', async () => {
    const { app } = await setup()
    expect(routeRules(app).map((r) => [r.method, r.path, r.rule?.kind])).toEqual([
      ['GET', '/api/v1/open', 'public'],
      ['GET', '/api/v1/things', 'auth'],
      ['POST', '/api/v1/things', 'role'],
      ['DELETE', '/api/v1/things/:id', 'role'],
    ].sort((a, b) => (a[1] === b[1] ? a[0]!.localeCompare(b[0]!) : a[1]!.localeCompare(b[1]!))))
    expect(undeclaredRoutes(app)).toEqual([])
  })

  it('a route without a declaration is listed by undeclaredRoutes() and answers 500 instead of running', async () => {
    const t = await setup()
    let ran = false
    mountV1(t.app, (v1) => {
      v1.openapi(route('get', '/forgotten'), (c) => { ran = true; return c.json({ data: 'leak' }, 200) })
      v1.get('/plain-hono', (c) => { ran = true; return c.json({ data: 'leak' }) })
    })
    expect(undeclaredRoutes(t.app)).toEqual(['GET /api/v1/forgotten', 'GET /api/v1/plain-hono'])
    for (const path of ['/api/v1/forgotten', '/api/v1/plain-hono']) {
      for (const client of [t.anonymous, t.as('alice', 'app-admins')]) {
        const res = await client.get(path)
        expect(res.status).toBe(500)
        expect(JSON.stringify(res.body)).not.toContain('leak')
      }
    }
    expect(ran).toBe(false)
    expect(t.lines.filter((l) => l.msg === 'route without an auth declaration — refused').length).toBe(4)
    // an unknown path is still a plain 404
    expect((await t.anonymous.get('/api/v1/nope')).status).toBe(404)
  })

  it('a wildcard handler that answers without a declaration: its answer is withheld (500), a pass-through one is fine', async () => {
    const t = await setup()
    t.app.use('/api/v1/things', async (c, next) => { c.header('x-seen', 'yes'); await next() }) // ordinary middleware
    t.app.use('/api/v1/wild/*', (c) => c.json({ data: 'leak' }))
    const res = await t.as('alice', 'app-admins').get('/api/v1/wild/anything')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error', traceId: res.traceId } })
    expect(t.lines.some((l) => l.msg === 'answer from a handler without an auth declaration — withheld')).toBe(true)
    expect((await t.as('alice', 'app-admins').get('/api/v1/things')).status).toBe(200)
    expect((await t.anonymous.get('/api/v1/nope')).status).toBe(404)
    expect((await t.anonymous.get('/api/v1/things')).status).toBe(401) // a refusal of a declared route is untouched
  })

  // M13 (review t1097): the runtime refusal only covered /api/v1/*, and "declared" was true when ANY matched route
  // had a declaration — so an undeclared handler in front of a declared one ran.
  it('fail closed on every path: an undeclared route outside /api/v1 is refused too; the system routes stay public', async () => {
    const t = await setup()
    let ran = 0
    t.app.get('/api/v2/secret', (c) => { ran++; return c.json({ data: 'leak' }) })
    t.app.get('/admin/stats', (c) => { ran++; return c.json({ data: 'leak' }) })
    t.app.post('/hooks/incoming', (c) => { ran++; return c.json({ data: 'leak' }) })
    t.app.get('/admin/ok', requireRole('admin'), (c) => c.json({ data: 'ok' })) // declared, outside /api/v1
    expect(undeclaredRoutes(t.app)).toEqual(['GET /admin/stats', 'GET /api/v2/secret', 'POST /hooks/incoming'])
    for (const client of [t.anonymous, t.as('alice', 'app-admins')]) {
      for (const res of [await client.get('/api/v2/secret'), await client.get('/admin/stats'), await client.post('/hooks/incoming', {})]) {
        expect(res.status).toBe(500)
        expect(JSON.stringify(res.body)).not.toContain('leak')
      }
    }
    expect(ran).toBe(0)
    expect(t.lines.filter((l) => l.msg === 'route without an auth declaration — refused').map((l) => l.path)).toEqual(['/api/v2/secret', '/admin/stats', '/hooks/incoming', '/api/v2/secret', '/admin/stats', '/hooks/incoming'])
    for (const path of ['/health/live', '/health/ready', '/version', '/openapi.json']) expect((await t.anonymous.get(path)).status, path).toBe(200)
    expect((await t.anonymous.get('/nope')).status).toBe(404)
    // a declared route outside /api/v1 works like any other
    expect((await t.anonymous.get('/admin/ok')).status).toBe(401)
    expect((await t.as('alice', 'app-admins').get('/admin/ok')).status).toBe(200)
  })

  it('the declaration that counts is the one of the handler that runs: an undeclared route in front of a declared one is refused', async () => {
    const t = await setup()
    let ran = false
    mountV1(t.app, (v1) => {
      v1.get('/late/:id', (c) => { ran = true; return c.json({ data: 'leak' }) }) // matches first, declares nothing
      v1.openapi(route('get', '/late/special', requireAuth()), (c) => c.json({ data: 'ok' }, 200))
    })
    // the static list agrees with the runtime: a declaration that is not the route's FIRST handler does not count
    t.app.get('/second', async (_c, next) => next(), requireAuth(), (c) => c.json({ data: 'ok' }))
    expect(undeclaredRoutes(t.app)).toEqual(['GET /api/v1/late/:id', 'GET /second'])
    const res = await t.as('alice', 'app-admins').get('/api/v1/late/special')
    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('leak')
    expect(ran).toBe(false)
    expect((await t.as('alice', 'app-admins').get('/second')).status).toBe(500)
  })

  it('paths in `ignore` are not the guard\'s business, wherever the middleware is mounted', async () => {
    const database = await testDb('sqlite')
    const auth = createAuth({ db: database.db, roles: ROLES, roleMap: ROLE_MAP, proxy: { secret: SECRET }, env: 'test', ignore: ['/metrics'] })
    const app = createApi({ name: 'svc', version: '1.0.0', logger: createLogger('error', () => undefined, { service: 'svc', env: 'test' }) })
    app.use('*', auth.middleware)
    app.get('/metrics', (c) => c.text('up 1'))
    app.get('/other', (c) => c.text('leak'))
    expect((await testClient(app).get('/metrics')).status).toBe(200)
    expect((await testClient(app).get('/other')).status).toBe(500)
  })

  it('requireRole() without a role is refused when the route is defined', () => {
    expect(() => (requireRole as any)()).toThrow(/at least one role/)
  })
})

describe('who is believed', () => {
  it('spoofed identity headers are rejected: no secret, wrong secret — and the attempt is logged', async () => {
    const t = await setup()
    for (const extra of [{}, { [PROXY_SECRET_HEADER]: 'guess' }]) {
      const res = await testClient(t.app, { headers: authentik('mallory', 'app-admins', extra) }).delete('/api/v1/things/1')
      expect(res.status).toBe(401)
    }
    expect(t.lines.filter((l) => l.msg === 'forward-auth headers ignored').map((l) => [l.level, l.reason])).toEqual([['warn', 'bad-secret'], ['warn', 'bad-secret']])
    expect(await t.db.selectFrom('users').select('id').execute()).toEqual([]) // nobody was created
  })

  it('without proxy config the headers are never believed; service tokens still work', async () => {
    const t = await setup({ proxy: {} })
    expect(t.auth.describe()).toEqual({ mode: 'tokens-only', proxySecret: false, trustedProxies: 0 })
    expect((await t.as('alice', 'app-admins').get('/api/v1/things')).status).toBe(401)
    const { token } = await createServiceToken(t.db, { name: 'svc', roles: ['admin'] })
    expect((await testClient(t.app, { headers: { authorization: `Bearer ${token}` } }).delete('/api/v1/things/1')).status).toBe(200)
  })

  it('a trusted source list uses the TCP peer of the request', async () => {
    let peer: string | undefined = '203.0.113.5'
    const t = await setup({ proxy: { trustedProxies: ['192.0.2.10'] }, remoteAddress: () => peer })
    const client = testClient(t.app, { headers: { ...authentik('alice', 'app-admins'), 'x-forwarded-for': '192.0.2.10' } })
    expect((await client.get('/api/v1/things')).status).toBe(401)
    peer = '192.0.2.10'
    expect((await client.get('/api/v1/things')).status).toBe(200)
    // default (no injected peer): an in-process request has no socket, so it is not trusted
    const noSocket = await setup({ proxy: { trustedProxies: ['192.0.2.10'] } })
    expect((await testClient(noSocket.app, { headers: authentik('alice', 'app-admins') }).get('/api/v1/things')).status).toBe(401)
  })

  it('viaProxy(): true only for a request that came through the trusted proxy — with or without an identity', async () => {
    const t = await setup()
    const seen: boolean[] = []
    t.app.get('/probe', publicRoute(), (c) => { seen.push(t.auth.viaProxy(c)); return c.json({ data: 'ok' }) })
    await testClient(t.app, { headers: { [PROXY_SECRET_HEADER]: SECRET } }).get('/probe')
    await t.as('alice', 'app-admins').get('/probe')
    await t.anonymous.get('/probe')
    await testClient(t.app, { headers: { [PROXY_SECRET_HEADER]: 'guess' } }).get('/probe')
    expect(seen).toEqual([true, true, false, false])
    const unconfigured = await setup({ proxy: {} })
    unconfigured.app.get('/probe', publicRoute(), (c) => c.json({ data: unconfigured.auth.viaProxy(c) }))
    expect((await unconfigured.as('alice', 'app-admins').get('/probe')).body.data).toBe(false)
  })

  it('a trusted user is upserted with the mapped roles and becomes the audit actor', async () => {
    const t = await setup()
    expect((await t.as('alice', 'app-admins|app-editors').get('/api/v1/things')).status).toBe(200)
    expect(await findUser(t.db, 'uid-alice')).toMatchObject({ email: 'alice@example.com', name: 'ALICE', roles: ['admin', 'editor'] })
    // groups changed at the identity provider -> the next request has the new roles
    expect((await t.as('alice', '').delete('/api/v1/things/1')).status).toBe(403)
    expect((await findUser(t.db, 'uid-alice'))!.roles).toEqual([])
  })

  it('a bad, expired or revoked token is 401 — on public routes too, never a silent anonymous', async () => {
    const t = await setup()
    const { token } = await createServiceToken(t.db, { name: 'svc', roles: ['admin'] })
    const bearer = (value: string) => testClient(t.app, { headers: { authorization: `Bearer ${value}` } })
    expect((await bearer(token).get('/api/v1/open')).status).toBe(200)
    expect((await bearer(`${TOKEN_PREFIX}${'x'.repeat(43)}`).get('/api/v1/open')).status).toBe(401)
    await revokeServiceToken(t.db, 'svc')
    const res = await bearer(token).get('/api/v1/things')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHORIZED')
    expect(t.lines.filter((l) => l.msg === 'service token rejected').map((l) => l.reason)).toEqual(['unknown', 'revoked'])
    expect(JSON.stringify(t.lines)).not.toContain(token)
    // a bearer that is not one of ours is ignored (it may belong to a proxy in front)
    expect((await bearer('someone-elses-credential').get('/api/v1/open')).status).toBe(200)
  })
})

describe('dev mode', () => {
  const devUser = { subject: 'dev', name: 'Dev User', roles: [...ROLES] }

  it('every request is the fixed dev user', async () => {
    const t = await setup({ devUser, proxy: {} })
    expect(t.auth.describe().mode).toBe('dev-user')
    expect(t.lines.filter((l) => l.level === 'warn' && /AUTH_DEV_MODE is on/.test(l.msg))).toHaveLength(1) // loud at boot
    expect((await t.anonymous.delete('/api/v1/things/1')).status).toBe(200)
  })

  it('refuses to start with NODE_ENV=production', async () => {
    const database = await testDb('sqlite')
    const make = (env: string) => createAuth({ db: database.db, roles: ROLES, roleMap: {}, proxy: {}, env, devUser })
    expect(() => make('production')).toThrow(AuthConfigError)
    expect(() => make('production')).toThrow(/AUTH_DEV_MODE.*refusing to start/)
    expect(() => make('development')).not.toThrow()
    expect(() => createAuth({ db: database.db, roles: ROLES, roleMap: {}, proxy: {}, env: 'production' })).not.toThrow()
  })
})
