// The five CLI commands. Each returns { exit, result } — bin/scaffold.mjs prints it (JSON or text).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compose, composeFromManifest } from './compose.mjs'
import { EXIT, existsError, incompatible, usageError } from './errors.mjs'
import { bareHash, inside, isEmptyOrMissing, pathExists, readJson, sha256, symlinkUnder, toJson, writeFileUnder } from './fsutil.mjs'
import { GENERATOR_TYPES, LAYER_REPO, isBehind } from './kit.mjs'
import { reservedName } from './names.mjs'

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

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const LAYER_TAG = new RegExp(`${escapeRe(LAYER_REPO)}#v\\d+\\.\\d+\\.\\d+`, 'g')

// The layer tag(s) the UI's nuxt.config.ts extends, oldest first; null when the file or a tag ref is not there
// (a local path, an env variable) — then only the manifest can say.
function layerRefInConfig(file) {
  if (!existsSync(file)) return null
  const refs = [...new Set(readFileSync(file, 'utf8').match(LAYER_TAG) ?? [])]
  if (!refs.length) return null
  return refs.sort((a, b) => (isBehind(a, b) ? -1 : isBehind(b, a) ? 1 : 0))[0]
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
      backup: plan.backup,
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
    // bareHash: a manifest written before the `sha256:` prefix holds bare hex — the same file is not drift.
    else if (sha256(readFileSync(abs)) !== bareHash(recorded[path])) drift.push({ path, reason: 'modified' })
    else if (bareHash(recorded[path]) !== bareHash(plan.locked[path])) drift.push({ path, reason: 'outdated' })
  }
  const ui = plan.parts.find((p) => p.type === 'ui')
  let layer = null
  let fromConfig = false
  if (ui) {
    // The ref the build really uses is the one in nuxt.config.ts — .scaffold.json only remembers what was generated.
    // A hand-edited older tag must read as drift, so the config wins whenever it names a tag of the layer.
    const inConfig = layerRefInConfig(join(dir, ui.dir, 'nuxt.config.ts'))
    const current = inConfig ?? manifest.layerRef ?? null
    layer = { current, latest: kit.layerRef, behind: isBehind(current, kit.layerRef) }
    fromConfig = inConfig !== null
  }
  return { manifest, plan, drift, layer, fromConfig }
}

export function cmdCheck(kit, opts) {
  const dir = resolve(opts.dir ?? '.')
  const { manifest, plan, drift, layer } = diff(kit, dir)
  const clean = drift.length === 0 && !layer?.behind
  return { exit: clean ? EXIT.OK : EXIT.DRIFT, result: { ok: true, dir, clean, kit: { project: manifest.kit ?? null, current: kit.version }, layer, drift, warnings: plan.warnings } }
}

// Re-copy locked files from the current kit and bump the layer tag. App-owned files are never touched, nothing is deleted.
export function cmdUpdate(kit, opts) {
  const dir = resolve(opts.dir ?? '.')
  const { manifest, plan, drift, layer, fromConfig } = diff(kit, dir)
  const updated = []
  const orphaned = []
  const warnings = [...plan.warnings]
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
    if (layer.current && text?.includes(layer.current)) {
      writeFileSync(config, text.split(layer.current).join(layer.latest))
      layerChange = { from: layer.current, to: layer.latest, file: posix.join(ui.dir, 'nuxt.config.ts') }
    } else {
      warnings.push(`layer tag ${layer.current} not found in ${posix.join(ui.dir, 'nuxt.config.ts')} — bump the extends entry to ${layer.latest} by hand`)
    }
  }
  const next = { ...manifest, kit: kit.version, locked: plan.locked }
  // Keep the manifest equal to what nuxt.config.ts really extends (a hand-edited tag is recorded, not papered over).
  if (layerChange) next.layerRef = layer.latest
  else if (fromConfig && !layer.behind) next.layerRef = layer.current
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
        requires: (m.requires ?? []).map((r) => (typeof r === 'string' ? r : r.name)),
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
  const reserved = reservedName(name)
  if (reserved) throw usageError(`add ${type}: "${name}" cannot be used as a name — ${reserved}. Pick a more specific one (e.g. ${name}-${type === 'job' ? 'job' : type === 'page' ? 'page' : 'records'}).`, 'reserved_name')
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
  // A file or a patch may name another part (`part: 'ui' | 'api' | 'project'`): a resource is an API thing with an
  // optional page in the UI. A part the project does not have is skipped — the generator need not know the kind.
  const dirOf = (partName) => {
    if (partName === undefined) return part.dir
    if (partName === 'project') return ''
    return plan.parts.find((p) => p.type === partName)?.dir
  }
  const parts = Object.fromEntries(plan.parts.map((p) => [p.type, { type: p.type, dir: p.dir, abs: join(dir, p.dir) }]))
  const out = await mod.default({ name, type, dir: join(dir, part.dir), part, parts, manifest, project: dir })
  const located = (list, what) => (list ?? []).flatMap((entry) => {
    const base = dirOf(entry.part)
    if (base === undefined) return []
    if (typeof entry.path !== 'string' || !entry.path) throw new Error(`generator ${found.unit.name}/${type}: a ${what} without a path`)
    return [{ ...entry, path: posix.join(base, entry.path) }]
  })
  const files = located(out.files, 'file')
  const patches = located(out.patches, 'patch')
  for (const f of files) if (pathExists(inside(dir, f.path))) throw existsError(`add ${type} ${name}: ${f.path} already exists`, 'exists')

  // Patches insert lines into app-owned files at an anchor comment (`// kit:anchor <name>`) the scaffold left there.
  // Everything is computed first: a missing anchor stops the command before a single byte is written.
  const patched = new Map()
  for (const p of patches) {
    const abs = inside(dir, p.path)
    if (!patched.has(p.path)) {
      if (!existsSync(abs)) throw usageError(`add ${type} ${name}: ${p.path} is missing — it is where the ${p.anchor} anchor lives`, 'anchor_missing')
      patched.set(p.path, readFileSync(abs, 'utf8'))
    }
    const lines = patched.get(p.path).split('\n')
    const at = lines.findIndex((line) => new RegExp(`(//|#|<!--)\\s*kit:anchor ${escapeRe(p.anchor)}(\\s|$)`).test(line))
    if (at === -1) {
      throw usageError(`add ${type} ${name}: no \`kit:anchor ${p.anchor}\` comment in ${p.path} — restore the anchor, or add this by hand above where it was:\n${p.insert}`, 'anchor_missing')
    }
    const indent = /^\s*/.exec(lines[at])[0]
    const insert = p.insert.replace(/\n$/, '').split('\n').map((line) => (line ? indent + line : line))
    if (insert.every((line) => lines.includes(line))) continue // already there: adding twice changes nothing
    lines.splice(at, 0, ...insert)
    patched.set(p.path, lines.join('\n'))
  }

  for (const f of files) writeFileUnder(dir, f.path, f.content)
  for (const [path, content] of patched) writeFileUnder(dir, path, content)
  return {
    exit: EXIT.OK,
    result: { ok: true, dir, type, name, generator: found.unit.name, files: files.map((f) => f.path), patched: [...patched.keys()], next: out.next ?? [] },
  }
}
