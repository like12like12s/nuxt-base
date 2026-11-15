// DO NOT EDIT — locked file from the nuxt-base kit (runtime/db/connect.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// One way to open the database. DATABASE_URL selects the dialect at run time:
//   sqlite:./data/app.db · sqlite:/abs/path/app.db · sqlite::memory:
//   mysql://<user>:<password>@<host>:3306/<database>          add ?ssl=true for TLS (the server certificate is verified)
// No error raised here ever contains the URL — it may hold a password.
import { Kysely, sql, type Dialect } from 'kysely'
import { mysqlDialect } from './mysql.js'
import { rememberResilience, resilient, type ResilienceOptions } from './resilient.js'
import { MEMORY, sqliteDialect } from './sqlite.js'

export type DialectName = 'sqlite' | 'mysql'

export type DatabaseTarget =
  | { dialect: 'sqlite'; file: string }
  | { dialect: 'mysql'; host: string; port: number; user: string; password: string; database: string; ssl?: true }

export function parseDatabaseUrl(url: string): DatabaseTarget {
  if (url.startsWith('sqlite:')) {
    const file = url.slice('sqlite:'.length).replace(/^\/\/(?!\/)/, '')
    if (!file) throw new Error('DATABASE_URL: sqlite needs a file path (sqlite:./data/app.db) or sqlite::memory:')
    return { dialect: 'sqlite', file }
  }
  if (url.startsWith('mysql:')) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('DATABASE_URL: not a valid mysql:// URL')
    }
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    if (!parsed.hostname || !database) throw new Error('DATABASE_URL: mysql needs a host and a database name (mysql://<user>:<password>@<host>:3306/<database>)')
    // TLS is asked for in the URL: `?ssl=true` (or 1 / required). Anything else after `?` is refused — a typo must not
    // silently mean "no TLS".
    const params = [...parsed.searchParams.keys()]
    const tls = parsed.searchParams.get('ssl')
    if (params.some((key) => key !== 'ssl') || (tls !== null && !['true', '1', 'required', 'false', '0'].includes(tls))) {
      throw new Error('DATABASE_URL: the only option a mysql:// URL takes is ?ssl=true')
    }
    // Not a Sequelize config (the rule below matches the shape): this is the parsed DATABASE_URL, and TLS is the `ssl` flag.
    // nosemgrep: javascript.sequelize.security.audit.sequelize-enforce-tls.sequelize-enforce-tls
    return {
      dialect: 'mysql',
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 3306,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database,
      ...(tls !== null && ['true', '1', 'required'].includes(tls) ? { ssl: true as const } : {}),
    }
  }
  throw new Error('DATABASE_URL: unsupported scheme — use sqlite: or mysql://')
}

export interface DatabaseOptions extends ResilienceOptions {
  url: string
  /**
   * MySQL: connecting and waiting for a pooled connection — in total, retries included (default 5 000 ms).
   * SQLite: how long a statement waits for a lock held by another process. node:sqlite is synchronous, so the wait
   * is done in slices of at most 50 ms with asynchronous pauses in between: the event loop is never blocked longer.
   */
  connectTimeoutMs?: number
  /**
   * Deadline of one statement on MySQL (default 10 000 ms); the statement is killed on the server. SQLite has NO
   * statement deadline: a statement runs synchronously to its end — keep SQLite queries small.
   */
  queryTimeoutMs?: number
  /** MySQL pool size (default 10). */
  poolMax?: number
  /** Tests: wrap the dialect (fault injection) before the retry layer goes around it. */
  wrapDialect?: (dialect: Dialect) => Dialect
}

export interface Database<DB> {
  db: Kysely<DB>
  dialect: DialectName
  target: DatabaseTarget
  /** `select 1` — throws when the database cannot be reached. */
  ping(): Promise<void>
  /** Close the pool / the file. Call it from the shutdown hook. */
  close(): Promise<void>
}

/** The longest one SQLite statement may block the process while it waits for a lock. */
export const SQLITE_BUSY_SLICE_MS = 50

export function openDatabase<DB>(options: DatabaseOptions): Database<DB> {
  const target = parseDatabaseUrl(options.url)
  const connectTimeoutMs = options.connectTimeoutMs ?? 5000
  const base: Dialect =
    target.dialect === 'sqlite'
      ? sqliteDialect(target.file, { busyTimeoutMs: Math.min(connectTimeoutMs, SQLITE_BUSY_SLICE_MS) })
      : mysqlDialect({ ...target, connectTimeoutMs, queryTimeoutMs: options.queryTimeoutMs ?? 10_000, poolMax: options.poolMax ?? 10 })
  const resilience: ResilienceOptions = {
    retries: options.retries,
    backoffMs: options.backoffMs,
    onRetry: options.onRetry,
    lockBudgetMs: target.dialect === 'sqlite' ? connectTimeoutMs : undefined,
    acquireBudgetMs: target.dialect === 'mysql' ? connectTimeoutMs : undefined,
  }
  const dialect = resilient(options.wrapDialect ? options.wrapDialect(base) : base, resilience)
  const db = new Kysely<DB>({ dialect })
  rememberResilience(db, resilience)
  let closed = false
  return {
    db,
    dialect: target.dialect,
    target,
    ping: async () => {
      await sql`select 1`.execute(db)
    },
    close: async () => {
      if (closed) return
      closed = true
      await db.destroy()
    },
  }
}

export const isMemory = (target: DatabaseTarget): boolean => target.dialect === 'sqlite' && target.file === MEMORY
