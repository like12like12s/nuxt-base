// Service tokens: `npm run auth:token -- create --name <name> --roles <a,b> [--days <n>]` · `-- revoke <id|name>` · `-- list`.
// In a built image (no npm, no tsx): `node dist/auth/cli.js token <command>`.
import { loadDatabaseConfig } from '../config.js'
import { EnvError } from '../kit/api/env.js'
import { runAuthCli } from '../kit/auth/cli.js'
import { ROLES } from './roles.js'

try {
  const config = loadDatabaseConfig()
  process.exitCode = await runAuthCli(process.argv.slice(2), {
    url: config.DATABASE_URL,
    roles: ROLES,
    options: { connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS, queryTimeoutMs: config.DB_QUERY_TIMEOUT_MS, retries: config.DB_RETRIES },
  })
} catch (err) {
  if (!(err instanceof EnvError)) throw err
  console.error(err.message)
  process.exitCode = 1
}
