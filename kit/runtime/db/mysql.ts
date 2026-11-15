// DO NOT EDIT — locked file from the nuxt-base kit (runtime/db/mysql.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// MySQL through mysql2, behind a pool wrapper that gives every acquire and every query a deadline. A query that
// passes its deadline is not left running on a pooled connection: the connection is destroyed (the server rolls back
// whatever it was doing) and the caller gets a QUERY_TIMEOUT error.
import { MysqlDialect, type MysqlPool, type MysqlPoolConnection } from 'kysely'
import { createPool, type Pool, type PoolConnection } from 'mysql2'

export interface MysqlOptions {
  host: string
  port: number
  user: string
  password: string
  database: string
  /** TCP connect + handshake, and waiting for a free pooled connection. */
  connectTimeoutMs: number
  queryTimeoutMs: number
  poolMax: number
}

export class DbTimeoutError extends Error {
  readonly code: 'QUERY_TIMEOUT' | 'POOL_ACQUIRE_TIMEOUT'
  constructor(code: 'QUERY_TIMEOUT' | 'POOL_ACQUIRE_TIMEOUT', ms: number) {
    super(code === 'QUERY_TIMEOUT' ? `query exceeded ${ms} ms` : `no database connection within ${ms} ms`)
    this.name = 'DbTimeoutError'
    this.code = code
  }
}

type QueryCallback = (error: unknown, result: never) => void

type LooseQuery = (sql: string, parameters: unknown, callback?: (error: unknown, result: unknown) => void) => unknown

function wrapConnection(raw: PoolConnection, queryTimeoutMs: number): MysqlPoolConnection {
  // mysql2's overloads do not include the (sql, values, callback) form with untyped values that Kysely uses.
  const send = raw.query.bind(raw) as unknown as LooseQuery
  return {
    get config() { return raw.config },
    get threadId() { return raw.threadId },
    connect: (callback) => raw.connect((error) => callback?.(error)),
    destroy: () => raw.destroy(),
    release: () => raw.release(),
    query(sql: string, parameters: unknown, callback?: QueryCallback) {
      if (!callback) return send(sql, parameters) as never // streaming: the consumer owns the pace
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        raw.destroy()
        callback(new DbTimeoutError('QUERY_TIMEOUT', queryTimeoutMs), undefined as never)
      }, queryTimeoutMs)
      return send(sql, parameters, (error, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback(error, result as never)
      }) as never
    },
  }
}

export function wrapPool(pool: Pool, options: Pick<MysqlOptions, 'connectTimeoutMs' | 'queryTimeoutMs'>): MysqlPool {
  const wrappers = new WeakMap<PoolConnection, MysqlPoolConnection>()
  return {
    getConnection(callback) {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        callback(new DbTimeoutError('POOL_ACQUIRE_TIMEOUT', options.connectTimeoutMs), undefined as never)
      }, options.connectTimeoutMs)
      pool.getConnection((error, raw) => {
        if (settled) {
          raw?.release() // arrived after the deadline — hand it straight back
          return
        }
        settled = true
        clearTimeout(timer)
        if (error) return callback(error, undefined as never)
        let wrapper = wrappers.get(raw)
        if (!wrapper) {
          wrapper = wrapConnection(raw, options.queryTimeoutMs)
          wrappers.set(raw, wrapper)
        }
        callback(null, wrapper)
      })
    },
    end: (callback) => pool.end((error) => callback(error)),
  }
}

export function mysqlDialect(options: MysqlOptions) {
  const pool = createPool({
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    database: options.database,
    connectTimeout: options.connectTimeoutMs,
    connectionLimit: options.poolMax,
    waitForConnections: true,
    enableKeepAlive: true,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    multipleStatements: false,
  })
  return new MysqlDialect({ pool: wrapPool(pool, options) })
}
