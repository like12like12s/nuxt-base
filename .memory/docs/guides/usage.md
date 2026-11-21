---
name: nuxt-base-usage
description: How to consume, develop, test and release the nuxt-base layer
---
# nuxt-base — Usage

## Consume (any Nuxt 4 app)
```ts
extends: [['github:like12like12s/nuxt-base#v0.1.3']
```
- Remove from the app: `@nuxtjs/tailwindcss`, own `tailwindcss()` vite plugin, copied `Btn.vue`/`Modal.vue`/…, scrollbar css, `ssr:false` (layer sets it).
- Keep in the app: `devServer`, `runtimeConfig`, modules, app-specific head overrides, extra css (loaded after the layer's).
- Repo is public (2026-11-15) — no token needed at build time.
- Cache: `node_modules/.c12/` — remove to refetch.

## Develop
```bash
cd ~/projects/nuxt-base && npm install
npm run dev                 # playground :3517 (LAN)
npm run gate                # typecheck + build + vitest (layer + kit unit tests) + playwright + templates mirror check
scripts/sync-templates.sh   # after editing components → mirror to ~/.dev-mem/templates/components
```

## Kit (project generator, `kit/`)
```bash
node kit/bin/scaffold.mjs list                                          # kinds, modules, deploy presets
node kit/bin/scaffold.mjs new my-app --kind fullstack --deploy container --port 3920 --dir ~/projects/my-app --json
node kit/bin/scaffold.mjs check ~/projects/my-app                       # exit 1 = locked file / layer tag drift
npm run gate:kit                                                        # scaffold every combo -> install -> gate -> build -> run (slow, ~5 min)
node kit/tests/kit-gate.mjs --only api --keep                           # one family, keep temp dirs
```
- Contract, module/kind/preset authoring: `kit/README.md` · normally called through `ai scaffold` (ai-cli), not by hand.
- Every UI part ships `tests/kit/tiers-check.mjs` (locked, base module): the test-tier guard of git-hooks `GATE.md` — 3 checks inside `gate`, `--init-baseline` / `--write-map` to maintain `tests/tiers.json`.
- Fast kit unit tests run inside `npm run gate` (`kit/tests/*.spec.ts`); `gate:kit` is the slow proof and is part of `ai verify`.
<!-- ai-verify: npm run gate && npm run gate:kit -->

## Release
```bash
git tag v0.1.1 && git push && git push --tags
```
Then bump the tag in consumers (list in [context](../context/context.md)).

## Checks
- `npm test` fails if `~/.dev-mem/templates/components` drifts from `app/components`.
- e2e screenshot: `test-results/playground-index.png`.
