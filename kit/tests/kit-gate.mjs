#!/usr/bin/env node
// Kit gate (`npm run gate:kit`): for every combo in combos.mjs — scaffold into a fresh temp dir, `npm install`,
// `npm run gate`, build, then prove the result runs (boot + health, env fail-fast, check/update, pm2 file, image build).
// With gitleaks installed, every project is also committed first and that commit must pass the secret scan.
// Projects with the db module also run their suite and their built CLI against MySQL: TEST_MYSQL_URL if set
// (mysql://<user>:<password>@<host>:3306, a user that may create `test_*` schemas), else a throwaway mysql container
// when docker is available, else a loud NOTICE … SKIPPED. The data-layer unit tests of the kit run there too.
// Slow by design (installs, builds); the fast unit tests of the generator live in kit/tests/*.spec.ts (`npm run gate`).
//
//   node kit/tests/kit-gate.mjs [--only <text>] [--concurrency N] [--keep] [--no-docker] [--no-e2e] [--no-audit] [--port-base N] [--layer-ref <ref>] [--list]
//
// Re-runnable: every run uses new temp dirs and removes them (and any image / container it created) on exit, also
// after a failure or Ctrl-C. `--keep` leaves the dirs for inspection. Starts nothing outside its own child processes.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { combos } from './combos.mjs'

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(KIT, '..')
const BIN = join(KIT, 'bin', 'scaffold.mjs')
const { values: flags } = parseArgs({
  options: {
    only: { type: 'string' }, concurrency: { type: 'string' }, keep: { type: 'boolean' }, 'no-docker': { type: 'boolean' },
    'no-e2e': { type: 'boolean' }, 'no-audit': { type: 'boolean' }, 'port-base': { type: 'string' }, 'layer-ref': { type: 'string' }, list: { type: 'boolean' },
  },
})

// Child processes get a clean npm environment: when this runs under `npm run`, npm_* variables of THIS repo would leak in.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_|^INIT_CWD$|^NODE_ENV$|^AI_KIT_DIR$|^PORT$|^HOST$|^DATABASE_URL$|^TEST_MYSQL_URL$|^DB_/.test(k)))
env.CI = '1'
env.NUXT_TELEMETRY_DISABLED = '1'

// One extra job besides the combos: the kit's own data-layer / test-kit unit tests against MySQL.
const RUNTIME_ON_MYSQL = { id: 'kit-runtime@mysql', kind: 'kit', runtime: true }
const selected = [...combos, RUNTIME_ON_MYSQL].filter((c) => !flags.only || c.id.includes(flags.only))
if (flags.list) { for (const c of selected) console.log(c.id); process.exit(0) }
if (!selected.length) { console.error(`kit gate: no combo matches --only ${flags.only}`); process.exit(2) }

const gitleaks = !spawnSync('gitleaks', ['version'], { stdio: 'ignore', timeout: 15_000 }).error
const docker = !flags['no-docker'] && spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 }).status === 0
const latestTag = spawnSync('git', ['-C', REPO, 'describe', '--tags', '--abbrev=0'], { encoding: 'utf8' }).stdout.trim()
const tagRef = flags['layer-ref'] ?? (latestTag ? `github:like12like12s/nuxt-base#${latestTag}` : null)
const localRef = flags['layer-ref'] ?? REPO

// Ports: every combo gets a block of 10 above a base that differs per run (derived from the pid), so two gate runs on
// one machine — two checkouts, two sessions — do not answer each other's probes. --port-base pins it.
const PORT_BASE = Number(flags['port-base']) || 30000 + (process.pid % 140) * 250
if (!Number.isInteger(PORT_BASE) || PORT_BASE < 1024 || PORT_BASE > 65000) { console.error('kit gate: --port-base must be a port between 1024 and 65000'); process.exit(2) }

const dirs = new Set()
const schemas = new Set() // `test_gate_*` schemas created on the MySQL server — dropped after each combo and on exit
let mysqlUrl = null
// `only` = the schema of one finished combo (others may still be running); without it, everything left at exit.
async function dropSchemas(only) {
  if (!mysqlUrl) return
  const names = [...schemas].filter((name) => /^test_gate_\d+_\d+$/.test(name) && (!only || name === only))
  if (!names.length) return
  for (const name of names) schemas.delete(name)
  await mysqlAdmin(mysqlUrl, names.map((name) => `DROP DATABASE IF EXISTS \`${name}\``)).catch((e) => console.error(`could not drop ${names.join(', ')}: ${e.message}`))
}
const children = new Set()
const images = new Set()
const containers = new Set()
const composeProjects = new Map() // compose project name -> dir of its compose file
function cleanupAll() {
  for (const child of children) try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
  for (const [project, cwd] of composeProjects) spawnSync('docker', ['compose', '-p', project, '-f', 'docker-compose.yml', 'down', '-v', '--remove-orphans'], { cwd, stdio: 'ignore' })
  for (const id of containers) spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' })
  for (const tag of images) spawnSync('docker', ['rmi', '-f', tag], { stdio: 'ignore' })
  if (!flags.keep) for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanupAll(); process.exit(130) })

class StepError extends Error {}

// A MySQL server for the combos that need one. Returns a server URL (no database) or null.
async function provideMysql() {
  if (!selected.some((c) => c.runtime || c.db === 'mysql')) return null
  if (process.env.TEST_MYSQL_URL) return process.env.TEST_MYSQL_URL
  if (!docker) return null
  const password = randomBytes(12).toString('hex')
  const started = spawnSync('docker', ['run', '-d', '--rm', '-e', `MYSQL_ROOT_PASSWORD=${password}`, '--tmpfs', '/var/lib/mysql:rw,size=1g', '-p', '127.0.0.1::3306', 'mysql:8.4'], { encoding: 'utf8', timeout: 300_000 })
  if (started.status !== 0) { console.log(`NOTICE could not start a mysql:8.4 container (${(started.stderr || '').trim().split('\n').pop()})`); return null }
  const cid = started.stdout.trim()
  containers.add(cid)
  const port = spawnSync('docker', ['port', cid, '3306/tcp'], { encoding: 'utf8' }).stdout.trim().split('\n')[0].split(':').pop()
  const url = `mysql://root:${password}@127.0.0.1:${port}`
  const { createConnection } = await import('mysql2/promise')
  for (const end = Date.now() + 120_000; Date.now() < end; ) {
    try {
      const c = await createConnection({ host: '127.0.0.1', port: Number(port), user: 'root', password, connectTimeout: 2000 })
      await c.query('select 1')
      await c.end()
      return url
    } catch { await new Promise((r) => setTimeout(r, 1000)) }
  }
  console.log('NOTICE the mysql container did not become ready in 120 s')
  return null
}

// Run statements on the MySQL server (schema management of the gate itself — only ever `test_gate_*` schemas).
async function mysqlAdmin(serverUrl, statements) {
  const { createConnection } = await import('mysql2/promise')
  const u = new URL(serverUrl)
  const c = await createConnection({ host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), connectTimeout: 5000 })
  try { for (const statement of statements) await c.query(statement) } finally { await c.end() }
}

// Run a command to completion in its own process group (so a timeout kills the whole tree — only PIDs started here).
function run(log, cmd, args, { cwd, timeout = 300_000, extraEnv = {}, expect = 0 } = {}) {
  return new Promise((done, fail) => {
    appendFileSync(log, `\n$ ${cmd} ${args.join(' ')}   (cwd ${cwd})\n`)
    const child = spawn(cmd, args, { cwd, env: { ...env, ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let out = ''
    const onData = (d) => { out += d; appendFileSync(log, d) }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }, timeout)
    child.on('error', (e) => { clearTimeout(timer); children.delete(child); fail(new StepError(`${cmd}: ${e.message}`)) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      children.delete(child)
      if (signal) return fail(new StepError(`${cmd} ${args.join(' ')} — killed (${signal}; timeout ${timeout / 1000}s?)`))
      if (expect !== null && code !== expect) return fail(new StepError(`${cmd} ${args.join(' ')} — exit ${code}, expected ${expect}`))
      done({ code, out })
    })
  })
}

async function waitFor(url, ms = 20_000) {
  const end = Date.now() + ms
  let last = 'no answer'
  while (Date.now() < end) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return res
      last = `HTTP ${res.status}`
    } catch (e) { last = e.message }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new StepError(`${url} did not answer 2xx within ${ms / 1000}s (${last})`)
}

// Start a server, run `probe`, stop it with SIGTERM and report how it exited.
async function withServer(log, cmd, args, { cwd, extraEnv, ...opts }, probe) {
  appendFileSync(log, `\n$ ${cmd} ${args.join(' ')} &   (cwd ${cwd})\n`)
  const child = spawn(cmd, args, { cwd, env: { ...env, ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  child.stdout.on('data', (d) => appendFileSync(log, d))
  child.stderr.on('data', (d) => appendFileSync(log, d))
  const exited = new Promise((r) => child.on('close', (code, signal) => r({ code, signal })))
  try {
    await probe()
  } finally {
    try { process.kill(opts.group ? -child.pid : child.pid, 'SIGTERM') } catch { /* gone */ }
    const killer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }, 8000)
    var result = await exited
    clearTimeout(killer)
    children.delete(child)
  }
  return result
}

// Image builds and removals run one at a time across combos. Combos share base layers; removing one combo's image
// while another combo is extracting the same layers makes the build fail with "parent snapshot … does not exist".
let dockerQueue = Promise.resolve()
function dockerImage(log, args, opts) {
  const result = dockerQueue.then(() => run(log, 'docker', args, opts))
  dockerQueue = result.catch(() => undefined)
  return result
}

const scaffold = (log, args, opts = {}) => run(log, process.execPath, [BIN, ...args], { cwd: REPO, timeout: 60_000, ...opts })

// The kit's data-layer and test-kit unit tests, on MySQL (in `npm run gate` they run on SQLite only).
async function gateRuntimeOnMysql(combo) {
  const started = Date.now()
  if (!mysqlUrl) {
    console.log(`NOTICE [${combo.id}] no MySQL available (set TEST_MYSQL_URL or run with docker) — MySQL cases of the kit runtime tests SKIPPED`)
    return { combo, ok: true, seconds: 0, steps: 0, skipped: true }
  }
  const tmp = mkdtempSync(join(tmpdir(), 'nuxt-base-kit-gate-'))
  dirs.add(tmp)
  const log = join(tmp, 'gate.log')
  writeFileSync(log, `kit gate — ${combo.id}\n`)
  const step = 'vitest kit/tests/runtime-db + runtime-testing + runtime-auth on MySQL'
  try {
    const { out } = await run(log, 'npx', ['vitest', 'run', 'kit/tests/runtime-db.spec.ts', 'kit/tests/runtime-testing.spec.ts', 'kit/tests/runtime-auth.spec.ts'], { cwd: REPO, timeout: 300_000, extraEnv: { TEST_MYSQL_URL: mysqlUrl } })
    if (/SKIPPED|skipped/.test(out)) throw new StepError('some MySQL cases were skipped although TEST_MYSQL_URL was set')
    return { combo, ok: true, seconds: Math.round((Date.now() - started) / 1000), steps: 1 }
  } catch (e) {
    const tail = readFileSync(log, 'utf8').trimEnd().split('\n').slice(-60).join('\n')
    return { combo, ok: false, seconds: Math.round((Date.now() - started) / 1000), step, message: e.message, tail, log }
  } finally {
    if (!flags.keep) { rmSync(tmp, { recursive: true, force: true }); dirs.delete(tmp) }
  }
}

async function gateCombo(combo, index) {
  if (combo.runtime) return gateRuntimeOnMysql(combo)
  const tmp = mkdtempSync(join(tmpdir(), 'nuxt-base-kit-gate-'))
  dirs.add(tmp)
  const dir = join(tmp, 'app')
  const log = join(tmp, 'gate.log')
  writeFileSync(log, `kit gate — ${combo.id}\n`)
  const port = PORT_BASE + index * 10
  const started = Date.now()
  let step = 'scaffold'
  const steps = []
  const begin = (name) => { step = name; steps.push(name) }
  try {
    const layerRef = combo.layer === 'tag' ? tagRef : localRef
    if (!layerRef) throw new StepError('no git tag found for a layer: "tag" combo (pass --layer-ref)')
    const ctx = join(tmp, 'ctx.json')
    writeFileSync(ctx, JSON.stringify({ title: 'Gate App', layerRef }))
    const args = ['new', 'gate-app', '--kind', combo.kind, '--dir', dir, '--port', String(port), '--context', ctx, '--json']
    if (combo.with?.length) args.push('--with', combo.with.join(','))
    if (combo.db) args.push('--db', combo.db)
    if (combo.deploy) args.push('--deploy', combo.deploy)
    if (combo.sample === false) args.push('--no-sample')
    if (combo.lang) args.push('--lang', combo.lang)
    begin('scaffold')
    const plan = JSON.parse((await scaffold(log, args)).out)
    const api = plan.services.find((s) => s.type === 'api')
    const web = plan.services.find((s) => s.type === 'web')
    const both = api && web
    const apiDir = api ? join(dir, both ? 'api' : '') : null
    const uiDir = web ? join(dir, both ? 'ui' : '') : null

    // db module: the API needs a database to boot. A scratch SQLite file by default; the mysql flavour gets its own
    // `test_gate_*` schema on the gate's MySQL server (dropped again below) and runs its test suite there too.
    const onMysql = plan.db === 'mysql' && mysqlUrl
    if (plan.db === 'mysql' && !mysqlUrl) console.log(`NOTICE [${combo.id}] no MySQL available (set TEST_MYSQL_URL or run with docker) — the MySQL run of this project's suite and CLI is SKIPPED; it is gated on SQLite only`)
    const schema = `test_gate_${process.pid}_${index}`
    let databaseUrl = null
    if (plan.db) {
      if (onMysql) {
        await mysqlAdmin(mysqlUrl, [`DROP DATABASE IF EXISTS \`${schema}\``, `CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`])
        schemas.add(schema)
        const u = new URL(mysqlUrl)
        u.pathname = `/${schema}`
        databaseUrl = u.toString()
      } else {
        databaseUrl = `sqlite:${join(tmp, 'data', 'gate.db')}`
      }
    }
    const dbEnv = databaseUrl ? { DATABASE_URL: databaseUrl } : {}

    // The first commit of a fresh project, the way a developer machine makes it: a secret scanner in a pre-commit
    // hook must let it through (it once stopped on the hashes in .scaffold.json). Explicitly with gitleaks' default
    // config — staged, then the committed history — and the commit itself runs whatever hook this machine has.
    if (gitleaks) {
      begin('git: first commit passes gitleaks (protect --staged, the machine\'s own hook, detect)')
      const git = (gitArgs) => run(log, 'git', ['-c', 'user.name=kit-gate', '-c', 'user.email=kit-gate@example.invalid', '-c', 'commit.gpgsign=false', ...gitArgs], { cwd: dir, timeout: 60_000 })
      await git(['init', '-q'])
      await git(['add', '-A'])
      await run(log, 'gitleaks', ['protect', '--staged', '--no-banner', '--redact', '-v'], { cwd: dir, timeout: 60_000, extraEnv: { GITLEAKS_CONFIG: '' } })
      await git(['commit', '-q', '-m', 'scaffold'])
      await run(log, 'gitleaks', ['detect', '--source', '.', '--no-banner', '--redact', '-v'], { cwd: dir, timeout: 60_000, extraEnv: { GITLEAKS_CONFIG: '' } })
    } else if (index === 0) {
      console.log('NOTICE gitleaks is not installed — the first-commit secret scan of the generated projects is SKIPPED')
    }

    begin('npm install')
    await run(log, 'npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, timeout: 900_000 })
    // A fresh project starts without a known moderate+ advisory in what the kit pins (the project's own gate:ci
    // fails on high; this is the kit keeping its ranges and overrides current). --no-audit: registry unreachable.
    if (!flags['no-audit']) {
      for (const part of [dir, ...new Set([apiDir, uiDir].filter((d) => d && d !== dir))]) {
        if (!existsSync(join(part, 'package-lock.json'))) continue
        begin(`npm audit --audit-level=moderate (${part === dir ? '.' : part.slice(dir.length + 1)})`)
        await run(log, 'npm', ['audit', '--audit-level=moderate'], { cwd: part, timeout: 120_000 })
      }
    }
    begin(onMysql ? 'npm run gate (test suite on MySQL)' : 'npm run gate')
    const gated = await run(log, 'npm', ['run', 'gate'], { cwd: dir, timeout: 300_000, extraEnv: onMysql ? { TEST_MYSQL_URL: mysqlUrl } : {} })
    if (onMysql && /SKIPPED/.test(gated.out)) throw new StepError('the suite printed a SKIPPED notice although TEST_MYSQL_URL was set')
    begin('npm run build')
    await run(log, 'npm', ['run', 'build'], { cwd: dir, timeout: 300_000 })

    // install / gate / build must not have touched a locked file
    begin('scaffold check (clean)')
    await scaffold(log, ['check', dir, '--json'])

    if (apiDir) {
      begin('api: refuses to boot without PORT and names it')
      const noPort = await run(log, process.execPath, ['dist/index.js'], { cwd: apiDir, timeout: 15_000, expect: 1 })
      if (!/missing PORT/.test(noPort.out)) throw new StepError('boot without PORT did not say "missing PORT"')
      begin('api: boots, /health/live 200, SIGTERM -> exit 0')
      const p = port + 3
      const exit = await withServer(log, process.execPath, ['dist/index.js'], { cwd: apiDir, extraEnv: { PORT: String(p), HOST: '127.0.0.1', ...dbEnv } }, async () => {
        const res = await waitFor(`http://127.0.0.1:${p}/health/live`)
        const body = await res.json()
        if (body.status !== 'ok') throw new StepError(`/health/live answered ${JSON.stringify(body)}`)
      })
      if (exit.code !== 0) throw new StepError(`api did not shut down gracefully on SIGTERM (code ${exit.code}, signal ${exit.signal})`)
    }

    if (uiDir) {
      begin('ui: build output')
      const cf = combo.deploy === 'cf-pages'
      const output = cf ? 'dist/_worker.js/index.js' : '.output/server/index.mjs'
      if (!existsSync(join(uiDir, output))) throw new StepError(`${output} missing after build`)
      // `npm run serve` = the built artefact: node server, or wrangler's local Pages runtime for cf-pages
      begin('ui: built app answers / (npm run serve)')
      const p = port + 4
      await withServer(log, 'npm', ['run', 'serve'], { cwd: uiDir, group: true, extraEnv: { PORT: String(p), HOST: '127.0.0.1', NITRO_PORT: String(p), NITRO_HOST: '127.0.0.1', WRANGLER_SEND_METRICS: 'false' } }, async () => {
        const html = await (await waitFor(`http://127.0.0.1:${p}/`, cf ? 60_000 : 20_000)).text()
        if (!html.includes('<div id="__nuxt">')) throw new StepError('/ did not return the SPA shell')
      })
      if (combo.e2e && !flags['no-e2e']) {
        begin('ui: playwright e2e')
        await run(log, 'npx', ['playwright', 'test'], { cwd: uiDir, timeout: 300_000, extraEnv: { E2E_PORT: String(port + 2), WRANGLER_SEND_METRICS: 'false' } })
      }
    }

    if (combo.deploy === 'pm2') {
      begin('pm2: ecosystem file is valid, time: true, scripts exist')
      const check = `const e=require('./ecosystem.config.cjs');const fs=require('fs'),p=require('path');if(!e.apps.length)throw new Error('no apps');for(const a of e.apps){if(a.time!==true)throw new Error(a.name+': time is not true');if(!Number.isInteger(a.env.PORT))throw new Error(a.name+': no PORT');if(!fs.existsSync(p.join(a.cwd,a.script)))throw new Error(a.name+': script missing '+a.script)}`
      await run(log, process.execPath, ['-e', check], { cwd: dir, timeout: 15_000 })
    }

    if (combo.deploy === 'container') {
      begin('container: compose file is valid')
      if (docker) {
        // on the deploy host the .env sits next to the compose file — stand in for it with the template
        copyFileSync(join(dir, 'docker/env.example'), join(dir, 'docker/.env'))
        await run(log, 'docker', ['compose', '-f', 'docker/docker-compose.yml', 'config', '-q'], { cwd: dir, timeout: 60_000 })
        rmSync(join(dir, 'docker/.env'))
      }
      for (const svc of readFileSync(join(dir, 'docker/deploy.conf'), 'utf8').match(/^SERVICES="([^"]+)"/m)[1].split(' ')) {
        if (!docker) { console.log(`NOTICE [${combo.id}] docker is not available — image build SKIPPED for ${svc}`); continue }
        const tag = `nuxt-base-kit-gate-${process.pid}-${index}-${svc}`
        begin(`container: docker build ${svc}`)
        images.add(tag)
        await dockerImage(log, ['build', '-q', '-t', tag, join(dir, svc)], { cwd: dir, timeout: 900_000 })
        begin(`container: image ${svc} runs and answers its health path`)
        // db module: the image must carry a working db CLI (no npm, no tsx in it) — what the compose db-check step runs
        const imageDb = svc === 'api' && plan.db ? ['-e', 'DATABASE_URL=sqlite:/tmp/gate.db'] : []
        if (imageDb.length) {
          begin('container: db-check step — behind = exit 1, DB_MIGRATE_ON_DEPLOY=1 migrates and passes')
          const behind = await run(log, 'docker', ['run', '--rm', ...imageDb, tag, 'node', 'dist/db/cli.js', 'predeploy'], { cwd: dir, timeout: 60_000, expect: 1 })
          if (!/schema behind/.test(behind.out)) throw new StepError('predeploy on an empty database did not say "schema behind"')
          const migrated = await run(log, 'docker', ['run', '--rm', ...imageDb, '-e', 'DB_MIGRATE_ON_DEPLOY=1', tag, 'node', 'dist/db/cli.js', 'predeploy'], { cwd: dir, timeout: 60_000 })
          if (!/schema ok/.test(migrated.out)) throw new StepError('predeploy with DB_MIGRATE_ON_DEPLOY=1 did not end with "schema ok"')
          begin(`container: image ${svc} runs and answers its health path`)
        }
        // Started the way compose starts it: the deployed tag in APP_IMAGE_TAG, no build arg (the deploy script passes none).
        const cid = (await run(log, 'docker', ['run', '-d', '-p', '127.0.0.1::3000', '-e', 'APP_IMAGE_TAG=20260131-235959-abc1234', ...imageDb, tag], { cwd: dir, timeout: 60_000 })).out.trim()
        containers.add(cid)
        const mapped = (await run(log, 'docker', ['port', cid, '3000/tcp'], { cwd: dir, timeout: 15_000 })).out.trim().split('\n')[0]
        await waitFor(`http://${mapped}${svc === 'api' ? '/health/live' : '/'}`, 40_000)
        if (svc === 'api' && plan.modules.includes('api')) {
          begin('container: /version of the image reports commit + builtAt (no build arg: tag + build stamp; build args win)')
          const version = await (await waitFor(`http://${mapped}/version`, 10_000)).json()
          const age = Date.now() - Date.parse(version.builtAt)
          if (version.commit !== 'abc1234' || !(age >= 0 && age < 3_600_000)) throw new StepError(`/version without build args: ${JSON.stringify(version)}`)
          const exact = `${tag}-args`
          images.add(exact)
          await dockerImage(log, ['build', '-q', '-t', exact, '--build-arg', `APP_COMMIT=${'c0ffee'.repeat(6)}c0ff`, '--build-arg', 'APP_BUILT_AT=2026-01-02T03:04:05Z', join(dir, svc)], { cwd: dir, timeout: 900_000 })
          const pinned = (await run(log, 'docker', ['run', '-d', '-p', '127.0.0.1::3000', '-e', 'APP_IMAGE_TAG=20260131-235959-abc1234', ...imageDb, exact], { cwd: dir, timeout: 60_000 })).out.trim()
          containers.add(pinned)
          const at = (await run(log, 'docker', ['port', pinned, '3000/tcp'], { cwd: dir, timeout: 15_000 })).out.trim().split('\n')[0]
          const built = await (await waitFor(`http://${at}/version`, 40_000)).json()
          if (built.commit !== `${'c0ffee'.repeat(6)}c0ff` || built.builtAt !== '2026-01-02T03:04:05Z') throw new StepError(`/version with build args: ${JSON.stringify(built)}`)
          await run(log, 'docker', ['rm', '-f', pinned], { cwd: dir, timeout: 60_000 })
          containers.delete(pinned)
          await dockerImage(log, ['rmi', '-f', exact], { cwd: dir, timeout: 60_000 })
          images.delete(exact)
        }
        const user = (await run(log, 'docker', ['exec', cid, 'id', '-un'], { cwd: dir, timeout: 15_000 })).out.trim()
        if (user !== 'node') throw new StepError(`container runs as "${user}", expected "node"`)
        await run(log, 'docker', ['rm', '-f', cid], { cwd: dir, timeout: 60_000 })
        containers.delete(cid)
        await dockerImage(log, ['rmi', '-f', tag], { cwd: dir, timeout: 60_000 })
        images.delete(tag)
      }
    }

    if (combo.deploy === 'container' && plan.db && docker) {
      // The compose file's db-check gate, for real: the API container starts only when the database matches the image.
      // fullstack: the API has no host port — everything is asked through the UI, which is all a deploy can reach.
      const apiTag = `gate-${process.pid}-${index}`
      const image = `registry.example.com/gate-app-api:${apiTag}`
      const uiImage = `registry.example.com/gate-app-ui:${apiTag}`
      const project = `kit-gate-${process.pid}-${index}`
      const second = `${project}-second`
      const dockerDir = join(dir, 'docker')
      const compose = (args, opts = {}) => run(log, 'docker', ['compose', '-p', project, '-f', 'docker-compose.yml', ...args], { cwd: dockerDir, timeout: 180_000, ...opts })
      // API_PORT is set on purpose in the fullstack case too: the compose file must not honour it.
      const ports = (base) => (both ? `UI_TAG=${apiTag}\nUI_PORT=${base + 1}\nAPI_PORT=${base}\n` : `API_PORT=${base}\n`)
      const envFile = (migrate) => writeFileSync(join(dockerDir, '.env'), `API_TAG=${apiTag}\n${ports(port + 6)}DATABASE_URL=sqlite:./data/gate.db\nDB_MIGRATE_ON_DEPLOY=${migrate}\n`)
      // Ready = what an operator can reach: the API's own port, or — fullstack — the UI (compose starts it only once
      // the API container is healthy) and an API call through its /api proxy.
      const ready = async (base, ms) => {
        if (!both) {
          const body = await (await waitFor(`http://127.0.0.1:${base}/health/ready`, ms)).json()
          if (body.checks.some((c) => c.status !== 'ok')) throw new StepError(`/health/ready in compose: ${JSON.stringify(body)}`)
          return
        }
        await waitFor(`http://127.0.0.1:${base + 1}/`, ms)
        const res = await fetch(`http://127.0.0.1:${base + 1}/api/v1/items`, { signal: AbortSignal.timeout(5000) })
        const expected = plan.modules.includes('auth') ? 401 : 200 // either way the answer is the API's, in its error shape
        const body = await res.json()
        if (res.status !== expected || !res.headers.get('x-trace-id') || (expected === 200 ? !Array.isArray(body.data) : body.error?.code !== 'UNAUTHORIZED')) throw new StepError(`the API through the UI in compose: ${res.status} ${JSON.stringify(body)}`)
      }
      begin('container: compose — schema behind = `up` fails and no api container runs')
      await dockerImage(log, ['build', '-q', '-t', image, join(dir, 'api')], { cwd: dir, timeout: 900_000 })
      images.add(image)
      if (both) {
        await dockerImage(log, ['build', '-q', '-t', uiImage, join(dir, 'ui')], { cwd: dir, timeout: 900_000 })
        images.add(uiImage)
      }
      mkdirSync(join(dockerDir, 'data'), { recursive: true })
      chmodSync(join(dockerDir, 'data'), 0o777) // the container user (node) writes the SQLite file here
      composeProjects.set(project, dockerDir)
      try {
        envFile('')
        const refused = await compose(['up', '-d'], { expect: 1 })
        if (!/db-check.*didn't complete successfully/.test(refused.out)) throw new StepError('compose up did not stop at the db-check step')
        const running = (await compose(['ps', '-q', '--status', 'running'])).out.trim()
        if (running) throw new StepError('a container is running although the db-check step failed')
        begin(`container: compose — DB_MIGRATE_ON_DEPLOY=1 migrates, then the api starts and is ready${both ? ' (asked through the UI)' : ''}`)
        envFile('1')
        await compose(['up', '-d'])
        await ready(port + 6, both ? 90_000 : 40_000)
        if (both) {
          begin('container: compose — the API has no host port; its health is still visible (HEALTHCHECK, exec)')
          const apiCid = (await compose(['ps', '-q', 'api'])).out.trim()
          const published = (await run(log, 'docker', ['port', apiCid], { cwd: dockerDir, timeout: 15_000 })).out.trim()
          if (published) throw new StepError(`the api container publishes a host port: ${published}`)
          const direct = await fetch(`http://127.0.0.1:${port + 6}/health/live`, { signal: AbortSignal.timeout(3000) }).then((res) => `HTTP ${res.status}`, () => null)
          if (direct) throw new StepError(`the API answers on host port ${port + 6} (${direct}) although the compose file publishes none`)
          const health = (await run(log, 'docker', ['inspect', '-f', '{{.State.Health.Status}}', apiCid], { cwd: dockerDir, timeout: 15_000 })).out.trim()
          if (health !== 'healthy') throw new StepError(`api container health is "${health}", expected "healthy"`)
          const inside = JSON.parse((await compose(['exec', '-T', 'api', 'wget', '-qO-', 'http://127.0.0.1:3000/health/ready'])).out.trim().split('\n').pop())
          if (inside.status !== 'ok') throw new StepError(`/health/ready inside the api container: ${JSON.stringify(inside)}`)
          const uiPublished = (await run(log, 'docker', ['port', (await compose(['ps', '-q', 'ui'])).out.trim()], { cwd: dockerDir, timeout: 15_000 })).out.trim()
          if (!uiPublished.includes(`:${port + 7}`)) throw new StepError(`the ui container is not published on ${port + 7}: ${uiPublished}`)
        }
        // The templates set no container_name, so the same compose file runs twice on one host: a second stage is
        // another project name (COMPOSE_PROJECT_NAME in its .env) and other host ports.
        begin('container: compose — a second stage of the app (COMPOSE_PROJECT_NAME) runs next to the first on one host')
        writeFileSync(join(dockerDir, '.env.second'), `COMPOSE_PROJECT_NAME=${second}\nAPI_TAG=${apiTag}\n${ports(port + 8)}`)
        composeProjects.set(second, dockerDir)
        await run(log, 'docker', ['compose', '--env-file', '.env.second', '-f', 'docker-compose.yml', 'up', '-d'], { cwd: dockerDir, timeout: 180_000 })
        await ready(port + 8, both ? 90_000 : 40_000)
        await ready(port + 6, 10_000) // the first stage was not replaced
        const stages = (await run(log, 'docker', ['ps', '--filter', 'label=com.docker.compose.service=api', '--format', '{{.Names}}'], { cwd: dockerDir, timeout: 30_000 })).out.trim().split('\n').filter((name) => name.startsWith(`${project}-`)).sort()
        if (stages.join() !== [`${project}-api-1`, `${second}-api-1`].sort().join()) throw new StepError(`expected one api container per stage, found: ${stages.join(', ')}`)
      } finally {
        await run(log, 'docker', ['compose', '-p', second, '-f', 'docker-compose.yml', 'down', '-v', '--remove-orphans'], { cwd: dockerDir, timeout: 180_000, expect: null }).catch(() => {})
        composeProjects.delete(second)
        rmSync(join(dockerDir, '.env.second'), { force: true })
        await compose(['down', '-v', '--remove-orphans'], { expect: null }).catch(() => {})
        composeProjects.delete(project)
        for (const built of both ? [image, uiImage] : [image]) {
          await dockerImage(log, ['rmi', '-f', built], { cwd: dir, timeout: 60_000, expect: null }).catch(() => {})
          images.delete(built)
        }
        rmSync(join(dockerDir, '.env'), { force: true })
        try { rmSync(join(dockerDir, 'data'), { recursive: true, force: true }) } catch { /* owned by the container user */ }
      }
    }

    // helper object for combo.checks (module tasks): run commands in the project, start servers, call the generator
    const t = {
      combo, dir, apiDir, uiDir, port, plan, begin, tmp, dbEnv, onMysql: !!onMysql, noE2e: !!flags['no-e2e'],
      run: (cmd, cmdArgs, opts = {}) => run(log, cmd, cmdArgs, { cwd: dir, ...opts }),
      scaffold: (cmdArgs, opts) => scaffold(log, cmdArgs, opts),
      withServer: (cmd, cmdArgs, opts, probe) => withServer(log, cmd, cmdArgs, { cwd: dir, ...opts }, probe),
      waitFor,
      fail: (message) => { throw new StepError(message) },
    }
    for (const check of combo.checks ?? []) await check(t)

    begin('locked file edited -> check exit 1 -> update -> check exit 0')
    appendFileSync(join(dir, plan.locked[0]), '\n// edited\n')
    await scaffold(log, ['check', dir, '--json'], { expect: 1 })
    await scaffold(log, ['update', dir, '--json'])
    await scaffold(log, ['check', dir, '--json'])

    return { combo, ok: true, seconds: Math.round((Date.now() - started) / 1000), steps: steps.length }
  } catch (e) {
    if (!(e instanceof StepError)) appendFileSync(log, `\n${e.stack}\n`)
    const tail = readFileSync(log, 'utf8').trimEnd().split('\n').slice(-60).join('\n')
    return { combo, ok: false, seconds: Math.round((Date.now() - started) / 1000), step, message: e.message, tail, log }
  } finally {
    await dropSchemas(`test_gate_${process.pid}_${index}`)
    if (!flags.keep) { rmSync(tmp, { recursive: true, force: true }); dirs.delete(tmp) }
  }
}

mysqlUrl = await provideMysql()
const concurrency = Math.max(1, Number(flags.concurrency) || Math.min(4, Math.floor(availableParallelism() / 2) || 1))
console.log(`kit gate: ${selected.length} job(s), concurrency ${concurrency}, ports ${PORT_BASE}+, docker ${docker ? 'yes' : 'NO (image builds skipped)'}, mysql ${mysqlUrl ? (process.env.TEST_MYSQL_URL ? 'TEST_MYSQL_URL' : 'throwaway container') : selected.some((c) => c.runtime || c.db === 'mysql') ? 'NO (MySQL runs skipped)' : 'not needed'}, layer local=${localRef} tag=${tagRef}`)
const queue = selected.map((combo) => ({ combo, index: combo.runtime ? combos.length : combos.indexOf(combo) }))
const results = []
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const r = await gateCombo(job.combo, job.index)
    results.push(r)
    console.log(r.skipped ? `skipped ${r.combo.id}  (no MySQL)` : r.ok ? `ok      ${r.combo.id}  (${r.seconds}s, ${r.steps} steps)` : `FAILED  ${r.combo.id}  kind=${r.combo.kind}  step="${r.step}"  (${r.seconds}s)`)
  }
}))
await dropSchemas()
cleanupAll()

const failed = results.filter((r) => !r.ok)
for (const r of failed) {
  console.error(`\n===== FAILED kind=${r.combo.kind} combo=${r.combo.id} step="${r.step}" =====\n${r.message}\n--- last log lines${flags.keep ? ` (full log: ${r.log})` : ''} ---\n${r.tail}`)
}
console.log(`\nkit gate: ${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((r) => r.combo.id).join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
