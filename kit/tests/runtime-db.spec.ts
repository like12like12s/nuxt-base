// @vitest-environment node
// The locked data layer (kit/runtime/db/**) at the source. Everything dialect-dependent runs on SQLite always and on
// MySQL when TEST_MYSQL_URL points at a server where `test_*` schemas may be created (the kit gate provides one).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sql, type CompiledQuery, type DatabaseConnection, type Dialect, type Driver, type Kysely } from 'kysely'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { runWithContext } from '../runtime/api/context'
import { databaseChecks } from '../runtime/db/checks'
import { runDbCli } from '../runtime/db/cli'
import { newId, now, setClock, setIdGenerator } from '../runtime/db/clock'
import { openDatabase, parseDatabaseUrl } from '../runtime/db/connect'
import { appliedMigrations, backupSqlite, verifySqliteFile, migrateDown, migrateReset, migrateUp, schemaState, type Migrations } from '../runtime/db/migrate'
import { DbTimeoutError } from '../runtime/db/mysql'
import { audited, created, fromJson, softDeleted, toJson, touched, withTransaction, writeAudit } from '../runtime/db/repo'
import { retryTransient, transientKind, type RetryEvent } from '../runtime/db/resilient'
import { baseMigration, standardColumns, type BaseTables } from '../runtime/db/schema'
import { createTestDb, mysqlSkipNotice, mysqlTestUrl, type TestDb } from '../runtime/testing/test-db'

interface Things { id: string; name: string; count: number; createdAt: string; updatedAt: string; deletedAt: string | null }
interface Schema extends BaseTables { things: Things }

const migrations: Migrations = {
  '0001_base': baseMigration,
  '0002_things': {
    up: async (db) => {
      await standardColumns(db.schema.createTable('things'))
        .addColumn('name', 'varchar(191)', (c) => c.notNull())
        .addColumn('count', 'integer', (c) => c.notNull().defaultTo(0))
        .execute()
    },
    down: async (db) => { await db.schema.dropTable('things').execute() },
  },
}

const MYSQL = mysqlTestUrl() !== null
const DIALECTS = MYSQL ? (['sqlite', 'mysql'] as const) : (['sqlite'] as const)
if (!MYSQL) mysqlSkipNotice('every MySQL case of kit/tests/runtime-db.spec.ts (npm run gate:kit runs them)')

const open: TestDb<any>[] = []
async function testDb(options: Parameters<typeof createTestDb>[0] = {}): Promise<TestDb<Schema>> {
  const db = await createTestDb<Schema>({ label: 'kit', ...options })
  open.push(db)
  return db
}
afterAll(async () => { for (const db of open.splice(0)) await db.cleanup() })
afterEach(() => { setClock(); setIdGenerator() })

// --- fault injection: a dialect whose connections fail on demand, underneath the retry layer -------------------------
const fault = (fields: Record<string, unknown>, message = 'injected') => Object.assign(new Error(message), fields)
const DEADLOCK = () => fault({ errno: 1213, code: 'ER_LOCK_DEADLOCK' }, 'Deadlock found when trying to get lock')
const LOCK_WAIT = () => fault({ errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' })
const RESET = () => fault({ code: 'ECONNRESET' }, 'read ECONNRESET')
const REFUSED = () => fault({ code: 'ECONNREFUSED' }, 'connect ECONNREFUSED')
const CLOSED = () => fault({ fatal: true }, "Can't add new command when connection is in closed state")
const DUPLICATE = () => fault({ errno: 1062, code: 'ER_DUP_ENTRY' }, 'Duplicate entry')

interface Flaky {
  /** Fail the next `times` statements matching `on` (after they ran, when `applied` is set — a lost acknowledgement). */
  failQuery(on: RegExp, error: () => Error, times?: number, applied?: boolean): void
  failAcquire(error: () => Error, times?: number): void
  /** Every statement that reached the (flaky) connection. */
  sent: string[]
  acquired: number
  wrap(dialect: Dialect): Dialect
}

function flaky(): Flaky {
  const queries: { on: RegExp; error: () => Error; times: number; applied: boolean }[] = []
  let acquire: { error: () => Error; times: number } | undefined
  const state: Flaky = {
    sent: [],
    acquired: 0,
    failQuery: (on, error, times = 1, applied = false) => { queries.push({ on, error, times, applied }) },
    failAcquire: (error, times = 1) => { acquire = { error, times } },
    wrap: (dialect) => ({
      createQueryCompiler: () => dialect.createQueryCompiler(),
      createAdapter: () => dialect.createAdapter(),
      createIntrospector: (db: Kysely<any>) => dialect.createIntrospector(db),
      createDriver: (): Driver => {
        const inner = dialect.createDriver()
        const real = new WeakMap<DatabaseConnection, DatabaseConnection>()
        return {
          init: () => inner.init(),
          destroy: () => inner.destroy(),
          async acquireConnection() {
            if (acquire && acquire.times > 0) { acquire.times--; throw acquire.error() }
            state.acquired++
            const connection = await inner.acquireConnection()
            const wrapped: DatabaseConnection = {
              async executeQuery<R>(query: CompiledQuery) {
                state.sent.push(query.sql)
                const hit = queries.find((q) => q.times > 0 && q.on.test(query.sql))
                if (hit) {
                  hit.times--
                  if (hit.applied) await connection.executeQuery<R>(query)
                  throw hit.error()
                }
                return connection.executeQuery<R>(query)
              },
              streamQuery: (query, chunkSize) => connection.streamQuery(query, chunkSize),
            }
            real.set(wrapped, connection)
            return wrapped
          },
          beginTransaction: (connection, settings) => inner.beginTransaction(connection, settings),
          commitTransaction: (connection) => inner.commitTransaction(connection),
          rollbackTransaction: (connection) => inner.rollbackTransaction(connection),
          releaseConnection: (connection) => inner.releaseConnection(real.get(connection) ?? connection),
        }
      },
    }),
  }
  return state
}

async function flakyDb(dialect: 'sqlite' | 'mysql', retries = 2) {
  const f = flaky()
  const events: RetryEvent[] = []
  const database = await testDb({ migrations, dialect, options: { retries, backoffMs: 1, wrapDialect: f.wrap, onRetry: (e) => events.push(e) } })
  f.sent.length = 0
  const count = async () => Number((await database.db.selectFrom('things').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)
  const insert = (name: string) => database.db.insertInto('things').values({ ...created(), name, count: 0 }).execute()
  return { f, events, database, db: database.db, count, insert }
}

// ---------------------------------------------------------------------------------------------------------------------

describe('DATABASE_URL', () => {
  const mysqlUrl = ['mysql://app', 'p%40ss@db.internal:3307/shop_db'].join(':')

  it('selects the dialect', () => {
    expect(parseDatabaseUrl('sqlite:./data/app.db')).toEqual({ dialect: 'sqlite', file: './data/app.db' })
    expect(parseDatabaseUrl('sqlite:/var/data/app.db')).toEqual({ dialect: 'sqlite', file: '/var/data/app.db' })
    expect(parseDatabaseUrl('sqlite::memory:')).toEqual({ dialect: 'sqlite', file: ':memory:' })
    expect(parseDatabaseUrl(mysqlUrl)).toEqual({ dialect: 'mysql', host: 'db.internal', port: 3307, user: 'app', password: 'p@ss', database: 'shop_db' })
    expect(parseDatabaseUrl(mysqlUrl.replace(':3307', ''))).toMatchObject({ port: 3306 })
  })

  it('rejects what it cannot use without ever repeating the URL (it may hold a password)', () => {
    for (const bad of [['postgres://u', 'hunter2@h/db'].join(':'), 'sqlite:', ['mysql://u', 'hunter2@/db'].join(':'), ['mysql://u', 'hunter2@host'].join(':'), 'hunter2']) {
      let message = ''
      try { parseDatabaseUrl(bad) } catch (e) { message = (e as Error).message }
      expect(message, bad).toMatch(/^DATABASE_URL: /)
      expect(message, bad).not.toContain('hunter2')
    }
  })
})

describe('clock and ids', () => {
  it('timestamps are ISO-8601 UTC strings, ids are UUIDs, and both can be pinned', () => {
    expect(now()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    setClock(() => new Date('2030-05-05T05:05:05.000Z'))
    setIdGenerator(() => 'fixed')
    expect([now(), newId()]).toEqual(['2030-05-05T05:05:05.000Z', 'fixed'])
    expect(created()).toEqual({ id: 'fixed', createdAt: '2030-05-05T05:05:05.000Z', updatedAt: '2030-05-05T05:05:05.000Z', deletedAt: null })
    expect(touched()).toEqual({ updatedAt: '2030-05-05T05:05:05.000Z' })
    expect(softDeleted()).toEqual({ deletedAt: '2030-05-05T05:05:05.000Z', updatedAt: '2030-05-05T05:05:05.000Z' })
    expect(fromJson(toJson(['a']), [])).toEqual(['a'])
    expect(fromJson('{broken', ['fallback'])).toEqual(['fallback'])
    expect(fromJson(null, 1)).toBe(1)
  })
})

describe.each(DIALECTS)('migrations on %s', (dialect) => {
  it('up -> down -> up with one migration set; base tables carry the standard columns', async () => {
    const { db } = await testDb({ dialect })
    const names = Object.keys(migrations)
    expect(await appliedMigrations(db)).toBeNull()
    expect(await schemaState(db, migrations)).toMatchObject({ state: 'behind', pending: names, current: null, expected: '0002_things' })

    expect((await migrateUp(db, migrations)).map((r) => `${r.migrationName} ${r.direction} ${r.status}`)).toEqual(['0001_base Up Success', '0002_things Up Success'])
    expect(await schemaState(db, migrations)).toEqual({ state: 'ok', current: '0002_things', expected: '0002_things', pending: [], unknown: [] })
    const columns = async () => Object.fromEntries((await db.introspection.getTables()).map((t) => [t.name, t.columns.map((c) => c.name).sort()]))
    const up = await columns()
    expect(up.users).toEqual(['createdAt', 'deletedAt', 'email', 'id', 'name', 'roles', 'subject', 'updatedAt'])
    expect(up.audit).toEqual(['action', 'actor', 'after', 'before', 'id', 'target', 'traceId', 'ts'])
    expect(up.service_tokens).toEqual(['createdAt', 'deletedAt', 'expiresAt', 'hash', 'id', 'lastUsedAt', 'name', 'revokedAt', 'roles', 'updatedAt'])
    expect(up.things).toEqual(['count', 'createdAt', 'deletedAt', 'id', 'name', 'updatedAt'])

    expect((await migrateDown(db, migrations)).map((r) => `${r.migrationName} ${r.direction}`)).toEqual(['0002_things Down'])
    expect(await schemaState(db, migrations)).toMatchObject({ state: 'behind', pending: ['0002_things'], current: '0001_base' })
    await migrateReset(db, migrations)
    expect(await appliedMigrations(db)).toEqual([])
    expect(Object.keys(await columns()).filter((t) => ['users', 'audit', 'service_tokens', 'things'].includes(t))).toEqual([])

    await migrateUp(db, migrations)
    expect(await columns()).toEqual(up)
    expect(await migrateUp(db, migrations)).toEqual([])
  })

  it('a database with a migration this build does not know is "ahead", and a migration without down() is refused', async () => {
    const { db } = await testDb({ dialect, migrations })
    expect(await schemaState(db, { '0001_base': baseMigration })).toMatchObject({ state: 'ahead', unknown: ['0002_things'] })
    await expect(migrateUp(db, { ...migrations, '0003_oneway': { up: async () => {} } })).rejects.toThrow(/0003_oneway has no down\(\)/)
  })

  it('a failing migration reports which one and leaves the database on the previous version', async () => {
    const { db } = await testDb({ dialect, migrations })
    const broken: Migrations = { ...migrations, '0003_broken': { up: async (d) => { await d.schema.createTable('things').addColumn('id', 'integer').execute() }, down: async () => {} } }
    await expect(migrateUp(db, broken)).rejects.toThrow(/migrate up failed at 0003_broken/)
    expect(await appliedMigrations(db)).toEqual(['0001_base', '0002_things'])
  })
})

describe.each(DIALECTS)('audit + soft delete on %s', (dialect) => {
  it('audited() commits the write and its audit row together, with actor and trace id from the request context', async () => {
    const { db } = await testDb({ dialect, migrations })
    const row = { ...created(), name: 'a', count: 1 }
    const result = await runWithContext({ traceId: 'trace-abc', user: { subject: 'u-7', roles: [] } }, () =>
      audited(db, { action: 'thing.create' }, async (trx) => {
        await trx.insertInto('things').values(row).execute()
        return { result: row.id, target: `thing:${row.id}`, after: row }
      }),
    )
    expect(result).toBe(row.id)
    const audit = await db.selectFrom('audit').selectAll().execute()
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor: 'u-7', action: 'thing.create', target: `thing:${row.id}`, before: null, traceId: 'trace-abc' })
    expect(JSON.parse(audit[0]!.after!)).toEqual(row)
    expect(audit[0]!.ts).toMatch(/Z$/)
  })

  it('a write that fails leaves neither data nor audit; an unchanged write leaves no audit; outside a request the actor is system', async () => {
    const { db } = await testDb({ dialect, migrations })
    await expect(
      audited(db, { action: 'thing.create', target: 'thing:x' }, async (trx) => {
        await trx.insertInto('things').values({ ...created(), name: 'never', count: 0 }).execute()
        throw new Error('validation failed after the insert')
      }),
    ).rejects.toThrow('validation failed')
    expect(await db.selectFrom('things').selectAll().execute()).toEqual([])
    expect(await db.selectFrom('audit').selectAll().execute()).toEqual([])

    await audited(db, { action: 'thing.sync', target: 'thing:y' }, async () => ({ result: null, before: { n: 1 }, after: { n: 1 } }))
    expect(await db.selectFrom('audit').selectAll().execute()).toEqual([])
    await audited(db, { action: 'thing.sync', target: 'thing:y' }, async () => ({ result: null, before: { n: 1 }, after: { n: 2 } }))
    await writeAudit(db, { action: 'job.run', target: 'job:nightly', actor: 'cron' })
    expect((await db.selectFrom('audit').select(['actor', 'action', 'traceId']).orderBy('action').execute())).toEqual([
      { actor: 'cron', action: 'job.run', traceId: null },
      { actor: 'system', action: 'thing.sync', traceId: null },
    ])
    await expect(audited(db, { action: 'thing.x' }, async () => ({ result: 1 }))).rejects.toThrow(/no target/)
  })

  it('soft delete keeps the row and hides it from live reads', async () => {
    const { db } = await testDb({ dialect, migrations })
    const a = { ...created(), name: 'a', count: 0 }
    const b = { ...created(), name: 'b', count: 0 }
    await db.insertInto('things').values([a, b]).execute()
    await db.updateTable('things').set(softDeleted()).where('id', '=', a.id).execute()
    expect((await db.selectFrom('things').select('id').where('deletedAt', 'is', null).execute()).map((r) => r.id)).toEqual([b.id])
    const all = await db.selectFrom('things').select(['id', 'deletedAt']).orderBy('name').execute()
    expect(all.map((r) => r.deletedAt === null)).toEqual([false, true])
  })
})

describe('transient errors — what is retried and what is not', () => {
  it('classifies', () => {
    expect([DEADLOCK(), LOCK_WAIT()].map(transientKind)).toEqual(['lock', 'lock'])
    expect(transientKind(fault({ code: 'ERR_SQLITE_ERROR', errcode: 5 }))).toBe('lock') // SQLITE_BUSY
    expect(transientKind(fault({ code: 'ERR_SQLITE_ERROR', errcode: 261 }))).toBe('lock') // SQLITE_BUSY_RECOVERY
    expect(transientKind(fault({ code: 'ERR_SQLITE_ERROR', errcode: 19 }))).toBeNull() // SQLITE_CONSTRAINT
    expect([REFUSED(), fault({ code: 'EPIPE' }), fault({ code: 'POOL_ACQUIRE_TIMEOUT' }), fault({}, "Can't add new command when connection is in closed state")].map(transientKind)).toEqual(['unsent', 'unsent', 'unsent', 'unsent'])
    expect([RESET(), fault({ code: 'PROTOCOL_CONNECTION_LOST' }), fault({ errno: 2013 })].map(transientKind)).toEqual(['connection', 'connection', 'connection'])
    for (const permanent of [DUPLICATE(), fault({ errno: 1064 }), new DbTimeoutError('QUERY_TIMEOUT', 5), new Error('boom'), null, 'text']) expect(transientKind(permanent)).toBeNull()
  })

  it('retryTransient is bounded and backs off', async () => {
    const attempts: number[] = []
    await expect(retryTransient(async (n) => { attempts.push(n); throw DEADLOCK() }, { retries: 2, backoffMs: 1 })).rejects.toThrow(/Deadlock/)
    expect(attempts).toEqual([0, 1, 2])
    expect(await retryTransient(async (n) => { if (n < 1) throw REFUSED(); return 'ok' }, { backoffMs: 1 })).toBe('ok')
    const never = vi.fn(async () => { throw DUPLICATE() })
    await expect(retryTransient(never, { backoffMs: 1 })).rejects.toThrow(/Duplicate/)
    expect(never).toHaveBeenCalledTimes(1)
    await expect(retryTransient(async () => { throw DEADLOCK() }, { retries: 0 })).rejects.toThrow()
  })

  describe.each(DIALECTS)('fault injection on %s', (dialect) => {
    it('a deadlock on a write is replayed and applied exactly once', async () => {
      const t = await flakyDb(dialect)
      t.f.failQuery(/insert into .things./i, DEADLOCK)
      await t.insert('a')
      expect(await t.count()).toBe(1)
      expect(t.events).toEqual([{ attempt: 1, kind: 'lock', error: 'Deadlock found when trying to get lock' }])
      expect(t.f.sent.filter((s) => /insert into/i.test(s))).toHaveLength(2)
    })

    it('gives up after the configured number of retries', async () => {
      const t = await flakyDb(dialect, 2)
      t.f.failQuery(/insert into/i, LOCK_WAIT, 10)
      await expect(t.insert('a')).rejects.toMatchObject({ errno: 1205 })
      expect(t.f.sent.filter((s) => /insert into/i.test(s))).toHaveLength(3) // 1 + 2 retries
      expect(t.events.map((e) => e.attempt)).toEqual([1, 2])
    })

    it('a permanent error is not retried', async () => {
      const t = await flakyDb(dialect)
      t.f.failQuery(/insert into/i, DUPLICATE)
      await expect(t.insert('a')).rejects.toMatchObject({ errno: 1062 })
      expect(t.f.sent.filter((s) => /insert into/i.test(s))).toHaveLength(1)
      expect(t.events).toEqual([])
    })

    it('a connection lost mid-flight replays a read but never a write (it may have been applied)', async () => {
      const t = await flakyDb(dialect)
      t.f.failQuery(/^select/i, RESET)
      expect(await t.count()).toBe(0) // the read came back after one retry, on a fresh connection
      expect(t.events.map((e) => e.kind)).toEqual(['connection'])

      t.f.failQuery(/insert into/i, RESET, 1, true) // applied on the server, acknowledgement lost
      await expect(t.insert('once')).rejects.toMatchObject({ code: 'ECONNRESET' })
      expect(t.f.sent.filter((s) => /insert into/i.test(s))).toHaveLength(1)
      expect(await t.count()).toBe(1) // a replay would have made it 2
    })

    it('failing to get a connection is retried — nothing was sent yet', async () => {
      const t = await flakyDb(dialect)
      t.f.failAcquire(REFUSED, 2)
      await t.insert('a')
      expect(await t.count()).toBe(1)
      expect(t.events.map((e) => e.kind)).toEqual(['unsent', 'unsent'])
      t.f.failAcquire(REFUSED, 5)
      await expect(t.insert('b')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    })

    it('inside a transaction a statement is never replayed on its own; withTransaction() replays the whole unit', async () => {
      const t = await flakyDb(dialect)
      t.f.failQuery(/insert into .things./i, DEADLOCK)
      await expect(t.db.transaction().execute(async (trx) => { await trx.insertInto('things').values({ ...created(), name: 'x', count: 0 }).execute() })).rejects.toMatchObject({ errno: 1213 })
      expect(t.f.sent.filter((s) => /insert into/i.test(s))).toHaveLength(1)
      expect(await t.count()).toBe(0)

      let runs = 0
      t.f.failQuery(/update .things./i, DEADLOCK)
      await withTransaction(t.db, async (trx) => {
        runs++
        await trx.insertInto('things').values({ ...created(), name: `run ${runs}`, count: 0 }).execute()
        await trx.updateTable('things').set({ count: 5 }).execute()
      }, { backoffMs: 1 })
      expect(runs).toBe(2)
      // the first run was rolled back as a whole: only the second run's row exists
      expect(await t.db.selectFrom('things').select(['name', 'count']).execute()).toEqual([{ name: 'run 2', count: 5 }])

      let failed = 0
      await expect(withTransaction(t.db, async () => { failed++; throw DUPLICATE() }, { backoffMs: 1 })).rejects.toMatchObject({ errno: 1062 })
      expect(failed).toBe(1)
    })

    // H1 (review t1097): the COMMIT is applied, its acknowledgement is lost, and the ROLLBACK Kysely sends next fails
    // on the dead connection with mysql2's "closed state" message — which used to be classified `unsent` and replayed.
    it('a COMMIT whose acknowledgement is lost is never replayed: the unit runs once and fails COMMIT_OUTCOME_UNKNOWN', async () => {
      const t = await flakyDb(dialect)
      t.f.failQuery(/^commit$/i, () => fault({ code: 'ECONNRESET', fatal: true }, 'read ECONNRESET'), 1, true)
      t.f.failQuery(/^rollback$/i, CLOSED, 5)
      let runs = 0
      const row = { ...created(), name: 'once', count: 0 }
      const outcome = await audited(t.db, { action: 'thing.create' }, async (trx) => {
        runs++
        await trx.insertInto('things').values({ ...row, id: `${row.id}-${runs}` }).execute()
        return { result: row.id, target: `thing:${row.id}`, after: row }
      }).then(() => 'ok', (e: Error & { code?: string }) => e)
      const audit = Number((await t.db.selectFrom('audit').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)
      expect({ runs, things: await t.count(), audit, commits: t.f.sent.filter((s) => /^commit$/i.test(s)).length }).toEqual({ runs: 1, things: 1, audit: 1, commits: 1 })
      expect(outcome).toMatchObject({ name: 'CommitOutcomeUnknownError', code: 'COMMIT_OUTCOME_UNKNOWN' })
      expect(transientKind(outcome)).toBeNull()
      expect((outcome as Error).cause).toMatchObject({ code: 'ECONNRESET' })
      expect(t.events).toEqual([])
      // the pool is usable afterwards
      await t.insert('next')
      expect(await t.count()).toBe(2)
    })

    it('a COMMIT the database itself refused (deadlock) is known to have failed: the unit is replayed', async () => {
      const t = await flakyDb(dialect)
      t.f.failQuery(/^commit$/i, DEADLOCK)
      let runs = 0
      await withTransaction(t.db, async (trx) => { runs++; await trx.insertInto('things').values({ ...created(), name: `run ${runs}`, count: 0 }).execute() }, { backoffMs: 1 })
      expect(runs).toBe(2)
      expect(await t.db.selectFrom('things').select('name').execute()).toEqual([{ name: 'run 2' }])
    })
  })

  it('SQLite: a real SQLITE_BUSY from a second writer is classified as a lock and retried, bounded', async () => {
    const first = await testDb({ dialect: 'sqlite', migrations })
    const events: RetryEvent[] = []
    const second = openDatabase<Schema>({ url: first.url, connectTimeoutMs: 100, retries: 1, backoffMs: 1, onRetry: (e) => events.push(e) })
    try {
      await first.db.transaction().execute(async (trx) => {
        await trx.insertInto('things').values({ ...created(), name: 'holds the write lock', count: 0 }).execute()
        await expect(second.db.insertInto('things').values({ ...created(), name: 'blocked', count: 0 }).execute()).rejects.toMatchObject({ code: 'ERR_SQLITE_ERROR' })
      })
      expect(events.map((e) => e.kind)).toEqual(['lock'])
      // once the lock is gone the same statement goes through
      await second.db.insertInto('things').values({ ...created(), name: 'after', count: 0 }).execute()
      expect(await second.db.selectFrom('things').select('name').orderBy('name').execute()).toEqual([{ name: 'after' }, { name: 'holds the write lock' }])
    } finally {
      await second.close()
    }
  })

  it('an unreachable server fails within the deadline, after bounded retries, and readiness reports it', async () => {
    const events: RetryEvent[] = []
    const url = ['mysql://nobody', 'x@127.0.0.1:1/nothing'].join(':') // port 1: nothing listens
    const database = openDatabase<Schema>({ url, connectTimeoutMs: 500, retries: 1, backoffMs: 5, onRetry: (e) => events.push(e) })
    try {
      const started = Date.now()
      await expect(database.ping()).rejects.toMatchObject({ code: 'ECONNREFUSED' })
      expect(Date.now() - started).toBeLessThan(3000)
      expect(events.map((e) => e.kind)).toEqual(['unsent'])
      const report = await Promise.all(databaseChecks(database, migrations).map((c) => c.run().then(() => 'ok', (e: Error) => `${e.constructor.name}: ${e.message}`)))
      expect(report).toEqual(['HealthCheckError: unreachable', 'HealthCheckError: unknown'])
    } finally {
      await database.close()
    }
  })
})

describe('readiness checks', () => {
  it('ok on a migrated database; "schema behind" names the pending migration; a closed database is unreachable', async () => {
    const database = await testDb({ dialect: 'sqlite', migrations })
    const run = (m: Migrations) => Promise.all(databaseChecks(database, m).map((c) => c.run().then(() => 'ok', (e: Error) => e.message)))
    expect(await run(migrations)).toEqual(['ok', 'ok'])
    expect(await run({ ...migrations, '0003_next': { up: async () => {}, down: async () => {} } })).toEqual(['ok', 'schema behind: 1 pending migration(s): 0003_next'])
    expect(await run({ '0001_base': baseMigration })).toEqual(['ok', 'schema ahead: the database has migration(s) this build does not know: 0002_things'])
    await database.close()
    expect(await run(migrations)).toEqual(['unreachable', 'unknown'])
  })
})

describe('db commands', () => {
  const cli = (database: TestDb<Schema>, env: Record<string, string> = {}, hook?: (cmd: string) => number) => {
    const lines: string[] = []
    const run = (...argv: string[]) => runDbCli(argv, { url: database.url, migrations, out: (l) => lines.push(l), env, runBackupCommand: hook, seed: async (d) => { if (!(await d.db.selectFrom('things').select('id').where('id', '=', 'seed-1').executeTakeFirst())) await d.db.insertInto('things').values({ ...created(), id: 'seed-1', name: 'seeded', count: 0 }).execute() } })
    return { run, lines }
  }

  it('SQLite: check / migrate / seed / status, and a file copy before a migration touches existing data', async () => {
    const database = await testDb({ dialect: 'sqlite' })
    const { run, lines } = cli(database)
    expect(await run('check')).toBe(1)
    expect(await run('migrate')).toBe(0) // `migrate` = `migrate up`
    expect(lines.filter((l) => l.startsWith('backup'))).toEqual([]) // a new database has nothing to back up
    expect(lines.at(-1)).toBe('schema ok (0002_things)')
    expect([await run('check'), await run('seed'), await run('seed')]).toEqual([0, 0, 0])
    expect(await database.db.selectFrom('things').select('id').execute()).toEqual([{ id: 'seed-1' }])

    expect(await run('migrate', 'down')).toBe(0)
    const backups = join(dirname((database.target as { file: string }).file), 'backups')
    expect(readdirSync(backups)).toHaveLength(1)
    lines.length = 0
    expect(await run('migrate', 'status')).toBe(0)
    expect(lines).toEqual(['applied  0001_base', 'pending  0002_things'])
    expect(await run('migrate', 'up', '--no-backup')).toBe(0)
    expect(readdirSync(backups)).toHaveLength(1)
    for (const bad of [['nope'], ['migrate', 'sideways'], ['check', '--force'], []]) expect(await run(...bad)).toBe(2)
  })

  // H2 (review t1097): another connection holds a read snapshot (the running API, a job, the old container), so the
  // WAL cannot be checkpointed — a plain file copy then misses pages or is malformed.
  it('SQLite: the backup is a consistent, verified snapshot while another connection holds a read', async () => {
    const database = await testDb({ dialect: 'sqlite', migrations })
    const file = (database.target as { file: string }).file
    const reader = new DatabaseSync(file)
    try {
      reader.exec('BEGIN')
      reader.prepare('select count(*) from things').get()
      for (let i = 0; i < 40; i++) await database.db.insertInto('things').values({ ...created(), name: `row ${i} ${'x'.repeat(400)}`, count: i }).execute()
      const copy = (await backupSqlite(database, '2026-01-01T00:00:00.000Z'))!
      expect(copy).toMatch(/backups\/.*\.20260101T000000000Z\.bak$/)
      const backup = new DatabaseSync(copy, { readOnly: true })
      try {
        expect(backup.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
        expect((backup.prepare('select count(*) as n from things').get() as { n: number }).n).toBe(40)
      } finally { backup.close() }
      // the same stamp twice never overwrites an earlier backup
      const again = (await backupSqlite(database, '2026-01-01T00:00:00.000Z'))!
      expect(again).not.toBe(copy)
      expect(existsSync(copy) && existsSync(again)).toBe(true)
    } finally {
      reader.exec('ROLLBACK')
      reader.close()
    }
  })

  it('SQLite: a backup that cannot be taken or does not verify refuses the migration (exit 3, schema untouched)', async () => {
    const database = await testDb({ dialect: 'sqlite', migrations: { '0001_base': baseMigration } })
    const file = (database.target as { file: string }).file
    writeFileSync(join(dirname(file), 'backups'), 'not a directory') // the backup cannot be written
    const { run, lines } = cli(database)
    expect(await run('migrate', 'up')).toBe(3)
    expect(lines.at(-1)).toMatch(/^REFUSED: the backup before migrating failed/)
    expect(await schemaState(database.db, migrations)).toMatchObject({ state: 'behind', pending: ['0002_things'] })
    expect(await run('migrate', 'down')).toBe(3)
    expect(await appliedMigrations(database.db)).toEqual(['0001_base'])

    // a copy that is not a healthy database is rejected by the verification
    const broken = join(dirname(file), 'broken.bak')
    writeFileSync(broken, Buffer.concat([readFileSync(file).subarray(0, 100), Buffer.alloc(8192, 0x5a)]))
    expect(() => verifySqliteFile(broken)).toThrow(/backup verification failed/)
    expect(() => verifySqliteFile(file)).not.toThrow()
  })

  it('predeploy only checks — unless DB_MIGRATE_ON_DEPLOY=1, then it migrates first', async () => {
    const database = await testDb({ dialect: 'sqlite' })
    expect(await cli(database).run('predeploy')).toBe(1)
    expect(await appliedMigrations(database.db)).toBeNull()
    expect(await cli(database, { DB_MIGRATE_ON_DEPLOY: '1' }).run('predeploy')).toBe(0)
    expect(await appliedMigrations(database.db)).toEqual(['0001_base', '0002_things'])
    expect(await cli(database).run('predeploy')).toBe(0)
  })

  it('a database ahead of the code is never migrated', async () => {
    const database = await testDb({ dialect: 'sqlite', migrations: { ...migrations, '0003_future': { up: async () => {}, down: async () => {} } } })
    const { run, lines } = cli(database)
    expect(await run('migrate', 'up')).toBe(1)
    expect(lines.at(-1)).toContain('schema ahead')
  })

  it.skipIf(!MYSQL)('MySQL: refuses to migrate existing data without a backup — hook, explicit override, or nothing', async () => {
    const database = await testDb({ dialect: 'mysql' })
    // a database that was never migrated holds nothing: no backup needed
    expect(await cli(database).run('migrate', 'up')).toBe(0)
    const down = () => cli(database, { DB_MIGRATE_NO_BACKUP: '1' }).run('migrate', 'down')
    expect(await down()).toBe(0)

    const refused = cli(database)
    expect(await refused.run('migrate', 'up')).toBe(3)
    expect(refused.lines.at(-1)).toMatch(/^REFUSED: no backup before migrating MySQL/)
    expect(await schemaState(database.db, migrations)).toMatchObject({ state: 'behind' })

    const hook = vi.fn(() => 1)
    expect(await cli(database, { DB_BACKUP_CMD: 'dump-it' }, hook).run('migrate', 'up')).toBe(3)
    expect(hook).toHaveBeenCalledWith('dump-it')
    expect(await schemaState(database.db, migrations)).toMatchObject({ state: 'behind' })

    const ok = vi.fn(() => 0)
    expect(await cli(database, { DB_BACKUP_CMD: 'dump-it' }, ok).run('migrate', 'up')).toBe(0)
    expect(ok).toHaveBeenCalledTimes(1)
    expect(await down()).toBe(0)
    expect(await cli(database).run('migrate', 'up', '--no-backup')).toBe(0)
    expect(await schemaState(database.db, migrations)).toMatchObject({ state: 'ok' })
  })
})

describe.skipIf(!MYSQL)('MySQL: timeouts and dropped connections', () => {
  const admin = async (statement: string) => {
    const { createConnection } = await import('mysql2/promise')
    const url = new URL(mysqlTestUrl()!)
    const connection = await createConnection({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) })
    try { await connection.query(statement) } finally { await connection.end() }
  }
  const connectionId = async (db: Kysely<Schema>) => Number((await sql<{ id: number }>`select connection_id() as id`.execute(db)).rows[0]!.id)

  it('recovers after the server drops the connection: reads and writes work again on a new one', async () => {
    const database = await testDb({ dialect: 'mysql', migrations, options: { poolMax: 1, retries: 2, backoffMs: 20 } })
    const before = await connectionId(database.db)
    await admin(`KILL ${before}`)
    // straight away — the pool may not have noticed yet; the read is replayed on a fresh connection if it has not
    const after = await connectionId(database.db)
    expect(after).not.toBe(before)
    await database.db.insertInto('things').values({ ...created(), name: 'after the drop', count: 0 }).execute()
    expect(await database.db.selectFrom('things').select('name').execute()).toEqual([{ name: 'after the drop' }])
    await database.ping()
  })

  it('a statement that passes its deadline fails with QUERY_TIMEOUT, is not retried, and does not poison the pool', async () => {
    const events: RetryEvent[] = []
    const database = await testDb({ dialect: 'mysql', options: { poolMax: 1, queryTimeoutMs: 300, retries: 2, onRetry: (e) => events.push(e) } })
    const started = Date.now()
    await expect(sql`select sleep(5)`.execute(database.db)).rejects.toMatchObject({ name: 'DbTimeoutError', code: 'QUERY_TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(events).toEqual([])
    expect((await sql<{ one: number }>`select 1 as one`.execute(database.db)).rows).toEqual([{ one: 1 }])
  })

  it('a real lock wait timeout between two sessions is retried, then surfaces', async () => {
    const database = await testDb({ dialect: 'mysql', migrations, options: { poolMax: 2, retries: 1, backoffMs: 5 } })
    const events: RetryEvent[] = []
    const other = openDatabase<Schema>({ url: database.url, poolMax: 1, retries: 1, backoffMs: 5, onRetry: (e) => events.push(e) })
    try {
      const row = { ...created(), name: 'contended', count: 0 }
      await database.db.insertInto('things').values(row).execute()
      await database.db.transaction().execute(async (trx) => {
        await trx.updateTable('things').set({ count: 1 }).where('id', '=', row.id).execute()
        await sql`set session innodb_lock_wait_timeout = 1`.execute(other.db)
        await expect(other.db.updateTable('things').set({ count: 2 }).where('id', '=', row.id).execute()).rejects.toMatchObject({ errno: 1205 })
      })
      expect(events.map((e) => e.kind)).toEqual(['lock'])
      await other.db.updateTable('things').set({ count: 3 }).where('id', '=', row.id).execute()
      expect((await database.db.selectFrom('things').select('count').executeTakeFirstOrThrow()).count).toBe(3)
    } finally {
      await other.close()
    }
  })
})

describe('SQLite driver (node:sqlite)', () => {
  it('binds booleans, dates and undefined; returns change counts; creates the directory of a new file', async () => {
    const database = await testDb({ dialect: 'sqlite' })
    await sql`create table t (a integer, b text, c text)`.execute(database.db)
    const result = await sql`insert into t (a, b, c) values (${true}, ${new Date('2026-02-03T04:05:06.000Z')}, ${undefined})`.execute(database.db)
    expect(result.numAffectedRows).toBe(1n)
    expect((await sql`select * from t`.execute(database.db)).rows).toEqual([{ a: 1, b: '2026-02-03T04:05:06.000Z', c: null }])
    await expect(sql`insert into t (a) values (${{ nested: true }})`.execute(database.db)).rejects.toThrow(/cannot bind/)
    expect((await sql<{ journal_mode: string }>`PRAGMA journal_mode`.execute(database.db)).rows[0]!.journal_mode).toBe('wal')
    expect((await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(database.db)).rows[0]!.foreign_keys).toBe(1)

    const nested = join(dirname((database.target as { file: string }).file), 'a', 'b', 'new.db')
    const fresh = openDatabase({ url: `sqlite:${nested}` })
    await fresh.ping()
    await fresh.close()
    await fresh.close() // closing twice is fine (shutdown hooks may race)
    expect(existsSync(nested)).toBe(true)
  })
})
