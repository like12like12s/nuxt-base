---
name: nuxt-base-changelog
description: Change history of nuxt-base (newest first)
---
# nuxt-base — Changelog

### t1093 — dev-kit A: kit core in `kit/` (epic t1092)
- `kit/bin/scaffold.mjs` + `kit/lib` — zero-dependency Node generator: `new | add | check | update | list`, `--json`, exit codes 0/1 drift/2 usage/3 dir not empty/4 unknown or planned/70 internal · pure (writes only under `--dir`; infra values arrive via `--context`, resolved by the `ai scaffold` wrapper in ai-cli, t1087)
- Kinds `nuxt-app` (extends the layer by tag), `api` (hono, zod env schema that fails fast, `/health/live`, JSON log, graceful shutdown), `fullstack` (`api/` + `ui/`, root gate runs both) · modules `base`, `ci-github` + 9 planned stubs (api, db, auth, trace, og, testkit, security, jobs, notify → t1094/t1095) · deploy presets cf-pages / container / pm2 · `gate:ci` = gate + gitleaks + npm audit
- Locked files: byte-copied from `kit/runtime/**`, sha256 in the project's `.scaffold.json`; `check` reports an edited/missing locked file or an old layer tag, `update` restores them (never touches app files or package.json)
- Public-repo ruling: `deploy-docker.sh` and the docker-node template are NOT shipped (internal hosts) — kit has its own locked Dockerfiles; the wrapper copies deploy-docker.sh · guard test fails on private IPs / `.int.` hosts / token shapes under `kit/`
- Tests: 94 kit unit specs in the vitest suite (gate: 105 unit + 4 e2e) · `npm run gate:kit` scaffolds 10 combos into temp dirs → install → gate → build → boot/health → tamper/check/update, builds and runs the container images (75 s) · `ai-verify:` = `npm run gate && npm run gate:kit`
- Notes: kit version = package.json version = layer tag (bump both together) · generated gates have no lint step yet · api uses typescript 7, the ui keeps the layer's 5.9 range · container combos in gate:kit build against the last released tag, not HEAD

## 2026-11-15

### t1086 — proof: drill/ui migrated to the layer (deployed)
- drill `ui/` now `extends github:like12like12s/nuxt-base#v0.1.3`; 11 copied components + main.css + own Tailwind plugin removed (drill 1a17df8), deployed tag `20261115-132406-1a17df8` on lxc-project, healthy
- Parity with `scripts/parity-shots.mjs` (10 routes, before vs after on the same live API, repeated on live): all 200, no new JS errors, pixel diff 0–3.3% on 8 routes, `/scenarios` 8.6% (+1 px/row × 365), error page replaced by the layer's. Every delta = the app's copies being behind the template (Toggle 20→24 px, Input 38→36 px, muted text zinc-500/600→400, focus ring, Modal Esc) — i.e. the drift the layer removes
- Evidence `~/archive/research/t1086-nuxt-base/` · jot note linked from the task report
- Follow-ups: t1087 (`ai scaffold`), t1088 (drift job), t1089 (remaining apps), t1090 (deploy-docker .env preflight)

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
