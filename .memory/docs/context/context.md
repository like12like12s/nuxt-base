---
name: nuxt-base-context
description: Current state of nuxt-base — the Nuxt 4 base layer all internal Nuxt apps extend
---
# nuxt-base — Context

## Current State

- Nuxt 4 **layer** (not an app): `extends: [['github:like12like12s/nuxt-base#vX.Y.Z', { install: true }]]` · repo `like12like12s/nuxt-base` · path `~/projects/nuxt-base`
- Contains: Tailwind 4 preset + `@theme` tokens (zinc dark), 24 core Vue components (moved from `~/.dev-mem/templates/components`, which is now a cmp-verified mirror) + LoadingState/EmptyState/ErrorState/AsyncState, `useSiteHead`/`useToast`/`useAuth`, `error.vue`, Nitro `GET /api/_me` (Authentik forward-auth headers)
- Fixture app `playground/` (port 3517 dev, 3518 e2e) · tests: vitest (nuxt env) 11 + playwright e2e 3 + templates mirror check · `npm run gate` = typecheck + test
- No running service — consumed at build time by other apps · created 2026-11-15 (t1086, dev-velocity pilot step 1 of t1085)
- Consumers: see [usage](../guides/usage.md) · history in [changelog](../changelog/changelog.md)
