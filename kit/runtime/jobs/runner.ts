// DO NOT EDIT — locked file from the nuxt-base kit (runtime/jobs/runner.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Jobs: work that runs on a schedule, outside a request. The app declares them (src/jobs/<name>.ts), an external
// scheduler runs `node dist/jobs/run.js <name>` and reads the exit code — nothing in the app schedules itself.
//   - a job cannot overlap itself: a lock per job (lock.ts — atomic, also between processes and hosts that share
//     the lock directory); a second start exits 3 without running
//   - one JSON log line at the start and one at the end (job, status, ms, changed, ...), on stdout like the API's
//   - writes go through audited(): actor `job:<name>`, and a run that changes nothing writes no audit row
//   - a deadline per job (timeoutMs): the job is told through `signal`, the run ends with exit 4. The lock is given
//     back only when the job function has really stopped; a job that ignores the signal keeps it until the process
//     exits or the lock's deadline passes — so the next run cannot start next to work that is still going on
// Exit codes: 0 ok · 1 the job failed · 2 usage (unknown job) · 3 already running · 4 timed out.
import { newTraceId, runWithContext } from '../api/context.js'
import type { Logger } from '../api/log.js'
import type { Database } from '../db/connect.js'
import { acquireLock, type JobLock, type LockOptions } from './lock.js'

export { acquireLock, type JobLock, type LockOptions } from './lock.js'

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

export interface RunJobDeps<DB = any> {
  database: Database<DB>
  logger: Logger
  /** Directory of the lock files — on a volume every instance of the app shares. */
  lockDir: string
  now?: () => number
  lock?: Partial<LockOptions>
  /** After the deadline: how long to wait for the job to stop on its `signal` before giving up on it (default 5 s). */
  abortGraceMs?: number
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
    let release = true
    try {
      const running = job.run({ name: job.name, database, logger, signal: controller.signal })
      const outcome = await Promise.race([
        running.then((result) => ({ result })),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs)
        }),
      ])
      if (outcome === 'timeout') {
        controller.abort()
        // The lock goes back only when the job function has stopped. One that ignores the signal keeps it.
        let grace: ReturnType<typeof setTimeout> | undefined
        const stopped = await Promise.race([
          running.then(() => true, () => true),
          new Promise<false>((resolve) => {
            grace = setTimeout(() => resolve(false), deps.abortGraceMs ?? 5000)
          }),
        ])
        clearTimeout(grace)
        release = stopped
        logger.error('job end', { job: job.name, status: 'timeout', ms: now() - started, timeoutMs, stopped })
        return JOB_EXIT.TIMEOUT
      }
      // What the job returns never replaces the standard fields of the line.
      logger.info('job end', { changed: 0, ...outcome.result, job: job.name, status: 'ok', ms: now() - started })
      return JOB_EXIT.OK
    } catch (error) {
      logger.error('job end', { job: job.name, status: 'failed', ms: now() - started, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined })
      return JOB_EXIT.FAILED
    } finally {
      clearTimeout(timer)
      if (release) lock.release()
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
  const job = arg && Object.hasOwn(deps.jobs, arg) ? deps.jobs[arg] : undefined // not `constructor`, `__proto__`, …
  if (!job || rest.length) {
    out(`usage: job <name> | --list\njobs: ${names.join(', ') || '(none — add one with `scaffold add job <name>`)'}`)
    return JOB_EXIT.USAGE
  }
  return runJob(job, deps)
}
