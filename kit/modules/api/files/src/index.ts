// Entry point: validate env -> open the database -> create the app -> listen -> shut down gracefully on SIGTERM / SIGINT.
// The process starts even when the database is down or behind: /health/live answers, /health/ready says 503 and why.
// @kit:if trace
import './tracing.js' // first: tracing is set up before anything else loads
// @kit:end
import { serve } from '@hono/node-server'
import { appLogger, createApp } from './app.js'
import { describeConfig, loadConfig, type Config } from './config.js'
import { connect } from './db/index.js'
import { EnvError } from './kit/api/env.js'
import { gracefulShutdown } from './kit/api/shutdown.js'
// @kit:if trace
import { stopTracing, tracingActive } from './kit/trace/tracing.js'
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
let app: ReturnType<typeof createApp>
try {
  app = createApp(config, { database, logger })
} catch (err) {
  // A setting that is well-formed but wrong (a wildcard CORS origin, dev auth in production) stops the boot and says
  // why — these errors carry a message that is safe to print; anything else is a bug and keeps its stack.
  if (!(err instanceof Error) || !err.name.endsWith('ConfigError')) throw err
  console.error(err.message)
  process.exit(1)
}
const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  // @kit:if trace
  logger.info('listening', { port: info.port, db: database.dialect, tracing: tracingActive(), config: describeConfig(config) })
  // @kit:else
  logger.info('listening', { port: info.port, db: database.dialect, config: describeConfig(config) })
  // @kit:end
})

gracefulShutdown(server, {
  // @kit:if trace
  cleanup: async () => {
    await database.close()
    await stopTracing() // flush the spans still buffered
  },
  // @kit:else
  cleanup: () => database.close(),
  // @kit:end
  onSignal: (signal) => logger.info('shutting down', { signal }),
  onError: (err) => logger.error('shutdown failed', { error: err instanceof Error ? err.message : String(err) }),
})
