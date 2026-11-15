// The example resource end to end: list / get / create / update / soft delete, pagination, audit.
import { describe, expect, it } from 'vitest'
import { defineFactory } from '../src/kit/testing/factory.js'
import type { Item, ItemCreate } from '../src/resources/items/items.schema.js'
import { useApp } from './helpers.js'

const t = useApp()
// A factory per call: every test gets Item 001, 002, ... whatever ran before it.
const itemFactory = () => defineFactory<ItemCreate>(({ n }) => ({ name: `Item ${String(n).padStart(3, '0')}`, quantity: n }))

async function createMany(api: ReturnType<typeof t.build>['api'], count: number): Promise<Item[]> {
  const itemInput = itemFactory()
  const out: Item[] = []
  for (let i = 0; i < count; i++) out.push((await api.post('/api/v1/items', itemInput.build())).body.data)
  return out
}

describe('items — CRUD', () => {
  it('creates, reads, updates and lists', async () => {
    const { api } = t.build()
    const created = await api.post('/api/v1/items', { name: '  Widget  ', description: 'first' })
    expect(created.status).toBe(201)
    // pinned ids + clock (useDeterministic): the same values on every run
    expect(created.body).toEqual({
      data: { id: '00000000-0000-4000-8000-000000000001', name: 'Widget', description: 'first', quantity: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    })
    const id = created.body.data.id

    expect((await api.get(`/api/v1/items/${id}`)).body.data.name).toBe('Widget')

    const updated = await api.patch(`/api/v1/items/${id}`, { quantity: 7 })
    expect(updated.status).toBe(200)
    expect(updated.body.data).toMatchObject({ id, quantity: 7, name: 'Widget' })
    expect(updated.body.data.updatedAt > created.body.data.updatedAt).toBe(true)

    const list = await api.get('/api/v1/items')
    expect(list.body).toEqual({ data: [updated.body.data], meta: { limit: 50, offset: 0, total: 1 } })
  })

  it('rejects an empty update and an unknown id', async () => {
    const { api } = t.build()
    const [item] = await createMany(api, 1)
    expect((await api.patch(`/api/v1/items/${item!.id}`, {})).status).toBe(400)
    expect((await api.patch('/api/v1/items/missing', { quantity: 1 })).status).toBe(404)
    expect((await api.delete('/api/v1/items/missing')).status).toBe(404)
  })

  it('refuses a second live item with the same name (409), on create and on rename', async () => {
    const { api } = t.build()
    const [a, b] = await createMany(api, 2)
    expect((await api.post('/api/v1/items', { name: a!.name })).status).toBe(409)
    expect((await api.patch(`/api/v1/items/${b!.id}`, { name: a!.name })).status).toBe(409)
  })
})

describe('items — soft delete', () => {
  it('DELETE answers 204, hides the row from get and list, and keeps it in the table', async () => {
    const { api } = t.build()
    const [a, b] = await createMany(api, 2)
    const res = await api.delete(`/api/v1/items/${a!.id}`)
    expect(res.status).toBe(204)
    expect(res.body).toBeNull()

    expect((await api.get(`/api/v1/items/${a!.id}`)).status).toBe(404)
    const list = await api.get('/api/v1/items')
    expect(list.body.data.map((i: Item) => i.id)).toEqual([b!.id])
    expect(list.body.meta.total).toBe(1)
    expect((await api.get(`/api/v1/items?ids=${a!.id},${b!.id}`)).body.data.map((i: Item) => i.id)).toEqual([b!.id])

    const row = await t.db.selectFrom('items').selectAll().where('id', '=', a!.id).executeTakeFirstOrThrow()
    expect(row.deletedAt).toMatch(/^2026-01-01T/)
    expect((await api.delete(`/api/v1/items/${a!.id}`)).status).toBe(404) // already gone
    // the name is free again once the item is deleted
    expect((await api.post('/api/v1/items', { name: a!.name })).status).toBe(201)
  })
})

describe('items — pagination', () => {
  it('defaults to limit 50, offset 0, newest first', async () => {
    const { api } = t.build()
    const items = await createMany(api, 3)
    const res = await api.get('/api/v1/items')
    expect(res.body.meta).toEqual({ limit: 50, offset: 0, total: 3 })
    expect(res.body.data.map((i: Item) => i.id)).toEqual(items.map((i) => i.id).reverse())
  })

  it('pages with limit + offset over a stable order, and reports the total', async () => {
    const { api } = t.build()
    await createMany(api, 5)
    const names = async (query: string) => (await api.get(`/api/v1/items?${query}`)).body.data.map((i: Item) => i.name)
    expect(await names('sort=name&limit=2')).toEqual(['Item 001', 'Item 002'])
    expect(await names('sort=name&limit=2&offset=2')).toEqual(['Item 003', 'Item 004'])
    expect(await names('sort=name&limit=2&offset=4')).toEqual(['Item 005'])
    expect(await names('sort=name&limit=2&offset=99')).toEqual([])
    expect(await names('sort=-quantity,name&limit=1')).toEqual(['Item 005'])
    expect((await api.get('/api/v1/items?limit=2&offset=4')).body.meta).toEqual({ limit: 2, offset: 4, total: 5 })
  })

  it.each([
    ['limit above the maximum', 'limit=201', 'query.limit'],
    ['limit zero', 'limit=0', 'query.limit'],
    ['limit not a number', 'limit=abc', 'query.limit'],
    ['negative offset', 'offset=-1', 'query.offset'],
    ['fractional offset', 'offset=1.5', 'query.offset'],
    ['unknown sort column', 'sort=password', 'query.sort'],
    ['empty id in ids', 'ids=a,,b', 'query.ids'],
  ])('rejects %s with 400 VALIDATION (never clamps silently)', async (_label, query, path) => {
    const res = await t.build().api.get(`/api/v1/items?${query}`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION')
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(path)
  })

  it('accepts the maximum limit', async () => {
    const res = await t.build().api.get('/api/v1/items?limit=200')
    expect(res.status).toBe(200)
    expect(res.body.meta.limit).toBe(200)
  })

  it('?ids=a,b reads many in one call', async () => {
    const { api } = t.build()
    const [a, , c] = await createMany(api, 3)
    const res = await api.get(`/api/v1/items?ids=${a!.id},${c!.id},unknown&sort=name`)
    expect(res.body.data.map((i: Item) => i.id)).toEqual([a!.id, c!.id])
    expect(res.body.meta.total).toBe(2)
  })
})

describe('items — audit', () => {
  const auditRows = () => t.db.selectFrom('audit').selectAll().orderBy('ts', 'asc').orderBy('id', 'asc').execute()

  it('every write leaves one audit row: actor, action, target, before / after, and the request trace id', async () => {
    const { api } = t.build()
    const created = await api.post('/api/v1/items', { name: 'Widget' })
    const id = created.body.data.id
    const updated = await api.patch(`/api/v1/items/${id}`, { quantity: 3 })
    const deleted = await api.delete(`/api/v1/items/${id}`)

    const rows = await auditRows()
    expect(rows.map((r) => [r.action, r.target, r.actor])).toEqual([
      ['item.create', `item:${id}`, 'anonymous'],
      ['item.update', `item:${id}`, 'anonymous'],
      ['item.delete', `item:${id}`, 'anonymous'],
    ])
    expect(rows.map((r) => r.traceId)).toEqual([created.traceId, updated.traceId, deleted.traceId])
    expect(rows[0]!.before).toBeNull()
    expect(JSON.parse(rows[0]!.after!)).toMatchObject({ id, name: 'Widget', quantity: 0 })
    expect(JSON.parse(rows[1]!.before!)).toMatchObject({ quantity: 0 })
    expect(JSON.parse(rows[1]!.after!)).toMatchObject({ quantity: 3 })
    expect(JSON.parse(rows[2]!.before!)).toMatchObject({ quantity: 3 })
    expect(rows[2]!.after).toBeNull()
  })

  it('a failed write leaves no audit row and no data (one transaction)', async () => {
    const { api } = t.build()
    await api.post('/api/v1/items', { name: 'Widget' })
    expect((await api.post('/api/v1/items', { name: 'Widget' })).status).toBe(409)
    expect((await api.patch('/api/v1/items/missing', { quantity: 1 })).status).toBe(404)
    expect(await auditRows()).toHaveLength(1)
    expect((await api.get('/api/v1/items')).body.meta.total).toBe(1)
  })

  it('an update that changes nothing writes no audit row', async () => {
    const { api } = t.build()
    const { data } = (await api.post('/api/v1/items', { name: 'Widget', quantity: 2 })).body
    const same = await api.patch(`/api/v1/items/${data.id}`, { quantity: 2, name: 'Widget' })
    expect(same.status).toBe(200)
    expect(same.body.data.updatedAt).toBe(data.updatedAt)
    expect(await auditRows()).toHaveLength(1)
  })
})
