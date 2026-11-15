// HTTP surface of `items` — the example of a resource done the standard way. Copy this folder for a new resource:
//   GET    /api/v1/items          list: ?limit&offset&sort, or ?ids=a,b   -> { data: [...], meta: { limit, offset, total } }
//   GET    /api/v1/items/{id}                                              -> { data }
//   POST   /api/v1/items                                                   -> 201 { data }
//   PATCH  /api/v1/items/{id}                                              -> { data }
//   DELETE /api/v1/items/{id}     soft delete                              -> 204
// Each route declares its request and every response first (createRoute); the handler only moves data.
// After changing a route or a schema: `npm run contract` (and `npm run client` in the UI).
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Kysely } from 'kysely'
import type { Schema } from '../../db/schema.js'
import { errorResponses } from '../../kit/api/errors.js'
import { dataOf, listOf, listQuery, one, page } from '../../kit/api/pagination.js'
import { createItem, deleteItem, getItem, listItems, updateItem } from './items.repo.js'
import { ITEM_SORTABLE, ItemCreateSchema, ItemIdParam, ItemSchema, ItemUpdateSchema } from './items.schema.js'

const tags = ['items']
const json = <T>(schema: T) => ({ 'application/json': { schema } })
const list = listQuery({ sortable: ITEM_SORTABLE, defaultSort: '-createdAt' })

const listRoute = createRoute({
  method: 'get',
  path: '/items',
  tags,
  summary: 'List items',
  request: { query: list.schema },
  responses: { 200: { description: 'A page of items', content: json(listOf(ItemSchema)) }, ...errorResponses(400) },
})

const getRoute = createRoute({
  method: 'get',
  path: '/items/{id}',
  tags,
  summary: 'Get one item',
  request: { params: ItemIdParam },
  responses: { 200: { description: 'The item', content: json(dataOf(ItemSchema)) }, ...errorResponses(404) },
})

const createItemRoute = createRoute({
  method: 'post',
  path: '/items',
  tags,
  summary: 'Create an item',
  request: { body: { required: true, content: json(ItemCreateSchema) } },
  responses: { 201: { description: 'Created', content: json(dataOf(ItemSchema)) }, ...errorResponses(400, 409) },
})

const updateRoute = createRoute({
  method: 'patch',
  path: '/items/{id}',
  tags,
  summary: 'Update an item',
  request: { params: ItemIdParam, body: { required: true, content: json(ItemUpdateSchema) } },
  responses: { 200: { description: 'Updated', content: json(dataOf(ItemSchema)) }, ...errorResponses(400, 404, 409) },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/items/{id}',
  tags,
  summary: 'Delete an item (soft delete)',
  request: { params: ItemIdParam },
  responses: { 204: { description: 'Deleted' }, ...errorResponses(404) },
})

export function registerItems(v1: OpenAPIHono, deps: { db: Kysely<Schema> }): void {
  const { db } = deps

  v1.openapi(listRoute, async (c) => {
    const params = list.parse(c.req.valid('query'))
    const { rows, total } = await listItems(db, params)
    return c.json(page(rows, params, total), 200)
  })

  v1.openapi(getRoute, async (c) => c.json(one(await getItem(db, c.req.valid('param').id)), 200))

  v1.openapi(createItemRoute, async (c) => c.json(one(await createItem(db, c.req.valid('json'))), 201))

  v1.openapi(updateRoute, async (c) => c.json(one(await updateItem(db, c.req.valid('param').id, c.req.valid('json'))), 200))

  v1.openapi(deleteRoute, async (c) => {
    await deleteItem(db, c.req.valid('param').id)
    return c.body(null, 204)
  })
}
