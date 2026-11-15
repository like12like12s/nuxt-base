// DO NOT EDIT — locked file from the nuxt-base kit (runtime/project/gate-ci.mjs). Its hash is recorded in
// .scaffold.json; `scaffold check` reports local edits and `scaffold update` overwrites them.
//
// gate:ci = the local gate + secret scan (gitleaks) + dependency audit (npm audit --audit-level=high).
// Fail-fast, non-interactive. A missing gitleaks binary is a visible notice, never a silent pass.
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
if (spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).error) {
  console.log('NOTICE: gitleaks is not installed — secret scan SKIPPED (install it: https://github.com/gitleaks/gitleaks)')
} else {
  const args = existsSync(join(root, '.git')) ? ['detect', '--source', '.', '--no-banner', '--redact'] : ['detect', '--source', '.', '--no-git', '--no-banner', '--redact']
  code = run('gitleaks', args)
  if (code !== 0) fail('gitleaks', code)
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
