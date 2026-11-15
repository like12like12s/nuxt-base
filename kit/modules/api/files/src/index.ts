// Entry point: validate env -> open the database -> create the app -> listen -> shut down gracefully on SIGTERM / SIGINT.
// The process starts even when the database is down or behind: /health/live answers, /health/ready says 503 and why.
import { serve } from '@hono/node-server'
import { appLogger, createApp } from './app.js'
import { describeConfig, loadConfig, type Config } from './config.js'
import { connect } from './db/index.js'
import { EnvError } from './kit/api/env.js'
import { gracefulShutdown } from './kit/api/shutdown.js'

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
const app = createApp(config, { database, logger })
const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  logger.info('listening', { port: info.port, db: database.dialect, config: describeConfig(config) })
})

gracefulShutdown(server, {
  cleanup: () => database.close(),
  onSignal: (signal) => logger.info('shutting down', { signal }),
  onError: (err) => logger.error('shutdown failed', { error: err instanceof Error ? err.message : String(err) }),
})
