// The five CLI commands. Each returns { exit, result } — bin/scaffold.mjs prints it (JSON or text).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compose, composeFromManifest } from './compose.mjs'
import { EXIT, existsError, incompatible, usageError } from './errors.mjs'
import { inside, isEmptyOrMissing, pathExists, readJson, sha256, symlinkUnder, toJson, writeFileUnder } from './fsutil.mjs'
import { GENERATOR_TYPES, isBehind } from './kit.mjs'

const MANIFEST = '.scaffold.json'
const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

function readManifest(dir) {
  const file = join(dir, MANIFEST)
  if (!existsSync(file)) throw usageError(`${dir} is not a scaffolded project (no ${MANIFEST})`, 'not_scaffolded')
  try {
    return readJson(file)
  } catch (e) {
    throw usageError(`${file} is not valid JSON: ${e.message}`, 'bad_manifest')
  }
}

export function cmdNew(kit, opts) {
  if (!opts.dir) throw usageError('--dir <target> is required')
  const dir = resolve(opts.dir)
  const plan = compose(kit, opts)
  if (!isEmptyOrMissing(dir)) throw existsError(`target dir ${dir} exists and is not empty`)
  if (!opts.dryRun) {
    for (const f of plan.files) writeFileUnder(dir, f.path, f.content)
    for (const s of plan.symlinks) symlinkUnder(dir, s.path, s.target)
  }
  return {
    exit: EXIT.OK,
    result: {
      ok: true,
      ...(opts.dryRun ? { dryRun: true } : {}),
      dir,
      name: plan.name,
      kind: plan.kind,
      modules: plan.modules,
      db: plan.db,
      deploy: plan.deploy,
      kitVersion: plan.kitVersion,
      files: [...plan.files.map((f) => f.path), ...plan.symlinks.map((s) => s.path)],
      locked: Object.keys(plan.locked),
      services: plan.services,
      env: plan.env,
      next: plan.next,
    },
  }
}

// Locked-file and layer-tag drift of a project against the current kit. Read-only.
function diff(kit, dir) {
  const manifest = readManifest(dir)
  const plan = composeFromManifest(kit, manifest)
  const recorded = manifest.locked ?? {}
  const drift = []
  for (const path of [...new Set([...Object.keys(recorded), ...Object.keys(plan.locked)])].sort()) {
    if (!(path in plan.locked)) { drift.push({ path, reason: 'removed-from-kit' }); continue }
    if (!(path in recorded)) { drift.push({ path, reason: 'new-in-kit' }); continue }
    const abs = inside(dir, path)
    if (!existsSync(abs)) drift.push({ path, reason: 'missing' })
    else if (sha256(readFileSync(abs)) !== recorded[path]) drift.push({ path, reason: 'modified' })
    else if (recorded[path] !== plan.locked[path]) drift.push({ path, reason: 'outdated' })
  }
  const hasUi = plan.parts.some((p) => p.type === 'ui')
  const layer = hasUi ? { current: manifest.layerRef ?? null, latest: kit.layerRef, behind: isBehind(manifest.layerRef, kit.layerRef) } : null
  return { manifest, plan, drift, layer }
}

export function cmdCheck(kit, opts) {
  const dir = resolve(opts.dir ?? '.')
  const { manifest, drift, layer } = diff(kit, dir)
  const clean = drift.length === 0 && !layer?.behind
  return { exit: clean ? EXIT.OK : EXIT.DRIFT, result: { ok: true, dir, clean, kit: { project: manifest.kit ?? null, current: kit.version }, layer, drift } }
}

// Re-copy locked files from the current kit and bump the layer tag. App-owned files are never touched, nothing is deleted.
export function cmdUpdate(kit, opts) {
  const dir = resolve(opts.dir ?? '.')
  const { manifest, plan, drift, layer } = diff(kit, dir)
  const updated = []
  const orphaned = []
  const warnings = []
  for (const { path, reason } of drift) {
    if (reason === 'removed-from-kit') { orphaned.push(path); continue }
    writeFileUnder(dir, path, plan.files.find((f) => f.path === path).content)
    updated.push(path)
  }
  let layerChange = null
  if (layer?.behind) {
    const ui = plan.parts.find((p) => p.type === 'ui')
    const config = join(dir, ui.dir, 'nuxt.config.ts')
    const text = existsSync(config) ? readFileSync(config, 'utf8') : null
    if (text?.includes(layer.current)) {
      writeFileSync(config, text.split(layer.current).join(layer.latest))
      layerChange = { from: layer.current, to: layer.latest, file: posix.join(ui.dir, 'nuxt.config.ts') }
    } else {
      warnings.push(`layer tag ${layer.current} not found in ${posix.join(ui.dir, 'nuxt.config.ts')} — bump the extends entry to ${layer.latest} by hand`)
    }
  }
  const next = { ...manifest, kit: kit.version, locked: plan.locked }
  if (layerChange) next.layerRef = layer.latest
  const text = toJson(next)
  if (text !== readFileSync(join(dir, MANIFEST), 'utf8')) writeFileSync(join(dir, MANIFEST), text)
  return { exit: EXIT.OK, result: { ok: true, dir, kit: { from: manifest.kit ?? null, to: kit.version }, updated, orphaned, layer: layerChange, warnings } }
}

export function cmdList(kit) {
  const brief = (u) => u.description ?? ''
  return {
    exit: EXIT.OK,
    result: {
      ok: true,
      kitVersion: kit.version,
      layerRef: kit.layerRef,
      kinds: [...kit.kinds.values()].map((k) => ({ name: k.name, description: brief(k), parts: k.parts.map((p) => ({ type: p.type, dir: p.dir ?? '' })) })),
      modules: [...kit.modules.values()].map((m) => ({
        name: m.name,
        status: m.status,
        implicit: m.name === 'base',
        kinds: m.kinds,
        requires: m.requires ?? [],
        generators: Object.keys(m.generators ?? {}),
        description: brief(m),
      })),
      deploy: [...kit.presets.values()].map((p) => ({ name: p.name, kinds: p.kinds, description: brief(p) })),
      generators: GENERATOR_TYPES,
    },
  }
}

// `add <type> <name>`: dispatch to the generator a kind or an installed module contributes for <type>.
// Unit descriptor: "generators": { "<type>": { "module": "generators/<type>.mjs", "part": "ui" | "api" | "project" } }.
// The module default-exports ({ name, type, dir, part, manifest, project }) => { files: [{ path, content }], next? }
// with paths relative to the part's directory. Existing files are never overwritten.
export async function cmdAdd(kit, opts) {
  const { type, name } = opts
  if (!GENERATOR_TYPES.includes(type)) throw usageError(`add: unknown type "${type ?? ''}" (${GENERATOR_TYPES.join('|')})`)
  if (!name || !NAME.test(name)) throw usageError(`add ${type}: invalid name "${name ?? ''}" — lowercase kebab-case`)
  const dir = resolve(opts.dir ?? '.')
  const manifest = readManifest(dir)
  const plan = composeFromManifest(kit, manifest)

  const units = []
  for (const part of plan.parts) if (part.kind !== plan.kind) units.push(kit.kinds.get(part.kind))
  units.push(kit.kinds.get(plan.kind), ...plan.modules.map((m) => kit.modules.get(m)))
  let found = null
  for (const unit of units) if (unit.generators?.[type]) found = { unit, spec: unit.generators[type] } // later unit wins
  if (!found) throw incompatible('no_generator', `no "${type}" generator in this project (kind ${plan.kind}, modules ${plan.modules.join(', ')})`)

  const partType = found.spec.part ?? 'project'
  const part = partType === 'project' ? { type: 'project', dir: '' } : plan.parts.find((p) => p.type === partType)
  if (!part) throw incompatible('no_generator', `the "${type}" generator needs a "${partType}" part, which kind ${plan.kind} does not have`)

  const mod = await import(pathToFileURL(join(found.unit.dir, found.spec.module)).href)
  const out = await mod.default({ name, type, dir: join(dir, part.dir), part, manifest, project: dir })
  const files = (out.files ?? []).map((f) => ({ path: posix.join(part.dir, f.path), content: f.content }))
  for (const f of files) if (pathExists(inside(dir, f.path))) throw existsError(`add ${type} ${name}: ${f.path} already exists`, 'exists')
  for (const f of files) writeFileUnder(dir, f.path, f.content)
  return { exit: EXIT.OK, result: { ok: true, dir, type, name, generator: found.unit.name, files: files.map((f) => f.path), next: out.next ?? [] } }
}
