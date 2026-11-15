// The hono app of {{kit.name}}. Pure: no listening, no process.env — src/index.ts boots it, tests call app.request().
import { Hono } from 'hono'
import type { Config } from './config.js'
import { createLogger, requestLogger, type Logger } from './kit/log.js'

export interface AppDeps {
  logger?: Logger
}

export function createApp(config: Config, deps: AppDeps = {}) {
  const logger = deps.logger ?? createLogger(config.LOG_LEVEL)
  const app = new Hono()

  app.use(requestLogger(logger))

  // Liveness: the process is up. Must not touch the database or other services.
  app.get('/health/live', (c) => c.json({ status: 'ok' }))

  // Routes of the app go here.

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: `No route for ${c.req.method} ${c.req.path}` } }, 404))
  app.onError((err, c) => {
    logger.error('unhandled error', { path: c.req.path, error: err instanceof Error ? err.message : String(err) })
    return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500)
  })

  return app
}
