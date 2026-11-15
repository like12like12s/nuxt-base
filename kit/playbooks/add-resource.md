---
name: {{kit.name}}-playbook-add-resource
description: Playbook — add an API resource (table, schemas, routes, tests, contract, typed client) to {{kit.name}}
---
# Playbook: add a resource

One command, then fill in. Do not copy `items` by hand.

```bash
scaffold add resource <name>        # plural kebab-case: orders, order-lines   (from the project root)
```

## What it generates (API: `{{kit.apiDir}}`)

```
src/resources/<name>/<name>.schema.ts   zod schemas: the record, create, update, id param, sortable columns
src/resources/<name>/<name>.repo.ts     list / get / create / update / soft delete — every write through audited()
src/resources/<name>/<name>.routes.ts   GET list + GET one + POST + PATCH + DELETE under /api/v1/<name>, contract-first
src/db/migrations/<NNNN>_<name>.ts      the table (standard columns + name), reversible
tests/<name>.spec.ts                    CRUD, validation, soft delete, audit
```

and registers it at the `kit:anchor` comments: `src/app.ts`, `src/db/migrations/index.ts`, `src/db/schema.ts`,
`tests/helpers.ts` (table cleanup) — plus, with the auth module, the route rows in the matrix of `tests/auth.spec.ts`.
In a fullstack project it also writes `ui/app/pages/<name>.vue` (a list page on the AsyncState pattern) and
`ui/tests/e2e/<name>.spec.ts`. An anchor that was removed stops the command and prints what to add by hand.

## What you fill in

1. The fields: `<name>.schema.ts` first, then the same columns in the migration, in the table type in
   `src/db/schema.ts` and in `COLUMNS` of `<name>.repo.ts`. Portable column rules: header of `src/kit/db/schema.ts`.
2. With auth: who may call each route (`middleware: [requireAuth()]` / `requireRole(...)` / `publicRoute()` in
   `<name>.routes.ts`) and the matching rows in `tests/auth.spec.ts`. Generated default: read = any signed-in caller,
   write = `admin` / `editor`, delete = `admin`.
3. Business rules in the repository (uniqueness, state changes) with a test for each.

## Then, in this order

```bash
npm run contract --prefix {{kit.apiDir}}      # openapi.json from the code — commit the diff
npm run client --prefix ui                    # fullstack only: ui/app/api/schema.d.ts from openapi.json
npm run db:migrate --prefix {{kit.apiDir}} -- up   # your development database
npm run gate                                  # must be green
```

## Tests that must pass

- `tests/<name>.spec.ts`, `tests/contract.spec.ts` (red until `npm run contract`), `tests/db.spec.ts` (the migration is
  reversible), with auth `tests/auth.spec.ts` (no undeclared route; the matrix covers every route).
- Fullstack: `npm run typecheck` in `ui/` (red until `npm run client`) and `npm run test:e2e` for the new page.
- Never edit `openapi.json` or `schema.d.ts` by hand, and never edit a migration that has shipped — add a new one.
