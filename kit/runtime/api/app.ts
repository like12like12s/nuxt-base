// DO NOT EDIT — locked file from the nuxt-base kit (runtime/api/app.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// The API standard as one factory. createApi() returns a hono app (OpenAPIHono) that already has:
//   - a request scope: trace id (active span -> `traceparent` -> generated), echoed in `x-trace-id`, on every log line
//   - one JSON log line per request: ts level msg service env traceId method path status ms
//   - the error shape { error: { code, message, details?, traceId } } for every status >= 400, validation included
//   - GET /health/live · GET /health/ready (pluggable checks, 503 + the check list) · GET /version · GET /openapi.json
// Resources are declared contract-first with createRoute() and mounted under /api/v1 with mountV1().
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { getContext, resolveTraceId, runWithContext } from './context.js'
import { ApiError, ErrorSchema, codeForStatus, errorBody, validation } from './errors.js'
import { runChecks, type HealthCheck } from './health.js'
import { KIT_VERSION } from './kit-version.js'
import type { Logger } from './log.js'

export const API_V1 = '/api/v1'
export const TRACE_HEADER = 'x-trace-id'

export interface ApiOptions {
  /** Service name: `service` on every log line, `name` in /version, the OpenAPI title. */
  name: string
  version: string
  /** A logger created with base fields `{ service, env }`. */
  logger: Logger
  /** Readiness checks (the db module adds: database reachable, schema version == code). */
  checks?: readonly HealthCheck[]
  build?: { commit?: string; builtAt?: string }
  /** Runs around the request scope, before a trace id exists — the trace module's server span goes here. */
  before?: readonly MiddlewareHandler[]
  /** Runs inside the request scope, in front of every route including /health/* (security headers, CORS, limits). */
  middleware?: readonly MiddlewareHandler[]
}

export type Api = OpenAPIHono

/** A zod issue list -> `details` of a VALIDATION error: where it is (query.limit, json.name) and what is wrong. */
function validationDetails(target: string, issues: readonly { path: PropertyKey[]; message: string }[]) {
  return issues.map((issue) => ({ path: [target, ...issue.path.map(String)].join('.'), message: issue.message }))
}

/** A router with the standard validation hook. Use mountV1() unless you need a router of your own. */
export function createRouter(): OpenAPIHono {
  return new OpenAPIHono({
    defaultHook: (result) => {
      if (!result.success) throw validation('Request validation failed', validationDetails(result.target, result.error.issues))
    },
  })
}

const traceIdOf = (c: Context): string => getContext()?.traceId ?? resolveTraceId(c.req.header('traceparent'))

/** Anything that is not a deliberate ApiError: the cause (message, stack, SQL) goes to the log only. */
function internalError(c: Context, logger: Logger, err: unknown): Response {
  logger.error('unhandled error', {
    method: c.req.method,
    path: c.req.path,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
  return c.json(errorBody('INTERNAL', 'Internal server error', traceIdOf(c)), 500)
}

/** Trace id + request log. Everything a request does runs inside this scope. */
function requestScope(logger: Logger): MiddlewareHandler {
  return (c, next) => {
    const traceId = resolveTraceId(c.req.header('traceparent'))
    return runWithContext({ traceId }, async () => {
      const start = performance.now()
      try {
        await next()
      } catch (thrown) {
        // hono hands only Error instances to onError; a handler that throws a string or an object lands here.
        if (thrown instanceof Error) throw thrown
        c.res = internalError(c, logger, thrown)
      } finally {
        const status = c.res?.status ?? 500
        c.res?.headers.set(TRACE_HEADER, traceId)
        // No query string in the log: it may carry tokens.
        const fields = { method: c.req.method, path: c.req.path, status, ms: Math.round(performance.now() - start) }
        if (status >= 500) logger.error('request', fields)
        else logger.info('request', fields)
      }
    })
  }
}

const HealthSchema = z
  .object({
    status: z.literal('ok'),
    checks: z.array(z.object({ name: z.string(), status: z.enum(['ok', 'fail']), ms: z.number(), message: z.string().optional() })).optional(),
  })
  .openapi('Health')

const VersionSchema = z
  .object({ name: z.string(), version: z.string(), commit: z.string(), builtAt: z.string(), kit: z.string() })
  .openapi('Version')

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } })

export function createApi(options: ApiOptions): Api {
  const { name, version, logger, checks = [], build = {}, before = [], middleware = [] } = options
  const app = createRouter()

  for (const handler of before) app.use(handler)
  app.use(requestScope(logger))
  for (const handler of middleware) app.use(handler)

  app.notFound((c) => c.json(errorBody('NOT_FOUND', `No route for ${c.req.method} ${c.req.path}`, traceIdOf(c)), 404))

  app.onError((err, c) => {
    const traceId = traceIdOf(c)
    if (err instanceof ApiError) {
      return c.json(errorBody(err.code, err.message, traceId, err.details), err.status as 400)
    }
    if (err instanceof HTTPException && err.status < 500) {
      // hono's own client errors (malformed JSON body, payload too large, ...) — their message describes the request.
      return c.json(errorBody(codeForStatus(err.status), err.message || 'Bad request', traceId), err.status as 400)
    }
    // Anything else is ours; the caller gets the trace id to quote.
    return internalError(c, logger, err)
  })

  app.openapi(
    createRoute({
      method: 'get',
      path: '/health/live',
      tags: ['system'],
      summary: 'Liveness — the process is up (touches nothing else)',
      responses: { 200: json(HealthSchema, 'Alive') },
    }),
    (c) => c.json({ status: 'ok' as const }, 200),
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/health/ready',
      tags: ['system'],
      summary: 'Readiness — every dependency check passes',
      responses: { 200: json(HealthSchema, 'Ready'), 503: json(ErrorSchema, 'Not ready — details = the check list') },
    }),
    async (c) => {
      const report = await runChecks(checks, (check, err) => {
        logger.warn('health check failed', { check, error: err instanceof Error ? err.message : String(err) })
      })
      if (report.ok) return c.json({ status: 'ok' as const, checks: report.checks }, 200)
      return c.json(errorBody('INTERNAL', 'Not ready', traceIdOf(c), report.checks), 503)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/version',
      tags: ['system'],
      summary: 'What is running',
      responses: { 200: json(VersionSchema, 'Build information') },
    }),
    (c) => c.json({ name, version, commit: build.commit ?? 'unknown', builtAt: build.builtAt ?? 'unknown', kit: KIT_VERSION }, 200),
  )

  app.get('/openapi.json', (c) => c.json(openApiDocument(app, { name, version })))

  return app
}

/** Mount resources under /api/v1: `mountV1(api, (v1) => { registerItems(v1, deps) })`. Call it once, after createApi(). */
export function mountV1(api: Api, register: (v1: OpenAPIHono) => void): void {
  const v1 = createRouter()
  register(v1)
  api.route(API_V1, v1)
}

/** The OpenAPI 3.1 document of the app — what /openapi.json serves and what the committed openapi.json must equal. */
export function openApiDocument(api: Api, info: { name: string; version: string }): Record<string, unknown> {
  return api.getOpenAPI31Document({ openapi: '3.1.0', info: { title: info.name, version: info.version } }) as unknown as Record<string, unknown>
}

/** Stable serialisation of the document for the committed file and the contract test. */
export const stringifyOpenApi = (document: Record<string, unknown>): string => JSON.stringify(document, null, 2) + '\n'
