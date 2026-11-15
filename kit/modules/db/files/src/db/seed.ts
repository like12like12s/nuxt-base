// Deterministic seed: fixed ids, fixed timestamps, insert-if-missing. Running it twice leaves the data exactly as
// running it once — `npm run db:seed` is safe on a database that already has rows.
import type { AppDatabase } from './index.js'

const AT = '2026-01-01T00:00:00.000Z'
const standard = { createdAt: AT, updatedAt: AT, deletedAt: null }

// @kit:if sample
export const SEED_ITEMS = [
  { id: '00000000-0000-4000-9000-000000000001', name: 'Sample item', description: 'Created by the seed', quantity: 1, ...standard },
  { id: '00000000-0000-4000-9000-000000000002', name: 'Another item', description: null, quantity: 5, ...standard },
]

export async function seed({ db }: AppDatabase): Promise<void> {
  for (const row of SEED_ITEMS) {
    const exists = await db.selectFrom('items').select('id').where('id', '=', row.id).executeTakeFirst()
    if (!exists) await db.insertInto('items').values(row).execute()
  }
}
// @kit:else
// Nothing to seed yet. Add rows per table like this (fixed id, insert only when it is missing):
//   const row = { id: '00000000-0000-4000-9000-000000000001', name: 'First', ...standard }
//   if (!(await db.selectFrom('things').select('id').where('id', '=', row.id).executeTakeFirst())) await db.insertInto('things').values(row).execute()
export const SEED_STANDARD = standard

export async function seed(_database: AppDatabase): Promise<void> {}
// @kit:end
