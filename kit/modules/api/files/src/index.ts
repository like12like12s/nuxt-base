// Entry point: validate env -> open the database -> create the app -> listen -> shut down gracefully on SIGTERM / SIGINT.
// The process starts even when the database is down or behind: /health/live answers, /health/ready says 503 and why.
import { serve } from '@hono/node-server'
import { appLogger, createApp } from './app.js'
import { describeConfig, loadConfig, type Config } from './config.js'
import { connect } from './db/index.js'
import { EnvError } from './kit/api/env.js'
import { gracefulShutdown } from './kit/api/shutdown.js'
// @kit:if auth
import { AuthConfigError } from './kit/auth/proxy.js'
// @kit:end

let config: Config
try {
  config = loadConfig()
} catch (err) {
  if (!(err instanceof EnvError)) throw err
  console.error(err.message)
  process.exit(1)
}

const logger = appLogger(config)
const database = connect(config, logger)
// @kit:if auth
let app: ReturnType<typeof createApp>
try {
  app = createApp(config, { database, logger })
} catch (err) {
  // A bad auth setting (AUTH_DEV_MODE in production, an unknown role in AUTH_ROLE_MAP) stops the boot and says why.
  if (!(err instanceof AuthConfigError)) throw err
  console.error(err.message)
  process.exit(1)
}
// @kit:else
const app = createApp(config, { database, logger })
// @kit:end
const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  logger.info('listening', { port: info.port, db: database.dialect, config: describeConfig(config) })
})

gracefulShutdown(server, {
  cleanup: () => database.close(),
  onSignal: (signal) => logger.info('shutting down', { signal }),
  onError: (err) => logger.error('shutdown failed', { error: err instanceof Error ? err.message : String(err) }),
})
