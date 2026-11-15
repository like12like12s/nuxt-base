## UI (`{{kit.uiDir}}`)

```bash
cd {{kit.uiDir}}
npm run dev                 # Nuxt dev server on :{{kit.uiPort}} (LAN)
npm run gate                # typecheck + lint (oxlint) + unit tests (vitest, nuxt env)
npm run test:e2e            # build, then playwright against the built app on :{{kit.e2ePort}} (fails on any pageerror / console error)
npm run build && npm run serve
```

- Extends the nuxt-base layer `{{kit.layerRef}}`: tokens, components, `useSiteHead` / `useToast` / `useAuth` come from
  it. Never copy a layer component into the app — change it in the layer and bump the tag (`scaffold update`).
- Read `DESIGN.md` before touching UI. Pages go in `app/pages/`, app-only components in `app/components/`.
- New page: `scaffold add page <name>`.
