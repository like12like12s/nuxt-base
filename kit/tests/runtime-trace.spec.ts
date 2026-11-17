// @vitest-environment node
// The locked trace runtime (kit/runtime/trace/**) at the source: off without an endpoint; with one, a span reaches
// the collector (an in-process fake) and the SAME trace id is in the span, the x-trace-id header and the log line.
import { afterEach, describe, expect, it } from 'vitest'
import { createApi } from '../runtime/api/app'
import { setTraceIdProvider } from '../runtime/api/context'
import { notFound } from '../runtime/api/errors'
import { createLogger } from '../runtime/api/log'
import { testClient } from '../runtime/testing/client'
import { startOtlpCollector, type OtlpCollector } from '../runtime/testing/otlp-collector'
import { UNTRACED, flushTracing, sampleRatio, startTracing, stopTracing, traceMiddleware, tracesUrl, tracingActive, tracingEnabled } from '../runtime/trace/tracing'

const HEX32 = /^[0-9a-f]{32}$/
let collector: OtlpCollector | undefined

afterEach(async () => {
  await stopTracing()
  await collector?.close()
  collector = undefined
  setTraceIdProvider(() => undefined)
})

// `trust` = the app believes every caller's traceparent (createApi and the trace middleware share the predicate)
function app(trust = false) {
  const lines: Record<string, any>[] = []
  const logger = createLogger('info', (line) => lines.push(JSON.parse(line)), { service: 'svc', env: 'test' })
  const api = createApi({ name: 'svc', version: '1.0.0', logger, trustTraceparent: () => trust, before: [traceMiddleware({ trustParent: () => trust })] })
  api.get('/api/v1/things/:id', (c) => c.json({ data: { id: c.req.param('id') } }))
  api.get('/api/v1/missing/:id', () => { throw notFound('Thing', 'x') })
  api.get('/api/v1/boom', () => { throw new Error('kaboom') })
  return { api: testClient(api), lines }
}

async function tracing(env: Record<string, string> = {}) {
  collector = await startOtlpCollector()
  expect(startTracing({ serviceName: 'svc-api', version: '1.0.0', env: { OTEL_EXPORTER_OTLP_ENDPOINT: collector.url, NODE_ENV: 'test', ...env } })).toBe(true)
  return collector
}

describe('configuration', () => {
  it('is off without an OTLP endpoint; either endpoint variable turns it on; the kill switch wins', () => {
    expect(tracingEnabled({})).toBe(false)
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: '  ' })).toBe(false)
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example:4318' })).toBe(true)
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector.example/v1/traces' })).toBe(true)
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example:4318', OTEL_SDK_DISABLED: 'TRUE' })).toBe(false)
  })

  it('the traces URL: /v1/traces appended to the base endpoint, the explicit one used as is', () => {
    expect(tracesUrl({})).toBeUndefined()
    expect(tracesUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example:4318/' })).toBe('http://collector.example:4318/v1/traces')
    expect(tracesUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://a.example', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://b.example/custom' })).toBe('http://b.example/custom')
  })

  it('the sample ratio defaults to 1 and is clamped', () => {
    expect([undefined, '', 'abc', '0.25', '7', '-1'].map(sampleRatio)).toEqual([1, 1, 1, 0.25, 1, 0])
  })

  it('health probes are never traced', () => {
    for (const path of ['/health', '/health/live', '/health/ready']) expect(UNTRACED.test(path), path).toBe(true)
    for (const path of ['/healthz', '/api/v1/health', '/version']) expect(UNTRACED.test(path), path).toBe(false)
  })
})

describe('off', () => {
  it('without an endpoint nothing starts, and requests work as before (generated trace id, a trusted traceparent honoured)', async () => {
    expect(startTracing({ serviceName: 'svc-api', env: {} })).toBe(false)
    expect(tracingActive()).toBe(false)
    const { api } = app(true)
    expect((await api.get('/api/v1/things/1')).traceId).toMatch(HEX32)
    const incoming = 'ab'.repeat(16)
    expect((await api.get('/api/v1/things/1', { headers: { traceparent: `00-${incoming}-${'cd'.repeat(8)}-01` } })).traceId).toBe(incoming)
    await flushTracing() // a no-op, not an error
  })
})

describe('on — spans reach the collector', () => {
  it('one SERVER span per request; span, x-trace-id and the log line carry the same trace id', async () => {
    const otlp = await tracing()
    const { api, lines } = app()
    const res = await api.get('/api/v1/things/42?token=zz-secret-zz')
    expect(res.status).toBe(200)
    expect(res.traceId).toMatch(HEX32)
    await flushTracing()

    expect(otlp.requests).toEqual(['/v1/traces'])
    const spans = otlp.spans()
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({
      traceId: res.traceId,
      name: 'GET /api/v1/things/:id',
      kind: 2, // SPAN_KIND_SERVER
      service: 'svc-api',
      attributes: { 'http.request.method': 'GET', 'http.route': '/api/v1/things/:id', 'http.response.status_code': 200 }, // L16: no raw url.path (it can carry a token)
    })
    expect(JSON.stringify(spans)).not.toContain('zz-secret-zz') // no query string in a span either (non-hex marker: can never appear inside the random hex trace id)
    const logged = lines.filter((l) => l.msg === 'request')
    expect(logged).toHaveLength(1)
    expect(logged[0]!.traceId).toBe(res.traceId)
  })

  it('continues a trusted caller\'s trace: same trace id, the caller\'s span as parent', async () => {
    const otlp = await tracing()
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    const res = await app(true).api.get('/api/v1/things/1', { headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` } })
    await flushTracing()
    expect(res.traceId).toBe(traceId)
    expect(otlp.spans()[0]).toMatchObject({ traceId, parentSpanId: '00f067aa0ba902b7' })
  })

  // L1: an untrusted caller neither chooses the trace id nor forces the export with the sampled flag
  it('an untrusted caller\'s traceparent starts no trace of its choosing: new id, no parent, and the sample ratio still applies', async () => {
    const otlp = await tracing()
    const claimed = '4bf92f3577b34da6a3ce929d0e0e4736'
    const res = await app().api.get('/api/v1/things/1', { headers: { traceparent: `00-${claimed}-00f067aa0ba902b7-01` } })
    await flushTracing()
    expect(res.traceId).toMatch(HEX32)
    expect(res.traceId).not.toBe(claimed)
    expect(otlp.spans()).toHaveLength(1)
    expect(otlp.spans()[0]!.traceId).toBe(res.traceId)
    expect(otlp.spans()[0]!.parentSpanId).toBeUndefined()
    await stopTracing()

    const none = await tracing({ OTEL_TRACES_SAMPLER_ARG: '0' })
    await app().api.get('/api/v1/things/2', { headers: { traceparent: `00-${claimed}-00f067aa0ba902b7-01` } })
    await flushTracing()
    expect(none.spans()).toEqual([]) // the `-01` (sampled) flag of a stranger does not export anything
  })

  it('errors: the error body, the log line and the span agree on the trace id; a 5xx marks the span as failed', async () => {
    const otlp = await tracing()
    const { api, lines } = app()
    const missing = await api.get('/api/v1/missing/1')
    const boom = await api.get('/api/v1/boom')
    await flushTracing()
    expect(missing.body.error.traceId).toBe(missing.traceId)
    expect(boom.body.error.traceId).toBe(boom.traceId)
    expect(lines.find((l) => l.msg === 'unhandled error')!.traceId).toBe(boom.traceId)
    const byTrace = Object.fromEntries(otlp.spans().map((s) => [s.traceId, s]))
    expect(byTrace[missing.traceId!]).toMatchObject({ attributes: { 'http.response.status_code': 404 } })
    expect(byTrace[missing.traceId!]!.statusCode ?? 0).toBe(0)
    expect(byTrace[boom.traceId!]).toMatchObject({ attributes: { 'http.response.status_code': 500 }, statusCode: 2 })
  })

  it('health probes and unknown paths: no span for a probe, a low-cardinality name for a 404', async () => {
    const otlp = await tracing()
    const { api } = app()
    expect((await api.get('/health/live')).traceId).toMatch(HEX32)
    await api.get('/no/such/route/123')
    await flushTracing()
    expect(otlp.spans().map((s) => s.name)).toEqual(['GET'])
  })

  it('a ratio of 0 exports nothing for new traces but still keeps a sampled caller; the trace id stays consistent', async () => {
    const otlp = await tracing({ OTEL_TRACES_SAMPLER_ARG: '0' })
    const { api, lines } = app(true)
    const dropped = await api.get('/api/v1/things/1')
    const traceId = 'cd'.repeat(16)
    const kept = await api.get('/api/v1/things/2', { headers: { traceparent: `00-${traceId}-${'ef'.repeat(8)}-01` } })
    await flushTracing()
    expect(otlp.spans().map((s) => s.traceId)).toEqual([traceId])
    expect(kept.traceId).toBe(traceId)
    expect(lines.map((l) => l.traceId)).toEqual([dropped.traceId, traceId])
  })

  it('stopTracing flushes what is buffered and switches it off', async () => {
    const otlp = await tracing()
    const { api } = app()
    await api.get('/api/v1/things/1')
    expect(otlp.spans()).toHaveLength(0) // still buffered
    await stopTracing()
    expect(otlp.spans()).toHaveLength(1)
    expect(tracingActive()).toBe(false)
    await api.get('/api/v1/things/2')
    expect(otlp.spans()).toHaveLength(1)
    await stopTracing() // idempotent
  })
})
