// Data access of `items`. The standard way to write a repository:
//   - reads never return soft-deleted rows (`deletedAt is null`)
//   - every write goes through audited(): the change and its audit row commit together, or not at all
//   - DELETE sets deletedAt — rows are never removed
import type { Kysely } from 'kysely'
import type { Schema } from '../../db/schema.js'
import { conflict, notFound } from '../../kit/api/errors.js'
import type { ListParams } from '../../kit/api/pagination.js'
import { audited, created, softDeleted, touched } from '../../kit/db/repo.js'
import type { ITEM_SORTABLE, Item, ItemCreate, ItemUpdate } from './items.schema.js'

type Db = Kysely<Schema>
const COLUMNS = ['id', 'name', 'description', 'quantity', 'createdAt', 'updatedAt'] as const
const target = (id: string) => `item:${id}`

export async function listItems(db: Db, params: ListParams<(typeof ITEM_SORTABLE)[number]>): Promise<{ rows: Item[]; total: number }> {
  let live = db.selectFrom('items').where('deletedAt', 'is', null)
  if (params.ids) live = live.where('id', 'in', params.ids.length ? params.ids : [''])
  const { total } = await live.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow()
  let query = live.select(COLUMNS)
  for (const term of params.sort) query = query.orderBy(term.column, term.direction)
  // `id` last: rows with equal sort values keep one order, so pages never overlap.
  const rows = await query.orderBy('id', 'asc').limit(params.limit).offset(params.offset).execute()
  return { rows, total: Number(total) }
}

export async function getItem(db: Db, id: string): Promise<Item> {
  const row = await db.selectFrom('items').select(COLUMNS).where('id', '=', id).where('deletedAt', 'is', null).executeTakeFirst()
  if (!row) throw notFound('Item', id)
  return row
}

/** Names are unique among live items. Checked inside the transaction of the write that needs it. */
async function assertNameFree(db: Db, name: string, exceptId?: string): Promise<void> {
  let query = db.selectFrom('items').select('id').where('name', '=', name).where('deletedAt', 'is', null)
  if (exceptId) query = query.where('id', '!=', exceptId)
  if (await query.executeTakeFirst()) throw conflict(`An item named "${name}" already exists`)
}

export function createItem(db: Db, input: ItemCreate): Promise<Item> {
  return audited(db, { action: 'item.create' }, async (trx) => {
    await assertNameFree(trx, input.name)
    const row = { ...created(), name: input.name, description: input.description ?? null, quantity: input.quantity ?? 0 }
    await trx.insertInto('items').values(row).execute()
    const item = await getItem(trx, row.id)
    return { result: item, target: target(item.id), after: item }
  })
}

export function updateItem(db: Db, id: string, patch: ItemUpdate): Promise<Item> {
  return audited(db, { action: 'item.update', target: target(id) }, async (trx) => {
    const before = await getItem(trx, id)
    if (patch.name !== undefined && patch.name !== before.name) await assertNameFree(trx, patch.name, id)
    const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== undefined && value !== before[key as keyof Item]))
    // Nothing differs: no write, and audited() records nothing because before equals after.
    if (!Object.keys(changes).length) return { result: before, before, after: before }
    await trx.updateTable('items').set({ ...changes, ...touched() }).where('id', '=', id).execute()
    const after = await getItem(trx, id)
    return { result: after, before, after }
  })
}

export function deleteItem(db: Db, id: string): Promise<void> {
  return audited(db, { action: 'item.delete', target: target(id) }, async (trx) => {
    const before = await getItem(trx, id)
    await trx.updateTable('items').set(softDeleted()).where('id', '=', id).execute()
    return { result: undefined, before }
  })
}
