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
//   sample   false = scaffold with --no-sample (no `items` example)
//   lang     --lang value ('en'; the default th is what every other combo runs). Needs layer 'local' until the layer
//            release that knows `nuxtBase.lang` is tagged.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

// The committed contract is what the code generates (the template lives in kit/modules/{api,auth}/variants/).
async function contractCheck(t) {
  t.begin('contract: `npm run contract` reproduces the committed openapi.json byte for byte')
  const contract = join(t.apiDir, 'openapi.json')
  const before = sha(contract)
  await t.run('npm', ['run', 'contract'], { cwd: t.apiDir, timeout: 60_000 })
  if (sha(contract) !== before) t.fail(`openapi.json changed — the template in kit/modules/${t.plan.modules.includes('auth') ? 'auth' : 'api'}/variants/openapi.json is behind the code`)
  return contract
}

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

  const contract = await contractCheck(t)

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
    // the trace id is the server's own: a client is not trusted to choose it (TRUST_TRACEPARENT is off by default)
    if (created.status !== 201 || !/^[0-9a-f]{32}$/.test(created.traceId ?? '') || created.traceId === 'ab'.repeat(16)) t.fail(`create: ${created.status} trace ${created.traceId}`)
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
  if (sha(file) !== before) t.fail(`schema.d.ts changed — the template in kit/modules/${t.plan.modules.includes('auth') ? 'auth' : 'api'}/variants/schema.d.ts is behind the contract`)
}

// An OTLP/HTTP collector inside the gate process: what the built API exports its spans to.
async function fakeCollector() {
  const spans = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        for (const r of JSON.parse(Buffer.concat(chunks).toString('utf8')).resourceSpans ?? []) for (const s of r.scopeSpans ?? []) spans.push(...(s.spans ?? []))
      } catch { /* not JSON: ignored, the check below fails on the missing span */ }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, spans, close: () => new Promise((resolve) => server.close(resolve)) }
}

// Every module of task E on the BUILT app, over real HTTP with NODE_ENV=production: auth (who is believed, roles,
// service tokens, dev mode refused), security headers / CORS / limits, tracing into a collector, link previews —
// then the three playbook generators on the same project, which must leave it green and working.
async function fullModules(t) {
  const node = process.execPath
  const cwd = t.apiDir
  const p = t.port + 5
  const base = `http://127.0.0.1:${p}`
  const SECRET = 'gate-proxy-secret-0123456789'
  const prod = { PORT: String(p), HOST: '127.0.0.1', NODE_ENV: 'production', ...t.dbEnv }
  const cli = (script, args, opts = {}) => t.run(node, [script, ...args], { cwd, timeout: 60_000, extraEnv: { ...t.dbEnv, ...(opts.env ?? {}) }, expect: opts.expect ?? 0 })
  const call = async (path, init = {}) => {
    const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(5000) })
    const text = await res.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    return { status: res.status, headers: res.headers, traceId: res.headers.get('x-trace-id'), body }
  }
  const proxied = (username, groups) => ({ 'x-auth-proxy-secret': SECRET, 'x-authentik-username': username, 'x-authentik-uid': `uid-${username}`, 'x-authentik-groups': groups })
  const post = (headers, body) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

  await contractCheck(t)
  if (t.uiDir) await typedClient(t)

  t.begin('db: migrate up + seed (built CLI)')
  await cli('dist/db/cli.js', ['migrate', 'up'])
  await cli('dist/db/cli.js', ['seed'])

  t.begin('auth: AUTH_DEV_MODE=1 with NODE_ENV=production refuses to start, and says why')
  const refused = await t.run(node, ['dist/index.js'], { cwd, timeout: 20_000, extraEnv: { ...prod, AUTH_DEV_MODE: '1' }, expect: 1 })
  if (!/AUTH_DEV_MODE.*refusing to start/.test(refused.out)) t.fail('dev mode in production did not stop the boot with a clear message')
  const wildcard = await t.run(node, ['dist/index.js'], { cwd, timeout: 20_000, extraEnv: { ...prod, CORS_ORIGINS: '*' }, expect: 1 })
  if (!/CORS_ORIGINS: wildcards are not allowed/.test(wildcard.out)) t.fail('a wildcard CORS origin did not stop the boot')

  t.begin('auth: create a service token with the built CLI (shown once)')
  const created = await cli('dist/auth/cli.js', ['token', 'create', '--name', 'gate-bot', '--roles', 'editor', '--days', '1'])
  const token = /^token: (\S+)$/m.exec(created.out)?.[1]
  if (!token) t.fail('token create did not print a token')
  const listed = await cli('dist/auth/cli.js', ['token', 'list'])
  if (!/active\s+name=gate-bot/.test(listed.out) || listed.out.includes(token)) t.fail('token list is wrong, or shows the token')
  // a token without roles: authenticated, read-only (finding #5)
  const readerToken = /^token: (\S+)$/m.exec((await cli('dist/auth/cli.js', ['token', 'create', '--name', 'gate-reader', '--days', '1'])).out)?.[1]
  if (!readerToken) t.fail('token create without --roles did not print a token')

  const collector = await fakeCollector()
  const env = {
    ...prod,
    AUTH_PROXY_SECRET: SECRET,
    AUTH_ROLE_MAP: JSON.stringify({ 'app-admins': ['admin'], 'app-editors': ['editor'] }),
    CORS_ORIGINS: 'https://app.example.com',
    BODY_LIMIT_BYTES: '1000',
    OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
    LOG_LEVEL: 'info',
  }
  let traced
  try {
    t.begin('auth + security + trace over real HTTP (production)')
    const exit = await t.withServer(node, ['dist/index.js'], { cwd, extraEnv: env }, async () => {
      await t.waitFor(`${base}/health/live`)
      // who is believed
      const anonymous = await call('/api/v1/items')
      if (anonymous.status !== 401 || anonymous.body.error.code !== 'UNAUTHORIZED' || anonymous.body.error.traceId !== anonymous.traceId) t.fail(`anonymous: ${anonymous.status} ${JSON.stringify(anonymous.body)}`)
      const { 'x-auth-proxy-secret': _secret, ...spoofed } = proxied('mallory', 'app-admins')
      for (const headers of [spoofed, { ...spoofed, 'x-auth-proxy-secret': 'guess' }]) {
        const res = await call('/api/v1/me', { headers })
        if (res.status !== 401) t.fail(`spoofed identity headers were accepted: ${res.status} ${JSON.stringify(res.body)}`)
      }
      const admin = await call('/api/v1/me', { headers: proxied('alice', 'app-admins') })
      if (admin.status !== 200 || admin.body.data.subject !== 'uid-alice' || admin.body.data.roles.join() !== 'admin') t.fail(`/me through the proxy: ${admin.status} ${JSON.stringify(admin.body)}`)
      // role x endpoint
      const viewer = proxied('carol', 'nobody')
      const editor = proxied('erin', 'app-editors')
      const made = await call('/api/v1/items', post(editor, { name: 'From the gate' }))
      if (made.status !== 201) t.fail(`editor create: ${made.status} ${JSON.stringify(made.body)}`)
      traced = made.traceId
      const matrix = [
        [await call('/api/v1/items', { headers: viewer }), 200],
        [await call('/api/v1/items', post(viewer, { name: 'x' })), 403],
        [await call(`/api/v1/items/${made.body.data.id}`, { method: 'DELETE', headers: editor }), 403],
        [await call(`/api/v1/items/${made.body.data.id}`, { method: 'DELETE', headers: proxied('alice', 'app-admins') }), 204],
      ]
      matrix.forEach(([res, want], i) => { if (res.status !== want) t.fail(`role matrix row ${i}: ${res.status}, expected ${want}`) })
      // service token
      const bearer = { authorization: `Bearer ${token}` }
      const me = await call('/api/v1/me', { headers: bearer })
      if (me.status !== 200 || me.body.data.kind !== 'service' || me.body.data.roles.join() !== 'editor') t.fail(`/me with a service token: ${me.status} ${JSON.stringify(me.body)}`)
      if ((await call('/api/v1/items', post(bearer, { name: 'By the token' }))).status !== 201) t.fail('the service token could not create an item')
      if ((await call('/api/v1/me', { headers: { authorization: `Bearer ${token.slice(0, -2)}xx` } })).status !== 401) t.fail('a tampered token was accepted')
      const reader = { authorization: `Bearer ${readerToken}` }
      const readerMe = await call('/api/v1/me', { headers: reader })
      if (readerMe.status !== 200 || readerMe.body.data.kind !== 'service' || readerMe.body.data.roles.length !== 0) t.fail(`/me with a role-less token: ${readerMe.status} ${JSON.stringify(readerMe.body)}`)
      if ((await call('/api/v1/items', { headers: reader })).status !== 200) t.fail('the role-less token could not read')
      if ((await call('/api/v1/items', post(reader, { name: 'By the reader' }))).status !== 403) t.fail('the role-less token could write')
      // security baseline
      const h = (await call('/health/live')).headers
      if (h.get('x-content-type-options') !== 'nosniff' || h.get('x-frame-options') !== 'DENY' || !/default-src 'none'/.test(h.get('content-security-policy') ?? '')) t.fail('secure headers are missing on /health/live')
      const allowed = await call('/api/v1/items', { headers: { ...viewer, origin: 'https://app.example.com' } })
      const foreign = await call('/api/v1/items', { headers: { ...viewer, origin: 'https://evil.example.com' } })
      if (allowed.headers.get('access-control-allow-origin') !== 'https://app.example.com' || foreign.headers.get('access-control-allow-origin') !== null) t.fail('CORS allowlist is wrong')
      const big = await call('/api/v1/items', post(editor, { name: 'big', description: 'x'.repeat(1500) }))
      if (big.status !== 413 || big.body.error.code !== 'VALIDATION') t.fail(`body limit: ${big.status}`)
    })
    if (exit.code !== 0) t.fail(`api did not shut down gracefully (code ${exit.code}, signal ${exit.signal})`)

    t.begin('trace: the span reached the collector with the trace id of the response and of the log line')
    // spans are flushed on SIGTERM
    const span = collector.spans.find((s) => s.traceId === traced)
    if (!span || span.name !== 'POST /api/v1/items') t.fail(`no span for trace ${traced} (collector has ${collector.spans.length}: ${collector.spans.map((s) => s.name).join(', ')})`)
    const logged = readFileSync(join(t.tmp, 'gate.log'), 'utf8').split('\n').filter((line) => line.startsWith('{') && line.includes(traced)).map((line) => JSON.parse(line))
    if (!logged.some((l) => l.msg === 'request' && l.traceId === traced && l.status === 201)) t.fail(`no request log line with traceId ${traced}`)
    if (!logged.every((l) => l.service === 'gate-app' && l.env === 'production')) t.fail('log lines are missing service / env')
  } finally {
    await collector.close()
  }

  t.begin('auth: revoke the token -> 401 at once')
  await cli('dist/auth/cli.js', ['token', 'revoke', 'gate-bot'])
  await t.withServer(node, ['dist/index.js'], { cwd, extraEnv: { ...prod, AUTH_PROXY_SECRET: SECRET } }, async () => {
    await t.waitFor(`${base}/health/live`)
    const res = await call('/api/v1/me', { headers: { authorization: `Bearer ${token}` } })
    if (res.status !== 401) t.fail(`a revoked token still works: ${res.status}`)
  })

  // --- playbooks: one generator command each, then the project must still be green ------------------------------------
  t.begin('playbooks: copied into the project')
  for (const name of ['add-resource', 'add-job', ...(t.uiDir ? ['add-page'] : [])]) {
    if (!existsSync(join(t.dir, `.memory/docs/guides/playbook-${name}.md`))) t.fail(`playbook-${name}.md is not in the project`)
  }
  t.begin('playbook add-resource: scaffold add resource order-lines')
  const resource = JSON.parse((await t.scaffold(['add', 'resource', 'order-lines', '--dir', t.dir, '--json'])).out)
  t.begin('playbook add-job: scaffold add job nightly-sync')
  await t.scaffold(['add', 'job', 'nightly-sync', '--dir', t.dir, '--json'])
  if (t.uiDir) {
    t.begin('playbook add-page: scaffold add page reports')
    await t.scaffold(['add', 'page', 'reports', '--dir', t.dir, '--json'])
  }
  t.begin('playbooks: the contract test is red until the contract is regenerated')
  const red = await t.run('npm', ['run', 'test'], { cwd, timeout: 300_000, expect: 1 })
  if (!/openapi\.json matches the routes in the code/.test(red.out)) t.fail('the stale contract was not the failing test')
  t.begin('playbooks: npm run contract (+ npm run client)')
  await t.run('npm', ['run', 'contract'], { cwd, timeout: 60_000 })
  if (t.uiDir) await t.run('npm', ['run', 'client'], { cwd: t.uiDir, timeout: 120_000 })
  t.begin('playbooks: npm run gate is green')
  await t.run('npm', ['run', 'gate'], { timeout: 600_000 })
  t.begin('playbooks: npm run build is green')
  await t.run('npm', ['run', 'build'], { timeout: 600_000 })
  t.begin('playbooks: scaffold check is still clean (generators touch no locked file)')
  await t.scaffold(['check', t.dir, '--json'])

  t.begin('playbooks: the new resource works on the built app; the new job runs, is listed, and exits with the contract codes')
  const migrated = await cli('dist/db/cli.js', ['migrate', 'up'])
  if (!/schema ok \(0003_order_lines\)/.test(migrated.out)) t.fail('migrate up did not end with "schema ok (0003_order_lines)"')
  await t.withServer(node, ['dist/index.js'], { cwd, extraEnv: { ...prod, AUTH_PROXY_SECRET: SECRET, AUTH_ROLE_MAP: JSON.stringify({ 'app-editors': ['editor'] }) } }, async () => {
    await t.waitFor(`${base}/health/ready`)
    const editor = proxied('erin', 'app-editors')
    if ((await call('/api/v1/order-lines')).status !== 401) t.fail('the generated resource is reachable without auth')
    const made = await call('/api/v1/order-lines', post(editor, { name: 'Line 1' }))
    const list = await call('/api/v1/order-lines', { headers: editor })
    if (made.status !== 201 || list.status !== 200 || list.body.meta.total !== 1) t.fail(`generated resource: create ${made.status}, list ${list.status} ${JSON.stringify(list.body)}`)
    const doc = await call('/openapi.json')
    if (!doc.body.paths['/api/v1/order-lines/{id}']) t.fail('/openapi.json does not document the generated resource')
  })
  const lockEnv = { env: { JOB_LOCK_DIR: join(t.tmp, 'locks') } }
  const ran = await cli('dist/jobs/run.js', ['nightly-sync'], lockEnv)
  const lines = ran.out.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
  const end = lines.find((l) => l.msg === 'job end')
  if (!lines.some((l) => l.msg === 'job start') || end?.status !== 'ok' || end.job !== 'nightly-sync' || end.changed !== 0 || !end.traceId) t.fail(`job output: ${ran.out}`)
  if (!/nightly-sync/.test((await cli('dist/jobs/run.js', ['--list'], lockEnv)).out)) t.fail('job --list does not show the job')
  await cli('dist/jobs/run.js', ['no-such-job'], { ...lockEnv, expect: 2 })
  if (!existsSync(join(t.dir, '.memory/docs/guides/job-nightly-sync.md'))) t.fail('the scheduler registration doc was not generated')
  if (resource.files.length < 5) t.fail('add resource generated fewer files than expected')

  if (t.uiDir && !t.noE2e) {
    t.begin('playbooks: the UI e2e suite (generated pages, link previews for crawlers) on the rebuilt app')
    await t.run('npx', ['playwright', 'test'], { cwd: t.uiDir, timeout: 300_000, extraEnv: { E2E_PORT: String(t.port + 2) } })
  }
}

// A project created with --no-sample: nothing of the `items` example exists — not in the contract, not in the
// database, not over HTTP — and the first resource is added with the generator, after which everything is green.
async function noSample(t) {
  const node = process.execPath
  const cwd = t.apiDir
  const p = t.port + 5
  const base = `http://127.0.0.1:${p}`
  const SECRET = 'gate-proxy-secret-0123456789'
  const auth = t.plan.modules.includes('auth')
  const prod = { PORT: String(p), HOST: '127.0.0.1', NODE_ENV: 'production', ...t.dbEnv, ...(auth ? { AUTH_PROXY_SECRET: SECRET, AUTH_ROLE_MAP: JSON.stringify({ 'app-admins': ['admin'] }) } : {}) }
  const admin = auth ? { 'x-auth-proxy-secret': SECRET, 'x-authentik-username': 'alice', 'x-authentik-uid': 'uid-alice', 'x-authentik-groups': 'app-admins' } : {}
  const cli = (args, opts = {}) => t.run(node, ['dist/db/cli.js', ...args], { cwd, timeout: 60_000, extraEnv: { ...t.dbEnv }, expect: opts.expect ?? 0 })
  const call = async (path, init = {}) => {
    const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(5000) })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  const serve = (probe) => t.withServer(node, ['dist/index.js'], { cwd, extraEnv: prod }, async () => { await t.waitFor(`${base}/health/live`); await probe() })

  t.begin('no-sample: the project says so, and has no file of the example')
  if (t.plan.sample !== false) t.fail(`new --json reported sample: ${t.plan.sample}`)
  const leftovers = t.plan.files.filter((file) => /items/.test(file))
  if (leftovers.length) t.fail(`files of the example were generated: ${leftovers.join(', ')}`)
  if (auth && !/ROLES = \['admin'\] as const/.test(readFileSync(join(cwd, 'src/auth/roles.ts'), 'utf8'))) t.fail('roles.ts still has the example role')

  await contractCheck(t)
  if (t.uiDir) await typedClient(t)

  t.begin('no-sample: migrate up ends at 0001_base, seed is a no-op that succeeds twice')
  const up = await cli(['migrate', 'up'])
  if (!/schema ok \(0001_base\)/.test(up.out)) t.fail('migrate up did not end with "schema ok (0001_base)"')
  await cli(['seed'])
  await cli(['seed'])

  t.begin('no-sample: over HTTP there is no /api/v1/items and the contract does not document it')
  await serve(async () => {
    const ready = await call('/health/ready')
    if (ready.status !== 200) t.fail(`/health/ready: ${ready.status} ${JSON.stringify(ready.body)}`)
    for (const headers of [{}, admin]) {
      const res = await call('/api/v1/items', { headers })
      if (res.status !== 404 || res.body.error.code !== 'NOT_FOUND') t.fail(`/api/v1/items answered ${res.status} ${JSON.stringify(res.body)}`)
    }
    const doc = await call('/openapi.json')
    const resources = Object.keys(doc.body.paths).filter((path) => path.startsWith('/api/v1/') && path !== '/api/v1/me')
    if (resources.length) t.fail(`the contract documents resources: ${resources.join(', ')}`)
    if (auth) {
      const me = await call('/api/v1/me', { headers: admin })
      if (me.status !== 200 || me.body.data.roles.join() !== 'admin') t.fail(`/me through the proxy: ${me.status} ${JSON.stringify(me.body)}`)
    }
  })

  t.begin('no-sample: scaffold add resource orders -> contract (+ client) -> gate + build green')
  const added = JSON.parse((await t.scaffold(['add', 'resource', 'orders', '--dir', t.dir, '--json'])).out)
  if (!added.files.some((file) => file.endsWith('src/db/migrations/0002_orders.ts'))) t.fail(`the first resource is not migration 0002: ${added.files.join(', ')}`)
  await t.run('npm', ['run', 'contract'], { cwd, timeout: 60_000 })
  if (t.uiDir) await t.run('npm', ['run', 'client'], { cwd: t.uiDir, timeout: 120_000 })
  await t.run('npm', ['run', 'gate'], { timeout: 600_000 })
  await t.run('npm', ['run', 'build'], { timeout: 600_000 })
  await t.scaffold(['check', t.dir, '--json'])

  t.begin('no-sample: the first resource works on the built app (admin writes; without auth anyone)')
  const migrated = await cli(['migrate', 'up'])
  if (!/schema ok \(0002_orders\)/.test(migrated.out)) t.fail('migrate up did not end with "schema ok (0002_orders)"')
  await serve(async () => {
    if (auth && (await call('/api/v1/orders')).status !== 401) t.fail('the generated resource is reachable without auth')
    const made = await call('/api/v1/orders', { method: 'POST', headers: { 'content-type': 'application/json', ...admin }, body: JSON.stringify({ name: 'Order 1' }) })
    const list = await call('/api/v1/orders', { headers: admin })
    if (made.status !== 201 || list.status !== 200 || list.body.meta.total !== 1) t.fail(`generated resource: create ${made.status}, list ${list.status} ${JSON.stringify(list.body)}`)
  })

  if (t.uiDir && !t.noE2e) {
    t.begin('no-sample: the UI e2e suite (with the generated pages) on the rebuilt app')
    await t.run('npx', ['playwright', 'test'], { cwd: t.uiDir, timeout: 300_000, extraEnv: { E2E_PORT: String(t.port + 2) } })
  }
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
  // the fullstack compose file for real: db-check gate, the API without a host port, health and API calls through the UI
  { id: 'fullstack+std+container', kind: 'fullstack', with: ['api', 'db'], db: 'sqlite', deploy: 'container', layer: 'tag' },
  // task E: every module, then the playbook generators on the generated project
  { id: 'fullstack+full', kind: 'fullstack', with: ['db', 'auth', 'api', 'trace', 'og', 'security', 'jobs', 'notify'], e2e: true, checks: [fullModules] },
  { id: 'api+full+container', kind: 'api', with: ['auth', 'trace', 'security', 'jobs', 'notify'], db: 'sqlite', deploy: 'container', checks: [fullModules] },
  // --no-sample: no `items` example anywhere; the first resource comes from the generator
  // …in English (--lang en): the e2e suite asserts the generated pages AND the layer's labels are English
  { id: 'fullstack+auth+no-sample+en', kind: 'fullstack', with: ['db', 'auth', 'api', 'og'], sample: false, lang: 'en', e2e: true, checks: [noSample] },
  { id: 'api+no-sample', kind: 'api', with: ['api', 'db'], sample: false, checks: [noSample] },
  // link previews on Cloudflare Pages: the e2e suite runs against wrangler's local Pages runtime, with crawler user agents
  { id: 'nuxt-app+og+auth+cf-pages', kind: 'nuxt-app', with: ['og', 'auth'], deploy: 'cf-pages', e2e: true },
]
