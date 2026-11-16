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
     [--deploy cf-pages|container|pm2] [--port N] [--api-port N] [--no-sample] [--lang th|en]
     --dir <target> [--context ctx.json] [--dry-run] [--json]
node <KIT>/bin/scaffold.mjs add resource|page|job <name> [--og] [--dir <project>] [--json]
                                   (page: <name> may be a route path — reports/monthly, reports/[id];
                                    resource --og: also list the detail page for link previews — opt-in)
node <KIT>/bin/scaffold.mjs check [<dir>] [--json]     exit 0 clean · 1 drift
node <KIT>/bin/scaffold.mjs update [<dir>] [--json]    re-copy locked files + bump the layer tag
node <KIT>/bin/scaffold.mjs update [<dir>] --show <path> [--json]
                                   print one file as this kit generates it for this project — writes nothing
node <KIT>/bin/scaffold.mjs list [--json]              kinds, modules, deploy presets, kitVersion
```

`KIT` = `$AI_KIT_DIR`, default the directory this file is in.

```
exit  meaning
0     ok
1     drift — `check` only: a locked file was edited / is missing / is behind a RELEASED kit, or the layer tag is
      behind. (Differences caused by unreleased work in the kit directory are not drift — exit 0, state `kit-unreleased`.)
2     usage — bad flag or name, missing --kind / --dir, not a scaffolded project (check / update / add),
      `add`: a `kit:anchor` comment the generator needs was removed (code `anchor_missing`; nothing is written),
      a route that names a parameter twice (`duplicate_param`), `--og` without the og module in a fullstack
      project (`og_unavailable`)
3     the target dir exists and is not empty (`new`) · a generator's output file already exists (`add`)
4     unknown or incompatible kind, module (also: planned) or preset · no generator for that type in the project
      · `update`: the project is at a NEWER kit than the one running (code `kit_older`; nothing is written)
70    internal error (a kit or generator bug). Deliberately not 1, so a crash never reads as drift.
```

With `--json` the result is one JSON document on stdout. Errors: `{ "ok": false, "code", "message" }` on stdout plus
the exit code (without `--json`: the message on stderr).

```
new     { ok, dir, name, title, description, kind, modules[], db, deploy, sample, lang, kitVersion, files[], locked[],
          services[{ id, name, type: "web"|"api", port, healthPath, internal? }], env[{ key, required, secret, generated? }],
          backup[{ id, service, engine: "sqlite"|"mysql", envKey, path? | database? }], next[] }
          (+ "dryRun": true with --dry-run — same plan, nothing written)
add     { ok, dir, type, name, generator, files[], patched[], next[] }
          (files = created, patched = existing app-owned files edited at a `kit:anchor` comment)
check   { ok, dir, clean, state: "clean"|"drift"|"kit-unreleased",
          kit: { project, current, commit: "<sha>"|null, unreleased, note? }, layer: { current, latest, behind } | null,
          drift[{ path, reason: "modified"|"missing"|"outdated"|"new-in-kit"|"removed-from-kit" }],
          unreleased[{ path, reason: "outdated"|"new-in-kit"|"removed-from-kit" }], warnings[] }
update  { ok, dir, kit: { from, to, commit, unreleased, note? }, updated[], orphaned[],
          layer: { from, to, file } | null, notes[{ from, to, items[] }], warnings[] }
update --show   { ok, dir, path, owner: "app"|"kit", kit: { project, current, commit, unreleased, note? }, content }
                (without --json: the file itself on stdout, byte for byte; unknown path = exit 2, code `unknown_file`)
list    { ok, kitVersion, layerRef, kinds[{ name, description, parts[{ type, dir }] }],
          modules[{ name, status: "ready"|"planned", implicit, kinds[], requires[], generators[], description }],
          deploy[{ name, kinds[], description }], generators[] }
```

- `name`: lowercase kebab-case. `services[].id` is `<name>-web` / `<name>-api`; the wrapper adds the environment
  when it registers them.
- `title` / `description`: what the project calls itself, exactly as rendered into its files — register these, not
  the name. Without a `title` in `--context` (absent, blank, or just the name again) it is derived from the name
  (`kit-ref` -> `Kit Ref`); without a `description`, `<Title> — scaffolded with the nuxt-base kit`. No generated
  document has an empty bullet or heading, whatever was passed.
- `--no-sample` leaves the example resource out: no `src/resources/items/`, no `0002_items` migration, no seed rows,
  no `items` tests, no `editor` role (the app starts with `admin` only), and a contract / typed client without it.
  `sample` in the result says which it is (`true` with the `api` module unless the flag was given; `false`
  otherwise). It is recorded as `answers.sample: false` — only then, so existing manifests are unchanged — and
  `add resource` follows it (writes are admin-only, matrix rows without the editor column). The first resource of
  such a project is `scaffold add resource <name>`.
- `--lang th|en` (default `th`): the ONE language of the project's UI. It decides the strings of the generated
  pages (also of every later `add page` / `add resource`) and, through `nuxtBase.lang` in the UI's `app.config.ts`,
  the layer's own words (loading, empty, error, retry, confirm / cancel, the error page, `<html lang>`). `lang` in
  the result is `"th"`, `"en"`, or `null` for a project without a UI; it is recorded as `answers.lang` only when it is
  not the default. An unknown value is exit 2.
- `services[].internal: true` (only present when true): the API of a `fullstack` project deployed with the
  `container` preset. The compose file publishes no host port for it — the UI reaches it over the compose network —
  so `port` is its development port only: do not register a health probe or a route against it on the deploy host.
- Ports: one-part kinds use `--port` (default 3000). `fullstack`: `--port N` alone = API on N, UI on N+1 (port
  pairing); with `--api-port`, `--port` is the UI port.
- `env[].generated: true` (only present when true; module.json: `"generated": true` on a secret env key): a secret
  nobody chooses — a deploy tool generates a random value on the host. With the `container` preset
  `docker/env.example` names those keys in ONE comment line, `# kit:generated KEY [KEY ...]`, and leaves `KEY=`
  empty; the line is absent when the project has none. Today: `AUTH_PROXY_SECRET` (module `auth`). The deploy
  details a tool needs stay where they are: `answers.deploy.{host,user,domain}` and `answers.port` in
  `.scaffold.json`, and `docker/env.example`.
- `backup` is what a backup job has to cover (empty without the `db` module): `path` = the SQLite file relative to
  the project, `database` = the MySQL schema, `envKey` = where the real location is configured. The generator
  registers nothing — the wrapper does.
- `--context ctx.json` — every key optional, obvious placeholders otherwise:
  `{ "title", "description", "layerRef", "deploy": { "registry", "host", "domain", "user" }, "otlpEndpoint", "authentikUrl", "mysqlHost" }`.
  An empty value counts as not given. Every value is validated before anything is written (`new`: exit 2 otherwise): `title` / `description` are single lines
  without control characters; `deploy.*` and `mysqlHost` are letters, digits and `. _ : -` (`registry` also `/`);
  `layerRef` has no spaces or quotes; the two URLs are plain http(s) without credentials. The values are rendered
  into source, YAML and a bash-sourced `deploy.conf`, so nothing that could become code is accepted.
  Answers already stored in a project's `.scaffold.json` never fail `check` / `update` / `add`: a stored value that
  is not acceptable is listed in `warnings[]` and the default is used in its place.
  `layerRef` defaults to `github:like12like12s/nuxt-base#v<kitVersion>`; `deploy.registry` is the registry the deploy
  host pulls from; `mysqlHost` is the host in the example `DATABASE_URL` of a `--db mysql` project (never a
  credential); `otlpEndpoint` is the example `OTEL_EXPORTER_OTLP_ENDPOINT` of the `trace` module (empty = tracing
  off); `authentikUrl` is named in the operator instructions of the `auth` module. Keys a module does not use are
  ignored.
- `.scaffold.json` (in every generated project):
  `{ "kit", "kind", "modules", "db", "deploy", "layerRef", "answers": { name, title, description, port, apiPort, deploy, sample?, lang?, mysqlHost?, otlpEndpoint?, authentikUrl? }, "locked": { "<path>": "sha256:<hex>" } }`.
  `answers` is everything needed to re-compose the project, which is how `check` / `update` / `add` work.
  A locked hash carries its algorithm prefix on purpose: a bare 64-character hex value beside a key such as
  `…/tokens.ts` is what secret scanners report as a generic API key, and a fresh project must pass a default
  `gitleaks protect` / `gitleaks detect` on its first commit (unit test + a step of the kit gate). Manifests written
  with bare hex (kit <= 0.2.0) are read as before; `update` rewrites them.

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

**Which kit was that?** Every `check` / `update` names the kit it compared against: `kit.current` (the version) and
`kit.commit` (the HEAD of the kit's repository; `null` when the kit directory is not a git checkout — an exported
release). The text form starts with it: `clean (kit 0.2.0 @ 3baed5a)`.

**A kit with unreleased changes is its own state.** When the kit directory is a checkout whose `kit/` differs from
the release tag of its version (`v<version>`: commits after the tag, an edited working tree, untracked files — or no
such tag at all), `kit.unreleased` is `true` and `kit.note` says why. For a project generated from that same version,
differences that come from the kit side (`outdated`, `new-in-kit`, `removed-from-kit`) are then **not drift**: they
are listed in `unreleased[]`, `state` is `kit-unreleased`, `clean` stays `true` and the exit code stays `0`. Only
what the project itself did (`modified`, `missing`, an older layer tag) is drift. A project that is behind a
*released* version is drift as always, whatever else is in the kit's tree. `update` applies both lists — it brings
the project to the kit it was given — and reports `kit.unreleased` so that is never a surprise.

**Consumers read the kit from a release tag.** Point `AI_KIT_DIR` at a checkout (or an export) of the tag
`v<version>`, not at a working tree that is being developed: then `kit.unreleased` is `false`, `check` compares
projects with a release, and a kit change reaches projects only through a version bump (see "Releasing"). The
`ai scaffold` wrapper does this; the working tree is for `npm run gate:kit` and for developing the kit.

**Upgrade notes.** `update` cannot change app-owned files. `kit/UPGRADING.md` lists, per version step
(`## <from> -> <to>`), what a project owner changes by hand; `update` returns the steps a project crosses as
`notes[]` (oldest first) and prints them. A project at version P updated by kit K gets the section `<from> -> …`
when `P <= from` and the kit is past `from` (`K > from`, or `K == from` with unreleased changes — the `-> next` step).

`layer.current` is the tag the UI's `nuxt.config.ts` really extends (the oldest one when it names several);
`.scaffold.json` is only consulted when the config names no tag of the layer. A tag edited by hand to an older one is
therefore drift even though the manifest still records the new one.

`update` writes the current locked files, replaces the old layer ref with the new one in the UI's `nuxt.config.ts`, and
rewrites `.scaffold.json`. It never touches an app-owned file and never deletes: a file the kit dropped is reported as
`orphaned` and left in place; a layer ref it cannot find in `nuxt.config.ts` is a warning, and `check` keeps failing.
It does not change `package.json` — dependency bumps stay a deliberate, reviewed change.

`update --show <path>` is the read-only companion of the upgrade notes: it prints a file — app-owned or locked — as
this kit generates it for this project (its kind, modules and stored answers), so the current form of a file that
`update` never rewrites can be diffed against the project's own (`scaffold update --show api/src/app.ts | diff -
api/src/app.ts`) or written where it does not exist yet. Files that `add` generated are not part of it.

`update` never downgrades: when the project's manifest names a kit version newer than the running kit (semver
compare of `kit` in `.scaffold.json` with the kit's version) it stops with exit 4 / code `kit_older` before reading
or writing anything else — an older kit would re-copy its older locked files over newer ones. Use the newer kit.

## Layout

```
bin/scaffold.mjs        the CLI (argument parsing, output, exit codes)
lib/                    kit.mjs (load the tree) · compose.mjs (selection -> files) · commands.mjs · render / pkg / fsutil / errors
                        · source.mjs (which commit the kit is, released or not) · upgrading.mjs (UPGRADING.md -> notes)
UPGRADING.md            what a project owner changes by hand per version step — printed by `update`
kinds/<name>/           kind.json + files/           nuxt-app · api · fullstack
modules/<name>/         module.json (+ files/, variants/, generators/)   base (always) · ci-github · api · db · testkit ·
                        auth · trace · security · og · jobs · notify
playbooks/              add-resource.md · add-page.md · add-job.md — copied into projects (.memory/docs/guides/playbook-*.md)
presets/deploy/<name>/  preset.json + files/         cf-pages · container · pm2
runtime/                files copied byte for byte into apps and locked: runtime/<area>/* -> src/kit/<area>/*
                        (api · db · auth · trace · security · jobs · notify · testing; testing/e2e.ts -> the UI's
                        tests/kit/, og/og.ts -> the UI's server/kit/, ui/api-error.ts -> the UI's app/utils/),
                        project/gate-ci.mjs -> scripts/
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
  "requires": ["db"],                      // modules: pulled in automatically, transitively. An entry may be
                                           // { "name": "db", "kinds": ["api", "fullstack"] } = only for those kinds
  "parts": [{ "type": "api", "dir": "api", "kind": "api" }],   // kinds only; "kind" borrows that kind's part contribution
  "contributes": {
    "api": {
      "package": { "dependencies": {}, "devDependencies": {}, "scripts": {} },   // merged into the part's package.json
      "env": [{ "key": "API_TOKEN", "required": true, "secret": true, "example": "", "description": "…" }],   // + "generated": true, "when": {…}
      "files": [{ "from": "files", "to": "", "when": { "kind": ["api"] } }],      // file or directory, relative to the unit; rendered
      "locked": [{ "from": "runtime/api/env.ts", "to": "src/kit/api/env.ts" }],   // relative to the kit root; copied verbatim + hashed
      "backup": [{ "engine": "sqlite", "path": "data/{{kit.name}}.db", "envKey": "DATABASE_URL", "when": { "db": ["sqlite"] } }],  // -> `backup` of `new --json`
      "symlinks": [{ "path": "api", "target": "." }],
      "nuxtConfig": ["nitro: { preset: 'cloudflare-pages' },"],                   // lines added to the UI's defineNuxtConfig
      "gitignore": ["dist/"],
      "usage": "usage.md",                                                         // section appended to .memory/docs/guides/usage.md
      "next": ["one line shown to the user after `new`",                           // or { "text", "when" } for some selections only
               { "when": { "with": ["auth"] }, "text": "…" }]
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
  `name title description titleJson descriptionJson kind lang kitVersion layerRef modules db deploy port uiPort apiPort
  e2ePort apiDir uiDir dir registry deployHost deployDomain deployUser mysqlHost dbName databaseUrlExample rateLimitDefault
  services nuxtConfig generatedEnvLine
  usageSections`. Use the `*Json` forms inside source code — they are quoted and escaped.
- No clock, no randomness, no environment lookups in a template or in `lib/compose.mjs`.
- Conditional blocks: a line that is only a comment `@kit:if <terms>` / `@kit:else` / `@kit:end` (`//`, `#` or
  `<!-- -->` style) keeps or drops the lines in between; the directive lines never reach the project. Terms (all must
  hold): a module name, `kind:<kind>`, `db:<db>`, `deploy:<preset>`, `sample`, `lang:<th|en>`, each optionally negated with `!`. Blocks nest.
  This is how ONE app-owned file (`src/app.ts`, `src/config.ts`, a test helper) serves every module combination —
  prefer it to a `when` variant whenever the file is text with comments. JSON files cannot hold a directive: they use
  `when` variants (`modules/api/variants/openapi.json` without auth, `modules/auth/variants/openapi.json` with it).
- Two units writing the same path is an error, not a merge. Variants use `when` on a `files` / `locked` / `symlinks` /
  `backup` entry — every key given must hold: `kind: [..]` (the project's kind is one of), `with: [..]` (all of these
  modules are selected), `without: [..]` (none of them is), `db: [..]` (the `--db` value is one of), `sample:
  true|false` (the example resource is / is not part of the project — its files live in `files-sample/`). That is how a
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
default-exports `({ name, type, dir, part, parts, manifest, project, options }) => ({ files, patches?, next? })`, sync or
async (`options` = the flags of `add` that belong to generators; today `{ og: boolean }`):

```
files    [{ path, content, part? }]          new files; refused when one exists (exit 3)
patches  [{ path, anchor, insert, part?, optional? }]
                                             lines inserted into an existing app-owned file, above the line that holds
                                             the comment `kit:anchor <anchor>`, with that line's indent. A missing
                                             anchor is exit 2 (`anchor_missing`) and the message says what to add by
                                             hand — unless the patch is `optional` (a convenience older projects may
                                             lack the anchor for): then it is left out and named in `next[]`
next     ["…"]                               what the developer does next, in order
```

Paths are relative to the part named in the descriptor (`"part": "ui" | "api"`, default the project root); an entry
may name another part (`part: 'ui' | 'api' | 'project'`), and is skipped when the project has no such part. Everything
is computed before anything is written — all files and patches, or none; nothing outside the project. When several
units provide the same type the later one wins (modules override the kind). A generator is pure like the rest of the
kit: it runs no command, so derived files (`openapi.json`, the typed client) are regenerated by the commands in `next`.
`lib/names.mjs` gives every spelling of a name (`order-lines` -> `OrderLine`, `order_lines`, …); `lib/i18n.mjs` holds
the words generated pages say, per language — a generator takes them with `text(langOf(manifest))`, never a literal. A name whose
identifier would be a reserved word or shadow a built-in type (`delete`, `classes`, `errors`) is refused (exit 2,
code `reserved_name`), and so is a route path that uses one parameter name twice (`orders/[id]/lines/[id]` — exit 2,
`duplicate_param`; a resource name is one word and has no parameter of its own). `update` / `add` never write through a symlink that leaves the project (`path_escape`).

```
page       kind nuxt-app (also in fullstack)   app/pages/<path>.vue on the AsyncState pattern + its e2e spec. <path> is
                                                one word, nested (reports/monthly) or dynamic (reports/[id] — the page
                                                reads route.params). Below an existing flat page it is refused (exit 2,
                                                `flat_parent`, with the `git mv` that fixes it); named like an existing
                                                directory it becomes that directory's index.vue
resource   module api                           schemas, repository (name unique among live rows by a database index ->
                                                409; writes never touch a deleted row), routes (with auth declarations
                                                when the auth module is installed), migration, tests; registered at the anchors in src/app.ts,
                                                src/db/migrations/index.ts, src/db/schema.ts, tests/helpers.ts and the
                                                matrix of tests/auth.spec.ts; fullstack: app/pages/<name>/index.vue (list
                                                + create form) and <name>/[id].vue (detail, edit form, soft delete) —
                                                forms in the layer's Modal, delete behind ConfirmModal, a 400 shown per
                                                field — with an e2e spec that walks all of it. `--og` (og module):
                                                also lists the detail page in RECORDS of server/og.ts — opt-in,
                                                because a preview shows record names to any crawler user agent
job        module jobs                          src/jobs/<name>.ts, its test, the registration in src/jobs/index.ts and
                                                .memory/docs/guides/job-<name>.md (the scheduler entry for the operator)
```

Each has a playbook in `playbooks/` — the one command, what it generates, what to fill in, which tests must pass —
written for an agent working inside the project, where it lands as `.memory/docs/guides/playbook-add-<type>.md`.

## Kinds

```
nuxt-app    Nuxt 4 SPA extending the layer by git tag · DESIGN.md · vitest (nuxt env) · playwright e2e against the
            built app that fails on any pageerror / console error, served on the project's own e2e port (UI port
            + 10000; `E2E_PORT` overrides) so two projects can run e2e at once · gate = typecheck + unit · security headers on
            every page (nosniff, no framing, referrer policy) through `routeRules`
api         hono on Node (tsx dev, tsc build -> dist/) · src/config.ts = zod env schema: a missing key stops the boot
            and is named, no value is ever printed · /health/live · one JSON log line per request · graceful shutdown
            · src/app.ts creates the app · src/kit/** = locked runtime · `--with api,db` replaces the plain app
            with the API standard below
fullstack   api/ + ui/ in one repo, each with its own package.json and lockfile; the UI server proxies /api/** to
            the API (API_URL); the root package.json wires install / gate / build to both
```

Every kind gets `.gitignore` (first), `README.md`, `.memory/docs/{brief,context,guides,changelog}` (the brief lives
in ONE place, `.memory/docs/brief/brief.md` — the README links to it; there is no root `brief.md`),
`.env.example` per part, `.scaffold.json`, and `npm run gate` / `gate:ci` at the root. The README and `next[]` say
that the repository must stay private: the answers, `docker/` and the env examples record deployment details. `gate` is typecheck → lint
(`oxlint --deny-warnings`, build output ignored through `.oxlintrc.json`) → unit tests. `gate:ci` (locked
`scripts/gate-ci.mjs`) = gate + `gitleaks` (absent binary: a visible `NOTICE … SKIPPED` locally, a failure when `CI`
is set) + `npm audit --audit-level=high` in every directory that has a lockfile. The secret scan covers the whole
git history (`gitleaks detect`) and — on a developer machine, not in CI — what is not committed yet (`gitleaks
protect`); a pre-commit hook (`gitleaks protect --staged`) sees only what is about to be committed, so a green
local gate:ci implies a green hook, never the other way round. All modes share the rules and `.gitleaksignore`; a
false positive in an old commit stays ignored there by its fingerprint (see UPGRADING.md, 0.2.0 -> 0.3.0). `--with ci-github` adds a workflow
running it: `npm ci`, actions pinned by commit SHA, gitleaks installed from a pinned release with its checksum.

## Modules: api · db · testkit

`api` and `db` always come together (each requires the other) and bring `testkit`: the standard's audit trail, soft
delete and readiness checks are database-backed, so there is one app shape to maintain and to gate. `--db sqlite|mysql`
only picks the defaults (`.env.example`, the `backup` entry); `DATABASE_URL` selects the engine at run time and the
code, migrations and tests are identical for both.

```
api       hono + @hono/zod-openapi (contract-first routes) · /api/v1 via mountV1() · one error shape for every status
          >= 400: { error: { code, message, details?, traceId } } with the fixed code set VALIDATION UNAUTHORIZED
          FORBIDDEN NOT_FOUND CONFLICT RATE_LIMITED INTERNAL COMMIT_OUTCOME_UNKNOWN (a 500 shows no cause; the log
          has it, driver messages masked; 503 COMMIT_OUTCOME_UNKNOWN = the connection failed during COMMIT, the write
          may have been applied — a client reads the state back before it retries) · trace id generated, or from the `traceparent` of a TRUSTED caller (through the proxy, or
          TRUST_TRACEPARENT=1), echoed in x-trace-id, on every log line (ts level msg service env traceId method
          path status ms) and in the audit row · lists: limit (50, max 200) / offset / sort / ids, envelopes { data } and
          { data, meta } · GET /health/live, /health/ready (pluggable checks, 503 + the check list), /version,
          /openapi.json · `npm run contract` writes openapi.json and tests/contract.spec.ts fails when it differs from
          the code · src/resources/items/ = the example resource (list / get / create / update / soft delete, audited;
          left out with `--no-sample`)
          · fullstack: the UI gets app/api/schema.d.ts (openapi-typescript), useApi() (openapi-fetch), a
          compile-time check of the typed client, and the locked `app/utils/api-error.ts`: `apiProblem(error)` turns
          the API's error body into one line with the trace id and — for a 400 — a message per field from `details`
db        Kysely · SQLite through node:sqlite (built in — no native module) or MySQL through mysql2 · one migration
          set written with the schema builder, every migration reversible · base tables users / audit /
          service_tokens · standard columns id / createdAt / updatedAt / deletedAt, soft delete, "unique among live
          rows" by a generated column + unique index (liveValue(); addLiveUnique() / dropLiveUnique() add it to a
          table that already exists, portable across both engines), audited() = the write
          and its audit row in one transaction · connect + statement deadlines, bounded retry on transient errors only
          (deadlock, lock wait, connection refused; a lost connection replays reads, never writes), withTransaction()
          replays a whole unit, the pool closes on shutdown · db:migrate up|down|status, db:seed (deterministic),
          db:check (database == code; also what /health/ready asks) · backup before migrate: SQLite verified snapshot (VACUUM INTO + integrity_check), MySQL
          DB_BACKUP_CMD hook or refusal · container preset: a `db-check` compose service gates the API container
testkit   deterministic factories (seeded random, fixed clock, sequential ids) · one throwaway database per test file
          (SQLite temp file, or a MySQL `test_*` schema when TEST_MYSQL_URL is set) · in-process app client ·
          playwright helpers (captureErrors, stubApi) in the UI
```

## Modules: auth · trace · security · og · jobs · notify

```
auth      identity from three sources, in this order: the fixed dev user (AUTH_DEV_MODE=1 — createAuth() throws with
          NODE_ENV=production, so the process does not start) · `Authorization: Bearer kit_…` service tokens (256
          random bits, shown once, sha256 in `service_tokens`, roles, expiry, revoke, lastUsedAt, compared in constant
          time; `npm run auth:token -- create|revoke|list`; without `--roles` = authenticated, read-only) · identity
          headers of the forward-auth proxy — which ones is configuration: AUTH_HEADER_PRESET `authentik` (default,
          X-Authentik-*) or `remote` (Remote-User / Remote-Groups / Remote-Email / Remote-Name), single names through
          AUTH_HEADER_USERNAME / _UID / _EMAIL / _NAME / _GROUPS — believed ONLY when the request provably came
          through the proxy: the shared secret header `x-auth-proxy-secret` (AUTH_PROXY_SECRET) and/or the TCP peer
          in AUTH_TRUSTED_PROXIES — neither configured = the headers are never believed.
          fullstack: the proxy talks to the UI, so the UI's /api proxy carries the auth bridge (locked
          server/kit/auth-bridge.ts): identity and secret headers a client sent are ALWAYS removed, and only when the
          request's TCP peer is the configured forward-auth proxy (AUTH_BRIDGE_TRUSTED_PROXIES) are the proxy's
          identity headers passed on and the secret added — the same rule one hop earlier; with either setting
          missing nothing is passed on. One identity per request, on both hops: an identity header that is repeated
          or a user name / uid / email with a comma is refused (401), never joined into one subject. A service
          token's role that the app no longer declares is ignored.
          Trusted users are upserted into `users` (written and audited on change only); roles are the app's own
          (src/auth/roles.ts), mapped from identity-provider groups by AUTH_ROLE_MAP.
          Every route declares who may call it — `publicRoute()` / `requireAuth()` / `requireRole(…)` as route
          middleware — the first one of the route. A route without a declaration is refused at run time on every
          path except the system routes (500, logged) and listed by
          `undeclaredRoutes(app)`, which the generated tests/auth.spec.ts requires to be empty next to its
          role x endpoint matrix (which must name every route). GET /api/v1/me returns the caller; in a UI the
          layer's useAuth() reads it. kinds api / fullstack (brings api + db) and nuxt-app (UI wiring only).
          Nothing here creates identity-provider or proxy configuration: usage.md tells the operator what to set up,
          in terms of "the forward-auth proxy" and the header preset (a hand-written proxy config is one example).
trace     OpenTelemetry (sdk-trace 3.x) -> OTLP/HTTP. Off until OTEL_EXPORTER_OTLP_ENDPOINT is set. One SERVER span
          per request from a hono middleware (`createApi({ before: [traceMiddleware()] })`) — nothing is patched, so
          it is ESM-safe without a loader flag; src/tracing.ts is the first import of src/index.ts. The span's trace
          id is the request's: x-trace-id, every log line, the audit row. Tests: an in-process fake collector
          (src/kit/testing/otlp-collector.ts).
security  `createApi({ middleware: security({…}) })`: secure headers (nosniff, DENY, no-referrer, HSTS, CSP none),
          CORS allowlist of exact origins with credentials (a wildcard stops the boot), body limit (413), a fixed
          window rate limit per client (429 + retry-after, /health/* exempt): the TCP peer, or the client address a
          TRUSTED proxy reports (same rule as auth); fullstack defaults to off, its API only ever sees the UI server. Refusals use the error shape.
og        per-URL title / description / og:* / twitter:* / canonical for crawlers: the SPA shell's <head> is rewritten
          in the server's HTML renderer (Nitro `render:html`), the same code on Node and on Cloudflare Pages. The
          app owns server/og.ts (URL -> meta, may be async, abandoned after 3 s, an error never breaks the page).
          og:url / canonical / site-relative images come from NUXT_PUBLIC_SITE_URL only — the request's Host and
          X-Forwarded-Host are never believed (without the setting those tags are left out), and the path cannot
          select another host. Unlisted URLs get the site preview, never a title derived from the path.
          fullstack: `RECORDS` in server/og.ts maps a detail page (`/orders/<id>`, added by `add resource --og` —
          opt-in; without the flag `next[]` names the line to add; entries already there stay) to its
          API collection; the lookup is made by the UI server through server/utils/server-api.ts with the
          role-less service token in API_SERVICE_TOKEN — a crawler has no session and the API refuses anonymous
          callers. With `auth`, `new` says in `next[]` that crawlers cannot pass single sign-on.
jobs      src/jobs/<name>.ts + `npm run job -- <name>` / `node dist/jobs/run.js <name>`: a lock per job (no
          overlap, atomic across processes and hosts sharing JOB_LOCK_DIR; a dead owner or a passed deadline frees it), exit 0 ok · 1 failed · 2 unknown · 3 already running ·
          4 timed out, one JSON line at start and end, audit actor `job:<name>` and no audit row without a change.
          Nothing is scheduled: `add job` writes the scheduler entry for the operator.
notify    client of a notification hub (`POST <NOTIFIER_URL>/notify`, bearer token): off without a URL, never throws,
          5 s timeout. Tests mock fetch.
```

`createApi()` has two middleware slots for them: `before` (wraps the request scope — tracing) and `middleware` (inside
it, in front of every route including the system ones — security). The auth middleware is mounted on `*`: an undeclared route is refused on every path, not only under `/api/v1`.

## Deploy presets

```
cf-pages    nuxt-app only · nitro preset cloudflare-pages (output dist/) · wrangler devDependency · scripts cf:create / deploy
container   multi-stage Dockerfile + .dockerignore per part (locked) · docker/docker-compose.yml, docker/deploy.conf and
            docker/env.example filled from --context (deploy.registry / host / domain / user). With the db module the
            compose file has a one-shot `db-check` service the API depends on (`node dist/db/cli.js predeploy`: migrate
            when DB_MIGRATE_ON_DEPLOY=1, then database == image or the API does not start). A one-part project gets a
            symlinked service dir (`web -> .` / `api -> .`). `GET /version` of a deployed API reports commit and
            build time with an unchanged deploy script: compose passes the deployed tag as `APP_IMAGE_TAG` (its
            trailing commit is used) and the API image stamps its build time; the build args `APP_COMMIT` /
            `APP_BUILT_AT` override both when a script passes them. No `container_name`: compose names containers
            `<project>-<service>-1`, so two stages of one app run on one host (second stage: another directory with
            `COMPOSE_PROJECT_NAME` and other ports in its `.env`). `fullstack`: only the UI has a host port; the
            API is reachable inside the compose network alone (a commented loopback-only `ports:` block is there
            for the rare outside caller), and its health is the image HEALTHCHECK the UI service waits for. The deploy script itself is NOT in the kit: it carries
            site-specific defaults, so the wrapper (or the developer) copies it from the private docker-node template.
pm2         ecosystem.config.cjs (time: true, ports in env only). Nothing is started: the generated usage.md documents
            starting it through the Pilot API.
```

### Dependency ranges and scanner findings

The ranges in `kinds/*/kind.json` and `modules/*/module.json` are what every new project starts with — refresh them
with `npm view <pkg> version`, never from memory. A fresh project must have no `npm audit` finding of severity
moderate or higher (a step of the kit gate, per directory with a lockfile; `--no-audit` skips it when the registry's
advisory service is unreachable). Where the fix is only in a transitive dependency whose parent has not released it,
the UI's `package.json` carries a narrow `overrides` entry (today: `minimatch` under `editorconfig` / `readdir-glob`,
`glob` under `js-beautify`) — drop an entry as soon as the parent's own range reaches the fixed version.
Static-analysis findings in locked files are fixed in the kit, or suppressed on the line with the reason next to it
(`// nosemgrep: <rule id>`): an app cannot edit a locked file, so a finding there is the kit's to answer.

A preset on a kind it does not support (`cf-pages` on `api` / `fullstack`) is exit 4.

## Testing the kit

```bash
npm run gate        # fast: lint of kit/{runtime,lib,bin} + the kit's unit tests in the repo's vitest suite — no installs
npm run gate:ci     # gate + gitleaks + npm audit — what .github/workflows/gate.yml runs (the ci-github template, dogfooded)
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

The kit gate additionally proves, per combo: the first commit of the fresh project passes `gitleaks protect --staged`
and `gitleaks detect` with the default config, and the machine's own pre-commit hook when it has one (`NOTICE …
SKIPPED` without the binary); locked files survive install and build; the API refuses to boot without
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
`DB_MIGRATE_ON_DEPLOY=1` = migrated and ready, and a second stage of the same compose file running next to it);
`fullstack+std+container` runs the fullstack compose file the same way and shows that the API container publishes no
host port (even with `API_PORT` set), is healthy, answers `/health/ready` through `compose exec`, and serves API
calls through the UI; the API image answers `/version` with a commit and a build time, with and without build args.
MySQL: the gate uses `TEST_MYSQL_URL` when set, else starts a
throwaway `mysql:8.4` container, else prints `NOTICE … SKIPPED`; the `--db mysql` combo runs its whole suite and its
CLI there (in a `test_gate_*` schema that is dropped again), and the job `kit-runtime@mysql` runs the kit's
data-layer unit tests there.

Task E combos: `fullstack+full` and `api+full+container` scaffold every module, then prove on the built app with
NODE_ENV=production: dev mode and a wildcard CORS origin stop the boot; anonymous = 401; forward-auth headers without
the proxy secret = 401; fullstack, built UI in front of the built API: identity headers reach the API only when the
client's address is the configured proxy of the auth bridge — from any other peer they are stripped even together
with the REAL secret, with one of the two bridge settings missing, and with nothing configured (always 401), a
bearer token passes untouched, and with the `remote` header preset on both sides Remote-User is the identity while
X-Authentik-* is not; a user through the proxy gets the mapped roles; a role matrix over HTTP; a service token
created with the built CLI works and is 401 after `revoke`; secure headers, the CORS allowlist and the body limit;
a span reaches a collector with the trace id of the response and of the log line. Then they run the three playbook
generators (`add resource`, `add job`, `add page`), show that the contract test is red until `npm run contract`,
and require `npm run gate` + `npm run build` green, the generated resource and job working on the built app, and the
UI e2e suite (generated pages, link previews with crawler user agents) green. `nuxt-app+og+auth+cf-pages` runs the
e2e suite against wrangler's Pages runtime. `kit-runtime@mysql` also runs the auth runtime tests on MySQL.
`fullstack+auth+no-sample` and `api+no-sample` scaffold with `--no-sample`: no file, table, route or contract entry
of the example exists, `/api/v1/items` is a 404 on the built app, and after `add resource` (the project's first)
gate, build, the built app and the e2e suite are green.

## Releasing the kit (= the layer)

One git tag versions the layer and the kit. A release changes what `scaffold check` reports in every project (locked
files become `outdated`, the layer tag `behind`), so it is a deliberate step:

1. Green on the commit to release: `npm run gate` and `npm run gate:kit`.
2. In `kit/UPGRADING.md`, rename the `## <last> -> next` heading to `## <last> -> X.Y.Z` (the notes written since the
   last release now belong to this one) — new notes after the release start a fresh `## X.Y.Z -> next` section.
3. Bump the version in **both** places, to the same value: `package.json` (`version`) and the locked
   `kit/runtime/api/kit-version.ts` (`KIT_VERSION` — what `GET /version` of every app reports). A unit test
   (`runtime-api.spec.ts`, "kit version") fails while they differ. Run `npm install` so `package-lock.json` follows.
4. Commit (`release vX.Y.Z`), tag `vX.Y.Z` on that commit, push the branch and the tag. The tag must exist on GitHub
   before any project is generated with it: a generated UI extends `github:like12like12s/nuxt-base#vX.Y.Z`.
5. `npm run gate:kit` once more after the tag is pushed: the `layer: 'tag'` combos (container images) build against
   the newest tag, so this is the run that proves the released layer and the released kit together.
6. Consumers (they read the kit from the new tag): `scaffold check` now reports drift in generated projects;
   `scaffold update` brings each one up and prints the by-hand notes of the step; then their gate. Layer-only
   consumers bump the tag in their `extends`.

Between releases the locked runtime may change freely on the branch: nothing reads it but the kit's own gates, and a
checkout that is not at a tag says so (`kit.unreleased`). Do not bump the version for work in progress.

Never move or re-use a tag. A wrong release is fixed by the next patch version.
