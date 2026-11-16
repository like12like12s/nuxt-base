---
name: {{kit.name}}-playbook-add-resource
description: Playbook — add an API resource (table, schemas, routes, tests, contract, typed client) to {{kit.name}}
---
# Playbook: add a resource

One command, then fill in. Do not copy another resource by hand.

```bash
scaffold add resource <name>        # plural kebab-case: orders, order-lines   (from the project root)
scaffold add resource <name> --og   # fullstack with the og module: also give /<name>/<id> a link preview
```

`--og` is a decision, not a default: the preview of a record page carries the record's name, and anyone who can reach
the UI with a crawler user agent sees it. Without the flag the page gets the site's generic preview and the command
prints the one line to add to `RECORDS` in `ui/server/og.ts` if you decide so later.

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
An anchor that was removed stops the command and prints what to add by hand.

In a fullstack project it also writes the resource's pages, in the project's language:

```
ui/app/pages/<name>/index.vue       /<name>: the list (AsyncState: loading -> error with retry -> empty -> rows),
                                    an "add" button and the create form in a Modal
ui/app/pages/<name>/[id].vue        /<name>/<id>: the record, an edit form in a Modal, soft delete behind a ConfirmModal
ui/tests/e2e/<name>.spec.ts         list, empty / error / retry, create with a per-field 400, edit, delete, 404
```

A 400 from the API is shown at the field it is about: `apiProblem(res.error).fields.<field>` (locked
`app/utils/api-error.ts`, from the `details` of the error body); anything else as one line with the trace id.

## What you fill in

1. The fields: `<name>.schema.ts` first, then the same columns in the migration, in the table type in
   `src/db/schema.ts` and in `COLUMNS` of `<name>.repo.ts`. Portable column rules: header of `src/kit/db/schema.ts`.
2. With auth: who may call each route (`middleware: [requireAuth()]` / `requireRole(...)` / `publicRoute()` in
   `<name>.routes.ts`) and the matching rows in `tests/auth.spec.ts`. Generated default: read = any signed-in caller,
   write = `admin` / `editor`, delete = `admin`.
3. Business rules in the repository (state changes, further uniqueness) with a test for each. The generated resource
   already keeps `name` unique among live rows — in the database (generated `liveName` column + unique index, see
   `liveValue` in `src/kit/db/schema.ts`), answered as `409 CONFLICT`. Use the same pattern for any other unique
   field; never check-then-insert. If names need not be unique, remove the column, the index and the 409 mapping.

4. Fullstack — every field you added, in both pages: an entry in `form` (a `ref({...})`, not `reactive()`), an input
   with its `problem.fields.<field>` line in the form, the field in the request `body`, a row in the detail list —
   and the same in the stubs and assertions of `ui/tests/e2e/<name>.spec.ts`.

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
