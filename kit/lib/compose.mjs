// Composition: (kind + modules + deploy preset + answers) -> the complete, deterministic set of files of a project.
// Pure: reads only the kit tree, returns data. Same inputs = byte-identical output (no clock, no randomness, sorted keys).
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, posix, resolve, sep } from 'node:path'
import { incompatible, usageError } from './errors.mjs'
import { DEFAULT_LANG, LANGS } from './i18n.mjs'
import { lockHash, toJson, walk } from './fsutil.mjs'
import { mergePackage, stringifyPackage } from './pkg.mjs'
import { render, undot } from './render.mjs'

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const DBS = ['sqlite', 'mysql']
const PLACEHOLDER = { registry: 'registry.example.com', host: 'deploy-host', domain: 'example.com', user: 'deploy' }

// --context values end up in generated source, YAML, Markdown and in docker/deploy.conf, which a bash script sources.
// They are data typed by a person or passed on by another program, so every one is checked before anything is
// rendered: free text may not contain a line break or another control character (a title is rendered into `//` and `#`
// comment lines), and everything that names a machine or a location has a closed alphabet — no quotes, spaces, `$`,
// backticks, `;` or parentheses, so the value cannot become code wherever it is pasted.
// C0 / C1 control characters and the two Unicode line separators (JavaScript ends a `//` comment at those too).
const hasControl = (text) => {
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true
  }
  return false
}
const HOSTLIKE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/
const REGISTRY = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]*[A-Za-z0-9])?$/
const LAYER_REF = /^[A-Za-z0-9@._~/:#+-]+$/
const URL_CHARS = /^https?:\/\/[A-Za-z0-9._~:/?#[\]%+=,-]+$/

// Returns the context to use plus warnings. `new` is strict: a bad value is a usage error (exit 2) and nothing is
// written. Re-composing an existing project (`lenient`: check / update / add read the answers back from
// .scaffold.json) never fails on a stored answer: the value is left out — the default or placeholder is used instead,
// so it still cannot reach a rendered file — and reported as a warning. An empty or absent value is always valid.
function validateContext(input, lenient = false) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    if (!lenient) throw usageError('--context must be a JSON object')
    return { context: {}, warnings: ['answers: not an object — defaults are used'] }
  }
  const context = { ...input }
  const warnings = []
  const bad = (target, prop, key, message) => {
    if (!lenient) throw usageError(`--context ${message}`)
    delete target[prop]
    warnings.push(`answers.${message} — ignored, the default is used; correct ${key} in .scaffold.json`)
  }
  const shown = (value) => JSON.stringify(String(value).slice(0, 40))
  const empty = (value) => value === undefined || value === null || value === ''
  const text = (target, prop, key, max) => {
    const value = target[prop]
    if (empty(value)) return
    if (typeof value !== 'string') return bad(target, prop, key, `${key} must be a string`)
    if (value.length > max) return bad(target, prop, key, `${key} must be at most ${max} characters`)
    if (hasControl(value)) return bad(target, prop, key, `${key} must be a single line without control characters`)
  }
  const token = (target, prop, key, pattern, what) => {
    const value = target[prop]
    if (empty(value)) return
    if (typeof value !== 'string') return bad(target, prop, key, `${key} must be a string`)
    if (value.length > 255 || !pattern.test(value)) return bad(target, prop, key, `${key} ${shown(value)} is not ${what}`)
  }
  const url = (target, prop, key) => {
    const value = target[prop]
    if (empty(value)) return
    if (typeof value !== 'string') return bad(target, prop, key, `${key} must be a string`)
    let parsed = null
    try {
      parsed = new URL(value)
    } catch {
      /* reported below */
    }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || value.length > 500 || !URL_CHARS.test(value)) {
      return bad(target, prop, key, `${key} ${shown(value)} is not a plain http(s) URL (no credentials, no spaces or shell characters)`)
    }
  }
  text(context, 'title', 'title', 120)
  text(context, 'description', 'description', 500)
  token(context, 'layerRef', 'layerRef', LAYER_REF, 'a layer reference (github:owner/repo#tag, a package name or a path without spaces)')
  if (context.deploy !== undefined && context.deploy !== null && (typeof context.deploy !== 'object' || Array.isArray(context.deploy))) bad(context, 'deploy', 'deploy', 'deploy must be an object')
  const deploy = { ...context.deploy }
  token(deploy, 'registry', 'deploy.registry', REGISTRY, 'a registry (host[:port][/path])')
  for (const key of ['host', 'domain', 'user']) token(deploy, key, `deploy.${key}`, HOSTLIKE, 'a host or account name (letters, digits, . _ : -)')
  context.deploy = deploy
  token(context, 'mysqlHost', 'mysqlHost', HOSTLIKE, 'a host name (letters, digits, . _ : -)')
  url(context, 'otlpEndpoint', 'otlpEndpoint')
  url(context, 'authentikUrl', 'authentikUrl')
  return { context, warnings }
}

// The port the UI's e2e suite serves the built app on. Derived from the project's own (registered, therefore unique)
// UI port, so two kit projects on one machine never fight over one fixed port: UI port + 10000, or - 10000 when that
// would leave the port range. E2E_PORT still overrides it.
export const e2ePort = (uiPort) => (uiPort + 10000 <= 65535 ? uiPort + 10000 : uiPort - 10000)

// A title / description counts as given only when it says something: empty or blank is "not given" (a wrapper passes
// "" when its own flag was left out), and so is a title that merely repeats the kebab-case name — the readable form
// derived from the name (`kit-ref` -> `Kit Ref`) is the better default for a registry, a page title and the docs.
const given = (value, name) => {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text !== name ? text : ''
}
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
    // A requirement is a module name, or { name, kinds } when it only applies to some kinds (auth needs the data
    // layer in an API, and nothing but the layer's useAuth in a UI-only project).
    for (const dep of mod.requires ?? []) {
      if (typeof dep === 'string') add(dep, name)
      else if (!dep.kinds || dep.kinds.includes(kind.name)) add(dep.name, name)
    }
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
//   db: [..] the --db value is one of these · sample: true|false the example resource is / is not part of the project
const matches = (when, ctx) =>
  !when ||
  ((!when.kind || when.kind.includes(ctx.kind)) &&
    (!when.with || when.with.every((m) => ctx.modules.includes(m))) &&
    (!when.without || !when.without.some((m) => ctx.modules.includes(m))) &&
    (!when.db || when.db.includes(ctx.db)) &&
    (when.sample === undefined || when.sample === ctx.sample))

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

  // One UI language per project: the generated pages and the layer's own labels (app.config `lang`) say the same
  // language. th is the default (the layer's default); it only matters to projects with a UI.
  const lang = input.lang ?? DEFAULT_LANG
  if (!LANGS.includes(lang)) throw usageError(`--lang must be one of ${LANGS.join('|')}`)

  // The example resource `items` (table, routes, tests, seed rows, the `editor` role) comes with the api module unless
  // the project is created with --no-sample. Without the api module there is no sample to leave out.
  const sample = modules.includes('api') && input.sample !== false

  const { context, warnings } = validateContext(input.context ?? {}, input.lenient === true)
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
    sample,
    lang,
    warnings,
    layerRef: hasUi ? context.layerRef || kit.layerRef : null,
    // Everything needed to re-compose this exact project later (check / update read it back from .scaffold.json).
    answers: {
      name,
      title: given(context.title, name) || titleCase(name),
      description: given(context.description) || `${titleCase(name)} — scaffolded with the nuxt-base kit`,
      port: ports.ui,
      apiPort: ports.api,
      deploy: deployCtx,
      // Only recorded when given, so projects without it keep the same .scaffold.json.
      ...(modules.includes('api') && !sample ? { sample: false } : {}),
      ...(hasUi && lang !== DEFAULT_LANG ? { lang } : {}),
      ...(context.mysqlHost ? { mysqlHost: String(context.mysqlHost) } : {}),
      ...(context.otlpEndpoint ? { otlpEndpoint: String(context.otlpEndpoint) } : {}),
      ...(context.authentikUrl ? { authentikUrl: String(context.authentikUrl) } : {}),
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

  const when = { kind: kind.name, modules: sel.modules, db: sel.db, sample: sel.sample }
  // What `@kit:if` blocks in templates can ask (lib/render.mjs).
  const flags = new Set([...sel.modules, `kind:${kind.name}`, ...(sel.db ? [`db:${sel.db}`] : []), ...(preset ? [`deploy:${preset.name}`] : []), ...(sel.sample ? ['sample'] : []), `lang:${sel.lang}`])
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
    // The API of a fullstack container deploy has no host port (only the UI talks to it, over the compose network):
    // `internal: true` tells whoever registers the services that `port` is not something to probe from outside.
    const internal = role === 'api' && preset?.name === 'container' && parts.length > 1
    return { id: `${sel.name}-${role}`, name: role === 'api' ? 'API' : 'Web', type: role, port: p.port, healthPath: role === 'api' ? '/health/live' : '/', ...(internal ? { internal: true } : {}) }
  })

  const baseVars = {
    name: sel.name,
    title: sel.answers.title,
    description: sel.answers.description,
    // JSON string literals — safe to drop into .ts / .json sources whatever the title contains.
    titleJson: JSON.stringify(sel.answers.title),
    descriptionJson: JSON.stringify(sel.answers.description),
    kind: kind.name,
    lang: sel.lang,
    kitVersion: kit.version,
    layerRef: sel.layerRef ?? '',
    modules: csv(sel.modules),
    db: sel.db ?? 'none',
    deploy: preset?.name ?? 'none',
    port: sel.ports.ui,
    uiPort: sel.ports.ui,
    apiPort: sel.ports.api,
    e2ePort: e2ePort(sel.ports.ui),
    apiDir: partDir('api') || '.',
    uiDir: partDir('ui') || '.',
    registry: deploy.registry,
    deployHost: deploy.host,
    deployDomain: deploy.domain,
    deployUser: deploy.user,
    mysqlHost: sel.answers.mysqlHost ?? 'db.example.com',
    // Empty = tracing stays off until the operator sets it. Never a host of ours: it arrives through --context.
    otlpEndpoint: sel.answers.otlpEndpoint ?? '',
    authentikUrl: sel.answers.authentikUrl ?? 'https://authentik.example.com',
    // Behind the fullstack UI every user has the same TCP peer: the in-app rate limit is off until proxy trust is set.
    rateLimitDefault: kind.name === 'fullstack' ? '0' : '300',
    dbName: sel.name.replaceAll('-', '_'),
    // Placeholders, never a credential: the real URL lives in .env only.
    databaseUrlExample:
      sel.db === 'mysql'
        ? `mysql://<user>:<password>@${sel.answers.mysqlHost ?? 'db.example.com'}:3306/${sel.name.replaceAll('-', '_')}`
        : `sqlite:./data/${sel.name}.db`,
    // Secrets nobody chooses: random values a deploy tool generates on the host. docker/env.example names them in one
    // `# kit:generated KEY [KEY ...]` line and leaves `KEY=` empty; the line is absent when there is none.
    generatedEnvLine: (() => {
      const keys = [...new Set([...accs.values()].flatMap((a) => [...a.env.values()].filter((e) => e.secret && e.generated).map((e) => e.key)))].sort()
      return keys.length ? `# kit:generated ${keys.join(' ')}\n` : ''
    })(),
    services: services.map((s) => `- ${s.name} (\`${s.id}\`, ${s.type}) — port ${s.port}${s.internal ? ' (development; deployed: no host port, compose-internal)' : ''}, health \`${s.healthPath}\``).join('\n'),
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
    .map(({ file, dir }) => render(readFileSync(file, 'utf8'), varsFor(acc(dir)), file, flags).trim())
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
      for (const [abs, to] of entries) put(at(undot(to)), render(readFileSync(abs, 'utf8'), vars, abs, flags))
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
    env.push({ key: e.key, required: !!e.required, secret: !!e.secret, ...(e.secret && e.generated ? { generated: true } : {}) })
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
  for (const path of [...files.keys()].sort()) if (files.get(path).locked) locked[path] = lockHash(files.get(path).content)

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
    sample: sel.sample,
    lang: parts.some((p) => p.type === 'ui') ? sel.lang : null,
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
    warnings: sel.warnings,
    next: ['npm install', 'npm run gate', 'git init && git add -A && git commit -m "scaffold"', ...next.map((n) => render(n, baseVars, 'next'))],
  }
}

// Re-compose a project from its .scaffold.json (check / update / add).
export function composeFromManifest(kit, manifest) {
  const a = manifest.answers ?? {}
  const kind = kit.kinds.get(manifest.kind)
  const both = kind && kind.parts.length > 1
  return compose(kit, {
    lenient: true, // a stored answer never fails check / update / add — see validateContext
    name: a.name,
    kind: manifest.kind,
    with: (manifest.modules ?? []).filter((m) => m !== 'base'),
    db: manifest.db ?? undefined,
    deploy: manifest.deploy ?? undefined,
    port: a.port,
    apiPort: both ? a.apiPort : undefined,
    sample: a.sample !== false,
    // A stored value that is not a language (hand-edited manifest) falls back to the default instead of failing check.
    lang: LANGS.includes(a.lang) ? a.lang : undefined,
    context: { title: a.title, description: a.description, layerRef: manifest.layerRef ?? undefined, deploy: a.deploy, mysqlHost: a.mysqlHost, otlpEndpoint: a.otlpEndpoint, authentikUrl: a.authentikUrl },
  })
}
