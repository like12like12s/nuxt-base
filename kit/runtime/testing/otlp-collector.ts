// DO NOT EDIT — locked file from the nuxt-base kit (runtime/testing/otlp-collector.ts). Its hash is recorded in
// .scaffold.json; `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// A fake OTLP collector for tests: an HTTP server on a free loopback port that accepts POST /v1/traces (OTLP/JSON)
// and keeps what it received. Nothing leaves the process.
//   const collector = await startOtlpCollector()
//   startTracing({ serviceName: 'x', env: { OTEL_EXPORTER_OTLP_ENDPOINT: collector.url } })
//   ... make requests, await flushTracing() ...
//   collector.spans()   -> [{ traceId, spanId, name, kind, attributes, service }]
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface CollectedSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  attributes: Record<string, unknown>
  /** `service.name` of the resource that sent it. */
  service: string
  statusCode?: number
}

export interface OtlpCollector {
  /** Base URL — what OTEL_EXPORTER_OTLP_ENDPOINT is set to. */
  url: string
  /** Paths that were POSTed to, in order. */
  requests: string[]
  spans(): CollectedSpan[]
  close(): Promise<void>
}

type AnyValue = { stringValue?: string; intValue?: number | string; doubleValue?: number; boolValue?: boolean }
const valueOf = (value: AnyValue | undefined): unknown =>
  value?.stringValue ?? (value?.intValue !== undefined ? Number(value.intValue) : undefined) ?? value?.doubleValue ?? value?.boolValue
const attributes = (list: { key: string; value?: AnyValue }[] | undefined): Record<string, unknown> =>
  Object.fromEntries((list ?? []).map((entry) => [entry.key, valueOf(entry.value)]))

export async function startOtlpCollector(): Promise<OtlpCollector> {
  const bodies: any[] = []
  const requests: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push(req.url ?? '')
      try {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      } catch {
        res.writeHead(400).end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    spans: () =>
      bodies.flatMap((body) =>
        (body.resourceSpans ?? []).flatMap((resource: any) =>
          (resource.scopeSpans ?? []).flatMap((scope: any) =>
            (scope.spans ?? []).map(
              (span: any): CollectedSpan => ({
                traceId: span.traceId,
                spanId: span.spanId,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: span.name,
                kind: span.kind,
                attributes: attributes(span.attributes),
                service: String(attributes(resource.resource?.attributes)['service.name'] ?? ''),
                ...(span.status?.code !== undefined ? { statusCode: span.status.code } : {}),
              }),
            ),
          ),
        ),
      ),
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}
