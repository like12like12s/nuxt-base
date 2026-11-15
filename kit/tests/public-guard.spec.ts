// @vitest-environment node
// nuxt-base is a PUBLIC repo and the kit's output lands in other repos: nothing under kit/ may carry an internal
// address, an internal hostname or anything shaped like a credential. Infra values arrive at run time via --context.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KIT_ROOT } from './helpers'

const RULES: [string, RegExp][] = [
  ['private IPv4 (10/8)', /(?<![\d.])10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])/],
  ['CGNAT / tailnet IPv4 (100.64/10)', /(?<![\d.])100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?![\d.])/],
  ['private IPv4 (192.168/16)', /(?<![\d.])192\.168\.\d{1,3}\.\d{1,3}(?![\d.])/],
  ['private IPv4 (172.16/12)', /(?<![\d.])172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?![\d.])/],
  ['internal hostname (.int.)', /[a-z0-9-]\.int\.[a-z]/i],
  ['internal host alias', /\b(lxc|pve|mac|oracle)-[a-z0-9]+\b/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['provider token', /\b(ghp|gho|ghu|ghs|github_pat|glpat|xox[abprs]|sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ['bearer token literal', /Bearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['long hex secret', /\b[a-f0-9]{40,}\b/i],
  ['long base64 secret', /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{48,}={0,2}(?![A-Za-z0-9+/_-])/],
  ['password in URL', /[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:[^\s/@'"`$<{]+@(?!db\.test)/i],
]

// Internal service names that are not shaped like the host aliases above. Assembled at run time: this file is scanned too.
RULES.push(['internal service alias', new RegExp(`\\b(${[['mysql', 'central'], ['mssql', 'dev'], ['litellm', 'pg']].map((parts) => parts.join('-')).join('|')})\\b`)])

// Values that look like secrets and are public by nature: the commit SHA an action is pinned to, the published
// checksum of a release. Only in exactly these positions.
const PUBLIC_PINS = [/(uses: [\w.-]+\/[\w./-]+@)[0-9a-f]{40}\b/g, /(\b[A-Z][A-Z0-9_]*_SHA256: )[0-9a-f]{64}\b/g]

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) files(abs, out)
    else out.push(abs)
  }
  return out
}

export function violations(text: string): string[] {
  const hits: string[] = []
  text.split('\n').forEach((raw, i) => {
    const line = PUBLIC_PINS.reduce((text, pin) => text.replace(pin, '$1<pinned>'), raw)
    for (const [label, re] of RULES) if (re.test(line)) hits.push(`${i + 1}: ${label}`)
  })
  return hits
}

describe('public-repo guard', () => {
  it('the rules catch what they are for', () => {
    const d = (...parts: (string | number)[]) => parts.join('.') // built at run time so this file stays clean
    for (const bad of [
      `host ${d(10, 0, 0, 5)}`, `registry ${d(100, 100, 10, 41)}:5000`, `http://${d(192, 168, 1, 10)}/`, `${d(172, 20, 0, 3)}`,
      `https://app${'.int.'}example.xyz/`, `ssh ${'lxc'}-project`, `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----`,
      `${'ghp'}_${'a1B2'.repeat(9)}`, `${'sk'}-${'a1B2c3'.repeat(5)}`, `${'AKIA'}${'ABCDEFGH12345678'}`,
      `Authorization: ${'Bearer'} ${'abcDEF123456'.repeat(2)}`, `${'0123456789abcdef'.repeat(3)}`,
      `mysql://root:${'hunter2'}@db.example.com/app`, `the ${['mysql', 'central'].join('-')} server`,
      // a pin is only public in its own position — the same value anywhere else is still flagged
      `token: ${'0123456789abcdef'.repeat(4)}`, `uses: ${'0123456789abcdef'.repeat(3)}`,
    ]) expect(violations(bad), bad).not.toEqual([])
    for (const ok of [
      'http://127.0.0.1:3000/health/live', 'HOST=0.0.0.0', '"nuxt": "^4.6.4"', 'version 10.2.1', 'registry.example.com',
      'github:like12like12s/nuxt-base#v0.1.3', 'authorization: Bearer $PILOT_TOKEN', 'https://demo-app.example.com/',
      'print(int.parse(x))', `      - uses: actions/checkout@${'0123456789abcdef'.repeat(2)}${'01234567'} # v7.0.1`, `      GITLEAKS_SHA256: ${'0123456789abcdef'.repeat(4)} # release checksum`,
      'the central dev MySQL', 'api+std-mysql',
    ]) expect(violations(ok), ok).toEqual([])
  })

  it('no file under kit/ contains an internal address, hostname or anything token-shaped', () => {
    const found: string[] = []
    const all = files(KIT_ROOT)
    expect(all.length).toBeGreaterThan(40)
    for (const abs of all) for (const hit of violations(readFileSync(abs, 'utf8'))) found.push(`${relative(KIT_ROOT, abs)}:${hit}`)
    expect(found).toEqual([])
  })

  // L15: the repo is public as a whole — its own docs (README, the tracked .memory/ changelog and guides) and its CI
  // workflow are held to the same rules as kit/.
  it('nothing else this repo publishes does either: README.md, tracked .memory/ and .github/', () => {
    const repo = join(KIT_ROOT, '..')
    const tracked = spawnSync('git', ['-C', repo, 'ls-files', '-z', 'README.md', '.memory', '.github'], { encoding: 'utf8' }).stdout.split('\0').filter(Boolean)
    expect(tracked).toContain('README.md')
    expect(tracked.some((file) => file.startsWith('.memory/docs/changelog/'))).toBe(true)
    const found: string[] = []
    for (const file of tracked) {
      if (!existsSync(join(repo, file))) continue // deleted in the working tree
      for (const hit of violations(readFileSync(join(repo, file), 'utf8'))) found.push(`${file}:${hit}`)
    }
    expect(found).toEqual([])
  })

  it('the kit ships no binaries, lockfiles or installed dependencies', () => {
    const bad = files(KIT_ROOT).map((f) => relative(KIT_ROOT, f)).filter((f) => /(^|\/)node_modules\/|package-lock\.json$|\.(png|jpe?g|gif|ico|woff2?|zip|tgz|gz|db|sqlite)$/.test(f))
    expect(bad).toEqual([])
  })
})
