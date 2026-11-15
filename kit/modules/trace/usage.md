## Tracing (`{{kit.apiDir}}`, module `trace`)

- OpenTelemetry, sent over OTLP/HTTP. **Off until `OTEL_EXPORTER_OTLP_ENDPOINT` is set** (e.g. the collector on the
  same host, `http://127.0.0.1:4318`): no exporter, no timers, no network. `OTEL_SERVICE_NAME` (default
  `{{kit.name}}-api`), `OTEL_TRACES_SAMPLER_ARG` (share of new traces kept, default 1), `OTEL_SDK_DISABLED=true` (kill switch).
- One SERVER span per request, named by the route as declared (`GET /api/v1/items/:id`), continuing the caller's
  `traceparent`. Health probes are not traced.
- The span's trace id is the request's trace id: the `x-trace-id` header, `traceId` on every log line, `traceId` in
  the audit row and in an error body. Search the logs for it, or open the trace with it.
- `src/tracing.ts` is the first import of `src/index.ts` (keep it there); spans are flushed on SIGTERM.
  Nothing is patched — the span comes from a hono middleware (`createApi({ before: [traceMiddleware()] })`), so there
  is no loader flag. Outgoing calls are not traced; forward `traceparent` yourself if a downstream should join.
- Tests use an in-process fake collector (`src/kit/testing/otlp-collector.ts`) — `tests/trace.spec.ts`.
