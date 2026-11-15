// Job runner: `npm run job -- <name>` · `npm run job -- --list` · built: `node dist/jobs/run.js <name>`.
// Exit codes (what the scheduler reads): 0 ok · 1 failed · 2 unknown job · 3 already running · 4 timed out.
import { SERVICE } from '../app.js'
import { loadJobConfig } from '../config.js'
import { connect } from '../db/index.js'
import { EnvError } from '../kit/api/env.js'
import { createLogger } from '../kit/api/log.js'
import { runJobsCli } from '../kit/jobs/runner.js'
import { jobs } from './index.js'

let code = 1
try {
  const config = loadJobConfig()
  const logger = createLogger(config.LOG_LEVEL, undefined, { service: SERVICE, env: config.NODE_ENV })
  const database = connect({ ...config, DB_POOL_MAX: 2 }, logger)
  try {
    code = await runJobsCli(process.argv.slice(2), { jobs, database, logger, lockDir: config.JOB_LOCK_DIR })
  } finally {
    await database.close()
  }
} catch (err) {
  if (!(err instanceof EnvError)) throw err
  console.error(err.message)
}
// Exit explicitly: a job that timed out may still hold timers or sockets open.
process.exit(code)
