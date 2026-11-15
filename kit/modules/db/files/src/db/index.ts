// Opens the app's database from the validated config. DATABASE_URL picks SQLite or MySQL at run time; the code above
// this line is the same for both.
import type { DatabaseConfig } from '../config.js'
import type { Logger } from '../kit/api/log.js'
import { openDatabase, type Database } from '../kit/db/connect.js'
import type { Schema } from './schema.js'

export type AppDatabase = Database<Schema>

export function connect(config: DatabaseConfig, logger?: Logger): AppDatabase {
  return openDatabase<Schema>({
    url: config.DATABASE_URL,
    connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
    queryTimeoutMs: config.DB_QUERY_TIMEOUT_MS,
    retries: config.DB_RETRIES,
    poolMax: config.DB_POOL_MAX,
    onRetry: (event) => logger?.warn('db retry', { ...event }),
  })
}
