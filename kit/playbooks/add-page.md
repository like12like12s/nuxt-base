---
name: {{kit.name}}-playbook-add-page
description: Playbook — add a page (route) to the UI of {{kit.name}}
---
# Playbook: add a page

```bash
scaffold add page <name>            # kebab-case: reports, order-history   (from the project root)
scaffold add page reports/monthly   # nested route  -> app/pages/reports/monthly.vue
scaffold add page reports/[id]      # dynamic route -> app/pages/reports/[id].vue (the page reads route.params.id)
```

- A page below an existing flat page (`reports/[id]` while `app/pages/reports.vue` exists) is refused: Nuxt would
  make `reports.vue` a parent layout and the new page would not render. Move the flat page to
  `app/pages/reports/index.vue` first (`git mv` — the command prints it), then add the page.
- A page named like an existing directory (`reports` while `app/pages/reports/` exists) is written as its `index.vue`.
- The pages of an API resource (list, detail, forms) come from `scaffold add resource`, not from here.

## What it generates (UI: `{{kit.uiDir}}`)

```
app/pages/<path>.vue                the route /<path>: title + the layer's AsyncState pattern
                                    (pending -> error with retry -> empty -> content); a dynamic page shows its params
tests/e2e/<path with - for />.spec.ts   opens the page in the built app; fails on any page error or console error
```

## What you fill in

1. `load()` in the page: fetch the data (fullstack: `useApi().GET('/api/v1/...')` — typed), set `rows` / `error`.
2. The content inside `<AsyncState>`; keep the empty and the error state. Components and tokens come from the layer —
   read `DESIGN.md` first; never copy a layer component into the app, never use a hex colour or another CSS framework.
3. Text in the project's one language (`answers.lang` in `.scaffold.json`; the generated strings already are).
4. The e2e spec: assert what the page shows. Stub the API with `stubApi()` from `tests/kit/e2e.ts` when the project
   has the test kit — e2e runs without a backend.

## Tests that must pass

```bash
npm run gate                        # typecheck + lint + unit tests
npm run test:e2e                    # in the UI directory: builds, then playwright against the built app
```

A page that renders but logs an error fails the e2e spec — fix the error, do not silence the check.
