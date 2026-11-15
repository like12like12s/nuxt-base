// Composition: (kind + modules + deploy preset + answers) -> the complete, deterministic set of files of a project.
// Pure: reads only the kit tree, returns data. Same inputs = byte-identical output (no clock, no randomness, sorted keys).
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, posix, resolve, sep } from 'node:path'
import { incompatible, usageError } from './errors.mjs'
import { sha256, toJson, walk } from './fsutil.mjs'
import { mergePackage, stringifyPackage } from './pkg.mjs'
import { render, undot } from './render.mjs'

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const DBS = ['sqlite', 'mysql']
const PLACEHOLDER = { registry: 'registry.example.com', host: 'deploy-host', domain: 'example.com', user: 'deploy' }

const titleCase = (name) => name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
const csv = (list) => (list.length ? list.join(', ') : 'none')

function resolveModules(kit, kind, requested) {
  const names = new Set(['base'])
  const add = (name, via) => {
    const mod = kit.modules.get(name)
    if (!mod) throw incompatible('unknown_module', `unknown module "${name}"${via ? ` (required by ${via})` : ''} — run \`scaffold list\` to see what exists`)
    if (mod.status !== 'ready') throw incompatible('planned_module', `module "${name}" is planned but not available in kit ${kit.version}${via ? ` (required by ${via})` : ''}`)
    if (!mod.kinds.includes(kind.name)) throw incompatible('incompatible_module', `module "${name}" does not support kind "${kind.name}" (supports: ${mod.kinds.join(', ')})`)
    if (names.has(name) && name !== 'base') return
    names.add(name)
    for (const dep of mod.requires ?? []) add(dep, name)
  }
  add('base')
  for (const name of requested) add(name)
  return ['base', ...[...names].filter((n) => n !== 'base').sort()]
}

function resolvePorts(kind, port, apiPort) {
  const types = kind.parts.map((p) => p.type)
  if (types.includes('api') && types.includes('ui')) {
    // Port pairing: API = base, UI = base + 1. `--port` alone is the base; with `--api-port`, `--port` is the UI port.
    const api = apiPort ?? port ?? 3000
    const ui = apiPort != null && port != null ? port : api + 1
    return { api, ui }
  }
  const only = port ?? apiPort ?? 3000
  return { api: only, ui: only }
}

// `when` on a file / locked / symlink / backup entry: every key present must hold.
//   kind: [..] the project's kind is one of these · with: [..] all these modules are in · without: [..] none of them is
//   db: [..] the --db value is one of these
const matches = (when, ctx) =>
  !when ||
  ((!when.kind || when.kind.includes(ctx.kind)) &&
    (!when.with || when.with.every((m) => ctx.modules.includes(m))) &&
    (!when.without || !when.without.some((m) => ctx.modules.includes(m))) &&
    (!when.db || when.db.includes(ctx.db)))

// What `new` was asked for -> validated, normalised selection. Throws KitError with the contract's exit codes.
export function resolveSelection(kit, input) {
  const { name, kind: kindName } = input
  if (!name || !NAME.test(name)) throw usageError(`invalid project name "${name ?? ''}" — lowercase kebab-case (a-z, 0-9, -), starting with a letter`)
  if (!kindName) throw usageError(`--kind is required (${[...kit.kinds.keys()].join('|')})`)
  const kind = kit.kinds.get(kindName)
  if (!kind) throw incompatible('unknown_kind', `unknown kind "${kindName}" (kinds: ${[...kit.kinds.keys()].join(', ')})`)

  const modules = resolveModules(kit, kind, input.with ?? [])

  let db = input.db ?? null
  if (db && !DBS.includes(db)) throw usageError(`--db must be one of ${DBS.join('|')}`)
  if (db && !modules.includes('db')) throw incompatible('incompatible_db', `--db ${db} needs the "db" module (--with db)`)
  if (!db && modules.includes('db')) db = 'sqlite'

  let preset = null
  if (input.deploy) {
    preset = kit.presets.get(input.deploy)
    if (!preset) throw incompatible('unknown_preset', `unknown deploy preset "${input.deploy}" (presets: ${[...kit.presets.keys()].join(', ')})`)
    if (!preset.kinds.includes(kind.name)) throw incompatible('incompatible_preset', `deploy preset "${preset.name}" does not support kind "${kind.name}" (supports: ${preset.kinds.join(', ')})`)
  }

  const context = input.context ?? {}
  const hasUi = kind.parts.some((p) => p.type === 'ui')
  const ports = resolvePorts(kind, input.port, input.apiPort)
  const deployCtx = {}
  for (const key of Object.keys(PLACEHOLDER)) if (context.deploy?.[key]) deployCtx[key] = String(context.deploy[key])

  return {
    name,
    kind,
    modules,
    db,
    preset,
    ports,
    layerRef: hasUi ? context.layerRef ?? kit.layerRef : null,
    // Everything needed to re-compose this exact project later (check / update read it back from .scaffold.json).
    answers: {
      name,
      title: context.title ?? titleCase(name),
      description: context.description ?? `${titleCase(name)} — scaffolded with the nuxt-base kit`,
      port: ports.ui,
      apiPort: ports.api,
      deploy: deployCtx,
      // Only recorded when given, so projects without it keep the same .scaffold.json.
      ...(context.mysqlHost ? { mysqlHost: String(context.mysqlHost) } : {}),
    },
  }
}

export function compose(kit, input) {
  const sel = resolveSelection(kit, input)
  const { kind, preset } = sel
  const parts = kind.parts.map((p) => ({ type: p.type, dir: p.dir ?? '', kind: p.kind ?? kind.name, port: sel.ports[p.type] }))
  const partDir = (type) => parts.find((p) => p.type === type)?.dir
  const deploy = { ...PLACEHOLDER, ...sel.answers.deploy }

  // One accumulator per output directory. In a single-part kind the part lives at the root, so project-level and
  // part-level contributions land in the same package.json.
  const accs = new Map()
  const acc = (dir) => {
    if (!accs.has(dir)) accs.set(dir, { dir, pkg: {}, env: new Map(), files: [], locked: [], symlinks: [], nuxtConfig: [], backup: [] })
    return accs.get(dir)
  }
  const gitignore = []
  const usage = []
  const next = []

  // Unit order is fixed -> deterministic: part kinds, the kind itself, base, other modules (sorted), deploy preset.
  const applications = []
  for (const part of parts) if (part.kind !== kind.name) applications.push({ unit: kit.kinds.get(part.kind), only: part.type })
  applications.push({ unit: kind })
  for (const name of sel.modules) applications.push({ unit: kit.modules.get(name) })
  if (preset) applications.push({ unit: preset })

  const when = { kind: kind.name, modules: sel.modules, db: sel.db }
  for (const { unit, only } of applications) {
    if (!unit) throw new Error(`kit is inconsistent: a unit referenced by kind "${kind.name}" is missing`)
    for (const [target, c] of Object.entries(unit.contributes ?? {})) {
      if (only && target !== only) continue
      const dir = target === 'project' ? '' : partDir(target)
      if (dir === undefined) continue // this kind has no such part
      const a = acc(dir)
      mergePackage(a.pkg, c.package)
      for (const e of c.env ?? []) a.env.set(e.key, { ...a.env.get(e.key), ...e })
      for (const b of c.backup ?? []) if (matches(b.when, when)) a.backup.push(b)
      for (const f of c.files ?? []) if (matches(f.when, when)) a.files.push({ ...f, unit })
      for (const f of c.locked ?? []) if (matches(f.when, when)) a.locked.push(f)
      for (const s of c.symlinks ?? []) if (matches(s.when, when)) a.symlinks.push(s)
      a.nuxtConfig.push(...(c.nuxtConfig ?? []))
      gitignore.push(...(c.gitignore ?? []))
      for (const u of [].concat(c.usage ?? [])) usage.push({ file: join(unit.dir, u), dir })
      next.push(...(c.next ?? []))
    }
  }

  const services = parts.map((p) => {
    const role = p.type === 'api' ? 'api' : 'web'
    return { id: `${sel.name}-${role}`, name: role === 'api' ? 'API' : 'Web', type: role, port: p.port, healthPath: role === 'api' ? '/health/live' : '/' }
  })

  const baseVars = {
    name: sel.name,
    title: sel.answers.title,
    description: sel.answers.description,
    // JSON string literals — safe to drop into .ts / .json sources whatever the title contains.
    titleJson: JSON.stringify(sel.answers.title),
    descriptionJson: JSON.stringify(sel.answers.description),
    kind: kind.name,
    kitVersion: kit.version,
    layerRef: sel.layerRef ?? '',
    modules: csv(sel.modules),
    db: sel.db ?? 'none',
    deploy: preset?.name ?? 'none',
    port: sel.ports.ui,
    uiPort: sel.ports.ui,
    apiPort: sel.ports.api,
    apiDir: partDir('api') || '.',
    uiDir: partDir('ui') || '.',
    registry: deploy.registry,
    deployHost: deploy.host,
    deployDomain: deploy.domain,
    deployUser: deploy.user,
    mysqlHost: sel.answers.mysqlHost ?? 'db.example.com',
    dbName: sel.name.replaceAll('-', '_'),
    // Placeholders, never a credential: the real URL lives in .env only.
    databaseUrlExample:
      sel.db === 'mysql'
        ? `mysql://<user>:<password>@${sel.answers.mysqlHost ?? 'db.example.com'}:3306/${sel.name.replaceAll('-', '_')}`
        : `sqlite:./data/${sel.name}.db`,
    services: services.map((s) => `- ${s.name} (\`${s.id}\`, ${s.type}) — port ${s.port}, health \`${s.healthPath}\``).join('\n'),
    nuxtConfig: '',
    usageSections: '',
  }
  const varsFor = (a) => {
    const part = parts.find((p) => p.dir === a.dir)
    return {
      ...baseVars,
      dir: a.dir || '.',
      port: part ? part.port : baseVars.port,
      nuxtConfig: a.nuxtConfig.map((line) => `  ${line}\n`).join(''),
    }
  }
  baseVars.usageSections = usage
    .map(({ file, dir }) => render(readFileSync(file, 'utf8'), varsFor(acc(dir)), file).trim())
    .join('\n\n')

  const files = new Map() // project-relative path -> { content, locked }
  const put = (path, content, locked = false) => {
    if (files.has(path)) throw new Error(`kit is inconsistent: two units write ${path}`)
    files.set(path, { content, locked })
  }
  const symlinks = []

  for (const a of [...accs.values()].sort((x, y) => (x.dir < y.dir ? -1 : 1))) {
    const vars = varsFor(a)
    const at = (rel) => posix.join(a.dir, rel)
    for (const f of a.files) {
      const src = resolve(f.unit.dir, f.from)
      if (!src.startsWith(kit.root + sep)) throw new Error(`${f.unit.name}: file source escapes the kit: ${f.from}`)
      if (!existsSync(src)) throw new Error(`${f.unit.name}: missing file source ${f.from}`)
      const entries = statSync(src).isDirectory() ? walk(src).map((rel) => [join(src, rel), posix.join(f.to ?? '', rel)]) : [[src, f.to]]
      for (const [abs, to] of entries) put(at(undot(to)), render(readFileSync(abs, 'utf8'), vars, abs))
    }
    for (const f of a.locked) {
      // Locked files are copied byte for byte (never rendered) so their hash equals the kit's — that is what `check` compares.
      const src = resolve(kit.root, f.from)
      if (!src.startsWith(kit.root + sep) || !existsSync(src)) throw new Error(`missing locked source ${f.from}`)
      put(at(undot(f.to)), readFileSync(src, 'utf8'), true)
    }
    for (const s of a.symlinks) symlinks.push({ path: at(render(s.path, vars)), target: render(s.target, vars) })
    if (Object.keys(a.pkg).length) {
      const pkg = mergePackage({ name: a.dir ? `${sel.name}-${a.dir}` : sel.name, version: '0.1.0', private: true }, a.pkg)
      put(at('package.json'), render(stringifyPackage(pkg), vars, 'package.json'))
    }
    if (a.env.size) {
      const lines = [`# ${at('.env.example')} — copy to .env and fill in. Never commit .env.`]
      for (const e of a.env.values()) {
        const flags = [e.required ? 'required' : 'optional', e.secret ? 'secret' : null].filter(Boolean).join(', ')
        lines.push(`# ${e.description ?? e.key} (${flags})`, `${e.key}=${render(String(e.example ?? ''), vars, 'env example')}`)
      }
      put(at('.env.example'), lines.join('\n') + '\n')
    }
  }

  put('.gitignore', [...new Set(gitignore)].join('\n') + '\n')

  const env = []
  const seen = new Set()
  for (const a of accs.values()) for (const e of a.env.values()) {
    if (seen.has(e.key)) continue
    seen.add(e.key)
    env.push({ key: e.key, required: !!e.required, secret: !!e.secret })
  }

  // What a backup job has to cover — the wrapper registers it, the generator registers nothing.
  const backup = []
  for (const a of [...accs.values()].sort((x, y) => (x.dir < y.dir ? -1 : 1))) {
    const vars = varsFor(a)
    for (const { when: _when, path, ...rest } of a.backup) {
      const entry = { id: `${sel.name}-db`, service: `${sel.name}-api` }
      for (const [key, value] of Object.entries(rest)) entry[key] = render(String(value), vars, 'backup')
      if (path) entry.path = posix.join(a.dir, render(path, vars, 'backup'))
      backup.push(entry)
    }
  }

  const locked = {}
  for (const path of [...files.keys()].sort()) if (files.get(path).locked) locked[path] = sha256(files.get(path).content)

  const manifest = {
    kit: kit.version,
    kind: kind.name,
    modules: sel.modules,
    db: sel.db,
    deploy: preset?.name ?? null,
    layerRef: sel.layerRef,
    answers: sel.answers,
    locked,
  }
  put('.scaffold.json', toJson(manifest))

  // .gitignore first (a project must be able to `git init` safely at any point), then everything else sorted.
  const order = ['.gitignore', ...[...files.keys()].filter((p) => p !== '.gitignore').sort()]
  return {
    name: sel.name,
    kind: kind.name,
    modules: sel.modules,
    db: sel.db,
    deploy: preset?.name ?? null,
    kitVersion: kit.version,
    layerRef: sel.layerRef,
    parts,
    manifest,
    files: order.map((path) => ({ path, ...files.get(path) })),
    symlinks: symlinks.sort((a, b) => (a.path < b.path ? -1 : 1)),
    locked,
    services,
    env,
    backup,
    next: ['npm install', 'npm run gate', 'git init && git add -A && git commit -m "scaffold"', ...next.map((n) => render(n, baseVars, 'next'))],
  }
}

// Re-compose a project from its .scaffold.json (check / update / add).
export function composeFromManifest(kit, manifest) {
  const a = manifest.answers ?? {}
  const kind = kit.kinds.get(manifest.kind)
  const both = kind && kind.parts.length > 1
  return compose(kit, {
    name: a.name,
    kind: manifest.kind,
    with: (manifest.modules ?? []).filter((m) => m !== 'base'),
    db: manifest.db ?? undefined,
    deploy: manifest.deploy ?? undefined,
    port: a.port,
    apiPort: both ? a.apiPort : undefined,
    context: { title: a.title, description: a.description, layerRef: manifest.layerRef ?? undefined, deploy: a.deploy, mysqlHost: a.mysqlHost },
  })
}
