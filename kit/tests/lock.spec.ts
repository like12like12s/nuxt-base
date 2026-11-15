// @vitest-environment node
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanup, cli, cloneKit, read, setKitVersion, snapshot, tmp } from './helpers'

afterAll(cleanup)

function project(args: string[], kit?: string) {
  const dir = join(tmp('lock'), 'app')
  const r = cli(['new', 'demo-app', ...args, '--dir', dir, '--json'], { kit })
  expect(r.status).toBe(0)
  return dir
}

describe('check', () => {
  it('a fresh project is clean (exit 0)', () => {
    for (const kind of ['nuxt-app', 'api', 'fullstack']) {
      const r = cli(['check', project(['--kind', kind, '--deploy', 'container']), '--json'])
      expect(r.status, kind).toBe(0)
      expect(r.json).toMatchObject({ ok: true, clean: true, drift: [] })
    }
  })

  it('an edited locked file is drift (exit 1); the default dir is the cwd', () => {
    const dir = project(['--kind', 'api'])
    appendFileSync(join(dir, 'src/kit/api/env.ts'), '\n// local tweak\n')
    const r = cli(['check', '--json'], { cwd: dir })
    expect(r.status).toBe(1)
    expect(r.json.clean).toBe(false)
    expect(r.json.drift).toEqual([{ path: 'src/kit/api/env.ts', reason: 'modified' }])
    const plain = cli(['check', dir])
    expect(plain.status).toBe(1)
    expect(plain.stdout).toContain('modified  src/kit/api/env.ts')
  })

  it('a missing locked file is drift (exit 1)', () => {
    const dir = project(['--kind', 'fullstack', '--deploy', 'container'])
    rmSync(join(dir, 'api/Dockerfile'))
    const r = cli(['check', dir, '--json'])
    expect(r.status).toBe(1)
    expect(r.json.drift).toEqual([{ path: 'api/Dockerfile', reason: 'missing' }])
  })

  it('editing app-owned files is not drift', () => {
    const dir = project(['--kind', 'api'])
    appendFileSync(join(dir, 'src/app.ts'), '\n// my route\n')
    appendFileSync(join(dir, 'README.md'), '\nnotes\n')
    expect(cli(['check', dir, '--json']).status).toBe(0)
  })

  it('a newer kit: changed, added and removed locked files are drift', () => {
    const kit = cloneKit('1.0.0')
    const dir = project(['--kind', 'api'], kit)
    appendFileSync(join(kit, 'runtime/api/log.ts'), '\n// kit v2\n')
    const kindFile = join(kit, 'kinds/api/kind.json')
    const kind = JSON.parse(read(kit, 'kinds/api/kind.json'))
    kind.contributes.api.locked = kind.contributes.api.locked.filter((l: any) => l.to !== 'src/kit/api/shutdown.ts')
    writeFileSync(join(kit, 'runtime/api/extra.ts'), '// DO NOT EDIT\nexport const extra = 1\n')
    kind.contributes.api.locked.push({ from: 'runtime/api/extra.ts', to: 'src/kit/api/extra.ts' })
    writeFileSync(kindFile, JSON.stringify(kind))
    const r = cli(['check', dir, '--json'], { kit })
    expect(r.status).toBe(1)
    expect(r.json.drift).toEqual([
      { path: 'src/kit/api/extra.ts', reason: 'new-in-kit' },
      { path: 'src/kit/api/log.ts', reason: 'outdated' },
      { path: 'src/kit/api/shutdown.ts', reason: 'removed-from-kit' },
    ])
  })

  it('a layer tag behind the kit is drift; a custom ref (local path, newer tag) is not', () => {
    const kit = cloneKit('1.0.0')
    const dir = project(['--kind', 'nuxt-app'], kit)
    expect(cli(['check', dir, '--json'], { kit }).status).toBe(0)
    setKitVersion(kit, '1.1.0')
    const r = cli(['check', dir, '--json'], { kit })
    expect(r.status).toBe(1)
    expect(r.json.drift).toEqual([])
    expect(r.json.layer).toEqual({ current: 'github:like12like12s/nuxt-base#v1.0.0', latest: 'github:like12like12s/nuxt-base#v1.1.0', behind: true })
    expect(cli(['check', dir], { kit }).stdout).toContain('layer-behind')

    const ctx = join(tmp('ctx'), 'ctx.json')
    writeFileSync(ctx, JSON.stringify({ layerRef: '/somewhere/nuxt-base' }))
    const local = project(['--kind', 'nuxt-app', '--context', ctx], kit)
    expect(cli(['check', local, '--json'], { kit }).status).toBe(0)
    // an api project has no layer at all
    const api = project(['--kind', 'api'], kit)
    expect(cli(['check', api, '--json'], { kit }).json.layer).toBeNull()
  })
})

describe('update', () => {
  it('restores edited and missing locked files and leaves app-owned files alone', () => {
    const dir = project(['--kind', 'fullstack', '--deploy', 'container'])
    const before = snapshot(dir)
    appendFileSync(join(dir, 'api/src/kit/api/env.ts'), '\n// local tweak\n')
    rmSync(join(dir, 'ui/Dockerfile'))
    appendFileSync(join(dir, 'api/src/app.ts'), '\n// my route\n')
    mkdirSync(join(dir, 'api/src/routes'))
    writeFileSync(join(dir, 'api/src/routes/mine.ts'), 'export {}\n')
    expect(cli(['check', dir, '--json']).status).toBe(1)

    const r = cli(['update', dir, '--json'])
    expect(r.status).toBe(0)
    expect(r.json.updated).toEqual(['api/src/kit/api/env.ts', 'ui/Dockerfile'])
    expect(cli(['check', dir, '--json']).status).toBe(0)
    const after = snapshot(dir)
    expect(after['api/src/kit/api/env.ts']).toBe(before['api/src/kit/api/env.ts'])
    expect(after['ui/Dockerfile']).toBe(before['ui/Dockerfile'])
    expect(read(dir, 'api/src/app.ts')).toContain('// my route')
    expect(after['api/src/routes/mine.ts']).toBeTruthy()
    // nothing else changed
    for (const path of Object.keys(before)) if (path !== 'api/src/app.ts') expect(after[path], path).toBe(before[path])
  })

  it('on a clean project changes nothing', () => {
    const dir = project(['--kind', 'nuxt-app', '--deploy', 'pm2'])
    const before = snapshot(dir)
    const r = cli(['update', dir, '--json'])
    expect(r.json).toMatchObject({ ok: true, updated: [], orphaned: [], layer: null, warnings: [] })
    expect(snapshot(dir)).toEqual(before)
  })

  it('moves a project to a newer kit: locked files, layer tag in nuxt.config.ts and .scaffold.json — nothing else', () => {
    const kit = cloneKit('1.0.0')
    const dir = project(['--kind', 'fullstack'], kit)
    appendFileSync(join(dir, 'ui/app/pages/index.vue'), '\n<!-- mine -->\n')
    const before = snapshot(dir)
    setKitVersion(kit, '1.2.0')
    appendFileSync(join(kit, 'runtime/api/log.ts'), '\n// kit 1.2\n')

    const r = cli(['update', dir, '--json'], { kit })
    expect(r.status).toBe(0)
    expect(r.json.updated).toEqual(['api/src/kit/api/log.ts'])
    expect(r.json.kit).toEqual({ from: '1.0.0', to: '1.2.0' })
    expect(r.json.layer).toEqual({ from: 'github:like12like12s/nuxt-base#v1.0.0', to: 'github:like12like12s/nuxt-base#v1.2.0', file: 'ui/nuxt.config.ts' })
    expect(read(dir, 'ui/nuxt.config.ts')).toContain(`extends: ['github:like12like12s/nuxt-base#v1.2.0']`)
    expect(read(dir, 'api/src/kit/api/log.ts')).toContain('// kit 1.2')
    const manifest = JSON.parse(read(dir, '.scaffold.json'))
    expect(manifest).toMatchObject({ kit: '1.2.0', layerRef: 'github:like12like12s/nuxt-base#v1.2.0' })
    expect(cli(['check', dir, '--json'], { kit }).status).toBe(0)

    const after = snapshot(dir)
    const changed = Object.keys(after).filter((p) => after[p] !== before[p]).sort()
    expect(changed).toEqual(['.scaffold.json', 'api/src/kit/api/log.ts', 'ui/nuxt.config.ts'])
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
  })

  it('a locked file the kit no longer ships is left in place and dropped from the manifest', () => {
    const kit = cloneKit('1.0.0')
    const dir = project(['--kind', 'api'], kit)
    const kind = JSON.parse(read(kit, 'kinds/api/kind.json'))
    kind.contributes.api.locked = kind.contributes.api.locked.filter((l: any) => l.to !== 'src/kit/api/shutdown.ts')
    writeFileSync(join(kit, 'kinds/api/kind.json'), JSON.stringify(kind))
    const r = cli(['update', dir, '--json'], { kit })
    expect(r.json.orphaned).toEqual(['src/kit/api/shutdown.ts'])
    expect(read(dir, 'src/kit/api/shutdown.ts')).toContain('gracefulShutdown')
    expect(Object.keys(JSON.parse(read(dir, '.scaffold.json')).locked)).not.toContain('src/kit/api/shutdown.ts')
    expect(cli(['check', dir, '--json'], { kit }).status).toBe(0)
  })

  it('warns instead of guessing when the layer tag is no longer in nuxt.config.ts', () => {
    const kit = cloneKit('1.0.0')
    const dir = project(['--kind', 'nuxt-app'], kit)
    writeFileSync(join(dir, 'nuxt.config.ts'), `export default defineNuxtConfig({ extends: [process.env.LAYER!] })\n`)
    setKitVersion(kit, '1.1.0')
    const r = cli(['update', dir, '--json'], { kit })
    expect(r.status).toBe(0)
    expect(r.json.layer).toBeNull()
    expect(r.json.warnings[0]).toContain('by hand')
    expect(cli(['check', dir, '--json'], { kit }).status).toBe(1) // still behind — not papered over
  })
})
