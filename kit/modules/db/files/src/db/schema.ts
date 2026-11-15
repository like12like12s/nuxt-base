// The database as TypeScript sees it: the kit's base tables plus the app's own. Add a table here and a migration in
// src/db/migrations/ — never one without the other.
import type { BaseTables, StandardColumns } from '../kit/db/schema.js'

export interface ItemsTable extends StandardColumns {
  name: string
  description: string | null
  quantity: number
}

// kit:anchor tables — `scaffold add resource` adds its table interface above this line

export interface Schema extends BaseTables {
  items: ItemsTable
  // kit:anchor schema — and its entry above this line
}
