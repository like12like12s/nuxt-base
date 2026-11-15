// DO NOT EDIT — locked file from the nuxt-base kit (runtime/db/resilient.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Bounded retry on transient database errors — and only on those.
//
//   lock        deadlock / lock wait timeout / SQLITE_BUSY: the server rolled the statement back, replaying is safe
//   unsent      the statement never reached the server (connection refused, socket already closed, no pooled
//               connection in time): replaying is safe
//   connection  the connection died while the statement was in flight: it MAY have been applied. Reads are replayed;
//               writes are not (a replayed `count = count + 1` would count twice) — the error reaches the caller.
//
// Inside a transaction nothing is replayed statement by statement: the transaction is gone (or half applied), so the
// whole unit has to run again — that is what withTransaction() in repo.ts does. Everything else (constraint
// violations, syntax errors, a query timeout) fails at once.
import {
  SelectQueryNode,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
  type TransactionSettings,
} from 'kysely'

export type TransientKind = 'lock' | 'unsent' | 'connection'

const MYSQL_LOCK = new Set([1205, 1213]) // ER_LOCK_WAIT_TIMEOUT, ER_LOCK_DEADLOCK
const SQLITE_LOCK = new Set([5, 6]) // SQLITE_BUSY, SQLITE_LOCKED (primary result codes)
const UNSENT = new Set(['ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'POOL_ACQUIRE_TIMEOUT', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'PROTOCOL_ENQUEUE_AFTER_QUIT'])
const CONNECTION = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ETIMEDOUT', 'PROTOCOL_SEQUENCE_TIMEOUT'])
const MYSQL_CONNECTION = new Set([1053, 2006, 2013]) // server shutdown, gone away, lost connection during query

/** What kind of transient failure this is, or null when retrying cannot help. */
export function transientKind(error: unknown): TransientKind | null {
  if (!error || typeof error !== 'object') return null
  const e = error as { code?: unknown; errno?: unknown; errcode?: unknown; message?: unknown; fatal?: unknown }
  if (e.code === 'ERR_SQLITE_ERROR') return typeof e.errcode === 'number' && SQLITE_LOCK.has(e.errcode & 0xff) ? 'lock' : null
  if (typeof e.errno === 'number' && MYSQL_LOCK.has(e.errno)) return 'lock'
  if (typeof e.code === 'string') {
    if (UNSENT.has(e.code)) return 'unsent'
    if (CONNECTION.has(e.code)) return 'connection'
  }
  if (typeof e.errno === 'number' && MYSQL_CONNECTION.has(e.errno)) return 'connection'
  if (typeof e.message === 'string' && /connection is in closed state/i.test(e.message)) return 'unsent'
  return null
}

export interface RetryEvent {
  attempt: number
  kind: TransientKind
  error: string
}

export interface ResilienceOptions {
  /** Extra attempts after the first one (default 2). 0 = never retry. */
  retries?: number
  /** First pause; doubles per attempt (default 50 ms). */
  backoffMs?: number
  /** Called before each retry — log it as a warning. */
  onRetry?: (event: RetryEvent) => void
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Run `fn`, replaying it on a transient error that `canRetry` accepts, at most `retries` extra times. */
export async function retryTransient<T>(fn: (attempt: number) => Promise<T>, options: ResilienceOptions & { canRetry?: (kind: TransientKind) => boolean } = {}): Promise<T> {
  const { retries = 2, backoffMs = 50, onRetry, canRetry = () => true } = options
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (error) {
      const kind = transientKind(error)
      if (!kind || attempt >= retries || !canRetry(kind)) throw error
      onRetry?.({ attempt: attempt + 1, kind, error: message(error) })
      await sleep(backoffMs * 2 ** attempt)
    }
  }
}

/** A statement that may be sent twice without changing anything: a read, or opening a transaction. */
const isReplaySafe = (query: CompiledQuery): boolean => SelectQueryNode.is(query.query) || /^\s*(select|begin)\b/i.test(query.sql)

class ResilientConnection implements DatabaseConnection {
  inTransaction = false
  constructor(public inner: DatabaseConnection, private readonly driver: Driver, private readonly options: ResilienceOptions) {}

  executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    if (this.inTransaction) return this.inner.executeQuery<R>(query)
    return retryTransient(
      async (attempt) => {
        // A retry after a connection failure needs a live connection: give the dead one back and take another.
        if (attempt > 0) await this.reconnect()
        return this.inner.executeQuery<R>(query)
      },
      { ...this.options, canRetry: (kind) => kind !== 'connection' || isReplaySafe(query) },
    )
  }

  streamQuery<R>(query: CompiledQuery, chunkSize: number): AsyncIterableIterator<QueryResult<R>> {
    return this.inner.streamQuery<R>(query, chunkSize)
  }

  private async reconnect(): Promise<void> {
    await this.driver.releaseConnection(this.inner).catch(() => undefined)
    this.inner = await this.driver.acquireConnection()
  }
}

class ResilientDriver implements Driver {
  constructor(private readonly inner: Driver, private readonly options: ResilienceOptions) {}

  init(): Promise<void> {
    return this.inner.init()
  }
  async acquireConnection(): Promise<DatabaseConnection> {
    // Nothing was sent yet, so every transient failure to get a connection may be retried.
    const connection = await retryTransient(() => this.inner.acquireConnection(), this.options)
    return new ResilientConnection(connection, this.inner, this.options)
  }
  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    const c = connection as ResilientConnection
    await this.inner.beginTransaction(c, settings) // through executeQuery above: a dead pooled connection is replaced
    c.inTransaction = true
  }
  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const c = connection as ResilientConnection
    try {
      await this.inner.commitTransaction(c.inner)
    } finally {
      c.inTransaction = false
    }
  }
  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    const c = connection as ResilientConnection
    try {
      await this.inner.rollbackTransaction(c.inner)
    } finally {
      c.inTransaction = false
    }
  }
  async savepoint(connection: DatabaseConnection, name: string, compile: Parameters<NonNullable<Driver['savepoint']>>[2]): Promise<void> {
    await this.inner.savepoint?.((connection as ResilientConnection).inner, name, compile)
  }
  async rollbackToSavepoint(connection: DatabaseConnection, name: string, compile: Parameters<NonNullable<Driver['rollbackToSavepoint']>>[2]): Promise<void> {
    await this.inner.rollbackToSavepoint?.((connection as ResilientConnection).inner, name, compile)
  }
  async releaseSavepoint(connection: DatabaseConnection, name: string, compile: Parameters<NonNullable<Driver['releaseSavepoint']>>[2]): Promise<void> {
    await this.inner.releaseSavepoint?.((connection as ResilientConnection).inner, name, compile)
  }
  releaseConnection(connection: DatabaseConnection): Promise<void> {
    return this.inner.releaseConnection((connection as ResilientConnection).inner)
  }
  destroy(): Promise<void> {
    return this.inner.destroy()
  }
}

/** Wrap any Kysely dialect so that its driver retries transient errors as described at the top of this file. */
export function resilient(dialect: Dialect, options: ResilienceOptions = {}): Dialect {
  return {
    createDriver: () => new ResilientDriver(dialect.createDriver(), options),
    createQueryCompiler: () => dialect.createQueryCompiler(),
    createAdapter: () => dialect.createAdapter(),
    createIntrospector: (db: Kysely<any>) => dialect.createIntrospector(db),
  }
}
