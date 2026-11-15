// Every migration of the app, by name. They run in name order on SQLite and on MySQL alike, so:
//   - prefix with a 4-digit sequence and never rename or edit one that has shipped — add a new one
//   - write them with the Kysely schema builder (no raw dialect SQL) and give every one a down()
// `0001_base` is the kit's base schema (users, audit, service_tokens).
import { baseMigration } from '../../kit/db/schema.js'
import type { Migrations } from '../../kit/db/migrate.js'
// @kit:if sample
import { items } from './0002_items.js'
// @kit:end
// kit:anchor migration-imports — `scaffold add resource` adds its import above this line

export const migrations: Migrations = {
  '0001_base': baseMigration,
  // @kit:if sample
  '0002_items': items,
  // @kit:end
  // kit:anchor migrations — and its migration above this line (next free 4-digit sequence)
}
