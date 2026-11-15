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
//
// COMMIT is the one statement that is never transient: once it was sent and the answer did not come back (socket
// reset, timeout, closed connection), the transaction may be durable. The unit is NOT replayed — the caller gets
// COMMIT_OUTCOME_UNKNOWN and has to find out (read the row back) before doing the write again. Only a COMMIT the
// database itself answered with an error (deadlock, constraint) is known to have failed and keeps its own error.
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

/** COMMIT was sent and no answer came back: the transaction may or may not be durable. Never retried. */
export class CommitOutcomeUnknownError extends Error {
  readonly code = 'COMMIT_OUTCOME_UNKNOWN'
  constructor(cause: unknown) {
    super('the connection failed while committing: the transaction may or may not have been applied', { cause })
    this.name = 'CommitOutcomeUnknownError'
  }
}

/** True when the database itself answered with an error (so the statement is known not to have been applied). */
function answeredByDatabase(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: unknown; errno?: unknown; fatal?: unknown }
  if (e.code === 'ERR_SQLITE_ERROR') return true
  // MySQL server errors are 1000-1999 and 3000+; 2000-2999 are client-side (connection) errors.
  return typeof e.errno === 'number' && e.errno >= 1000 && !(e.errno >= 2000 && e.errno < 3000) && !MYSQL_CONNECTION.has(e.errno) && e.fatal !== true
}

/** What kind of transient failure this is, or null when retrying cannot help. */
export function transientKind(error: unknown): TransientKind | null {
  if (!error || typeof error !== 'object') return null
  const e = error as { code?: unknown; errno?: unknown; errcode?: unknown; message?: unknown; fatal?: unknown }
  if (e.code === 'COMMIT_OUTCOME_UNKNOWN') return null
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
  /**
   * Keep retrying a `lock` error past `retries` until this much time has passed (pauses of at most 100 ms). SQLite
   * uses it: its own lock wait blocks the process, so it is kept to short slices and the waiting happens here.
   */
  lockBudgetMs?: number
  /** Getting a connection: no further attempt once this much time has passed (the connect deadline is a total). */
  acquireBudgetMs?: number
}

export interface RetryOptions extends ResilienceOptions {
  canRetry?: (kind: TransientKind) => boolean
  /** No further attempt once this much time has passed since the first one started. */
  budgetMs?: number
}

// The settings a database was opened with, so that withTransaction() retries the way its statements do.
const settings = new WeakMap<object, ResilienceOptions>()
export const rememberResilience = (db: object, options: ResilienceOptions): void => void settings.set(db, options)
export const resilienceOf = (db: object): ResilienceOptions => settings.get(db) ?? {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Run `fn`, replaying it on a transient error that `canRetry` accepts, at most `retries` extra times. */
export async function retryTransient<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { retries = 2, backoffMs = 50, onRetry, canRetry = () => true, lockBudgetMs = 0, budgetMs = Infinity } = options
  const started = Date.now()
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (error) {
      const kind = transientKind(error)
      if (!kind || !canRetry(kind)) throw error
      const elapsed = Date.now() - started
      const waiting = kind === 'lock' && elapsed < lockBudgetMs
      if ((attempt >= retries && !waiting) || elapsed >= budgetMs) throw error
      onRetry?.({ attempt: attempt + 1, kind, error: message(error) })
      const pause = backoffMs * 2 ** Math.min(attempt, 10)
      await sleep(waiting ? Math.min(pause, 100) : pause)
    }
  }
}

/** A statement that may be sent twice without changing anything: a read, or opening a transaction. */
const isReplaySafe = (query: CompiledQuery): boolean => SelectQueryNode.is(query.query) || /^\s*(select|begin)\b/i.test(query.sql)

class ResilientConnection implements DatabaseConnection {
  inTransaction = false
  /** Set when a failed COMMIT already cleaned up: the ROLLBACK Kysely sends next must not run (or mask the error). */
  commitFailed = false
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
    const connection = await retryTransient(() => this.inner.acquireConnection(), { ...this.options, budgetMs: this.options.acquireBudgetMs })
    return new ResilientConnection(connection, this.inner, this.options)
  }
  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    const c = connection as ResilientConnection
    await this.inner.beginTransaction(c, settings) // through executeQuery above: a dead pooled connection is replaced
    c.inTransaction = true
    c.commitFailed = false
  }
  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const c = connection as ResilientConnection
    try {
      await this.inner.commitTransaction(c.inner)
    } catch (error) {
      if (answeredByDatabase(error)) throw error // known not committed: Kysely rolls back, the caller may replay
      // No answer to COMMIT. Roll back here (it only helps when the commit never arrived; on a dead connection it
      // fails, and that failure must not replace this error), then tell the caller the truth.
      c.commitFailed = true
      await this.inner.rollbackTransaction(c.inner).catch(() => undefined)
      throw new CommitOutcomeUnknownError(error)
    } finally {
      c.inTransaction = false
    }
  }
  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    const c = connection as ResilientConnection
    if (c.commitFailed) {
      c.commitFailed = false
      return
    }
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
