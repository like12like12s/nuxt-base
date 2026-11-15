#!/usr/bin/env node
// Parity screenshots for an app migrating to the layer (or any before/after UI change).
//   node scripts/parity-shots.mjs shoot <baseURL> <outDir> <route...> [--rewrite from=to] [--width 1280]
//   node scripts/parity-shots.mjs diff  <beforeDir> <afterDir> <diffDir>
// shoot: full-page PNG per route + JSON (status, title, height, JS errors). --rewrite reroutes API calls (e.g. a local
//        build whose API base points at a host that is not running) so both sides read the same backend.
// diff : pixelmatch per file → % changed pixels + a diff PNG. Exit 0 always; read the table.
import { chromium } from '@playwright/test'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [cmd, ...rest] = process.argv.slice(2)
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest.splice(i, 2)[1] : undefined }

if (cmd === 'shoot') {
  const rewrite = flag('rewrite'); const width = Number(flag('width')) || 1280
  const [base, out, ...routes] = rest
  mkdirSync(out, { recursive: true })
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
  if (rewrite) { const [from, to] = rewrite.split('='); 
    // fetch + fulfill (not continue): continue() cannot change protocol, and a local http build often needs an https API
    await ctx.route(`${from}/**`, async (r) => {
      try { await r.fulfill({ response: await r.fetch({ url: r.request().url().replace(from, to) }) }) } catch { await r.abort() }
    })
  }
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console ${m.text().slice(0, 160)}`) })
  const result = {}
  for (const r of routes.length ? routes : ['/']) {
    let status
    try { status = (await page.goto(base + r, { waitUntil: 'networkidle', timeout: 30000 }))?.status() } catch (e) { status = `ERR ${String(e.message).slice(0, 80)}` }
    await page.waitForTimeout(600)
    const name = r === '/' ? 'index' : r.replace(/^\//, '').replace(/[^a-zA-Z0-9_-]+/g, '_')
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: true })
    result[r] = { status, title: await page.title(), height: await page.evaluate(() => document.documentElement.scrollHeight) }
  }
  await browser.close()
  writeFileSync(join(out, 'shots.json'), JSON.stringify({ base, width, result, errors }, null, 1))
  console.log(JSON.stringify({ result, errors }, null, 1))
} else if (cmd === 'diff') {
  const { default: pixelmatch } = await import('pixelmatch'); const { PNG } = await import('pngjs')
  const [a, b, out] = rest
  mkdirSync(out, { recursive: true })
  const rows = []
  for (const f of readdirSync(a).filter((x) => x.endsWith('.png'))) {
    let A, B
    try { A = PNG.sync.read(readFileSync(join(a, f))); B = PNG.sync.read(readFileSync(join(b, f))) } catch { rows.push({ file: f, note: 'missing on one side' }); continue }
    const w = Math.min(A.width, B.width), h = Math.min(A.height, B.height)
    const crop = (p) => { const o = new PNG({ width: w, height: h }); PNG.bitblt(p, o, 0, 0, w, h, 0, 0); return o }
    const d = new PNG({ width: w, height: h })
    const n = pixelmatch(crop(A).data, crop(B).data, d.data, w, h, { threshold: 0.1 })
    writeFileSync(join(out, f), PNG.sync.write(d))
    rows.push({ file: f, before: `${A.width}x${A.height}`, after: `${B.width}x${B.height}`, heightDelta: B.height - A.height, changedPct: +(100 * n / (w * h)).toFixed(3) })
  }
  writeFileSync(join(out, 'diff.json'), JSON.stringify(rows, null, 1))
  console.table(rows)
} else {
  console.error('usage: parity-shots.mjs shoot <baseURL> <outDir> <route...> [--rewrite from=to] [--width N] | diff <before> <after> <out>'); process.exit(2)
}
