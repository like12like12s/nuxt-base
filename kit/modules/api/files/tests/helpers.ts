// Shared setup of the API tests: a throwaway database per test file (SQLite temp file, or a MySQL `test_*` schema
// when TEST_MYSQL_URL is set), a pinned clock + ids, and the app wired to both. Every test starts with empty tables.
import { beforeEach } from 'vitest'
import { appLogger, createApp, type AppDeps } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { migrations } from '../src/db/migrations/index.js'
import type { Schema } from '../src/db/schema.js'
import { testClient } from '../src/kit/testing/client.js'
import { useDeterministic, useTestDb } from '../src/kit/testing/test-db.js'

export const testConfig = () => loadConfig({ PORT: '3000', NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:' })

export function useApp() {
  const t = useTestDb<Schema>({ migrations })
  useDeterministic()
  beforeEach(async () => {
    await t.db.deleteFrom('items').execute()
    await t.db.deleteFrom('audit').execute()
  })

  /** A fresh app on the test database. `lines` collects its JSON log lines. */
  function build(overrides: Partial<AppDeps> = {}) {
    const lines: Record<string, unknown>[] = []
    const config = testConfig()
    const logger = appLogger(config, (line) => lines.push(JSON.parse(line) as Record<string, unknown>))
    const app = createApp(config, { database: t.database, logger, ...overrides })
    return { app, api: testClient(app), lines }
  }

  return {
    build,
    get db() { return t.db },
    get database() { return t.database },
  }
}

export const TRACE_ID = /^[0-9a-f]{32}$/
