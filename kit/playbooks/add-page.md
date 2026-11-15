---
name: {{kit.name}}-playbook-add-page
description: Playbook — add a page (route) to the UI of {{kit.name}}
---
# Playbook: add a page

```bash
scaffold add page <name>            # kebab-case: reports, order-history   (from the project root)
```

## What it generates (UI: `{{kit.uiDir}}`)

```
app/pages/<name>.vue                the route /<name>: title + the layer's AsyncState pattern
                                    (pending -> error with retry -> empty -> content)
tests/e2e/<name>.spec.ts            opens the page in the built app; fails on any page error or console error
```

## What you fill in

1. `load()` in the page: fetch the data (fullstack: `useApi().GET('/api/v1/...')` — typed), set `rows` / `error`.
2. The content inside `<AsyncState>`; keep the empty and the error state. Components and tokens come from the layer —
   read `DESIGN.md` first; never copy a layer component into the app, never use a hex colour or another CSS framework.
3. The e2e spec: assert what the page shows. Stub the API with `stubApi()` from `tests/kit/e2e.ts` when the project
   has the test kit — e2e runs without a backend.

## Tests that must pass

```bash
npm run gate                        # typecheck + lint + unit tests
npm run test:e2e                    # in the UI directory: builds, then playwright against the built app
```

A page that renders but logs an error fails the e2e spec — fix the error, do not silence the check.
