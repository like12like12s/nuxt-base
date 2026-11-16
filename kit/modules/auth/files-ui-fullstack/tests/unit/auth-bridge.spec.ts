// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { PROXY_SECRET_HEADER, authBridgeFromEnv, createAuthBridge } from '../../server/kit/auth-bridge'

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

  it('one identity per request: a repeated identity header, or a user name with a comma, is not passed on', () => {
    const repeated: Record<string, string> = { 'x-authentik-username': 'alice, bob', accept: 'application/json' }
    expect(bridge(repeated, PROXY, ['X-Authentik-Username', 'alice', 'X-Authentik-Username', 'bob', 'Accept', 'application/json'])).toBe(false)
    expect(repeated).toEqual({ accept: 'application/json' })
    const comma: Record<string, string> = { 'x-authentik-username': 'alice, bob' }
    expect(bridge(comma, PROXY)).toBe(false)
    expect(comma).toEqual({})
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

  it('from the environment: both settings + the preset', () => {
    const on = authBridgeFromEnv({ AUTH_BRIDGE_TRUSTED_PROXIES: `${PROXY}, 198.51.100.0/24`, AUTH_PROXY_SECRET: SECRET, AUTH_HEADER_PRESET: 'remote' }, () => { throw new Error('nothing to report') })
    expect(on.describe()).toEqual({ active: true, trustedProxies: 2, secret: true, headers: ['remote-user', 'remote-email', 'remote-name', 'remote-groups'] })
    expect(on({ 'remote-user': 'alice' }, PROXY)).toBe(true)
  })
})
