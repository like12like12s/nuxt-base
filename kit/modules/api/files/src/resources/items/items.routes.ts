// HTTP surface of `items` — the example of a resource done the standard way. Copy this folder for a new resource:
//   GET    /api/v1/items          list: ?limit&offset&sort, or ?ids=a,b   -> { data: [...], meta: { limit, offset, total } }
//   GET    /api/v1/items/{id}                                              -> { data }
//   POST   /api/v1/items                                                   -> 201 { data }
//   PATCH  /api/v1/items/{id}                                              -> { data }
//   DELETE /api/v1/items/{id}     soft delete                              -> 204
// Each route declares its request and every response first (createRoute); the handler only moves data.
// @kit:if auth
// Every route also declares who may call it (`middleware: [requireAuth()]` / `requireRole(...)` / `publicRoute()`):
// reading needs a signed-in caller, writing the editor role, deleting the admin role.
// @kit:end
// After changing a route or a schema: `npm run contract` (and `npm run client` in the UI).
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Kysely } from 'kysely'
import type { Schema } from '../../db/schema.js'
import { errorResponses } from '../../kit/api/errors.js'
import { dataOf, listOf, listQuery, one, page } from '../../kit/api/pagination.js'
// @kit:if auth
import { requireAuth, requireRole } from '../../kit/auth/guard.js'
// @kit:end
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
  // @kit:if auth
  middleware: [requireAuth()] as const,
  // @kit:end
  request: { query: list.schema },
  // @kit:if auth
  responses: { 200: { description: 'A page of items', content: json(listOf(ItemSchema)) }, ...errorResponses(400, 401) },
  // @kit:else
  responses: { 200: { description: 'A page of items', content: json(listOf(ItemSchema)) }, ...errorResponses(400) },
  // @kit:end
})

const getRoute = createRoute({
  method: 'get',
  path: '/items/{id}',
  tags,
  summary: 'Get one item',
  // @kit:if auth
  middleware: [requireAuth()] as const,
  // @kit:end
  request: { params: ItemIdParam },
  // @kit:if auth
  responses: { 200: { description: 'The item', content: json(dataOf(ItemSchema)) }, ...errorResponses(401, 404) },
  // @kit:else
  responses: { 200: { description: 'The item', content: json(dataOf(ItemSchema)) }, ...errorResponses(404) },
  // @kit:end
})

const createItemRoute = createRoute({
  method: 'post',
  path: '/items',
  tags,
  summary: 'Create an item',
  // @kit:if auth
  middleware: [requireRole('admin', 'editor')] as const,
  // @kit:end
  request: { body: { required: true, content: json(ItemCreateSchema) } },
  // @kit:if auth
  responses: { 201: { description: 'Created', content: json(dataOf(ItemSchema)) }, ...errorResponses(400, 401, 403, 409) },
  // @kit:else
  responses: { 201: { description: 'Created', content: json(dataOf(ItemSchema)) }, ...errorResponses(400, 409) },
  // @kit:end
})

const updateRoute = createRoute({
  method: 'patch',
  path: '/items/{id}',
  tags,
  summary: 'Update an item',
  // @kit:if auth
  middleware: [requireRole('admin', 'editor')] as const,
  // @kit:end
  request: { params: ItemIdParam, body: { required: true, content: json(ItemUpdateSchema) } },
  // @kit:if auth
  responses: { 200: { description: 'Updated', content: json(dataOf(ItemSchema)) }, ...errorResponses(400, 401, 403, 404, 409) },
  // @kit:else
  responses: { 200: { description: 'Updated', content: json(dataOf(ItemSchema)) }, ...errorResponses(400, 404, 409) },
  // @kit:end
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/items/{id}',
  tags,
  summary: 'Delete an item (soft delete)',
  // @kit:if auth
  middleware: [requireRole('admin')] as const,
  // @kit:end
  request: { params: ItemIdParam },
  // @kit:if auth
  responses: { 204: { description: 'Deleted' }, ...errorResponses(401, 403, 404) },
  // @kit:else
  responses: { 204: { description: 'Deleted' }, ...errorResponses(404) },
  // @kit:end
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
