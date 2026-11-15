// @vitest-environment node
// What the og module composes (behaviour: runtime-og.spec.ts, and the e2e spec the kit gate runs on Node and on
// wrangler's Pages runtime).
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
