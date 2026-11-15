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
  extends: ['github:like12like12s/nuxt-base#v0.1.1'],
  // app-specific only: devServer port, runtimeConfig, modules, extra css…
})
```
Measured: a consumer build with the peers installed takes ~6 s. `[ 'github:…', { install: true } ]` also works but runs
`npm install` inside the cached layer (its dev deps too, ~600 packages, minutes) — avoid.

- The layer already sets `ssr: false`, the Tailwind Vite plugin, `base.css`, head defaults (lang th, dark class, viewport,
  theme-color, favicon). Do **not** add `@nuxtjs/tailwindcss` or a second `tailwindcss()` plugin.
- Private repo → `GIGET_AUTH=<github token>` in the env of `nuxt build`/`nuxi prepare` (Docker build args, CF Pages env).
- Bump = change the tag. Nuxt caches git layers in `node_modules/.c12/` — delete it to force a refetch of the same tag.
- Local development of the layer itself: `extends: ['../nuxt-base']` (relative path), then switch back to the tag.

## What you get

- **Tokens** (`app/assets/css/base.css`, `@theme`): `bg-bg bg-surface bg-surface-2 border-line text-fg text-fg-2 text-muted
  text-faint bg-accent text-accent-fg bg-danger rounded-ui` — zinc dark default (UI standard v1). `dark:` is class-driven
  (`html.dark`). Scrollbar/focus/reduced-motion base styles included. External sites override tokens in their own css
  with another `@theme { --color-bg: … }` block after the layer's.
- **Components** (auto-imported, no prefix): Avatar Badge Btn Card ConfirmModal Drawer Dropdown DropdownItem Field
  HelpPopover Input Markdown Modal QuickChat SearchSpotlight Segmented Select Slider StatCard Table Tabs Toast Toggle UiHint
  (the former template set) + `LoadingState` `EmptyState` `ErrorState` `AsyncState`.
- **Patterns**: `<AsyncState :pending :error :empty :retry :has-data>` enforces loading → error → empty → content and never
  flashes an empty state while pending. `EmptyState` = title + what to do + CTA slot. `ErrorState` = what failed + real
  message + retry. `app/error.vue` default error page.
- **Composables**: `useSiteHead({ title, description, image })` (title + OG/Twitter from `app.config.nuxtBase.site`;
  call it in `app.vue` — SPA mode needs client-side head). `useToast()` → `toast.show(msg)` + `<Toast :message="toast.message" />`.
- **Auth hook point**: `useAuth()` → `{ user, ready, isAuthenticated, load, login }`. Off by default. Enable in
  `app/app.config.ts`: `nuxtBase: { auth: { enabled: true, loginUrl: '/outpost.goauthentik.io/start?rd={rd}' } }` — the
  layer's Nitro route `GET /api/_me` reads the `X-Authentik-*` headers Caddy forward-auth sets. Other schemes: ship your
  own `app/composables/useAuth.ts` (project files override layer files of the same name).
- **Config defaults**: `runtimeConfig.public.apiBase` ('' = same origin; `NUXT_PUBLIC_API_BASE` in dev), `typescript.strict`.

Override anything by defining the same file/key in the app (Nuxt deep-merges config, app files win).

## Develop the layer

```bash
npm install
npm run dev          # playground on :3517
npm test             # build playground → vitest (nuxt env) → playwright e2e (built app) → templates mirror check
npm run gate         # typecheck + test
scripts/sync-templates.sh   # push component changes to ~/.dev-mem/templates/components (mirror for non-Nuxt Vue apps)
git tag v0.x.y && git push --tags
```

Rules: components change **here** (never in an app); after a release bump the tag in each app. Drift checks are jobs
(templates mirror in `npm test`; app-side layer version check = next pilot step).
