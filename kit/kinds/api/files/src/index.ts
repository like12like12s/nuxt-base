// Entry point: validate env -> create the app -> listen -> shut down gracefully on SIGTERM / SIGINT.
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { describeConfig, loadConfig, type Config } from './config.js'
import { EnvError } from './kit/env.js'
import { createLogger } from './kit/log.js'
import { gracefulShutdown } from './kit/shutdown.js'

let config: Config
try {
  config = loadConfig()
} catch (err) {
  if (!(err instanceof EnvError)) throw err
  console.error(err.message)
  process.exit(1)
}

const logger = createLogger(config.LOG_LEVEL)
const app = createApp(config, { logger })
const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  logger.info('listening', { port: info.port, config: describeConfig(config) })
})

gracefulShutdown(server, {
  onSignal: (signal) => logger.info('shutting down', { signal }),
  onError: (err) => logger.error('shutdown failed', { error: err instanceof Error ? err.message : String(err) }),
})
