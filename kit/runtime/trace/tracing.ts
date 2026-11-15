// DO NOT EDIT — locked file from the nuxt-base kit (runtime/trace/tracing.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// OpenTelemetry tracing for the hono API. Off unless an OTLP endpoint is configured — no exporter, no timers, no
// network calls:
//   OTEL_EXPORTER_OTLP_ENDPOINT          e.g. http://127.0.0.1:4318 (a local collector); `/v1/traces` is appended
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT   full URL of the traces endpoint (wins over the one above)
//   OTEL_SERVICE_NAME                    default: the name passed to startTracing()
//   OTEL_TRACES_SAMPLER_ARG              share of new traces kept, 0..1 (default 1); a sampled parent is always kept
//   OTEL_SDK_DISABLED=true               kill switch
// ESM-safe by construction: nothing is patched. The server span is made by traceMiddleware() (a plain hono
// middleware), so there is no require/import hook and no `--import` flag to remember. src/tracing.ts still is the
// first import of src/index.ts — the place to register instrumentations if the app ever needs them.
// While a span is active its trace id IS the request's trace id: x-trace-id, every log line, the audit row.
import { SpanKind, SpanStatusCode, context, isSpanContextValid, propagation, trace, type TextMapGetter } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, TracerProvider } from '@opentelemetry/sdk-trace'
import type { Context, MiddlewareHandler } from 'hono'
import { routePath } from 'hono/route'
import { hostname } from 'node:os'
import { setTraceIdProvider } from '../api/context.js'

type Env = Record<string, string | undefined>

export function tracingEnabled(env: Env = process.env): boolean {
  if ((env.OTEL_SDK_DISABLED ?? '').trim().toLowerCase() === 'true') return false
  return Boolean(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim())
}

/** Where spans are POSTed (OTLP over HTTP); undefined when tracing is off. */
export function tracesUrl(env: Env = process.env): string | undefined {
  if (!tracingEnabled(env)) return undefined
  const explicit = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  return explicit || `${env.OTEL_EXPORTER_OTLP_ENDPOINT!.trim().replace(/\/+$/, '')}/v1/traces`
}

/** OTEL_TRACES_SAMPLER_ARG -> share of new traces kept, clamped to 0..1; unset or garbage = 1. */
export function sampleRatio(raw: string | undefined): number {
  const n = Number(raw)
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(n)) return 1
  return Math.min(1, Math.max(0, n))
}

/** Requests never worth a trace: health probes. */
export const UNTRACED = /^\/health(\/|$)/

let provider: TracerProvider | null = null

export interface TracingOptions {
  /** `service.name` unless OTEL_SERVICE_NAME is set. */
  serviceName: string
  version?: string
  env?: Env
  /** How long a finished span may wait before it is sent (default 5 000 ms). */
  exportDelayMs?: number
}

/** Start tracing when an endpoint is configured. Returns whether it is on. Safe to call twice. */
export function startTracing(options: TracingOptions): boolean {
  const env = options.env ?? process.env
  const url = tracesUrl(env)
  if (provider || !url) return provider !== null
  provider = new TracerProvider({
    resource: resourceFromAttributes({
      'service.name': env.OTEL_SERVICE_NAME?.trim() || options.serviceName,
      ...(options.version ? { 'service.version': options.version } : {}),
      'deployment.environment.name': env.NODE_ENV || 'development',
      'host.name': hostname(),
    }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRatio(env.OTEL_TRACES_SAMPLER_ARG)) }),
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url }), scheduledDelayMillis: options.exportDelayMs ?? 5000 })],
  })
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  trace.setGlobalTracerProvider(provider)
  setTraceIdProvider(() => {
    const active = trace.getActiveSpan()?.spanContext()
    return active && isSpanContextValid(active) ? active.traceId : undefined
  })
  return true
}

export const tracingActive = (): boolean => provider !== null

/** Send what is buffered now (tests; a job right before it exits). */
export async function flushTracing(): Promise<void> {
  await provider?.forceFlush()
}

/** Flush and switch tracing off. Call it from the shutdown hook — otherwise the last seconds of spans are lost. */
export async function stopTracing(): Promise<void> {
  const current = provider
  provider = null
  setTraceIdProvider(() => undefined)
  if (!current) return
  try {
    await current.shutdown()
  } finally {
    trace.disable()
    propagation.disable()
    context.disable()
  }
}

const HEADERS: TextMapGetter<Headers> = {
  get: (carrier, key) => carrier.get(key) ?? undefined,
  keys: (carrier) => [...carrier.keys()],
}

/**
 * One SERVER span per request. Pass it to createApi({ before: [...] }) so it wraps the request scope: the scope then
 * takes its trace id from this span. Without startTracing() it does nothing.
 * The caller's trace (`traceparent`) is continued only when `trustParent` says the caller may choose it — the same
 * predicate as createApi's `trustTraceparent`. A sampled `traceparent` from anyone else would otherwise put an id of
 * the caller's choice into the audit trail and force the span to be exported whatever the sample ratio is. For an
 * untrusted caller the span starts a new trace and keeps the caller's context as a span LINK.
 */
export function traceMiddleware(options: { ignore?: RegExp; trustParent?: (c: Context) => boolean } = {}): MiddlewareHandler {
  const ignore = options.ignore ?? UNTRACED
  const trustParent = options.trustParent ?? (() => false)
  return async (c, next) => {
    if (!provider || ignore.test(c.req.path)) return next()
    const method = c.req.method
    const remote = propagation.extract(context.active(), c.req.raw.headers, HEADERS)
    const trusted = trustParent(c)
    const claimed = trace.getSpanContext(remote)
    const links = !trusted && claimed && isSpanContextValid(claimed) ? [{ context: claimed }] : []
    const tracer = trace.getTracer('nuxt-base-kit')
    await tracer.startActiveSpan(method, { kind: SpanKind.SERVER, attributes: { 'http.request.method': method }, links }, trusted ? remote : context.active(), async (span) => {
      try {
        await next()
      } finally {
        const status = c.res?.status ?? 500
        // The route as declared (/api/v1/items/:id), never the raw path: span names must be low-cardinality.
        let route: string | undefined
        try {
          route = routePath(c, -1)
        } catch {
          route = undefined
        }
        if (route && !route.endsWith('*')) {
          span.setAttribute('http.route', route)
          span.updateName(`${method} ${route}`)
        }
        // No `url.path`: the raw path can carry a secret (/reset/<token>, a signed link) and a trace backend is read
        // by more people than the request log. The declared route above says which endpoint it was.

        span.setAttribute('http.response.status_code', status)
        if (c.error) span.recordException(c.error)
        if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
        span.end()
      }
    })
  }
}
