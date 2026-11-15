## API standard (`{{kit.apiDir}}`, module `api`)

```
GET /health/live     the process is up — touches nothing else (container HEALTHCHECK)
GET /health/ready    database reachable + schema == code -> 200, otherwise 503 with the failing checks
GET /version         name, version, commit, builtAt, kit
GET /openapi.json    the contract (same content as the committed openapi.json)
/api/v1/<resource>   the app's resources — plural, kebab-case; a breaking change goes to /api/v2
```

- Every status >= 400 has one body: `{ "error": { "code", "message", "details"?, "traceId" } }`. Codes: `VALIDATION`
  `UNAUTHORIZED` `FORBIDDEN` `NOT_FOUND` `CONFLICT` `RATE_LIMITED` `INTERNAL`. Handlers `throw notFound('Item', id)` /
  `conflict(...)` / `validation(...)` (`src/kit/api/errors.ts`); anything else becomes a 500 that shows no cause.
  A 503 from `/health/ready` uses `INTERNAL` with the check list in `details`.
- Trace id: taken from `traceparent`, else generated; returned in `x-trace-id`; on every log line of the request
  (`ts level msg service env traceId method path status ms`) and in the audit row. Quote it to find a request.
- Lists: `?limit=50&offset=0&sort=-createdAt` (limit 1-200; out-of-range is a 400, never clamped) and `?ids=a,b` for
  many in one call -> `{ data: [...], meta: { limit, offset, total } }`. One object -> `{ data: {...} }`.
- New resource: copy `src/resources/items/` (schema -> repo -> routes), register it in `src/app.ts`, add a migration,
  then `npm run contract` — `tests/contract.spec.ts` fails while `openapi.json` and the code disagree.
- Probes: `/health/ready` gives each check 2 s — set probe timeout >= 3 s, period >= 10 s, failure threshold >= 3.
