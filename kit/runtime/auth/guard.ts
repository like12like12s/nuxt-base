// DO NOT EDIT — locked file from the nuxt-base kit (runtime/auth/guard.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Who is calling, and what each route demands.
//   createAuth(...).middleware   resolves the caller once per request: dev user -> service token -> forward-auth
//                                headers from the trusted proxy; puts it in the request context (audit actor)
//   publicRoute() / requireAuth() / requireRole('admin', ...)
//                                the auth DECLARATION of a route — every route has exactly one:
//                                  createRoute({ method: 'get', path: '/things', middleware: [requireAuth()] as const, ... })
//                                the declaration is the FIRST handler of the route (plain hono:
//                                `app.get('/x', requireAuth(), handler)`): what counts is what runs first.
// A route without a declaration is a bug with a security impact, so it is refused twice: the middleware answers 500
// instead of running it — on EVERY path the middleware is mounted on (mount it on `*`), not only under /api/v1 — and
// undeclaredRoutes(app) lists it so a test fails before it ships. Both look at the same thing: the first handler
// registered for the method + path.
import type { Context, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import type { Kysely } from 'kysely'
import { getContext, type RequestUser } from '../api/context.js'
import { ApiError, errorBody, forbidden, unauthorized } from '../api/errors.js'
import type { Logger } from '../api/log.js'
import { AuthConfigError, proxyAuth, rolesFor, type ProxyTrust } from './proxy.js'
import { TOKEN_PREFIX, verifyServiceToken } from './tokens.js'
import { upsertUser } from './users.js'

export type AuthRule = { kind: 'public' } | { kind: 'auth' } | { kind: 'role'; roles: readonly string[] }

const RULE = Symbol.for('nuxt-base-kit.auth.rule')
type Tagged = { [RULE]?: AuthRule; __COMPOSED_HANDLER?: Tagged }

const declare = (rule: AuthRule, handler: MiddlewareHandler): MiddlewareHandler => Object.assign(handler, { [RULE]: rule })
// app.route() may wrap a sub-app's handlers; hono keeps the original under this key.
const ruleOf = (handler: unknown): AuthRule | undefined => (handler as Tagged)?.[RULE] ?? (handler as Tagged)?.__COMPOSED_HANDLER?.[RULE]

const caller = (): RequestUser | undefined => getContext()?.user

/** Anyone may call this route, signed in or not. Say so explicitly — silence is not a declaration. */
export const publicRoute = (): MiddlewareHandler => declare({ kind: 'public' }, (_c, next) => next())

/** Any authenticated caller (a user from the proxy, a service token, the dev user). 401 otherwise. */
export const requireAuth = (): MiddlewareHandler =>
  declare({ kind: 'auth' }, (_c, next) => {
    if (!caller()) throw unauthorized()
    return next()
  })

/** A caller holding at least one of these roles. 401 when nobody is authenticated, 403 when the roles do not match. */
export function requireRole<R extends string>(...roles: [R, ...R[]]): MiddlewareHandler {
  if (!roles.length) throw new Error('requireRole() needs at least one role — use requireAuth() for "any signed-in caller"')
  return declare({ kind: 'role', roles }, (_c, next) => {
    const user = caller()
    if (!user) throw unauthorized()
    if (!roles.some((role) => user.roles.includes(role))) throw forbidden()
    return next()
  })
}

/** Routes the API standard itself serves; they carry no data and are public by definition. */
export const SYSTEM_PATHS: readonly string[] = ['/health/live', '/health/ready', '/version', '/openapi.json']

interface RouteEntry {
  method: string
  path: string
  handler: unknown
}
// `app.use()` registers ALL + a wildcard path; everything else is something a client can call.
const isMiddleware = (route: RouteEntry) => route.method === 'ALL' && route.path.endsWith('*')

export interface DeclaredRoute {
  method: string
  path: string
  rule: AuthRule | null
}

/** Every callable route of the app with its auth declaration (null = none). The role x endpoint matrix test reads this. */
export function routeRules(app: { routes: readonly RouteEntry[] }, options: { ignore?: readonly string[] } = {}): DeclaredRoute[] {
  const ignore = options.ignore ?? SYSTEM_PATHS
  const seen = new Map<string, DeclaredRoute>()
  for (const route of app.routes) {
    if (isMiddleware(route) || ignore.includes(route.path)) continue
    const key = `${route.method} ${route.path}`
    // The first handler registered for a method + path is the one that runs first: only its declaration counts.
    if (!seen.has(key)) seen.set(key, { method: route.method, path: route.path, rule: ruleOf(route.handler) ?? null })
  }
  return [...seen.values()].sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)))
}

/** `"GET /api/v1/things"` for every route that has no publicRoute() / requireAuth() / requireRole(). Must be empty. */
export const undeclaredRoutes = (app: { routes: readonly RouteEntry[] }, options: { ignore?: readonly string[] } = {}): string[] =>
  routeRules(app, options).filter((route) => !route.rule).map((route) => `${route.method} ${route.path}`)

export interface AuthOptions<R extends string = string> {
  db: Kysely<any>
  /** Every role the app knows, most privileged first. */
  roles: readonly R[]
  /** Identity-provider group -> roles. */
  roleMap: Record<string, readonly R[]>
  proxy: ProxyTrust
  /**
   * Explicit dev mode: every request is this fixed user and nothing else is checked. createAuth() throws when it is
   * set with env = production, so the process does not start.
   */
  devUser?: RequestUser | null
  /** NODE_ENV */
  env: string
  logger?: Logger
  /** TCP peer of the request. Default: the socket of @hono/node-server. Injectable for tests. */
  remoteAddress?: (c: Context) => string | undefined
  /** Exact paths the guard leaves alone (default SYSTEM_PATHS: health, version, openapi — public by definition). */
  ignore?: readonly string[]
}

export interface Auth {
  /** Mount in front of every route: `api.use('*', auth.middleware)` — a route outside the mount is not guarded at all. */
  middleware: MiddlewareHandler
  /** How forward-auth is set up — logged at boot, never a secret. */
  describe(): { mode: 'dev-user' | 'proxy' | 'tokens-only'; proxySecret: boolean; trustedProxies: number }
}

const socketAddress = (c: Context): string | undefined => (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress

export function createAuth<R extends string>(options: AuthOptions<R>): Auth {
  const { db, roles, roleMap, logger, devUser = null } = options
  if (devUser && options.env === 'production') {
    throw new AuthConfigError('AUTH_DEV_MODE is set with NODE_ENV=production — refusing to start: the dev user would let every request in')
  }
  if (devUser) logger?.warn('AUTH_DEV_MODE is on — every request is the dev user; never use it on a deployed instance', { subject: devUser.subject })
  const readProxy = proxyAuth(options.proxy)
  const remoteAddress = options.remoteAddress ?? socketAddress
  const proxySecret = Boolean(options.proxy.secret?.trim())
  const trustedProxies = options.proxy.trustedProxies?.length ?? 0
  const ignore = options.ignore ?? SYSTEM_PATHS

  async function identify(c: Context): Promise<RequestUser | undefined> {
    if (devUser) return devUser

    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1]
    if (bearer?.startsWith(TOKEN_PREFIX)) {
      const check = await verifyServiceToken(db, bearer)
      // A credential that was presented and is wrong is a 401 on every route — never a silent fall back to anonymous.
      if (!check.ok) {
        logger?.warn('service token rejected', { reason: check.reason })
        throw unauthorized('Invalid or expired token')
      }
      return { subject: `service:${check.token.id}`, name: check.token.name, roles: check.token.roles }
    }

    const proxy = readProxy((name) => c.req.header(name), remoteAddress(c))
    if (proxy.kind === 'rejected') {
      // Identity headers from somewhere that is not the proxy: someone is probing, or the proxy is misconfigured.
      logger?.warn('forward-auth headers ignored', { reason: proxy.reason })
      return undefined
    }
    if (proxy.kind === 'none') return undefined
    const user = await upsertUser(db, proxy.identity, rolesFor(proxy.identity.groups, roleMap, roles))
    return { subject: user.subject, roles: user.roles, ...(user.email ? { email: user.email } : {}), ...(user.name ? { name: user.name } : {}) }
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    const context = getContext()
    if (!context) throw new Error('auth middleware needs the request scope of createApi()')
    if (ignore.includes(c.req.path)) return next()
    const user = await identify(c)
    if (user) context.user = user

    // Fail closed: a route that matched but declares nothing is not run.
    // "Declared" is decided by the handler that runs first — the first matched route that is not middleware — never
    // by some other route that happens to match the same request further down.
    const first = matchedRoutes(c).find((route) => !isMiddleware(route))
    const declared = first !== undefined && ruleOf(first.handler) !== undefined
    if (first && !declared) {
      logger?.error('route without an auth declaration — refused', { method: c.req.method, path: first.path })
      throw new ApiError('INTERNAL', 'Internal server error')
    }
    await next()
    // What the check above cannot see in advance: a wildcard handler (`app.use('/x/*', (c) => c.json(...))`) that
    // answers instead of passing on. Its answer is not let out either.
    if (!declared && c.res.status !== 404) {
      logger?.error('answer from a handler without an auth declaration — withheld', { method: c.req.method, path: c.req.path, status: c.res.status })
      c.res = undefined
      c.res = c.json(errorBody('INTERNAL', 'Internal server error', context.traceId), 500)
    }
  }

  return {
    middleware,
    describe: () => ({ mode: devUser ? 'dev-user' : proxySecret || trustedProxies ? 'proxy' : 'tokens-only', proxySecret, trustedProxies }),
  }
}
