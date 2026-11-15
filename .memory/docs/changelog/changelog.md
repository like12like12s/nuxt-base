---
name: nuxt-base-changelog
description: Change history of nuxt-base (newest first)
---
# nuxt-base — Changelog

## 2026-11-15

### t1086 — v0.1.3: default favicon, vue-router 5 devDep
- `public/favicon.svg` default (the layer's head links `/favicon.svg`; apps without one — e.g. drill — would 404) · app's own `public/favicon.svg` overrides it · e2e +1
- devDep `vue-router` ^4.6 → ^5.5.1 to match what Nuxt 4.6.4 resolves (removed the duplicate + the `vue-router/volar/sfc-route-blocks` warning in typecheck)

### t1086 — v0.1.2: Card header-right slot + parity-shots tool
- `Card.vue`: `#header-right` slot ported back from drill's local copy (markup unchanged when the slot is absent) — mirror synced to `~/.dev-mem/templates/components`
- `scripts/parity-shots.mjs`: `shoot` (full-page screenshots per route, JS errors, optional API `--rewrite`) + `diff` (pixelmatch % per page) — used for the drill/ui migration proof; devDeps pixelmatch + pngjs
- Repo made **public** (user decision 2026-11-15) — no `GIGET_AUTH` needed in Docker/CF builds; never commit internal hosts/credentials here

### t1086 — v0.1.0: layer created (dev-velocity pilot step 1)
- New repo: Nuxt 4.6 layer with Tailwind 4 vite plugin, `base.css` (`@theme` tokens zinc dark, class-driven `dark:`, scrollbar/focus/reduced-motion), head defaults, `runtimeConfig.public.apiBase`
- Components: 24 moved from `~/.dev-mem/templates/components` (that dir is now a mirror; `scripts/sync-templates.sh --check` in `npm test`) + LoadingState / EmptyState / ErrorState / AsyncState (loading → error → empty → content, no empty flash while pending)
- Composables: `useSiteHead` (title + OG/Twitter from app.config), `useToast` (reactive), `useAuth` hook point (off by default; Nitro `GET /api/_me` reads X-Authentik-* headers) + `auth.client` plugin · `app/error.vue`
- Fixture `playground/` extends `..` · tests: vitest nuxt env (11) · playwright on the built playground (3: render/tokens/toast/async/head, 404 page, /api/_me) · typecheck 0 errors
- Gotchas found: `app.config.ts` must live in `app/` (root one is ignored in Nuxt 4 → `useAppConfig().nuxtBase` undefined) · playwright `testIdAttribute` set to `data-test` · composables return `reactive()` so `toast.message` / `auth.user` unwrap in templates

### t1086 — v0.1.1: peer deps instead of install:true
- Measured on a scratch consumer: `extends: 'github:…#v0.1.0'` with the 3 peers installed in the app → build 6 s, layer fetched to `node_modules/.c12/github_like12like12s_nuxt_*`, Tailwind compiled the layer's classes (`@source` works from node_modules) · `{ install: true }` also worked but ran `npm install` of the layer's dev deps (~600 pkgs)
- `package.json`: deps → `peerDependencies` (@tailwindcss/vite, tailwindcss, lucide-vue-next) · README/usage updated
- ui-kit now serves its registry Vue column from this repo (submodule `vendor/nuxt-base`) — see ui-kit changelog
