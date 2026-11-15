import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { usageError } from './errors.mjs'

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

// How a locked file's hash is written in .scaffold.json: `sha256:<hex>`. A bare 64-character hex string next to a key
// like "…/tokens.ts" is exactly what secret scanners call a generic API key (gitleaks stopped the first commit of a
// fresh project on it); with the algorithm prefix the value no longer has the shape of a credential. Manifests written
// before this (bare hex) are still read.
export const lockHash = (data) => `sha256:${sha256(data)}`
export const bareHash = (recorded) => (typeof recorded === 'string' ? recorded.replace(/^sha256:/, '') : recorded)

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

// Stable JSON: 2-space indent + trailing newline. Key order is the caller's responsibility.
export const toJson = (value) => JSON.stringify(value, null, 2) + '\n'

// Every file under `dir`, as sorted posix-style relative paths (sorted = deterministic output order).
// Symlinks are listed, never followed (a single-app container project has a `web -> .` service dir).
export function walk(dir) {
  const out = []
  const visit = (abs) => {
    for (const name of readdirSync(abs).sort()) {
      const child = join(abs, name)
      if (lstatSync(child).isDirectory()) visit(child)
      else out.push(relative(dir, child).split(sep).join('/'))
    }
  }
  visit(dir)
  return out.sort()
}

export function isEmptyOrMissing(dir) {
  if (!existsSync(dir)) return true
  if (!statSync(dir).isDirectory()) return false
  return readdirSync(dir).length === 0
}

// Resolve `rel` under `root` and refuse anything that escapes it — the generator only ever writes under --dir.
export function inside(root, rel) {
  const abs = resolve(root, rel)
  const base = resolve(root)
  if (abs !== base && !abs.startsWith(base + sep)) throw usageError(`path escapes the target dir: ${rel}`, 'path_escape')
  return abs
}

// inside() is lexical. A symlink INSIDE the project can still point out of it (`src/kit -> /somewhere/else`, or a
// locked file replaced by a link): writing "under the project" would then overwrite a file outside it. So before any
// write, the real location of the deepest existing part of the path must be inside the real project root. Links that
// stay inside (the `api -> .` / `web -> .` service dirs of a single-app container project) are fine.
function assertRealInside(root, abs, rel) {
  mkdirSync(root, { recursive: true })
  const realRoot = realpathSync(root)
  let probe = abs
  while (!pathExists(probe)) probe = dirname(probe)
  let real
  try {
    real = realpathSync(probe)
  } catch {
    throw usageError(`refusing to write through a dangling symlink: ${rel}`, 'path_escape')
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw usageError(`refusing to write through a symlink that leaves the project: ${rel} -> ${real}`, 'path_escape')
}

export function writeFileUnder(root, rel, content, mode) {
  const abs = inside(root, rel)
  assertRealInside(root, abs, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, mode ? { mode } : undefined)
}

export function symlinkUnder(root, rel, target) {
  const abs = inside(root, rel)
  assertRealInside(root, dirname(abs), rel)
  mkdirSync(dirname(abs), { recursive: true })
  symlinkSync(target, abs)
}

export function pathExists(p) {
  try { lstatSync(p); return true } catch { return false }
}
