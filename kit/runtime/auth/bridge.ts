// DO NOT EDIT — locked file from the nuxt-base kit (runtime/auth/bridge.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// The hop between the forward-auth proxy and the API, in a fullstack app: browser -> proxy -> UI server -> API.
// The API believes identity headers only together with the shared secret (`x-auth-proxy-secret`) — but the UI server
// is what the proxy talks to, and many forward-auth proxies add identity headers and no secret. So the UI server's
// /api proxy carries the bridge. For every request it forwards to the API:
//   1. whatever the client sent under an identity header name or as the secret is REMOVED — always, first
//   2. only when the request's TCP peer is the configured forward-auth proxy (AUTH_BRIDGE_TRUSTED_PROXIES) are the
//      identity headers the proxy set passed on, and the secret (AUTH_PROXY_SECRET) added
// So the secret reaches the API exactly when the request provably came through the proxy — the same rule the API
// applies itself (src/kit/auth/proxy.ts): a trusted peer, never a header a client can type. Both settings are needed;
// with either missing nothing is ever passed on (fail closed) and the API sees an anonymous request, or the caller's
// own `Authorization: Bearer` service token, which is never touched.
// Self-contained (node:net only): it is copied into the UI server as is.
import { BlockList, isIP } from 'node:net'

export const PROXY_SECRET_HEADER = 'x-auth-proxy-secret'

export const HEADER_PRESETS: Record<string, Record<string, string>> = {
  authentik: { username: 'x-authentik-username', uid: 'x-authentik-uid', email: 'x-authentik-email', name: 'x-authentik-name', groups: 'x-authentik-groups' },
  remote: { username: 'remote-user', email: 'remote-email', name: 'remote-name', groups: 'remote-groups' },
}

export class AuthBridgeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthBridgeConfigError'
  }
}

export interface AuthBridgeOptions {
  /** Addresses / CIDR ranges of the forward-auth proxy as THIS server sees the TCP peer. Empty = never pass on. */
  trustedProxies?: readonly string[]
  /** The secret the API expects (AUTH_PROXY_SECRET, >= 16 characters). Empty = never pass on. */
  secret?: string
  /** Header preset of the proxy: `authentik` (default) or `remote` — the same value the API is configured with. */
  preset?: string
  /** Single header names that differ from the preset (AUTH_HEADER_USERNAME, …). */
  names?: Partial<Record<'username' | 'uid' | 'email' | 'name' | 'groups', string>>
}

export type RequestHeaders = Record<string, string | string[] | undefined>

export interface AuthBridge {
  /** Rewrites `headers` (lower-case keys, as Node gives them) in place. Returns whether the request was vouched for. */
  (headers: RequestHeaders, peer: string | undefined): boolean
  /** How it is set up — for the boot log, never a secret. */
  describe(): { active: boolean; trustedProxies: number; secret: boolean; headers: string[] }
}

const csv = (value: string | undefined): string[] => (value ?? '').split(',').map((part) => part.trim()).filter(Boolean)
const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

function matcher(entries: readonly string[]): (address: string | undefined) => boolean {
  const list = new BlockList()
  for (const entry of entries) {
    const [address = '', prefix] = entry.split('/')
    const family = isIP(address)
    if (!family) throw new AuthBridgeConfigError(`AUTH_BRIDGE_TRUSTED_PROXIES: "${entry}" is not an IP address or CIDR range`)
    const type = family === 4 ? 'ipv4' : 'ipv6'
    if (prefix === undefined) list.addAddress(address, type)
    else {
      const bits = Number(prefix)
      if (!Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) throw new AuthBridgeConfigError(`AUTH_BRIDGE_TRUSTED_PROXIES: "${entry}" has an invalid prefix length`)
      list.addSubnet(address, bits, type)
    }
  }
  return (address) => {
    if (!address) return false
    // An IPv4 peer on a dual-stack socket shows up as ::ffff:a.b.c.d
    const plain = address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address
    const family = isIP(plain)
    return family !== 0 && list.check(plain, family === 4 ? 'ipv4' : 'ipv6')
  }
}

export function createAuthBridge(options: AuthBridgeOptions = {}): AuthBridge {
  const preset = (options.preset?.trim() || 'authentik').toLowerCase()
  if (!Object.hasOwn(HEADER_PRESETS, preset)) throw new AuthBridgeConfigError(`AUTH_HEADER_PRESET: "${options.preset}" is not a preset (${Object.keys(HEADER_PRESETS).join(', ')})`)
  const names: Record<string, string> = { ...HEADER_PRESETS[preset] }
  for (const [part, given] of Object.entries(options.names ?? {})) {
    const name = given?.trim().toLowerCase()
    if (!name) continue
    if (!HEADER_NAME.test(name) || name === PROXY_SECRET_HEADER) throw new AuthBridgeConfigError(`AUTH_HEADER_${part.toUpperCase()}: "${given}" cannot be used as an identity header`)
    names[part] = name
  }
  const passOn = new Set(Object.values(names))
  // Removed from every request, trusted or not, unless it is one of the names the proxy is configured to use: the
  // names of every preset — a client must not be able to reach the API with ANY of them.
  const known = new Set([...Object.values(HEADER_PRESETS).flatMap((set) => Object.values(set)), ...passOn])

  const entries = [...(options.trustedProxies ?? [])].map((entry) => entry.trim()).filter(Boolean)
  const secret = options.secret?.trim() ?? ''
  if (secret && secret.length < 16) throw new AuthBridgeConfigError('AUTH_PROXY_SECRET must be at least 16 characters')
  const fromProxy = entries.length ? matcher(entries) : () => false
  const active = entries.length > 0 && secret.length > 0

  const bridge = ((headers: RequestHeaders, peer: string | undefined): boolean => {
    const trusted = active && fromProxy(peer)
    for (const header of Object.keys(headers)) {
      const name = header.toLowerCase()
      if (name === PROXY_SECRET_HEADER) delete headers[header]
      else if (known.has(name) && !(trusted && passOn.has(name))) delete headers[header]
    }
    if (trusted) headers[PROXY_SECRET_HEADER] = secret
    return trusted
  }) as AuthBridge
  bridge.describe = () => ({ active, trustedProxies: entries.length, secret: secret.length > 0, headers: [...passOn] })
  return bridge
}

/**
 * The bridge from the UI server's environment: AUTH_BRIDGE_TRUSTED_PROXIES, AUTH_PROXY_SECRET, AUTH_HEADER_PRESET and
 * AUTH_HEADER_USERNAME / _UID / _EMAIL / _NAME / _GROUPS. A setting that cannot be used does not stop the UI from
 * serving pages: the bridge then passes nothing on (every identity header and the secret are still removed), and says
 * so once through `report`.
 */
export function authBridgeFromEnv(env: Record<string, string | undefined> = process.env, report: (message: string) => void = (message) => console.error(message)): AuthBridge {
  const options: AuthBridgeOptions = {
    trustedProxies: csv(env.AUTH_BRIDGE_TRUSTED_PROXIES),
    secret: env.AUTH_PROXY_SECRET,
    preset: env.AUTH_HEADER_PRESET,
    names: { username: env.AUTH_HEADER_USERNAME, uid: env.AUTH_HEADER_UID, email: env.AUTH_HEADER_EMAIL, name: env.AUTH_HEADER_NAME, groups: env.AUTH_HEADER_GROUPS },
  }
  try {
    const bridge = createAuthBridge(options)
    const { active, trustedProxies, secret } = bridge.describe()
    if (!active && (trustedProxies > 0 || secret)) report(`auth bridge: off — it needs BOTH AUTH_BRIDGE_TRUSTED_PROXIES and AUTH_PROXY_SECRET (set: ${trustedProxies > 0 ? 'AUTH_BRIDGE_TRUSTED_PROXIES' : 'AUTH_PROXY_SECRET'}); identities from the proxy are not passed on to the API`)
    return bridge
  } catch (error) {
    report(`auth bridge: off — ${error instanceof Error ? error.message : String(error)}; identities from the proxy are not passed on to the API`)
    // Fail closed: strip everything, vouch for nothing.
    return createAuthBridge({})
  }
}
