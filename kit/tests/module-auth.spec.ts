// @vitest-environment node
// What the auth module composes. Its behaviour is tested at the source (runtime-auth.spec.ts) and in the generated
// project (tests/auth.spec.ts, run by the kit gate).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanup, cli, read, snapshot, tmp } from './helpers'

afterAll(cleanup)

function scaffold(args: string[]) {
  const dir = join(tmp('auth'), 'app')
  const r = cli(['new', 'demo-app', ...args, '--dir', dir, '--json'])
  return { dir, r }
}

describe('auth module', () => {
  it('is ready for all three kinds; in an API it needs the standard and the data layer, in a UI-only project nothing', () => {
    const auth = cli(['list', '--json']).json.modules.find((m: any) => m.name === 'auth')
    expect(auth).toMatchObject({ status: 'ready', kinds: ['api', 'fullstack', 'nuxt-app'], requires: ['api', 'db'] })
    expect(scaffold(['--kind', 'api', '--with', 'auth']).r.json.modules).toEqual(['base', 'api', 'auth', 'db', 'testkit'])
    expect(scaffold(['--kind', 'fullstack', '--with', 'auth']).r.json.modules).toEqual(['base', 'api', 'auth', 'db', 'testkit'])
    expect(scaffold(['--kind', 'nuxt-app', '--with', 'auth']).r.json.modules).toEqual(['base', 'auth'])
  })

  describe('kind api', () => {
    const { dir, r } = scaffold(['--kind', 'api', '--with', 'auth'])

    it('locks the runtime and adds the app-owned wiring, the /me resource, the token command and the matrix test', () => {
      expect(r.status).toBe(0)
      expect(r.json.locked.filter((p: string) => p.startsWith('src/kit/auth/'))).toEqual(['cli', 'guard', 'proxy', 'tokens', 'users'].map((f) => `src/kit/auth/${f}.ts`))
      for (const f of ['src/auth/index.ts', 'src/auth/roles.ts', 'src/auth/cli.ts', 'src/resources/me/me.routes.ts', 'tests/auth.spec.ts']) expect(r.json.files, f).toContain(f)
      expect(JSON.parse(read(dir, 'package.json')).scripts['auth:token']).toBe('tsx --env-file-if-exists=.env src/auth/cli.ts token')
    })

    it('the app mounts the auth middleware in front of /api/v1 and every items route declares its rule', () => {
      const app = read(dir, 'src/app.ts')
      expect(app).toContain("api.use('*', appAuth(config, deps.database, logger).middleware)") // every path, not only /api/v1 (M13)
      expect(app.indexOf('appAuth(config')).toBeLessThan(app.indexOf('mountV1(api'))
      expect(app).toContain('registerMe(v1)')
      const routes = read(dir, 'src/resources/items/items.routes.ts')
      expect(routes.match(/middleware: \[require(Auth|Role)\(.*\)\] as const,/g)).toEqual([
        'middleware: [requireAuth()] as const,',
        'middleware: [requireAuth()] as const,',
        "middleware: [requireRole('admin', 'editor')] as const,",
        "middleware: [requireRole('admin', 'editor')] as const,",
        "middleware: [requireRole('admin')] as const,",
      ])
      expect(routes.match(/createRoute\(/g)).toHaveLength(5)
    })

    it('the committed contract documents /api/v1/me and the 401 / 403 answers', () => {
      const doc = JSON.parse(read(dir, 'openapi.json'))
      expect(doc.info.title).toBe('demo-app')
      expect(Object.keys(doc.paths)).toContain('/api/v1/me')
      expect(Object.keys(doc.paths['/api/v1/items'].get.responses)).toContain('401')
      expect(Object.keys(doc.paths['/api/v1/items/{id}'].delete.responses)).toEqual(expect.arrayContaining(['401', '403']))
    })

    it('env: the proxy secret is a secret, nothing is required, dev mode is off by default', () => {
      expect(r.json.env).toContainEqual({ key: 'AUTH_PROXY_SECRET', required: false, secret: true })
      for (const key of ['AUTH_TRUSTED_PROXIES', 'AUTH_ROLE_MAP', 'AUTH_DEV_MODE']) expect(r.json.env).toContainEqual({ key, required: false, secret: false })
      expect(read(dir, '.env.example')).toMatch(/\nAUTH_DEV_MODE=\n/)
      expect(read(dir, 'src/config.ts')).toContain("SECRETS: readonly (keyof typeof shape)[] = ['DATABASE_URL', 'AUTH_PROXY_SECRET']")
    })

    it('usage.md tells the operator what to set up — and the generator sets nothing up itself', () => {
      const usage = read(dir, '.memory/docs/guides/usage.md')
      for (const text of ['## Auth', 'What the operator sets up', 'https://authentik.example.com', 'x-auth-proxy-secret', 'AUTH_TRUSTED_PROXIES', 'npm run auth:token -- create', 'must answer 401']) expect(usage, text).toContain(text)
    })
  })

  it('--context authentikUrl lands in the docs and survives check', () => {
    const base = tmp('auth-ctx')
    const dir = join(base, 'app')
    const ctx = join(base, 'ctx.json')
    writeFileSync(ctx, JSON.stringify({ authentikUrl: 'https://sso.example.org' }))
    expect(cli(['new', 'demo-app', '--kind', 'api', '--with', 'auth', '--context', ctx, '--dir', dir, '--json']).status).toBe(0)
    expect(read(dir, '.memory/docs/guides/usage.md')).toContain('Identity provider (https://sso.example.org)')
    expect(JSON.parse(read(dir, '.scaffold.json')).answers.authentikUrl).toBe('https://sso.example.org')
    expect(cli(['check', dir, '--json']).json.clean).toBe(true)
    // not given = not recorded, so older projects keep the same manifest
    expect(JSON.parse(read(scaffold(['--kind', 'api']).dir, '.scaffold.json')).answers).not.toHaveProperty('authentikUrl')
  })

  it('without the module nothing of it is generated — and no template directive survives in any combination', () => {
    for (const args of [['--kind', 'api', '--with', 'api'], ['--kind', 'fullstack', '--with', 'api'], ['--kind', 'nuxt-app'], ['--kind', 'fullstack', '--with', 'auth'], ['--kind', 'nuxt-app', '--with', 'auth']]) {
      const { dir, r } = scaffold(args)
      const withAuth = args.includes('auth')
      for (const f of r.json.files as string[]) {
        const text = read(dir, f)
        expect(text, `${args.join(' ')}: ${f}`).not.toMatch(/@kit:(if|else|end)/)
        if (!withAuth && !f.endsWith('.md') && f !== '.scaffold.json') expect(text, `${args.join(' ')}: ${f}`).not.toMatch(/requireAuth|AUTH_|kit\/auth|\/api\/v1\/me/)
      }
      expect(r.json.files.some((f: string) => f.includes('src/auth/')), args.join(' ')).toBe(withAuth && !args.includes('nuxt-app'))
    }
  })

  it('UI: fullstack and nuxt-app turn the layer\'s useAuth on, pointed at /api/v1/me; fullstack gets the typed client of the auth contract', () => {
    for (const [kind, ui] of [['fullstack', 'ui/'], ['nuxt-app', '']] as const) {
      const { dir, r } = scaffold(['--kind', kind, '--with', 'auth'])
      expect(read(dir, `${ui}app/app.config.ts`), kind).toContain("auth: { enabled: true, meEndpoint: '/api/v1/me', loginUrl: '/outpost.goauthentik.io/start?rd={rd}' }")
      expect(r.json.files, kind).toContain(`${ui}tests/unit/auth.spec.ts`)
      expect(read(dir, `${ui}tests/e2e/app.spec.ts`), kind).toContain("page.route('**/api/v1/me'")
      expect(r.json.files.includes('ui/app/api/schema.d.ts'), kind).toBe(kind === 'fullstack')
    }
    expect(read(scaffold(['--kind', 'fullstack', '--with', 'auth']).dir, 'ui/app/api/schema.d.ts')).toContain('"/api/v1/me"')
    expect(read(scaffold(['--kind', 'nuxt-app']).dir, 'app/app.config.ts')).not.toContain('auth:')
  })

  it.each([[['--kind', 'api', '--with', 'auth']], [['--kind', 'fullstack', '--with', 'auth', '--deploy', 'pm2']], [['--kind', 'nuxt-app', '--with', 'auth', '--deploy', 'cf-pages']]])('%j: deterministic and clean', (args) => {
    const a = scaffold(args)
    expect(snapshot(scaffold(args).dir)).toEqual(snapshot(a.dir))
    expect(cli(['check', a.dir, '--json']).json).toMatchObject({ clean: true })
  })
})
