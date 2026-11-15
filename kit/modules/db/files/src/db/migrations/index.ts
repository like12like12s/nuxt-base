// Every migration of the app, by name. They run in name order on SQLite and on MySQL alike, so:
//   - prefix with a 4-digit sequence and never rename or edit one that has shipped — add a new one
//   - write them with the Kysely schema builder (no raw dialect SQL) and give every one a down()
// `0001_base` is the kit's base schema (users, audit, service_tokens).
import { baseMigration } from '../../kit/db/schema.js'
import type { Migrations } from '../../kit/db/migrate.js'
import { items } from './0002_items.js'

export const migrations: Migrations = {
  '0001_base': baseMigration,
  '0002_items': items,
}
