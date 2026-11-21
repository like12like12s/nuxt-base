/**
 * heavy-run from Playwright: the whole run holds a slot in the host-wide queue
 * (t1441). Copy this file into your project (scripts/lib/) and wire it in
 * playwright.config.ts — the IMPORT is load-bearing, see step 1:
 *
 *   import { heavyRunReporters } from './scripts/lib/heavy-run-global-setup.mjs'   // side effect at import, step 1
 *   export default defineConfig({
 *     globalSetup: './scripts/lib/heavy-run-global-setup.mjs',   // a PATH (Playwright >= 1.45): its default export runs
 *     reporters: [...heavyRunReporters(), ['list']],
 *     workers: Number(process.env.HEAVY_RUN_WORKERS) || undefined,
 *   })
 *
 * 1. The import itself sets HEAVY_RUN_WORKERS / E2E_WORKERS (clamped to the
 *    tier cap: 4 heavy, 2 light) and HEAVY_RUN_JSON — because imports run
 *    BEFORE the config object is built, `workers:` and heavyRunReporters() in
 *    the same file see them. heavy-run itself is a CHILD of this process, so
 *    nothing it exports could ever reach this config (t1441 review).
 * 2. globalSetup (the default export; a function value stopped being accepted
 *    by Playwright 1.45+ — the config passes this file's PATH) takes the slot;
 *    the holder is a watcher that exits when this process does (pid +
 *    starttime — a recycled pid must not hold the slot), so a killed run
 *    releases it.
 * 3. Process exit releases (globalSetup registers an exit hook — an explicit
 *    globalTeardown would need its own default-export file, which is not worth
 *    a second locked file); heavy-run survives the group-SIGTERM to log the row
 *    and read the JSON reporter you attached in step 1 (passed/failed/flaky
 *    land in the queue's SQLite log).
 *
 * The lock sits in globalSetup (like printq's e2e-lock) so it catches a bare
 * `npx playwright test` too, not just npm scripts.
 *
 * Tier: --grep @smoke or 1-3 file arguments = light (3 slots, workers <= 2);
 * anything else = heavy (2 slots, workers <= 4). Title-filter runs count as
 * heavy — the default is the safe side.
 *
 * Off the queue host (heavy-run not on PATH — machines the queue does not
 * serve) the import and globalSetup are no-ops: the run proceeds as it always did.
 * HEAVY_RUN_HELD=1 (already inside heavy-run, e.g. gate:full -> test:e2e, or a
 * wrapped `heavy-run -- npx playwright test`) also no-ops — re-entrant.
 *
 * Queue full: this process exits 75 — the suite has NOT run. Retry; never
 * report it as a pass or a fail (GATE.md).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

/** Is this argument a spec file (not a title filter)? */
const fileish = (a) => a.includes('/') || /\.(spec|test)\.[cm]?[jt]sx?$/i.test(a) || existsSync(a)

/** 'light' for a smoke grep or a 1-3-file run, else 'heavy'. */
export function heavyRunTier(argv = process.argv.slice(2)) {
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--grep' || a === '-g') {
      if ((argv[i + 1] || '').includes('@smoke')) return 'light'
      i++
    } else if (a.startsWith('--grep=')) {
      if (a.includes('@smoke')) return 'light'
    } else if (!a.startsWith('-')) {
      positional.push(a)
    }
  }
  if (positional.length >= 1 && positional.length <= 3 && positional.every(fileish)) return 'light'
  return 'heavy'
}

/** JSON reporter pointed at the queue's slot, so heavy-run logs passed/failed/flaky. */
export function heavyRunReporters() {
  return process.env.HEAVY_RUN_JSON ? [{ name: 'json', outputFile: process.env.HEAVY_RUN_JSON }] : []
}

// --- import-time preparation (runs before the importing config builds its object) -----------
const CAPS = { heavy: { HEAVY_RUN_WORKERS: 4, E2E_WORKERS: 4 }, light: { HEAVY_RUN_WORKERS: 2, E2E_WORKERS: 2 } }
const where = spawnSync('bash', ['-c', 'command -v heavy-run'], { encoding: 'utf8' })
const BIN = (where.stdout || '').trim()
const ENGAGED = !BIN || process.env.HEAVY_RUN_HELD === '1' ? null : heavyRunTier()
if (ENGAGED) {
  const state = process.env.HEAVY_RUN_STATE || `${homedir()}/.local/state/heavy-run`
  process.env.HEAVY_RUN_JSON = process.env.HEAVY_RUN_JSON || `${state}/report.pw.${process.pid}.json`
  for (const [k, cap] of Object.entries(CAPS[ENGAGED])) {
    const cur = Number(process.env[k])
    if (!cur || cur < 1 || cur > cap) process.env[k] = String(cap) // clamp: never above the tier budget
  }
}

let holder = null // { child } while a slot is held

export default async function globalSetup() {
  if (!ENGAGED) {
    if (BIN) return // already under heavy-run (HEAVY_RUN_HELD) — re-entrant
    console.error('[heavy-run] not on PATH — running without the host queue (expected off the queue host)')
    return
  }
  const tier = ENGAGED
  const waitSec = Number(process.env.HEAVY_RUN_WAIT ?? 600)
  // The watcher holds the slot for as long as this process lives. Liveness is
  // the pid AND its /proc starttime: a recycled pid answering `kill -0` must
  // not keep the slot after this process is gone and nothing tore it down.
  const pid = process.pid
  const watcher = `
st=""; [ -r /proc/${pid}/stat ] && st=$(sed 's/^.*) //' /proc/${pid}/stat | awk '{print $20}')
while :; do
  cur=""; [ -r /proc/${pid}/stat ] && cur=$(sed 's/^.*) //' /proc/${pid}/stat | awk '{print $20}')
  if [ -n "$st" ]; then [ "$cur" = "$st" ] || break; else kill -0 ${pid} 2>/dev/null || break; fi
  sleep 1
done`
  const child = spawn(BIN, [
    ...(tier === 'light' ? ['--light'] : []),
    '--wait', String(waitSec),
    '--label', `playwright ${tier} (pid ${pid})`,
    '--hold',
    '--', 'bash', '-c', watcher,
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true }) // own group: teardown takes it down whole
  holder = { child }

  let stderr = ''
  child.stderr.on('data', (c) => { stderr += c })
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  const deadline = Date.now() + (waitSec + 30) * 1000
  for (;;) {
    if (stderr.includes('heavy-run: acquired')) break
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(undefined), 200))])
    if (code !== undefined) {
      if (code === 75) {
        console.error(`[heavy-run] queue full (${tier} tier) after ${waitSec}s — the suite has NOT run. Retry; do not report this as pass or fail.`)
        process.exit(75) // the queue-full contract survives the helper path (GATE.md)
      }
      throw new Error(`[heavy-run] exited ${code} before acquiring a slot:\n${stderr.trim()}`)
    }
    if (Date.now() > deadline) {
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
      throw new Error(`[heavy-run] no answer from heavy-run after ${waitSec}s:\n${stderr.trim()}`)
    }
  }
  // Marked in THIS process's env: the webServer and workers playwright spawns
  // from here inherit it, so nothing inside the run re-enters the queue.
  process.env.HEAVY_RUN_HELD = '1'
  process.on('exit', release) // belt and braces: a run that never calls teardown still frees the slot
}

function release() {
  if (!holder) return
  try { process.kill(-holder.child.pid, 'SIGTERM') } catch { /* already gone */ }
  holder = null
}

export async function globalTeardown() {
  release()
}
