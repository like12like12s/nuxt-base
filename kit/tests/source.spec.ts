// @vitest-environment node
// Findings #7 / #18 of the first real use: `check` reported drift in a project nobody had touched, because the kit
// directory it read was a working tree with unreleased changes — and nothing in the output said which kit that was.
// `check` / `update` now name the kit version AND commit, and keep "the kit has unreleased changes" apart from drift.
// Finding #19: `update` prints the by-hand notes of kit/UPGRADING.md for the version steps a project crosses.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { KIT_ROOT, cleanup, cli, cloneKit, git, gitKit, read, setKitVersion, tmp } from './helpers'
// @ts-expect-error plain ESM, no types
import { compareVersions, parseUpgrading } from '../lib/upgrading.mjs'

afterAll(cleanup)

function project(kit: string, args = ['--kind', 'api', '--with', 'api,db']) {
  const dir = join(tmp('source'), 'app')
  expect(cli(['new', 'demo-app', ...args, '--dir', dir, '--json'], { kit }).status).toBe(0)
  return dir
}
const releaseOf = (kit: string) => join(kit, '..')

describe('check names the kit it compared against', () => {
  it('a released kit (HEAD is the tag, tree clean): version + commit, not unreleased', () => {
    const kit = gitKit('1.2.3')
    const head = git(releaseOf(kit), 'rev-parse', 'HEAD')
    const dir = project(kit)
    const r = cli(['check', dir, '--json'], { kit })
    expect(r.status).toBe(0)
    expect(r.json).toMatchObject({ clean: true, state: 'clean', kit: { project: '1.2.3', current: '1.2.3', commit: head, unreleased: false }, drift: [], unreleased: [], warnings: [] })
    expect(r.json.kit).not.toHaveProperty('note')
    expect(cli(['check', dir], { kit }).stdout).toBe(`clean (kit 1.2.3 @ ${head.slice(0, 7)})\n`)
  })

  it('a kit that is not a git checkout (an exported release): no commit, treated as released — as before', () => {
    const kit = cloneKit('1.2.3')
    const dir = project(kit)
    expect(cli(['check', dir, '--json'], { kit }).json).toMatchObject({ clean: true, state: 'clean', kit: { current: '1.2.3', commit: null, unreleased: false } })
    expect(cli(['check', dir], { kit }).stdout).toBe('clean (kit 1.2.3)\n')
    // and a difference is plain drift there
    appendFileSync(join(kit, 'runtime/api/log.ts'), '\n// changed in the export\n')
    const r = cli(['check', dir, '--json'], { kit })
    expect(r.status).toBe(1)
    expect(r.json).toMatchObject({ state: 'drift', drift: [{ path: 'src/kit/api/log.ts', reason: 'outdated' }], unreleased: [] })
  })
})

describe('"the kit has unreleased changes" is its own state, not project drift', () => {
  it.each([
    ['an uncommitted edit in the working tree', (kit: string) => appendFileSync(join(kit, 'runtime/api/log.ts'), '\n// work in progress\n')],
    ['a commit after the release tag', (kit: string) => { appendFileSync(join(kit, 'runtime/api/log.ts'), '\n// committed, not released\n'); git(releaseOf(kit), 'commit', '-qam', 'fix') }],
  ])('%s: exit 0, state kit-unreleased, the files listed apart', (_what, change) => {
    const kit = gitKit('1.2.3')
    const dir = project(kit)
    change(kit)
    const r = cli(['check', dir, '--json'], { kit })
    expect(r.status, r.stdout).toBe(0)
    expect(r.json).toMatchObject({ clean: true, state: 'kit-unreleased', drift: [], unreleased: [{ path: 'src/kit/api/log.ts', reason: 'outdated' }], kit: { project: '1.2.3', current: '1.2.3', unreleased: true } })
    expect(r.json.kit.commit).toBe(git(releaseOf(kit), 'rev-parse', 'HEAD'))
    expect(r.json.kit.note).toMatch(/has unreleased changes \(kit\/ differs from v1\.2\.3; commit [0-9a-f]{7}\) — read the kit from the release tag v1\.2\.3/)
    expect(r.json.warnings).toEqual([]) // warnings are about the project's stored answers, never about the kit
    const text = cli(['check', dir], { kit })
    expect(text.status).toBe(0)
    expect(text.stdout).toMatch(/^clean \(kit 1\.2\.3 @ [0-9a-f]{7}, unreleased changes\)\n {2}kit has unreleased changes — 1 locked file\(s\) differ from this kit's working tree, not from a release \(not project drift\):\n {4}outdated {2}src\/kit\/api\/log\.ts\n/)
  })

  it('a new untracked locked file in the kit, or a version without its tag, is unreleased too', () => {
    const untagged = gitKit('1.2.3', { tagged: false })
    const dir = project(untagged)
    appendFileSync(join(untagged, 'runtime/api/log.ts'), '\n// x\n')
    const r = cli(['check', dir, '--json'], { kit: untagged })
    expect(r.status).toBe(0)
    expect(r.json).toMatchObject({ state: 'kit-unreleased', kit: { unreleased: true } })
    expect(r.json.kit.note).toContain('this checkout has no tag v1.2.3')
  })

  it('what the PROJECT did is still drift (exit 1) next to it: an edited or deleted locked file', () => {
    const kit = gitKit('1.2.3')
    const dir = project(kit)
    appendFileSync(join(kit, 'runtime/api/log.ts'), '\n// work in progress\n')
    appendFileSync(join(dir, 'src/kit/api/env.ts'), '\n// local tweak\n')
    const r = cli(['check', dir, '--json'], { kit })
    expect(r.status).toBe(1)
    expect(r.json).toMatchObject({ clean: false, state: 'drift', drift: [{ path: 'src/kit/api/env.ts', reason: 'modified' }], unreleased: [{ path: 'src/kit/api/log.ts', reason: 'outdated' }] })
    expect(cli(['check', dir], { kit }).stdout).toMatch(/^drift \(kit 1\.2\.3 @ [0-9a-f]{7}, unreleased changes\):\n {2}modified {2}src\/kit\/api\/env\.ts\n {2}kit has unreleased changes/)
  })

  it('a real release is drift again: the project is behind a released version, whatever else is in the tree', () => {
    const kit = gitKit('1.2.3')
    const dir = project(kit)
    appendFileSync(join(kit, 'runtime/api/log.ts'), '\n// released in 1.3.0\n')
    setKitVersion(kit, '1.3.0')
    git(releaseOf(kit), 'commit', '-qam', 'release v1.3.0')
    git(releaseOf(kit), 'tag', 'v1.3.0')
    const released = cli(['check', dir, '--json'], { kit })
    expect(released.status).toBe(1)
    expect(released.json).toMatchObject({ state: 'drift', kit: { project: '1.2.3', current: '1.3.0', unreleased: false }, unreleased: [] })
    expect(released.json.drift).toContainEqual({ path: 'src/kit/api/log.ts', reason: 'outdated' })
    // more work on top of 1.3.0: still drift for a 1.2.3 project (it IS behind a release) — with the warning
    appendFileSync(join(kit, 'runtime/api/env.ts'), '\n// after 1.3.0\n')
    const both = cli(['check', dir, '--json'], { kit })
    expect(both.status).toBe(1)
    expect(both.json.state).toBe('drift')
    expect(both.json.unreleased).toEqual([])
    expect(both.json.kit.note).toContain('has unreleased changes')
  })

  it('update still brings the project to the kit it was given, says which one, and check is clean afterwards', () => {
    const kit = gitKit('1.2.3')
    const dir = project(kit)
    appendFileSync(join(kit, 'runtime/api/log.ts'), '\n// work in progress\n')
    const r = cli(['update', dir, '--json'], { kit })
    expect(r.json).toMatchObject({ updated: ['src/kit/api/log.ts'], kit: { from: '1.2.3', to: '1.2.3', unreleased: true } })
    expect(read(dir, 'src/kit/api/log.ts')).toContain('// work in progress')
    expect(cli(['update', dir], { kit }).stdout).toMatch(/^updated 0 locked file\(s\) \(kit 1\.2\.3 @ [0-9a-f]{7}, unreleased changes\)\n/)
    expect(cli(['check', dir, '--json'], { kit }).json).toMatchObject({ state: 'clean', unreleased: [] })
  })

  it('this repository: the kit reports its own commit', () => {
    const dir = join(tmp('own'), 'app')
    expect(cli(['new', 'demo-app', '--kind', 'api', '--dir', dir, '--json']).status).toBe(0)
    const r = cli(['check', dir, '--json'])
    expect(r.status).toBe(0)
    // a CI checkout is a git checkout too; an exported copy would say null
    if (r.json.kit.commit !== null) expect(r.json.kit.commit).toBe(git(join(KIT_ROOT, '..'), 'rev-parse', 'HEAD'))
    expect(typeof r.json.kit.unreleased).toBe('boolean')
  })
})

describe('UPGRADING.md and the notes `update` prints', () => {
  const NOTES = `# Upgrading\n\nintro\n\n## 1.3.0 -> next\n\n- \`src/app.ts\`: third\n\n## 1.2.3 -> 1.3.0\n\n- \`src/app.ts\`: first thing,\n  continued on a second line\n- \`docker/docker-compose.yml\`: second thing\n\n## 1.0.0 -> 1.2.3\n\n- ancient\n`

  it('parses `## <from> -> <to>` sections and their top-level bullets', () => {
    expect(parseUpgrading(NOTES)).toEqual([
      { from: '1.3.0', to: 'next', items: ['`src/app.ts`: third'] },
      { from: '1.2.3', to: '1.3.0', items: ['`src/app.ts`: first thing, continued on a second line', '`docker/docker-compose.yml`: second thing'] },
      { from: '1.0.0', to: '1.2.3', items: ['ancient'] },
    ])
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions(null, '0.0.1')).toBe(-1)
  })

  it('update lists exactly the steps the project crosses — in --json as notes[], in text as a by-hand list', () => {
    const kit = gitKit('1.2.3')
    const dir = project(kit)
    writeFileSync(join(kit, 'UPGRADING.md'), NOTES)
    // same version, nothing released since: no step crossed (the edited UPGRADING.md alone makes the kit unreleased,
    // but the only section that starts at 1.2.3 is a released step the kit has not reached)
    git(releaseOf(kit), 'commit', '-qam', 'notes')
    git(releaseOf(kit), 'tag', '-f', 'v1.2.3')
    expect(cli(['update', dir, '--json'], { kit }).json.notes).toEqual([])

    setKitVersion(kit, '1.3.0')
    git(releaseOf(kit), 'commit', '-qam', 'release v1.3.0')
    git(releaseOf(kit), 'tag', 'v1.3.0')
    const second = project(kit) // a project born at 1.3.0
    const crossed = cli(['update', dir, '--json'], { kit })
    expect(crossed.json.kit).toMatchObject({ from: '1.2.3', to: '1.3.0', unreleased: false })
    expect(crossed.json.notes).toEqual([{ from: '1.2.3', to: '1.3.0', items: ['`src/app.ts`: first thing, continued on a second line', '`docker/docker-compose.yml`: second thing'] }])
    // the manifest now says 1.3.0: running update again prints nothing more
    expect(cli(['update', dir, '--json'], { kit }).json.notes).toEqual([])
    expect(cli(['update', second, '--json'], { kit }).json.notes).toEqual([])

    // unreleased work on top of 1.3.0: the `next` step applies to projects at 1.3.0 — and an older project gets both, oldest first
    appendFileSync(join(kit, 'runtime/api/log.ts'), '\n// towards the next release\n')
    const next = cli(['update', second, '--json'], { kit })
    expect(next.json.notes).toEqual([{ from: '1.3.0', to: 'next', items: ['`src/app.ts`: third'] }])
    const old = project(cloneKit('1.2.3'))
    const text = cli(['update', old], { kit })
    expect(cli(['update', project(cloneKit('1.2.3')), '--json'], { kit }).json.notes.map((n: any) => `${n.from}->${n.to}`)).toEqual(['1.2.3->1.3.0', '1.3.0->next'])
    expect(text.stdout).toContain('by hand — kit 1.2.3 -> 1.3.0 (app-owned files are never rewritten; kit/UPGRADING.md):\n  - `src/app.ts`: first thing, continued on a second line\n  - `docker/docker-compose.yml`: second thing\nby hand — kit 1.3.0 -> next')
  })

  it('the kit ships UPGRADING.md with the 0.2.0 -> next step, every note naming where to change what', () => {
    const sections = parseUpgrading(readFileSync(join(KIT_ROOT, 'UPGRADING.md'), 'utf8'))
    const first = sections.find((s: any) => s.from === '0.2.0')
    expect(first).toBeDefined()
    expect(first.items.length).toBeGreaterThanOrEqual(5)
    for (const topic of ["api.use('*', auth.middleware)", 'NUXT_PUBLIC_SITE_URL', 'liveName', 'container_name', '.lock.<n>']) expect(first.items.join('\n')).toContain(topic)
    for (const item of first.items) expect(item.length, item).toBeGreaterThan(40)
  })

  it('a v0.2.0 project updated by this kit is told the 0.2.0 steps (once the kit is past 0.2.0)', () => {
    const kit = cloneKit('0.3.0') // an exported release after 0.2.0, with this repository's UPGRADING.md
    const dir = project(cloneKit('0.2.0'))
    const r = cli(['update', dir, '--json'], { kit })
    expect(r.json.notes.length).toBeGreaterThanOrEqual(1)
    expect(r.json.notes[0]).toMatchObject({ from: '0.2.0' })
    expect(r.json.notes[0].items.join('\n')).toContain('container_name')
  })
})
