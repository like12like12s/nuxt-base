// DO NOT EDIT — locked file from the nuxt-base kit (runtime/db/cli.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// The database commands of an app (src/db/cli.ts calls runDbCli with the app's migrations and seed):
//   migrate up [--no-backup]     apply pending migrations — after a backup — then verify database == code
//   migrate down [--no-backup]   revert the newest migration (after a backup)
//   migrate status               applied / pending
//   seed                         load the deterministic seed (safe to repeat)
//   check                        exit 0 when database == code, 1 otherwise
//   predeploy                    what a deploy runs before the new API starts: `migrate up` when DB_MIGRATE_ON_DEPLOY=1,
//                                then `check`
// Backup before migrate: SQLite = a verified snapshot (VACUUM INTO + integrity_check) in <dir>/backups/; a backup
// that cannot be taken or does not verify refuses the migration. MySQL = the command in DB_BACKUP_CMD (your
// dump hook) must succeed; without one the migration is refused unless --no-backup / DB_MIGRATE_NO_BACKUP=1 says the
// backup was taken some other way. A database that has never been migrated holds nothing to back up.
// Exit codes: 0 ok · 1 failed / not in sync · 2 usage · 3 refused (no backup).
import { spawnSync } from 'node:child_process'
import { now } from './clock.js'
import { openDatabase, type Database, type DatabaseOptions } from './connect.js'
import { appliedMigrations, backupSqlite, describeSchema, migrateDown, migrateUp, schemaState, type Migrations } from './migrate.js'

// DB_BACKUP_CMD is a command line the OPERATOR configures (`mysqldump … | gzip > …`): a shell is what it is written
// for, so one is started explicitly and given the line as a single argument (no shell option on the spawn call), and nothing from a
// request ever reaches this (the value comes from the process environment at deploy time only).
export function runShellCommand(commandLine: string): number {
  const [shell, flag] = process.platform === 'win32' ? [process.env.ComSpec ?? 'cmd.exe', '/c'] : ['/bin/sh', '-c']
  return spawnSync(shell, [flag, commandLine], { stdio: 'inherit' }).status ?? 1
}

export interface DbCliDeps {
  /** DATABASE_URL */
  url: string
  migrations: Migrations
  seed?: (database: Database<any>) => Promise<void>
  options?: Omit<DatabaseOptions, 'url'>
  env?: Record<string, string | undefined>
  out?: (line: string) => void
  /** Runs DB_BACKUP_CMD; returns its exit code. Injectable for tests. */
  runBackupCommand?: (command: string) => number
}

const USAGE = 'usage: db migrate up|down|status [--no-backup] | db seed | db check | db predeploy'
const truthy = (value: string | undefined) => value === '1' || value === 'true'

export async function runDbCli(argv: readonly string[], deps: DbCliDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const env = deps.env ?? process.env
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const [command, sub = command === 'migrate' ? 'up' : undefined] = argv.filter((a) => !a.startsWith('--'))
  const known = command === 'migrate' ? ['up', 'down', 'status'].includes(sub ?? '') : ['seed', 'check', 'predeploy'].includes(command ?? '')
  if (!known || [...flags].some((f) => f !== '--no-backup')) {
    out(USAGE)
    return 2
  }

  const database = openDatabase<any>({ ...deps.options, url: deps.url })
  const { db } = database
  const noBackup = flags.has('--no-backup') || truthy(env.DB_MIGRATE_NO_BACKUP)

  // Returns false when the migration must not run.
  const backup = async (): Promise<boolean> => {
    if ((await appliedMigrations(db)) === null) return true // never migrated: nothing to lose
    if (noBackup) {
      out('backup skipped (--no-backup / DB_MIGRATE_NO_BACKUP)')
      return true
    }
    if (database.dialect === 'sqlite') {
      try {
        const copy = await backupSqlite(database, now())
        out(copy ? `backup: ${copy} (verified)` : 'backup: nothing to copy (in-memory or new database)')
        return true
      } catch (error) {
        out(`REFUSED: the backup before migrating failed — not migrating (${error instanceof Error ? error.message : String(error)})`)
        return false
      }
    }
    const hook = env.DB_BACKUP_CMD
    if (!hook) {
      out('REFUSED: no backup before migrating MySQL. Set DB_BACKUP_CMD to your dump command, or pass --no-backup (DB_MIGRATE_NO_BACKUP=1) when a backup was taken another way.')
      return false
    }
    const code = (deps.runBackupCommand ?? runShellCommand)(hook)
    if (code !== 0) {
      out(`REFUSED: DB_BACKUP_CMD exited ${code} — not migrating`)
      return false
    }
    out('backup: DB_BACKUP_CMD ok')
    return true
  }

  const up = async (): Promise<number> => {
    const before = await schemaState(db, deps.migrations)
    if (before.state === 'ahead') {
      out(describeSchema(before))
      return 1
    }
    if (before.pending.length) {
      if (!(await backup())) return 3
      for (const r of await migrateUp(db, deps.migrations)) out(`up   ${r.migrationName}  ${r.status}`)
    }
    // Never trust "it exited 0": ask the database what it has now.
    const after = await schemaState(db, deps.migrations)
    out(describeSchema(after))
    return after.state === 'ok' ? 0 : 1
  }

  const check = async (): Promise<number> => {
    const state = await schemaState(db, deps.migrations)
    out(describeSchema(state))
    return state.state === 'ok' ? 0 : 1
  }

  try {
    if (command === 'check') return await check()
    if (command === 'predeploy') {
      if (truthy(env.DB_MIGRATE_ON_DEPLOY)) {
        const code = await up()
        if (code !== 0) return code
      }
      return await check()
    }
    if (command === 'seed') {
      const state = await schemaState(db, deps.migrations)
      if (state.state !== 'ok') {
        out(`${describeSchema(state)} — migrate first`)
        return 1
      }
      if (!deps.seed) {
        out('no seed defined')
        return 0
      }
      await deps.seed(database)
      out('seed ok')
      return 0
    }
    if (sub === 'status') {
      const applied = (await appliedMigrations(db)) ?? []
      for (const name of Object.keys(deps.migrations).sort()) out(`${applied.includes(name) ? 'applied' : 'pending'}  ${name}`)
      for (const name of applied.filter((n) => !(n in deps.migrations))) out(`unknown  ${name}`)
      return 0
    }
    if (sub === 'down') {
      // Nothing applied (or never migrated): return before the migrator creates its bookkeeping tables.
      if (!(await appliedMigrations(db))?.length) {
        out('nothing to revert')
        return 0
      }
      if (!(await backup())) return 3
      const results = await migrateDown(db, deps.migrations)
      for (const r of results) out(`down ${r.migrationName}  ${r.status}`)
      if (!results.length) out('nothing to revert')
      return 0
    }
    return await up()
  } catch (error) {
    // The message of a driver error may describe the server, never the credentials (the URL is not part of it).
    out(`db ${argv.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    await database.close()
  }
}
