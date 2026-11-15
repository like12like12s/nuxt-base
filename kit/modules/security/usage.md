## Security baseline (`{{kit.apiDir}}`, module `security`)

Applied to every route, system routes included (`createApi({ middleware: security({...}) })` in `src/app.ts`):

- **Headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS and a
  `Content-Security-Policy` that allows nothing — the API serves JSON, never a page.
- **CORS**: `CORS_ORIGINS` lists the exact origins that may call the API from a browser, with credentials. A wildcard
  is refused at boot. Empty (the default, and right for the fullstack layout where the browser only talks to the UI
  origin) = no CORS headers at all.
- **Body limit**: `BODY_LIMIT_BYTES` (default 1 MiB) -> `413` with code `VALIDATION`.
- **Rate limit**: `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS` per client -> `429` with code `RATE_LIMITED` and
  `retry-after`; `/health/*` is exempt; `0` = off. Who "the client" is:
  - a direct caller: its TCP peer address. `X-Forwarded-For` typed by a client is never believed.
  - behind the reverse proxy, with the `auth` module's proxy trust in place (`AUTH_PROXY_SECRET` and/or
    `AUTH_TRUSTED_PROXIES`): the client address that proxy reports (the last `X-Forwarded-For` entry) — each user has
    their own budget, also through the fullstack UI, which forwards the proxy's headers unchanged.
  - behind a proxy without that trust: everyone shares the proxy's one budget, and the API logs a warning once. That
    is why the default is `{{kit.rateLimitDefault}}` in this project (fullstack: off, the UI server is the peer of
    every request; api: 300). Set the trust and a limit, or leave it off and limit at the edge.
  The counters live in this process — a backstop, not a replacement for limits at the edge.
