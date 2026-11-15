// DO NOT EDIT — locked file from the nuxt-base kit (runtime/jobs/runner.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Jobs: work that runs on a schedule, outside a request. The app declares them (src/jobs/<name>.ts), an external
// scheduler runs `node dist/jobs/run.js <name>` and reads the exit code — nothing in the app schedules itself.
//   - a job cannot overlap itself: a lock file per job (O_EXCL); a second start exits 3 without running
//   - one JSON log line at the start and one at the end (job, status, ms, changed, ...), on stdout like the API's
//   - writes go through audited(): actor `job:<name>`, and a run that changes nothing writes no audit row
//   - a deadline per job (timeoutMs): the job is told through `signal`, the run ends with exit 4
// Exit codes: 0 ok · 1 the job failed · 2 usage (unknown job) · 3 already running · 4 timed out.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { newTraceId, runWithContext } from '../api/context.js'
import type { Logger } from '../api/log.js'
import type { Database } from '../db/connect.js'

export const JOB_EXIT = { OK: 0, FAILED: 1, USAGE: 2, LOCKED: 3, TIMEOUT: 4 } as const

export interface JobContext<DB = any> {
  name: string
  database: Database<DB>
  logger: Logger
  /** Aborted when the deadline passes — check it in long loops and stop. */
  signal: AbortSignal
}

/** What a run reports; it lands on the `job end` log line. `changed` = how many records the run really changed. */
export interface JobResult {
  changed?: number
  [key: string]: unknown
}

export interface Job<DB = any> {
  /** kebab-case; the argument of the runner and the name of the lock. */
  name: string
  description?: string
  /** Deadline of one run (default 10 minutes). Also how long a lock left behind by a killed run is honoured. */
  timeoutMs?: number
  run(context: JobContext<DB>): Promise<JobResult | void>
}

export const defineJob = <DB = any>(job: Job<DB>): Job<DB> => job

export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000

interface LockInfo {
  pid: number
  host: string
  startedAt: string
  expiresAt: string
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
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' // exists, owned by someone else
  }
}

/**
 * Take the lock of a job, or return null when a run holds it. A lock is stale — and taken over — when its deadline
 * has passed, or when it was taken on this host by a process that no longer exists.
 */
export function acquireLock(dir: string, name: string, options: LockOptions): JobLock | null {
  const { ttlMs, now = Date.now, pid = process.pid, host = hostname(), isAlive = alive } = options
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.lock`)
  const info: LockInfo = { pid, host, startedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + ttlMs).toISOString() }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx') // fails when the file exists: two starts cannot both win
      writeSync(fd, JSON.stringify(info))
      closeSync(fd)
      return {
        file,
        release() {
          try {
            const held = JSON.parse(readFileSync(file, 'utf8')) as LockInfo
            if (held.pid === pid && held.host === host && held.startedAt === info.startedAt) rmSync(file, { force: true })
          } catch {
            /* already gone */
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let held: LockInfo | null = null
      try {
        held = JSON.parse(readFileSync(file, 'utf8')) as LockInfo
      } catch {
        held = null // unreadable or half-written: treat as stale only via the checks below
      }
      const expired = !held || !(Date.parse(held.expiresAt) > now())
      const orphaned = held !== null && held.host === host && !isAlive(held.pid)
      if (!expired && !orphaned) return null
      rmSync(file, { force: true }) // stale: remove and try once more
    }
  }
  return null
}

export interface RunJobDeps<DB = any> {
  database: Database<DB>
  logger: Logger
  /** Directory of the lock files — on a volume every instance of the app shares. */
  lockDir: string
  now?: () => number
  lock?: Partial<LockOptions>
}

/** Run one job under its lock and deadline. Returns the exit code; never throws. */
export async function runJob<DB>(job: Job<DB>, deps: RunJobDeps<DB>): Promise<number> {
  const { logger, database, lockDir, now = Date.now } = deps
  const timeoutMs = job.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS
  // The log lines and the audit rows of one run share a trace id; the audit actor is the job.
  return runWithContext({ traceId: newTraceId(), user: { subject: `job:${job.name}`, roles: [] } }, async () => {
    let lock: JobLock | null
    try {
      lock = acquireLock(lockDir, job.name, { ttlMs: timeoutMs + 60_000, now, ...deps.lock })
    } catch (error) {
      logger.error('job end', { job: job.name, status: 'failed', ms: 0, error: `lock: ${error instanceof Error ? error.message : String(error)}` })
      return JOB_EXIT.FAILED
    }
    if (!lock) {
      logger.warn('job skipped', { job: job.name, status: 'locked', reason: 'a previous run still holds the lock' })
      return JOB_EXIT.LOCKED
    }
    const started = now()
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    logger.info('job start', { job: job.name })
    try {
      const outcome = await Promise.race([
        job.run({ name: job.name, database, logger, signal: controller.signal }).then((result) => ({ result })),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs)
        }),
      ])
      if (outcome === 'timeout') {
        controller.abort()
        logger.error('job end', { job: job.name, status: 'timeout', ms: now() - started, timeoutMs })
        return JOB_EXIT.TIMEOUT
      }
      logger.info('job end', { job: job.name, status: 'ok', ms: now() - started, changed: 0, ...outcome.result })
      return JOB_EXIT.OK
    } catch (error) {
      logger.error('job end', { job: job.name, status: 'failed', ms: now() - started, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined })
      return JOB_EXIT.FAILED
    } finally {
      clearTimeout(timer)
      lock.release()
    }
  })
}

export interface JobsCliDeps<DB = any> extends RunJobDeps<DB> {
  jobs: Record<string, Job<DB>>
  out?: (line: string) => void
}

/** `<name>` runs a job · `--list` prints the jobs. The caller closes the database and exits with the returned code. */
export async function runJobsCli<DB>(argv: readonly string[], deps: JobsCliDeps<DB>): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const names = Object.keys(deps.jobs).sort()
  for (const key of names) if (deps.jobs[key]!.name !== key) throw new Error(`job "${deps.jobs[key]!.name}" is registered as "${key}" — the key must be the job's name`)
  const [arg, ...rest] = argv
  if (arg === '--list' && !rest.length) {
    for (const name of names) out(`${name}${deps.jobs[name]!.description ? `  — ${deps.jobs[name]!.description}` : ''}`)
    return JOB_EXIT.OK
  }
  const job = arg ? deps.jobs[arg] : undefined
  if (!job || rest.length) {
    out(`usage: job <name> | --list\njobs: ${names.join(', ') || '(none — add one with `scaffold add job <name>`)'}`)
    return JOB_EXIT.USAGE
  }
  return runJob(job, deps)
}
