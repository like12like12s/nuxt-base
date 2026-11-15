---
name: nuxt-base-usage
description: How to consume, develop, test and release the nuxt-base layer
---
# nuxt-base — Usage

## Consume (any Nuxt 4 app)
```ts
extends: [['github:like12like12s/nuxt-base#v0.1.2']
```
- Remove from the app: `@nuxtjs/tailwindcss`, own `tailwindcss()` vite plugin, copied `Btn.vue`/`Modal.vue`/…, scrollbar css, `ssr:false` (layer sets it).
- Keep in the app: `devServer`, `runtimeConfig`, modules, app-specific head overrides, extra css (loaded after the layer's).
- Repo is public (2026-11-15) — no token needed at build time.
- Cache: `node_modules/.c12/` — remove to refetch.

## Develop
```bash
cd ~/projects/nuxt-base && npm install
npm run dev                 # playground :3517 (LAN)
npm run gate                # typecheck + build + vitest + playwright + templates mirror check
scripts/sync-templates.sh   # after editing components → mirror to ~/.dev-mem/templates/components
```

## Release
```bash
git tag v0.1.1 && git push && git push --tags
```
Then bump the tag in consumers (list in [context](../context/context.md)).

## Checks
- `npm test` fails if `~/.dev-mem/templates/components` drifts from `app/components`.
- e2e screenshot: `test-results/playground-index.png`.
