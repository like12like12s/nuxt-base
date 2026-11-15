// DO NOT EDIT — locked file from the nuxt-base kit (runtime/testing/test-db.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// A throwaway database per test file, migrated and removed again.
//   default            a SQLite file in the OS temp dir
//   TEST_MYSQL_URL     set (mysql://<user>:<password>@<host>:3306) -> a new `test_*` schema on that server instead; the same
//                      suite then proves the migrations and queries on MySQL. The user must be allowed to create and
//                      drop `test_%` schemas. Nothing outside a schema this file created is ever touched.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'mysql2/promise'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { openDatabase, parseDatabaseUrl, type Database, type DatabaseOptions } from '../db/connect.js'
import { migrateUp, type Migrations } from '../db/migrate.js'
import { deterministic } from './factory.js'

export const mysqlTestUrl = (): string | null => process.env.TEST_MYSQL_URL || null
/** 'mysql' when TEST_MYSQL_URL is set, else 'sqlite' — what createTestDb() will use. */
export const testDialect = (): 'sqlite' | 'mysql' => (mysqlTestUrl() ? 'mysql' : 'sqlite')

/** For suites that only make sense on MySQL: say loudly that they did not run. */
export function mysqlSkipNotice(what: string): void {
  // Straight to stderr: a test runner hides console output of passing files, and this must not be hidden.
  process.stderr.write(`SKIPPED: ${what} — TEST_MYSQL_URL is not set, so this ran on SQLite only\n`)
}

const TEST_SCHEMA = /^test_[a-z0-9_]{1,56}$/

export interface TestDbOptions {
  /** Applied before the database is handed out. Omit for an empty database. */
  migrations?: Migrations
  /** Goes into the file / schema name, to tell leftovers apart. */
  label?: string
  /** Force an engine instead of following TEST_MYSQL_URL ('mysql' needs the variable). */
  dialect?: 'sqlite' | 'mysql'
  options?: Omit<DatabaseOptions, 'url'>
}

export interface TestDb<DB> extends Database<DB> {
  /** A DATABASE_URL for this database (to boot the app or the CLI against it). */
  url: string
  /** Close and remove the database. Safe to call twice. */
  cleanup(): Promise<void>
}

async function mysqlAdmin<T>(serverUrl: string, fn: (query: (statement: string) => Promise<unknown>) => Promise<T>): Promise<T> {
  const url = new URL(serverUrl)
  const connection = await createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    connectTimeout: 5000,
  })
  try {
    return await fn((statement) => connection.query(statement))
  } finally {
    await connection.end()
  }
}

export async function createTestDb<DB = any>(options: TestDbOptions = {}): Promise<TestDb<DB>> {
  const label = (options.label ?? 'db').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30)
  const server = (options.dialect ?? testDialect()) === 'mysql' ? mysqlTestUrl() : null
  if (options.dialect === 'mysql' && !server) throw new Error('createTestDb({ dialect: "mysql" }) needs TEST_MYSQL_URL')
  let url: string
  let remove: () => Promise<void>

  if (server) {
    const schema = `test_${label}_${randomBytes(6).toString('hex')}`
    if (!TEST_SCHEMA.test(schema)) throw new Error(`refusing to create schema "${schema}" — test schemas are named test_*`)
    await mysqlAdmin(server, (query) => query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`))
    const target = new URL(server)
    target.pathname = `/${schema}`
    url = target.toString()
    remove = async () => {
      // Belt and braces: only ever drop the schema created above, and only if it is named like a test schema.
      if (!TEST_SCHEMA.test(schema)) throw new Error(`refusing to drop "${schema}"`)
      await mysqlAdmin(server, (query) => query(`DROP DATABASE IF EXISTS \`${schema}\``))
    }
  } else {
    const dir = mkdtempSync(join(tmpdir(), `kit-test-${label}-`))
    url = `sqlite:${join(dir, 'test.db')}`
    remove = async () => rmSync(dir, { recursive: true, force: true })
  }

  let database: Database<DB>
  try {
    database = openDatabase<DB>({ retries: 0, ...options.options, url })
    if (options.migrations) await migrateUp(database.db, options.migrations)
  } catch (error) {
    await remove()
    throw error
  }
  let cleaned = false
  return {
    ...database,
    url,
    cleanup: async () => {
      if (cleaned) return
      cleaned = true
      await database.close().catch(() => undefined)
      await remove()
    },
  }
}

/**
 * The usual setup of a test file: `const t = useTestDb<Schema>({ migrations })` at the top, then `t.db` inside tests.
 * One database per file (created in beforeAll, removed in afterAll).
 */
export function useTestDb<DB = any>(options: TestDbOptions = {}): { readonly db: TestDb<DB>['db']; readonly database: TestDb<DB> } {
  let current: TestDb<DB> | undefined
  beforeAll(async () => {
    current = await createTestDb<DB>({ ...options, label: options.label ?? parseLabel() })
  })
  afterAll(async () => {
    await current?.cleanup()
    current = undefined
  })
  const get = (): TestDb<DB> => {
    if (!current) throw new Error('useTestDb(): the database exists only while tests run (use it inside it() / beforeEach())')
    return current
  }
  return {
    get db() { return get().db },
    get database() { return get() },
  }
}

const parseLabel = (): string => (process.env.VITEST_POOL_ID ? `w${process.env.VITEST_POOL_ID}` : 'db')

/** Pin the clock and the id generator around every test of the file, so each test sees the same ids and timestamps. */
export function useDeterministic(options: { start?: string; stepMs?: number } = {}): void {
  let pinned: { restore: () => void } | undefined
  beforeEach(() => {
    pinned = deterministic(options)
  })
  afterEach(() => {
    pinned?.restore()
    pinned = undefined
  })
}

/** What a test DATABASE_URL points at, for assertions (never log the URL itself). */
export const describeTestUrl = (url: string): string => {
  const target = parseDatabaseUrl(url)
  return target.dialect === 'sqlite' ? `sqlite ${target.file}` : `mysql ${target.database}`
}
