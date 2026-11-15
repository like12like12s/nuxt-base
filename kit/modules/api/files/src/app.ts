// The API of {{kit.name}}. Pure: no listening, no process.env — src/index.ts boots it, tests call app.request().
// createApi() (locked kit runtime) brings the standard: trace id, request log, error shape, /health/*, /version,
// /openapi.json. This file only says what THIS app adds: its readiness checks and its resources under /api/v1.
import { readFileSync } from 'node:fs'
// @kit:if auth
import type { Context } from 'hono'
// @kit:end
// @kit:if auth
import { appAuth } from './auth/index.js'
// @kit:end
import type { Config } from './config.js'
import type { AppDatabase } from './db/index.js'
import { migrations as shippedMigrations } from './db/migrations/index.js'
import { createApi, mountV1 } from './kit/api/app.js'
import { buildInfo } from './kit/api/build-info.js'
import { createLogger, type Logger } from './kit/api/log.js'
import { databaseChecks } from './kit/db/checks.js'
import type { Migrations } from './kit/db/migrate.js'
// @kit:if security
import { parseOrigins, security } from './kit/security/security.js'
// @kit:end
// @kit:if trace
import { traceMiddleware } from './kit/trace/tracing.js'
// @kit:end
import { registerItems } from './resources/items/items.routes.js'
// @kit:if auth
import { registerMe } from './resources/me/me.routes.js'
// @kit:end
// kit:anchor resource-imports — `scaffold add resource` adds its import above this line

export const SERVICE = '{{kit.name}}'
// package.json sits next to src/ and next to dist/, so this works under tsx, in tests and in the built image.
export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

export interface AppDeps {
  database: AppDatabase
  logger?: Logger
  /** What /health/ready compares the database with. Defaults to the migrations this build ships. */
  migrations?: Migrations
}

export const appLogger = (config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>, write?: (line: string) => void): Logger =>
  createLogger(config.LOG_LEVEL, write, { service: SERVICE, env: config.NODE_ENV })

export function createApp(config: Config, deps: AppDeps) {
  const logger = deps.logger ?? appLogger(config)
  // @kit:if auth
  // Who is calling: resolved once per request, in front of EVERY route — also one added outside /api/v1. A route says
  // what it demands with publicRoute() / requireAuth() / requireRole() as its first middleware; one without a
  // declaration is refused at run time (500) and fails tests/auth.spec.ts. Only the standard's own system routes
  // (/health/*, /version, /openapi.json) are exempt.
  const auth = appAuth(config, deps.database, logger)
  // Whose `traceparent` is continued (the trace id lands in audit rows and logs): a request that came through the
  // trusted proxy, or everyone when TRUST_TRACEPARENT=1 says only trusted callers reach this API.
  const trustTraceparent = (c: Context) => config.TRUST_TRACEPARENT === '1' || auth.viaProxy(c)
  // @kit:else
  // Whose `traceparent` is continued (the trace id lands in audit rows and logs): nobody, unless TRUST_TRACEPARENT=1
  // says only trusted callers reach this API.
  const trustTraceparent = () => config.TRUST_TRACEPARENT === '1'
  // @kit:end
  const api = createApi({
    name: SERVICE,
    version: VERSION,
    logger,
    checks: databaseChecks(deps.database, deps.migrations ?? shippedMigrations),
    // commit + builtAt of /version: the image's build args, else the deployed tag and the image's build stamp.
    build: buildInfo({ commit: config.APP_COMMIT, builtAt: config.APP_BUILT_AT, imageTag: config.APP_IMAGE_TAG }),
    trustTraceparent,
    // @kit:if security
    // In front of every route: secure headers, CORS allowlist, rate limit, body size limit.
    middleware: security({
      corsOrigins: parseOrigins(config.CORS_ORIGINS),
      rateLimit:
        config.RATE_LIMIT_MAX > 0
          ? {
              max: config.RATE_LIMIT_MAX,
              windowMs: config.RATE_LIMIT_WINDOW_MS,
              // @kit:if auth
              // Per client behind the reverse proxy — believed under the same rule as its identity headers.
              trust: { secret: config.AUTH_PROXY_SECRET, trustedProxies: config.AUTH_TRUSTED_PROXIES },
              // @kit:end
              onSharedPeer: (peer) => logger.warn('rate limit: requests arrive through a proxy that is not trusted — all its users share one budget (set the proxy trust, or RATE_LIMIT_MAX=0)', { peer }),
            }
          : null,
      bodyLimitBytes: config.BODY_LIMIT_BYTES,
    }),
    // @kit:end
    // @kit:if trace
    // Around everything: the request's trace id is the id of this span (a no-op while tracing is off).
    before: [traceMiddleware({ trustParent: trustTraceparent })],
    // @kit:end
  })

  // @kit:if auth
  api.use('*', auth.middleware)

  // @kit:end
  // Resources of the app. One register<Resource>() per resource, all under /api/v1.
  mountV1(api, (v1) => {
    registerItems(v1, { db: deps.database.db })
    // @kit:if auth
    registerMe(v1)
    // @kit:end
    // kit:anchor resources — `scaffold add resource` registers it above this line
  })

  return api
}
