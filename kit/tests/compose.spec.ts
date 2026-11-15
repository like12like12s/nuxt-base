// @vitest-environment node
import { existsSync, lstatSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanup, cli, read, snapshot, tmp } from './helpers'
// @ts-expect-error plain ESM, no types
import { compose } from '../lib/compose.mjs'
// @ts-expect-error plain ESM, no types
import { loadKit } from '../lib/kit.mjs'
import rootPkg from '../../package.json'

afterAll(cleanup)
const kit = loadKit()

const KINDS = ['nuxt-app', 'api', 'fullstack']
const COMBOS: [string, string | undefined][] = []
for (const kind of KINDS) for (const deploy of [undefined, 'container', 'pm2', ...(kind === 'nuxt-app' ? ['cf-pages'] : [])]) COMBOS.push([kind, deploy])

function scaffold(args: string[], label = 'app') {
  const dir = join(tmp(label), 'app')
  const r = cli(['new', 'demo-app', ...args, '--dir', dir, '--json'])
  return { dir, r }
}

describe('new — composition', () => {
  it.each(COMBOS)('%s + deploy %s: every kind gets the base files, .gitignore first', (kind, deploy) => {
    const { dir, r } = scaffold(['--kind', kind, ...(deploy ? ['--deploy', deploy] : [])])
    expect(r.status).toBe(0)
    expect(r.json.files[0]).toBe('.gitignore')
    for (const f of ['.gitignore', 'README.md', 'brief.md', '.scaffold.json', 'package.json', 'scripts/gate-ci.mjs',
      '.memory/docs/context/context.md', '.memory/docs/guides/usage.md', '.memory/docs/changelog/changelog.md']) {
      expect(r.json.files, f).toContain(f)
      expect(existsSync(join(dir, f)), f).toBe(true)
    }
    // every listed file exists and no template variable survived rendering
    for (const f of r.json.files) {
      expect(existsSync(join(dir, f)), f).toBe(true)
      if (lstatSync(join(dir, f)).isFile()) expect(read(dir, f), f).not.toMatch(/\{\{kit\./)
    }
    const pkg = JSON.parse(read(dir, 'package.json'))
    expect(pkg.scripts.gate).toBeTruthy()
    expect(pkg.scripts['gate:ci']).toBe('node scripts/gate-ci.mjs')
    for (const doc of ['context/context.md', 'guides/usage.md', 'changelog/changelog.md']) {
      expect(read(dir, `.memory/docs/${doc}`)).toMatch(/^---\nname: demo-app-\w+\ndescription: .+\n---\n/)
    }
  })

  it('--json for `new` has exactly the contract keys', () => {
    const { r } = scaffold(['--kind', 'api', '--port', '3920'])
    expect(Object.keys(r.json)).toEqual(['ok', 'dir', 'name', 'kind', 'modules', 'db', 'deploy', 'kitVersion', 'files', 'locked', 'services', 'env', 'backup', 'next'])
    expect(r.json).toMatchObject({ ok: true, name: 'demo-app', kind: 'api', modules: ['base'], db: null, deploy: null, kitVersion: rootPkg.version, backup: [] })
    expect(r.json.services).toEqual([{ id: 'demo-app-api', name: 'API', type: 'api', port: 3920, healthPath: '/health/live' }])
    expect(r.json.env).toContainEqual({ key: 'PORT', required: true, secret: false })
    expect(r.json.next.slice(0, 2)).toEqual(['npm install', 'npm run gate'])
  })

  it('.scaffold.json records kit, selection, answers and a sha256 per locked file', () => {
    const { dir, r } = scaffold(['--kind', 'api'])
    const m = JSON.parse(read(dir, '.scaffold.json'))
    expect(Object.keys(m)).toEqual(['kit', 'kind', 'modules', 'db', 'deploy', 'layerRef', 'answers', 'locked'])
    expect(m).toMatchObject({ kit: rootPkg.version, kind: 'api', modules: ['base'], db: null, deploy: null, layerRef: null })
    expect(Object.keys(m.locked).sort()).toEqual([...r.json.locked].sort())
    expect(Object.keys(m.locked)).toEqual(['scripts/gate-ci.mjs', 'src/kit/api/context.ts', 'src/kit/api/env.ts', 'src/kit/api/log.ts', 'src/kit/api/shutdown.ts'])
    const hashes = snapshot(dir)
    for (const [path, hash] of Object.entries(m.locked)) expect(hashes[path], path).toBe(hash)
    for (const path of Object.keys(m.locked)) expect(read(dir, path), path).toMatch(/DO NOT EDIT/)
  })

  it('nuxt-app extends the layer at the tag of this kit by default, or the layerRef from --context', () => {
    const a = scaffold(['--kind', 'nuxt-app'])
    expect(read(a.dir, 'nuxt.config.ts')).toContain(`extends: ['github:like12like12s/nuxt-base#v${rootPkg.version}']`)
    expect(JSON.parse(read(a.dir, '.scaffold.json')).layerRef).toBe(`github:like12like12s/nuxt-base#v${rootPkg.version}`)
    expect(existsSync(join(a.dir, 'DESIGN.md'))).toBe(true)
    expect(existsSync(join(a.dir, 'tests/e2e/app.spec.ts'))).toBe(true)
    expect(read(a.dir, 'tests/e2e/app.spec.ts')).toMatch(/pageerror/)

    const ctx = join(tmp('ctx'), 'ctx.json')
    writeFileSync(ctx, JSON.stringify({ title: `Bob's "App"`, layerRef: 'github:like12like12s/nuxt-base#v0.0.1' }))
    const b = scaffold(['--kind', 'nuxt-app', '--context', ctx])
    expect(read(b.dir, 'nuxt.config.ts')).toContain(`extends: ['github:like12like12s/nuxt-base#v0.0.1']`)
    // a title with quotes still yields valid source
    expect(read(b.dir, 'app/app.config.ts')).toContain(`name: ${JSON.stringify(`Bob's "App"`)}`)
  })

  it('the nuxt-app template pins the same dependency ranges as the layer itself', () => {
    const { dir } = scaffold(['--kind', 'nuxt-app'])
    const pkg = JSON.parse(read(dir, 'package.json'))
    const layer: Record<string, string> = { ...rootPkg.peerDependencies, ...rootPkg.devDependencies }
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) expect(range, name).toBe(layer[name])
  })

  it('api: env schema, health route, locked runtime under src/kit, PORT in .env.example', () => {
    const { dir } = scaffold(['--kind', 'api', '--port', '3920'])
    expect(read(dir, 'src/app.ts')).toContain(`'/health/live'`)
    expect(read(dir, 'src/config.ts')).toContain('loadEnv')
    expect(read(dir, '.env.example')).toContain('PORT=3920')
    expect(existsSync(join(dir, 'DESIGN.md'))).toBe(false)
  })

  it('fullstack: api/ + ui/, root gate calls both, ui proxies /api to the api port', () => {
    const { dir, r } = scaffold(['--kind', 'fullstack', '--port', '3920'])
    const root = JSON.parse(read(dir, 'package.json'))
    expect(root.scripts.gate).toBe('npm run gate --prefix api && npm run gate --prefix ui')
    expect(root.scripts.postinstall).toContain('--prefix api')
    expect(JSON.parse(read(dir, 'api/package.json')).name).toBe('demo-app-api')
    expect(JSON.parse(read(dir, 'ui/package.json')).name).toBe('demo-app-ui')
    expect(r.json.services.map((s: any) => [s.type, s.port])).toEqual([['api', 3920], ['web', 3921]])
    expect(read(dir, 'api/.env.example')).toContain('PORT=3920')
    expect(read(dir, 'ui/nuxt.config.ts')).toContain('port: 3921')
    expect(read(dir, 'ui/.env.example')).toContain('API_URL=http://127.0.0.1:3920')
    expect(read(dir, 'ui/server/utils/api-target.ts')).toContain('http://127.0.0.1:3920')
    expect(existsSync(join(dir, 'DESIGN.md'))).toBe(true)
  })

  it('ports: --port alone is the base (api, ui = +1); with --api-port, --port is the ui port', () => {
    const ports = (args: string[]) => scaffold(['--kind', 'fullstack', ...args]).r.json.services.map((s: any) => s.port)
    expect(ports([])).toEqual([3000, 3001])
    expect(ports(['--port', '4100'])).toEqual([4100, 4101])
    expect(ports(['--api-port', '4100'])).toEqual([4100, 4101])
    expect(ports(['--port', '4200', '--api-port', '4100'])).toEqual([4100, 4200])
  })
})

describe('new — deploy presets and CI', () => {
  it('cf-pages: nitro preset + wrangler scripts', () => {
    const { dir } = scaffold(['--kind', 'nuxt-app', '--deploy', 'cf-pages'])
    expect(read(dir, 'nuxt.config.ts')).toContain(`nitro: { preset: 'cloudflare-pages' },`)
    const pkg = JSON.parse(read(dir, 'package.json'))
    expect(pkg.devDependencies.wrangler).toBeTruthy()
    expect(pkg.scripts.deploy).toContain('wrangler pages deploy dist --project-name demo-app')
    expect(read(dir, '.memory/docs/guides/usage.md')).toContain('Cloudflare Pages')
  })

  it('pm2: ecosystem with time: true and the port in env; usage documents the Pilot API, nothing is started', () => {
    const { dir } = scaffold(['--kind', 'fullstack', '--deploy', 'pm2', '--port', '3920'])
    const eco = read(dir, 'ecosystem.config.cjs')
    expect(eco.match(/time: true/g)).toHaveLength(2)
    expect(eco).toContain('PORT: 3920')
    expect(eco).toContain('PORT: 3921')
    expect(eco).toContain(`name: 'demo-app-api'`)
    const usage = read(dir, '.memory/docs/guides/usage.md')
    expect(usage).toContain('Pilot API')
    expect(usage).toContain('/projects/demo-app/stages/')
  })

  it('container: locked Dockerfiles, compose + deploy.conf filled from --context, placeholders otherwise', () => {
    const plain = scaffold(['--kind', 'fullstack', '--deploy', 'container', '--port', '3920'])
    expect(plain.r.json.locked).toEqual(expect.arrayContaining(['api/Dockerfile', 'api/.dockerignore', 'ui/Dockerfile', 'ui/.dockerignore']))
    expect(read(plain.dir, 'api/Dockerfile')).toContain('/health/live')
    expect(read(plain.dir, 'docker/docker-compose.yml')).toContain('image: registry.example.com/demo-app-api:${API_TAG:-latest}')
    expect(read(plain.dir, 'docker/deploy.conf')).toMatch(/^DEPLOY_HOST=deploy-host\b/m)
    expect(read(plain.dir, 'docker/deploy.conf')).toContain('https://demo-app.example.com/')
    expect(read(plain.dir, 'docker/deploy.conf')).toMatch(/^SERVICES="api ui"/m)

    const ctx = join(tmp('ctx'), 'ctx.json')
    writeFileSync(ctx, JSON.stringify({ deploy: { registry: 'reg.test:5000', host: 'box-1', domain: 'apps.test', user: 'svc' } }))
    const filled = scaffold(['--kind', 'fullstack', '--deploy', 'container', '--context', ctx])
    expect(read(filled.dir, 'docker/docker-compose.yml')).toContain('image: reg.test:5000/demo-app-ui:${UI_TAG:-latest}')
    const conf = read(filled.dir, 'docker/deploy.conf')
    expect(conf).toMatch(/^DEPLOY_HOST=box-1\b/m)
    expect(conf).toMatch(/^DEPLOY_USER=svc$/m)
    expect(conf).toMatch(/^PULL_REGISTRY=reg\.test:5000\b/m)
    expect(conf).toContain('https://demo-app.apps.test/')
    expect(JSON.parse(read(filled.dir, '.scaffold.json')).answers.deploy).toEqual({ registry: 'reg.test:5000', host: 'box-1', domain: 'apps.test', user: 'svc' })
  })

  it('container on a single-app repo: the service dir is a symlink to the repo root', () => {
    const web = scaffold(['--kind', 'nuxt-app', '--deploy', 'container'])
    expect(readlinkSync(join(web.dir, 'web'))).toBe('.')
    expect(web.r.json.files).toContain('web')
    expect(read(web.dir, 'docker/deploy.conf')).toMatch(/^SERVICES="web"/m)
    const api = scaffold(['--kind', 'api', '--deploy', 'container'])
    expect(readlinkSync(join(api.dir, 'api'))).toBe('.')
    expect(read(api.dir, 'docker/deploy.conf')).toMatch(/^SERVICES="api"/m)
  })

  it('gate:ci = gate + gitleaks (visible notice when absent) + npm audit --audit-level=high', () => {
    const { dir } = scaffold(['--kind', 'api'])
    const script = read(dir, 'scripts/gate-ci.mjs')
    expect(script).toContain(`['run', 'gate']`)
    expect(script).toMatch(/NOTICE: gitleaks is not installed — secret scan SKIPPED/)
    expect(script).toContain(`'--audit-level=high'`)
  })

  it('ci-github is opt-in: the workflow exists only with --with ci-github', () => {
    expect(existsSync(join(scaffold(['--kind', 'api']).dir, '.github/workflows/gate.yml'))).toBe(false)
    const { dir, r } = scaffold(['--kind', 'api', '--with', 'ci-github'])
    expect(r.json.modules).toEqual(['base', 'ci-github'])
    expect(read(dir, '.github/workflows/gate.yml')).toContain('npm run gate:ci')
  })
})

describe('new — determinism and purity', () => {
  it.each(COMBOS)('%s + deploy %s: the same inputs give byte-identical output', (kind, deploy) => {
    const args = ['--kind', kind, '--port', '3920', '--with', 'ci-github', ...(deploy ? ['--deploy', deploy] : [])]
    const a = scaffold(args, 'det-a')
    const b = scaffold(args, 'det-b')
    expect(a.r.status).toBe(0)
    expect(snapshot(a.dir)).toEqual(snapshot(b.dir))
    expect(a.r.json.files).toEqual(b.r.json.files)
  })

  it('compose() is a pure function of its input (no clock, no randomness)', () => {
    const input = { name: 'demo-app', kind: 'fullstack', with: ['ci-github'], deploy: 'container', port: 3920 }
    expect(JSON.stringify(compose(kit, input))).toBe(JSON.stringify(compose(kit, input)))
  })

  it('--dry-run reports the same plan and writes nothing', () => {
    const dir = join(tmp('dry'), 'app')
    const dry = cli(['new', 'demo-app', '--kind', 'fullstack', '--dir', dir, '--dry-run', '--json'])
    expect(dry.status).toBe(0)
    expect(dry.json.dryRun).toBe(true)
    expect(existsSync(dir)).toBe(false)
    const real = cli(['new', 'demo-app', '--kind', 'fullstack', '--dir', dir, '--json'])
    expect(dry.json.files).toEqual(real.json.files)
  })

  it('writes only under --dir', () => {
    const parent = tmp('pure')
    const dir = join(parent, 'app')
    cli(['new', 'demo-app', '--kind', 'fullstack', '--deploy', 'container', '--dir', dir, '--json'])
    expect(Object.keys(snapshot(parent)).every((p) => p.startsWith('app/'))).toBe(true)
  })
})

describe('lint step of the generated gate', () => {
  it.each([['api', ['']], ['nuxt-app', ['']], ['fullstack', ['api/', 'ui/']]])('%s: every part lints with oxlint (warnings fail) between typecheck and tests, ignoring build output', (kind, parts) => {
    const { dir } = scaffold(['--kind', kind])
    for (const part of parts) {
      const pkg = JSON.parse(read(dir, `${part}package.json`))
      expect(pkg.scripts.lint, part).toBe('oxlint --deny-warnings')
      expect(pkg.scripts.gate, part).toBe('npm run typecheck && npm run lint && npm run test')
      expect(pkg.devDependencies.oxlint, part).toBeTruthy()
      expect(JSON.parse(read(dir, `${part}.oxlintrc.json`)).ignorePatterns, part).toEqual(expect.arrayContaining(['.nuxt', '.output', 'dist', 'node_modules']))
    }
  })
})
