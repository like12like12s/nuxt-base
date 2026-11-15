// @vitest-environment node
// The locked runtime that ships into apps (kit/runtime/**) — tested here at the source.
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { EnvError, loadEnv, redactEnv } from '../runtime/api/env'
import { runWithContext } from '../runtime/api/context'
import { createLogger, describeError } from '../runtime/api/log'
import { gracefulShutdown } from '../runtime/api/shutdown'

const shape = {
  PORT: z.coerce.number().int().min(1),
  DATABASE_URL: z.string().url(),
  API_TOKEN: z.string().min(32),
  LOG_LEVEL: z.enum(['debug', 'info']).default('info'),
}
const secrets = ['API_TOKEN', 'DATABASE_URL'] as const
const good = { PORT: '3000', DATABASE_URL: 'mysql://app:s3cretpw@db.test/app', API_TOKEN: 'tok_'.padEnd(40, 'z') }

describe('env schema', () => {
  it('parses, coerces and applies defaults', () => {
    expect(loadEnv(shape, { source: good })).toMatchObject({ PORT: 3000, LOG_LEVEL: 'info' })
  })

  it('fails fast naming every missing key (unset or empty)', () => {
    let err: EnvError | undefined
    try { loadEnv(shape, { source: { PORT: '', LOG_LEVEL: 'debug' } }) } catch (e) { err = e as EnvError }
    expect(err).toBeInstanceOf(EnvError)
    expect(err!.keys.sort()).toEqual(['API_TOKEN', 'DATABASE_URL', 'PORT'])
    expect(err!.message).toContain('missing PORT')
    expect(err!.message).toContain('missing DATABASE_URL')
    expect(err!.message).toContain('missing API_TOKEN')
  })

  it('never prints a value: invalid secrets get no detail, and no input value appears anywhere', () => {
    const source = { PORT: 'not-a-port', DATABASE_URL: 'p4ssw0rd-not-a-url', API_TOKEN: 'short-secret' }
    let message = ''
    try { loadEnv(shape, { source, secrets }) } catch (e) { message = (e as Error).message }
    expect(message).toMatch(/invalid PORT \(.+\)/)
    expect(message).toMatch(/invalid DATABASE_URL(;|$)/)
    expect(message).toMatch(/invalid API_TOKEN(;|$)/)
    for (const value of Object.values(source)) expect(message).not.toContain(value)
  })

  it('redactEnv masks secrets for logging', () => {
    const safe = redactEnv(loadEnv(shape, { source: good }), secrets)
    expect(safe).toEqual({ PORT: 3000, DATABASE_URL: '***', API_TOKEN: '***', LOG_LEVEL: 'info' })
  })

  it('reads process.env by default', () => {
    vi.stubEnv('KIT_TEST_ONLY_KEY', 'yes')
    expect(loadEnv({ KIT_TEST_ONLY_KEY: z.string() })).toEqual({ KIT_TEST_ONLY_KEY: 'yes' })
    vi.unstubAllEnvs()
    expect(() => loadEnv({ KIT_TEST_ONLY_KEY: z.string() })).toThrow(/missing KIT_TEST_ONLY_KEY/)
  })
})

describe('logger', () => {
  it('writes one JSON object per line and honours the level', () => {
    const lines: string[] = []
    const log = createLogger('warn', (l) => lines.push(l))
    log.info('ignored')
    log.error('boom', { code: 7 })
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'error', msg: 'boom', code: 7 })
  })

  // L2: `fields` was spread last — a caller (or request data put into fields) could replace level / service / traceId
  it('fields add to a line but never replace the standard ones', () => {
    const lines: any[] = []
    const log = createLogger('info', (l) => lines.push(JSON.parse(l)), { service: 'svc', env: 'prod' })
    runWithContext({ traceId: 'real-trace' }, () => log.info('x', { traceId: 'spoofed', level: 'error', service: 'other', env: 'dev', msg: 'y', ts: 'never', extra: 1 }))
    expect(lines[0]).toMatchObject({ traceId: 'real-trace', level: 'info', service: 'svc', env: 'prod', msg: 'x', extra: 1 })
    expect(lines[0].ts).toMatch(/^\d{4}-/)
  })

  it('describeError masks the values a database driver quotes in its message; other errors are logged as they are', () => {
    const duplicate = Object.assign(new Error("Duplicate entry 'jane@example.com' for key 'users.users_email_uq'"), { code: 'ER_DUP_ENTRY', errno: 1062, sqlMessage: 'x' })
    const described = describeError(duplicate)
    expect(described.error).toBe("ER_DUP_ENTRY: Duplicate entry '?' for key '?'")
    expect(JSON.stringify(described)).not.toContain('jane@example.com')
    expect(described.stack).toMatch(/^Error: Duplicate entry '\?'[^\n]*\n\s+at /)
    expect(describeError(Object.assign(new Error('UNIQUE constraint failed: items.liveName'), { code: 'ERR_SQLITE_ERROR', errcode: 2067 })).error).toBe('ERR_SQLITE_ERROR: UNIQUE constraint failed: items.liveName')
    const plain = new Error("cannot read 'x' of undefined")
    expect(describeError(plain)).toEqual({ error: "cannot read 'x' of undefined", stack: plain.stack })
    expect(describeError('text')).toEqual({ error: 'text' })
  })
})

describe('graceful shutdown', () => {
  const server = (err?: Error) => ({ closed: 0, close(cb?: (e?: Error) => void) { this.closed++; cb?.(err) } })

  it('closes the server, runs cleanup, exits 0 — once, however many signals arrive', async () => {
    const s = server()
    const exit = vi.fn()
    const cleanup = vi.fn()
    const shutdown = gracefulShutdown(s, { exit, cleanup, signals: [] })
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')])
    expect(s.closed).toBe(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('exits 1 when closing fails, and on the hard deadline', async () => {
    const exit = vi.fn()
    const onError = vi.fn()
    await gracefulShutdown(server(new Error('nope')), { exit, onError, signals: [] })()
    expect(onError).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)

    vi.useFakeTimers()
    const stuck = vi.fn()
    void gracefulShutdown({ close() { /* never calls back */ } }, { exit: stuck, timeoutMs: 50, signals: [] })()
    await vi.advanceTimersByTimeAsync(60)
    expect(stuck).toHaveBeenCalledExactlyOnceWith(1)
    vi.useRealTimers()
  })

  // L9: the pool stayed open when the server could not be closed or the deadline passed
  it('cleanup (closing the pool) also runs when closing the server fails and when the deadline passes — once', async () => {
    const exit = vi.fn()
    const cleanup = vi.fn()
    await gracefulShutdown(server(new Error('nope')), { exit, cleanup, onError: vi.fn(), signals: [] })()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)

    vi.useFakeTimers()
    try {
      const late = vi.fn()
      const closePool = vi.fn()
      void gracefulShutdown({ close() { /* a request never finishes */ } }, { exit: late, cleanup: closePool, timeoutMs: 50, signals: [] })()
      await vi.advanceTimersByTimeAsync(60)
      expect(closePool).toHaveBeenCalledTimes(1)
      expect(late).toHaveBeenCalledExactlyOnceWith(1)

      // a cleanup that hangs cannot hold the exit back for more than cleanupTimeoutMs
      const hung = vi.fn()
      void gracefulShutdown({ close() {} }, { exit: hung, cleanup: () => new Promise<void>(() => undefined), timeoutMs: 50, cleanupTimeoutMs: 30, signals: [] })()
      await vi.advanceTimersByTimeAsync(60)
      expect(hung).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(40)
      expect(hung).toHaveBeenCalledExactlyOnceWith(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
