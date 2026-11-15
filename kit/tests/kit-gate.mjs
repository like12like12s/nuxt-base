#!/usr/bin/env node
// Kit gate (`npm run gate:kit`): for every combo in combos.mjs — scaffold into a fresh temp dir, `npm install`,
// `npm run gate`, build, then prove the result runs (boot + health, env fail-fast, check/update, pm2 file, image build).
// Slow by design (installs, builds); the fast unit tests of the generator live in kit/tests/*.spec.ts (`npm run gate`).
//
//   node kit/tests/kit-gate.mjs [--only <text>] [--concurrency N] [--keep] [--no-docker] [--no-e2e] [--layer-ref <ref>] [--list]
//
// Re-runnable: every run uses new temp dirs and removes them (and any image / container it created) on exit, also
// after a failure or Ctrl-C. `--keep` leaves the dirs for inspection. Starts nothing outside its own child processes.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    'no-e2e': { type: 'boolean' }, 'layer-ref': { type: 'string' }, list: { type: 'boolean' },
  },
})

// Child processes get a clean npm environment: when this runs under `npm run`, npm_* variables of THIS repo would leak in.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_|^INIT_CWD$|^NODE_ENV$|^AI_KIT_DIR$|^PORT$|^HOST$/.test(k)))
env.CI = '1'
env.NUXT_TELEMETRY_DISABLED = '1'

const selected = combos.filter((c) => !flags.only || c.id.includes(flags.only))
if (flags.list) { for (const c of selected) console.log(c.id); process.exit(0) }
if (!selected.length) { console.error(`kit gate: no combo matches --only ${flags.only}`); process.exit(2) }

const docker = !flags['no-docker'] && spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 }).status === 0
const latestTag = spawnSync('git', ['-C', REPO, 'describe', '--tags', '--abbrev=0'], { encoding: 'utf8' }).stdout.trim()
const tagRef = flags['layer-ref'] ?? (latestTag ? `github:like12like12s/nuxt-base#${latestTag}` : null)
const localRef = flags['layer-ref'] ?? REPO

const dirs = new Set()
const children = new Set()
const images = new Set()
const containers = new Set()
function cleanupAll() {
  for (const child of children) try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
  for (const id of containers) spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' })
  for (const tag of images) spawnSync('docker', ['rmi', '-f', tag], { stdio: 'ignore' })
  if (!flags.keep) for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanupAll(); process.exit(130) })

class StepError extends Error {}

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

const scaffold = (log, args, opts = {}) => run(log, process.execPath, [BIN, ...args], { cwd: REPO, timeout: 60_000, ...opts })

async function gateCombo(combo, index) {
  const tmp = mkdtempSync(join(tmpdir(), 'nuxt-base-kit-gate-'))
  dirs.add(tmp)
  const dir = join(tmp, 'app')
  const log = join(tmp, 'gate.log')
  writeFileSync(log, `kit gate — ${combo.id}\n`)
  const port = 39300 + index * 10
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
    begin('scaffold')
    const plan = JSON.parse((await scaffold(log, args)).out)
    const api = plan.services.find((s) => s.type === 'api')
    const web = plan.services.find((s) => s.type === 'web')
    const both = api && web
    const apiDir = api ? join(dir, both ? 'api' : '') : null
    const uiDir = web ? join(dir, both ? 'ui' : '') : null

    begin('npm install')
    await run(log, 'npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, timeout: 900_000 })
    begin('npm run gate')
    await run(log, 'npm', ['run', 'gate'], { cwd: dir, timeout: 300_000 })
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
      const exit = await withServer(log, process.execPath, ['dist/index.js'], { cwd: apiDir, extraEnv: { PORT: String(p), HOST: '127.0.0.1' } }, async () => {
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
        await run(log, 'npx', ['playwright', 'test'], { cwd: uiDir, timeout: 300_000, extraEnv: { E2E_PORT: String(port + 2) } })
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
        await run(log, 'docker', ['build', '-q', '-t', tag, join(dir, svc)], { cwd: dir, timeout: 900_000 })
        begin(`container: image ${svc} runs and answers its health path`)
        const cid = (await run(log, 'docker', ['run', '-d', '-p', '127.0.0.1::3000', tag], { cwd: dir, timeout: 60_000 })).out.trim()
        containers.add(cid)
        const mapped = (await run(log, 'docker', ['port', cid, '3000/tcp'], { cwd: dir, timeout: 15_000 })).out.trim().split('\n')[0]
        await waitFor(`http://${mapped}${svc === 'api' ? '/health/live' : '/'}`, 40_000)
        const user = (await run(log, 'docker', ['exec', cid, 'id', '-un'], { cwd: dir, timeout: 15_000 })).out.trim()
        if (user !== 'node') throw new StepError(`container runs as "${user}", expected "node"`)
        await run(log, 'docker', ['rm', '-f', cid], { cwd: dir, timeout: 60_000 })
        containers.delete(cid)
        await run(log, 'docker', ['rmi', '-f', tag], { cwd: dir, timeout: 60_000 })
        images.delete(tag)
      }
    }

    // helper object for combo.checks (module tasks): run commands in the project, start servers, call the generator
    const t = {
      combo, dir, apiDir, uiDir, port, plan, begin,
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
    if (!flags.keep) { rmSync(tmp, { recursive: true, force: true }); dirs.delete(tmp) }
  }
}

const concurrency = Math.max(1, Number(flags.concurrency) || Math.min(4, Math.floor(availableParallelism() / 2) || 1))
console.log(`kit gate: ${selected.length} combo(s), concurrency ${concurrency}, docker ${docker ? 'yes' : 'NO (image builds skipped)'}, layer local=${localRef} tag=${tagRef}`)
const queue = selected.map((combo) => ({ combo, index: combos.indexOf(combo) }))
const results = []
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const r = await gateCombo(job.combo, job.index)
    results.push(r)
    console.log(r.ok ? `ok      ${r.combo.id}  (${r.seconds}s, ${r.steps} steps)` : `FAILED  ${r.combo.id}  kind=${r.combo.kind}  step="${r.step}"  (${r.seconds}s)`)
  }
}))
cleanupAll()

const failed = results.filter((r) => !r.ok)
for (const r of failed) {
  console.error(`\n===== FAILED kind=${r.combo.kind} combo=${r.combo.id} step="${r.step}" =====\n${r.message}\n--- last log lines${flags.keep ? ` (full log: ${r.log})` : ''} ---\n${r.tail}`)
}
console.log(`\nkit gate: ${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((r) => r.combo.id).join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
