// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanup, cli, cloneKit, tmp } from './helpers'
import rootPkg from '../../package.json'

afterAll(cleanup)
const target = () => join(tmp('cli'), 'app')

describe('exit codes', () => {
  it('0 — ok', () => {
    expect(cli(['new', 'demo-app', '--kind', 'api', '--dir', target(), '--json']).status).toBe(0)
    expect(cli(['list', '--json']).status).toBe(0)
    expect(cli(['--help']).status).toBe(0)
  })

  it.each([
    ['no command', []],
    ['unknown command', ['frobnicate']],
    ['missing name', ['new', '--kind', 'api', '--dir', 'x']],
    ['bad name', ['new', 'Demo_App', '--kind', 'api', '--dir', 'x']],
    ['missing --kind', ['new', 'demo-app', '--dir', 'x']],
    ['missing --dir', ['new', 'demo-app', '--kind', 'api']],
    ['unknown flag', ['new', 'demo-app', '--kind', 'api', '--dir', 'x', '--frob']],
    ['bad --port', ['new', 'demo-app', '--kind', 'api', '--dir', 'x', '--port', '99999']],
    ['bad --db value', ['new', 'demo-app', '--kind', 'api', '--dir', 'x', '--db', 'oracle']],
    ['missing --context file', ['new', 'demo-app', '--kind', 'api', '--dir', 'x', '--context', '/nonexistent/ctx.json']],
    ['extra argument', ['new', 'demo-app', 'extra', '--kind', 'api', '--dir', 'x']],
    ['add: unknown type', ['add', 'widget', 'x']],
    ['add: bad name', ['add', 'page', 'Bad Name']],
  ])('2 — usage: %s', (_label, args) => {
    const r = cli([...args, '--json'], { cwd: tmp('usage') })
    expect(r.status).toBe(2)
    if (args.length) expect(r.json).toMatchObject({ ok: false })
  })

  it('2 — check / update / add outside a scaffolded project', () => {
    const dir = tmp('empty')
    for (const args of [['check', dir], ['update', dir], ['add', 'page', 'x', '--dir', dir]]) {
      const r = cli([...args, '--json'])
      expect(r.status, args.join(' ')).toBe(2)
      expect(r.json).toMatchObject({ ok: false, code: 'not_scaffolded' })
    }
  })

  it('3 — target dir exists and is not empty (and nothing is written)', () => {
    const dir = tmp('busy')
    writeFileSync(join(dir, 'keep.txt'), 'mine')
    const r = cli(['new', 'demo-app', '--kind', 'api', '--dir', dir, '--json'])
    expect(r.status).toBe(3)
    expect(r.json).toMatchObject({ ok: false, code: 'dir_not_empty' })
    // an existing empty dir is fine
    const empty = join(tmp('empty'), 'app')
    mkdirSync(empty)
    expect(cli(['new', 'demo-app', '--kind', 'api', '--dir', empty, '--json']).status).toBe(0)
  })

  it.each([
    ['unknown kind', ['--kind', 'django'], 'unknown_kind'],
    ['unknown module', ['--kind', 'api', '--with', 'nope'], 'unknown_module'],
    ['unknown preset', ['--kind', 'api', '--deploy', 'heroku'], 'unknown_preset'],
    ['cf-pages on api', ['--kind', 'api', '--deploy', 'cf-pages'], 'incompatible_preset'],
    ['cf-pages on fullstack', ['--kind', 'fullstack', '--deploy', 'cf-pages'], 'incompatible_preset'],
    ['--db without the db module', ['--kind', 'api', '--db', 'sqlite'], 'incompatible_db'],
  ])('4 — %s', (_label, args, code) => {
    const dir = target()
    const r = cli(['new', 'demo-app', ...args, '--dir', dir, '--json'])
    expect(r.status).toBe(4)
    expect(r.json).toEqual({ ok: false, code, message: expect.any(String) })
    expect(cli(['check', dir, '--json']).status).toBe(2) // nothing was written
  })

  it('4 — a planned module is listed but refused with a clear message, also when another module requires it', () => {
    const kit = cloneKit()
    mkdirSync(join(kit, 'modules', 'uploads'), { recursive: true })
    writeFileSync(join(kit, 'modules', 'uploads', 'module.json'), JSON.stringify({ name: 'uploads', status: 'planned', description: 'not built yet', kinds: ['api'], requires: [] }))
    expect(cli(['list', '--json'], { kit }).json.modules.find((m: any) => m.name === 'uploads')).toMatchObject({ status: 'planned', kinds: ['api'] })
    const dir = target()
    const r = cli(['new', 'demo-app', '--kind', 'api', '--with', 'uploads', '--dir', dir, '--json'], { kit })
    expect(r.status).toBe(4)
    expect(r.json).toEqual({ ok: false, code: 'planned_module', message: expect.stringMatching(/module "uploads" is planned but not available in kit/) })
    expect(cli(['check', dir, '--json'], { kit }).status).toBe(2) // nothing was written
    // whatever is still planned in the real kit behaves the same
    for (const m of cli(['list', '--json']).json.modules.filter((m: any) => m.status === 'planned')) {
      expect(cli(['new', 'demo-app', '--kind', m.kinds[0], '--with', m.name, '--dir', target(), '--json']).status, m.name).toBe(4)
    }
  })

  it('4 — a ready module on a kind it does not support; requires pulls modules in', () => {
    const kit = cloneKit()
    const mod = (name: string, extra: object) => {
      mkdirSync(join(kit, 'modules', name), { recursive: true })
      writeFileSync(join(kit, 'modules', name, 'module.json'), JSON.stringify({ name, status: 'ready', description: '', requires: [], ...extra }))
    }
    mod('ui-only', { kinds: ['nuxt-app'] })
    mod('needs-ci', { kinds: ['api'], requires: ['ci-github'] })
    mod('later', { kinds: ['api'], status: 'planned' })
    mod('needs-planned', { kinds: ['api'], requires: ['later'] })
    const bad = cli(['new', 'demo-app', '--kind', 'api', '--with', 'ui-only', '--dir', target(), '--json'], { kit })
    expect(bad.status).toBe(4)
    expect(bad.json.code).toBe('incompatible_module')
    const ok = cli(['new', 'demo-app', '--kind', 'api', '--with', 'needs-ci', '--dir', target(), '--json'], { kit })
    expect(ok.json.modules).toEqual(['base', 'ci-github', 'needs-ci'])
    const viaPlanned = cli(['new', 'demo-app', '--kind', 'api', '--with', 'needs-planned', '--dir', target(), '--json'], { kit })
    expect(viaPlanned.status).toBe(4)
    expect(viaPlanned.json.message).toContain('required by needs-planned')
  })

  it('errors go to stderr without --json, as JSON on stdout with it', () => {
    const plain = cli(['new', 'demo-app', '--kind', 'django', '--dir', target()])
    expect(plain.status).toBe(4)
    expect(plain.stdout).toBe('')
    expect(plain.stderr).toContain('unknown kind "django"')
  })
})

describe('list', () => {
  it('--json: kinds, modules (status, kinds, requires), deploy presets, kitVersion', () => {
    const { json } = cli(['list', '--json'])
    expect(json.ok).toBe(true)
    expect(json.kitVersion).toBe(rootPkg.version)
    expect(json.kinds.map((k: any) => k.name)).toEqual(['api', 'fullstack', 'nuxt-app'])
    expect(json.kinds.find((k: any) => k.name === 'fullstack').parts).toEqual([{ type: 'api', dir: 'api' }, { type: 'ui', dir: 'ui' }])
    expect(json.modules.find((m: any) => m.name === 'base')).toMatchObject({ status: 'ready', implicit: true, kinds: ['nuxt-app', 'api', 'fullstack'], requires: [] })
    expect(json.modules.find((m: any) => m.name === 'ci-github')).toMatchObject({ status: 'ready', implicit: false })
    expect(json.deploy.map((p: any) => [p.name, p.kinds])).toEqual([
      ['cf-pages', ['nuxt-app']],
      ['container', ['nuxt-app', 'api', 'fullstack']],
      ['pm2', ['nuxt-app', 'api', 'fullstack']],
    ])
  })

  it('AI_KIT_DIR selects the kit', () => {
    expect(cli(['list', '--json'], { kit: cloneKit('7.7.7') }).json.kitVersion).toBe('7.7.7')
  })
})
