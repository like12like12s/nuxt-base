// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { recordPreview } from '../../server/og'
import { serverApi } from '../../server/utils/server-api'

const answer = (body: unknown, status = 200) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

// Link previews of record pages: the UI server asks the API with its own read-only service token, because a crawler
// cannot sign in.
describe('serverApi', () => {
  it('GETs the API at API_URL with the service token as a bearer', async () => {
    const fetch = answer({ data: { id: '1', name: 'First' } })
    expect(await serverApi('/api/v1/orders/1', { fetch, apiUrl: 'http://api:3000/', token: 'kit_test-token' })).toEqual({ data: { id: '1', name: 'First' } })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://api:3000/api/v1/orders/1')
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer kit_test-token')
    expect(init!.method ?? 'GET').toBe('GET')
  })

  it('without a token the request carries no credentials', async () => {
    const fetch = answer({ data: {} })
    await serverApi('/api/v1/orders/1', { fetch, apiUrl: 'http://api:3000', token: '' })
    expect(fetch.mock.calls[0]![1]!.headers).not.toHaveProperty('authorization')
  })

  it('never throws: 401 / 404 / a dead API / a slow API are all `null`', async () => {
    for (const status of [401, 403, 404, 500]) expect(await serverApi('/api/v1/orders/1', { fetch: answer({ error: {} }, status), apiUrl: 'http://api:3000' })).toBeNull()
    expect(await serverApi('/api/v1/orders/1', { fetch: vi.fn(async () => { throw new TypeError('fetch failed') }), apiUrl: 'http://api:3000' })).toBeNull()
    const slow = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))))
    expect(await serverApi('/api/v1/orders/1', { fetch: slow, apiUrl: 'http://api:3000', timeoutMs: 20 })).toBeNull()
  })

  it('only takes a path — it cannot be pointed at another host', async () => {
    const fetch = answer({})
    for (const path of ['https://evil.example/x', '//evil.example/x', 'api/v1/x']) expect(await serverApi(path, { fetch, apiUrl: 'http://api:3000' })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('recordPreview', () => {
  const records = { '/orders': '/api/v1/orders' }

  it('a record page gets the record\'s own name, looked up through the API', async () => {
    const lookup = vi.fn(async () => ({ data: { id: '42', name: 'Order 42', description: 'Two widgets' } }))
    expect(await recordPreview('/orders/42', records, lookup)).toMatchObject({ title: expect.stringContaining('Order 42'), description: 'Two widgets' })
    expect(lookup).toHaveBeenCalledWith('/api/v1/orders/42')
  })

  it('no answer (unknown id, no token, API down) and unlisted or odd paths: null — the caller shows the site preview', async () => {
    expect(await recordPreview('/orders/42', records, async () => null)).toBeNull()
    expect(await recordPreview('/orders/42', records, async () => ({ data: { name: '' } }))).toBeNull()
    const lookup = vi.fn(async () => ({ data: { name: 'x' } }))
    for (const path of ['/orders', '/orders/', '/orders/42/extra', '/other/42', '/orders/a%2Fb', '/orders/..', `/orders/${'x'.repeat(80)}`]) expect(await recordPreview(path, records, lookup), path).toBeNull()
    expect(lookup).not.toHaveBeenCalled()
  })
})
