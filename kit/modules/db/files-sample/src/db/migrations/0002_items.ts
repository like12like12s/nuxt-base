import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'
import { liveValue, standardColumns } from '../../kit/db/schema.js'

export const items: Migration = {
  async up(db: Kysely<any>) {
    await standardColumns(db.schema.createTable('items'))
      .addColumn('name', 'varchar(191)', (col) => col.notNull())
      .addColumn('description', 'text')
      .addColumn('quantity', 'integer', (col) => col.notNull().defaultTo(0))
      // The name while the row is live, NULL once it is soft-deleted: the unique index below is what makes
      // "one live item per name" true under concurrent requests (src/kit/db/schema.ts, liveValue).
      .addColumn('liveName', 'varchar(191)', (col) => col.generatedAlwaysAs(liveValue('name')))
      .execute()
    await db.schema.createIndex('items_name_idx').on('items').column('name').execute()
    await db.schema.createIndex('items_live_name_uq').on('items').column('liveName').unique().execute()
  },
  async down(db: Kysely<any>) {
    await db.schema.dropTable('items').execute()
  },
}
