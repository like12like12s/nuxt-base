// DO NOT EDIT — locked file from the nuxt-base kit (runtime/db/migrate.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Migrations: one ordered set (name -> { up, down }) that runs on SQLite and MySQL, plus the question every deploy and
// every readiness probe asks — "does the database have exactly the schema this build was written for?".
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { sql, type Kysely } from 'kysely'
import { Migrator, NO_MIGRATIONS, type Migration, type MigrationResult } from 'kysely/migration'
import { isMemory, type Database } from './connect.js'

export type Migrations = Record<string, Migration>

export const MIGRATION_TABLE = 'kysely_migration'

export class MigrationError extends Error {
  readonly results: readonly MigrationResult[]
  constructor(message: string, results: readonly MigrationResult[] = [], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MigrationError'
    this.results = results
  }
}

const sorted = (migrations: Migrations) => Object.keys(migrations).sort()

function migrator(db: Kysely<any>, migrations: Migrations): Migrator {
  for (const name of sorted(migrations)) {
    if (typeof migrations[name]?.down !== 'function') throw new MigrationError(`migration ${name} has no down() — every migration must be reversible`)
  }
  return new Migrator({ db, provider: { getMigrations: async () => migrations } })
}

async function settle(run: Promise<{ error?: unknown; results?: MigrationResult[] }>, what: string): Promise<MigrationResult[]> {
  const { error, results = [] } = await run
  if (error) {
    const failed = results.find((r) => r.status === 'Error')
    throw new MigrationError(`${what} failed${failed ? ` at ${failed.migrationName}` : ''}: ${error instanceof Error ? error.message : String(error)}`, results, error)
  }
  return results
}

/** Apply every pending migration. Returns what ran (empty = already up to date). */
export const migrateUp = async (db: Kysely<any>, migrations: Migrations) => settle(migrator(db, migrations).migrateToLatest(), 'migrate up')
/** Revert the newest applied migration. */
export const migrateDown = async (db: Kysely<any>, migrations: Migrations) => settle(migrator(db, migrations).migrateDown(), 'migrate down')
/** Revert everything. */
export const migrateReset = async (db: Kysely<any>, migrations: Migrations) => settle(migrator(db, migrations).migrateTo(NO_MIGRATIONS), 'migrate reset')

/** Names of the migrations recorded in the database, oldest first; null when it has never been migrated. */
export async function appliedMigrations(db: Kysely<any>): Promise<string[] | null> {
  try {
    const rows = await sql<{ name: string }>`select name from ${sql.table(MIGRATION_TABLE)} order by name`.execute(db)
    return rows.rows.map((row) => row.name)
  } catch (error) {
    if (/no such table|doesn't exist/i.test(error instanceof Error ? error.message : '')) return null
    throw error
  }
}

export interface SchemaState {
  /** ok = database == code · behind = code has migrations the database lacks · ahead = the database has migrations this build does not know */
  state: 'ok' | 'behind' | 'ahead'
  /** Newest migration in the database / in the code. */
  current: string | null
  expected: string | null
  pending: string[]
  unknown: string[]
}

/** Compare the database with the migrations this build ships. Read-only: creates nothing. */
export async function schemaState(db: Kysely<any>, migrations: Migrations): Promise<SchemaState> {
  const shipped = sorted(migrations)
  const applied = (await appliedMigrations(db)) ?? []
  const pending = shipped.filter((name) => !applied.includes(name))
  const unknown = applied.filter((name) => !shipped.includes(name))
  return {
    state: unknown.length ? 'ahead' : pending.length ? 'behind' : 'ok',
    current: applied.at(-1) ?? null,
    expected: shipped.at(-1) ?? null,
    pending,
    unknown,
  }
}

export const describeSchema = (s: SchemaState): string =>
  s.state === 'ok'
    ? `schema ok (${s.current ?? 'no migrations'})`
    : s.state === 'behind'
      ? `schema behind: ${s.pending.length} pending migration(s): ${s.pending.join(', ')}`
      : `schema ahead: the database has migration(s) this build does not know: ${s.unknown.join(', ')}`

/**
 * SQLite backup before a migration: checkpoint the WAL into the main file, then copy it next to the database
 * (<dir>/backups/<file>.<stamp>.bak). Returns the copy's path, or null when there is nothing to copy.
 */
export async function backupSqlite(database: Database<any>, stamp: string): Promise<string | null> {
  if (database.target.dialect !== 'sqlite' || isMemory(database.target) || !existsSync(database.target.file)) return null
  await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(database.db)
  const dir = join(dirname(database.target.file), 'backups')
  mkdirSync(dir, { recursive: true })
  const copy = join(dir, `${basename(database.target.file)}.${stamp.replace(/[^0-9A-Za-z]/g, '')}.bak`)
  copyFileSync(database.target.file, copy)
  return copy
}
