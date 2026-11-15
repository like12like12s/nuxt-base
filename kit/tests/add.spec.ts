// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanup, cli, cloneKit, read, tmp } from './helpers'

afterAll(cleanup)

function project(kind: string, kit?: string, extra: string[] = []) {
  const dir = join(tmp('add'), 'app')
  expect(cli(['new', 'demo-app', '--kind', kind, ...extra, '--dir', dir, '--json'], { kit }).status).toBe(0)
  return dir
}

// A module that contributes generators — the mechanism tasks D/E use for resource / job.
function kitWithGenerators() {
  const kit = cloneKit()
  const dir = join(kit, 'modules', 'gen-test')
  mkdirSync(join(dir, 'generators'), { recursive: true })
  writeFileSync(join(dir, 'module.json'), JSON.stringify({
    name: 'gen-test', status: 'ready', description: '', kinds: ['api', 'fullstack', 'nuxt-app'], requires: [],
    generators: {
      job: { module: 'generators/job.mjs', part: 'api' },
      page: { module: 'generators/page.mjs', part: 'ui' },
      resource: { module: 'generators/resource.mjs' },
    },
  }))
  writeFileSync(join(dir, 'generators/job.mjs'), 'export default ({ name, part }) => ({ files: [{ path: `src/jobs/${name}.ts`, content: `// job ${name} in part ${part.type}\\n` }] })\n')
  writeFileSync(join(dir, 'generators/page.mjs'), 'export default ({ name }) => ({ files: [{ path: `app/pages/${name}.vue`, content: `<template>from the module</template>\\n` }] })\n')
  writeFileSync(join(dir, 'generators/resource.mjs'), 'export default async ({ name, manifest }) => ({ files: [{ path: `docs/${name}.md`, content: `${manifest.kind}\\n` }, { path: `../escape.md`, content: `x` }] })\n')
  return kit
}

describe('add — generator dispatch', () => {
  it('a crashing generator is an internal error (exit 70), never exit 1 = drift', () => {
    const kit = kitWithGenerators()
    writeFileSync(join(kit, 'modules/gen-test/generators/job.mjs'), 'export default () => { throw new Error("generator bug") }\n')
    const r = cli(['add', 'job', 'x', '--dir', project('api', kit, ['--with', 'gen-test']), '--json'], { kit })
    expect(r.status).toBe(70)
    expect(r.json).toMatchObject({ ok: false, code: 'internal', message: 'generator bug' })
  })

  it('nuxt-app: `add page` runs the generator the kind contributes', () => {
    const dir = project('nuxt-app')
    const r = cli(['add', 'page', 'order-history', '--dir', dir, '--json'])
    expect(r.status).toBe(0)
    expect(r.json).toMatchObject({ ok: true, type: 'page', name: 'order-history', generator: 'nuxt-app', files: ['app/pages/order-history.vue'] })
    expect(read(dir, 'app/pages/order-history.vue')).toContain('Order History')
  })

  it('fullstack: the page lands in the ui part; the default dir is the cwd', () => {
    const dir = project('fullstack')
    const r = cli(['add', 'page', 'reports', '--json'], { cwd: dir })
    expect(r.json.files).toEqual(['ui/app/pages/reports.vue'])
    expect(read(dir, 'ui/app/pages/reports.vue')).toContain('Reports')
  })

  it('never overwrites: adding the same name twice is exit 3', () => {
    const dir = project('nuxt-app')
    expect(cli(['add', 'page', 'reports', '--dir', dir, '--json']).status).toBe(0)
    const again = cli(['add', 'page', 'reports', '--dir', dir, '--json'])
    expect(again.status).toBe(3)
    expect(again.json).toMatchObject({ ok: false, code: 'exists' })
  })

  it('a type nothing in the project provides is exit 4', () => {
    for (const [kind, type] of [['nuxt-app', 'resource'], ['nuxt-app', 'job'], ['api', 'page'], ['api', 'resource']]) {
      const r = cli(['add', type, 'thing', '--dir', project(kind), '--json'])
      expect(r.status, `${kind} ${type}`).toBe(4)
      expect(r.json.code).toBe('no_generator')
    }
  })

  it('an installed module contributes generators, overrides the kind, and targets a part', () => {
    const kit = kitWithGenerators()
    const dir = project('fullstack', kit, ['--with', 'gen-test'])
    const job = cli(['add', 'job', 'nightly-sync', '--dir', dir, '--json'], { kit })
    expect(job.json).toMatchObject({ generator: 'gen-test', files: ['api/src/jobs/nightly-sync.ts'] })
    expect(read(dir, 'api/src/jobs/nightly-sync.ts')).toBe('// job nightly-sync in part api\n')
    const page = cli(['add', 'page', 'reports', '--dir', dir, '--json'], { kit })
    expect(page.json.generator).toBe('gen-test')
    expect(read(dir, 'ui/app/pages/reports.vue')).toContain('from the module')
    expect(cli(['list', '--json'], { kit }).json.modules.find((m: any) => m.name === 'gen-test').generators).toEqual(['job', 'page', 'resource'])
  })

  it('a module that is not installed in the project contributes nothing; a missing part is exit 4', () => {
    const kit = kitWithGenerators()
    expect(cli(['add', 'job', 'x', '--dir', project('api', kit), '--json'], { kit }).status).toBe(4)
    const uiOnly = project('nuxt-app', kit, ['--with', 'gen-test'])
    const r = cli(['add', 'job', 'x', '--dir', uiOnly, '--json'], { kit })
    expect(r.status).toBe(4)
    expect(r.json.message).toContain('needs a "api" part')
  })

  it('a generator cannot write outside the project', () => {
    const kit = kitWithGenerators()
    const dir = project('api', kit, ['--with', 'gen-test'])
    const r = cli(['add', 'resource', 'thing', '--dir', dir, '--json'], { kit })
    expect(r.status).toBe(2)
    expect(r.json.code).toBe('path_escape')
    expect(() => read(dir, 'docs/thing.md')).toThrow() // all or nothing
    expect(() => read(dir, '../escape.md')).toThrow()
  })

  it('patches insert at a `kit:anchor` comment, keep its indent, and may target another part', () => {
    const kit = kitWithGenerators()
    writeFileSync(join(kit, 'modules/gen-test/generators/job.mjs'), `export default ({ name }) => ({
      files: [{ path: 'src/jobs/' + name + '.ts', content: 'x\\n' }, { part: 'ui', path: 'app/pages/' + name + '.vue', content: '<template />\\n' }, { part: 'project', path: 'docs/' + name + '.md', content: 'doc\\n' }],
      patches: [
        { path: 'src/app.ts', anchor: 'routes', insert: "register('" + name + "')\\n" },
        { path: 'src/app.ts', anchor: 'imports', insert: "import './jobs/" + name + ".js'" },
      ],
    })\n`)
    const dir = project('fullstack', kit, ['--with', 'gen-test'])
    writeFileSync(join(dir, 'api/src/app.ts'), "// kit:anchor imports\nfunction boot() {\n  // kit:anchor routes — keep this line\n}\n")
    const r = cli(['add', 'job', 'sync', '--dir', dir, '--json'], { kit })
    expect(r.status).toBe(0)
    expect(r.json.files).toEqual(['api/src/jobs/sync.ts', 'ui/app/pages/sync.vue', 'docs/sync.md'])
    expect(r.json.patched).toEqual(['api/src/app.ts'])
    expect(read(dir, 'api/src/app.ts')).toBe("import './jobs/sync.js'\n// kit:anchor imports\nfunction boot() {\n  register('sync')\n  // kit:anchor routes — keep this line\n}\n")

    // a second job lands above the anchor too, below the first
    cli(['add', 'job', 'other', '--dir', dir, '--json'], { kit })
    expect(read(dir, 'api/src/app.ts')).toContain("  register('sync')\n  register('other')\n  // kit:anchor routes")

    // in a project without a ui part the ui file is skipped
    const apiOnly = project('api', kit, ['--with', 'gen-test'])
    writeFileSync(join(apiOnly, 'src/app.ts'), '// kit:anchor imports\n// kit:anchor routes\n')
    expect(cli(['add', 'job', 'sync', '--dir', apiOnly, '--json'], { kit }).json.files).toEqual(['src/jobs/sync.ts', 'docs/sync.md'])
  })

  it('a missing anchor stops everything (exit 2) and says what to add by hand', () => {
    const kit = kitWithGenerators()
    writeFileSync(join(kit, 'modules/gen-test/generators/job.mjs'), `export default ({ name }) => ({
      files: [{ path: 'src/jobs/' + name + '.ts', content: 'x\\n' }],
      patches: [{ path: 'src/app.ts', anchor: 'routes', insert: "register('" + name + "')" }],
    })\n`)
    const dir = project('api', kit, ['--with', 'gen-test'])
    const before = read(dir, 'src/app.ts')
    const r = cli(['add', 'job', 'sync', '--dir', dir, '--json'], { kit })
    expect(r.status).toBe(2)
    expect(r.json.code).toBe('anchor_missing')
    expect(r.json.message).toContain("register('sync')")
    expect(read(dir, 'src/app.ts')).toBe(before)
    expect(() => read(dir, 'src/jobs/sync.ts')).toThrow() // all or nothing
  })
})
