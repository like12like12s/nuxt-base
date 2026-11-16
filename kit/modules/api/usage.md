## API standard (`{{kit.apiDir}}`, module `api`)

```
GET /health/live     the process is up — touches nothing else (container HEALTHCHECK)
GET /health/ready    database reachable + schema == code -> 200, otherwise 503 with the failing checks
GET /version         name, version, commit, builtAt, kit — commit / builtAt: APP_COMMIT / APP_BUILT_AT, in an image
                     also the deployed tag and the build stamp (`src/kit/api/build-info.ts`); `unknown` in dev
GET /openapi.json    the contract (same content as the committed openapi.json)
/api/v1/<resource>   the app's resources — plural, kebab-case; a breaking change goes to /api/v2
```

- Every status >= 400 has one body: `{ "error": { "code", "message", "details"?, "traceId" } }`. Codes: `VALIDATION`
  `UNAUTHORIZED` `FORBIDDEN` `NOT_FOUND` `CONFLICT` `RATE_LIMITED` `INTERNAL`. Handlers `throw notFound('Item', id)` /
  `conflict(...)` / `validation(...)` (`src/kit/api/errors.ts`); anything else becomes a 500 that shows no cause.
  A 503 from `/health/ready` uses `INTERNAL` with the check list in `details`.
  `COMMIT_OUTCOME_UNKNOWN` (503) is the one answer that is not a plain failure: the database connection failed while
  a write was being committed, so the write **may have been applied**. A client must not blindly send it again —
  read the record back (or list) first. Nothing in a handler is needed for it: `createApi()` maps the data layer's
  `CommitOutcomeUnknownError` to this response, and the code is part of the `Error` schema in `openapi.json`.
- Trace id: generated — or taken from `traceparent` when the caller is trusted to choose it (a request through the
  trusted proxy of the `auth` module, or every caller with `TRUST_TRACEPARENT=1` on an API only trusted clients
  reach); returned in `x-trace-id`; on every log line of the request
  (`ts level msg service env traceId method path status ms`) and in the audit row. Quote it to find a request.
- Lists: `?limit=50&offset=0&sort=-createdAt` (limit 1-200; out-of-range is a 400, never clamped) and `?ids=a,b` for
  many in one call -> `{ data: [...], meta: { limit, offset, total } }`. One object -> `{ data: {...} }`.
- New resource: `scaffold add resource <name>` (playbook-add-resource.md) — schema -> repo -> routes -> migration ->
  tests, registered in `src/app.ts`; then `npm run contract` — `tests/contract.spec.ts` fails while `openapi.json`
  and the code disagree.
<!-- @kit:if sample -->
- `src/resources/items/` is the example resource (with its migration `0002_items`, seed rows, tests and the `editor`
  role). A project that does not want it is created with `--no-sample`; to remove it later, delete those files, its
  lines in `src/app.ts`, `src/db/migrations/index.ts`, `src/db/schema.ts`, `src/db/seed.ts` and the tests, add a
  migration that drops the table, and run `npm run contract`.
<!-- @kit:end -->
- Probes: `/health/ready` gives each check 2 s — set probe timeout >= 3 s, period >= 10 s, failure threshold >= 3.
