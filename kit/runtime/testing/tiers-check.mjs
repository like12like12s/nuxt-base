// DO NOT EDIT — locked file from the nuxt-base kit (runtime/testing/tiers-check.mjs). Its hash is recorded in
// .scaffold.json; `scaffold check` reports local edits and `scaffold update` overwrites them.
//
// tiers-check — the fast guard of the test-tier contract (git-hooks GATE.md, t1440/t1449). Runs inside `gate`,
// executes no tests, finishes in milliseconds. Three checks:
//   1. every discovered spec is pointed at by a `map` entry, or declared in `fullOnly` (runs only in the full suite)
//   2. every tag is in the closed set (@smoke @layout @quarantine + tags declared in tiers.json), and a test that
//      branches on the Playwright project or viewport carries @layout
//   3. a spec file that is not in `baseline` is not named after a task number / version / fix round (t1405-*, v112-*)
// A `map` key (or `fullOn` glob) that matches no file is a WARNING, never an error — a renamed folder must not turn
// the gate red before anyone updates tiers.json.
//
// Also maintains what it checks:
//   node tests/kit/tiers-check.mjs                  the three checks (the gate stage)
//   node tests/kit/tiers-check.mjs --init-baseline  record the current spec paths as `baseline` (adopt once)
//   node tests/kit/tiers-check.mjs --write-map      regenerate the page->spec part of `map` from the flow catalog
// `--write-map` needs `"flows": "tests/flows/catalog.mjs"` in tiers.json (a data-only module or .json; personas are
// flattened) and maps each page route to the specs whose titles carry that flow's id ("[P7.F3] ..."). Only entries
// under `"pages"` (default app/pages) are replaced; everything else in `map` is kept as written.
//
// tiers.json is found at tests/tiers.json or test/tiers.json of the current package (tests/ first); when run from
// the repo root, one level down too (*/tests/tiers.json — a repo with several checks them all). ALL paths it holds
// — keys, spec values, baseline, flows, pages — are REPO-ROOT-relative even when the file sits in a sub-package
// (ui/tests/tiers.json of a fullstack repo): the repo root is the git toplevel, else the directory the file was
// found in. With no tiers.json at all: exit 0 and one note — a repo that has not adopted tiers has nothing to check.
//
// Exit codes: 0 clean (warnings allowed), 1 findings, 2 usage (invalid tiers.json, missing catalog, ambiguous write).

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const CLOSED_TAGS = ['@smoke', '@layout', '@quarantine']
const DEFAULT_SPEC_GLOBS = ['tests/e2e/**/*.spec.ts', 'tests/e2e/**/*.test.ts', 'test/e2e/**/*.spec.ts', 'test/e2e/**/*.test.ts']
// Never walked when matching a map key / fullOn glob / spec glob against the tree (speed; no matches in build output).
const SKIP_DIRS = new Set(['node_modules', '.git', '.nuxt', '.output', 'dist', 'test-results', 'playwright-report', '.claude'])
const SPEC_EXT = /\.(?:spec|test)\.(?:[cm]?[jt]s|x)$/
// A spec stem named after a task number, version or fix round (GATE.md: never t1405-*, v112-*, fix3).
const BAD_STEM = [
  /^t\d/i,
  /^v\d/i,
  /^fix(?:es)?(?:[-_.]?\d+)?$/i,
  /(?:^|[-_.])(?:t|task|v|ver|version|fix|fixes|hotfix|round)[-_.]?\d+(?:$|[-_.])/i,
]
// A test that branches on the project or viewport must carry @layout (GATE.md). Heuristic: the branch keyword and
// the discriminator within one 3-line window (conditions wrap). A missed line only loses a tag on a test; a wrong
// line would cost an unearned red gate, so the window stays small.
const BRANCH_LINE = /\btest\s*\.\s*(?:skip|fixme)\s*\(|\bif\s*\(/
const PROJECT_LINE = /\.project\s*\.\s*name|\bbrowserName\b|\bviewportSize\s*\(\)|\bviewport\s*\.\s*(?:width|height)|\bisMobile\b/

// --- glob -> RegExp (gitignore-style: `**` crosses directories, `*` and `?` stay inside one segment, `[a-z]`
// character classes pass through; there are no braces in gitignore globs, so they are literals). Null = not a glob.
function globToRegExp(glob) {
  if (typeof glob !== 'string' || !glob) return null
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '\\') { if (i + 1 < glob.length) { re += glob[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } else return null }
    else if (ch === '*') {
      if (glob[i + 1] === '*') {
        while (glob[i + 1] === '*') i++
        // `/**/` also matches zero segments (a/**/b matches a/b); a bare `**` matches anything, slashes included.
        if (glob[i + 1] === '/') { re += '(?:[\\s\\S]*/)?'; i++ }
        else re += '[\\s\\S]*'
      } else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else if (ch === '[' || ch === ']') re += ch
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  try { return new RegExp(`^${re}$`) } catch { return null }
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// All regular files under `dir` (posix, relative to root, no leading slash), not crossing SKIP_DIRS or dot dirs.
function walkFiles(root, dir) {
  const out = []
  const step = (rel) => {
    let entries
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const rel2 = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) step(rel2) }
      else out.push(rel2)
    }
  }
  if (dir && !dir.startsWith('/') && existsSync(join(root, dir))) step(dir)
  else if (!dir) step('')
  return out
}

// The literal leading part of a glob (up to the first metacharacter) — the only directory worth walking.
function globPrefixDir(glob) {
  const m = glob.match(/^[^*?[\]{}]*/)
  return m ? m[0].replace(/\/[^/]*$/, '') : ''
}

// Files under root matching one glob (posix, relative). Unwalkable prefix = no match.
function matchGlob(root, glob) {
  const re = globToRegExp(glob)
  if (!re) return null
  return walkFiles(root, globPrefixDir(glob)).filter((f) => re.test(f))
}

const readText = (root, rel) => { try { return readFileSync(join(root, rel), 'utf8') } catch { return null } }

// --- where are we, and which tiers.json files exist ---------------------------------------------------------
function gitRoot(startDir) {
  for (let dir = resolve(startDir); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return null
  }
}

// Without a git toplevel (a fresh scaffold whose git init comes later), the repo root is inferred: the package dir
// is the one holding <dir>/tests/tiers.json, and the root is the highest ancestor that still looks like the repo —
// every step up has a package.json (fullstack: ui -> repo root; a root package stops at itself). Paths inside
// tiers.json are repo-root-relative (ui/tests/e2e/...), so guessing the package dir as the root would drop the
// ui/ prefix from discovery while the map keeps it — every spec would read as unreachable.
function rootWithoutGit(pkgDir) {
  let dir = resolve(pkgDir)
  for (;;) {
    const parent = dirname(dir)
    if (parent === dir || !existsSync(join(parent, 'package.json'))) return dir
    dir = parent
  }
}

function locateTiers(cwd) {
  const git = gitRoot(cwd)
  const searchRoot = git ?? resolve(cwd)
  const bases = [resolve(cwd), ...(git && git !== resolve(cwd) ? [git] : [])]
  const found = []
  const seen = new Set()
  for (const base of bases) {
    for (const folder of ['tests', 'test']) {
      const file = join(base, folder, 'tiers.json')
      if (existsSync(file) && !seen.has(file)) { seen.add(file); found.push(file) }
    }
  }
  // One level down too (ui/tests/tiers.json of a fullstack repo) — always, so a repo with tiers.json at the root
  // AND in a sub-package has both checked when run from the root.
  for (const entry of readdirSync(searchRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    for (const folder of ['tests', 'test']) {
      const file = join(searchRoot, entry.name, folder, 'tiers.json')
      if (existsSync(file) && !seen.has(file)) { seen.add(file); found.push(file) }
    }
  }
  const root = git ?? (found.length ? rootWithoutGit(dirname(dirname(found[0]))) : resolve(cwd))
  // The package prefix comes from where the file sits, never from where the search started.
  const files = found.map((file) => ({ file, pkg: relative(root, dirname(dirname(file))).split(sep).join('/') }))
  return { root, files }
}

// --- tags ---------------------------------------------------------------------------------------------------
// Playwright tags, two forms: the option `tag: '@smoke'` / `tag: ['@smoke', '@layout']`, and tags parsed from a
// title string — Playwright reads EVERY @token anywhere in the title (title.match(/@[\S]+/g)), not only trailing
// ones, so 'use @fast here' declares @fast. We mirror that on lines that declare a test (or set .tag), with a
// slightly narrower token ([\w.-]+) so prose like 'a@b.com' only fires when Playwright's own parsing would too.
// Returns { tag, line }, deduped.
const TITLE_LINE = /\btest\s*[.(]|\bdescribe\s*[.(]|\.tag\s*\(/
function tagsIn(text) {
  const found = new Map()
  text.split('\n').forEach((line, idx) => {
    const add = (tag) => found.set(`${idx + 1}:${tag}`, { tag, line: idx + 1 })
    for (const m of line.matchAll(/tag\s*:\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/g)) {
      for (const t of m[1].matchAll(/@([\w.-]+)/g)) add(`@${t[1]}`)
    }
    if (!TITLE_LINE.test(line)) return
    for (const m of line.matchAll(/'([^']*)'|"([^"]*)"/g)) {
      for (const t of (m[1] ?? m[2] ?? '').matchAll(/@([\w.-]+)/g)) add(`@${t[1]}`)
    }
  })
  return [...found.values()]
}

const branchesOnProjectOrViewport = (chunk) => {
  const lines = chunk.split('\n')
  return lines.some((_, i) => {
    const window = lines.slice(i, i + 3).join('\n')
    return BRANCH_LINE.test(window) && PROJECT_LINE.test(window)
  })
}

// Where the call opened at `from` closes — paren depth back to zero, skipping string literals and comments, so a
// '(' in a title ('signs in (admin)') cannot fool the count. Used to find the describes that enclose a test: the
// nested tests are arguments INSIDE the describe's parens.
function callEnd(text, from) {
  let depth = 0
  let quote = null
  let comment = null
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (comment === 'line') { if (ch === '\n') comment = null; continue }
    if (comment === 'block') { if (ch === '*' && next === '/') { comment = null; i++ } continue }
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue }
    if (ch === '/' && next === '/') { comment = 'line'; i++; continue }
    if (ch === '/' && next === '*') { comment = 'block'; i++; continue }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return i }
  }
  return text.length
}

// Test declarations: { index, isDescribe, headerEnd } — chunk i runs to the next opener. `test.skip(`/`test.fixme(`
// declare a test only when the first argument is the title string (`test.skip('known bad', ...)`); otherwise they
// are branch statements inside a test (`test.skip(({ browserName }) => ...)`) and belong to its chunk. A describe's
// header (title + options, before its first nested declaration) is where ITS tags live.
function testOpeners(text) {
  const openers = []
  for (const m of text.matchAll(/\btest\s*(?:\.\s*(?:describe|only|skip|fixme|fail)\s*)*\(/g)) {
    if (/[.]\s*(?:skip|fixme|fail)\s*\($/.test(m[0]) && !/^['"]/.test(text.slice(m.index + m[0].length).trimStart())) continue
    openers.push({ index: m.index, isDescribe: /[.]\s*describe\s*\($/.test(m[0]), callEnd: 0, headerEnd: text.length })
  }
  for (const o of openers) {
    o.callEnd = callEnd(text, o.index)
    const nextOpener = openers.find((other) => other.index > o.index)
    o.headerEnd = Math.min(nextOpener ? nextOpener.index : text.length, o.callEnd)
  }
  return openers
}

// The describes whose call still encloses offset `at` — a describe's @layout covers the tests inside it, and ONLY
// those: a closed describe does not leak coverage onto a later top-level test.
function enclosingDescribes(text, openers, at) {
  return openers.filter((o) => {
    if (!o.isDescribe || o.index >= at) return false
    return callEnd(text, o.index) > at
  })
}

// --- the three checks (one tiers.json) ------------------------------------------------------------------------
function checkTiersFile({ root, file, pkg }) {
  const errors = []
  const warnings = []
  const notes = []
  const label = pkg ? `${pkg}/tests` : 'tests'
  const at = (message) => `${label}: ${message}`

  let tiers
  try { tiers = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { return { exit: 2, errors: [at(`tiers.json is not valid JSON (${e.message})`)], warnings, notes } }
  const shape = (ok, message) => { if (!ok) errors.push(at(`tiers.json: ${message}`)); return ok }
  if (!shape(tiers && typeof tiers === 'object' && !Array.isArray(tiers), 'must be a JSON object')) return { exit: 2, errors, warnings, notes, tiers: null }
  shape(tiers.version === 1, 'version must be 1')
  const map = tiers.map ?? {}
  if (!shape(typeof map === 'object' && !Array.isArray(map), 'map must be an object of source-glob -> spec[]')) return { exit: 2, errors, warnings, notes, tiers: null }
  for (const [key, specs] of Object.entries(map)) {
    if (!Array.isArray(specs) || specs.some((s) => typeof s !== 'string')) errors.push(at(`tiers.json: map["${key}"] must be an array of spec paths`))
    else if (!globToRegExp(key)) errors.push(at(`tiers.json: map key "${key}" is not a valid glob`))
  }
  const fullOnly = tiers.fullOnly ?? []
  if (!shape(Array.isArray(fullOnly) && fullOnly.every((s) => typeof s === 'string'), 'fullOnly must be an array of spec paths')) return { exit: 2, errors, warnings, notes, tiers: null }
  const baseline = tiers.baseline ?? []
  if (!shape(Array.isArray(baseline) && baseline.every((s) => typeof s === 'string'), 'baseline must be an array of spec paths')) return { exit: 2, errors, warnings, notes, tiers: null }
  if (!shape(Array.isArray(tiers.tags ?? []) && (tiers.tags ?? []).every((t) => typeof t === 'string'), 'tags must be an array of tag strings')) return { exit: 2, errors, warnings, notes, tiers: null }
  if (!shape(Array.isArray(tiers.fullOn ?? []) && (tiers.fullOn ?? []).every((g) => typeof g === 'string'), 'fullOn must be an array of source globs')) return { exit: 2, errors, warnings, notes, tiers: null }
  if (!shape(tiers.specs === undefined || typeof tiers.specs === 'string' || (Array.isArray(tiers.specs) && tiers.specs.every((g) => typeof g === 'string')), 'specs must be a glob or an array of globs')) return { exit: 2, errors, warnings, notes, tiers: null }
  if (!shape((tiers.flows === undefined || typeof tiers.flows === 'string') && (tiers.pages === undefined || typeof tiers.pages === 'string'), 'flows and pages must be paths')) return { exit: 2, errors, warnings, notes, tiers: null }
  if (errors.length) return { exit: 2, errors, warnings, notes, tiers: null }

  const allowed = new Set([...CLOSED_TAGS, ...(tiers.tags ?? []).map((t) => (String(t).startsWith('@') ? String(t) : `@${String(t)}`))])

  // Spec discovery: the declared `specs` globs, else the usual e2e folders of this package.
  const specGlobs = tiers.specs === undefined ? DEFAULT_SPEC_GLOBS.map((g) => `${pkg ? `${pkg}/` : ''}${g}`) : [tiers.specs].flat()
  const specFiles = [...new Set(specGlobs.flatMap((g) => matchGlob(root, g) ?? []))].filter((f) => SPEC_EXT.test(f)).sort()
  if (!specFiles.length) notes.push(at('no spec files discovered — nothing to check (declare "specs" globs if the e2e folder is elsewhere)'))

  // 1 — every spec reachable from map or fullOnly; globs and values that name nothing only warn.
  const referenced = new Set(Object.values(map).flat())
  for (const spec of specFiles) {
    if (!referenced.has(spec) && !fullOnly.includes(spec)) errors.push(at(`spec not reachable: ${spec} — add a map entry that pulls it, or list it in fullOnly`))
  }
  for (const key of Object.keys(map)) {
    if (!matchGlob(root, key)?.length) warnings.push(at(`map key matches no file: ${key} (stale after a rename? warn only, never blocks)`))
  }
  for (const spec of referenced) if (readText(root, spec) === null) warnings.push(at(`map names a spec that does not exist: ${spec} (map values are plain paths, not globs)`))
  for (const spec of fullOnly) if (readText(root, spec) === null) warnings.push(at(`fullOnly names a spec that does not exist: ${spec}`))

  // 2 — closed tag set; a test that branches on project/viewport carries @layout (an ENCLOSING describe's tag
  // covers it — a describe that already closed does not).
  for (const spec of specFiles) {
    const text = readText(root, spec)
    if (text === null) continue
    for (const { tag, line } of tagsIn(text)) {
      if (!allowed.has(tag)) errors.push(at(`${spec}:${line} tag ${tag} is outside the closed set (${[...allowed].join(' ')}) — declare it in tiers.json "tags" or drop it`))
    }
    const openers = testOpeners(text)
    for (let i = 0; i < openers.length; i++) {
      const opener = openers[i]
      const chunk = text.slice(opener.index, openers[i + 1] ? openers[i + 1].index : undefined)
      if (!branchesOnProjectOrViewport(chunk)) continue
      const taggedHere = tagsIn(chunk).some((t) => t.tag === '@layout')
      const coveredAbove = enclosingDescribes(text, openers, opener.index)
        .some((d) => tagsIn(text.slice(d.index, d.headerEnd)).some((t) => t.tag === '@layout'))
      if (!taggedHere && !coveredAbove) {
        errors.push(at(`${spec}:${text.slice(0, opener.index).split('\n').length} branches on the Playwright project or viewport but carries no @layout — without it T1 runs one viewport only`))
      }
    }
  }

  // 3 — new spec files are not named after task numbers, versions or fix rounds; baseline files are exempt.
  for (const spec of specFiles) {
    if (baseline.includes(spec)) continue
    const stem = spec.split('/').pop().replace(SPEC_EXT, '')
    if (BAD_STEM.some((re) => re.test(stem))) errors.push(at(`spec file name "${stem}" looks like a task/version/fix name — name it after the module or page; names that predate tiers go in baseline`))
  }
  for (const old of baseline) if (!specFiles.includes(old)) warnings.push(at(`baseline entry is not a spec anymore: ${old} (prune with --init-baseline)`))

  // fullOn belongs to the selector (ai verify / test:affected); an unmatched one is still worth a warn.
  for (const glob of tiers.fullOn ?? []) {
    if (typeof glob === 'string' && !matchGlob(root, glob)?.length) warnings.push(at(`fullOn glob matches no file: ${glob}`))
  }

  return { exit: errors.length ? 1 : 0, errors, warnings, notes, tiers, specFiles, pkg }
}

export function runTiersCheck({ cwd = process.cwd(), tiersFile = null } = {}) {
  const { root, files } = locateTiers(cwd)
  // An explicit tiersFile keeps the same pkg rule as discovery: the prefix comes from the FILE's location, not from
  // where the command ran (running --write-map from the repo root must not re-check with an empty prefix).
  const targets = tiersFile
    ? [{ file: resolve(cwd, tiersFile), pkg: relative(root, dirname(dirname(resolve(cwd, tiersFile)))).split(sep).join('/') }]
    : files
  if (!targets.length) {
    return { exit: 0, errors: [], warnings: [], notes: ['no tests/tiers.json — tiers-check: nothing to check (a repo adopts tiers by adding one, GATE.md)'], root }
  }
  const runs = targets.map((t) => checkTiersFile({ ...t, root }))
  const merged = {
    exit: Math.max(...runs.map((r) => r.exit)),
    errors: runs.flatMap((r) => r.errors),
    warnings: runs.flatMap((r) => r.warnings),
    notes: runs.flatMap((r) => r.notes),
    root,
    runs,
  }
  if (runs.length === 1) { Object.assign(merged, { tiers: runs[0].tiers, specFiles: runs[0].specFiles, tiersFile: targets[0].file, pkg: runs[0].pkg }) }
  return merged
}

// --- --write-map: regenerate the page->spec part of `map` from the flow catalog -------------------------------
async function loadCatalog(root, rel) {
  const abs = resolve(root, rel)
  if (!existsSync(abs)) throw new Error(`flows catalog not found: ${rel}`)
  let loaded
  if (abs.endsWith('.json')) loaded = JSON.parse(readFileSync(abs, 'utf8'))
  else {
    loaded = await import(pathToFileURL(abs).href)
    loaded = loaded.default ?? loaded.FLOWS ?? loaded.flows ?? loaded
  }
  const flows = Array.isArray(loaded) ? loaded : loaded?.flows ?? loaded?.personas?.flatMap((p) => p.flows ?? []) ?? null
  if (!Array.isArray(flows) || flows.some((f) => typeof f?.id !== 'string' || !Array.isArray(f.pages) || f.pages.some((p) => typeof p !== 'string'))) {
    throw new Error(`catalog ${rel}: expected flows of { id, pages[] } — a flat array, { flows: [...] } or { personas: [{ flows: [...] }] }`)
  }
  return flows
}

// A page route -> the source glob of that page file. A dynamic segment becomes `*` (written out, `[slug]` is a
// glob character class otherwise — a real trap), a catch-all `**`. Flat file and index folder are both valid Nuxt
// layouts: the one on disk wins; when neither exists the flat form is emitted and warned (unmatched-glob rule).
function routeToGlob(root, pagesDir, route) {
  const segs = route.split('/').filter(Boolean).map((seg) => {
    if (/^\[\.\.\..*\]$/.test(seg)) return '**'
    if (/^\[.*\]$/.test(seg)) return '*'
    return seg.replace(/[*?[\]{}]/g, (ch) => `\\${ch}`)
  })
  if (segs.length === 0) return { glob: `${pagesDir}/index.vue`, missing: !existsSync(join(root, `${pagesDir}/index.vue`)) }
  // A dynamic leaf stands for the whole filename, extension included: /c/[slug] -> app/pages/c/* (never c/*.vue).
  if (segs[segs.length - 1] === '*' || segs[segs.length - 1] === '**') return { glob: `${pagesDir}/${segs.join('/')}`, missing: false }
  const base = `${pagesDir}/${segs.join('/')}`
  const flat = `${base}.vue`
  if (existsSync(join(root, flat))) return { glob: flat, missing: false }
  const index = `${base}/index.vue`
  if (existsSync(join(root, index))) return { glob: index, missing: false }
  return { glob: flat, missing: true }
}

export async function writeMap({ cwd = process.cwd() } = {}) {
  const state = runTiersCheck({ cwd })
  const fail = (message) => ({ exit: 2, errors: [message], warnings: state.warnings, notes: state.notes, root: state.root })
  if (state.runs?.length !== 1 || !state.tiers) return fail(state.errors.length ? state.errors.join('; ') : 'run --write-map from the package that owns the one tiers.json (several found)')
  const { tiers, tiersFile, root, specFiles, pkg } = state
  if (state.exit === 2) return fail(state.errors.join('; '))
  if (!tiers.flows) return fail('tiers.json has no "flows" — point it at the flow catalog (e.g. "tests/flows/catalog.mjs")')
  let flows
  try { flows = await loadCatalog(root, tiers.flows) } catch (e) { return fail(e.message) }
  const pagesDir = tiers.pages ?? `${pkg ? `${pkg}/` : ''}app/pages`

  // Which flow ids appear in each spec title ("[P7.F3] sign in: ..."); a route pulls every spec that covers it.
  const texts = new Map(specFiles.map((spec) => [spec, readText(root, spec) ?? '']))
  const generated = new Map()
  const genWarnings = []
  for (const flow of flows) {
    const idAt = new RegExp(`\\[${escapeRegExp(flow.id)}\\]`)
    const specs = specFiles.filter((spec) => idAt.test(texts.get(spec))).sort()
    for (const route of flow.pages) {
      const { glob, missing } = routeToGlob(root, pagesDir, route)
      if (missing) genWarnings.push(`page ${route} is neither ${glob} nor ${glob.replace(/\.vue$/, '/index.vue')} — emitted the flat form (warn-only glob)`)
      generated.set(glob, [...new Set([...(generated.get(glob) ?? []), ...specs])].sort())
    }
  }
  // A page no spec covers pulls nothing — an empty entry would only be noise. (The flow's own coverage is the
  // project's flows test to enforce, not the map's.)
  // Replace only this pages dir's entries; hand-written keys (components, server/**, ...) survive untouched.
  const kept = Object.fromEntries(Object.entries(tiers.map ?? {}).filter(([k]) => !k.startsWith(`${pagesDir}/`)))
  const written = Object.fromEntries([...generated].filter(([, specs]) => specs.length).sort(([a], [b]) => (a < b ? -1 : 1)))
  tiers.map = { ...kept, ...written }
  writeFileSync(tiersFile, `${JSON.stringify(tiers, null, 2)}\n`)
  const after = runTiersCheck({ cwd, tiersFile })
  return { ...after, warnings: [...genWarnings, ...after.warnings], notes: [`map: ${Object.keys(written).length} page entries generated from ${flows.length} flows, ${Object.keys(kept).length} hand-written entries kept (flows: ${tiers.flows})`, ...after.notes] }
}

export function initBaseline({ cwd = process.cwd() } = {}) {
  const state = runTiersCheck({ cwd })
  if (state.runs?.length !== 1 || !state.tiers) return { ...state, exit: 2, errors: [...state.errors, 'run --init-baseline from the package that owns the one tiers.json'] }
  const { tiers, tiersFile, specFiles } = state
  const previous = Array.isArray(tiers.baseline) ? tiers.baseline.length : 0
  tiers.baseline = specFiles
  writeFileSync(tiersFile, `${JSON.stringify(tiers, null, 2)}\n`)
  const note = `baseline: ${specFiles.length} spec paths recorded (was ${previous}) — run once when adopting; prune by rerunning when a legacy-named file is gone`
  const after = runTiersCheck({ cwd, tiersFile })
  return { ...after, notes: [note, ...after.notes] }
}

// --- CLI ------------------------------------------------------------------------------------------------------
async function main(argv) {
  if (argv.some((a) => a === '--help' || a === '-h')) {
    console.log('usage: node tests/kit/tiers-check.mjs [--write-map | --init-baseline | --json]')
    return 0
  }
  const result = argv.includes('--write-map') ? await writeMap({}) : argv.includes('--init-baseline') ? initBaseline({}) : runTiersCheck({})
  if (argv.includes('--json')) console.log(JSON.stringify(result, (k, v) => (k === 'tiers' || k === 'root' || k === 'runs' ? undefined : v), 2))
  else {
    for (const n of result.notes ?? []) console.log(`tiers-check: ${n}`)
    for (const w of result.warnings ?? []) console.log(`tiers-check: warn: ${w}`)
    for (const e of result.errors ?? []) console.log(`tiers-check: ${e}`)
  }
  return result.exit
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await main(process.argv.slice(2)))
}
