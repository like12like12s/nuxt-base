// @vitest-environment node
// The auth bridge of a fullstack UI (kit/runtime/auth/bridge.ts), tested at the source — the same cases the generated
// UI test runs, plus: it and the API's own check (runtime/auth/proxy.ts) agree on header names and on the trust rule.
import { describe, expect, it } from 'vitest'
import { NEVER_IDENTITY as BRIDGE_NEVER_IDENTITY, PROXY_SECRET_HEADER, authBridgeFromEnv, createAuthBridge } from '../runtime/auth/bridge'
import { KNOWN_IDENTITY_HEADERS, NEVER_IDENTITY } from '../runtime/auth/proxy'

// The /api proxy of this UI is the only way a browser reaches the API. What it lets through decides who the API
// believes: identity headers count only when the request came from the forward-auth proxy (its TCP peer), and then —
// only then — the secret the API expects is added. See server/routes/api/[...path].ts.
const SECRET = 'bridge-secret-for-tests-0123456789'
const PROXY = '192.0.2.10'
const identity = () => ({ 'x-authentik-username': 'alice', 'x-authentik-uid': 'uid-alice', 'x-authentik-groups': 'app-admins', accept: 'application/json' })

describe('auth bridge', () => {
  const bridge = createAuthBridge({ trustedProxies: [PROXY, '198.51.100.0/24'], secret: SECRET })

  it('from the forward-auth proxy: the identity is passed on and the secret is added', () => {
    const headers: Record<string, string> = identity()
    expect(bridge(headers, PROXY)).toBe(true)
    expect(headers).toEqual({ ...identity(), [PROXY_SECRET_HEADER]: SECRET })
    expect(bridge({ ...identity() }, '::ffff:198.51.100.77')).toBe(true) // a CIDR range, an IPv4 peer on a dual-stack socket
  })

  it('from anyone else: identity headers and a guessed (or even the right) secret never reach the API', () => {
    for (const peer of ['203.0.113.5', '127.0.0.1', undefined, '']) {
      const headers: Record<string, string> = { ...identity(), [PROXY_SECRET_HEADER]: SECRET, authorization: 'Bearer kit_abc' }
      expect(bridge(headers, peer), String(peer)).toBe(false)
      expect(headers).toEqual({ accept: 'application/json', authorization: 'Bearer kit_abc' }) // a service token is the caller's own business
    }
  })

  it('a client-sent secret is replaced, never forwarded — also through the proxy', () => {
    const headers: Record<string, string> = { ...identity(), [PROXY_SECRET_HEADER]: 'guess' }
    bridge(headers, PROXY)
    expect(headers[PROXY_SECRET_HEADER]).toBe(SECRET)
    const upper: Record<string, string> = { 'X-Auth-Proxy-Secret': 'guess', 'X-Authentik-Username': 'mallory' }
    bridge(upper, '203.0.113.5')
    expect(upper).toEqual({})
  })

  it('header preset `remote`: Remote-* is passed on; the names of the other preset are removed even from the proxy', () => {
    const remote = createAuthBridge({ trustedProxies: [PROXY], secret: SECRET, preset: 'remote' })
    const headers: Record<string, string> = { 'remote-user': 'alice', 'remote-groups': 'app-admins', 'remote-email': 'a@example.com', 'x-authentik-username': 'mallory' }
    expect(remote(headers, PROXY)).toBe(true)
    expect(headers).toEqual({ 'remote-user': 'alice', 'remote-groups': 'app-admins', 'remote-email': 'a@example.com', [PROXY_SECRET_HEADER]: SECRET })
    const spoofed: Record<string, string> = { 'remote-user': 'mallory', 'remote-groups': 'app-admins' }
    expect(remote(spoofed, '203.0.113.5')).toBe(false)
    expect(spoofed).toEqual({})
    // and with the default preset a client cannot smuggle Remote-* through either
    const other: Record<string, string> = { 'remote-user': 'mallory', ...identity() }
    bridge(other, PROXY)
    expect(other).not.toHaveProperty('remote-user')
  })

  it('needs BOTH settings: with one missing nothing is passed on (fail closed), and it says so', () => {
    for (const env of [{ AUTH_BRIDGE_TRUSTED_PROXIES: PROXY }, { AUTH_PROXY_SECRET: SECRET }, {}]) {
      const said: string[] = []
      const off = authBridgeFromEnv(env, (message) => said.push(message))
      const headers: Record<string, string> = { ...identity(), [PROXY_SECRET_HEADER]: SECRET }
      expect(off(headers, PROXY)).toBe(false)
      expect(headers).toEqual({ accept: 'application/json' })
      expect(said.length).toBe(Object.keys(env).length ? 1 : 0)
    }
  })

  it('a setting that cannot be used turns the bridge off instead of trusting something else', () => {
    for (const env of [{ AUTH_BRIDGE_TRUSTED_PROXIES: 'proxy.internal', AUTH_PROXY_SECRET: SECRET }, { AUTH_BRIDGE_TRUSTED_PROXIES: PROXY, AUTH_PROXY_SECRET: 'short' }, { AUTH_BRIDGE_TRUSTED_PROXIES: PROXY, AUTH_PROXY_SECRET: SECRET, AUTH_HEADER_PRESET: 'nope' }]) {
      const said: string[] = []
      const off = authBridgeFromEnv(env, (message) => said.push(message))
      const headers: Record<string, string> = identity()
      expect(off(headers, PROXY)).toBe(false)
      expect(headers).toEqual({ accept: 'application/json' })
      expect(said.join('\n')).toMatch(/^auth bridge: off — /)
      expect(said.join('\n')).not.toContain(SECRET)
    }
  })

  // K-L5 (review 2): a second Remote-User from the trusted proxy reached the API as the subject "alice, bob".
  it('an identity header that is repeated, or a user name / uid / email with a comma, is not vouched for: nothing is passed on', () => {
    const remote = createAuthBridge({ trustedProxies: [PROXY], secret: SECRET, preset: 'remote' })
    const said: string[] = []
    const reporting = createAuthBridge({ trustedProxies: [PROXY], secret: SECRET, preset: 'remote', onAmbiguous: (header) => said.push(header) })
    const cases: [Record<string, string | string[]>, string[] | undefined][] = [
      // what Node hands over for a header sent twice: one joined value — and the raw list shows the repetition
      [{ 'remote-user': 'alice, bob', accept: 'x' }, ['Remote-User', 'alice', 'Remote-User', 'bob', 'Accept', 'x']],
      [{ 'remote-user': 'alice, bob', accept: 'x' }, undefined], // without rawHeaders the comma alone is enough
      [{ 'remote-user': ['alice', 'bob'], accept: 'x' }, undefined],
      [{ 'remote-user': 'alice', 'remote-email': 'a@example.com, b@example.com', accept: 'x' }, undefined],
      // groups / display name may contain commas — but not arrive twice
      [{ 'remote-user': 'alice', 'remote-groups': 'staff, app-admins', accept: 'x' }, ['remote-user', 'alice', 'remote-groups', 'staff', 'REMOTE-GROUPS', 'app-admins', 'accept', 'x']],
    ]
    for (const [headers, raw] of cases) {
      const copy = structuredClone(headers)
      expect(remote(copy, PROXY, raw), JSON.stringify(headers)).toBe(false)
      expect(copy, JSON.stringify(headers)).toEqual({ accept: 'x' }) // no identity, no secret: the API sees an anonymous request
    }
    reporting({ 'remote-user': 'alice, bob' }, PROXY)
    expect(said).toEqual(['remote-user'])
    // the uid of the authentik preset is a subject part too
    expect(bridge({ 'x-authentik-username': 'alice', 'x-authentik-uid': 'u1, u2' }, PROXY)).toBe(false)
    // one of each is the normal case; commas in the display name and in a single groups header are fine
    const ok: Record<string, string> = { 'remote-user': 'alice', 'remote-name': 'Doe, Alice', 'remote-groups': 'staff,app-admins' }
    expect(remote(ok, PROXY, ['Remote-User', 'alice', 'Remote-Name', 'Doe, Alice', 'Remote-Groups', 'staff,app-admins'])).toBe(true)
    expect(ok[PROXY_SECRET_HEADER]).toBe(SECRET)
  })

  // Info (review 2): the API refused these names, the bridge did not — it would have forwarded a client's own
  // Authorization / Cookie value as "who this is".
  it('a header that means something else on every request cannot be named as an identity header: the bridge stays off', () => {
    for (const name of ['authorization', 'Cookie', 'x-forwarded-for', 'host', 'user-agent', 'traceparent']) {
      expect(() => createAuthBridge({ trustedProxies: [PROXY], secret: SECRET, names: { username: name } }), name).toThrow(/cannot be used as an identity header/)
      const said: string[] = []
      const off = authBridgeFromEnv({ AUTH_BRIDGE_TRUSTED_PROXIES: PROXY, AUTH_PROXY_SECRET: SECRET, AUTH_HEADER_GROUPS: name }, (message) => said.push(message))
      const headers: Record<string, string> = { ...identity(), [name.toLowerCase()]: 'app-admins' }
      expect(off(headers, PROXY), name).toBe(false)
      expect(headers).not.toHaveProperty('x-authentik-username')
      expect(headers).not.toHaveProperty(PROXY_SECRET_HEADER)
      expect(said.join('\n')).toMatch(/^auth bridge: off — AUTH_HEADER_GROUPS/)
    }
  })

  it('from the environment: both settings + the preset', () => {
    const on = authBridgeFromEnv({ AUTH_BRIDGE_TRUSTED_PROXIES: `${PROXY}, 198.51.100.0/24`, AUTH_PROXY_SECRET: SECRET, AUTH_HEADER_PRESET: 'remote' }, () => { throw new Error('nothing to report') })
    expect(on.describe()).toEqual({ active: true, trustedProxies: 2, secret: true, headers: ['remote-user', 'remote-email', 'remote-name', 'remote-groups'] })
    expect(on({ 'remote-user': 'alice' }, PROXY)).toBe(true)
  })
})

// Finding #1: the bridge and the API are two halves of one rule. What the bridge lets through for a request must be
// exactly what makes the API believe it — and nothing a client sends on its own may survive the hop.
describe('bridge + API: one trust rule end to end', async () => {
  const { proxyAuth, identityHeaders, HEADER_PRESETS } = await import('../runtime/auth/proxy')
  const { HEADER_PRESETS: BRIDGE_PRESETS } = await import('../runtime/auth/bridge')
  const lookup = (headers: Record<string, string | string[] | undefined>) => (name: string) => { const v = headers[name]; return Array.isArray(v) ? v[0] : v }

  it('both sides know the same presets and header names', () => {
    expect(BRIDGE_PRESETS).toEqual(HEADER_PRESETS)
    expect([...BRIDGE_NEVER_IDENTITY].sort()).toEqual([...NEVER_IDENTITY].sort())
    expect([...KNOWN_IDENTITY_HEADERS].sort()).toEqual([...new Set(Object.values(BRIDGE_PRESETS).flatMap((set) => Object.values(set)))].sort())
  })

  it.each(['authentik', 'remote'])('preset %s: through the proxy the API gets the identity; from anywhere else it gets nothing it believes', (preset) => {
    const names = identityHeaders({ preset })
    const bridge = createAuthBridge({ trustedProxies: [PROXY], secret: SECRET, preset })
    const api = proxyAuth({ secret: SECRET, headers: names })
    const sent = () => ({ [names.username]: 'alice', ...(names.groups ? { [names.groups]: 'app-admins|staff' } : {}), ...(names.uid ? { [names.uid]: 'uid-alice' } : {}) }) as Record<string, string>

    const viaProxy = sent()
    bridge(viaProxy, PROXY)
    expect(api(lookup(viaProxy), '198.51.100.200')).toEqual({ kind: 'trusted', identity: { subject: names.uid ? 'uid-alice' : 'alice', username: 'alice', email: undefined, name: undefined, groups: ['app-admins', 'staff'] } })

    // a client that reaches the UI directly, sending everything it can think of — including the real secret
    const direct: Record<string, string> = { ...sent(), 'x-authentik-username': 'mallory', 'remote-user': 'mallory', [PROXY_SECRET_HEADER]: SECRET }
    bridge(direct, '203.0.113.5')
    expect(api(lookup(direct), '198.51.100.200')).toEqual({ kind: 'none' })
    expect(api.viaProxy(lookup(direct), '198.51.100.200')).toBe(false) // so no traceparent / forwarded address is believed either
    expect(api.viaProxy(lookup(viaProxy), '198.51.100.200')).toBe(true)
  })

  it('the API reads only the configured names: a header of the other preset is not an identity', () => {
    const api = proxyAuth({ secret: SECRET, headers: identityHeaders({ preset: 'remote' }) })
    expect(api(lookup({ 'x-authentik-username': 'mallory', [PROXY_SECRET_HEADER]: SECRET }), undefined)).toEqual({ kind: 'none' })
    expect(api(lookup({ 'remote-user': 'alice', 'remote-groups': 'a,b', [PROXY_SECRET_HEADER]: SECRET }), undefined)).toMatchObject({ kind: 'trusted', identity: { subject: 'alice', groups: ['a,b'] } })
    const comma = proxyAuth({ secret: SECRET, headers: identityHeaders({ preset: 'remote' }), groupsSeparator: ',' })
    expect(comma(lookup({ 'remote-user': 'alice', 'remote-groups': 'a, b', [PROXY_SECRET_HEADER]: SECRET }), undefined)).toMatchObject({ identity: { groups: ['a', 'b'] } })
    // still fail closed with nothing configured, whatever the names
    expect(proxyAuth({ headers: identityHeaders({ preset: 'remote' }) })(lookup({ 'remote-user': 'mallory' }), '127.0.0.1')).toEqual({ kind: 'rejected', reason: 'not-configured' })
  })

  // K-L5: the API's own half — it sees a repeated header only as the joined value
  it('the API refuses a user name, uid or email with a comma (a repeated header, joined) instead of reading it as one subject', () => {
    const api = proxyAuth({ secret: SECRET, headers: identityHeaders({ preset: 'remote' }) })
    const joined = new Headers({ [PROXY_SECRET_HEADER]: SECRET })
    joined.append('remote-user', 'alice')
    joined.append('remote-user', 'bob')
    expect(joined.get('remote-user')).toBe('alice, bob')
    expect(api((name) => joined.get(name) ?? undefined, undefined)).toEqual({ kind: 'rejected', reason: 'ambiguous-identity' })
    expect(api(lookup({ 'remote-user': 'alice', 'remote-email': 'a@example.com,b@example.com', [PROXY_SECRET_HEADER]: SECRET }), undefined)).toEqual({ kind: 'rejected', reason: 'ambiguous-identity' })
    const authentik = proxyAuth({ secret: SECRET })
    expect(authentik(lookup({ 'x-authentik-username': 'alice', 'x-authentik-uid': 'u1, u2', [PROXY_SECRET_HEADER]: SECRET }), undefined)).toEqual({ kind: 'rejected', reason: 'ambiguous-identity' })
    // not a way around the trust rule: without the secret it is the secret that is wrong
    expect(api(lookup({ 'remote-user': 'alice, bob' }), undefined)).toEqual({ kind: 'rejected', reason: 'bad-secret' })
    // a display name with a comma is one person
    expect(api(lookup({ 'remote-user': 'alice', 'remote-name': 'Doe, Alice', [PROXY_SECRET_HEADER]: SECRET }), undefined)).toMatchObject({ kind: 'trusted', identity: { subject: 'alice', name: 'Doe, Alice' } })
  })

  it('identityHeaders: defaults stay X-Authentik-*, single names override, and what cannot be an identity header stops the boot', () => {
    expect(identityHeaders()).toEqual(HEADER_PRESETS.authentik)
    expect(identityHeaders({ preset: '' })).toEqual(HEADER_PRESETS.authentik)
    expect(identityHeaders({ preset: 'Remote', groups: 'X-Forwarded-Groups' })).toEqual({ ...HEADER_PRESETS.remote, groups: 'x-forwarded-groups' })
    expect(identityHeaders({ uid: 'x-user-id' }).uid).toBe('x-user-id')
    for (const bad of [{ preset: 'okta' }, { username: 'authorization' }, { username: 'cookie' }, { username: 'x-forwarded-for' }, { username: 'bad name' }, { username: 'x-auth-proxy-secret' }, { groups: 'x-authentik-username' }, { email: 'a:b' }]) {
      expect(() => identityHeaders(bad), JSON.stringify(bad)).toThrow(/AUTH_HEADER_/)
    }
  })
})
