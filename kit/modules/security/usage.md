## Security baseline (`{{kit.apiDir}}`, module `security`)

Applied to every route, system routes included (`createApi({ middleware: security({...}) })` in `src/app.ts`):

- **Headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS and a
  `Content-Security-Policy` that allows nothing — the API serves JSON, never a page.
- **CORS**: `CORS_ORIGINS` lists the exact origins that may call the API from a browser, with credentials. A wildcard
  is refused at boot. Empty (the default, and right for the fullstack layout where the browser only talks to the UI
  origin) = no CORS headers at all.
- **Body limit**: `BODY_LIMIT_BYTES` (default 1 MiB) -> `413` with code `VALIDATION`.
- **Rate limit**: `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS` per client -> `429` with code `RATE_LIMITED` and
  `retry-after`; `/health/*` is exempt. It is a backstop: the client is the TCP peer (behind a proxy or the fullstack
  UI that is the proxy itself, so everyone shares one budget) and the counters live in this process. Put real limits
  at the edge; set `RATE_LIMIT_MAX=0` to switch this one off.
