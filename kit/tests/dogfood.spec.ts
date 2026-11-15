// @vitest-environment node
// nuxt-base eats its own cooking: its CI workflow is the ci-github module's template, and its `gate:ci` is the kit's
// locked gate-ci script. If the template changes, this repo's workflow must follow.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import rootPkg from '../../package.json'
import { KIT_ROOT, cleanup, cli, read, tmp } from './helpers'

afterAll(cleanup)
const REPO = join(KIT_ROOT, '..')

describe('dogfood: the repo\'s own CI', () => {
  const workflow = readFileSync(join(REPO, '.github/workflows/gate.yml'), 'utf8')

  it('.github/workflows/gate.yml is what `--with ci-github` generates for a project named nuxt-base (+ the browser install its e2e suite needs)', () => {
    const dir = join(tmp('dogfood'), 'app')
    expect(cli(['new', 'nuxt-base', '--kind', 'nuxt-app', '--with', 'ci-github', '--dir', dir, '--json']).status).toBe(0)
    const generated = read(dir, '.github/workflows/gate.yml')
    const extra = workflow.split('\n').filter((line) => !generated.split('\n').includes(line))
    expect(extra).toEqual([
      "      # nuxt-base only: its gate runs the layer's playwright suite, which needs a browser on the runner.",
      '      - run: npx playwright install --with-deps chromium',
    ])
    expect(workflow.split('\n').filter((line) => !extra.includes(line)).join('\n')).toBe(generated)
  })

  it('runs on push and pull request, read-only, with no secret and no deploy', () => {
    expect(workflow).toMatch(/\non:\n  push:\n    branches: \[main, master\]\n  pull_request:\n/)
    expect(workflow).toMatch(/\npermissions:\n  contents: read\n/)
    expect(workflow).not.toMatch(/secrets\.|deploy|wrangler|docker|ssh|registry/i)
    expect(workflow).toContain('- run: npm run gate:ci')
  })

  it('`npm run gate:ci` is the kit\'s own gate-ci script (gate + gitleaks + npm audit)', () => {
    expect(rootPkg.scripts['gate:ci']).toBe('node kit/runtime/project/gate-ci.mjs')
    const script = readFileSync(join(KIT_ROOT, 'runtime/project/gate-ci.mjs'), 'utf8')
    for (const text of ["run('npm', ['run', 'gate'])", 'gitleaks', "['audit', '--audit-level=high']"]) expect(script).toContain(text)
  })
})
