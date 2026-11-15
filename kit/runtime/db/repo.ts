// DO NOT EDIT — locked file from the nuxt-base kit (runtime/db/repo.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// What every repository does the same way: standard column values, soft delete, the audit row that goes with each
// write (same transaction, same traceId as the request log), and a transaction that is replayed on a deadlock.
import type { Kysely, Transaction } from 'kysely'
import { currentActor, currentTraceId } from '../api/context.js'
import { newId, now } from './clock.js'
import { resilienceOf, retryTransient, type ResilienceOptions } from './resilient.js'

/** Values of the standard columns for a new row. */
export const created = () => {
  const at = now()
  return { id: newId(), createdAt: at, updatedAt: at, deletedAt: null }
}
/** `set` clause of an update. */
export const touched = () => ({ updatedAt: now() })
/** `set` clause of a soft delete: DELETE never removes a row. Read live rows with `.where('deletedAt', 'is', null)`. */
export const softDeleted = () => {
  const at = now()
  return { deletedAt: at, updatedAt: at }
}

export const toJson = (value: unknown): string => JSON.stringify(value)
export function fromJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/**
 * A UNIQUE index (or the primary key) refused the write: MySQL ER_DUP_ENTRY (1062) / ER_DUP_ENTRY_WITH_KEY_NAME (1586),
 * SQLite SQLITE_CONSTRAINT_UNIQUE (2067) / SQLITE_CONSTRAINT_PRIMARYKEY (1555). Map it to `conflict(...)` (409) in the
 * repository — the driver's own message names the value and must not reach the client.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: unknown; errno?: unknown; errcode?: unknown }
  if (e.code === 'ERR_SQLITE_ERROR') return e.errcode === 2067 || e.errcode === 1555
  return e.errno === 1062 || e.errno === 1586
}

/**
 * Run `fn` in a transaction. A deadlock, a lock wait timeout or a connection that could not be opened rolls the whole
 * unit back and runs it again (bounded) — so `fn` must only touch the database through `trx`. A COMMIT whose answer
 * was lost is never replayed: it fails with COMMIT_OUTCOME_UNKNOWN (resilient.ts).
 */
export function withTransaction<DB, T>(db: Kysely<DB>, fn: (trx: Transaction<DB>) => Promise<T>, options: ResilienceOptions = {}): Promise<T> {
  // Defaults = what the database was opened with (retries, backoff, SQLite's lock budget); `options` override them.
  return retryTransient(() => db.transaction().execute(fn), { ...resilienceOf(db), ...options, canRetry: (kind) => kind !== 'connection' })
}

export interface AuditEntry {
  /** `<resource>.<verb>`: item.create, item.update, item.delete */
  action: string
  /** `<resource>:<id>` */
  target: string
  before?: unknown
  after?: unknown
  /** Defaults to the authenticated subject of the request ('anonymous' without auth, 'system' outside a request). */
  actor?: string
}

/** Insert the audit row. Pass the transaction of the write it describes. */
export async function writeAudit(db: Kysely<any>, entry: AuditEntry): Promise<void> {
  await db
    .insertInto('audit')
    .values({
      id: newId(),
      ts: now(),
      actor: entry.actor ?? currentActor(),
      action: entry.action,
      target: entry.target,
      before: entry.before === undefined ? null : toJson(entry.before),
      after: entry.after === undefined ? null : toJson(entry.after),
      traceId: currentTraceId() ?? null,
    })
    .execute()
}

export interface Audited<T> {
  result: T
  /** Omit `target` here to use the one passed to audited(). */
  target?: string
  before?: unknown
  after?: unknown
}

/**
 * A write and its audit row as one unit: `fn` does the write and returns the state before / after.
 * When both are given and equal, nothing changed and no audit row is written — a periodic sync that rewrites the
 * same values must not bury the real events.
 */
export function audited<DB, T>(db: Kysely<DB>, entry: { action: string; target?: string; actor?: string }, fn: (trx: Transaction<DB>) => Promise<Audited<T>>): Promise<T> {
  return withTransaction(db, async (trx) => {
    const { result, target, before, after } = await fn(trx)
    const unchanged = before !== undefined && after !== undefined && toJson(before) === toJson(after)
    if (!unchanged) {
      const subject = target ?? entry.target
      if (!subject) throw new Error(`audited(${entry.action}): no target`)
      await writeAudit(trx, { action: entry.action, target: subject, actor: entry.actor, before, after })
    }
    return result
  })
}
