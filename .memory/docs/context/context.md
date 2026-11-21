---
name: nuxt-base-context
description: Current state of nuxt-base — the Nuxt 4 base layer + the dev-kit (project generator) for internal apps
---
# nuxt-base — Context

## Current State

- Two things in one repo (`like12like12s/nuxt-base`, path `~/projects/nuxt-base`, **public** — keep internal hosts/credentials out), one version = package.json = git tag (now **v0.5.5**):
  - Nuxt 4 **layer**: `extends: ['github:like12like12s/nuxt-base#vX.Y.Z']` + peer deps in the app — Tailwind 4 preset + zinc-dark tokens, 26 core Vue components (incl. Tooltip + icon-only IconButton, rule t1308) + Loading/Empty/Error/AsyncState, `useSiteHead`/`useToast`/`useAuth`, `error.vue`
  - **dev-kit** in `kit/` (epic t1092): zero-dep generator `kit/bin/scaffold.mjs` (`new | add | check | update | list`, `--json`) — kinds nuxt-app / api / fullstack; modules base, ci-github, api, db, auth, trace, og, testkit, security, jobs, notify; deploy presets cf-pages / container / pm2
- Kit model: app-owned files are generated once; locked runtime files are copied from `kit/runtime/**` to the app's `src/kit/<area>/` with hashes in `.scaffold.json`; `check` = clean | drift | kit-unreleased; `update` re-copies locked files and prints the by-hand steps from `kit/UPGRADING.md`
- Stack the kit generates: hono + zod-openapi (`/api/v1`, error shape with traceId, openapi.json contract test, typed client), Kysely (one migration set for SQLite and MySQL), forward-auth headers behind a trusted proxy + service tokens, OTel trace, generated gate = typecheck → oxlint → test
- Normal entry point is `ai scaffold` (ai-cli) — it reads the kit from the newest release tag on origin (cache), adds infra context and registers the project; never from this working tree
- Test tiers (GATE.md, t1444): `gate` (typecheck + lint + vitest + templates mirror — no build, no e2e) · `test:smoke` (build + 4 `@smoke` layer tests) = T1 · `gate:full` = gate + all e2e · `gate:kit` (every combo: install, gate, build, docker, MySQL — again after a release once the tag is on GitHub) · `tests/tiers.json` (exclusive, fullOn `kit/**` → ai-verify T2 runs gate:full + gate:kit) · every playwright run + the kit gate hold a heavy-run queue slot (globalSetup helper / self-wrap; exit 75 = not run) · CI = gate:ci + test:smoke
- No running service of its own. Jobs in pulse: `kit-drift-weekly` (Mon), `kit-gate-weekly` (Thu)
- Consumers: **kit-ref** (reference fullstack app, built only from the kit) · **drill/ui** (layer only) · **ui-kit** (submodule) · `~/.dev-mem/templates/components` (cmp mirror, `scripts/sync-templates.sh [--check]`)
- Fixture app `playground/` (port 3517 dev, 3518 e2e) · `scripts/parity-shots.mjs shoot|diff` (migration proof)
- Not built: `uploads` module · Next: t1089 migrate remaining Nuxt apps to the layer
- How-to in [usage](../guides/usage.md) + `kit/README.md` · history in [changelog](../changelog/changelog.md)
