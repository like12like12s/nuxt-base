import { afterEach, describe, expect, it, vi } from 'vitest'
import { useApi } from '~/composables/useApi'

afterEach(() => vi.unstubAllGlobals())

const respond = (body: unknown, status = 200) =>
  vi.fn(async (_request: Request) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

// The compile-time side (paths, params and bodies are type-checked) is app/api/schema.check.ts.
describe('useApi', () => {
  // @kit:if sample
  it('calls the API on the same origin and returns the typed envelope', async () => {
    const item = { id: '1', name: 'Widget', description: null, quantity: 2, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    const fetch = respond({ data: [item], meta: { limit: 2, offset: 0, total: 1 } })
    vi.stubGlobal('fetch', fetch)

    const { data, error } = await useApi().GET('/api/v1/items', { params: { query: { limit: 2, sort: '-createdAt' } } })
    expect(error).toBeUndefined()
    expect(data?.data[0]?.quantity).toBe(2)
    expect(data?.meta.total).toBe(1)
    const url = new URL(fetch.mock.calls[0]![0].url)
    expect(url.pathname + url.search).toBe('/api/v1/items?limit=2&sort=-createdAt')
  })

  it('returns the standard error body for a failed call', async () => {
    vi.stubGlobal('fetch', respond({ error: { code: 'NOT_FOUND', message: 'Item x not found', traceId: 'abc' } }, 404))
    const { data, error } = await useApi().GET('/api/v1/items/{id}', { params: { path: { id: 'x' } } })
    expect(data).toBeUndefined()
    expect(error?.error.code).toBe('NOT_FOUND')
    expect(error?.error.traceId).toBe('abc')
  })
  // @kit:else
  it('calls the API on the same origin and returns the typed body', async () => {
    const fetch = respond({ name: 'app', version: '0.1.0', commit: 'unknown', builtAt: 'unknown', kit: '0.0.0' })
    vi.stubGlobal('fetch', fetch)

    const { data, error } = await useApi().GET('/version', {})
    expect(error).toBeUndefined()
    expect(data?.kit).toBe('0.0.0')
    expect(new URL(fetch.mock.calls[0]![0].url).pathname).toBe('/version')
  })

  it('returns the standard error body for a failed call', async () => {
    vi.stubGlobal('fetch', respond({ error: { code: 'INTERNAL', message: 'Not ready', traceId: 'abc' } }, 503))
    const { data, error } = await useApi().GET('/health/ready', {})
    expect(data).toBeUndefined()
    expect(error?.error.code).toBe('INTERNAL')
    expect(error?.error.traceId).toBe('abc')
  })
  // @kit:end
})
