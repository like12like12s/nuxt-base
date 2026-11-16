// DO NOT EDIT — locked file from the nuxt-base kit (runtime/project/gate-ci.mjs). Its hash is recorded in
// .scaffold.json; `scaffold check` reports local edits and `scaffold update` overwrites them.
//
// gate:ci = the local gate + secret scan (gitleaks) + dependency audit (npm audit --audit-level=high).
// Fail-fast, non-interactive. A missing gitleaks binary is a visible notice on a developer machine and a FAILURE in CI
// (CI set to anything but empty / 0 / false) — a pipeline that silently skips the secret scan is not a secret scan.
//
// The secret scan and a pre-commit hook look at different things, on purpose:
//   pre-commit hook   `gitleaks protect --staged`   what is about to be committed
//   gate:ci           `gitleaks detect`             every commit in the history — what a hook on some machine let
//                                                    through, was skipped (--no-verify) or never ran
//   gate:ci, locally  + `gitleaks protect`          what is not committed yet (staged or not) — so a green local
//                                                    gate:ci means the hook would pass too. Not in CI: nothing is
//                                                    uncommitted there.
// Same rules for all three (the repo's .gitleaks.toml, else the built-in ones) and the same `.gitleaksignore`. A
// finding in the history cannot be fixed by a later commit: a false positive gets its fingerprint (the line
// `gitleaks detect -v` prints, `<commit>:<file>:<rule>:<line>`) in `.gitleaksignore`; a real secret is rotated first.
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const run = (cmd, args, cwd = root) => spawnSync(cmd, args, { cwd, stdio: 'inherit' }).status ?? 1
const step = (title) => console.log(`\n== gate:ci · ${title}`)
const fail = (title, code) => {
  console.error(`\ngate:ci FAILED at: ${title} (exit ${code})`)
  process.exit(code || 1)
}

step('gate')
let code = run('npm', ['run', 'gate'])
if (code !== 0) fail('gate', code)

step('gitleaks')
const inCi = !['', '0', 'false'].includes((process.env.CI ?? '').toLowerCase())
if (spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).error) {
  if (inCi) {
    console.error('gitleaks is not installed and CI is set — the secret scan must run in CI (install the pinned release in the workflow: https://github.com/gitleaks/gitleaks)')
    fail('gitleaks (not installed)', 1)
  }
  console.log('NOTICE: gitleaks is not installed — secret scan SKIPPED (install it: https://github.com/gitleaks/gitleaks)')
} else {
  const inGit = existsSync(join(root, '.git'))
  code = run('gitleaks', inGit ? ['detect', '--source', '.', '--no-banner', '--redact'] : ['detect', '--source', '.', '--no-git', '--no-banner', '--redact'])
  if (code !== 0) fail(inGit ? 'gitleaks (history)' : 'gitleaks', code)
  if (inGit && !inCi) {
    step('gitleaks (uncommitted changes)')
    code = run('gitleaks', ['protect', '--source', '.', '--no-banner', '--redact'])
    if (code !== 0) fail('gitleaks (uncommitted changes)', code)
  }
}

// Every directory with its own lockfile: the root and first-level parts (api/, ui/). Symlinked service dirs are skipped.
const dirs = ['.']
for (const name of readdirSync(root).sort()) {
  if (name.startsWith('.') || name === 'node_modules') continue
  const stat = lstatSync(join(root, name))
  if (stat.isDirectory() && !stat.isSymbolicLink() && existsSync(join(root, name, 'package.json'))) dirs.push(name)
}
for (const dir of dirs) {
  step(`npm audit (${dir})`)
  if (!existsSync(join(root, dir, 'package-lock.json'))) {
    console.log(`NOTICE: ${dir}/package-lock.json not found — audit SKIPPED for ${dir} (run npm install first)`)
    continue
  }
  code = run('npm', ['audit', '--audit-level=high'], join(root, dir))
  if (code !== 0) fail(`npm audit (${dir})`, code)
}

console.log('\ngate:ci OK')
