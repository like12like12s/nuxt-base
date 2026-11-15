// DO NOT EDIT — locked file from the nuxt-base kit (runtime/db/checks.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Readiness checks of the database for createApi({ checks }): reachable, and on the schema this build ships.
// A database that lags the code breaks every request that touches the new columns while the container looks fine —
// so "schema behind" is not ready, and a deploy does not start the API on it (the predeploy check runs first).
import type { Kysely } from 'kysely'
import { HealthCheckError, type HealthCheck } from '../api/health.js'
import type { Database } from './connect.js'
import { describeSchema, schemaState, type Migrations } from './migrate.js'

export function databaseChecks(database: Pick<Database<any>, 'db' | 'ping'>, migrations: Migrations): HealthCheck[] {
  const db: Kysely<any> = database.db
  return [
    {
      name: 'db',
      run: async () => {
        try {
          await database.ping()
        } catch {
          throw new HealthCheckError('unreachable')
        }
      },
    },
    {
      name: 'schema',
      run: async () => {
        let state
        try {
          state = await schemaState(db, migrations)
        } catch {
          throw new HealthCheckError('unknown')
        }
        if (state.state !== 'ok') throw new HealthCheckError(describeSchema(state))
      },
    },
  ]
}
