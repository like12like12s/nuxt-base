// Notifications against a mocked hub — a test never calls the real one.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeConfig } from '../src/config.js'
import { appNotifier } from '../src/notify.js'
import { testConfig } from './helpers.js'

afterEach(() => vi.unstubAllGlobals())
const message = { topic: 'ops-warn', title: 'Something happened', message: 'details' }

describe('notifications', () => {
  it('are off without NOTIFIER_URL: nothing is sent', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const notifier = appNotifier(testConfig())
    expect(notifier.enabled).toBe(false)
    expect(await notifier.notify(message)).toEqual({ ok: false, skipped: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('POST the message to the hub with the bearer token from the config', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const config = testConfig({ NOTIFIER_URL: 'https://hub.example.com', NOTIFIER_TOKEN: 'tok-for-tests' })
    expect(await appNotifier(config).notify(message)).toEqual({ ok: true, status: 200 })
    expect(fetch.mock.calls[0]![0]).toBe('https://hub.example.com/notify')
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ authorization: 'Bearer tok-for-tests' })
    expect(describeConfig(config).NOTIFIER_TOKEN).toBe('***') // never logged
  })

  it('a hub that is down does not throw; it is logged without the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED') }))
    const lines: Record<string, unknown>[] = []
    const logger = { debug() {}, info() {}, error() {}, warn: (msg: string, fields?: Record<string, unknown>) => { lines.push({ msg, ...fields }) } }
    const config = testConfig({ NOTIFIER_URL: 'https://hub.example.com', NOTIFIER_TOKEN: 'tok-for-tests' })
    expect(await appNotifier(config, logger).notify(message)).toEqual({ ok: false, error: 'connect ECONNREFUSED' })
    expect(lines).toEqual([{ msg: 'notification not sent', topic: 'ops-warn', title: 'Something happened', error: 'connect ECONNREFUSED' }])
  })
})
