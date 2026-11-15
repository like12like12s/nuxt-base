// Auth of this app: the role x endpoint matrix, the rule that every route declares who may call it, and who is
// believed (the trusted proxy, service tokens — never bare headers). When you add a route, add it to MATRIX.
import { describe, expect, it } from 'vitest'
import { DEV_USER } from '../src/auth/index.js'
import { ROLES } from '../src/auth/roles.js'
import { routeRules, undeclaredRoutes } from '../src/kit/auth/guard.js'
import { AuthConfigError, PROXY_SECRET_HEADER } from '../src/kit/auth/proxy.js'
import { createServiceToken, revokeServiceToken } from '../src/kit/auth/tokens.js'
import { testClient } from '../src/kit/testing/client.js'
import { useApp } from './helpers.js'

const t = useApp()

const SECRET = 'proxy-secret-for-tests'
// Real mode: no dev user; the proxy is identified by the shared secret; groups map onto the app's roles.
const REAL = { AUTH_DEV_MODE: '0', AUTH_PROXY_SECRET: SECRET, AUTH_ROLE_MAP: JSON.stringify({ 'app-admins': ['admin'], 'app-editors': ['editor'] }) }
const fromProxy = (username: string, groups: string) => ({
  [PROXY_SECRET_HEADER]: SECRET,
  'x-authentik-username': username,
  'x-authentik-uid': `uid-${username}`,
  'x-authentik-email': `${username}@example.com`,
  'x-authentik-groups': groups,
})

function real() {
  const { app, lines } = t.build({}, REAL)
  const client = (headers: Record<string, string> = {}) => testClient(app, { headers })
  return { app, lines, client, anonymous: client() }
}

type Caller = 'anonymous' | 'no role' | 'editor' | 'admin'
const CALLERS: Record<Caller, Record<string, string>> = {
  anonymous: {},
  'no role': fromProxy('carol', 'some-other-group'),
  editor: fromProxy('erin', 'app-editors'),
  admin: fromProxy('alice', 'app-admins'),
}

// method + route (as declared) -> the status each caller gets. 404 / 400 = allowed in (the id or body is a dummy).
const MATRIX: Record<string, Record<Caller, number>> = {
  'GET /api/v1/items': { anonymous: 401, 'no role': 200, editor: 200, admin: 200 },
  'GET /api/v1/items/:id': { anonymous: 401, 'no role': 404, editor: 404, admin: 404 },
  'POST /api/v1/items': { anonymous: 401, 'no role': 403, editor: 400, admin: 400 },
  'PATCH /api/v1/items/:id': { anonymous: 401, 'no role': 403, editor: 400, admin: 400 },
  'DELETE /api/v1/items/:id': { anonymous: 401, 'no role': 403, editor: 403, admin: 404 },
  'GET /api/v1/me': { anonymous: 401, 'no role': 200, editor: 200, admin: 200 },
  // kit:anchor auth-matrix — `scaffold add resource` adds its routes above this line
}

describe('every route declares who may call it', () => {
  it('no route is without publicRoute() / requireAuth() / requireRole()', () => {
    expect(undeclaredRoutes(t.build().app)).toEqual([])
  })

  it('the matrix below covers every route (add a route = add its row)', () => {
    const declared = routeRules(t.build().app).map((route) => `${route.method} ${route.path}`)
    expect(Object.keys(MATRIX).sort()).toEqual(declared.sort())
  })

  it('a route added without a declaration is caught, and is not served', async () => {
    const { app, anonymous } = real()
    app.get('/api/v1/forgotten', (c) => c.json({ data: 'leak' }))
    expect(undeclaredRoutes(app)).toEqual(['GET /api/v1/forgotten'])
    const res = await anonymous.get('/api/v1/forgotten')
    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('leak')
  })

  it('also outside /api/v1: an undeclared route anywhere is refused at run time; the system routes stay public', async () => {
    const { app, anonymous, client } = real()
    app.get('/api/v2/secret', (c) => c.json({ data: 'leak' }))
    app.get('/admin/stats', (c) => c.json({ data: 'leak' }))
    for (const api of [anonymous, client(CALLERS.admin)]) {
      for (const path of ['/api/v2/secret', '/admin/stats']) {
        const res = await api.get(path)
        expect(res.status, path).toBe(500)
        expect(JSON.stringify(res.body)).not.toContain('leak')
      }
    }
    for (const path of ['/health/live', '/version', '/openapi.json']) expect((await anonymous.get(path)).status, path).toBe(200)
  })
})

describe('role x endpoint', () => {
  it.each(Object.entries(MATRIX))('%s', async (route, expected) => {
    const [method, pattern] = route.split(' ') as [string, string]
    const path = pattern.replace(/:[A-Za-z]+/g, 'none')
    const { client } = real()
    const got: Record<string, number> = {}
    for (const caller of Object.keys(CALLERS) as Caller[]) {
      const api = client(CALLERS[caller])
      const res = method === 'GET' ? await api.get(path) : method === 'DELETE' ? await api.delete(path) : await api[method.toLowerCase() as 'post'](path, {})
      got[caller] = res.status
      if (res.status === 401) expect(res.body.error.code).toBe('UNAUTHORIZED')
      if (res.status === 403) expect(res.body.error.code).toBe('FORBIDDEN')
    }
    expect(got).toEqual(expected)
  })
})

describe('who is believed', () => {
  it('identity headers without the proxy secret are rejected — and logged', async () => {
    const { client, lines } = real()
    const spoofed = { ...fromProxy('mallory', 'app-admins'), [PROXY_SECRET_HEADER]: 'guess' }
    expect((await client(spoofed).get('/api/v1/me')).status).toBe(401)
    const { [PROXY_SECRET_HEADER]: _none, ...bare } = spoofed
    expect((await client(bare).delete('/api/v1/items/none')).status).toBe(401)
    expect(lines.filter((l) => l.msg === 'forward-auth headers ignored')).toHaveLength(2)
    expect(await t.db.selectFrom('users').select('id').execute()).toEqual([])
  })

  it('without AUTH_PROXY_SECRET / AUTH_TRUSTED_PROXIES the headers are never believed (fail closed)', async () => {
    const { app } = t.build({}, { AUTH_DEV_MODE: '0', NODE_ENV: 'production' })
    expect((await testClient(app, { headers: fromProxy('alice', 'app-admins') }).get('/api/v1/me')).status).toBe(401)
  })

  it('a user from the proxy: /me shows the mapped roles, the row lands in `users`, writes are audited under the subject', async () => {
    const { client } = real()
    const admin = client(CALLERS.admin)
    const me = await admin.get('/api/v1/me')
    expect(me.body).toEqual({ data: { subject: 'uid-alice', name: 'alice', email: 'alice@example.com', roles: ['admin'], kind: 'user' } })
    expect((await t.db.selectFrom('users').select(['subject', 'roles']).execute())).toEqual([{ subject: 'uid-alice', roles: '["admin"]' }])
    const created = await admin.post('/api/v1/items', { name: 'By Alice' })
    expect(created.status).toBe(201)
    const audit = await t.db.selectFrom('audit').select(['actor', 'action']).where('action', '=', 'item.create').execute()
    expect(audit).toEqual([{ actor: 'uid-alice', action: 'item.create' }])
  })

  it('service tokens: Bearer works with the token\'s roles; revoked and expired ones are 401', async () => {
    const { client } = real()
    const editor = await createServiceToken(t.db, { name: 'sync-job', roles: ['editor'] })
    const bearer = (token: string) => client({ authorization: `Bearer ${token}` })
    expect((await bearer(editor.token).get('/api/v1/me')).body.data).toMatchObject({ subject: `service:${editor.id}`, name: 'sync-job', roles: ['editor'], kind: 'service' })
    expect((await bearer(editor.token).post('/api/v1/items', { name: 'By the job' })).status).toBe(201)
    expect((await bearer(editor.token).delete('/api/v1/items/none')).status).toBe(403)

    await revokeServiceToken(t.db, 'sync-job')
    expect((await bearer(editor.token).get('/api/v1/me')).status).toBe(401)
    const expired = await createServiceToken(t.db, { name: 'old', roles: ['admin'], expiresAt: '2020-01-01T00:00:00.000Z' })
    expect((await bearer(expired.token).get('/api/v1/me')).status).toBe(401)
    // only hashes are stored
    const stored = JSON.stringify(await t.db.selectFrom('service_tokens').selectAll().execute())
    expect(stored).not.toContain(editor.token)
  })
})

describe('configuration', () => {
  it('dev mode: every request is the dev user with every role', async () => {
    const res = await t.build().api.get('/api/v1/me')
    expect(res.body.data).toMatchObject({ subject: DEV_USER.subject, roles: [...ROLES] })
  })

  it('dev mode refuses to start in production', () => {
    expect(() => t.build({}, { NODE_ENV: 'production', AUTH_DEV_MODE: '1' })).toThrow(AuthConfigError)
    expect(() => t.build({}, { NODE_ENV: 'production', AUTH_DEV_MODE: '0' })).not.toThrow()
  })

  it('a role map that names an unknown role stops the boot', () => {
    expect(() => t.build({}, { ...REAL, AUTH_ROLE_MAP: '{"staff":["superuser"]}' })).toThrow(/not a role of this app/)
  })
})
