// DO NOT EDIT — locked file from the nuxt-base kit (runtime/jobs/lock.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// The lock of a job: files `<name>.lock.<generation>` in a directory every instance of the app shares.
//
//   take      write the owner record to a temp file, then link() it to `<name>.lock.<newest generation + 1>`. link is
//             atomic and fails when the name exists, so one contender per generation wins and a lock file is never
//             seen half-written.
//   confirm   list the directory again: any lock that was not there before (a contender that saw a different
//             directory and took another generation) means "not mine" — the file is removed again and nobody is
//             disturbed. Two contenders can both back off; two can never both hold.
//   stale     a lock whose deadline passed, or whose owner is a dead process on this host. A stale lock is never
//             deleted to make room — it is superseded by the next generation and removed by the new holder afterwards
//             — so no contender can delete a lock that somebody just took.
//   release   the owner removes its own file (checked by its nonce).
//
// No imports from the rest of the kit: this file is also loaded on its own by the race test.
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

interface LockInfo {
  pid: number
  host: string
  startedAt: string
  expiresAt: string
  nonce?: string
}

export interface JobLock {
  file: string
  release(): void
}

export interface LockOptions {
  /** How long the lock is honoured if its owner disappears without releasing it. */
  ttlMs: number
  now?: () => number
  pid?: number
  host?: string
  isAlive?: (pid: number) => boolean
  /** How long a lock file that cannot be parsed is honoured (it may be another version's write in progress). Default 10 s. */
  graceMs?: number
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' // exists, owned by someone else
  }
}

interface Entry {
  file: string
  generation: number
  raw: string
  info: LockInfo | null
  mtimeMs: number
}

/** Every lock file of `name`: `<name>.lock.<n>`, and `<name>.lock` (generation 0 — written by kit 0.2.0). */
function entries(dir: string, name: string): Entry[] {
  const base = `${name}.lock`
  const found: Entry[] = []
  for (const entry of readdirSync(dir)) {
    const suffix = entry === base ? '0' : entry.startsWith(`${base}.`) ? entry.slice(base.length + 1) : ''
    if (!/^\d+$/.test(suffix)) continue
    const file = join(dir, entry)
    try {
      const raw = readFileSync(file, 'utf8')
      let info: LockInfo | null = null
      try {
        const parsed = JSON.parse(raw) as LockInfo
        if (parsed && typeof parsed.pid === 'number' && typeof parsed.host === 'string' && typeof parsed.expiresAt === 'string') info = parsed
      } catch {
        info = null
      }
      found.push({ file, generation: Number(suffix), raw, info, mtimeMs: statSync(file).mtimeMs })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error // released while we were listing
    }
  }
  return found
}

/**
 * Take the lock of a job, or return null when a run holds it (or when another start is taking it at this moment).
 * A lock is stale — and superseded — when its deadline has passed, or when it was taken on this host by a process
 * that no longer exists.
 */
export function acquireLock(dir: string, name: string, options: LockOptions): JobLock | null {
  const { ttlMs, now = Date.now, pid = process.pid, host = hostname(), isAlive = alive, graceMs = 10_000 } = options
  mkdirSync(dir, { recursive: true })
  const stale = (entry: Entry): boolean => {
    if (!entry.info) return Date.now() - entry.mtimeMs > graceMs // unreadable: stale only once nobody can still be writing it
    return !(Date.parse(entry.info.expiresAt) > now()) || (entry.info.host === host && !isAlive(entry.info.pid))
  }

  const before = entries(dir, name)
  if (!before.every(stale)) return null

  const nonce = randomUUID()
  const info: LockInfo = { pid, host, startedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + ttlMs).toISOString(), nonce }
  const file = join(dir, `${name}.lock.${Math.max(0, ...before.map((entry) => entry.generation)) + 1}`)
  const temp = join(dir, `.${name}.${nonce}.tmp`)
  writeFileSync(temp, JSON.stringify(info), { flag: 'wx' })
  try {
    linkSync(temp, file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null // another start won this generation
    throw error
  } finally {
    rmSync(temp, { force: true })
  }

  // Confirm: nothing but what we judged stale (same file, same content) and our own file may be there.
  const judged = new Set(before.map((entry) => `${entry.file}\n${entry.raw}`))
  if (entries(dir, name).some((entry) => entry.file !== file && !judged.has(`${entry.file}\n${entry.raw}`))) {
    rmSync(file, { force: true })
    return null
  }
  for (const entry of before) rmSync(entry.file, { force: true }) // superseded

  return {
    file,
    release() {
      try {
        // Only our own record: after our deadline a later run may have superseded this file and the name been reused.
        if ((JSON.parse(readFileSync(file, 'utf8')) as LockInfo).nonce === nonce) rmSync(file, { force: true })
      } catch {
        /* already gone */
      }
    },
  }
}
