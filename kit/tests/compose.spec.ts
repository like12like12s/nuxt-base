// @vitest-environment node
import { existsSync, lstatSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanup, cli, read, snapshot, tmp } from './helpers'
// @ts-expect-error plain ESM, no types
import { compose, composeFromManifest } from '../lib/compose.mjs'
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
    for (const f of ['.gitignore', 'README.md', '.memory/docs/brief/brief.md', '.scaffold.json', 'package.json', 'scripts/gate-ci.mjs',
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
    expect(Object.keys(r.json)).toEqual(['ok', 'dir', 'name', 'title', 'description', 'kind', 'modules', 'db', 'deploy', 'sample', 'lang', 'kitVersion', 'files', 'locked', 'services', 'env', 'backup', 'next'])
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
    for (const [path, hash] of Object.entries(m.locked)) expect(`sha256:${hashes[path]}`, path).toBe(hash)
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

// Test tiers per GATE.md (git-hooks): gate never builds or opens a browser; test:smoke is the authored @smoke
// suite; gate:full is everything. The heavy-run queue helper is a locked file every playwright run goes through.
describe('new — test tiers', () => {
  it('nuxt-app: gate = typecheck + lint + unit, smoke/full scripts, @smoke-tagged skeleton, tiers.json, queue helper wired and locked', () => {
    const { dir } = scaffold(['--kind', 'nuxt-app'])
    const pkg = JSON.parse(read(dir, 'package.json'))
    expect(pkg.scripts.gate).toBe('npm run typecheck && npm run lint && npm run test') // no build, no playwright
    expect(pkg.scripts['test:smoke']).toBe('npm run build && playwright test --grep @smoke')
    expect(pkg.scripts['gate:full']).toBe('npm run gate && npm run test:e2e')
    expect(JSON.parse(read(dir, 'tests/tiers.json'))).toEqual({
      version: 1,
      exclusive: true, // the e2e port is fixed per project — checkouts of one repo serialize
      map: { 'app/**': ['tests/e2e/app.spec.ts'] },
    })
    expect(read(dir, 'tests/e2e/app.spec.ts')).toMatch(/tag: \['@smoke'\]/)
    // the queue helper: wired into the config, and locked (hash in .scaffold.json = the file as written)
    const config = read(dir, 'playwright.config.ts')
    expect(config).toContain("from './scripts/lib/heavy-run-global-setup.mjs'")
    expect(config).toContain('globalSetup: heavyGlobalSetup')
    expect(config).toContain('workers: Number(process.env.HEAVY_RUN_WORKERS) || undefined')
    const manifest = JSON.parse(read(dir, '.scaffold.json'))
    expect(Object.keys(manifest.locked)).toContain('scripts/lib/heavy-run-global-setup.mjs')
    const hashes = snapshot(dir)
    expect(manifest.locked['scripts/lib/heavy-run-global-setup.mjs']).toBe(`sha256:${hashes['scripts/lib/heavy-run-global-setup.mjs']}`)
    expect(read(dir, 'scripts/lib/heavy-run-global-setup.mjs')).toContain('Queue full')
  })

  it('fullstack: root wires smoke to the ui part and gate:full to both; ui tiers.json paths are repo-root-relative', () => {
    const { dir } = scaffold(['--kind', 'fullstack', '--with', 'api'])
    const root = JSON.parse(read(dir, 'package.json'))
    expect(root.scripts['test:smoke']).toBe('npm run test:smoke --prefix ui')
    expect(root.scripts['gate:full']).toBe('npm run gate:full --prefix api && npm run gate:full --prefix ui')
    expect(JSON.parse(read(dir, 'ui/tests/tiers.json'))).toEqual({
      version: 1,
      exclusive: true,
      map: {
        'ui/app/**': ['ui/tests/e2e/app.spec.ts'],
        'ui/server/**': ['ui/tests/e2e/app.spec.ts'],
      },
    })
    expect(read(dir, 'ui/playwright.config.ts')).toContain('globalSetup: heavyGlobalSetup')
    expect(read(dir, 'ui/tests/e2e/app.spec.ts')).toMatch(/tag: \['@smoke'\]/)
    // the api part has no tiers file: no e2e there, the tier split is the gate / gate:full scripts alone
    expect(existsSync(join(dir, 'api/tests/tiers.json'))).toBe(false)
    expect(JSON.parse(read(dir, 'api/package.json')).scripts['gate:full']).toBe('npm run gate && npm run build')
  })

  it('api alone: no smoke, no tiers.json — gate / gate:full is the whole tier split', () => {
    const { dir } = scaffold(['--kind', 'api'])
    const pkg = JSON.parse(read(dir, 'package.json'))
    expect(pkg.scripts['gate:full']).toBe('npm run gate && npm run build')
    expect(pkg.scripts['test:smoke']).toBeUndefined()
    expect(pkg.scripts['test:e2e']).toBeUndefined()
    expect(existsSync(join(dir, 'tests/tiers.json'))).toBe(false)
  })
})

// Finding #17: every project served its e2e build on 3999, so two kit projects could not run e2e at the same time.
describe('new — e2e port', () => {
  const e2e = (args: string[]) => /Number\(process\.env\.E2E_PORT\) \|\| (\d+)/.exec(read(scaffold(args).dir, args.includes('fullstack') ? 'ui/playwright.config.ts' : 'playwright.config.ts'))![1]
  it('derives from the project\'s own UI port — two projects never share it, and none uses a fixed one', () => {
    expect(e2e(['--kind', 'nuxt-app'])).toBe('13000')
    expect(e2e(['--kind', 'nuxt-app', '--port', '3100'])).toBe('13100')
    expect(e2e(['--kind', 'fullstack', '--port', '3200'])).toBe('13201') // the UI port of a fullstack project is base + 1
    expect(e2e(['--kind', 'fullstack', '--port', '3200', '--api-port', '3300'])).toBe('13200')
    expect(e2e(['--kind', 'nuxt-app', '--port', '60000'])).toBe('50000') // stays inside the port range
    for (const kind of ['nuxt-app', 'fullstack']) expect(read(scaffold(['--kind', kind]).dir, kind === 'fullstack' ? 'ui/playwright.config.ts' : 'playwright.config.ts')).not.toContain('3999')
  })
})

// Finding #12: `npm audit` of a fresh UI reported 8 moderate advisories (minimatch, glob) through packages whose
// parents have not released a fix. The override is narrow on purpose — only under the three parents that need it.
describe('new — dependency overrides of the UI', () => {
  it('the UI pins the fixed minimatch / glob under the parents that still ask for a vulnerable range, and nothing wider', () => {
    for (const [kind, file] of [['nuxt-app', 'package.json'], ['fullstack', 'ui/package.json']] as const) {
      const pkg = JSON.parse(read(scaffold(['--kind', kind]).dir, file))
      expect(pkg.overrides, kind).toEqual({ editorconfig: { minimatch: '^11.0.8' }, 'readdir-glob': { minimatch: '^11.0.8' }, 'js-beautify': { glob: '^14.0.6' } })
    }
    const fullstack = scaffold(['--kind', 'fullstack']).dir
    expect(JSON.parse(read(fullstack, 'api/package.json')).overrides).toBeUndefined()
    expect(JSON.parse(read(fullstack, 'package.json')).overrides).toBeUndefined()
  })
})

// Finding #15 of the first real use: the layer's defaults were Thai and the generated pages English — one app, two
// languages. A project now has ONE: `--lang th|en` (default th) drives the generated strings and the layer's labels.
describe('new — one UI language (--lang)', () => {
  const THAI = /[\u0E00-\u0E7F]/
  const uiFiles = (dir: string, files: string[]) => files.filter((f) => /\.(vue|ts)$/.test(f) && !/(^|\/)(kit|node_modules)\//.test(f) && !f.startsWith('api/')).map((f) => [f, read(dir, f)] as const)

  it('default th: nothing new in app.config (the layer default), Thai strings in the generated page and its tests', () => {
    const { dir, r } = scaffold(['--kind', 'nuxt-app'])
    expect(r.json.lang).toBe('th')
    expect(JSON.parse(read(dir, '.scaffold.json')).answers).not.toHaveProperty('lang') // manifests of existing projects stay as they are
    expect(read(dir, 'app/app.config.ts')).not.toMatch(/lang:/)
    expect(read(dir, 'app/pages/index.vue')).toContain(">ทักทาย</Btn>")
    expect(read(dir, 'tests/e2e/app.spec.ts')).toContain("getByText('ใช้งานได้')")
    expect(read(dir, 'app/pages/index.vue')).not.toContain('Say hello')
    expect(scaffold(['--kind', 'nuxt-app', '--lang', 'th']).r.json.files).toEqual(r.json.files)
    expect(snapshot(scaffold(['--kind', 'nuxt-app', '--lang', 'th']).dir)).toEqual(snapshot(dir))
  })

  it('--lang en: app.config sets the layer language, and no generated UI file holds a Thai string', () => {
    for (const args of [['--kind', 'nuxt-app'], ['--kind', 'fullstack', '--with', 'db,auth,api,og']]) {
      const { dir, r } = scaffold([...args, '--lang', 'en'])
      expect(r.status, r.stdout).toBe(0)
      expect(r.json.lang).toBe('en')
      expect(JSON.parse(read(dir, '.scaffold.json')).answers.lang).toBe('en')
      const ui = args.includes('fullstack') ? 'ui/' : ''
      const config = read(dir, `${ui}app/app.config.ts`)
      expect(config).toMatch(/lang: 'en'/)
      expect(config).toContain("locale: 'en_US'")
      expect(read(dir, `${ui}app/pages/index.vue`)).toContain('>Say hello</Btn>')
      for (const [file, text] of uiFiles(dir, r.json.files)) expect(text, file).not.toMatch(THAI)
      for (const [file, text] of uiFiles(dir, r.json.files)) expect(text, file).not.toMatch(/@kit:/)
    }
  })

  it('the generators follow the project language (read from the manifest)', () => {
    const th = scaffold(['--kind', 'nuxt-app']).dir
    const en = scaffold(['--kind', 'nuxt-app', '--lang', 'en']).dir
    for (const dir of [th, en]) expect(cli(['add', 'page', 'reports', '--dir', dir, '--json']).status).toBe(0)
    expect(read(th, 'app/pages/reports.vue')).toContain('<EmptyState title="ยังไม่มีข้อมูล"')
    expect(read(th, 'tests/e2e/reports.spec.ts')).toContain("getByText('ยังไม่มีข้อมูล')")
    expect(read(en, 'app/pages/reports.vue')).toContain('<EmptyState title="Nothing here yet"')
    expect(read(en, 'app/pages/reports.vue')).not.toMatch(THAI)
    expect(read(en, 'tests/e2e/reports.spec.ts')).not.toMatch(THAI)
  })

  it('an unknown language is a usage error; a project without a UI has none; check / update keep it', () => {
    const bad = scaffold(['--kind', 'nuxt-app', '--lang', 'fr'])
    expect(bad.r.status).toBe(2)
    expect(bad.r.json.message).toContain('--lang must be one of th|en')
    const api = scaffold(['--kind', 'api', '--lang', 'en'])
    expect(api.r.json.lang).toBeNull()
    expect(JSON.parse(read(api.dir, '.scaffold.json')).answers).not.toHaveProperty('lang')
    const { dir } = scaffold(['--kind', 'fullstack', '--with', 'api,db', '--lang', 'en'])
    expect(cli(['check', dir, '--json']).json).toMatchObject({ clean: true, drift: [] })
    expect(cli(['update', dir, '--json']).json.updated).toEqual([])
    // a hand-edited manifest with a language that does not exist falls back to th instead of failing
    const manifest = JSON.parse(read(dir, '.scaffold.json'))
    manifest.answers.lang = 'xx'
    writeFileSync(join(dir, '.scaffold.json'), JSON.stringify(manifest, null, 2) + '\n')
    expect(cli(['check', dir, '--json']).status).toBe(0)
  })

  it('fullstack with the API: the UI gets the locked error helper that turns validation `details` into field messages', () => {
    const { dir, r } = scaffold(['--kind', 'fullstack', '--with', 'api,db'])
    expect(r.json.locked).toContain('ui/app/utils/api-error.ts')
    expect(read(dir, 'ui/app/utils/api-error.ts')).toContain('export function apiProblem(error: unknown): ApiProblem')
    expect(r.json.files).toContain('ui/tests/unit/api-error.spec.ts')
    expect(scaffold(['--kind', 'nuxt-app']).r.json.locked).not.toContain('app/utils/api-error.ts')
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

// M1 (review t1097): --context values were pasted raw into source files and into docker/deploy.conf (sourced by bash).
describe('new — hostile --context values', () => {
  const withContext = (context: unknown, args = ['--kind', 'fullstack', '--deploy', 'container', '--with', 'trace,auth', '--db', 'mysql']) => {
    const ctx = join(tmp('ctx'), 'ctx.json')
    writeFileSync(ctx, JSON.stringify(context))
    return scaffold([...args, '--context', ctx], 'hostile')
  }

  it.each([
    ['title with a line break (code after a // comment)', { title: 'Shop\nimport("node:child_process"); console.log("INJECTED")' }],
    ['title with a JS line separator', { title: 'Shop\u2028alert(1)' }],
    ['title that is not a string', { title: { toString: 'x' } }],
    ['description with a carriage return', { description: 'fine\r\n---\nname: other' }],
    ['deploy.host with a command substitution', { deploy: { host: 'h$(id>/tmp/x)' } }],
    ['deploy.host with backticks', { deploy: { host: 'h`id`' } }],
    ['deploy.user with a second command', { deploy: { user: 'svc; rm -rf ~' } }],
    ['deploy.registry with a space and a quote', { deploy: { registry: 'reg.test" other' } }],
    ['deploy.domain that closes the SMOKE_URL expansion', { deploy: { domain: 'x}"; id; : "${Y=' } }],
    ['mysqlHost with a slash', { mysqlHost: 'db/../../etc' }],
    ['layerRef that closes the string in nuxt.config.ts', { layerRef: "x'], hooks: { ready() { process.exit(7) } }, _: ['" }],
    ['otlpEndpoint that is not http(s)', { otlpEndpoint: 'javascript:alert(1)' }],
    ['otlpEndpoint with credentials', { otlpEndpoint: ['https://user', 'secret@collector.test'].join(':') }],
    ['otlpEndpoint with a shell expansion', { otlpEndpoint: 'http://collector.test/$(id)' }],
    ['authentikUrl with a line break', { authentikUrl: 'https://sso.test/\n## Injected heading' }],
    ['deploy that is not an object', { deploy: 'box-1' }],
  ])('refused, nothing written: %s', (_label, context) => {
    const { dir, r } = withContext(context)
    expect(r.status).toBe(2)
    expect(r.json).toMatchObject({ ok: false, code: 'usage' })
    expect(r.json.message).toMatch(/^--context /)
    expect(existsSync(dir)).toBe(false)
  })

  it('awkward but harmless text is kept as data: one comment line, JSON-escaped in code', () => {
    const title = `O'Brien "Shop" \`x\` \${process.exit(1)} */ </script> {{kit.name}} #1`
    const { dir, r } = withContext({ title, description: 'A & B — "quoted" <b>bold</b>' })
    expect(r.status).toBe(0)
    const config = read(dir, 'ui/nuxt.config.ts').split('\n')
    expect(config[0]).toBe(`// ${title} — Nuxt 4 SPA on the nuxt-base layer (the layer sets ssr: false, Tailwind 4, tokens, head defaults).`)
    expect(config.filter((line) => line.includes('process.exit'))).toHaveLength(1) // only inside that comment
    expect(read(dir, 'ui/app/app.config.ts')).toContain(JSON.stringify(title))
    expect(JSON.parse(read(dir, '.scaffold.json')).answers.title).toBe(title)
  })

  it('an empty or absent title / description is valid and falls back to the default', () => {
    for (const context of [{ title: '', description: '' }, { title: null, description: null }, {}]) {
      const { dir, r } = withContext(context, ['--kind', 'api'])
      expect(r.status, JSON.stringify(context)).toBe(0)
      expect(JSON.parse(read(dir, '.scaffold.json')).answers).toMatchObject({ title: 'Demo App', description: 'Demo App — scaffolded with the nuxt-base kit' })
      expect(read(dir, 'README.md')).toMatch(/^# Demo App\n\nDemo App — scaffolded with the nuxt-base kit\n/)
    }
  })

  // Finding #10 of the first real use: the wrapper passed the name as the title and no description — the registry
  // showed `kit-ref`, context.md had an empty bullet, and the brief existed twice.
  it('a title that is blank or only repeats the name is derived from the name; `new --json` reports what was used', () => {
    for (const context of [{ title: 'demo-app' }, { title: '   ' }, { title: ' demo-app ' }, {}]) {
      const { dir, r } = withContext(context, ['--kind', 'nuxt-app'])
      expect(r.json, JSON.stringify(context)).toMatchObject({ title: 'Demo App', description: 'Demo App — scaffolded with the nuxt-base kit' })
      expect(read(dir, 'app/app.config.ts')).toContain('name: "Demo App"')
    }
    const { r } = withContext({ title: '  Link Shelf ', description: ' Links worth keeping ' }, ['--kind', 'api'])
    expect(r.json).toMatchObject({ title: 'Link Shelf', description: 'Links worth keeping' })
  })

  it('no generated document has an empty bullet or an empty heading, whatever title / description was passed', () => {
    for (const context of [{}, { title: '', description: '' }, { title: ' ', description: '   ' }, { title: 'demo-app', description: null }]) {
      for (const args of [['--kind', 'nuxt-app'], ['--kind', 'fullstack', '--with', 'db,auth,api,trace,og,security,jobs,notify', '--deploy', 'container'], ['--kind', 'api', '--deploy', 'pm2']]) {
        const { dir, r } = withContext(context, args)
        const docs = r.json.files.filter((path: string) => path.endsWith('.md'))
        expect(docs.length).toBeGreaterThan(4)
        for (const path of docs) {
          const empty = read(dir, path).split('\n').filter((line) => /^\s*(?:[-*+]|#{1,6}|\d+\.)\s*$/.test(line))
          expect(empty, `${path} with ${JSON.stringify(context)}`).toEqual([])
        }
      }
    }
  })

  it('the brief lives in one place — .memory/docs/brief/brief.md — and the README links to it', () => {
    for (const kind of KINDS) {
      const { dir, r } = scaffold(['--kind', kind])
      expect(r.json.files.filter((path: string) => /(^|\/)brief\.md$/.test(path)), kind).toEqual(['.memory/docs/brief/brief.md'])
      expect(read(dir, '.memory/docs/brief/brief.md')).toMatch(/^---\nname: demo-app-brief\ndescription: .+\n---\n# Demo App — Brief\n/)
      expect(read(dir, 'README.md')).toContain('[.memory/docs/brief/brief.md](.memory/docs/brief/brief.md)')
      expect(read(dir, 'README.md')).not.toMatch(/\]\(brief\.md\)/)
    }
  })

  // Answers already stored in a project are never a usage error: check / update / add keep working, the value is
  // reported as a warning and replaced by the default wherever something is rendered.
  const store = (dir: string, change: (manifest: any) => void) => {
    const manifest = JSON.parse(read(dir, '.scaffold.json'))
    change(manifest)
    writeFileSync(join(dir, '.scaffold.json'), JSON.stringify(manifest, null, 2) + '\n')
    return manifest
  }

  it('a project scaffolded by v0.2.0 (empty description, answers as that version wrote them) passes check and update', () => {
    const { dir } = scaffold(['--kind', 'fullstack', '--deploy', 'container', '--with', 'auth,trace,og,security,jobs', '--port', '3002'])
    const stored = store(dir, (m) => {
      // exactly the shape ai-cli + kit 0.2.0 produced for the reference app (hosts replaced by example values)
      m.answers = { name: 'demo-app', title: 'demo-app', description: '', port: 3003, apiPort: 3002, deploy: { registry: 'registry.test:5000', host: 'box-1', domain: 'apps.test', user: 'svc' }, authentikUrl: 'https://auth.apps.test' }
    })
    const check = cli(['check', dir, '--json'])
    expect(check.status, check.stdout + check.stderr).toBe(0)
    expect(check.json).toMatchObject({ ok: true, clean: true, drift: [], warnings: [] })
    const update = cli(['update', dir, '--json'])
    expect(update.status).toBe(0)
    expect(update.json).toMatchObject({ updated: [], warnings: [] })
    expect(JSON.parse(read(dir, '.scaffold.json')).answers).toEqual(stored.answers) // stored answers are not rewritten
    expect(cli(['add', 'job', 'nightly', '--dir', dir, '--json']).status).toBe(0)
  })

  it('a stored answer that is not acceptable is a warning of check / update / add — never exit 2 — and is not rendered', () => {
    const { dir } = scaffold(['--kind', 'fullstack', '--deploy', 'container', '--with', 'jobs'])
    store(dir, (m) => {
      m.answers.title = 'Shop\nimport("x")'
      m.answers.description = 'd'.repeat(501)
      m.answers.deploy = { host: 'h$(id)', registry: 'registry.test:5000' }
      m.answers.otlpEndpoint = 'javascript:alert(1)'
    })
    const check = cli(['check', dir, '--json'])
    expect(check.status, check.stdout + check.stderr).toBe(0)
    expect(check.json.clean).toBe(true)
    expect(check.json.warnings).toHaveLength(4)
    expect(check.json.warnings.join('\n')).toMatch(/answers\.title must be a single line.*\n.*answers\.description must be at most 500.*\n.*answers\.deploy\.host "h\$\(id\)".*\n.*answers\.otlpEndpoint/)
    const update = cli(['update', dir, '--json'])
    expect(update.status).toBe(0)
    expect(update.json.warnings).toHaveLength(4)
    expect(read(dir, 'docker/deploy.conf')).toMatch(/^DEPLOY_HOST=deploy-host\b/m)
    expect(cli(['add', 'job', 'nightly', '--dir', dir, '--json']).status).toBe(0)
    // what compose() would render for this project uses the placeholders, never the stored values
    const plan = composeFromManifest(kit, JSON.parse(read(dir, '.scaffold.json')))
    const rendered = plan.files.map((f: { content: string | Buffer }) => String(f.content)).join('\n')
    for (const unsafe of ['h$(id)', 'import("x")', 'javascript:alert']) expect(rendered).not.toContain(unsafe)
    expect(plan.files.find((f: { path: string }) => f.path === 'docker/deploy.conf').content).toMatch(/^DEPLOY_HOST=deploy-host\b/m)
    // a valid stored value next to the bad ones is still used
    expect(rendered).toContain('PULL_REGISTRY=registry.test:5000')
  })
})

// L12: only the hono API had security headers; the pages of a generated UI had none
describe('new — UI security headers', () => {
  it.each([['nuxt-app', ''], ['fullstack', 'ui/']])('%s: nuxt.config.ts sets them for every route of the UI server', (kind, ui) => {
    const { dir, r } = scaffold(['--kind', kind])
    expect(r.status).toBe(0)
    const config = read(dir, `${ui}nuxt.config.ts`)
    expect(config).toContain("  routeRules: { '/**': { headers: { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin', 'content-security-policy': \"frame-ancestors 'none'\" } } },\n")
    expect(read(dir, `${ui}tests/e2e/app.spec.ts`)).toContain('pages carry the security headers')
  })
})

// M2 / M14
describe('new — container names and the privacy note', () => {
  it.each([['nuxt-app', []], ['api', []], ['api', ['--with', 'api,db']], ['fullstack', []], ['fullstack', ['--with', 'api,db']]] as [string, string[]][])('%s %j: no fixed container_name; services reach each other by service name', (kind, extra) => {
    const { dir, r } = scaffold(['--kind', kind, '--deploy', 'container', ...extra])
    expect(r.status).toBe(0)
    const composeFile = read(dir, 'docker/docker-compose.yml')
    expect(composeFile).not.toMatch(/^\s*container_name:/m)
    expect(composeFile).toMatch(/^name: demo-app$/m)
    if (kind === 'fullstack') expect(composeFile).toContain('API_URL: http://api:3000')
    expect(read(dir, 'docker/env.example')).toContain('#COMPOSE_PROJECT_NAME=demo-app-sit')
  })

  it.each(KINDS)('%s: next[] and the README say the repository must stay private', (kind) => {
    const { dir, r } = scaffold(['--kind', kind])
    expect(r.json.next.filter((line: string) => /keep this repository private/.test(line))).toHaveLength(1)
    expect(read(dir, 'README.md')).toMatch(/^## Keep this repository private$/m)
  })
})

// Finding #14: the fullstack compose file published the API on every interface of the deploy host although only the
// UI (same compose network) ever calls it.
describe('new — fullstack container: the API has no host port', () => {
  const publishes = (compose: string, service: string) => new RegExp(`\\n  ${service}:\\n(?:(?:    .*| *#.*)?\\n)*?    ports:\\n`).test(compose)

  it.each([[[]], [['--with', 'api,db']], [['--with', 'db,auth,api,trace,og,security,jobs,notify']]] as [string[]][])('fullstack %j: only the UI is published; the API is compose-internal and marked internal', (extra) => {
    const { dir, r } = scaffold(['--kind', 'fullstack', '--deploy', 'container', '--port', '3200', ...extra])
    const compose = read(dir, 'docker/docker-compose.yml')
    expect(publishes(compose, 'ui')).toBe(true)
    expect(publishes(compose, 'api')).toBe(false)
    expect(compose).toContain('      API_URL: http://api:3000')
    // the documented way out is loopback only, and commented
    const published = compose.split('\n').filter((line) => /^\s*(#\s*)?- "/.test(line) && line.includes(':3000"'))
    expect(published).toEqual(['    #   - "127.0.0.1:${API_PORT:-3200}:3000"', '      - "${UI_PORT:-3201}:3000"'])
    expect(read(dir, 'docker/env.example')).not.toMatch(/^API_PORT=/m)
    expect(r.json.services).toEqual([
      { id: 'demo-app-api', name: 'API', type: 'api', port: 3200, healthPath: '/health/live', internal: true },
      { id: 'demo-app-web', name: 'Web', type: 'web', port: 3201, healthPath: '/' },
    ])
    expect(read(dir, '.memory/docs/guides/usage.md')).toContain('Only the UI has a host port')
  })

  it('everything else is unchanged: a lone API stays published, and no other preset marks a service internal', () => {
    for (const extra of [[], ['--with', 'api,db']]) {
      const { dir, r } = scaffold(['--kind', 'api', '--deploy', 'container', ...extra])
      expect(publishes(read(dir, 'docker/docker-compose.yml'), 'api')).toBe(true)
      expect(r.json.services.some((s: any) => 'internal' in s)).toBe(false)
      expect(read(dir, '.memory/docs/guides/usage.md')).not.toContain('Only the UI has a host port')
    }
    for (const deploy of [[], ['--deploy', 'pm2']]) expect(scaffold(['--kind', 'fullstack', ...deploy]).r.json.services.some((s: any) => 'internal' in s)).toBe(false)
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
