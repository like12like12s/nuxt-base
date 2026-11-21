// @vitest-environment node
// tiers-check (kit/runtime/testing/tiers-check.mjs, shipped locked to every UI part by the base module): the three
// checks of the tier contract + the map generator. Every case runs against a throwaway tree in os.tmpdir().
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanup, KIT_ROOT, read, tmp } from './helpers'
// @ts-expect-error plain ESM, no types
import { initBaseline, runTiersCheck, writeMap } from '../runtime/testing/tiers-check.mjs'

const CHECKER = join(KIT_ROOT, 'runtime', 'testing', 'tiers-check.mjs')
afterAll(cleanup)

/** A throwaway repo: <root>/.git, the package at `pkg` ('' = root itself). */
function repo(files: Record<string, string>, pkg = '') {
  const root = tmp('tiers')
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, pkg, path)), { recursive: true })
    writeFileSync(join(root, pkg, path), content)
  }
  return { root, cwd: join(root, pkg) }
}

const tiersJson = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`
const spec = (title: string, body = '') => `import { expect, test } from '@playwright/test'\n\ntest('${title}', async ({ page }) => {\n${body}\n})\n`
const run = (cwd: string) => runTiersCheck({ cwd })

describe('tiers-check: discovery and shape', () => {
  it('no tiers.json anywhere: exit 0, one note, never blocks the gate', () => {
    const { cwd } = repo({ 'tests/e2e/app.spec.ts': spec('home renders') })
    const r = run(cwd)
    expect(r.exit).toBe(0)
    expect(r.errors).toEqual([])
    expect(r.notes.join(' ')).toMatch(/nothing to check/)
  })

  it('a fullstack tiers.json found from the repo root: paths stay repo-root-relative (ui/ prefix)', () => {
    const { root } = repo({
      'tests/tiers.json': tiersJson({ version: 1, map: { 'ui/app/**': ['ui/tests/e2e/app.spec.ts'] } }),
      'tests/e2e/app.spec.ts': spec('home renders'),
      'app/pages/index.vue': '<template />',
    }, 'ui')
    const r = run(root) // run from the root, not from ui/
    expect(r.exit, r.errors.join('; ')).toBe(0)
    expect(r.warnings).toEqual([])
  })

  it('test/ is accepted when that is the project folder (tests/ first, then test/)', () => {
    const { cwd } = repo({
      'test/tiers.json': tiersJson({ version: 1, map: { 'app/**': ['test/e2e/app.spec.ts'] } }),
      'test/e2e/app.spec.ts': spec('home renders'),
      'app/pages/index.vue': '<template />',
    })
    const r = run(cwd)
    expect(r.exit).toBe(0)
    expect(r.specFiles).toEqual(['test/e2e/app.spec.ts'])
  })

  it('invalid JSON or a wrong shape is a usage error (exit 2), not a finding', () => {
    const a = repo({ 'tests/tiers.json': '{not json' })
    expect(run(a.cwd).exit).toBe(2)
    const b = repo({ 'tests/tiers.json': tiersJson({ version: 2, map: {} }) })
    expect(run(b.cwd).exit).toBe(2)
    const c = repo({ 'tests/tiers.json': tiersJson({ version: 1, map: { 'app/**': 'tests/e2e/app.spec.ts' } }) })
    expect(run(c.cwd).exit).toBe(2)
  })
})

describe('tiers-check: 1 — every spec reachable from map or fullOnly', () => {
  const base = {
    'tests/tiers.json': tiersJson({ version: 1, map: { 'app/**': ['tests/e2e/app.spec.ts'] } }),
    'tests/e2e/app.spec.ts': spec('home renders'),
    'app/pages/index.vue': '<template />',
  }

  it('a spec no entry points at is an error; fullOnly declares it full-suite-only', () => {
    const files = { ...base, 'tests/e2e/admin.spec.ts': spec('admin renders') }
    const r = run(repo(files).cwd)
    expect(r.exit).toBe(1)
    expect(r.errors.join(' ')).toMatch(/spec not reachable: tests\/e2e\/admin\.spec\.ts/)
    const ok = run(repo({
      ...files,
      'tests/tiers.json': tiersJson({ version: 1, map: { 'app/**': ['tests/e2e/app.spec.ts'] }, fullOnly: ['tests/e2e/admin.spec.ts'] }),
    }).cwd)
    expect(ok.exit, ok.errors.join('; ')).toBe(0)
  })

  it('a map key that matches no file only warns — a rename never turns the gate red', () => {
    const r = run(repo({ ...base, 'tests/tiers.json': tiersJson({ version: 1, map: { 'app/**': ['tests/e2e/app.spec.ts'], 'gone/**': ['tests/e2e/app.spec.ts'] } }) }).cwd)
    expect(r.exit).toBe(0)
    expect(r.warnings.join(' ')).toMatch(/map key matches no file: gone\/\*\*/)
  })

  it('a map value or fullOnly entry naming a spec that does not exist warns', () => {
    const r = run(repo({ ...base, 'tests/tiers.json': tiersJson({ version: 1, map: { 'app/**': ['tests/e2e/app.spec.ts', 'tests/e2e/renamed-away.spec.ts'] } }) }).cwd)
    expect(r.exit).toBe(0)
    expect(r.warnings.join(' ')).toMatch(/renamed-away/)
  })

  it('an explicit "specs" glob finds specs outside the default e2e folders', () => {
    const r = run(repo({
      'tests/tiers.json': tiersJson({ version: 1, specs: 'browser/**/*.spec.ts', map: { 'app/**': ['browser/home.spec.ts'] } }),
      'browser/home.spec.ts': spec('home renders'),
      'app/pages/index.vue': '<template />',
    }).cwd)
    expect(r.exit, r.errors.join('; ')).toBe(0)
    expect(r.specFiles).toEqual(['browser/home.spec.ts'])
  })

  it('no spec files discovered: exit 0 with a note', () => {
    const r = run(repo({ 'tests/tiers.json': tiersJson({ version: 1, map: {} }) }).cwd)
    expect(r.exit).toBe(0)
    expect(r.notes.join(' ')).toMatch(/no spec files discovered/)
  })
})

describe('tiers-check: 2 — closed tag set and @layout', () => {
  const withSpec = (title: string, body = '', extra = '') => repo({
    'tests/tiers.json': tiersJson({ version: 1, map: { 'app/**': ['tests/e2e/app.spec.ts'] } }),
    'tests/e2e/app.spec.ts': extra + spec(title, body),
    'app/pages/index.vue': '<template />',
  })

  it('a tag outside the closed set is an error, and declaring it in tiers.json fixes it', () => {
    const r = run(withSpec('home renders @smoke @fast').cwd)
    expect(r.exit).toBe(1)
    expect(r.errors.join(' ')).toMatch(/@fast is outside the closed set/)
    const declared = repo({
      'tests/tiers.json': tiersJson({ version: 1, tags: ['@fast'], map: { 'app/**': ['tests/e2e/app.spec.ts'] } }),
      'tests/e2e/app.spec.ts': spec('home renders @smoke @fast'),
      'app/pages/index.vue': '<template />',
    })
    expect(run(declared.cwd).exit).toBe(0)
  })

  it('the option form tag: [...] is read too', () => {
    const r = run(withSpec('home renders', '', "import { test } from '@playwright/test'\ntest('x', { tag: ['@nightly'] }, () => {})\n").cwd)
    expect(r.exit).toBe(1)
    expect(r.errors.join(' ')).toMatch(/@nightly is outside the closed set/)
  })

  it('a test that skips by project name carries @layout — missing is an error, present passes', () => {
    const branch = "test.skip(({ browserName }) => browserName === 'webkit', 'flaky there')\n"
    const missing = run(withSpec('matrix @smoke', branch).cwd)
    expect(missing.exit).toBe(1)
    expect(missing.errors.join(' ')).toMatch(/no @layout/)
    const tagged = run(withSpec('matrix @smoke @layout', branch).cwd)
    expect(tagged.exit, tagged.errors.join('; ')).toBe(0)
  })

  it('a viewport branch (wrapped over two lines) needs @layout too; a describe tag covers its tests', () => {
    const branch = "if (\n  testInfo.project.name === 'mobile') return\n"
    const missing = run(withSpec('compact nav @smoke', branch).cwd)
    expect(missing.exit).toBe(1)
    const covered = repo({
      'tests/tiers.json': tiersJson({ version: 1, map: { 'app/**': ['tests/e2e/app.spec.ts'] } }),
      'tests/e2e/app.spec.ts': `import { test } from '@playwright/test'\ntest.describe('settings @layout', () => {\n  test('compact nav @smoke', () => {\n    ${branch}  })\n})\n`,
      'app/pages/index.vue': '<template />',
    })
    expect(run(covered.cwd).exit, 'describe @layout covers the test').toBe(0)
  })

  it('a test that merely asserts on the viewport, without branching, does not need @layout', () => {
    const plain = "expect(page.viewportSize()!.width).toBeGreaterThan(0)\n"
    const r = run(withSpec('size @smoke', plain).cwd)
    expect(r.exit, r.errors.join('; ')).toBe(0)
  })
})

describe('tiers-check: 3 — new spec file names vs baseline', () => {
  const withSpecNamed = (name: string, baseline?: string[]) => repo({
    'tests/tiers.json': tiersJson({ version: 1, ...(baseline ? { baseline } : {}), map: { 'app/**': [`tests/e2e/${name}`] } }),
    [`tests/e2e/${name}`]: spec('home renders'),
    'app/pages/index.vue': '<template />',
  })

  it('task / version / fix-round names are refused: t1405-accounts, v112-home, fix3, settings-v2', () => {
    for (const name of ['t1405-accounts.spec.ts', 'v112-home.spec.ts', 'fix3.spec.ts', 'settings-v2.spec.ts', 'round2.spec.ts']) {
      const r = run(withSpecNamed(name).cwd)
      expect(r.exit, name).toBe(1)
      expect(r.errors.join(' '), name).toMatch(/task\/version\/fix/)
    }
  })

  it('names that merely contain those letters pass: tv-guide, nav2, cov19, versions', () => {
    for (const name of ['tv-guide.spec.ts', 'nav2.spec.ts', 'cov19.spec.ts', 'versions.spec.ts']) {
      const r = run(withSpecNamed(name).cwd)
      expect(r.errors.join(' '), name).not.toMatch(/task\/version\/fix/)
      expect(r.exit, name).toBe(0)
    }
  })

  it('a baseline entry exempts a legacy name, and a stale baseline entry warns', () => {
    const legacy = run(withSpecNamed('t1405-accounts.spec.ts', ['tests/e2e/t1405-accounts.spec.ts']).cwd)
    expect(legacy.exit, legacy.errors.join('; ')).toBe(0)
    const stale = run(repo({
      'tests/tiers.json': tiersJson({ version: 1, baseline: ['tests/e2e/deleted-long-ago.spec.ts'], map: { 'app/**': ['tests/e2e/app.spec.ts'] } }),
      'tests/e2e/app.spec.ts': spec('home renders'),
      'app/pages/index.vue': '<template />',
    }).cwd)
    expect(stale.exit).toBe(0)
    expect(stale.warnings.join(' ')).toMatch(/baseline entry is not a spec anymore/)
  })

  it('--init-baseline records the current specs and clears the finding', () => {
    const { cwd } = withSpecNamed('t1405-accounts.spec.ts')
    expect(run(cwd).exit).toBe(1)
    const init = initBaseline({ cwd })
    expect(init.exit, init.errors.join('; ')).toBe(0)
    const recorded = JSON.parse(readFileSync(join(cwd, 'tests/tiers.json'), 'utf8')).baseline
    expect(recorded).toEqual(['tests/e2e/t1405-accounts.spec.ts'])
    expect(run(cwd).exit).toBe(0)
  })
})

describe('tiers-check --write-map: the page→spec part of map from the flow catalog', () => {
  // Pages on disk cover each Nuxt layout: '/' index, '/search' flat, '/help' index-folder, '/c/[slug]' dynamic,
  // '/p/[id]' dynamic with nothing on disk (neither p/[id].vue nor p/index.vue — different routes entirely).
  const pages = {
    'app/pages/index.vue': '<template />',
    'app/pages/search.vue': '<template />',
    'app/pages/help/index.vue': '<template />',
    'app/pages/c/[slug].vue': '<template />',
  }
  const specs = {
    'tests/e2e/home.spec.ts': spec('[P1.F1] first visit picks categories'),
    'tests/e2e/search.spec.ts': spec('[P1.F2] typos still find'),
    'tests/e2e/item.spec.ts': spec('[P1.F3] browse and go, also covers [P1.F6]'),
  }
  const catalog = `export const FLOWS = [
  { id: 'P1.F1', title: 'first visit', pages: ['/'] },
  { id: 'P1.F2', title: 'search', pages: ['/search'] },
  { id: 'P1.F3', title: 'browse', pages: ['/c/[slug]', '/p/[id]'] },
  { id: 'P1.F6', title: 'first heart', pages: ['/p/[id]'] },
  { id: 'P1.F7', title: 'help', pages: ['/help'] },
]
`
  const tree = () => repo({
    ...pages,
    ...specs,
    'tests/flows/catalog.mjs': catalog,
    'tests/tiers.json': tiersJson({ version: 1, flows: 'tests/flows/catalog.mjs', map: { 'src/server/**': ['tests/e2e/search.spec.ts'] } }),
  })

  it('routes become page globs: dynamic leaf = * (whole filename), index folder when that is what exists, union of specs', async () => {
    const { cwd } = tree()
    const r = await writeMap({ cwd })
    expect(r.exit, r.errors.join('; ')).toBe(0)
    const map = JSON.parse(read(cwd, 'tests/tiers.json')).map
    expect(map).toEqual({
      'app/pages/index.vue': ['tests/e2e/home.spec.ts'],
      'app/pages/search.vue': ['tests/e2e/search.spec.ts'],
      'app/pages/c/*': ['tests/e2e/item.spec.ts'],
      'app/pages/p/*': ['tests/e2e/item.spec.ts'],
      'src/server/**': ['tests/e2e/search.spec.ts'], // hand-written, kept
    })
    expect(Object.keys(map).filter((k) => k.includes('help'))).toEqual([]) // P1.F7 has no spec: no entry
    expect(run(cwd).exit).toBe(0) // generated map keeps every spec reachable
  })

  it('a route whose page file exists in neither form is emitted flat + warned, not an error', async () => {
    const { cwd } = tree()
    writeFileSync(join(cwd, 'tests/flows/catalog.mjs'), catalog.replace("pages: ['/'] },", "pages: ['/', '/gone'] },"))
    const r = await writeMap({ cwd })
    expect(r.exit, r.errors.join('; ')).toBe(0)
    expect(r.warnings.join(' ')).toMatch(/page \/gone/)
    expect(JSON.parse(read(cwd, 'tests/tiers.json')).map['app/pages/gone.vue']).toEqual(['tests/e2e/home.spec.ts'])
  })

  it('a static page present as BOTH the flat file and the index folder picks the flat file', async () => {
    const { cwd } = tree()
    mkdirSync(join(cwd, 'app/pages/search'), { recursive: true })
    writeFileSync(join(cwd, 'app/pages/search/index.vue'), '<template />')
    await writeMap({ cwd })
    const map = JSON.parse(read(cwd, 'tests/tiers.json')).map
    expect(map['app/pages/search.vue']).toEqual(['tests/e2e/search.spec.ts'])
    expect(map['app/pages/search/index.vue']).toBeUndefined()
  })

  it('a catalog of personas is flattened; a .json catalog works', async () => {
    const personas = repo({
      'tests/tiers.json': tiersJson({ version: 1, flows: 'tests/flows/catalog.json', map: {} }),
      'tests/flows/catalog.json': JSON.stringify({ personas: [{ id: 'P1', flows: [{ id: 'P9.F1', title: 'x', pages: ['/'] }] }] }),
      'tests/e2e/home.spec.ts': spec('[P9.F1] whatever'),
      'app/pages/index.vue': '<template />',
    })
    const r = await writeMap({ cwd: personas.cwd })
    expect(r.exit, r.errors.join('; ')).toBe(0)
    expect(JSON.parse(read(personas.cwd, 'tests/tiers.json')).map).toEqual({ 'app/pages/index.vue': ['tests/e2e/home.spec.ts'] })
  })

  it('ui/ prefix of a fullstack repo applies to the pages dir and the emitted keys', async () => {
    const { cwd } = repo({
      'tests/tiers.json': tiersJson({ version: 1, flows: 'ui/tests/flows/catalog.mjs', map: {} }),
      'tests/flows/catalog.mjs': catalog,
      ...pages,
      ...specs,
    }, 'ui')
    const r = await writeMap({ cwd })
    expect(r.exit, r.errors.join('; ')).toBe(0)
    const map = JSON.parse(read(cwd, 'tests/tiers.json')).map
    expect(Object.keys(map)).toContain('ui/app/pages/index.vue')
    expect(map['ui/app/pages/index.vue']).toEqual(['ui/tests/e2e/home.spec.ts'])
  })

  it('no flows key or a missing catalog is a usage error', async () => {
    const noKey = repo({ 'tests/tiers.json': tiersJson({ version: 1, map: {} }) })
    expect((await writeMap({ cwd: noKey.cwd })).exit).toBe(2)
    const missing = repo({ 'tests/tiers.json': tiersJson({ version: 1, flows: 'tests/flows/none.mjs', map: {} }) })
    expect((await writeMap({ cwd: missing.cwd })).exit).toBe(2)
  })
})

describe('tiers-check: CLI', () => {
  it('runs as a script: exit codes and --json output', () => {
    const good = repo({
      'tests/tiers.json': tiersJson({ version: 1, map: { 'app/**': ['tests/e2e/app.spec.ts'] } }),
      'tests/e2e/app.spec.ts': spec('home renders @smoke'),
      'app/pages/index.vue': '<template />',
    })
    const ok = spawnSync(process.execPath, [CHECKER], { encoding: 'utf8', cwd: good.cwd })
    expect(ok.status, ok.stdout).toBe(0)
    expect(ok.stdout.trim()).toBe('') // clean: no notes, no warnings, no errors
    const bad = repo({
      'tests/tiers.json': tiersJson({ version: 1, map: {} }),
      'tests/e2e/t1405-thing.spec.ts': spec('orphan'),
    })
    const fail = spawnSync(process.execPath, [CHECKER], { encoding: 'utf8', cwd: bad.cwd })
    expect(fail.status).toBe(1)
    expect(fail.stdout).toMatch(/spec not reachable/)
    expect(fail.stdout).toMatch(/task\/version\/fix/)
    const asJson = spawnSync(process.execPath, [CHECKER, '--json'], { encoding: 'utf8', cwd: bad.cwd })
    expect(JSON.parse(asJson.stdout)).toMatchObject({ exit: 1 })
  })

  it('runs against this repo (nuxt-base) without crashing — dogfood', () => {
    const r = run(KIT_ROOT)
    expect([0, 1]).toContain(r.exit)
    expect(Array.isArray(r.errors)).toBe(true)
  })
})
