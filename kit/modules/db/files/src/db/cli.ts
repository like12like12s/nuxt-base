// Database commands: `npm run db:migrate -- up|down|status`, `npm run db:seed`, `npm run db:check`.
// In a built image (no npm, no tsx): `node dist/db/cli.js <command>` — the container deploy runs `predeploy` first.
import { loadDatabaseConfig } from '../config.js'
import { EnvError } from '../kit/api/env.js'
import { runDbCli } from '../kit/db/cli.js'
import { migrations } from './migrations/index.js'
import { seed } from './seed.js'

try {
  const config = loadDatabaseConfig()
  process.exitCode = await runDbCli(process.argv.slice(2), {
    url: config.DATABASE_URL,
    migrations,
    seed,
    options: { connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS, queryTimeoutMs: config.DB_QUERY_TIMEOUT_MS, retries: config.DB_RETRIES },
  })
} catch (err) {
  if (!(err instanceof EnvError)) throw err
  console.error(err.message)
  process.exitCode = 1
}
