# nuxt-base kit — project generator

Composable scaffolding for new projects: a **kind** (what the project is) + **modules** (capabilities) + a **deploy
preset**, composed into a complete, gated project. It lives next to the layer so one git tag versions both: the kit
version is the `version` in the repo's `package.json`, and a generated UI extends the layer at that tag.

Plain Node 24 ESM, no build step, no dependencies. The generator is **pure**: it writes files under `--dir` and does
nothing else — no `npm`, no `git`, no registration, no network. It holds no infrastructure value (this repo is
public); hosts, registries and domains arrive at run time through `--context`. The `ai scaffold` wrapper (ai-cli) owns
everything around it: preflight, install, gate, git, registration.

## CLI contract

```
node <KIT>/bin/scaffold.mjs new <name> --kind nuxt-app|api|fullstack [--with a,b,c] [--db sqlite|mysql]
     [--deploy cf-pages|container|pm2] [--port N] [--api-port N] --dir <target> [--context ctx.json] [--dry-run] [--json]
node <KIT>/bin/scaffold.mjs add resource|page|job <name> [--dir <project>] [--json]
node <KIT>/bin/scaffold.mjs check [<dir>] [--json]     exit 0 clean · 1 drift
node <KIT>/bin/scaffold.mjs update [<dir>] [--json]    re-copy locked files + bump the layer tag
node <KIT>/bin/scaffold.mjs list [--json]              kinds, modules, deploy presets, kitVersion
```

`KIT` = `$AI_KIT_DIR`, default the directory this file is in.

```
exit  meaning
0     ok
1     drift — `check` only: a locked file was edited / is missing / is behind the kit, or the layer tag is behind
2     usage — bad flag or name, missing --kind / --dir, not a scaffolded project (check / update / add)
3     the target dir exists and is not empty (`new`) · a generator's output file already exists (`add`)
4     unknown or incompatible kind, module (also: planned) or preset · no generator for that type in the project
70    internal error (a kit or generator bug). Deliberately not 1, so a crash never reads as drift.
```

With `--json` the result is one JSON document on stdout. Errors: `{ "ok": false, "code", "message" }` on stdout plus
the exit code (without `--json`: the message on stderr).

```
new     { ok, dir, name, kind, modules[], db, deploy, kitVersion, files[], locked[],
          services[{ id, name, type: "web"|"api", port, healthPath }], env[{ key, required, secret }],
          backup[{ id, service, engine: "sqlite"|"mysql", envKey, path? | database? }], next[] }
          (+ "dryRun": true with --dry-run — same plan, nothing written)
add     { ok, dir, type, name, generator, files[], next[] }
check   { ok, dir, clean, kit: { project, current }, layer: { current, latest, behind } | null,
          drift[{ path, reason: "modified"|"missing"|"outdated"|"new-in-kit"|"removed-from-kit" }] }
update  { ok, dir, kit: { from, to }, updated[], orphaned[], layer: { from, to, file } | null, warnings[] }
list    { ok, kitVersion, layerRef, kinds[{ name, description, parts[{ type, dir }] }],
          modules[{ name, status: "ready"|"planned", implicit, kinds[], requires[], generators[], description }],
          deploy[{ name, kinds[], description }], generators[] }
```

- `name`: lowercase kebab-case. `services[].id` is `<name>-web` / `<name>-api`; the wrapper adds the environment
  when it registers them.
- Ports: one-part kinds use `--port` (default 3000). `fullstack`: `--port N` alone = API on N, UI on N+1 (port
  pairing); with `--api-port`, `--port` is the UI port.
- `backup` is what a backup job has to cover (empty without the `db` module): `path` = the SQLite file relative to
  the project, `database` = the MySQL schema, `envKey` = where the real location is configured. The generator
  registers nothing — the wrapper does.
- `--context ctx.json` — every key optional, obvious placeholders otherwise:
  `{ "title", "description", "layerRef", "deploy": { "registry", "host", "domain", "user" }, "otlpEndpoint", "authentikUrl", "mysqlHost" }`.
  `layerRef` defaults to `github:like12like12s/nuxt-base#v<kitVersion>`; `deploy.registry` is the registry the deploy
  host pulls from; `mysqlHost` is the host in the example `DATABASE_URL` of a `--db mysql` project (never a
  credential). Keys a module does not use are ignored.
- `.scaffold.json` (in every generated project):
  `{ "kit", "kind", "modules", "db", "deploy", "layerRef", "answers": { name, title, description, port, apiPort, deploy, mysqlHost? }, "locked": { "<path>": "<sha256>" } }`.
  `answers` is everything needed to re-compose the project, which is how `check` / `update` / `add` work.

### check / update

`check` re-composes the project from `.scaffold.json` with the current kit and compares, read-only:

```
modified          the file on disk differs from the recorded hash (someone edited a locked file)
missing           a locked file is gone
outdated          the kit ships a newer version of the file
new-in-kit        the kit now locks a file this project does not have
removed-from-kit  the kit no longer ships a file this project has locked
layer.behind      the project's layer tag is older than the kit's (only for github:like12like12s/nuxt-base#vX.Y.Z refs —
                  a local path or a newer tag is left alone)
```

`update` writes the current locked files, replaces the old layer ref with the new one in the UI's `nuxt.config.ts`, and
rewrites `.scaffold.json`. It never touches an app-owned file and never deletes: a file the kit dropped is reported as
`orphaned` and left in place; a layer ref it cannot find in `nuxt.config.ts` is a warning, and `check` keeps failing.
It does not change `package.json` — dependency bumps stay a deliberate, reviewed change.

## Layout

```
bin/scaffold.mjs        the CLI (argument parsing, output, exit codes)
lib/                    kit.mjs (load the tree) · compose.mjs (selection -> files) · commands.mjs · render / pkg / fsutil / errors
kinds/<name>/           kind.json + files/           nuxt-app · api · fullstack
modules/<name>/         module.json (+ files/, generators/)   base (always) · ci-github · api · db · testkit
                        planned: auth trace og security jobs notify
presets/deploy/<name>/  preset.json + files/         cf-pages · container · pm2
runtime/                files copied byte for byte into apps and locked: runtime/<area>/* -> src/kit/<area>/*
                        (api · db · testing; testing/e2e.ts -> the UI's tests/kit/), project/gate-ci.mjs -> scripts/
tests/                  *.spec.ts (unit, in `npm run gate`) · kit-gate.mjs + combos.mjs (`npm run gate:kit`)
```

## How composition works

A kind, a module and a deploy preset are all **units** with the same descriptor. A kind declares its **parts** — an
`api` part and/or a `ui` part, each in a directory (`""` = the project root). Every unit contributes to targets:
`project` (the root) or a part type; a contribution to a part the kind does not have is skipped.

```jsonc
{
  "name": "example",                       // = directory name
  "description": "one line, shown by `list`",
  "status": "ready",                       // modules: "ready" | "planned" (planned = listed, refused by `new` with exit 4)
  "kinds": ["api", "fullstack"],           // modules and presets: the kinds they support (anything else = exit 4)
  "requires": ["db"],                      // modules: pulled in automatically, transitively
  "parts": [{ "type": "api", "dir": "api", "kind": "api" }],   // kinds only; "kind" borrows that kind's part contribution
  "contributes": {
    "api": {
      "package": { "dependencies": {}, "devDependencies": {}, "scripts": {} },   // merged into the part's package.json
      "env": [{ "key": "API_TOKEN", "required": true, "secret": true, "example": "", "description": "…" }],
      "files": [{ "from": "files", "to": "", "when": { "kind": ["api"] } }],      // file or directory, relative to the unit; rendered
      "locked": [{ "from": "runtime/api/env.ts", "to": "src/kit/api/env.ts" }],   // relative to the kit root; copied verbatim + hashed
      "backup": [{ "engine": "sqlite", "path": "data/{{kit.name}}.db", "envKey": "DATABASE_URL", "when": { "db": ["sqlite"] } }],  // -> `backup` of `new --json`
      "symlinks": [{ "path": "api", "target": "." }],
      "nuxtConfig": ["nitro: { preset: 'cloudflare-pages' },"],                   // lines added to the UI's defineNuxtConfig
      "gitignore": ["dist/"],
      "usage": "usage.md",                                                         // section appended to .memory/docs/guides/usage.md
      "next": ["one line shown to the user after `new`"]
    },
    "project": {}, "ui": {}
  },
  "generators": { "page": { "module": "generators/page.mjs", "part": "ui" } }    // `scaffold add page <name>`
}
```

Rules that keep the output deterministic — **same inputs, byte-identical output**:

- Units apply in a fixed order: borrowed part kinds → the kind → `base` → other modules by name → the deploy preset.
  `package.json` fragments merge key by key and the later unit wins; dependency maps are written sorted.
- Templates may use `{{kit.<var>}}` only (Vue's own `{{ }}` is untouched). An unknown variable is an error. Variables:
  `name title description titleJson descriptionJson kind kitVersion layerRef modules db deploy port uiPort apiPort
  apiDir uiDir dir registry deployHost deployDomain deployUser mysqlHost dbName databaseUrlExample services nuxtConfig
  usageSections`. Use the `*Json` forms inside source code — they are quoted and escaped.
- No clock, no randomness, no environment lookups in a template or in `lib/compose.mjs`.
- Two units writing the same path is an error, not a merge. Variants use `when` on a `files` / `locked` / `symlinks` /
  `backup` entry — every key given must hold: `kind: [..]` (the project's kind is one of), `with: [..]` (all of these
  modules are selected), `without: [..]` (none of them is), `db: [..]` (the `--db` value is one of). That is how a
  module replaces a file of the kind: the kind ships it `without` the module, the module ships its own.
- A path segment `dot.x` in a `files/` tree becomes `.x` in the project (a real `.gitignore` inside the kit would act
  on this repo). `.gitignore` itself is assembled from the `gitignore` lines and is always written first.

### Locked files

A locked file is kit-owned code that lives in the app: it is copied byte for byte (never rendered, so its hash equals
the kit's), starts with a `DO NOT EDIT` header, and its sha256 goes into `.scaffold.json`. Put shared runtime in
`runtime/<area>/` and lock it into `src/kit/<area>/` — keep that mapping, because locked files import each other with
relative paths that must be the same in the kit and in the app (the kit's unit tests import them from `runtime/`).
Anything the app is meant to change is a normal `files` entry. Changing a locked source is a kit release: every
project sees it as `outdated` until `scaffold update`. `runtime/api/kit-version.ts` carries the kit version that
`GET /version` reports — bump it together with `package.json` (a unit test fails when they differ).

### Adding a module

1. `modules/<name>/module.json` with `status: "ready"`, `kinds`, `requires` and `contributes` (start from a planned stub).
2. App-owned templates under `modules/<name>/files/`, locked runtime under `runtime/<area>/`.
3. Unit tests in `tests/*.spec.ts` for what it composes; a combo in `tests/combos.mjs` so the kit gate installs,
   gates and builds a project that uses it (add `checks` for behaviour only a running app can show).
4. Document the env keys it needs (`env`) and, if it reads a `--context` key, list the key above.

### Generators (`scaffold add`)

A unit that is part of the project (its kind, or an installed module) may provide a generator per type. The module
default-exports `({ name, type, dir, part, manifest, project }) => ({ files: [{ path, content }], next?: [] })`, sync or
async, with paths relative to the part named in the descriptor (`"part": "ui" | "api"`, default the project root). The
dispatcher refuses to overwrite an existing file (exit 3) or to write outside the project, and writes all files or
none. When several units provide the same type the later one wins (modules override the kind). Shipped today: `page`
(kind `nuxt-app`, also in `fullstack`); `resource` and `job` arrive with the playbooks task — until then a new
resource is a copy of `src/resources/items/`.

## Kinds

```
nuxt-app    Nuxt 4 SPA extending the layer by git tag · DESIGN.md · vitest (nuxt env) · playwright e2e against the
            built app that fails on any pageerror / console error · gate = typecheck + unit
api         hono on Node (tsx dev, tsc build -> dist/) · src/config.ts = zod env schema: a missing key stops the boot
            and is named, no value is ever printed · /health/live · one JSON log line per request · graceful shutdown
            · src/app.ts creates the app · src/kit/** = locked runtime · `--with api,db` replaces the plain app
            with the API standard below
fullstack   api/ + ui/ in one repo, each with its own package.json and lockfile; the UI server proxies /api/** to
            the API (API_URL); the root package.json wires install / gate / build to both
```

Every kind gets `.gitignore` (first), `README.md`, `brief.md`, `.memory/docs/{context,guides,changelog}`,
`.env.example` per part, `.scaffold.json`, and `npm run gate` / `gate:ci` at the root. `gate` is typecheck → unit
tests (no lint step is generated yet — the gate contract allows only real parts). `gate:ci` (locked
`scripts/gate-ci.mjs`) = gate + `gitleaks` (a visible `NOTICE … SKIPPED` when the binary is absent) +
`npm audit --audit-level=high` in every directory that has a lockfile. `--with ci-github` adds a workflow running it.

## Modules: api · db · testkit

`api` and `db` always come together (each requires the other) and bring `testkit`: the standard's audit trail, soft
delete and readiness checks are database-backed, so there is one app shape to maintain and to gate. `--db sqlite|mysql`
only picks the defaults (`.env.example`, the `backup` entry); `DATABASE_URL` selects the engine at run time and the
code, migrations and tests are identical for both.

```
api       hono + @hono/zod-openapi (contract-first routes) · /api/v1 via mountV1() · one error shape for every status
          >= 400: { error: { code, message, details?, traceId } } with the fixed code set VALIDATION UNAUTHORIZED
          FORBIDDEN NOT_FOUND CONFLICT RATE_LIMITED INTERNAL (a 500 shows no cause; the log has it) · trace id from
          `traceparent` or generated, echoed in x-trace-id, on every log line (ts level msg service env traceId method
          path status ms) and in the audit row · lists: limit (50, max 200) / offset / sort / ids, envelopes { data } and
          { data, meta } · GET /health/live, /health/ready (pluggable checks, 503 + the check list), /version,
          /openapi.json · `npm run contract` writes openapi.json and tests/contract.spec.ts fails when it differs from
          the code · src/resources/items/ = the example resource (list / get / create / update / soft delete, audited)
          · fullstack: the UI gets app/api/schema.d.ts (openapi-typescript), useApi() (openapi-fetch) and a
          compile-time check of the typed client
db        Kysely · SQLite through node:sqlite (built in — no native module) or MySQL through mysql2 · one migration
          set written with the schema builder, every migration reversible · base tables users / audit /
          service_tokens · standard columns id / createdAt / updatedAt / deletedAt, soft delete, audited() = the write
          and its audit row in one transaction · connect + statement deadlines, bounded retry on transient errors only
          (deadlock, lock wait, connection refused; a lost connection replays reads, never writes), withTransaction()
          replays a whole unit, the pool closes on shutdown · db:migrate up|down|status, db:seed (deterministic),
          db:check (database == code; also what /health/ready asks) · backup before migrate: SQLite file copy, MySQL
          DB_BACKUP_CMD hook or refusal · container preset: a `db-check` compose service gates the API container
testkit   deterministic factories (seeded random, fixed clock, sequential ids) · one throwaway database per test file
          (SQLite temp file, or a MySQL `test_*` schema when TEST_MYSQL_URL is set) · in-process app client ·
          playwright helpers (captureErrors, stubApi) in the UI
```

Seams left for the modules that follow (`auth`, `trace`): the request context has a `user` slot (`getContext().user`,
read by `currentActor()` for the audit row) and the trace id comes from one function (`setTraceIdProvider()` lets an
OpenTelemetry module supply the active span's id).

## Deploy presets

```
cf-pages    nuxt-app only · nitro preset cloudflare-pages (output dist/) · wrangler devDependency · scripts cf:create / deploy
container   multi-stage Dockerfile + .dockerignore per part (locked) · docker/docker-compose.yml, docker/deploy.conf and
            docker/env.example filled from --context (deploy.registry / host / domain / user). With the db module the
            compose file has a one-shot `db-check` service the API depends on (`node dist/db/cli.js predeploy`: migrate
            when DB_MIGRATE_ON_DEPLOY=1, then database == image or the API does not start). A one-part project gets a
            symlinked service dir (`web -> .` / `api -> .`). The deploy script itself is NOT in the kit: it carries
            site-specific defaults, so the wrapper (or the developer) copies it from the private docker-node template.
pm2         ecosystem.config.cjs (time: true, ports in env only). Nothing is started: the generated usage.md documents
            starting it through the Pilot API.
```

A preset on a kind it does not support (`cf-pages` on `api` / `fullstack`) is exit 4.

## Testing the kit

```bash
npm run gate        # fast: the generator's unit tests run inside the repo's vitest suite (kit/tests/*.spec.ts) — no installs
npm run gate:kit    # slow: every combo in tests/combos.mjs -> temp dir -> npm install -> npm run gate -> build -> run it
node kit/tests/kit-gate.mjs --only fullstack --keep     # one family, keep the temp dirs
```

The unit tests cover composition per kind / preset / module, determinism, every exit code, check / update, generator
dispatch, the locked runtime at the source — `runtime-api` (trace id, error shape, pagination, health, createApi),
`runtime-db` (migrate up → down → up, audit, soft delete, retry with fault injection, the db commands) and
`runtime-testing` — and the **public-repo guard**, which fails when any file under `kit/` contains a private or
tailnet IPv4 address, a `.int.` hostname, an internal host alias or anything shaped like a token. The data-layer
tests run on SQLite; with `TEST_MYSQL_URL=mysql://<user>:<password>@<host>:3306` (a user that may create and drop
`test_*` schemas) they also run on MySQL, and say `SKIPPED` loudly when it is not set.

The kit gate additionally proves, per combo: locked files survive install and build; the API refuses to boot without
`PORT` and names it, then boots, answers `/health/live` and exits 0 on SIGTERM; the built UI serves the SPA (and passes
its playwright suite on the base `nuxt-app` combo); the pm2 file loads and points at real build output; with docker
available, each image builds, runs as `node` and answers its health path (`NOTICE … SKIPPED` otherwise); and an edited
locked file is caught by `check` and restored by `update`. UI combos extend the working tree (`layer: 'local'`) so the
layer and the kit are tested together; image builds extend the latest git tag from GitHub (`layer: 'tag'`), because a
docker build cannot see a host path. It cleans up its temp dirs, containers and images, also on failure.

For projects with the `db` module it also proves, on the built app: the committed `openapi.json` (and the UI's
`schema.d.ts`) are exactly what the code generates; `db check` fails and `/health/ready` is 503 until `migrate up`;
seeding twice changes nothing; list / create / soft delete, the error shape and the trace id over real HTTP; the
backup rule of `migrate`; in the image, the compose `db-check` gate (schema behind = `up` fails and no API runs,
`DB_MIGRATE_ON_DEPLOY=1` = migrated and ready). MySQL: the gate uses `TEST_MYSQL_URL` when set, else starts a
throwaway `mysql:8.4` container, else prints `NOTICE … SKIPPED`; the `--db mysql` combo runs its whole suite and its
CLI there (in a `test_gate_*` schema that is dropped again), and the job `kit-runtime@mysql` runs the kit's
data-layer unit tests there.
