import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'
import { standardColumns } from '../../kit/db/schema.js'

export const items: Migration = {
  async up(db: Kysely<any>) {
    await standardColumns(db.schema.createTable('items'))
      .addColumn('name', 'varchar(191)', (col) => col.notNull())
      .addColumn('description', 'text')
      .addColumn('quantity', 'integer', (col) => col.notNull().defaultTo(0))
      .execute()
    await db.schema.createIndex('items_name_idx').on('items').column('name').execute()
  },
  async down(db: Kysely<any>) {
    await db.schema.dropTable('items').execute()
  },
}
