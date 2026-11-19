# nuxt-base — Nuxt 4 base layer

One layer every internal Nuxt app extends instead of copying files. Tailwind 4 preset + design tokens, the core UI
components (single source — `~/.dev-mem/templates/components` is a verified mirror, ui-kit's registry reads from here),
loading/empty/error patterns, head/OG defaults, and an auth hook point. Versioned with git tags.

## Use it

```bash
npm i -D nuxt@^4.6 && npm i @tailwindcss/vite@^4.3 tailwindcss@^4.3 lucide-vue-next@^1   # the layer's peer deps
```
```ts
// nuxt.config.ts of the app
export default defineNuxtConfig({
  extends: ['github:like12like12s/nuxt-base#v0.1.3'],
  // app-specific only: devServer port, runtimeConfig, modules, extra css…
})
```
Measured: a consumer build with the peers installed takes ~6 s. `[ 'github:…', { install: true } ]` also works but runs
`npm install` inside the cached layer (its dev deps too, ~600 packages, minutes) — avoid.

- The layer already sets `ssr: false`, the Tailwind Vite plugin, `base.css`, head defaults (lang th, dark class, viewport,
  theme-color, favicon). Do **not** add `@nuxtjs/tailwindcss` or a second `tailwindcss()` plugin.
- The repo is public — builds need no token. Keep internal hosts/credentials out of it.
- Bump = change the tag. Nuxt caches git layers in `node_modules/.c12/` — delete it to force a refetch of the same tag.
- Local development of the layer itself: `extends: ['../nuxt-base']` (relative path), then switch back to the tag.

## What you get

- **Tokens** (`app/assets/css/base.css`, `@theme`): `bg-bg bg-surface bg-surface-2 border-line text-fg text-fg-2 text-muted
  text-faint bg-accent text-accent-fg bg-danger rounded-ui` — zinc dark default (UI standard v1). `dark:` is class-driven
  (`html.dark`). Scrollbar/focus/reduced-motion base styles included. External sites override tokens in their own css
  with another `@theme { --color-bg: … }` block after the layer's.
- **Components** (auto-imported, no prefix): Avatar Badge Btn Card ConfirmModal Drawer Dropdown DropdownItem Field
  HelpPopover IconButton Input Markdown Modal QuickChat SearchSpotlight Segmented Select Slider StatCard Table Tabs Toast
  Toggle Tooltip UiHint (the former template set) + `LoadingState` `EmptyState` `ErrorState` `AsyncState`.
- **Icon-only controls** (t1308): every icon-only button/link shows a tooltip on hover AND keyboard focus and carries a
  matching `aria-label` — native `title=` alone is not enough. Use `<IconButton label="…">` (label required → aria-label
  + title + tooltip) or wrap any trigger in `<Tooltip label="…">`.
- **Patterns**: `<AsyncState :pending :error :empty :retry :has-data>` enforces loading → error → empty → content and never
  flashes an empty state while pending. `EmptyState` = title + what to do + CTA slot. `ErrorState` = what failed + real
  message + retry. `app/error.vue` default error page.
- **Composables**: `useSiteHead({ title, description, image })` (title + OG/Twitter from `app.config.nuxtBase.site`;
  call it in `app.vue` — SPA mode needs client-side head). `useToast()` → `toast.show(msg)` + `<Toast :message="toast.message" />`.
- **Language of the layer's own words**: `nuxtBase: { lang: 'th' | 'en' }` in `app/app.config.ts` (default `th`) —
  loading, empty, error title, retry, confirm / cancel, the error page and `<html lang>` follow it; override single
  entries with `nuxtBase.labels: { retry: '…' }`; read them yourself with `useLabels()`. One language per app.
- **Auth hook point**: `useAuth()` → `{ user, ready, isAuthenticated, load, login }`. Off by default. Enable in
  `app/app.config.ts`: `nuxtBase: { auth: { enabled: true, loginUrl: '/outpost.goauthentik.io/start?rd={rd}' } }` — the
  layer's Nitro route `GET /api/_me` reads the `X-Authentik-*` headers Caddy forward-auth sets. Other schemes: ship your
  own `app/composables/useAuth.ts` (project files override layer files of the same name).
- **Config defaults**: `runtimeConfig.public.apiBase` ('' = same origin; `NUXT_PUBLIC_API_BASE` in dev), `typescript.strict`.

Override anything by defining the same file/key in the app (Nuxt deep-merges config, app files win).

## Start a new project from the kit

`kit/` is the project generator that ships with the layer (same tag): kinds `nuxt-app` · `api` · `fullstack`, composable
modules, deploy presets (`cf-pages` · `container` · `pm2`), locked kit files tracked in `.scaffold.json`. Contract and
authoring guide: [kit/README.md](kit/README.md).

```bash
node kit/bin/scaffold.mjs list
node kit/bin/scaffold.mjs new my-app --kind nuxt-app --dir ../my-app && cd ../my-app && npm install && npm run gate
```

## Develop the layer

```bash
npm install
npm run dev          # playground on :3517
npm test             # build playground → vitest (nuxt env) → playwright e2e (built app) → templates mirror check
npm run gate         # typecheck + test (includes the kit's unit tests)
npm run gate:kit     # kit: scaffold every kind/preset into a temp dir -> install -> gate -> build -> run
scripts/sync-templates.sh   # push component changes to ~/.dev-mem/templates/components (mirror for non-Nuxt Vue apps)
node scripts/parity-shots.mjs shoot <url> <dir> / /page … && node scripts/parity-shots.mjs diff <before> <after> <out>   # migration proof
git tag v0.x.y && git push --tags
```

Rules: components change **here** (never in an app); after a release bump the tag in each app. Drift checks are jobs
(templates mirror in `npm test`; app-side layer version check = next pilot step).
