import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createLogger } from '../src/kit/api/log.js'

function setup() {
  const lines: Record<string, unknown>[] = []
  const logger = createLogger('info', (line) => lines.push(JSON.parse(line)))
  const app = createApp(loadConfig({ PORT: '3000' }), { logger })
  return { app, lines }
}

describe('app', () => {
  it('answers the liveness probe', async () => {
    const { app } = setup()
    const res = await app.request('/health/live')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('answers unknown routes with a JSON 404', async () => {
    const { app } = setup()
    const res = await app.request('/nope')
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('NOT_FOUND')
  })

  it('writes one JSON log line per request, without the query string', async () => {
    const { app, lines } = setup()
    await app.request('/health/live?token=zz-secret-zz')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'request', method: 'GET', path: '/health/live', status: 200 })
    expect(JSON.stringify(lines[0])).not.toContain('zz-secret-zz') // non-hex marker: can never appear inside the random hex trace id
  })

  it('hides error details behind a JSON 500 and logs them', async () => {
    const { app, lines } = setup()
    app.get('/boom', () => { throw new Error('db password is hunter2') })
    const res = await app.request('/boom')
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('hunter2')
    expect(lines.some((l) => l.level === 'error')).toBe(true)
  })
})
