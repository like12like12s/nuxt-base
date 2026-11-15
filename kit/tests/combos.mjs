// What `npm run gate:kit` proves: every entry is scaffolded into a fresh temp dir, installed, gated and built.
// Tasks that add modules append entries here (e.g. { id: 'fullstack+db+auth', kind: 'fullstack', with: ['db', 'auth'] }).
//
//   id       unique label, shown in every failure line
//   kind     nuxt-app | api | fullstack
//   with     modules (--with)             db      --db value            deploy   --deploy value
//   e2e      also run the UI's playwright suite against the built app
//   layer    'local' (default) = the UI extends this working tree, so the layer and the kit are tested together
//            'tag'   = the UI extends the latest git tag from GitHub — required when the image is built by docker
//   checks   extra async (t) => {} steps; `t` is the helper object documented in kit-gate.mjs
//   db       with the db module: 'mysql' also runs the project's suite + built CLI on MySQL (kit-gate.mjs provides the server)
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

// The API standard + data layer, on the BUILT app (dist/, plain node): what `npm run gate` cannot show.
// t.dbEnv.DATABASE_URL is a scratch SQLite file, or a `test_gate_*` MySQL schema for the mysql flavour.
async function apiStandard(t) {
  const node = process.execPath
  const cwd = t.apiDir
  const cli = (args, opts = {}) => t.run(node, ['dist/db/cli.js', ...args], { cwd, timeout: 60_000, extraEnv: { ...t.dbEnv, ...(opts.env ?? {}) }, expect: opts.expect ?? 0 })
  const p = t.port + 5
  const base = `http://127.0.0.1:${p}`
  const json = async (path, init) => {
    const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(5000) })
    const text = await res.text()
    return { status: res.status, traceId: res.headers.get('x-trace-id'), body: text ? JSON.parse(text) : null }
  }
  const serve = (probe) => t.withServer(node, ['dist/index.js'], { cwd, extraEnv: { PORT: String(p), HOST: '127.0.0.1', NODE_ENV: 'production', ...t.dbEnv } }, async () => {
    await t.waitFor(`${base}/health/live`)
    await probe()
  })

  t.begin('contract: `npm run contract` reproduces the committed openapi.json byte for byte')
  const contract = join(cwd, 'openapi.json')
  const before = sha(contract)
  await t.run('npm', ['run', 'contract'], { cwd, timeout: 60_000 })
  if (sha(contract) !== before) t.fail('openapi.json changed — the template in kit/modules/api/files/openapi.json is behind the code')

  t.begin('db: check fails on an unmigrated database; the API boots but /health/ready is 503 naming the schema check')
  const behind = await cli(['check'], { expect: 1 })
  if (!/schema behind: 2 pending/.test(behind.out)) t.fail('db check did not report "schema behind: 2 pending"')
  await serve(async () => {
    const ready = await json('/health/ready')
    const failing = ready.body?.error?.details?.filter((c) => c.status === 'fail').map((c) => c.name).join(',')
    if (ready.status !== 503 || ready.body.error.code !== 'INTERNAL' || failing !== 'schema' || ready.body.error.traceId !== ready.traceId) t.fail(`/health/ready on an unmigrated database: ${ready.status} ${JSON.stringify(ready.body)}`)
  })

  t.begin('db: migrate up -> check ok -> seed twice = the same rows')
  const up = await cli(['migrate', 'up'])
  if (!/schema ok \(0002_items\)/.test(up.out)) t.fail('migrate up did not end with "schema ok (0002_items)"')
  await cli(['check'])
  await cli(['seed'])
  await cli(['seed'])

  t.begin('api: ready 200, /version, list + create + soft delete, error shape and trace id — and a clean shutdown')
  const exit = await serve(async () => {
    const ready = await json('/health/ready')
    if (ready.status !== 200 || ready.body.checks.some((c) => c.status !== 'ok')) t.fail(`/health/ready: ${ready.status} ${JSON.stringify(ready.body)}`)
    const version = await json('/version')
    if (version.body.name !== 'gate-app' || !version.body.kit) t.fail(`/version: ${JSON.stringify(version.body)}`)
    const seeded = await json('/api/v1/items?sort=name')
    if (seeded.status !== 200 || seeded.body.meta.total !== 2 || seeded.body.meta.limit !== 50) t.fail(`seeded list: ${JSON.stringify(seeded.body)}`)
    const created = await json('/api/v1/items', { method: 'POST', headers: { 'content-type': 'application/json', traceparent: `00-${'ab'.repeat(16)}-${'cd'.repeat(8)}-01` }, body: JSON.stringify({ name: 'From the gate', quantity: 3 }) })
    if (created.status !== 201 || created.traceId !== 'ab'.repeat(16)) t.fail(`create: ${created.status} trace ${created.traceId}`)
    const gone = await json(`/api/v1/items/${created.body.data.id}`, { method: 'DELETE' })
    const after = await json(`/api/v1/items/${created.body.data.id}`)
    if (gone.status !== 204 || after.status !== 404) t.fail(`soft delete: ${gone.status} then ${after.status}`)
    for (const [path, status, code] of [['/api/v1/items?limit=201', 400, 'VALIDATION'], ['/api/v1/items/nope', 404, 'NOT_FOUND'], ['/nope', 404, 'NOT_FOUND']]) {
      const res = await json(path)
      const keys = Object.keys(res.body.error).filter((k) => k !== 'details').sort().join(',')
      if (res.status !== status || res.body.error.code !== code || keys !== 'code,message,traceId' || res.body.error.traceId !== res.traceId) t.fail(`${path}: ${res.status} ${JSON.stringify(res.body)}`)
    }
    const doc = await json('/openapi.json')
    if (JSON.stringify(doc.body) !== JSON.stringify(JSON.parse(readFileSync(contract, 'utf8')))) t.fail('/openapi.json differs from the committed openapi.json')
  })
  if (exit.code !== 0) t.fail(`api with a database did not shut down gracefully (code ${exit.code}, signal ${exit.signal})`)

  t.begin('db: a second seed + a status listing after real traffic; migrate down needs a backup')
  const status = await cli(['migrate', 'status'])
  if (!/applied {2}0001_base[\s\S]*applied {2}0002_items/.test(status.out)) t.fail('migrate status did not list both migrations as applied')
  if (t.onMysql) {
    const refused = await cli(['migrate', 'down'], { expect: 3 })
    if (!/REFUSED: no backup before migrating MySQL/.test(refused.out)) t.fail('migrate down on MySQL without DB_BACKUP_CMD was not refused')
    await cli(['check'])
    const hooked = await cli(['migrate', 'down'], { env: { DB_BACKUP_CMD: 'true' } })
    if (!/backup: DB_BACKUP_CMD ok[\s\S]*down 0002_items/.test(hooked.out)) t.fail('migrate down with a backup hook did not run')
  } else {
    const down = await cli(['migrate', 'down'])
    if (!/backup: .*\.bak[\s\S]*down 0002_items/.test(down.out)) t.fail('migrate down on SQLite did not copy the database first')
  }
  await cli(['check'], { expect: 1 })
  await cli(['migrate', 'up', '--no-backup'])
}

// fullstack: the committed typed client is what the generator produces from the committed contract.
async function typedClient(t) {
  t.begin('ui: `npm run client` reproduces the committed app/api/schema.d.ts byte for byte')
  const file = join(t.uiDir, 'app/api/schema.d.ts')
  const before = sha(file)
  await t.run('npm', ['run', 'client'], { cwd: t.uiDir, timeout: 120_000 })
  if (sha(file) !== before) t.fail('schema.d.ts changed — the template in kit/modules/api/files-ui/app/api/schema.d.ts is behind the contract')
}

export const combos = [
  { id: 'nuxt-app', kind: 'nuxt-app', e2e: true },
  { id: 'nuxt-app+cf-pages', kind: 'nuxt-app', deploy: 'cf-pages' },
  { id: 'nuxt-app+container', kind: 'nuxt-app', deploy: 'container', layer: 'tag' },
  { id: 'nuxt-app+pm2', kind: 'nuxt-app', deploy: 'pm2' },
  { id: 'api', kind: 'api', with: ['ci-github'] },
  { id: 'api+container', kind: 'api', deploy: 'container' },
  { id: 'api+pm2', kind: 'api', deploy: 'pm2' },
  { id: 'fullstack', kind: 'fullstack' },
  { id: 'fullstack+container', kind: 'fullstack', deploy: 'container', layer: 'tag' },
  { id: 'fullstack+pm2', kind: 'fullstack', deploy: 'pm2' },
  // api + db modules (they bring the test kit): the standard on SQLite, on MySQL, in an image, and with a UI
  { id: 'api+std-sqlite', kind: 'api', with: ['api', 'db'], db: 'sqlite', checks: [apiStandard] },
  { id: 'api+std-mysql', kind: 'api', with: ['api', 'db'], db: 'mysql', checks: [apiStandard] },
  { id: 'api+std+container', kind: 'api', with: ['api', 'db'], db: 'sqlite', deploy: 'container' },
  { id: 'fullstack+std', kind: 'fullstack', with: ['api', 'db'], e2e: true, checks: [apiStandard, typedClient] },
]
