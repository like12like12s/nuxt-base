// Shared helpers of the kit unit tests. Everything is written under os.tmpdir() and removed after each test file.
import { spawnSync } from 'node:child_process'
import { cpSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error plain ESM, no types
import { sha256, walk } from '../lib/fsutil.mjs'

export const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const BIN = join(KIT_ROOT, 'bin', 'scaffold.mjs')

const created: string[] = []
export function tmp(label = 'work'): string {
  const dir = mkdtempSync(join(tmpdir(), `nuxt-base-kit-test-${label}-`))
  created.push(dir)
  return dir
}
export function cleanup() {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export interface CliResult { status: number; stdout: string; stderr: string; json: any }

/** Run the real CLI. `kit` points AI_KIT_DIR at another kit tree (see cloneKit). */
export function cli(args: string[], opts: { kit?: string; cwd?: string } = {}): CliResult {
  const env = { ...process.env }
  delete env.AI_KIT_DIR
  if (opts.kit) env.AI_KIT_DIR = opts.kit
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, cwd: opts.cwd })
  let json: any = null
  try { json = JSON.parse(r.stdout) } catch { /* not JSON */ }
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, json }
}

/** A private copy of the kit (with its own version) that a test may change: <tmp>/package.json + <tmp>/kit/. */
export function cloneKit(version = '9.9.9'): string {
  const root = tmp('kit')
  cpSync(KIT_ROOT, join(root, 'kit'), { recursive: true, filter: (src) => !src.includes(`${join(KIT_ROOT, 'tests')}`) })
  setKitVersion(join(root, 'kit'), version)
  return join(root, 'kit')
}
/**
 * A private copy of the kit that is a real git checkout: committed, and — unless `tagged` is false — tagged as the
 * release of its version. That is what `check` / `update` look at to tell a released kit from one with work on top.
 */
export function gitKit(version = '9.9.9', options: { tagged?: boolean } = {}): string {
  const kit = cloneKit(version)
  const repo = join(kit, '..')
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', `release v${version}`)
  if (options.tagged !== false) git(repo, 'tag', `v${version}`)
  return kit
}
export function git(repo: string, ...args: string[]): string {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  const r = spawnSync('git', ['-C', repo, '-c', 'user.name=kit-test', '-c', 'user.email=kit-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

export function setKitVersion(kit: string, version: string) {
  writeFileSync(join(kit, '..', 'package.json'), JSON.stringify({ name: 'kit-under-test', version }))
}

/** path -> sha256 of every file in a tree (symlinks: their target). */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rel of walk(dir)) {
    const abs = join(dir, rel)
    out[rel] = lstatSync(abs).isSymbolicLink() ? `link:${readlinkSync(abs)}` : sha256(readFileSync(abs))
  }
  return out
}

export const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8')
