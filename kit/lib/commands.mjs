// The five CLI commands. Each returns { exit, result } — bin/scaffold.mjs prints it (JSON or text).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compose, composeFromManifest } from './compose.mjs'
import { EXIT, existsError, incompatible, usageError } from './errors.mjs'
import { bareHash, inside, isEmptyOrMissing, pathExists, readJson, sha256, symlinkUnder, toJson, writeFileUnder } from './fsutil.mjs'
import { GENERATOR_TYPES, LAYER_REPO, isBehind } from './kit.mjs'
import { reservedName } from './names.mjs'
import { kitSource } from './source.mjs'
import { compareVersions, upgradeNotes } from './upgrading.mjs'

const MANIFEST = '.scaffold.json'
const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const PAGE_PATH = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(\/([a-z][a-z0-9]*(-[a-z0-9]+)*|\[[a-z][A-Za-z0-9]*\]))*$/

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
      // What the project calls itself — the wrapper registers these, so a registry never shows the bare name as a title.
      title: plan.manifest.answers.title,
      description: plan.manifest.answers.description,
      kind: plan.kind,
      modules: plan.modules,
      db: plan.db,
      deploy: plan.deploy,
      // true = the example resource `items` is part of the project (the api module without --no-sample)
      sample: plan.sample,
      // 'th' | 'en' — the one language of the UI (generated pages + the layer's labels); null without a UI
      lang: plan.lang,
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
  // Differences that come from the KIT side (it ships another version of a file, a new one, one less) are project
  // drift only when a release caused them. With a kit that has unreleased work on top of the very version the project
  // was generated from, they say nothing about the project: they are reported apart, and are not drift.
  const source = kitSource(kit)
  const unreleased = []
  if (source.unreleased && (manifest.kit ?? null) === kit.version) {
    for (let i = drift.length - 1; i >= 0; i--) {
      if (['outdated', 'new-in-kit', 'removed-from-kit'].includes(drift[i].reason)) unreleased.unshift(...drift.splice(i, 1))
    }
  }
  return { manifest, plan, drift, unreleased, layer, fromConfig, source, warnings: [...plan.warnings] }
}

// `kit` of check / update: the version(s), the commit of the kit directory (null when it is not a git checkout),
// whether that kit has work no release has, and — when it does — a sentence saying what and where to read it instead.
// Not in `warnings[]`: those are about the project (its stored answers); this is about the kit that was used.
const kitInfo = (kit, source, extra) => ({
  ...extra,
  commit: source.commit,
  unreleased: source.unreleased,
  ...(source.unreleased
    ? { note: `the kit at ${kit.root} has unreleased changes (${source.why}; commit ${source.commit?.slice(0, 7) ?? 'unknown'}) — read the kit from the release tag ${source.tag} to compare a project with a release` }
    : {}),
})

export function cmdCheck(kit, opts) {
  const dir = resolve(opts.dir ?? '.')
  const { manifest, drift, unreleased, layer, source, warnings } = diff(kit, dir)
  const clean = drift.length === 0 && !layer?.behind
  // `kit-unreleased`: the project itself is clean — what differs is work in the kit that no release has yet.
  const state = !clean ? 'drift' : unreleased.length ? 'kit-unreleased' : 'clean'
  return {
    exit: clean ? EXIT.OK : EXIT.DRIFT,
    result: { ok: true, dir, clean, state, kit: kitInfo(kit, source, { project: manifest.kit ?? null, current: kit.version }), layer, drift, unreleased, warnings },
  }
}

// Re-copy locked files from the current kit and bump the layer tag. App-owned files are never touched, nothing is deleted.
export function cmdUpdate(kit, opts) {
  const dir = resolve(opts.dir ?? '.')
  // Never downgrade: a project generated (or updated) by a NEWER kit would get this kit's older locked files — fixes
  // silently undone — and still report ok. Refused before anything is read or written.
  const projectKit = readManifest(dir).kit ?? null
  if (/^\d+\.\d+\.\d+$/.test(projectKit ?? '') && compareVersions(projectKit, kit.version) > 0) {
    throw incompatible('kit_older', `update: ${dir} is at kit ${projectKit}, this kit is ${kit.version} — an older kit never updates a newer project (it would downgrade its locked files). Run the update with kit ${projectKit} or newer.`)
  }
  const { manifest, plan, drift, unreleased, layer, fromConfig, source, warnings } = diff(kit, dir)
  const updated = []
  const orphaned = []
  // update brings the project to THIS kit, released or not (the warning says which) — both lists are applied.
  for (const { path, reason } of [...drift, ...unreleased].sort((a, b) => (a.path < b.path ? -1 : 1))) {
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
  // What update cannot do: changes in files the app owns. kit/UPGRADING.md lists them per version step.
  const notes = upgradeNotes(kit, manifest.kit ?? null, source.unreleased)
  return { exit: EXIT.OK, result: { ok: true, dir, kit: kitInfo(kit, source, { from: manifest.kit ?? null, to: kit.version }), updated, orphaned, layer: layerChange, notes, warnings } }
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
  // A page is a route: nested (`reports/monthly`) and dynamic (`reports/[id]`) paths are names too. Everything else
  // is one kebab-case word.
  const isPage = type === 'page'
  if (!name || !(isPage ? PAGE_PATH : NAME).test(name)) {
    throw usageError(`add ${type}: invalid name "${name ?? ''}" — ${isPage ? 'lowercase kebab-case segments separated by "/", a dynamic segment as [param] (reports, reports/monthly, reports/[id]); the first segment is never dynamic' : 'lowercase kebab-case'}`)
  }
  // Two dynamic segments with one name (`x/[id]/[id]`): the router keeps one value, the page reads the wrong record.
  const params = name.match(/\[[^\]]+\]/g) ?? []
  const repeated = params.find((param, i) => params.indexOf(param) !== i)
  if (repeated) throw usageError(`add ${type}: "${name}" names the route parameter ${repeated} twice — give each dynamic segment its own name (e.g. ${name.replace(repeated, '[parentId]')})`, 'duplicate_param')
  // --og is the opt-in of `add resource` for the link preview of its detail page (record names become visible to
  // anyone who reaches the UI with a crawler user agent) — it means nothing for another type.
  if (opts.og && type !== 'resource') throw usageError(`add ${type}: --og only applies to \`add resource\``)
  const reserved = (isPage ? name.split('/').filter((segment) => !segment.startsWith('[')) : [name]).map(reservedName).find(Boolean)
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
  const out = await mod.default({ name, type, dir: join(dir, part.dir), part, parts, manifest, project: dir, options: { og: !!opts.og } })
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
  const skipped = []
  for (const p of patches) {
    const abs = inside(dir, p.path)
    // An `optional` patch is a convenience in a file an older project may not have in that shape: without the file
    // or the anchor it is left out (and reported in `skipped`) instead of stopping the whole command.
    if (p.optional && (!existsSync(abs) || !(patched.get(p.path) ?? readFileSync(abs, 'utf8')).split('\n').some((line) => new RegExp(`(//|#|<!--)\\s*kit:anchor ${escapeRe(p.anchor)}(\\s|$)`).test(line)))) {
      skipped.push({ path: p.path, anchor: p.anchor, insert: p.insert })
      continue
    }
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
    result: {
      ok: true, dir, type, name, generator: found.unit.name, files: files.map((f) => f.path), patched: [...patched.keys()],
      next: [...(out.next ?? []), ...skipped.map((s) => `${s.path}: no \`kit:anchor ${s.anchor}\` there — if you want it, add by hand: ${s.insert.trim()}`)],
    },
  }
}
