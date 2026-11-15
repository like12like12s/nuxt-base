// @vitest-environment node
// What the og module composes (behaviour: runtime-og.spec.ts, and the e2e spec the kit gate runs on Node and on
// wrangler's Pages runtime).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanup, cli, read, snapshot, tmp } from './helpers'

afterAll(cleanup)
const scaffold = (args: string[]) => {
  const dir = join(tmp('og'), 'app')
  return { dir, r: cli(['new', 'demo-app', ...args, '--dir', dir, '--json']) }
}

describe('og module', () => {
  it('is ready for the kinds that have a UI, and is refused on a bare API', () => {
    expect(cli(['list', '--json']).json.modules.find((m: any) => m.name === 'og')).toMatchObject({ status: 'ready', kinds: ['nuxt-app', 'fullstack'], requires: [] })
    expect(scaffold(['--kind', 'api', '--with', 'og']).r.status).toBe(4)
  })

  it.each([['nuxt-app', ''], ['fullstack', 'ui/']])('%s: locked runtime in the UI server, app-owned resolver + plugin, unit and e2e tests', (kind, ui) => {
    const { dir, r } = scaffold(['--kind', kind, '--with', 'og'])
    expect(r.status).toBe(0)
    expect(r.json.locked).toContain(`${ui}server/kit/og.ts`)
    for (const f of ['server/og.ts', 'server/plugins/og.ts', 'tests/unit/og.spec.ts', 'tests/e2e/og.spec.ts']) expect(r.json.files, f).toContain(ui + f)
    expect(read(dir, `${ui}server/og.ts`)).toContain('export const SITE = "Demo App"')
    expect(read(dir, `${ui}tests/e2e/og.spec.ts`)).toContain('toBe("Demo App")')
    expect(read(dir, `${ui}nuxt.config.ts`)).toContain("  runtimeConfig: { public: { siteUrl: '' } },\n")
    expect(r.json.env).toContainEqual({ key: 'NUXT_PUBLIC_SITE_URL', required: false, secret: false })
    expect(read(dir, '.memory/docs/guides/usage.md')).toContain('## Link previews')
  })

  it('one implementation for every deploy target — cf-pages adds nothing platform-specific', () => {
    const node = scaffold(['--kind', 'nuxt-app', '--with', 'og'])
    const cf = scaffold(['--kind', 'nuxt-app', '--with', 'og', '--deploy', 'cf-pages'])
    for (const f of ['server/kit/og.ts', 'server/og.ts', 'server/plugins/og.ts']) expect(snapshot(cf.dir)[f], f).toBe(snapshot(node.dir)[f])
    expect(cf.r.json.files.some((f: string) => f.startsWith('functions/'))).toBe(false)
    expect(read(cf.dir, 'nuxt.config.ts')).toContain("nitro: { preset: 'cloudflare-pages' },")
    expect(snapshot(scaffold(['--kind', 'nuxt-app', '--with', 'og', '--deploy', 'cf-pages']).dir)).toEqual(snapshot(cf.dir))
    expect(cli(['check', cf.dir, '--json']).json.clean).toBe(true)
  })

  it('without the module the UI has no server plugin', () => {
    const { r } = scaffold(['--kind', 'nuxt-app'])
    expect(r.json.files.some((f: string) => /og\.(ts|spec\.ts)$/.test(f))).toBe(false)
  })
})

// Finding #6 of the first real use: the og example did not say that the API wants to know who is calling, and behind
// single sign-on a crawler never gets that far anyway.
describe('og with an API (fullstack) — and with auth', () => {
  const FULL = ['--kind', 'fullstack', '--with', 'db,auth,api,og', '--deploy', 'container']

  it('fullstack: og.ts looks records up through the server-side API helper, which sends the service token from the environment', () => {
    const { dir, r } = scaffold(FULL)
    expect(r.json.files).toEqual(expect.arrayContaining(['ui/server/utils/server-api.ts', 'ui/tests/unit/server-api.spec.ts']))
    const og = read(dir, 'ui/server/og.ts')
    expect(og).toContain("import { serverApi } from './utils/server-api'")
    expect(og).toContain('export async function recordPreview(')
    expect(og).toContain('const record = await recordPreview(path)')
    expect(og).not.toMatch(/@kit:|fetchItem/)
    const helper = read(dir, 'ui/server/utils/server-api.ts')
    expect(helper).toContain("process.env.API_SERVICE_TOKEN")
    expect(helper).toContain('authorization: `Bearer ${token}`')
    expect(r.json.env).toContainEqual({ key: 'API_SERVICE_TOKEN', required: false, secret: true })
    expect(read(dir, 'ui/.env.example')).toMatch(/^API_SERVICE_TOKEN=$/m)
    // the container deploy hands both settings to the UI service
    const compose = read(dir, 'docker/docker-compose.yml')
    expect(compose).toMatch(/\n  ui:\n(?:.*\n)*? {6}API_SERVICE_TOKEN: \$\{API_SERVICE_TOKEN:-\}/)
    expect(compose).toMatch(/NUXT_PUBLIC_SITE_URL: \$\{SITE_URL:-\}/)
    expect(read(dir, 'docker/env.example')).toMatch(/^API_SERVICE_TOKEN=$/m)
    expect(compose).not.toMatch(/@kit:/)
  })

  it('`new` says in next[] that crawlers cannot pass sign-in — only when og and auth are both selected', () => {
    const line = (r: any) => r.json.next.filter((n: string) => /crawler cannot pass single sign-on/.test(n))
    const both = scaffold(FULL).r
    expect(line(both)).toHaveLength(1)
    expect(line(both)[0]).toContain('API_SERVICE_TOKEN')
    expect(line(both)[0]).toContain('auth:token -- create --name og-preview')
    expect(line(scaffold(['--kind', 'fullstack', '--with', 'api,db,og']).r)).toEqual([])
    expect(line(scaffold(['--kind', 'fullstack', '--with', 'auth']).r)).toEqual([])
    expect(line(scaffold(['--kind', 'nuxt-app', '--with', 'og,auth']).r)).toHaveLength(1)
    for (const n of both.json.next) expect(typeof n).toBe('string')
    // and the usage doc explains it
    expect(read(scaffold(FULL).dir, '.memory/docs/guides/usage.md')).toContain('A crawler cannot pass single sign-on')
  })

  it('a UI-only project keeps the plain resolver (no API helper, no token key)', () => {
    const { dir, r } = scaffold(['--kind', 'nuxt-app', '--with', 'og'])
    expect(r.json.files.filter((f: string) => f.includes('server-api'))).toEqual([])
    expect(r.json.env.map((e: any) => e.key)).not.toContain('API_SERVICE_TOKEN')
    expect(read(dir, 'server/og.ts')).toContain('export const resolveOg: OgResolver = ({ path }) => {')
    expect(read(dir, 'server/og.ts')).not.toMatch(/@kit:|serverApi/)
  })

  it('add resource lists its detail page for previews; a project whose og.ts has no anchor still gets the resource', () => {
    const { dir } = scaffold(FULL)
    const r = cli(['add', 'resource', 'orders', '--dir', dir, '--json'])
    expect(r.status, r.stdout).toBe(0)
    expect(r.json.patched).toContain('ui/server/og.ts')
    expect(read(dir, 'ui/server/og.ts')).toContain("  '/orders': '/api/v1/orders',\n  // kit:anchor og-records")

    // og.ts as kit 0.2.0 wrote it (no anchor): the optional patch is skipped and named in next[], nothing fails
    const old = scaffold(FULL).dir
    const file = join(old, 'ui/server/og.ts')
    writeFileSync(file, readFileSync(file, 'utf8').split('\n').filter((l) => !l.includes('kit:anchor og-records')).join('\n'))
    const skipped = cli(['add', 'resource', 'orders', '--dir', old, '--json'])
    expect(skipped.status, skipped.stdout).toBe(0)
    expect(skipped.json.patched).not.toContain('ui/server/og.ts')
    expect(skipped.json.files).toContain('ui/app/pages/orders/[id].vue')
    expect(skipped.json.next.join('\n')).toContain("ui/server/og.ts: no `kit:anchor og-records` there — if you want it, add by hand: '/orders': '/api/v1/orders',")
    // without the og module there is no patch at all
    const plain = scaffold(['--kind', 'fullstack', '--with', 'api,db']).dir
    expect(cli(['add', 'resource', 'orders', '--dir', plain, '--json']).json.next.join('\n')).not.toContain('og-records')
  })
})
