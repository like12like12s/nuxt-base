## Fullstack layout

```bash
npm install                 # root postinstall installs api/ and ui/
npm run dev:api             # API on :{{kit.apiPort}}
npm run dev:ui              # UI on :{{kit.uiPort}}
npm run gate                # api gate, then ui gate
npm run test:smoke          # the ui part's @smoke e2e — T1 with gate (GATE.md tiers; the api has no e2e)
npm run gate:full           # both parts: gate + build (+ all ui e2e) — T2
npm run build
```

- The browser only talks to the UI origin: `ui/server/routes/api/[...path].ts` proxies `/api/**` to the API
  (`API_URL`, default `http://127.0.0.1:{{kit.apiPort}}`). Keep `NUXT_PUBLIC_API_BASE` empty — no host in the browser bundle.
- Each part keeps its own `package.json` and lockfile (one image per part); the root `package.json` only wires scripts.
