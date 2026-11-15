// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

// Finding #2: gitleaks (rule generic-api-key) stopped the very first commit of a fresh project on the bare sha256 of
// `…/kit/auth/tokens.ts` in .scaffold.json. The hash is now written as `sha256:<hex>`.
describe('.scaffold.json and secret scanners', () => {
  const FULL = ['--kind', 'fullstack', '--with', 'db,auth,api,trace,og,security,jobs,notify', '--deploy', 'container']

  it('locked hashes carry the algorithm prefix; none is a bare hex string', () => {
    const locked = JSON.parse(read(project(FULL), '.scaffold.json')).locked as Record<string, string>
    expect(Object.keys(locked).length).toBeGreaterThan(30)
    for (const [path, hash] of Object.entries(locked)) expect(hash, path).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('a manifest with bare hashes (kit <= 0.2.0) is still clean; update rewrites it in the new form and changes no file', () => {
    const dir = project(FULL)
    const file = join(dir, '.scaffold.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    for (const path of Object.keys(manifest.locked)) manifest.locked[path] = manifest.locked[path].replace(/^sha256:/, '')
    writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
    const before = snapshot(dir)
    const check = cli(['check', dir, '--json'])
    expect(check.status, check.stdout).toBe(0)
    expect(check.json.drift).toEqual([])
    // an edit is still found through the old form
    appendFileSync(join(dir, 'api/src/kit/auth/tokens.ts'), '\n// edited\n')
    expect(cli(['check', dir, '--json']).json.drift).toEqual([{ path: 'api/src/kit/auth/tokens.ts', reason: 'modified' }])
    const update = cli(['update', dir, '--json'])
    expect(update.json.updated).toEqual(['api/src/kit/auth/tokens.ts'])
    const after = snapshot(dir)
    expect(Object.keys(after).filter((path) => after[path] !== before[path])).toEqual(['.scaffold.json'])
    for (const hash of Object.values(JSON.parse(readFileSync(file, 'utf8')).locked)) expect(hash).toMatch(/^sha256:/)
  })

  const hasGitleaks = !spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).error
  if (!hasGitleaks) process.stderr.write('SKIPPED: gitleaks is not installed — the default-config scan of a fresh scaffold did not run (the kit gate and CI run it)\n')
  it.skipIf(!hasGitleaks)('a fresh project passes `gitleaks protect --staged` and `gitleaks detect` with the default config — and the scan is real', () => {
    const dir = project(FULL)
    // no repo config and no machine-wide one: the scanner's built-in rules
    const env = { ...process.env, GITLEAKS_CONFIG: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=kit', '-c', 'user.email=kit@example.invalid', ...args], { cwd: dir, env, encoding: 'utf8' })
    expect(git('init', '-q').status).toBe(0)
    expect(git('add', '-A').status).toBe(0)
    const staged = spawnSync('gitleaks', ['protect', '--staged', '--no-banner', '--redact', '-v'], { cwd: dir, env, encoding: 'utf8' })
    expect(staged.status, staged.stdout + staged.stderr).toBe(0)
    expect(git('commit', '-q', '-m', 'scaffold').status).toBe(0)
    const detect = spawnSync('gitleaks', ['detect', '--source', '.', '--no-banner', '--redact', '-v'], { cwd: dir, env, encoding: 'utf8' })
    expect(detect.status, detect.stdout + detect.stderr).toBe(0)

    // the same scan does fail on the old form — so the two green runs above mean something
    const file = join(dir, '.scaffold.json')
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('"sha256:', '"'))
    git('add', '-A')
    const old = spawnSync('gitleaks', ['protect', '--staged', '--no-banner', '--redact', '-v'], { cwd: dir, env, encoding: 'utf8' })
    expect(old.status).toBe(1)
    expect(old.stdout + old.stderr).toMatch(/\.scaffold\.json/)
  })
})

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
    expect(r.json.kit).toEqual({ from: '1.0.0', to: '1.2.0', commit: null, unreleased: false })
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

describe('layer tag: nuxt.config.ts is what counts (t1088)', () => {
  const ref = (v: string) => `github:like12like12s/nuxt-base#v${v}`

  it('a tag edited by hand to an older one is drift although .scaffold.json still says the new one', () => {
    const kit = cloneKit('1.2.0')
    for (const [kind, config] of [['nuxt-app', 'nuxt.config.ts'], ['fullstack', 'ui/nuxt.config.ts']] as const) {
      const dir = project(['--kind', kind], kit)
      expect(cli(['check', dir, '--json'], { kit }).status, kind).toBe(0)
      writeFileSync(join(dir, config), read(dir, config).replace(ref('1.2.0'), ref('1.1.0')))
      expect(JSON.parse(read(dir, '.scaffold.json')).layerRef).toBe(ref('1.2.0'))
      const r = cli(['check', dir, '--json'], { kit })
      expect(r.status, kind).toBe(1)
      expect(r.json).toMatchObject({ clean: false, drift: [], layer: { current: ref('1.1.0'), latest: ref('1.2.0'), behind: true } })

      const u = cli(['update', dir, '--json'], { kit })
      expect(u.json.layer).toEqual({ from: ref('1.1.0'), to: ref('1.2.0'), file: config })
      expect(read(dir, config)).toContain(`extends: ['${ref('1.2.0')}']`)
      expect(cli(['check', dir, '--json'], { kit }).status, kind).toBe(0)
    }
  })

  it('a stale manifest does not hide it either way: config ahead of the manifest is clean, and update records it', () => {
    const kit = cloneKit('1.0.0')
    const dir = project(['--kind', 'nuxt-app'], kit)
    setKitVersion(kit, '1.1.0')
    // bumped by hand in nuxt.config.ts only
    writeFileSync(join(dir, 'nuxt.config.ts'), read(dir, 'nuxt.config.ts').replace(ref('1.0.0'), ref('1.1.0')))
    const r = cli(['check', dir, '--json'], { kit })
    expect(r.json.layer).toEqual({ current: ref('1.1.0'), latest: ref('1.1.0'), behind: false })
    expect(r.status).toBe(0)
    cli(['update', dir, '--json'], { kit })
    expect(JSON.parse(read(dir, '.scaffold.json')).layerRef).toBe(ref('1.1.0'))
  })

  // L11: inside() is lexical — a symlink in the project used to make `update` / `add` overwrite a file outside it
  it('never writes through a symlink that leaves the project: update and add stop (exit 2), the outside file is untouched', () => {
    const dir = project(['--kind', 'api', '--with', 'jobs'])
    const outside = tmp('outside')
    writeFileSync(join(outside, 'victim.ts'), 'do not touch\n')

    // a locked file replaced by a link to a file elsewhere
    rmSync(join(dir, 'src/kit/api/env.ts'))
    symlinkSync(join(outside, 'victim.ts'), join(dir, 'src/kit/api/env.ts'))
    const update = cli(['update', dir, '--json'])
    expect(update.status).toBe(2)
    expect(update.json).toMatchObject({ ok: false, code: 'path_escape' })
    expect(readFileSync(join(outside, 'victim.ts'), 'utf8')).toBe('do not touch\n')
    rmSync(join(dir, 'src/kit/api/env.ts'))
    expect(cli(['update', dir, '--json']).status).toBe(0) // the link gone, update restores the real file

    // a directory the generator writes into, linked out of the project
    rmSync(join(dir, 'src/jobs'), { recursive: true })
    mkdirSync(join(outside, 'jobs'))
    writeFileSync(join(outside, 'jobs/index.ts'), '// kit:anchor job-imports\nexport const jobs = {\n  // kit:anchor jobs\n}\n')
    symlinkSync(join(outside, 'jobs'), join(dir, 'src/jobs'))
    const add = cli(['add', 'job', 'nightly', '--dir', dir, '--json'])
    expect(add.status).toBe(2)
    expect(add.json.code).toBe('path_escape')
    expect(readdirSync(join(outside, 'jobs'))).toEqual(['index.ts'])
    expect(readFileSync(join(outside, 'jobs/index.ts'), 'utf8')).not.toContain('nightly')
  })

  it('links that stay inside the project keep working (the `api -> .` service dir of a container project)', () => {
    const dir = project(['--kind', 'api', '--deploy', 'container'])
    appendFileSync(join(dir, 'src/kit/api/env.ts'), '\n// edited\n')
    expect(cli(['update', dir, '--json']).json.updated).toEqual(['src/kit/api/env.ts'])
    expect(cli(['check', dir, '--json']).status).toBe(0)
  })
})
