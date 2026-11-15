// @vitest-environment node
// nuxt-base eats its own cooking: its CI workflow is the ci-github module's template, and its `gate:ci` is the kit's
// locked gate-ci script. If the template changes, this repo's workflow must follow.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
    expect(workflow).not.toMatch(/pull_request_target|workflow_run/)
    expect(workflow).toContain('- run: npm run gate:ci')
  })

  // M3 (review t1097): the secret scan never ran in CI (gitleaks is not on the runner, the script only printed a
  // notice), CI installed without the lockfile, and actions were pinned by tag.
  it('installs from the lockfile, pins every action by commit SHA and gitleaks by version + checksum', () => {
    expect(workflow).toContain('- run: npm ci')
    expect(workflow).not.toMatch(/npm install\b/)
    const uses = [...workflow.matchAll(/uses: (\S+)(.*)/g)]
    expect(uses.length).toBeGreaterThanOrEqual(2)
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
      expect(rest, ref).toMatch(/# v\d+\.\d+\.\d+/) // the release the SHA belongs to
    }
    expect(workflow).toMatch(/GITLEAKS_VERSION: \d+\.\d+\.\d+\n\s+GITLEAKS_SHA256: [0-9a-f]{64}\b/)
    expect(workflow).toContain('sha256sum -c -')
    expect(workflow.indexOf('install gitleaks')).toBeLessThan(workflow.indexOf('npm run gate:ci'))
    expect(workflow).toContain('persist-credentials: false')
  })

  it('gate:ci fails in CI when gitleaks is missing; on a developer machine it is a visible notice', () => {
    const dir = tmp('gate-ci')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { gate: 'node -e ""' } }))
    // a PATH with node and npm only — no gitleaks
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    symlinkSync(process.execPath, join(bin, 'node'))
    symlinkSync(join(dirname(process.execPath), 'npm'), join(bin, 'npm'))
    const run = (ci: string | undefined) => {
      const env: Record<string, string> = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir }
      if (ci !== undefined) env.CI = ci
      return spawnSync(process.execPath, [join(KIT_ROOT, 'runtime/project/gate-ci.mjs')], { cwd: dir, env, encoding: 'utf8' })
    }
    expect(spawnSync('gitleaks', ['version'], { env: { PATH: `${bin}:/usr/bin:/bin` } }).error, 'the test PATH must not contain gitleaks').toBeTruthy()
    for (const ci of ['1', 'true']) {
      const r = run(ci)
      expect(r.status, r.stdout + r.stderr).toBe(1)
      expect(r.stderr).toContain('gitleaks is not installed and CI is set')
      expect(r.stderr).toContain('gate:ci FAILED at: gitleaks (not installed)')
    }
    for (const ci of [undefined, '', '0', 'false']) {
      const r = run(ci)
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.stdout).toContain('NOTICE: gitleaks is not installed — secret scan SKIPPED')
    }
  })

  it('fullstack: the root install follows the command — `npm ci` at the root is `npm ci` in api/ and ui/', () => {
    const dir = join(tmp('dogfood'), 'app')
    expect(cli(['new', 'demo-app', '--kind', 'fullstack', '--with', 'ci-github', '--dir', dir, '--json']).status).toBe(0)
    const script = JSON.parse(read(dir, 'package.json')).scripts.postinstall as string
    const calls = (npmCommand?: string) => {
      const stub = join(tmp('npm-stub'), 'npm')
      writeFileSync(stub, '#!/bin/sh\necho "npm $*"\n', { mode: 0o755 })
      const env: Record<string, string> = { PATH: `${dirname(stub)}:/usr/bin:/bin` }
      if (npmCommand) env.npm_command = npmCommand
      return spawnSync('sh', ['-c', script], { env, encoding: 'utf8' }).stdout.trim().split('\n')
    }
    expect(calls('ci')).toEqual(['npm ci --prefix api', 'npm ci --prefix ui'])
    expect(calls('install')).toEqual(['npm install --prefix api', 'npm install --prefix ui'])
    expect(calls()).toEqual(['npm install --prefix api', 'npm install --prefix ui'])
  })

  it('`npm run gate:ci` is the kit\'s own gate-ci script (gate + gitleaks + npm audit)', () => {
    expect(rootPkg.scripts['gate:ci']).toBe('node kit/runtime/project/gate-ci.mjs')
    const script = readFileSync(join(KIT_ROOT, 'runtime/project/gate-ci.mjs'), 'utf8')
    for (const text of ["run('npm', ['run', 'gate'])", 'gitleaks', "['audit', '--audit-level=high']"]) expect(script).toContain(text)
  })
})
