// @vitest-environment node
// The locked job runner (kit/runtime/jobs/runner.ts) and the notify client (kit/runtime/notify/client.ts) at the source.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../runtime/api/log'
import { audited, touched } from '../runtime/db/repo'
import type { Migrations } from '../runtime/db/migrate'
import { baseMigration, type BaseTables } from '../runtime/db/schema'
import { JOB_EXIT, acquireLock, defineJob, runJob, runJobsCli, type Job } from '../runtime/jobs/runner'
import { createNotifier } from '../runtime/notify/client'
import { createTestDb, type TestDb } from '../runtime/testing/test-db'
import { KIT_ROOT, cleanup, tmp } from './helpers'

const migrations: Migrations = { '0001_base': baseMigration }
const open: TestDb<any>[] = []
afterAll(async () => {
  for (const db of open.splice(0)) await db.cleanup()
  cleanup()
})

async function setup() {
  const database = await createTestDb<BaseTables>({ label: 'jobs', migrations, dialect: 'sqlite' })
  open.push(database)
  const lines: Record<string, any>[] = []
  const logger = createLogger('info', (line) => lines.push(JSON.parse(line)), { service: 'svc', env: 'test' })
  const lockDir = tmp('locks')
  const run = (job: Job<BaseTables>, extra = {}) => runJob(job, { database, logger, lockDir, ...extra })
  return { database, db: database.db, lines, logger, lockDir, run }
}

describe('lock — a job cannot overlap itself', () => {
  it('the second taker gets nothing until the first releases', () => {
    const dir = tmp('lock')
    const first = acquireLock(dir, 'sync', { ttlMs: 60_000 })
    expect(first).not.toBeNull()
    expect(acquireLock(dir, 'sync', { ttlMs: 60_000 })).toBeNull()
    expect(acquireLock(dir, 'other', { ttlMs: 60_000 })).not.toBeNull() // per job
    first!.release()
    expect(existsSync(first!.file)).toBe(false)
    expect(acquireLock(dir, 'sync', { ttlMs: 60_000 })).not.toBeNull()
  })

  it('a lock left by a dead process on this host is taken over; one held by a live process is not', () => {
    const dir = tmp('lock')
    expect(acquireLock(dir, 'sync', { ttlMs: 60_000, pid: 111, host: 'box', isAlive: () => true })).not.toBeNull()
    expect(acquireLock(dir, 'sync', { ttlMs: 60_000, pid: 222, host: 'box', isAlive: () => true })).toBeNull()
    const taken = acquireLock(dir, 'sync', { ttlMs: 60_000, pid: 222, host: 'box', isAlive: (pid) => pid !== 111 })
    expect(taken).not.toBeNull()
    expect(JSON.parse(readFileSync(taken!.file, 'utf8')).pid).toBe(222)
  })

  it('a lock from another host is honoured until its deadline, then taken over', () => {
    const dir = tmp('lock')
    let at = 1_000_000
    expect(acquireLock(dir, 'sync', { ttlMs: 60_000, pid: 111, host: 'box-a', now: () => at })).not.toBeNull()
    const other = { ttlMs: 60_000, pid: 222, host: 'box-b', now: () => at, isAlive: () => false }
    expect(acquireLock(dir, 'sync', other)).toBeNull() // cannot tell whether pid 111 lives on box-a
    at += 60_001
    expect(acquireLock(dir, 'sync', other)).not.toBeNull()
  })

  it('release only removes its own lock; a corrupt lock file is treated as stale', () => {
    const dir = tmp('lock')
    let at = 1_000_000
    const old = acquireLock(dir, 'sync', { ttlMs: 1000, pid: 111, host: 'box', now: () => at, isAlive: () => true })!
    at += 5000
    const next = acquireLock(dir, 'sync', { ttlMs: 60_000, pid: 222, host: 'box', now: () => at, isAlive: () => true })!
    old.release() // the old run finishes late: it must not free the new run's lock
    expect(JSON.parse(readFileSync(next.file, 'utf8')).pid).toBe(222)
    writeFileSync(join(dir, 'broken.lock'), '{not json')
    // unreadable = perhaps being written by another version of the runner: honoured for a grace period, then stale
    expect(acquireLock(dir, 'broken', { ttlMs: 1000 })).toBeNull()
    expect(acquireLock(dir, 'broken', { ttlMs: 1000, graceMs: -1 })).not.toBeNull()
    expect(readdirSync(dir).filter((f) => f.startsWith('broken'))).toEqual(['broken.lock.1'])
  })

  it('a contender that finds a lock it did not judge backs off without touching it', () => {
    const dir = tmp('lock')
    // generation 7 appears between "list" and "confirm" of a contender that saw an empty directory: simulated by a
    // live lock of another host at a generation the contender does not expect
    const live = JSON.stringify({ pid: 1, host: 'elsewhere', startedAt: 'x', expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: 'n' })
    writeFileSync(join(dir, 'sync.lock.7'), live)
    expect(acquireLock(dir, 'sync', { ttlMs: 1000 })).toBeNull()
    expect(readdirSync(dir)).toEqual(['sync.lock.7'])
    expect(readFileSync(join(dir, 'sync.lock.7'), 'utf8')).toBe(live)
  })
})

// H3 (review t1097): many instances started by the same scheduler tick, on a shared lock volume. Real processes —
// the races are between a contender's read of the lock and another contender's write.
describe('lock — races between processes', () => {
  const LOCK_MODULE = join(KIT_ROOT, 'runtime', 'jobs', 'lock.ts')
  const CHILD = join(KIT_ROOT, 'tests', 'fixtures', 'lock-race.mjs')
  const DEAD_PID = 2 ** 22 + 12345 // above the kernel's pid_max: never a live process

  async function round(prepare: (dir: string) => void, contenders = 12, holdMs = 400) {
    const dir = tmp('race')
    const log = join(dir, 'holders.log')
    prepare(dir)
    const at = Date.now() + 1200 // every child is up and spinning by then, also on a slow CI runner
    const exits = await Promise.all(Array.from({ length: contenders }, () => new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [CHILD, process.env.KIT_LOCK_MODULE ?? LOCK_MODULE, dir, String(at), log, String(holdMs)], { stdio: 'ignore' })
      child.on('close', (code) => resolve(code))
    })))
    expect(exits.every((code) => code === 0), `child exit codes ${exits.join(',')}`).toBe(true)
    const holders = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split(' ').map(Number)) : []
    const overlapping = holders.filter(([pid, from, to]) => holders.some(([other, f, t]) => other !== pid && f! < to! && from! < t!)).length
    return { holders: holders.length, overlapping, left: readdirSync(dir).filter((f) => f !== 'holders.log') }
  }

  it('a stale lock (dead owner) is taken over by exactly one of 12 simultaneous starts', async () => {
    const stale = JSON.stringify({ pid: DEAD_PID, host: hostname(), startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() })
    const rounds = []
    for (let i = 0; i < 6; i++) rounds.push(await round((dir) => writeFileSync(join(dir, 'race.lock'), stale)))
    // What must never happen: two holders at the same time. (A child that started late may take the lock after the
    // first holder released it — that is a second run, not an overlap — so the count alone is not the assertion.)
    expect(rounds.map((r) => r.overlapping)).toEqual([0, 0, 0, 0, 0, 0])
    expect(rounds.every((r) => r.holders >= 1 && r.holders <= 2), JSON.stringify(rounds.map((r) => r.holders))).toBe(true)
    expect(rounds.flatMap((r) => r.left)).toEqual([]) // the stale lock, the winner's lock and every temp file are gone
  }, 60_000)

  it('with no lock at all, exactly one of 12 simultaneous starts runs', async () => {
    const rounds = []
    for (let i = 0; i < 4; i++) rounds.push(await round(() => undefined))
    expect(rounds.map((r) => r.overlapping)).toEqual([0, 0, 0, 0])
    expect(rounds.every((r) => r.holders >= 1 && r.holders <= 2), JSON.stringify(rounds.map((r) => r.holders))).toBe(true)
    expect(rounds.flatMap((r) => r.left)).toEqual([])
  }, 60_000)
})

describe('runJob', () => {
  it('ok: exit 0, a start and an end line in JSON with job, status, ms, changed — and the lock is released', async () => {
    const t = await setup()
    const job = defineJob<BaseTables>({ name: 'sync', run: async ({ logger }) => { logger.info('working'); return { changed: 3, scanned: 10 } } })
    expect(await t.run(job)).toBe(JOB_EXIT.OK)
    expect(t.lines.map((l) => l.msg)).toEqual(['job start', 'working', 'job end'])
    expect(t.lines[2]).toMatchObject({ level: 'info', job: 'sync', status: 'ok', changed: 3, scanned: 10, service: 'svc' })
    expect(typeof t.lines[2]!.ms).toBe('number')
    // one trace id for the whole run, on every line
    expect(new Set(t.lines.map((l) => l.traceId)).size).toBe(1)
    expect(t.lines[0]!.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(readdirSync(t.lockDir)).toEqual([])
    expect(await t.run(job)).toBe(JOB_EXIT.OK) // and can run again
  })

  it('failed: exit 1, the error on the end line, the lock released', async () => {
    const t = await setup()
    expect(await t.run(defineJob({ name: 'boom', run: async () => { throw new Error('upstream is down') } }))).toBe(JOB_EXIT.FAILED)
    expect(t.lines.at(-1)).toMatchObject({ level: 'error', msg: 'job end', job: 'boom', status: 'failed', error: 'upstream is down' })
    expect(readdirSync(t.lockDir)).toEqual([])
  })

  it('overlap: a second start while the first runs exits 3 and does not run', async () => {
    const t = await setup()
    let runs = 0
    let finish!: () => void
    const job = defineJob({ name: 'slow', run: () => new Promise<void>((resolve) => { runs++; finish = resolve }) })
    const first = t.run(job)
    await vi.waitFor(() => expect(runs).toBe(1))
    expect(await t.run(job)).toBe(JOB_EXIT.LOCKED)
    expect(runs).toBe(1)
    expect(t.lines.at(-1)).toMatchObject({ level: 'warn', msg: 'job skipped', job: 'slow', status: 'locked' })
    finish()
    expect(await first).toBe(JOB_EXIT.OK)
    expect(await t.run(defineJob({ name: 'slow', run: async () => { runs++ } }))).toBe(JOB_EXIT.OK)
    expect(runs).toBe(2)
  })

  it('timeout: exit 4, the job is told through its signal; the lock is released once the job has stopped', async () => {
    const t = await setup()
    const job = defineJob({ name: 'obedient', timeoutMs: 30, run: ({ signal }) => new Promise<void>((_, reject) => { signal.addEventListener('abort', () => reject(new Error('stopped'))) }) })
    expect(await t.run(job)).toBe(JOB_EXIT.TIMEOUT)
    expect(t.lines.at(-1)).toMatchObject({ level: 'error', status: 'timeout', timeoutMs: 30, stopped: true })
    expect(readdirSync(t.lockDir)).toEqual([])
  })

  // L4: releasing the lock while the timed-out job function is still running would let the next run start next to it
  it('timeout: a job that ignores the signal keeps the lock — the next start is refused while it may still be working', async () => {
    const t = await setup()
    let aborted = false
    const job = defineJob({ name: 'stuck', timeoutMs: 30, run: ({ signal }) => new Promise<void>(() => { signal.addEventListener('abort', () => { aborted = true }) }) })
    expect(await t.run(job, { abortGraceMs: 20 })).toBe(JOB_EXIT.TIMEOUT)
    expect(aborted).toBe(true)
    expect(t.lines.at(-1)).toMatchObject({ level: 'error', status: 'timeout', stopped: false })
    expect(readdirSync(t.lockDir)).toEqual(['stuck.lock.1'])
    expect(await t.run(job, { abortGraceMs: 20 })).toBe(JOB_EXIT.LOCKED)
    // once the process is gone (or the deadline has passed) the lock is superseded
    expect(await t.run(defineJob({ name: 'stuck', run: async () => undefined }), { lock: { isAlive: () => false } })).toBe(JOB_EXIT.OK)
    expect(readdirSync(t.lockDir)).toEqual([])
  })

  it('what a job returns cannot replace the standard fields of its end line', async () => {
    const t = await setup()
    expect(await t.run(defineJob({ name: 'liar', run: async () => ({ status: 'failed', job: 'other', ms: -1, changed: 2 }) }))).toBe(JOB_EXIT.OK)
    expect(t.lines.at(-1)).toMatchObject({ job: 'liar', status: 'ok', changed: 2 })
    expect(t.lines.at(-1)!.ms).toBeGreaterThanOrEqual(0)
  })

  it('audit only on change: the actor is the job, and a run that changes nothing writes no row', async () => {
    const t = await setup()
    await t.db.insertInto('users').values({ id: 'u1', subject: 's1', email: null, name: 'old', roles: '[]', createdAt: 'x', updatedAt: 'x', deletedAt: null }).execute()
    // an idempotent sync: set the name to what the source says
    const sync = defineJob<BaseTables>({
      name: 'sync-names',
      run: async ({ database }) => {
        let changed = 0
        await audited(database.db, { action: 'user.rename', target: 'user:u1' }, async (trx) => {
          const before = await trx.selectFrom('users').select(['id', 'name']).where('id', '=', 'u1').executeTakeFirstOrThrow()
          if (before.name !== 'new') {
            await trx.updateTable('users').set({ name: 'new', ...touched() }).where('id', '=', 'u1').execute()
            changed++
          }
          return { result: undefined, before, after: { ...before, name: 'new' } }
        })
        return { changed }
      },
    })
    const audit = () => t.db.selectFrom('audit').select(['actor', 'action', 'traceId']).execute()
    expect(await t.run(sync)).toBe(0)
    expect(await audit()).toEqual([{ actor: 'job:sync-names', action: 'user.rename', traceId: t.lines[0]!.traceId }])
    expect(t.lines.at(-1)).toMatchObject({ changed: 1 })
    for (let i = 0; i < 3; i++) expect(await t.run(sync)).toBe(0)
    expect(await audit()).toHaveLength(1) // three more runs, not one more row
    expect(t.lines.at(-1)).toMatchObject({ status: 'ok', changed: 0 })
  })
})

describe('runner cli', () => {
  it('runs the named job, lists jobs, and treats anything else as usage (2)', async () => {
    const t = await setup()
    const ran: string[] = []
    const jobs = { a: defineJob({ name: 'a', description: 'first', run: async () => { ran.push('a') } }), b: defineJob({ name: 'b', run: async () => { ran.push('b') } }) }
    const out: string[] = []
    const cli = (...argv: string[]) => runJobsCli(argv, { jobs, database: t.database, logger: t.logger, lockDir: t.lockDir, out: (line) => out.push(line) })
    expect(await cli('b')).toBe(0)
    expect(ran).toEqual(['b'])
    expect(await cli('--list')).toBe(0)
    expect(out).toEqual(['a  — first', 'b'])
    for (const bad of [[], ['nope'], ['a', 'extra'], ['--list', 'x'], ['constructor'], ['__proto__'], ['toString']]) expect(await cli(...bad), bad.join(' ')).toBe(JOB_EXIT.USAGE)
    expect(out.at(-1)).toContain('jobs: a, b')
    expect(ran).toEqual(['b'])
  })

  it('a job registered under another key than its name is a programming error', async () => {
    const t = await setup()
    await expect(runJobsCli(['x'], { jobs: { x: defineJob({ name: 'y', run: async () => undefined }) }, database: t.database, logger: t.logger, lockDir: t.lockDir })).rejects.toThrow(/registered as "x"/)
  })
})

describe('notify client (mocked hub)', () => {
  const message = { topic: 'ops-warn', title: 'Sync failed', message: 'upstream is down' }
  const hub = (status = 200) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{}', { status }))

  it('POSTs the message to <url>/notify with the bearer token', async () => {
    const fetch = hub()
    const notifier = createNotifier({ url: 'https://hub.example.com/', token: 'tok-123', fetch })
    expect(notifier.enabled).toBe(true)
    expect(await notifier.notify({ ...message, priority: 'high', dedupeKey: 'sync', resolved: false })).toEqual({ ok: true, status: 200 })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://hub.example.com/notify')
    expect(init!.method).toBe('POST')
    expect(init!.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer tok-123' })
    expect(JSON.parse(String(init!.body))).toEqual({ topic: 'ops-warn', title: 'Sync failed', message: 'upstream is down', priority: 'high', dedupe_key: 'sync', resolved: false })
  })

  it('off without a URL: nothing is sent, and the result says so', async () => {
    const fetch = hub()
    for (const url of [undefined, '', '  ']) {
      const notifier = createNotifier({ url, fetch })
      expect(notifier.enabled).toBe(false)
      expect(await notifier.notify(message)).toEqual({ ok: false, skipped: true })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never throws: a refusal, a network error and a hub that does not answer all come back as a result', async () => {
    const errors: string[] = []
    const onError = (error: string) => errors.push(error)
    expect(await createNotifier({ url: 'https://hub.example.com', fetch: hub(401), onError }).notify(message)).toEqual({ ok: false, status: 401, error: 'the hub answered 401' })
    const down = vi.fn(async () => { throw new Error('connect ECONNREFUSED') })
    expect(await createNotifier({ url: 'https://hub.example.com', token: 'tok-123', fetch: down, onError }).notify(message)).toEqual({ ok: false, error: 'connect ECONNREFUSED' })
    const silent = vi.fn((_url: any, init?: RequestInit) => new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))))
    expect(await createNotifier({ url: 'https://hub.example.com', fetch: silent, timeoutMs: 20, onError }).notify(message)).toEqual({ ok: false, error: 'no answer within 20 ms' })
    expect(errors).toEqual(['the hub answered 401', 'connect ECONNREFUSED', 'no answer within 20 ms'])
    expect(errors.join()).not.toContain('tok-123')
  })

  // L3: userinfo in NOTIFIER_URL put the credentials into every error message, result and log line
  it('a URL with credentials, or one that is not http(s), is a config error that never repeats the value', () => {
    const withCredentials = ['https://ops', 'hunter2@hub.example.com'].join(':')
    for (const url of [withCredentials, 'https://ops@hub.example.com', 'ftp://hub.example.com', 'not a url']) {
      let message = ''
      try { createNotifier({ url }) } catch (error) { message = `${(error as Error).name}: ${(error as Error).message}` }
      expect(message, url).toMatch(/^NotifierConfigError: NOTIFIER_URL /)
      expect(message).not.toMatch(/hunter2|ops@|hub\.example/)
    }
    expect(createNotifier({ url: ' https://hub.example.com/base/ ' }).enabled).toBe(true)
  })

  it('sends no authorization header without a token and leaves optional fields out', async () => {
    const fetch = hub()
    await createNotifier({ url: 'https://hub.example.com', fetch }).notify(message)
    expect(fetch.mock.calls[0]![1]!.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual(message)
  })
})
