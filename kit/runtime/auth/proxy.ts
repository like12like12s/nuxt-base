// DO NOT EDIT — locked file from the nuxt-base kit (runtime/auth/proxy.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Identity from a forward-auth proxy (a reverse proxy that asks the identity provider before it forwards). The proxy
// authenticates the browser and adds identity headers to the request it forwards. Which headers is configuration:
//   preset `authentik` (default)   X-Authentik-Username / -Uid / -Email / -Name / -Groups
//   preset `remote`                Remote-User / Remote-Email / Remote-Name / Remote-Groups (no uid: the user name is
//                                  the stable subject)
//   or any single name on its own (identityHeaders()).
// Anyone who can reach this API directly can send the same headers — so they are believed ONLY when the request
// provably came through the proxy:
//   secret           the proxy adds `x-auth-proxy-secret: <AUTH_PROXY_SECRET>` (and strips it from client requests)
//   trustedProxies   the TCP peer is one of these addresses / CIDR ranges (AUTH_TRUSTED_PROXIES)
// Whatever is configured must hold (both = both). Nothing configured = the headers are never believed (fail closed).
import { createHash, timingSafeEqual } from 'node:crypto'
import { BlockList, isIP } from 'node:net'

export const PROXY_SECRET_HEADER = 'x-auth-proxy-secret'
export const IDENTITY_HEADERS = ['x-authentik-username', 'x-authentik-uid', 'x-authentik-email', 'x-authentik-name', 'x-authentik-groups'] as const

/** Which request header carries which part of the identity (lower-case). Only `username` is mandatory. */
export interface IdentityHeaderNames {
  username: string
  uid?: string
  email?: string
  name?: string
  groups?: string
}

export const HEADER_PRESETS = {
  authentik: { username: 'x-authentik-username', uid: 'x-authentik-uid', email: 'x-authentik-email', name: 'x-authentik-name', groups: 'x-authentik-groups' },
  remote: { username: 'remote-user', email: 'remote-email', name: 'remote-name', groups: 'remote-groups' },
} as const satisfies Record<string, IdentityHeaderNames>
export type HeaderPreset = keyof typeof HEADER_PRESETS

/** Every header name any preset uses — what a hop in front of the API strips from a request it does not trust. */
export const KNOWN_IDENTITY_HEADERS: readonly string[] = [...new Set(Object.values(HEADER_PRESETS).flatMap((names) => Object.values(names)))]

const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
// Headers that mean something else on every request: naming one of them as an identity header would let any client
// (or any ordinary proxy) "sign in" by sending it.
const NEVER_IDENTITY = new Set(['authorization', 'cookie', 'host', 'user-agent', 'referer', 'origin', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'traceparent', 'content-type'])

/**
 * The identity header names from configuration: a preset (AUTH_HEADER_PRESET, default `authentik`) with any single
 * name overridden (AUTH_HEADER_USERNAME, …_UID, …_EMAIL, …_NAME, …_GROUPS). Throws AuthConfigError on an unknown
 * preset or a name that is not a plain header name — a typo must stop the boot, not quietly accept nobody.
 */
export function identityHeaders(options: { preset?: string; username?: string; uid?: string; email?: string; name?: string; groups?: string } = {}): IdentityHeaderNames {
  const preset = (options.preset?.trim() || 'authentik').toLowerCase()
  if (!Object.hasOwn(HEADER_PRESETS, preset)) throw new AuthConfigError(`AUTH_HEADER_PRESET: "${options.preset}" is not a preset (${Object.keys(HEADER_PRESETS).join(', ')})`)
  const names: IdentityHeaderNames = { ...HEADER_PRESETS[preset as HeaderPreset] }
  for (const key of ['username', 'uid', 'email', 'name', 'groups'] as const) {
    const given = options[key]?.trim().toLowerCase()
    if (!given) continue
    if (!HEADER_NAME.test(given) || NEVER_IDENTITY.has(given) || given === PROXY_SECRET_HEADER) throw new AuthConfigError(`AUTH_HEADER_${key.toUpperCase()}: "${options[key]}" cannot be used as an identity header`)
    names[key] = given
  }
  const used = Object.values(names)
  if (new Set(used).size !== used.length) throw new AuthConfigError('AUTH_HEADER_*: two parts of the identity are read from the same header')
  return names
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthConfigError'
  }
}

export interface ProxyTrust {
  secret?: string
  trustedProxies?: readonly string[]
  /** Which headers carry the identity. Default: the `authentik` preset. */
  headers?: IdentityHeaderNames
  /** What separates the entries of the groups header. Default `|` (set `,` for a proxy that sends a comma list). */
  groupsSeparator?: string
}

export interface ProxyIdentity {
  /** Stable id at the identity provider (Authentik uid; the username when no uid is sent). */
  subject: string
  username: string
  email?: string
  name?: string
  groups: string[]
}

const digest = (value: string) => createHash('sha256').update(value).digest()
/** Compare two secrets without leaking, through timing, how much of a guess was right (or its length). */
export const safeEqual = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b))

/** `192.0.2.10, 198.51.100.0/24, ::1` -> a matcher for the TCP peer address. Throws AuthConfigError on a bad entry. */
export function trustedSources(entries: readonly string[]): (address: string | undefined) => boolean {
  const list = new BlockList()
  for (const raw of entries) {
    const entry = raw.trim()
    if (!entry) continue
    const [address = '', prefix] = entry.split('/')
    const family = isIP(address)
    if (!family) throw new AuthConfigError(`AUTH_TRUSTED_PROXIES: "${entry}" is not an IP address or CIDR range`)
    const type = family === 4 ? 'ipv4' : 'ipv6'
    if (prefix === undefined) list.addAddress(address, type)
    else {
      const bits = Number(prefix)
      if (!Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) throw new AuthConfigError(`AUTH_TRUSTED_PROXIES: "${entry}" has an invalid prefix length`)
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

export const csv = (value: string | undefined): string[] => (value ?? '').split(',').map((part) => part.trim()).filter(Boolean)

export type ProxyResult =
  | { kind: 'none' } // no identity headers on the request
  | { kind: 'trusted'; identity: ProxyIdentity }
  | { kind: 'rejected'; reason: 'not-configured' | 'bad-secret' | 'untrusted-source' }

/** Build the check once (it validates the config); call it per request. */
export function proxyAuth(trust: ProxyTrust) {
  const secret = trust.secret?.trim() || undefined
  const sources = trust.trustedProxies?.length ? trustedSources(trust.trustedProxies) : undefined
  const configured = Boolean(secret || sources)
  const names = trust.headers ?? HEADER_PRESETS.authentik
  const separator = trust.groupsSeparator || '|'
  const refusal = (header: (name: string) => string | undefined, remoteAddress: string | undefined): 'not-configured' | 'bad-secret' | 'untrusted-source' | null => {
    if (!configured) return 'not-configured'
    if (secret && !safeEqual(header(PROXY_SECRET_HEADER) ?? '', secret)) return 'bad-secret'
    if (sources && !sources(remoteAddress)) return 'untrusted-source'
    return null
  }

  function read(header: (name: string) => string | undefined, remoteAddress: string | undefined): ProxyResult {
    const username = header(names.username)?.trim()
    if (!username) return { kind: 'none' }
    const reason = refusal(header, remoteAddress)
    if (reason) return { kind: 'rejected', reason }
    const value = (name: string | undefined) => (name ? header(name)?.trim() || undefined : undefined)
    return {
      kind: 'trusted',
      identity: {
        // No uid header (the `remote` preset has none): the user name is the stable subject.
        subject: value(names.uid) ?? username,
        username,
        email: value(names.email),
        name: value(names.name),
        groups: (value(names.groups) ?? '').split(separator).map((group) => group.trim()).filter(Boolean),
      },
    }
  }
  /** Did this request provably come through the proxy — whether or not it carries an identity? */
  read.viaProxy = (header: (name: string) => string | undefined, remoteAddress: string | undefined): boolean => refusal(header, remoteAddress) === null
  return read
}

/**
 * AUTH_ROLE_MAP: JSON object `{ "<group at the identity provider>": ["role", ...] }` (a single role may be a string).
 * Every role must be one the app declares — a typo in the map must not silently grant nothing, or something else.
 */
export function parseRoleMap<R extends string>(json: string | undefined, roles: readonly R[]): Record<string, R[]> {
  if (!json?.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new AuthConfigError('AUTH_ROLE_MAP is not valid JSON — expected {"<group>": ["<role>", ...]}')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AuthConfigError('AUTH_ROLE_MAP must be a JSON object: {"<group>": ["<role>", ...]}')
  const out: Record<string, R[]> = {}
  for (const [group, value] of Object.entries(parsed)) {
    const list = typeof value === 'string' ? [value] : value
    if (!Array.isArray(list) || list.some((role) => typeof role !== 'string')) throw new AuthConfigError(`AUTH_ROLE_MAP: the value of "${group}" must be a role or a list of roles`)
    for (const role of list) if (!roles.includes(role as R)) throw new AuthConfigError(`AUTH_ROLE_MAP: "${role}" (group "${group}") is not a role of this app (${roles.join(', ')})`)
    out[group] = list as R[]
  }
  return out
}

/** Groups -> roles through the map, in the order the app declares its roles. A group that is not mapped grants nothing. */
export function rolesFor<R extends string>(groups: readonly string[], map: Record<string, readonly R[]>, roles: readonly R[]): R[] {
  const granted = new Set<string>()
  for (const group of groups) for (const role of map[group] ?? []) granted.add(role)
  return roles.filter((role) => granted.has(role))
}
