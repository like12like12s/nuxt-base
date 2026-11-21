// @vitest-environment node
// What the api / db / testkit modules compose (the behaviour of the result is proven by the kit gate, which
// installs, gates, builds and runs it; the runtime itself is tested in runtime-*.spec.ts).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanup, cli, cloneKit, read, snapshot, tmp } from './helpers'

afterAll(cleanup)

function scaffold(args: string[], opts: { context?: object; kit?: string } = {}) {
  const base = tmp('mod')
  const dir = join(base, 'app')
  const extra: string[] = []
  if (opts.context) {
    writeFileSync(join(base, 'ctx.json'), JSON.stringify(opts.context))
    extra.push('--context', join(base, 'ctx.json'))
  }
  const r = cli(['new', 'demo-app', ...args, ...extra, '--dir', dir, '--json'], { kit: opts.kit })
  return { dir, r }
}

describe('module list', () => {
  it('api, db and testkit are ready; api and db come together and bring the test kit', () => {
    const modules = Object.fromEntries(cli(['list', '--json']).json.modules.map((m: any) => [m.name, m]))
    expect(modules.api).toMatchObject({ status: 'ready', kinds: ['api', 'fullstack'], requires: ['db', 'testkit'] })
    expect(modules.db).toMatchObject({ status: 'ready', kinds: ['api', 'fullstack'], requires: ['api', 'testkit'] })
    expect(modules.testkit).toMatchObject({ status: 'ready', kinds: ['nuxt-app', 'api', 'fullstack'], requires: [] })
  })

  it.each([['api'], ['db'], ['api,db'], ['db,api,testkit']])('--with %s resolves to the same module set', (list) => {
    const { r } = scaffold(['--kind', 'api', '--with', list])
    expect(r.status).toBe(0)
    expect(r.json.modules).toEqual(['base', 'api', 'db', 'testkit'])
    expect(r.json.db).toBe('sqlite')
  })

  it('api / db are refused on nuxt-app (exit 4); testkit is not', () => {
    for (const name of ['api', 'db']) {
      const { r } = scaffold(['--kind', 'nuxt-app', '--with', name])
      expect([r.status, r.json.code], name).toEqual([4, 'incompatible_module'])
    }
    expect(scaffold(['--kind', 'nuxt-app', '--with', 'testkit']).r.status).toBe(0)
  })
})

describe('kind api --with api,db', () => {
  const { dir, r } = scaffold(['--kind', 'api', '--with', 'api,db', '--port', '3920'])
  const pkg = JSON.parse(read(dir, 'package.json'))

  it('replaces the plain app with the standard one (one writer per path)', () => {
    expect(r.status).toBe(0)
    expect(read(dir, 'src/app.ts')).toContain("createApi({")
    expect(read(dir, 'src/app.ts')).toContain("export const SERVICE = 'demo-app'")
    expect(read(dir, 'src/index.ts')).toContain('cleanup: () => database.close()')
    expect(read(dir, 'src/config.ts')).toContain("SECRETS: readonly (keyof typeof shape)[] = ['DATABASE_URL']")
    for (const f of ['src/contract.ts', 'openapi.json', 'src/resources/items/items.routes.ts', 'src/resources/items/items.repo.ts', 'src/resources/items/items.schema.ts',
      'src/db/schema.ts', 'src/db/index.ts', 'src/db/cli.ts', 'src/db/seed.ts', 'src/db/migrations/index.ts', 'src/db/migrations/0002_items.ts',
      'tests/helpers.ts', 'tests/app.spec.ts', 'tests/items.spec.ts', 'tests/db.spec.ts', 'tests/contract.spec.ts', 'tests/config.spec.ts']) {
      expect(r.json.files, f).toContain(f)
    }
    for (const f of r.json.files) expect(read(dir, f), f).not.toMatch(/\{\{kit\./)
  })

  it('the plain kind keeps its own app when the module is absent', () => {
    const plain = scaffold(['--kind', 'api'])
    expect(read(plain.dir, 'src/app.ts')).toContain('new Hono()')
    expect(plain.r.json.files).not.toContain('openapi.json')
    expect(plain.r.json.files.filter((f: string) => f.startsWith('src/kit/'))).toEqual(['src/kit/api/context.ts', 'src/kit/api/env.ts', 'src/kit/api/log.ts', 'src/kit/api/shutdown.ts'])
    expect(JSON.parse(read(plain.dir, 'package.json')).dependencies).not.toHaveProperty('kysely')
  })

  it('locks the runtime under src/kit/{api,db,testing} — byte for byte, with the DO NOT EDIT header', () => {
    expect(r.json.locked).toEqual([
      'scripts/gate-ci.mjs',
      ...['app', 'build-info', 'context', 'env', 'errors', 'health', 'kit-version', 'log', 'pagination', 'shutdown'].map((f) => `src/kit/api/${f}.ts`),
      ...['checks', 'cli', 'clock', 'connect', 'migrate', 'mysql', 'repo', 'resilient', 'schema', 'sqlite'].map((f) => `src/kit/db/${f}.ts`),
      ...['client', 'factory', 'test-db'].map((f) => `src/kit/testing/${f}.ts`),
    ])
    const kitFiles = snapshot(join(__dirname, '..', 'runtime'))
    const app = snapshot(dir)
    for (const path of r.json.locked.filter((p: string) => p.startsWith('src/kit/'))) {
      expect(app[path], path).toBe(kitFiles[path.replace('src/kit/', '')])
      expect(read(dir, path).split('\n')[0], path).toMatch(/^\/\/ DO NOT EDIT — locked file from the nuxt-base kit \(runtime\//)
    }
    // the build must not ship the test kit
    expect(JSON.parse(read(dir, 'tsconfig.build.json')).exclude).toEqual(['src/kit/testing'])
  })

  it('package.json: dependencies, scripts and the gate', () => {
    expect(Object.keys(pkg.dependencies)).toEqual(['@hono/node-server', '@hono/zod-openapi', 'hono', 'kysely', 'mysql2', 'zod'])
    expect(pkg.scripts).toMatchObject({
      contract: 'tsx src/contract.ts',
      'db:migrate': 'tsx --env-file-if-exists=.env src/db/cli.ts migrate',
      'db:seed': 'tsx --env-file-if-exists=.env src/db/cli.ts seed',
      'db:check': 'tsx --env-file-if-exists=.env src/db/cli.ts check',
      lint: 'oxlint --deny-warnings',
      gate: 'npm run typecheck && npm run lint && npm run test',
    })
    expect(JSON.stringify(pkg)).not.toMatch(/better-sqlite3|prisma|drizzle/) // SQLite = node:sqlite, nothing to compile
  })

  it('env: DATABASE_URL is required and secret; --json lists it; .env.example has the SQLite default', () => {
    expect(r.json.env).toContainEqual({ key: 'DATABASE_URL', required: true, secret: true })
    for (const key of ['DB_CONNECT_TIMEOUT_MS', 'DB_QUERY_TIMEOUT_MS', 'DB_RETRIES', 'DB_POOL_MAX', 'DB_BACKUP_CMD', 'DB_MIGRATE_ON_DEPLOY', 'APP_COMMIT', 'APP_BUILT_AT']) {
      expect(r.json.env, key).toContainEqual({ key, required: false, secret: false })
    }
    expect(read(dir, '.env.example')).toContain('\nDATABASE_URL=sqlite:./data/demo-app.db\n')
    expect(read(dir, '.gitignore').split('\n')).toEqual(expect.arrayContaining(['data/', '*.db', '.env']))
  })

  it('--json reports what a backup job must cover, and registers nothing itself', () => {
    expect(r.json.backup).toEqual([{ id: 'demo-app-db', service: 'demo-app-api', engine: 'sqlite', envKey: 'DATABASE_URL', path: 'data/demo-app.db' }])
    expect(Object.keys(r.json)).toEqual(['ok', 'dir', 'name', 'title', 'description', 'kind', 'modules', 'db', 'deploy', 'sample', 'lang', 'kitVersion', 'files', 'locked', 'services', 'env', 'backup', 'next'])
    expect(r.json.next.join('\n')).toMatch(/db:migrate -- up/)
  })

  it('the committed contract is the template rendered for this app', () => {
    const doc = JSON.parse(read(dir, 'openapi.json'))
    expect(doc.info).toEqual({ title: 'demo-app', version: pkg.version })
    expect(Object.keys(doc.paths)).toContain('/api/v1/items/{id}')
  })

  it('usage.md documents the standard, the database commands and the test kit', () => {
    const usage = read(dir, '.memory/docs/guides/usage.md')
    for (const text of ['## API standard', 'GET /health/ready', '## Database', 'npm run db:migrate -- up', 'DB_BACKUP_CMD', '## Test kit', 'TEST_MYSQL_URL']) expect(usage, text).toContain(text)
  })
})

// Finding #13 of the first real use: the example resource `items` (table, routes, tests, seed rows, the `editor`
// role) stayed in a real app and there was no way to leave it out.
describe('--no-sample', () => {
  const FULL = ['--kind', 'fullstack', '--with', 'db,auth,api,trace,og,security,jobs,notify', '--deploy', 'container']
  const texts = (dir: string, files: string[]) => files.filter((f) => !f.endsWith('package-lock.json')).map((f) => [f, read(dir, f)] as const)

  it.each([[['--kind', 'api', '--with', 'api,db']], [['--kind', 'fullstack', '--with', 'api,db']], [FULL]])('%j: nothing of the example is generated — no file, no table, no route, no test, no mention', (args) => {
    const sample = scaffold(args)
    const { dir, r } = scaffold([...args, '--no-sample'])
    expect(r.status, r.stdout).toBe(0)
    expect(r.json.sample).toBe(false)
    expect(sample.r.json.sample).toBe(true)
    expect(JSON.parse(read(dir, '.scaffold.json')).answers.sample).toBe(false)
    expect(JSON.parse(read(sample.dir, '.scaffold.json')).answers).not.toHaveProperty('sample') // existing manifests stay as they are

    const gone = sample.r.json.files.filter((f: string) => !r.json.files.includes(f)).map((f: string) => f.replace(/^api\//, ''))
    expect(gone.sort()).toEqual(['src/db/migrations/0002_items.ts', 'src/resources/items/items.repo.ts', 'src/resources/items/items.routes.ts', 'src/resources/items/items.schema.ts', 'tests/items.spec.ts'])
    expect(r.json.files.filter((f: string) => !sample.r.json.files.includes(f))).toEqual([])

    // the word only survives where it is an example in prose or a stubbed path of the test kit — never as code that needs the resource
    for (const [file, text] of texts(dir, r.json.files)) {
      expect(text, file).not.toMatch(/@kit:/)
      // (openapi.json / schema.d.ts use `items` as the JSON-schema keyword of an array — their paths are checked below)
      if (/\.(md)$/.test(file) || /tests\/e2e\/api\.spec\.ts$/.test(file) || /server\/og\.ts$/.test(file) || /kit\//.test(file) || /openapi\.json$|schema\.d\.ts$/.test(file)) continue
      expect(text, file).not.toMatch(/\bitems?\b|Items|SEED_ITEMS|registerItems/)
    }
    const api = args.includes('fullstack') ? 'api/' : ''
    expect(read(dir, `${api}src/db/migrations/index.ts`)).toMatch(/'0001_base': baseMigration,\n {2}\/\/ kit:anchor migrations/)
    expect(read(dir, `${api}src/db/schema.ts`)).toMatch(/export interface Schema extends BaseTables \{\n {2}\/\/ kit:anchor schema/)
    expect(Object.keys(JSON.parse(read(dir, `${api}openapi.json`)).paths).filter((p) => p.includes('items'))).toEqual([])
    // every anchor the resource generator needs is still there
    for (const [file, anchor] of [['src/app.ts', 'resource-imports'], ['src/app.ts', 'resources'], ['src/db/migrations/index.ts', 'migration-imports'], ['src/db/migrations/index.ts', 'migrations'], ['src/db/schema.ts', 'tables'], ['src/db/schema.ts', 'schema'], ['tests/helpers.ts', 'test-cleanup']]) {
      expect(read(dir, api + file), file).toContain(`kit:anchor ${anchor}`)
    }
  })

  it('with auth: the only role is admin — no `editor` in the roles, the test matrix or the role map example', () => {
    const { dir } = scaffold([...FULL, '--no-sample'])
    expect(read(dir, 'api/src/auth/roles.ts')).toContain("export const ROLES = ['admin'] as const")
    const spec = read(dir, 'api/tests/auth.spec.ts')
    expect(spec).toContain("type Caller = 'anonymous' | 'no role' | 'admin'")
    expect(spec).toContain("'GET /api/v1/me': { anonymous: 401, 'no role': 200, admin: 200 },\n  // kit:anchor auth-matrix")
    expect(spec).not.toMatch(/app-editors|editor:/)
    expect(read(scaffold(FULL).dir, 'api/src/auth/roles.ts')).toContain("export const ROLES = ['admin', 'editor'] as const")
  })

  it('add resource in such a project: starts at 0002, writes are admin-only, and the matrix rows have its columns', () => {
    const { dir } = scaffold([...FULL, '--no-sample'])
    const r = cli(['add', 'resource', 'orders', '--dir', dir, '--json'])
    expect(r.status, r.stdout).toBe(0)
    expect(r.json.files).toContain('api/src/db/migrations/0002_orders.ts')
    const routes = read(dir, 'api/src/resources/orders/orders.routes.ts')
    expect(routes.match(/requireRole\('admin'\)/g)).toHaveLength(3)
    expect(routes).not.toContain('editor')
    expect(read(dir, 'api/tests/auth.spec.ts')).toContain("'POST /api/v1/orders': { anonymous: 401, 'no role': 403, admin: 400 },")
    expect(r.json.next.join('\n')).toContain('write = admin, delete = admin')
    // and the default project is unchanged
    const sample = scaffold(FULL).dir
    cli(['add', 'resource', 'orders', '--dir', sample, '--json'])
    expect(read(sample, 'api/src/resources/orders/orders.routes.ts')).toContain("requireRole('admin', 'editor')")
    expect(read(sample, 'api/tests/auth.spec.ts')).toContain("'POST /api/v1/orders': { anonymous: 401, 'no role': 403, editor: 400, admin: 400 },")
  })

  it('survives check / update (it is a recorded answer), and is a no-op without the api module', () => {
    const { dir } = scaffold(['--kind', 'fullstack', '--with', 'api,db', '--no-sample'])
    expect(cli(['check', dir, '--json']).json).toMatchObject({ clean: true, drift: [] })
    expect(cli(['update', dir, '--json']).json.updated).toEqual([])
    const plain = scaffold(['--kind', 'nuxt-app', '--no-sample'])
    expect(plain.r.status).toBe(0)
    expect(plain.r.json.sample).toBe(false)
    expect(JSON.parse(read(plain.dir, '.scaffold.json')).answers).not.toHaveProperty('sample')
    expect(snapshot(plain.dir)).toEqual(snapshot(scaffold(['--kind', 'nuxt-app']).dir))
  })

  it('the default is byte-identical to before: the sample files come from their own directory, same paths', () => {
    const { dir, r } = scaffold(['--kind', 'api', '--with', 'api,db'])
    for (const f of ['src/resources/items/items.routes.ts', 'src/db/migrations/0002_items.ts', 'tests/items.spec.ts']) expect(r.json.files).toContain(f)
    expect(read(dir, 'src/app.ts')).toContain("import { registerItems } from './resources/items/items.routes.js'\n")
    expect(read(dir, 'src/db/migrations/index.ts')).toContain("  '0001_base': baseMigration,\n  '0002_items': items,\n  // kit:anchor migrations")
  })
})

describe('--db mysql', () => {
  it('only changes the defaults: the example URL (placeholders, host from --context) and the backup entry', () => {
    const sqlite = scaffold(['--kind', 'api', '--with', 'api,db'])
    const mysql = scaffold(['--kind', 'api', '--with', 'api,db', '--db', 'mysql'], { context: { mysqlHost: 'mysql.example.net' } })
    expect(mysql.r.json.db).toBe('mysql')
    expect(read(mysql.dir, '.env.example')).toContain('\nDATABASE_URL=mysql://<user>:<password>@mysql.example.net:3306/demo_app\n')
    expect(mysql.r.json.backup).toEqual([{ id: 'demo-app-db', service: 'demo-app-api', engine: 'mysql', database: 'demo_app', envKey: 'DATABASE_URL' }])
    expect(scaffold(['--kind', 'api', '--with', 'db', '--db', 'mysql']).r.json.db).toBe('mysql')
    expect(read(scaffold(['--kind', 'api', '--with', 'db', '--db', 'mysql']).dir, '.env.example')).toContain('@db.example.com:3306/demo_app')

    const a = snapshot(sqlite.dir)
    const b = snapshot(mysql.dir)
    expect(Object.keys(b)).toEqual(Object.keys(a))
    // what differs is configuration and the docs that name the default engine — never code
    const changed = Object.keys(a).filter((f) => a[f] !== b[f])
    expect(changed).toContain('.env.example')
    expect(changed).toContain('.scaffold.json')
    expect(changed.filter((f) => !f.endsWith('.md') && !['.env.example', '.scaffold.json'].includes(f))).toEqual([])
    // source, migrations and tests are identical: one code base for both engines
    for (const f of Object.keys(a).filter((p) => p.startsWith('src/') || p.startsWith('tests/'))) expect(b[f], f).toBe(a[f])
  })

  it('the mysql host survives check / update (it is part of the recorded answers)', () => {
    const { dir } = scaffold(['--kind', 'api', '--with', 'api,db', '--db', 'mysql', '--deploy', 'container'], { context: { mysqlHost: 'mysql.example.net' } })
    expect(JSON.parse(read(dir, '.scaffold.json')).answers.mysqlHost).toBe('mysql.example.net')
    expect(cli(['check', dir, '--json']).json).toMatchObject({ clean: true, drift: [] })
    expect(JSON.parse(read(scaffold(['--kind', 'api', '--with', 'db']).dir, '.scaffold.json')).answers).not.toHaveProperty('mysqlHost')
  })
})

describe('fullstack --with api,db', () => {
  const { dir, r } = scaffold(['--kind', 'fullstack', '--with', 'api,db', '--port', '3920'])

  it('the API part gets the standard, the UI part the typed client and useApi()', () => {
    expect(r.status).toBe(0)
    for (const f of ['api/src/app.ts', 'api/openapi.json', 'api/src/kit/db/connect.ts', 'api/tests/items.spec.ts',
      'ui/app/api/schema.d.ts', 'ui/app/api/schema.check.ts', 'ui/app/composables/useApi.ts', 'ui/tests/unit/use-api.spec.ts', 'ui/tests/unit/api-client.spec.ts',
      'ui/tests/e2e/api.spec.ts', 'ui/tests/kit/e2e.ts']) {
      expect(r.json.files, f).toContain(f)
    }
    const ui = JSON.parse(read(dir, 'ui/package.json'))
    expect(ui.dependencies['openapi-fetch']).toBeTruthy()
    expect(ui.devDependencies['openapi-typescript']).toBeTruthy()
    expect(ui.scripts.client).toBe('openapi-typescript ../api/openapi.json -o app/api/schema.d.ts')
    expect(JSON.parse(read(dir, 'api/package.json')).devDependencies).not.toHaveProperty('openapi-typescript') // needs TypeScript 5; the API is on 7
    expect(read(dir, 'ui/tests/unit/api-client.spec.ts')).toContain("'../../../api/openapi.json'")
    expect(read(dir, 'ui/app/api/schema.d.ts')).toContain('"/api/v1/items/{id}"')
  })

  it('paths in --json are project-relative: the backup entry and the locked files sit under api/ and ui/', () => {
    expect(r.json.backup).toEqual([{ id: 'demo-app-db', service: 'demo-app-api', engine: 'sqlite', envKey: 'DATABASE_URL', path: 'api/data/demo-app.db' }])
    expect(r.json.locked).toContain('api/src/kit/testing/test-db.ts')
    expect(r.json.locked).toContain('ui/tests/kit/e2e.ts')
    expect(r.json.locked.filter((p: string) => p.startsWith('ui/'))).toEqual(['ui/app/utils/api-error.ts', 'ui/scripts/lib/heavy-run-global-setup.mjs', 'ui/tests/kit/e2e.ts', 'ui/tests/kit/tiers-check.mjs'])
  })
})

describe('testkit on its own', () => {
  it('kind api without db: only the in-process client (the factories and the test DB need the data layer)', () => {
    const { r } = scaffold(['--kind', 'api', '--with', 'testkit'])
    expect(r.json.modules).toEqual(['base', 'testkit'])
    expect(r.json.locked.filter((p: string) => p.includes('/testing/'))).toEqual(['src/kit/testing/client.ts'])
  })

  it('kind nuxt-app: the playwright helpers', () => {
    const { dir, r } = scaffold(['--kind', 'nuxt-app', '--with', 'testkit'])
    expect(r.json.locked).toEqual(['scripts/gate-ci.mjs', 'scripts/lib/heavy-run-global-setup.mjs', 'tests/kit/e2e.ts', 'tests/kit/tiers-check.mjs'])
    expect(read(dir, 'tests/kit/e2e.ts')).toContain('export async function stubApi')
    expect(read(dir, '.memory/docs/guides/usage.md')).toContain('captureErrors(page)')
  })

  it('tiers-check ships from base, not testkit: every UI part has it even without the testkit module', () => {
    const { dir, r } = scaffold(['--kind', 'nuxt-app'])
    expect(r.json.locked).toEqual(['scripts/gate-ci.mjs', 'scripts/lib/heavy-run-global-setup.mjs', 'tests/kit/tiers-check.mjs'])
    expect(read(dir, 'tests/kit/tiers-check.mjs')).toContain('DO NOT EDIT')
    expect(read(dir, '.memory/docs/guides/usage.md')).toContain('tiers-check')
  })
})

describe('container preset with the db module', () => {
  it('compose starts the api only after db-check completed successfully; the env template has the database keys', () => {
    for (const kind of ['api', 'fullstack']) {
      const { dir } = scaffold(['--kind', kind, '--with', 'api,db', '--deploy', 'container'])
      const compose = read(dir, 'docker/docker-compose.yml')
      expect(compose, kind).toMatch(/\n  db-check:\n(.*\n)*?    command: \["node", "dist\/db\/cli\.js", "predeploy"\]\n/)
      expect(compose, kind).toMatch(/\n  api:\n(.*\n)*?    depends_on:\n      db-check:\n        condition: service_completed_successfully\n/)
      expect(compose.match(/restart: "no"/g), kind).toHaveLength(1)
      const env = read(dir, 'docker/env.example')
      expect(env, kind).toContain('\nDATABASE_URL=sqlite:./data/demo-app.db\n')
      expect(env, kind).toContain('\nDB_MIGRATE_ON_DEPLOY=1\n')
    }
  })

  // Finding #11: /version of a deployed image must say which build it is, with the deploy script unchanged.
  it('the API image and the compose file carry what /version reports: build args, a build stamp, the deployed tag', () => {
    for (const kind of ['api', 'fullstack']) {
      const { dir } = scaffold(['--kind', kind, '--with', 'api,db', '--deploy', 'container'])
      const dockerfile = read(dir, kind === 'api' ? 'Dockerfile' : 'api/Dockerfile')
      expect(dockerfile, kind).toContain('RUN npm run build && date -u +%Y-%m-%dT%H:%M:%SZ > dist/build-time.txt')
      expect(dockerfile, kind).toMatch(/\nARG APP_COMMIT=\nARG APP_BUILT_AT=\nENV APP_COMMIT=\$\{APP_COMMIT\} APP_BUILT_AT=\$\{APP_BUILT_AT\}\n/)
      expect(read(dir, 'docker/docker-compose.yml'), kind).toMatch(/\n  api:\n(?:.*\n)*?    environment:\n      APP_IMAGE_TAG: \$\{API_TAG:-\}/)
      const api = kind === 'api' ? '' : 'api/'
      expect(read(dir, `${api}src/app.ts`)).toContain('build: buildInfo({ commit: config.APP_COMMIT, builtAt: config.APP_BUILT_AT, imageTag: config.APP_IMAGE_TAG }),')
      expect(read(dir, `${api}src/config.ts`)).toContain('APP_IMAGE_TAG: z.string().optional(),')
    }
    // an API without the standard has no /version, but its compose file is the same shape
    expect(read(scaffold(['--kind', 'api', '--deploy', 'container']).dir, 'docker/docker-compose.yml')).toContain('APP_IMAGE_TAG: ${API_TAG:-}')
  })

  it('without the db module nothing changes', () => {
    const { dir } = scaffold(['--kind', 'api', '--deploy', 'container'])
    expect(read(dir, 'docker/docker-compose.yml')).not.toContain('db-check')
    expect(read(dir, 'docker/env.example')).not.toContain('DATABASE_URL')
  })
})

describe('determinism, check and update with the modules', () => {
  it.each([
    [['--kind', 'api', '--with', 'api,db']],
    [['--kind', 'api', '--with', 'api,db', '--db', 'mysql', '--deploy', 'container']],
    [['--kind', 'fullstack', '--with', 'api,db', '--deploy', 'pm2']],
  ])('%j: the same inputs give byte-identical output, and a fresh project is clean', (args) => {
    const a = scaffold(args)
    const b = scaffold(args)
    expect(snapshot(b.dir)).toEqual(snapshot(a.dir))
    expect(cli(['check', a.dir, '--json']).json).toMatchObject({ clean: true })
  })

  it('an edited runtime file is drift; update restores it and leaves the app\'s own files alone', () => {
    const { dir } = scaffold(['--kind', 'api', '--with', 'api,db'])
    const before = snapshot(dir)
    writeFileSync(join(dir, 'src/kit/db/resilient.ts'), read(dir, 'src/kit/db/resilient.ts').replace('retries = 2', 'retries = 99'))
    writeFileSync(join(dir, 'src/resources/items/items.repo.ts'), read(dir, 'src/resources/items/items.repo.ts') + '\n// mine\n')
    expect(cli(['check', dir, '--json']).json.drift).toEqual([{ path: 'src/kit/db/resilient.ts', reason: 'modified' }])
    expect(cli(['update', dir, '--json']).json.updated).toEqual(['src/kit/db/resilient.ts'])
    const after = snapshot(dir)
    expect(Object.keys(after).filter((f) => after[f] !== before[f])).toEqual(['src/resources/items/items.repo.ts'])
  })

  it('a new kit version reaches projects through the locked kit-version file', () => {
    const kit = cloneKit('9.9.9')
    const { dir } = scaffold(['--kind', 'api', '--with', 'api,db'], { kit })
    const file = join(kit, 'runtime/api/kit-version.ts')
    writeFileSync(file, read(kit, 'runtime/api/kit-version.ts').replace(/KIT_VERSION = '[^']+'/, "KIT_VERSION = '9.9.10'"))
    expect(cli(['check', dir, '--json'], { kit }).json.drift).toEqual([{ path: 'src/kit/api/kit-version.ts', reason: 'outdated' }])
    cli(['update', dir, '--json'], { kit })
    expect(read(dir, 'src/kit/api/kit-version.ts')).toContain("KIT_VERSION = '9.9.10'")
  })
})

describe('`when` conditions of a unit (kit authoring)', () => {
  it('with / without / db select files, locked files and backup entries', () => {
    const kit = cloneKit()
    mkdirSync(join(kit, 'modules', 'probe', 'files'), { recursive: true })
    for (const name of ['with-db', 'without-db', 'on-mysql', 'always']) writeFileSync(join(kit, 'modules', 'probe', 'files', `${name}.txt`), name)
    writeFileSync(join(kit, 'modules', 'probe', 'module.json'), JSON.stringify({
      name: 'probe', status: 'ready', description: '', kinds: ['api'], requires: [],
      contributes: { api: {
        files: [
          { from: 'files/with-db.txt', to: 'probe/with-db.txt', when: { with: ['db'] } },
          { from: 'files/without-db.txt', to: 'probe/without-db.txt', when: { without: ['db', 'api'] } },
          { from: 'files/on-mysql.txt', to: 'probe/on-mysql.txt', when: { db: ['mysql'] } },
          { from: 'files/always.txt', to: 'probe/always.txt' },
        ],
        backup: [{ engine: 'files', path: 'uploads', when: { without: ['db'] } }],
      } },
    }))
    const probe = (args: string[]) => {
      const { dir, r } = scaffold(['--kind', 'api', ...args], { kit })
      return { files: ['with-db', 'without-db', 'on-mysql', 'always'].filter((n) => existsSync(join(dir, 'probe', `${n}.txt`))), backup: r.json.backup.map((b: any) => b.engine) }
    }
    expect(probe(['--with', 'probe'])).toEqual({ files: ['without-db', 'always'], backup: ['files'] })
    expect(probe(['--with', 'probe,db'])).toEqual({ files: ['with-db', 'always'], backup: ['sqlite'] })
    expect(probe(['--with', 'probe,db', '--db', 'mysql'])).toEqual({ files: ['with-db', 'on-mysql', 'always'], backup: ['mysql'] })
  })
})
