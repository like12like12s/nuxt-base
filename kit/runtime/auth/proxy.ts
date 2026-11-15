// DO NOT EDIT — locked file from the nuxt-base kit (runtime/auth/proxy.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Identity from a forward-auth proxy (Authentik outpost behind Caddy / Traefik / nginx). The proxy authenticates the
// browser and adds X-Authentik-* headers to the request it forwards. Anyone who can reach this API directly can send
// the same headers — so they are believed ONLY when the request provably came through the proxy:
//   secret           the proxy adds `x-auth-proxy-secret: <AUTH_PROXY_SECRET>` (and strips it from client requests)
//   trustedProxies   the TCP peer is one of these addresses / CIDR ranges (AUTH_TRUSTED_PROXIES)
// Whatever is configured must hold (both = both). Nothing configured = the headers are never believed (fail closed).
import { createHash, timingSafeEqual } from 'node:crypto'
import { BlockList, isIP } from 'node:net'

export const PROXY_SECRET_HEADER = 'x-auth-proxy-secret'
export const IDENTITY_HEADERS = ['x-authentik-username', 'x-authentik-uid', 'x-authentik-email', 'x-authentik-name', 'x-authentik-groups'] as const

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthConfigError'
  }
}

export interface ProxyTrust {
  secret?: string
  trustedProxies?: readonly string[]
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
  const refusal = (header: (name: string) => string | undefined, remoteAddress: string | undefined): 'not-configured' | 'bad-secret' | 'untrusted-source' | null => {
    if (!configured) return 'not-configured'
    if (secret && !safeEqual(header(PROXY_SECRET_HEADER) ?? '', secret)) return 'bad-secret'
    if (sources && !sources(remoteAddress)) return 'untrusted-source'
    return null
  }

  function read(header: (name: string) => string | undefined, remoteAddress: string | undefined): ProxyResult {
    const username = header('x-authentik-username')?.trim()
    if (!username) return { kind: 'none' }
    const reason = refusal(header, remoteAddress)
    if (reason) return { kind: 'rejected', reason }
    const value = (name: string) => header(name)?.trim() || undefined
    return {
      kind: 'trusted',
      identity: {
        subject: value('x-authentik-uid') ?? username,
        username,
        email: value('x-authentik-email'),
        name: value('x-authentik-name'),
        groups: (header('x-authentik-groups') ?? '').split('|').map((group) => group.trim()).filter(Boolean),
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
