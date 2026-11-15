// @vitest-environment node
// The generators behind the playbooks: `scaffold add resource | page | job` on real scaffolded projects, and the
// jobs / notify modules they belong to. That the result installs, gates, builds and runs is proven by the kit gate
// (combo fullstack+full runs all three and requires gate + build green).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanup, cli, read, snapshot, tmp } from './helpers'
// @ts-expect-error plain ESM, no types
import { names, singular } from '../lib/names.mjs'

afterAll(cleanup)

function project(args: string[]) {
  const dir = join(tmp('gen'), 'app')
  const r = cli(['new', 'demo-app', ...args, '--dir', dir, '--json'])
  expect(r.status, r.stdout).toBe(0)
  return dir
}
const add = (dir: string, type: string, name: string) => cli(['add', type, name, '--dir', dir, '--json'])

describe('names', () => {
  it('derives every spelling a generator needs from one kebab-case plural', () => {
    expect(names('order-lines')).toEqual({
      kebab: 'order-lines', snake: 'order_lines', camel: 'orderLines', pascal: 'OrderLines',
      one: 'order-line', oneSnake: 'order_line', oneCamel: 'orderLine', onePascal: 'OrderLine',
      title: 'Order Lines', oneTitle: 'Order Line', constant: 'ORDER_LINES',
    })
  })
  it.each([['orders', 'order'], ['categories', 'category'], ['boxes', 'box'], ['batches', 'batch'], ['addresses', 'address'], ['statuses', 'status'], ['status', 'status'], ['news', 'news'], ['keys', 'key'], ['people', 'people']])('singular(%s) = %s', (plural, one) => {
    expect(singular(plural)).toBe(one)
  })
})

describe('add resource', () => {
  it('fullstack with auth: API files, registration at every anchor, auth declarations + matrix rows, UI page + e2e', () => {
    const dir = project(['--kind', 'fullstack', '--with', 'auth'])
    const before = snapshot(dir)
    const r = add(dir, 'resource', 'order-lines')
    expect(r.status, r.stdout).toBe(0)
    expect(r.json).toMatchObject({ ok: true, type: 'resource', name: 'order-lines', generator: 'api' })
    expect(r.json.files).toEqual([
      'api/src/resources/order-lines/order-lines.schema.ts', 'api/src/resources/order-lines/order-lines.repo.ts', 'api/src/resources/order-lines/order-lines.routes.ts',
      'api/src/db/migrations/0003_order_lines.ts', 'api/tests/order-lines.spec.ts', 'ui/app/pages/order-lines.vue', 'ui/tests/e2e/order-lines.spec.ts',
    ])
    expect(r.json.patched).toEqual(['api/src/app.ts', 'api/src/db/migrations/index.ts', 'api/src/db/schema.ts', 'api/tests/helpers.ts', 'api/tests/auth.spec.ts'])

    const app = read(dir, 'api/src/app.ts')
    expect(app).toContain("import { registerOrderLines } from './resources/order-lines/order-lines.routes.js'\n// kit:anchor resource-imports")
    expect(app).toContain('    registerOrderLines(v1, { db: deps.database.db })\n    // kit:anchor resources')
    expect(read(dir, 'api/src/db/migrations/index.ts')).toContain("  '0003_order_lines': orderLines,\n  // kit:anchor migrations")
    expect(read(dir, 'api/src/db/migrations/index.ts')).toContain("import { orderLines } from './0003_order_lines.js'\n// kit:anchor migration-imports")
    expect(read(dir, 'api/src/db/schema.ts')).toMatch(/export interface OrderLinesTable extends StandardColumns \{\n  name: string\n  \/\*\* Generated: .*\n  liveName: import\('kysely'\)\.GeneratedAlways<string \| null>\n\}\n\n\/\/ kit:anchor tables/)
    expect(read(dir, 'api/src/db/schema.ts')).toContain('  order_lines: OrderLinesTable\n  // kit:anchor schema')
    expect(read(dir, 'api/tests/helpers.ts')).toContain("    await t.db.deleteFrom('order_lines').execute()\n    // kit:anchor test-cleanup")

    // every route of the new resource declares who may call it, and the matrix knows all five
    const routes = read(dir, 'api/src/resources/order-lines/order-lines.routes.ts')
    expect(routes.match(/createRoute\(\{/g)).toHaveLength(5)
    expect(routes.match(/middleware: \[require(?:Auth\(\)|Role\([^)]*\))\] as const,/g)).toHaveLength(5)
    expect(routes).toContain("path: '/order-lines/{id}'")
    const matrix = read(dir, 'api/tests/auth.spec.ts')
    for (const row of ['GET /api/v1/order-lines', 'GET /api/v1/order-lines/:id', 'POST /api/v1/order-lines', 'PATCH /api/v1/order-lines/:id', 'DELETE /api/v1/order-lines/:id']) expect(matrix, row).toContain(`'${row}': { anonymous: 401,`)
    expect(read(dir, 'api/src/resources/order-lines/order-lines.repo.ts')).toContain("audited(db, { action: 'order_line.create' }")
    expect(read(dir, 'ui/app/pages/order-lines.vue')).toContain("useApi().GET('/api/v1/order-lines'")
    expect(read(dir, 'ui/app/pages/order-lines.vue')).toContain('<AsyncState :pending="pending" :error="error"')

    // nothing else changed, no locked file was touched, and the next steps name the derived files
    const after = snapshot(dir)
    expect(Object.keys(before).filter((f) => after[f] !== before[f]).sort()).toEqual([...r.json.patched].sort())
    expect(cli(['check', dir, '--json']).json.clean).toBe(true)
    expect(r.json.next.join('\n')).toMatch(/npm run contract[\s\S]*npm run client[\s\S]*db:migrate -- up[\s\S]*npm run gate/)
  })

  it('kind api without auth: no declarations, no matrix, no UI files — and the next free migration number', () => {
    const dir = project(['--kind', 'api', '--with', 'api'])
    expect(add(dir, 'resource', 'orders').json.files).toEqual([
      'src/resources/orders/orders.schema.ts', 'src/resources/orders/orders.repo.ts', 'src/resources/orders/orders.routes.ts', 'src/db/migrations/0003_orders.ts', 'tests/orders.spec.ts',
    ])
    const routes = read(dir, 'src/resources/orders/orders.routes.ts')
    expect(routes).not.toMatch(/middleware:|kit\/auth|401|403/)
    const second = add(dir, 'resource', 'categories')
    expect(second.json.files).toContain('src/db/migrations/0004_categories.ts')
    expect(second.json.patched).toEqual(['src/app.ts', 'src/db/migrations/index.ts', 'src/db/schema.ts', 'tests/helpers.ts'])
    expect(read(dir, 'src/db/migrations/index.ts')).toContain("  '0003_orders': orders,\n  '0004_categories': categories,\n  // kit:anchor migrations")
    expect(read(dir, 'src/resources/categories/categories.schema.ts')).toContain('export const CategorySchema = z')
  })

  // M8: the generated resource enforces "one live row per name" in the database and answers 409; L6: guarded writes
  it('the generated resource has the live-unique column + index, maps a duplicate key to 409 and never writes to a deleted row', () => {
    const dir = project(['--kind', 'api', '--with', 'api'])
    expect(add(dir, 'resource', 'order-lines').status).toBe(0)
    const migration = read(dir, 'src/db/migrations/0003_order_lines.ts')
    expect(migration).toContain(".addColumn('liveName', 'varchar(191)', (col) => col.generatedAlwaysAs(liveValue('name')))")
    expect(migration).toContain("createIndex('order_lines_live_name_uq').on('order_lines').column('liveName').unique()")
    const repo = read(dir, 'src/resources/order-lines/order-lines.repo.ts')
    expect(repo).toContain('isUniqueViolation(error) ? conflict(`Order Line "${name}" already exists`) : error')
    expect(repo.match(/\.where\('id', '=', id\)\.where\('deletedAt', 'is', null\)\.executeTakeFirst\(\)/g)).toHaveLength(3) // the read, the update and the delete
    expect(repo.match(/if \(!(?:updated|deleted)\.numUpdatedRows\) throw notFound/g)).toHaveLength(2)
    const routes = read(dir, 'src/resources/order-lines/order-lines.routes.ts')
    expect(routes).toContain('errorResponses(400, 409)')
    expect(routes).toContain('errorResponses(400, 404, 409)')
    expect(read(dir, 'src/db/schema.ts')).toContain("liveName: import('kysely').GeneratedAlways<string | null>")
    expect(read(dir, 'tests/order-lines.spec.ts')).toContain('names are unique among live rows')
    // the example resource uses the same pattern
    expect(read(dir, 'src/db/migrations/0002_items.ts')).toContain("createIndex('items_live_name_uq').on('items').column('liveName').unique()")
    expect(read(dir, 'src/resources/items/items.repo.ts')).not.toContain('assertNameFree')
  })

  // L5: `add job delete` wrote `export const delete = …`
  it.each([['job', 'delete', 'reserved word'], ['job', 'new', 'reserved word'], ['resource', 'classes', 'reserved word'], ['resource', 'errors', 'shadow a built-in'], ['page', 'default', 'reserved word'], ['page', 'import', 'reserved word']])('add %s %s is refused (exit 2): %s', (type, name, why) => {
    const dir = project(['--kind', 'fullstack', '--with', 'api,jobs'])
    const before = snapshot(dir)
    const r = add(dir, type, name)
    expect(r.status).toBe(2)
    expect(r.json).toMatchObject({ ok: false, code: 'reserved_name' })
    expect(r.json.message).toContain(why)
    expect(snapshot(dir)).toEqual(before)
  })

  it('ordinary names that merely contain such a word are fine', () => {
    const dir = project(['--kind', 'fullstack', '--with', 'api,jobs'])
    for (const [type, name] of [['job', 'delete-expired'], ['resource', 'error-reports'], ['page', 'new-order']]) expect(add(dir, type!, name!).status, `${type} ${name}`).toBe(0)
  })

  it('never overwrites (exit 3), needs the api module (exit 4), and a removed anchor stops it before anything is written (exit 2)', () => {
    const dir = project(['--kind', 'api', '--with', 'api'])
    expect(add(dir, 'resource', 'orders').status).toBe(0)
    expect(add(dir, 'resource', 'orders').status).toBe(3)
    expect(add(project(['--kind', 'api']), 'resource', 'orders').status).toBe(4)

    const broken = project(['--kind', 'api', '--with', 'api'])
    writeFileSync(join(broken, 'src/db/schema.ts'), read(broken, 'src/db/schema.ts').replace(/^.*kit:anchor schema.*\n/m, ''))
    const before = snapshot(broken)
    const r = add(broken, 'resource', 'orders')
    expect(r.status).toBe(2)
    expect(r.json).toMatchObject({ code: 'anchor_missing' })
    expect(r.json.message).toContain('orders: OrdersTable')
    expect(snapshot(broken)).toEqual(before)
  })
})

describe('add page', () => {
  it('writes the page on the AsyncState pattern and an e2e spec; with auth the spec stubs /api/v1/me', () => {
    const dir = project(['--kind', 'nuxt-app'])
    const r = add(dir, 'page', 'order-history')
    expect(r.json.files).toEqual(['app/pages/order-history.vue', 'tests/e2e/order-history.spec.ts'])
    const page = read(dir, 'app/pages/order-history.vue')
    for (const text of ['<AsyncState :pending="pending" :error="error" :empty="!rows.length" @retry="load">', "useSiteHead({ title: 'Order History' })", 'onMounted(load)']) expect(page).toContain(text)
    const spec = read(dir, 'tests/e2e/order-history.spec.ts')
    expect(spec).toContain("await page.goto('/order-history')")
    expect(spec).toContain('expect(errors).toEqual([])')
    expect(spec).not.toContain('/api/v1/me')

    const withAuth = project(['--kind', 'fullstack', '--with', 'auth'])
    expect(add(withAuth, 'page', 'reports').json.files).toEqual(['ui/app/pages/reports.vue', 'ui/tests/e2e/reports.spec.ts'])
    expect(read(withAuth, 'ui/tests/e2e/reports.spec.ts')).toContain("page.route('**/api/v1/me'")
  })
})

describe('jobs module + add job', () => {
  it('the module: ready, needs the API standard and the data layer, ships the runner and an empty registry', () => {
    expect(cli(['list', '--json']).json.modules.find((m: any) => m.name === 'jobs')).toMatchObject({ status: 'ready', kinds: ['api', 'fullstack'], requires: ['api', 'db'], generators: ['job'] })
    const dir = project(['--kind', 'api', '--with', 'jobs'])
    expect(JSON.parse(read(dir, 'package.json')).scripts.job).toBe('tsx --env-file-if-exists=.env src/jobs/run.ts')
    expect(JSON.parse(read(dir, '.scaffold.json')).locked).toHaveProperty('src/kit/jobs/runner.ts')
    expect(read(dir, 'src/jobs/index.ts')).toContain('// kit:anchor jobs')
    expect(read(dir, 'src/config.ts')).toContain("JOB_LOCK_DIR: z.string().default('./data/locks')")
    expect(read(dir, '.memory/docs/guides/usage.md')).toContain('## Jobs')
    expect(read(project(['--kind', 'api', '--with', 'api']), 'src/config.ts')).not.toContain('JOB_')
  })

  it('add job: the skeleton, its test, the registration and the scheduler entry — and nothing is scheduled', () => {
    const dir = project(['--kind', 'fullstack', '--with', 'jobs', '--deploy', 'container'])
    const r = add(dir, 'job', 'nightly-sync')
    expect(r.status, r.stdout).toBe(0)
    expect(r.json.files).toEqual(['api/src/jobs/nightly-sync.ts', 'api/tests/job-nightly-sync.spec.ts', '.memory/docs/guides/job-nightly-sync.md'])
    expect(r.json.patched).toEqual(['api/src/jobs/index.ts'])
    expect(read(dir, 'api/src/jobs/index.ts')).toContain("import { nightlySync } from './nightly-sync.js'\n// kit:anchor job-imports")
    expect(read(dir, 'api/src/jobs/index.ts')).toContain("  'nightly-sync': nightlySync,\n  // kit:anchor jobs")
    expect(read(dir, 'api/src/jobs/nightly-sync.ts')).toContain("name: 'nightly-sync',")
    const test = read(dir, 'api/tests/job-nightly-sync.spec.ts')
    for (const text of ['is idempotent', 'adds no audit row', 'cannot overlap itself', 'JOB_EXIT.LOCKED']) expect(test, text).toContain(text)

    const doc = read(dir, '.memory/docs/guides/job-nightly-sync.md')
    expect(doc).toMatch(/^---\nname: demo-app-job-nightly-sync\ndescription: .+\n---\n/)
    const entry = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(doc)![1]!)
    expect(entry).toMatchObject({ id: 'demo-app-nightly-sync', command: 'cd /srv/demo-app && docker compose exec -T api node dist/jobs/run.js nightly-sync', timeout: 660, notify: 'fail', enabled: true })
    expect(entry.schedule).toMatch(/^<cron/) // the operator decides
    expect(entry.device).toMatch(/^<host/)
    expect(r.json.next.join('\n')).toContain('nothing is scheduled until you do')
    // nothing in the project schedules anything
    expect(Object.keys(snapshot(dir)).filter((f) => /cron|systemd|\.timer$|\.service$/.test(f))).toEqual([])
    expect(add(dir, 'job', 'nightly-sync').status).toBe(3)
  })

  it('without a container preset the entry runs the built runner from the api directory', () => {
    const dir = project(['--kind', 'api', '--with', 'jobs', '--deploy', 'pm2'])
    add(dir, 'job', 'cleanup')
    expect(read(dir, '.memory/docs/guides/job-cleanup.md')).toContain('"command": "cd <project dir> && node --env-file-if-exists=.env dist/jobs/run.js cleanup"')
    expect(add(project(['--kind', 'api', '--with', 'api']), 'job', 'cleanup').status).toBe(4) // no jobs module, no generator
  })
})

describe('notify module', () => {
  it('ready; a mock-tested client under 100 lines; the token is a secret', () => {
    expect(cli(['list', '--json']).json.modules.find((m: any) => m.name === 'notify')).toMatchObject({ status: 'ready', kinds: ['api', 'fullstack'], requires: ['api'] })
    const dir = join(tmp('notify'), 'app')
    const r = cli(['new', 'demo-app', '--kind', 'api', '--with', 'notify', '--dir', dir, '--json'])
    expect(r.json.locked).toContain('src/kit/notify/client.ts')
    expect(r.json.files).toEqual(expect.arrayContaining(['src/notify.ts', 'tests/notify.spec.ts']))
    expect(r.json.env).toContainEqual({ key: 'NOTIFIER_TOKEN', required: false, secret: true })
    expect(read(dir, 'src/config.ts')).toContain("SECRETS: readonly (keyof typeof shape)[] = ['DATABASE_URL', 'NOTIFIER_TOKEN']")
    expect(read(dir, '.env.example')).toMatch(/\nNOTIFIER_URL=\n/) // no hub address lives in the kit
    expect(readFileSync(join(__dirname, '../runtime/notify/client.ts'), 'utf8').split('\n').length).toBeLessThan(100)
  })

  it('no module is left planned', () => {
    expect(cli(['list', '--json']).json.modules.filter((m: any) => m.status !== 'ready')).toEqual([])
  })
})

describe('playbooks', () => {
  const PLAYBOOK = (name: string) => `.memory/docs/guides/playbook-${name}.md`

  it('are copied into the projects that have the generator, rendered for the project', () => {
    const cases: [string[], string[]][] = [
      [['--kind', 'nuxt-app'], ['add-page']],
      [['--kind', 'api'], []],
      [['--kind', 'api', '--with', 'api'], ['add-resource']],
      [['--kind', 'fullstack', '--with', 'api'], ['add-page', 'add-resource']],
      [['--kind', 'fullstack', '--with', 'jobs,auth'], ['add-job', 'add-page', 'add-resource']],
    ]
    for (const [args, expected] of cases) {
      const dir = project(args)
      const present = ['add-job', 'add-page', 'add-resource'].filter((name) => existsSync(join(dir, PLAYBOOK(name))))
      expect(present, args.join(' ')).toEqual(expected)
      for (const name of present) {
        const text = read(dir, PLAYBOOK(name))
        expect(text, name).toMatch(/^---\nname: demo-app-playbook-[a-z-]+\ndescription: .+\n---\n# Playbook: /)
        expect(text, name).toContain(`scaffold add ${name.slice(4)} <name>`)
        expect(text, name).toContain('## Tests that must pass')
        expect(text, name).not.toMatch(/\{\{kit\./)
      }
    }
    expect(read(project(['--kind', 'fullstack', '--with', 'api']), PLAYBOOK('add-resource'))).toContain('npm run contract --prefix api')
    expect(read(project(['--kind', 'api', '--with', 'api']), PLAYBOOK('add-resource'))).toContain('npm run contract --prefix .')
  })

  it('every generator the kit lists has a playbook', () => {
    for (const type of cli(['list', '--json']).json.generators) expect(existsSync(join(__dirname, '..', 'playbooks', `add-${type}.md`)), type).toBe(true)
  })
})
