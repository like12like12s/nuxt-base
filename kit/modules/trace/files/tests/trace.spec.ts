// Tracing of this app against an in-process fake collector: a span is exported, and the same trace id is on the
// response (x-trace-id), on the request's log line and in the audit row of a write.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startOtlpCollector, type OtlpCollector } from '../src/kit/testing/otlp-collector.js'
import { flushTracing, startTracing, stopTracing } from '../src/kit/trace/tracing.js'
import { TRACE_ID, useApp } from './helpers.js'

const t = useApp()
let collector: OtlpCollector

beforeAll(async () => {
  collector = await startOtlpCollector()
})
afterEach(() => stopTracing())
afterAll(() => collector.close())

describe('tracing', () => {
  it('off by default: no endpoint, no span, and the request still gets a trace id', async () => {
    expect(startTracing({ serviceName: 'test-api', env: {} })).toBe(false)
    const res = await t.build().api.get('/api/v1/items')
    expect(res.traceId).toMatch(TRACE_ID)
    await flushTracing()
    expect(collector.spans()).toEqual([])
  })

  it('with an endpoint: the span, x-trace-id, the log line and the audit row share one trace id', async () => {
    expect(startTracing({ serviceName: 'test-api', env: { OTEL_EXPORTER_OTLP_ENDPOINT: collector.url } })).toBe(true)
    const { api, lines } = t.build()
    const res = await api.post('/api/v1/items', { name: 'Traced' })
    expect(res.status).toBe(201)
    await flushTracing()

    const span = collector.spans().find((s) => s.name === 'POST /api/v1/items')
    expect(span).toMatchObject({ traceId: res.traceId, service: 'test-api', kind: 2, attributes: { 'http.response.status_code': 201 } })
    expect(lines.find((l) => l.msg === 'request')).toMatchObject({ traceId: res.traceId, path: '/api/v1/items', status: 201 })
    const audit = await t.db.selectFrom('audit').select('traceId').where('action', '=', 'item.create').executeTakeFirstOrThrow()
    expect(audit.traceId).toBe(res.traceId)
  })

  it('continues the trace of a trusted caller (TRUST_TRACEPARENT=1); anyone else starts a new trace', async () => {
    startTracing({ serviceName: 'test-api', env: { OTEL_EXPORTER_OTLP_ENDPOINT: collector.url } })
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    const headers = { traceparent: `00-${traceId}-00f067aa0ba902b7-01` }
    const res = await t.build({}, { TRUST_TRACEPARENT: '1' }).api.get('/api/v1/items', { headers })
    const untrusted = await t.build().api.get('/api/v1/items', { headers })
    await flushTracing()
    expect(res.traceId).toBe(traceId)
    expect(collector.spans().some((s) => s.traceId === traceId && s.parentSpanId === '00f067aa0ba902b7')).toBe(true)
    expect(untrusted.traceId).not.toBe(traceId)
    expect(collector.spans().some((s) => s.traceId === untrusted.traceId && !s.parentSpanId)).toBe(true)
  })
})
