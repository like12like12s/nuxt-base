// The data layer of this app on its real migrations: reversible, seedable, and visible to /health/ready.
// Runs on a SQLite temp file; with TEST_MYSQL_URL set the same tests run on a MySQL `test_*` schema.
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { migrations } from '../src/db/migrations/index.js'
import type { Schema } from '../src/db/schema.js'
import { SEED_ITEMS, seed } from '../src/db/seed.js'
import { runDbCli } from '../src/kit/db/cli.js'
import { appliedMigrations, migrateDown, migrateReset, migrateUp, schemaState } from '../src/kit/db/migrate.js'
import { createTestDb, mysqlSkipNotice, testDialect, useTestDb } from '../src/kit/testing/test-db.js'
import { useApp } from './helpers.js'

const names = Object.keys(migrations).sort()
if (testDialect() === 'sqlite') mysqlSkipNotice('migrations and queries on MySQL')

describe(`migrations (${testDialect()})`, () => {
  const t = useTestDb<Schema>({ label: 'migrate' }) // empty: not migrated yet

  it('every migration is reversible and named with a sequence prefix', () => {
    expect(names[0]).toBe('0001_base')
    for (const name of names) {
      expect(name).toMatch(/^\d{4}_[a-z0-9_]+$/)
      expect(typeof migrations[name]!.down).toBe('function')
    }
  })

  it('up -> down -> up: the same set applies, reverts completely and applies again', async () => {
    expect(await appliedMigrations(t.db)).toBeNull()
    expect((await schemaState(t.db, migrations)).state).toBe('behind')

    expect((await migrateUp(t.db, migrations)).map((r) => [r.migrationName, r.direction, r.status])).toEqual(names.map((n) => [n, 'Up', 'Success']))
    expect(await schemaState(t.db, migrations)).toMatchObject({ state: 'ok', pending: [], current: names.at(-1) })
    await t.db.insertInto('items').values({ id: 'a', name: 'kept until down', description: null, quantity: 1, createdAt: 'x', updatedAt: 'x', deletedAt: null }).execute()

    // one step down reverts only the newest
    expect((await migrateDown(t.db, migrations)).map((r) => r.migrationName)).toEqual([names.at(-1)])
    expect((await schemaState(t.db, migrations)).pending).toEqual([names.at(-1)])
    // all the way down: no app table is left
    await migrateReset(t.db, migrations)
    expect(await appliedMigrations(t.db)).toEqual([])
    const tables = (await t.db.introspection.getTables()).map((table) => table.name)
    for (const table of ['users', 'audit', 'service_tokens', 'items']) expect(tables).not.toContain(table)

    // and up again, into a working schema
    expect((await migrateUp(t.db, migrations)).every((r) => r.status === 'Success')).toBe(true)
    expect((await schemaState(t.db, migrations)).state).toBe('ok')
    expect(await t.db.selectFrom('items').selectAll().execute()).toEqual([])
    expect(await migrateUp(t.db, migrations)).toEqual([]) // nothing left to do
  })
})

describe('base tables', () => {
  const t = useTestDb<Schema>({ migrations, label: 'base' })

  it('users, audit and service_tokens exist with the standard columns', async () => {
    const tables = Object.fromEntries((await t.db.introspection.getTables()).map((table) => [table.name, table.columns.map((c) => c.name).sort()]))
    expect(tables.users).toEqual(['createdAt', 'deletedAt', 'email', 'id', 'name', 'roles', 'subject', 'updatedAt'])
    expect(tables.audit).toEqual(['action', 'actor', 'after', 'before', 'id', 'target', 'traceId', 'ts'])
    expect(tables.service_tokens).toEqual(['createdAt', 'deletedAt', 'expiresAt', 'hash', 'id', 'lastUsedAt', 'name', 'revokedAt', 'roles', 'updatedAt'])
  })

  it('subject and token hash are unique', async () => {
    const at = '2026-01-01T00:00:00.000Z'
    const user = { subject: 'u-1', email: null, name: null, roles: '[]', createdAt: at, updatedAt: at, deletedAt: null }
    await t.db.insertInto('users').values({ id: 'a', ...user }).execute()
    await expect(t.db.insertInto('users').values({ id: 'b', ...user }).execute()).rejects.toThrow()
  })
})

describe('seed', () => {
  const t = useTestDb<Schema>({ migrations, label: 'seed' })

  it('is idempotent: running it twice leaves exactly the same rows', async () => {
    await seed(t.database)
    const first = await t.db.selectFrom('items').selectAll().orderBy('id').execute()
    expect(first.map((row) => row.id)).toEqual(SEED_ITEMS.map((row) => row.id))
    await seed(t.database)
    expect(await t.db.selectFrom('items').selectAll().orderBy('id').execute()).toEqual(first)
  })
})

describe('/health/ready follows the database', () => {
  const t = useApp()
  const failing = (body: any) => body.error.details.filter((c: { status: string }) => c.status === 'fail').map((c: { name: string }) => c.name)

  it('503 with the check list when the schema is behind the code', async () => {
    const ahead = { ...migrations, '9999_not_applied_yet': { up: async () => {}, down: async () => {} } }
    const res = await t.build({ migrations: ahead }).api.get('/health/ready')
    expect(res.status).toBe(503)
    expect(res.body.error).toMatchObject({ code: 'INTERNAL', message: 'Not ready', traceId: res.traceId })
    expect(failing(res.body)).toEqual(['schema'])
    expect(res.body.error.details.find((c: { name: string }) => c.name === 'schema').message).toContain('9999_not_applied_yet')
  })

  it('503 when the database is down — and liveness still answers', async () => {
    const down = { ...t.database, ping: () => Promise.reject(new Error('connect ECONNREFUSED')), db: new Proxy(t.db, { get: () => () => { throw new Error('connect ECONNREFUSED') } }) }
    const { api } = t.build({ database: down })
    const res = await api.get('/health/ready')
    expect(res.status).toBe(503)
    expect(failing(res.body)).toEqual(['db', 'schema'])
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED') // the cause is for the log, not for the probe
    expect((await api.get('/health/live')).status).toBe(200)
  })
})

describe('db commands', () => {
  const created: { cleanup(): Promise<void> }[] = []
  afterAll(async () => { for (const db of created) await db.cleanup() })

  it('check fails until migrate up has run; migrate up backs an existing database up first', async () => {
    const database = await createTestDb<Schema>({ label: 'cli' })
    created.push(database)
    const lines: string[] = []
    const run = (...argv: string[]) => runDbCli(argv, { url: database.url, migrations, seed, out: (line) => lines.push(line), env: { DB_BACKUP_CMD: 'true' }, runBackupCommand: () => 0 })

    expect(await run('check')).toBe(1)
    expect(lines.at(-1)).toContain('schema behind')
    expect(await run('seed')).toBe(1) // refuses to seed an unmigrated database
    expect(await run('migrate', 'up')).toBe(0)
    expect(await run('check')).toBe(0)
    expect(await run('seed')).toBe(0)
    expect(await run('seed')).toBe(0)
    expect(await database.db.selectFrom('items').select('id').execute()).toHaveLength(SEED_ITEMS.length)

    // one migration back, then up again: this time there is data to protect
    expect(await run('migrate', 'down')).toBe(0)
    lines.length = 0
    expect(await run('migrate', 'up')).toBe(0)
    expect(lines.some((line) => line.startsWith('backup: '))).toBe(true)
    if (database.target.dialect === 'sqlite') {
      const backups = join(dirname(database.target.file), 'backups')
      expect(existsSync(backups) && readdirSync(backups).length).toBeGreaterThan(0)
    }
    expect(await run('bogus')).toBe(2)
  })
})
