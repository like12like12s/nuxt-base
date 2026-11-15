// @vitest-environment node
// What the auth module composes. Its behaviour is tested at the source (runtime-auth.spec.ts) and in the generated
// project (tests/auth.spec.ts, run by the kit gate).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { KIT_ROOT, cleanup, cli, read, snapshot, tmp } from './helpers'

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

    // L14: the text said the proxy must remove client-sent identity headers; the snippet did not do it
    it('the Caddy example in usage.md strips client-sent identity and secret headers before forward_auth', () => {
      const usage = read(dir, '.memory/docs/guides/usage.md')
      const strip = usage.indexOf('request_header -X-Authentik-*')
      expect(strip).toBeGreaterThan(-1)
      expect(usage).toContain('request_header -x-auth-proxy-secret')
      expect(strip).toBeLessThan(usage.indexOf('forward_auth <outpost>:9000'))
    })

    // Finding #1 of the first real use: the docs offered a raw Caddy snippet as the only way, for X-Authentik-* only.
    it('usage.md describes the setup in terms of the forward-auth proxy and the header preset; the Caddy block is one example', () => {
      const usage = read(dir, '.memory/docs/guides/usage.md')
      const auth = usage.slice(usage.indexOf('## Auth ('))
      expect(auth).toContain('"The forward-auth proxy" = the reverse proxy in front of the app')
      expect(auth).toMatch(/remote\s+Remote-User\s+\(none\)\s+Remote-Email\s+Remote-Name\s+Remote-Groups/)
      expect(auth).toContain('AUTH_HEADER_PRESET')
      expect(auth).toContain('do not hand-edit the generated proxy configuration')
      expect(auth.indexOf('**3. What the proxy must do**')).toBeLessThan(auth.indexOf('app.example.com {'))
      expect(auth).toContain('one example; nginx and Traefik have the same three steps')
      expect(auth).not.toMatch(/@kit:/)
      // an API on its own: the proxy (or its address) is what the API trusts — no bridge
      expect(auth).toContain('The proxy forwards straight to the API.')
      expect(auth).not.toContain('auth bridge')
    })

    it('env: the header preset is configurable; the app-owned wiring passes it to the locked runtime', () => {
      expect(r.json.env.map((e: any) => e.key)).toContain('AUTH_HEADER_PRESET')
      expect(read(dir, 'src/config.ts')).toContain('AUTH_HEADER_PRESET: z.string().optional(),')
      expect(read(dir, 'src/auth/index.ts')).toContain('headers: identityHeaders({')
      expect(r.json.files.filter((f: string) => f.includes('auth-bridge'))).toEqual([])
    })

    it('locks the runtime and adds the app-owned wiring, the /me resource, the token command and the matrix test', () => {
      expect(r.status).toBe(0)
      expect(r.json.locked.filter((p: string) => p.startsWith('src/kit/auth/'))).toEqual(['cli', 'guard', 'proxy', 'tokens', 'users'].map((f) => `src/kit/auth/${f}.ts`))
      for (const f of ['src/auth/index.ts', 'src/auth/roles.ts', 'src/auth/cli.ts', 'src/resources/me/me.routes.ts', 'tests/auth.spec.ts']) expect(r.json.files, f).toContain(f)
      expect(JSON.parse(read(dir, 'package.json')).scripts['auth:token']).toBe('tsx --env-file-if-exists=.env src/auth/cli.ts token')
    })

    it('the app mounts the auth middleware in front of /api/v1 and every items route declares its rule', () => {
      const app = read(dir, 'src/app.ts')
      expect(app).toContain('const auth = appAuth(config, deps.database, logger)')
      expect(app).toContain("api.use('*', auth.middleware)") // every path, not only /api/v1 (M13)
      expect(app).toContain("const trustTraceparent = (c: Context) => config.TRUST_TRACEPARENT === '1' || auth.viaProxy(c)") // L1
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
      expect(r.json.env).toContainEqual({ key: 'AUTH_PROXY_SECRET', required: false, secret: true, generated: true })
      for (const key of ['AUTH_TRUSTED_PROXIES', 'AUTH_ROLE_MAP', 'AUTH_DEV_MODE']) expect(r.json.env).toContainEqual({ key, required: false, secret: false })
      expect(read(dir, '.env.example')).toMatch(/\nAUTH_DEV_MODE=\n/)
      expect(read(dir, 'src/config.ts')).toContain("SECRETS: readonly (keyof typeof shape)[] = ['DATABASE_URL', 'AUTH_PROXY_SECRET']")
    })

    it('usage.md tells the operator what to set up — and the generator sets nothing up itself', () => {
      const usage = read(dir, '.memory/docs/guides/usage.md')
      for (const text of ['## Auth', 'What the operator sets up', 'https://authentik.example.com', 'x-auth-proxy-secret', 'AUTH_TRUSTED_PROXIES', 'npm run auth:token -- create', 'must answer 401']) expect(usage, text).toContain(text)
    })
  })

  // Contract with the deploy tooling: secrets that are generated on the host are named in one line of docker/env.example.
  it('docker/env.example names the generated secrets in one `# kit:generated` line and leaves them empty', () => {
    for (const kind of ['api', 'fullstack']) {
      const { dir, r } = scaffold(['--kind', kind, '--with', 'auth,notify', '--deploy', 'container'])
      const env = read(dir, 'docker/env.example')
      expect(env.match(/^# kit:generated .*$/gm), kind).toEqual(['# kit:generated AUTH_PROXY_SECRET'])
      expect(env).toMatch(/^AUTH_PROXY_SECRET=$/m)
      expect(r.json.env.filter((e: any) => e.generated)).toEqual([{ key: 'AUTH_PROXY_SECRET', required: false, secret: true, generated: true }])
      // a secret someone else issues (a token of another service) is not generated
      expect(r.json.env.find((e: any) => e.key === 'NOTIFIER_TOKEN')).toEqual({ key: 'NOTIFIER_TOKEN', required: false, secret: true })
      // what deploy tooling reads stays where it is
      expect(JSON.parse(read(dir, '.scaffold.json')).answers).toMatchObject({ port: expect.any(Number), deploy: expect.any(Object) })
    }
    for (const args of [['--kind', 'api', '--with', 'api,db'], ['--kind', 'fullstack'], ['--kind', 'nuxt-app']]) {
      const { dir, r } = scaffold([...args, '--deploy', 'container'])
      expect(read(dir, 'docker/env.example'), args.join(' ')).not.toContain('kit:generated')
      expect(r.json.env.some((e: any) => 'generated' in e)).toBe(false)
    }
  })

  describe('fullstack: the UI\'s /api proxy carries the auth bridge', () => {
    const { dir, r } = scaffold(['--kind', 'fullstack', '--with', 'auth', '--deploy', 'container'])

    it('locks the bridge into the UI server and calls it before every forwarded request', () => {
      expect(r.json.locked).toContain('ui/server/kit/auth-bridge.ts')
      expect(read(dir, 'ui/server/kit/auth-bridge.ts')).toBe(readFileSync(join(KIT_ROOT, 'runtime/auth/bridge.ts'), 'utf8'))
      const route = read(dir, 'ui/server/routes/api/[...path].ts')
      expect(route).toContain("import { authBridgeFromEnv } from '../../kit/auth-bridge'")
      expect(route.indexOf('bridge(event.node.req.headers, event.node.req.socket.remoteAddress)')).toBeGreaterThan(-1)
      expect(route.indexOf('bridge(event.node.req.headers')).toBeLessThan(route.indexOf('return proxyRequest('))
      expect(route).not.toMatch(/@kit:/)
      expect(r.json.files).toContain('ui/tests/unit/auth-bridge.spec.ts')
    })

    it('env: the UI needs the secret and the proxy address; compose hands the one .env to both services', () => {
      const ui = read(dir, 'ui/.env.example')
      for (const key of ['AUTH_PROXY_SECRET', 'AUTH_BRIDGE_TRUSTED_PROXIES', 'AUTH_HEADER_PRESET']) expect(ui).toMatch(new RegExp(`^${key}=$`, 'm'))
      expect(ui).not.toContain('AUTH_TRUSTED_PROXIES=') // that one is the API's
      const compose = read(dir, 'docker/docker-compose.yml')
      const uiService = compose.slice(compose.indexOf('\n  ui:\n'))
      for (const key of ['AUTH_PROXY_SECRET', 'AUTH_BRIDGE_TRUSTED_PROXIES', 'AUTH_HEADER_PRESET', 'AUTH_HEADER_GROUPS']) expect(uiService).toContain(`      ${key}: \${${key}:-}`)
      const env = read(dir, 'docker/env.example')
      expect(env).toMatch(/^AUTH_BRIDGE_TRUSTED_PROXIES=$/m)
      expect(env).toContain('Leave AUTH_TRUSTED_PROXIES empty here')
    })

    it('usage.md explains the bridge; without the auth module the proxy route is the plain one', () => {
      const usage = read(dir, '.memory/docs/guides/usage.md')
      expect(usage).toContain('Its `/api` proxy carries the\n**auth bridge** (`ui/server/kit/auth-bridge.ts`)')
      expect(usage).toContain('AUTH_BRIDGE_TRUSTED_PROXIES   UI ')
      expect(usage).not.toMatch(/@kit:/)
      const plain = scaffold(['--kind', 'fullstack'])
      expect(read(plain.dir, 'ui/server/routes/api/[...path].ts')).not.toContain('auth-bridge')
      expect(plain.r.json.locked).not.toContain('ui/server/kit/auth-bridge.ts')
      // a UI-only project has no /api proxy of its own, so no bridge
      expect(scaffold(['--kind', 'nuxt-app', '--with', 'auth']).r.json.locked.filter((f: string) => f.includes('auth-bridge'))).toEqual([])
    })
  })

  it('--context authentikUrl lands in the docs and survives check', () => {
    const base = tmp('auth-ctx')
    const dir = join(base, 'app')
    const ctx = join(base, 'ctx.json')
    writeFileSync(ctx, JSON.stringify({ authentikUrl: 'https://sso.example.org' }))
    expect(cli(['new', 'demo-app', '--kind', 'api', '--with', 'auth', '--context', ctx, '--dir', dir, '--json']).status).toBe(0)
    expect(read(dir, '.memory/docs/guides/usage.md')).toContain('**4. Identity provider** (https://sso.example.org)')
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
