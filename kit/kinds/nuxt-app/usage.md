## UI (`{{kit.uiDir}}`)

```bash
cd {{kit.uiDir}}
npm run dev                 # Nuxt dev server on :{{kit.uiPort}} (LAN)
npm run gate                # typecheck + lint (oxlint) + unit tests (vitest, nuxt env) — no build, no e2e
npm run test:smoke          # build, then the @smoke e2e on :{{kit.e2ePort}} — the T1 pair with gate (GATE.md tiers)
npm run gate:full           # gate + build + all e2e — T2 (before a release; nightly on dev hosts)
npm run build && npm run serve
```

- Test tiers follow GATE.md (git-hooks): `gate` never builds or opens a browser; `test:smoke` is the authored
  `@smoke` suite (every e2e test the kit generates carries the tag); `gate:full` is everything. `tests/tiers.json`
  maps changed paths to specs (`exclusive: true` — the e2e port is fixed per project, so heavy-run runs one at a
  time).
- Every full playwright run (and a smoke grep) holds a slot in the host-wide heavy-run queue via the locked
  `scripts/lib/heavy-run-global-setup.mjs` (globalSetup): a bare `npx playwright test` queues too. Exit 75 = queue
  full = the suite has NOT run — retry, never report it as pass or fail. Off the queue host it is a no-op.

- Extends the nuxt-base layer `{{kit.layerRef}}`: tokens, components, `useSiteHead` / `useToast` / `useAuth` come from
  it. Never copy a layer component into the app — change it in the layer and bump the tag (`scaffold update`).
- One language: `{{kit.lang}}` (chosen with `scaffold new --lang`). The generated pages are written in it and
  `nuxtBase.lang` in `app/app.config.ts` makes the layer's own words (loading, empty, error, retry, confirm /
  cancel, the error page) match — write new pages in the same language; override a single layer label with
  `nuxtBase.labels`.
- Read `DESIGN.md` before touching UI. Pages go in `app/pages/`, app-only components in `app/components/`.
- New page: `scaffold add page <name>`.
