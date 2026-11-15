## API (`{{kit.apiDir}}`)

```bash
cd {{kit.apiDir}}
cp .env.example .env        # PORT is required — the API refuses to boot without it and names the missing key
npm run dev                 # tsx watch on :{{kit.apiPort}}
npm run build && npm start  # dist/index.js
npm run gate                # typecheck + unit tests
```

- `src/app.ts` creates the hono app (routes go here) · `src/config.ts` is the env schema · `src/index.ts` boots it.
- `src/kit/**` is locked kit runtime — never edit it; `scaffold check` / `scaffold update` keep it in sync.
- New env key: add it to `src/config.ts` (list it in `SECRETS` if it is one) and to `.env.example`.
- Health: `GET /health/live` · logs: one JSON line per request on stdout.
