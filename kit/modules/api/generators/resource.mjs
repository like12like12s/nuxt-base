// `scaffold add resource <name>` — a new resource done the standard way (the shape of src/resources/items/):
// migration + table type, zod schemas, repository (soft delete, audited writes), contract-first routes with their
// auth declarations (when the auth module is installed), tests, and — in a fullstack project — a list page with its
// e2e spec. It registers everything at the `kit:anchor` comments. The contract (openapi.json) and the typed client
// are derived files: the generator is pure, so regenerating them is the first step in `next`.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { names } from '../../../lib/names.mjs'

function nextSequence(apiDir) {
  const dir = join(apiDir, 'src/db/migrations')
  const taken = existsSync(dir) ? readdirSync(dir).map((file) => /^(\d{4})_/.exec(file)?.[1]).filter(Boolean).map(Number) : []
  return String(Math.max(1, ...taken) + 1).padStart(4, '0')
}

export default function generate({ name, dir, manifest, parts }) {
  const n = names(name)
  const auth = manifest.modules.includes('auth')
  // The `editor` role belongs to the example resource: a project created with --no-sample only has `admin` until the
  // app adds roles of its own (src/auth/roles.ts), so writes are admin-only there and the matrix has no editor column.
  const editor = manifest.answers?.sample !== false
  const writers = editor ? "requireRole('admin', 'editor')" : "requireRole('admin')"
  const seq = nextSequence(dir)
  const migration = `${seq}_${n.snake}`
  const base = `src/resources/${n.kebab}/${n.kebab}`
  const hasUi = Boolean(parts.ui) && manifest.modules.includes('api')
  const errors = (...statuses) => {
    const all = auth ? [...new Set([...statuses, ...(statuses.includes('write') ? [401, 403] : [401])])] : statuses
    return all.filter((s) => typeof s === 'number').sort((a, b) => a - b).join(', ')
  }
  const declare = (rule) => (auth ? `  middleware: [${rule}] as const,\n` : '')

  const schema = `// Contract of \`${n.kebab}\`: what goes in and what comes out. Add the resource's fields here first — then the
// migration, the table type in src/db/schema.ts and the repository follow.
import { z } from '@hono/zod-openapi'

export const ${n.onePascal}Schema = z
  .object({
    id: z.string(),
    name: z.string().openapi({ example: '${n.oneTitle}' }),
    createdAt: z.string().openapi({ example: '2026-01-01T00:00:00.000Z' }),
    updatedAt: z.string(),
  })
  .openapi('${n.onePascal}')
export type ${n.onePascal} = z.infer<typeof ${n.onePascal}Schema>

export const ${n.onePascal}CreateSchema = z
  .object({
    name: z.string().trim().min(1).max(191),
  })
  .openapi('${n.onePascal}Create')
export type ${n.onePascal}Create = z.infer<typeof ${n.onePascal}CreateSchema>

export const ${n.onePascal}UpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(191).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'at least one field is required' })
  .openapi('${n.onePascal}Update')
export type ${n.onePascal}Update = z.infer<typeof ${n.onePascal}UpdateSchema>

export const ${n.onePascal}IdParam = z.object({
  id: z.string().min(1).max(36).openapi({ param: { name: 'id', in: 'path' } }),
})

/** Columns a client may sort the list by. */
export const ${n.constant}_SORTABLE = ['createdAt', 'updatedAt', 'name'] as const
`

  const repo = `// Data access of \`${n.kebab}\`: reads skip soft-deleted rows, every write goes through audited() (the change and its
// audit row commit together), DELETE sets deletedAt.
import type { Kysely } from 'kysely'
import type { Schema } from '../../db/schema.js'
import { conflict, notFound } from '../../kit/api/errors.js'
import type { ListParams } from '../../kit/api/pagination.js'
import { audited, created, isUniqueViolation, softDeleted, touched } from '../../kit/db/repo.js'
import type { ${n.constant}_SORTABLE, ${n.onePascal}, ${n.onePascal}Create, ${n.onePascal}Update } from './${n.kebab}.schema.js'

type Db = Kysely<Schema>
const COLUMNS = ['id', 'name', 'createdAt', 'updatedAt'] as const
const target = (id: string) => \`${n.oneSnake}:\${id}\`

export async function list${n.pascal}(db: Db, params: ListParams<(typeof ${n.constant}_SORTABLE)[number]>): Promise<{ rows: ${n.onePascal}[]; total: number }> {
  let live = db.selectFrom('${n.snake}').where('deletedAt', 'is', null)
  if (params.ids) live = live.where('id', 'in', params.ids.length ? params.ids : [''])
  const { total } = await live.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow()
  let query = live.select(COLUMNS)
  for (const term of params.sort) query = query.orderBy(term.column, term.direction)
  // \`id\` last: rows with equal sort values keep one order, so pages never overlap.
  const rows = await query.orderBy('id', 'asc').limit(params.limit).offset(params.offset).execute()
  return { rows, total: Number(total) }
}

export async function get${n.onePascal}(db: Db, id: string): Promise<${n.onePascal}> {
  const row = await db.selectFrom('${n.snake}').select(COLUMNS).where('id', '=', id).where('deletedAt', 'is', null).executeTakeFirst()
  if (!row) throw notFound('${n.oneTitle}', id)
  return row
}

// Names are unique among live rows. The database enforces it (unique index on the generated \`liveName\` column, see
// the migration) — a check-then-insert would let two concurrent requests both through. A duplicate is a 409.
// Not unique in your domain? Remove the liveName column + index from the migration, the table type and this mapping.
const duplicate = (error: unknown, name: string) => (isUniqueViolation(error) ? conflict(\`${n.oneTitle} "\${name}" already exists\`) : error)

export function create${n.onePascal}(db: Db, input: ${n.onePascal}Create): Promise<${n.onePascal}> {
  return audited(db, { action: '${n.oneSnake}.create' }, async (trx) => {
    const row = { ...created(), name: input.name }
    try {
      await trx.insertInto('${n.snake}').values(row).execute()
    } catch (error) {
      throw duplicate(error, input.name)
    }
    const after = await get${n.onePascal}(trx, row.id)
    return { result: after, target: target(after.id), after }
  })
}

export function update${n.onePascal}(db: Db, id: string, patch: ${n.onePascal}Update): Promise<${n.onePascal}> {
  return audited(db, { action: '${n.oneSnake}.update', target: target(id) }, async (trx) => {
    const before = await get${n.onePascal}(trx, id)
    const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== undefined && value !== before[key as keyof ${n.onePascal}]))
    // Nothing differs: no write, and audited() records nothing because before equals after.
    if (!Object.keys(changes).length) return { result: before, before, after: before }
    let updated
    try {
      // \`deletedAt is null\` again: the row may have been deleted since it was read (another request, MySQL).
      updated = await trx.updateTable('${n.snake}').set({ ...changes, ...touched() }).where('id', '=', id).where('deletedAt', 'is', null).executeTakeFirst()
    } catch (error) {
      throw duplicate(error, patch.name ?? before.name)
    }
    if (!updated.numUpdatedRows) throw notFound('${n.oneTitle}', id)
    const after = await get${n.onePascal}(trx, id)
    return { result: after, before, after }
  })
}

export function delete${n.onePascal}(db: Db, id: string): Promise<void> {
  return audited(db, { action: '${n.oneSnake}.delete', target: target(id) }, async (trx) => {
    const before = await get${n.onePascal}(trx, id)
    // Only a live row is deleted: of two concurrent DELETEs one changes nothing, answers 404 and writes no audit row.
    const deleted = await trx.updateTable('${n.snake}').set(softDeleted()).where('id', '=', id).where('deletedAt', 'is', null).executeTakeFirst()
    if (!deleted.numUpdatedRows) throw notFound('${n.oneTitle}', id)
    return { result: undefined, before }
  })
}
`

  const routes = `// HTTP surface of \`${n.kebab}\`:
//   GET    /api/v1/${n.kebab}          list: ?limit&offset&sort, or ?ids=a,b   -> { data: [...], meta: { limit, offset, total } }
//   GET    /api/v1/${n.kebab}/{id}                                              -> { data }
//   POST   /api/v1/${n.kebab}                                                   -> 201 { data }
//   PATCH  /api/v1/${n.kebab}/{id}                                              -> { data }
//   DELETE /api/v1/${n.kebab}/{id}     soft delete                              -> 204
// Each route declares its request and every response first${auth ? ', and who may call it (review the roles below)' : ''}.
// After changing a route or a schema: \`npm run contract\` (and \`npm run client\` in the UI).
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Kysely } from 'kysely'
import type { Schema } from '../../db/schema.js'
import { errorResponses } from '../../kit/api/errors.js'
import { dataOf, listOf, listQuery, one, page } from '../../kit/api/pagination.js'
${auth ? "import { requireAuth, requireRole } from '../../kit/auth/guard.js'\n" : ''}import { create${n.onePascal}, delete${n.onePascal}, get${n.onePascal}, list${n.pascal}, update${n.onePascal} } from './${n.kebab}.repo.js'
import { ${n.constant}_SORTABLE, ${n.onePascal}CreateSchema, ${n.onePascal}IdParam, ${n.onePascal}Schema, ${n.onePascal}UpdateSchema } from './${n.kebab}.schema.js'

const tags = ['${n.kebab}']
const json = <T>(schema: T) => ({ 'application/json': { schema } })
const list = listQuery({ sortable: ${n.constant}_SORTABLE, defaultSort: '-createdAt' })

const listRoute = createRoute({
  method: 'get',
  path: '/${n.kebab}',
  tags,
  summary: 'List ${n.title.toLowerCase()}',
${declare('requireAuth()')}  request: { query: list.schema },
  responses: { 200: { description: 'A page of ${n.title.toLowerCase()}', content: json(listOf(${n.onePascal}Schema)) }, ...errorResponses(${errors(400)}) },
})

const getRoute = createRoute({
  method: 'get',
  path: '/${n.kebab}/{id}',
  tags,
  summary: 'Get one ${n.oneTitle.toLowerCase()}',
${declare('requireAuth()')}  request: { params: ${n.onePascal}IdParam },
  responses: { 200: { description: 'The ${n.oneTitle.toLowerCase()}', content: json(dataOf(${n.onePascal}Schema)) }, ...errorResponses(${errors(404)}) },
})

const createRoute_ = createRoute({
  method: 'post',
  path: '/${n.kebab}',
  tags,
  summary: 'Create a ${n.oneTitle.toLowerCase()}',
${declare(writers)}  request: { body: { required: true, content: json(${n.onePascal}CreateSchema) } },
  responses: { 201: { description: 'Created', content: json(dataOf(${n.onePascal}Schema)) }, ...errorResponses(${errors(400, 409, 'write')}) },
})

const updateRoute = createRoute({
  method: 'patch',
  path: '/${n.kebab}/{id}',
  tags,
  summary: 'Update a ${n.oneTitle.toLowerCase()}',
${declare(writers)}  request: { params: ${n.onePascal}IdParam, body: { required: true, content: json(${n.onePascal}UpdateSchema) } },
  responses: { 200: { description: 'Updated', content: json(dataOf(${n.onePascal}Schema)) }, ...errorResponses(${errors(400, 404, 409, 'write')}) },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/${n.kebab}/{id}',
  tags,
  summary: 'Delete a ${n.oneTitle.toLowerCase()} (soft delete)',
${declare("requireRole('admin')")}  request: { params: ${n.onePascal}IdParam },
  responses: { 204: { description: 'Deleted' }, ...errorResponses(${errors(404, 'write')}) },
})

export function register${n.pascal}(v1: OpenAPIHono, deps: { db: Kysely<Schema> }): void {
  const { db } = deps

  v1.openapi(listRoute, async (c) => {
    const params = list.parse(c.req.valid('query'))
    const { rows, total } = await list${n.pascal}(db, params)
    return c.json(page(rows, params, total), 200)
  })

  v1.openapi(getRoute, async (c) => c.json(one(await get${n.onePascal}(db, c.req.valid('param').id)), 200))

  v1.openapi(createRoute_, async (c) => c.json(one(await create${n.onePascal}(db, c.req.valid('json'))), 201))

  v1.openapi(updateRoute, async (c) => c.json(one(await update${n.onePascal}(db, c.req.valid('param').id, c.req.valid('json'))), 200))

  v1.openapi(deleteRoute, async (c) => {
    await delete${n.onePascal}(db, c.req.valid('param').id)
    return c.body(null, 204)
  })
}
`

  const migrationFile = `import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'
import { liveValue, standardColumns } from '../../kit/db/schema.js'

// Portable column rules: header of src/kit/db/schema.ts. Never edit this file once it has shipped — add a new migration.
export const ${n.camel}: Migration = {
  async up(db: Kysely<any>) {
    await standardColumns(db.schema.createTable('${n.snake}'))
      .addColumn('name', 'varchar(191)', (col) => col.notNull())
      // The name while the row is live, NULL once it is soft-deleted: the unique index below is what makes "one live
      // row per name" true under concurrent requests (src/kit/db/schema.ts, liveValue).
      .addColumn('liveName', 'varchar(191)', (col) => col.generatedAlwaysAs(liveValue('name')))
      .execute()
    await db.schema.createIndex('${n.snake}_name_idx').on('${n.snake}').column('name').execute()
    await db.schema.createIndex('${n.snake}_live_name_uq').on('${n.snake}').column('liveName').unique().execute()
  },
  async down(db: Kysely<any>) {
    await db.schema.dropTable('${n.snake}').execute()
  },
}
`

  const test = `// \`${n.kebab}\` end to end: list / get / create / update / soft delete, validation, audit.
import { describe, expect, it } from 'vitest'
import { useApp } from './helpers.js'

const t = useApp()
const URL = '/api/v1/${n.kebab}'

describe('${n.kebab}', () => {
  it('creates, reads, updates and lists', async () => {
    const { api } = t.build()
    const created = await api.post(URL, { name: '  First  ' })
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({ name: 'First' })
    const id = created.body.data.id

    expect((await api.get(\`\${URL}/\${id}\`)).body.data.name).toBe('First')
    const updated = await api.patch(\`\${URL}/\${id}\`, { name: 'Renamed' })
    expect(updated.status).toBe(200)
    expect(updated.body.data).toMatchObject({ id, name: 'Renamed' })
    expect((await api.get(URL)).body).toEqual({ data: [updated.body.data], meta: { limit: 50, offset: 0, total: 1 } })
  })

  it('validates input and answers 404 for an unknown id — in the standard error shape', async () => {
    const { api } = t.build()
    const bad = await api.post(URL, { name: '' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatchObject({ code: 'VALIDATION', traceId: bad.traceId })
    expect((await api.get(\`\${URL}?limit=201\`)).status).toBe(400)
    expect((await api.get(\`\${URL}/missing\`)).body.error.code).toBe('NOT_FOUND')
    expect((await api.patch(\`\${URL}/missing\`, { name: 'x' })).status).toBe(404)
    expect((await api.delete(\`\${URL}/missing\`)).status).toBe(404)
  })

  it('DELETE is a soft delete: 204, hidden from get and list, the row stays', async () => {
    const { api } = t.build()
    const { id } = (await api.post(URL, { name: 'Gone soon' })).body.data
    expect((await api.delete(\`\${URL}/\${id}\`)).status).toBe(204)
    expect((await api.get(\`\${URL}/\${id}\`)).status).toBe(404)
    expect((await api.get(URL)).body.meta.total).toBe(0)
    const row = await t.db.selectFrom('${n.snake}').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    expect(row.deletedAt).not.toBeNull()
  })

  it('names are unique among live rows — enforced by the database, also under concurrent requests (409)', async () => {
    const { api } = t.build()
    const results = await Promise.all(Array.from({ length: 5 }, () => api.post(URL, { name: 'Only one' })))
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409])
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('CONFLICT')
    const other = (await api.post(URL, { name: 'Other' })).body.data.id
    expect((await api.patch(\`\${URL}/\${other}\`, { name: 'Only one' })).status).toBe(409)
    // not a check in the application: a second live row with the name cannot be written at all
    await expect(t.db.insertInto('${n.snake}').values({ id: 'direct', name: 'Only one', createdAt: 'x', updatedAt: 'x', deletedAt: null }).execute()).rejects.toThrow()
    // a soft-deleted row does not hold its name; a deleted row is not written to
    const winner = results.find((r) => r.status === 201)!.body.data.id
    expect((await Promise.all([1, 2].map(() => api.delete(\`\${URL}/\${winner}\`)))).map((r) => r.status).sort()).toEqual([204, 404])
    expect((await api.patch(\`\${URL}/\${winner}\`, { name: 'Late' })).status).toBe(404)
    expect((await api.post(URL, { name: 'Only one' })).status).toBe(201)
  })

  it('every write leaves one audit row; a write that changes nothing leaves none', async () => {
    const { api } = t.build()
    const created = await api.post(URL, { name: 'Audited' })
    const id = created.body.data.id
    await api.patch(\`\${URL}/\${id}\`, { name: 'Audited' }) // same value: no change
    await api.patch(\`\${URL}/\${id}\`, { name: 'Audited twice' })
    await api.delete(\`\${URL}/\${id}\`)
    const rows = await t.db.selectFrom('audit').select(['action', 'target', 'traceId']).where('action', 'like', '${n.oneSnake}.%').orderBy('ts').orderBy('id').execute()
    expect(rows.map((r) => [r.action, r.target])).toEqual([
      ['${n.oneSnake}.create', \`${n.oneSnake}:\${id}\`],
      ['${n.oneSnake}.update', \`${n.oneSnake}:\${id}\`],
      ['${n.oneSnake}.delete', \`${n.oneSnake}:\${id}\`],
    ])
    expect(rows[0]!.traceId).toBe(created.traceId)
  })
})
`

  const files = [
    { path: `${base}.schema.ts`, content: schema },
    { path: `${base}.repo.ts`, content: repo },
    { path: `${base}.routes.ts`, content: routes },
    { path: `src/db/migrations/${migration}.ts`, content: migrationFile },
    { path: `tests/${n.kebab}.spec.ts`, content: test },
  ]

  const patches = [
    { path: 'src/app.ts', anchor: 'resource-imports', insert: `import { register${n.pascal} } from './resources/${n.kebab}/${n.kebab}.routes.js'` },
    { path: 'src/app.ts', anchor: 'resources', insert: `register${n.pascal}(v1, { db: deps.database.db })` },
    { path: 'src/db/migrations/index.ts', anchor: 'migration-imports', insert: `import { ${n.camel} } from './${migration}.js'` },
    { path: 'src/db/migrations/index.ts', anchor: 'migrations', insert: `'${migration}': ${n.camel},` },
    { path: 'src/db/schema.ts', anchor: 'tables', insert: `export interface ${n.pascal}Table extends StandardColumns {\n  name: string\n  /** Generated: \`name\` while live, NULL when soft-deleted — carries the unique index. Never written. */\n  liveName: import('kysely').GeneratedAlways<string | null>\n}\n\n` },
    { path: 'src/db/schema.ts', anchor: 'schema', insert: `${/^[a-z_]+$/.test(n.snake) ? n.snake : `'${n.snake}'`}: ${n.pascal}Table` },
    { path: 'tests/helpers.ts', anchor: 'test-cleanup', insert: `await t.db.deleteFrom('${n.snake}').execute()` },
  ]
  if (auth) {
    const row = (method, suffix, statuses) => `'${method} /api/v1/${n.kebab}${suffix}': { anonymous: 401, 'no role': ${statuses[0]}, ${editor ? `editor: ${statuses[1]}, ` : ''}admin: ${statuses[2]} },`
    patches.push({
      path: 'tests/auth.spec.ts',
      anchor: 'auth-matrix',
      insert: [row('GET', '', [200, 200, 200]), row('GET', '/:id', [404, 404, 404]), row('POST', '', [403, 400, 400]), row('PATCH', '/:id', [403, 400, 400]), row('DELETE', '/:id', [403, 403, 404])].join('\n'),
    })
  }

  if (hasUi) {
    files.push({
      part: 'ui',
      path: `app/pages/${n.kebab}.vue`,
      content: `<template>
  <main class="mx-auto max-w-3xl space-y-6 p-6">
    <h1 class="text-xl font-semibold text-fg" data-test="title">${n.title}</h1>
    <AsyncState :pending="pending" :error="error" :empty="!rows.length" :retry="load">
      <template #empty>
        <EmptyState title="No ${n.title.toLowerCase()} yet" description="Records created through the API show up here." />
      </template>
      <Card>
        <ul class="divide-y divide-line" data-test="${n.kebab}-list">
          <li v-for="row in rows" :key="row.id" class="flex items-center justify-between py-2 text-sm">
            <span class="text-fg">{{ row.name }}</span>
            <span class="text-muted">{{ row.createdAt.slice(0, 10) }}</span>
          </li>
        </ul>
      </Card>
    </AsyncState>
  </main>
</template>

<script setup lang="ts">
import type { components } from '~/api/schema'

useSiteHead({ title: '${n.title}' })

const rows = ref<components['schemas']['${n.onePascal}'][]>([])
const pending = ref(true)
const error = ref<string | null>(null)

async function load() {
  pending.value = true
  error.value = null
  const res = await useApi().GET('/api/v1/${n.kebab}', { params: { query: { limit: 50 } } })
  // The API's error body carries a trace id — show it, so a report can be matched to the server log.
  if (res.error) error.value = \`\${res.error.error.message} (trace \${res.error.error.traceId})\`
  else rows.value = res.data.data
  pending.value = false
}

onMounted(load)
</script>
`,
    })
    files.push({
      part: 'ui',
      path: `tests/e2e/${n.kebab}.spec.ts`,
      content: `import { expect, test } from '@playwright/test'
import { captureErrors, failure, list, stubApi } from '../kit/e2e'

${auth ? "const me = { 'GET /api/v1/me': { status: 200, body: { data: { subject: 'e2e', name: 'E2E User', email: null, roles: ['editor'], kind: 'user' } } } }\n\n" : 'const me = {}\n\n'}test('${n.kebab}: lists what the API returns, with no JS error', async ({ page }) => {
  const errors = captureErrors(page)
  const { calls } = await stubApi(page, {
    ...me,
    'GET /api/v1/${n.kebab}': list([{ id: '1', name: 'First', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]),
  })
  await page.goto('/${n.kebab}')
  await expect(page.getByTestId('title')).toHaveText('${n.title}')
  await expect(page.getByTestId('${n.kebab}-list')).toContainText('First')
  expect(calls.some((call) => call.method === 'GET' && call.path === '/api/v1/${n.kebab}')).toBe(true)
  errors.assertNone()
})

test('${n.kebab}: empty and error states', async ({ page }) => {
  await stubApi(page, { ...me, 'GET /api/v1/${n.kebab}': list([]) })
  await page.goto('/${n.kebab}')
  await expect(page.getByText('No ${n.title.toLowerCase()} yet')).toBeVisible()

  await page.unrouteAll()
  await stubApi(page, { ...me, 'GET /api/v1/${n.kebab}': failure(500, 'INTERNAL', 'Internal server error') })
  await page.reload()
  await expect(page.getByText('Internal server error (trace e2e-stub)')).toBeVisible()
})

test('${n.kebab}: the retry button of the error state loads the list again', async ({ page }) => {
  let healthy = false
  const { calls } = await stubApi(page, {
    ...me,
    'GET /api/v1/${n.kebab}': () => (healthy ? list([{ id: '1', name: 'Back again', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]) : failure(500, 'INTERNAL', 'Internal server error')),
  })
  await page.goto('/${n.kebab}')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Internal server error')
  healthy = true
  await alert.getByRole('button').click()
  await expect(page.getByTestId('${n.kebab}-list')).toContainText('Back again')
  await expect(alert).toHaveCount(0)
  expect(calls.filter((call) => call.path === '/api/v1/${n.kebab}')).toHaveLength(2)
})
`,
    })
  }

  const apiDir = parts.api?.dir ? `${parts.api.dir}` : '.'
  const next = [
    `${apiDir}: add the resource's fields — ${base}.schema.ts, the migration src/db/migrations/${migration}.ts, the table type in src/db/schema.ts and COLUMNS in ${base}.repo.ts`,
    ...(auth ? [`${apiDir}: review the roles in ${base}.routes.ts (read = any signed-in caller, write = ${editor ? 'admin / editor' : 'admin'}, delete = admin) and keep the matrix in tests/auth.spec.ts in step`] : []),
    `${apiDir}: npm run contract   # regenerates openapi.json — tests/contract.spec.ts is red until you do`,
    ...(hasUi ? [`${parts.ui.dir || '.'}: npm run client   # regenerates app/api/schema.d.ts — the new page does not typecheck until you do`] : []),
    `${apiDir}: npm run db:migrate -- up   # apply ${migration} to your development database`,
    'npm run gate',
  ]
  return { files, patches, next }
}
