// DO NOT EDIT — locked file from the nuxt-base kit (runtime/db/sqlite.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// SQLite through node:sqlite (built into Node — no native module to compile or to rebuild on a Node upgrade),
// adapted to the small better-sqlite3-shaped interface Kysely's SqliteDialect expects.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { SqliteDialect, type SqliteDatabase } from 'kysely'

/** node:sqlite binds null, numbers, bigints, strings and byte arrays — map the rest of what application code passes. */
function bindable(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string' || value instanceof Uint8Array) return value
  throw new TypeError(`cannot bind a value of type ${typeof value} to an SQL parameter`)
}

export interface SqliteOptions {
  /**
   * How long a statement waits — synchronously, blocking the whole process — for a lock held by another connection
   * before failing with SQLITE_BUSY (default 50 ms). Keep it small: the retry layer (resilient.ts) does the real
   * waiting, asynchronously.
   */
  busyTimeoutMs?: number
}

export const MEMORY = ':memory:'

/** Open (and create) the database file with the pragmas every app wants: WAL, foreign keys, a busy timeout. */
export function openSqliteFile(file: string, options: SqliteOptions = {}): DatabaseSync {
  if (file !== MEMORY) mkdirSync(dirname(file), { recursive: true })
  const database = new DatabaseSync(file)
  database.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.round(options.busyTimeoutMs ?? 50))}`)
  database.exec('PRAGMA foreign_keys = ON')
  if (file !== MEMORY) {
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA synchronous = NORMAL')
  }
  return database
}

export function sqliteAdapter(database: DatabaseSync): SqliteDatabase {
  return {
    close: () => database.close(),
    prepare(sql) {
      const statement = database.prepare(sql)
      const bind = (parameters: ReadonlyArray<unknown>) => parameters.map(bindable)
      return {
        // A statement that returns columns is read with all(); everything else is run() for its change count.
        reader: statement.columns().length > 0,
        all: (parameters) => statement.all(...bind(parameters)),
        run: (parameters) => statement.run(...bind(parameters)),
        iterate: (parameters) => statement.iterate(...bind(parameters)) as IterableIterator<unknown>,
      }
    },
  }
}

export const sqliteDialect = (file: string, options: SqliteOptions = {}) =>
  new SqliteDialect({ database: async () => sqliteAdapter(openSqliteFile(file, options)) })
