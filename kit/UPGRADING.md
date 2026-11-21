# Upgrading a project to a newer kit

`scaffold update` re-copies the locked files and bumps the layer tag. It never rewrites a file the app owns — what
has to change there is listed here, one section per version step, and `scaffold update` prints the sections a project
crosses (`notes[]` with `--json`). Do them, then run the project's `npm run gate`.

Format (parsed by `kit/lib/upgrading.mjs`): `## <from> -> <to>`, `<to>` = the next released version, or `next` while
it is not released. One top-level bullet per change; start it with the file. Newest step first.

The current form of any app-owned file — as this kit generates it for YOUR project (its kind, modules and answers) —
is one command away, so no note needs a second, freshly scaffolded project to copy from:

```bash
scaffold update --show api/src/app.ts                       # print it
scaffold update --show api/src/app.ts | diff - api/src/app.ts   # what differs from yours
scaffold update --show ui/tests/unit/auth-bridge.spec.ts > ui/tests/unit/auth-bridge.spec.ts   # a file you do not have yet
```

## 0.4.0 -> next

- Test tiers (GATE.md, t1444) — `package.json` scripts are app-owned, so add them by hand:
  - kind `nuxt-app` (and the `ui/` part of fullstack): `"test:smoke": "npm run build && playwright test --grep @smoke"`
    and `"gate:full": "npm run gate && npm run test:e2e"`; tag your main-flow e2e tests `@smoke` (the generated
    skeleton in `tests/e2e/app.spec.ts` already carries the tags — take it over with
    `scaffold update --show ui/tests/e2e/app.spec.ts > ui/tests/e2e/app.spec.ts` if you never edited it).
  - kind `api`: `"gate:full": "npm run gate && npm run build"`.
  - fullstack root: `"test:smoke": "npm run test:smoke --prefix ui"` and
    `"gate:full": "npm run gate:full --prefix api && npm run gate:full --prefix ui"`.
  - `gate` itself is unchanged (typecheck + lint + unit — no build, no e2e, as before).
- `ui/tests/tiers.json` (new, app-owned — a file you do not have yet): take it from
  `scaffold update --show ui/tests/tiers.json > ui/tests/tiers.json` (single-part kinds: without the `ui/` prefix),
  then extend `map` with your own pages/components as you add e2e specs.
- `ui/scripts/lib/heavy-run-global-setup.mjs` (locked, copied by `scaffold update`) and
  `ui/playwright.config.ts` (app-owned): wire the queue helper into the config — globalSetup + globalTeardown +
  `reporters: [...heavyRunReporters(), ['list']]` + `workers: Number(process.env.HEAVY_RUN_WORKERS) || undefined`
  (see `scaffold update --show ui/playwright.config.ts`). Every full playwright run then holds a slot in the
  host-wide heavy-run queue; exit 75 = queue full = not run.
- `api/tests/app.spec.ts` (kind `api` and fullstack): the query-string marker in the request-log test is now
  `zz-secret-zz` instead of `abc`. The assertion `expect(...).not.toContain(...)` runs on a log line that also
  carries the random hex trace id — an `abc` marker matched a trace id containing `abc` (~0.7% of ids) and made the
  test flaky. Take the file over with
  `scaffold update --show api/tests/app.spec.ts > api/tests/app.spec.ts` unless you changed it (a manual edit of the
  marker in the `token=` request and the `not.toContain` line is enough if you did).

## 0.3.0 -> 0.4.0

- `api/openapi.json` and `ui/app/api/schema.d.ts` (after every `scaffold update`, this one included): run
  `npm run contract` in the API directory, then `npm run client` in `ui/` (fullstack), and commit both files. This
  step: the `Error` schema gained the code `COMMIT_OUTCOME_UNKNOWN` — `tests/contract.spec.ts` is red until the
  contract is regenerated. A client that retries failed writes by itself must not retry on a 503 with this code: the
  write may have been applied (read the record back first).
- `ui/server/routes/api/[...path].ts` of a fullstack project with auth: pass the raw header list to the bridge —
  `bridge(event.node.req.headers, event.node.req.socket.remoteAddress, event.node.req.rawHeaders)` — so that an
  identity header the proxy sent twice is seen as such. Without the third argument a user name / uid / email with a
  comma is still refused; a repeated groups or display-name header is only caught with it.
- Identity provider (auth): a user name, uid or email that contains a comma is now refused (401, logged as
  `ambiguous-identity`) — it is what a repeated header looks like. If your provider's user names can contain commas,
  point `AUTH_HEADER_USERNAME` / `AUTH_HEADER_UID` at an attribute that cannot.
- `ui/tests/unit/auth-bridge.spec.ts` of a fullstack project with auth: one new case ("one identity per request") —
  take the file over with `scaffold update --show ui/tests/unit/auth-bridge.spec.ts > ui/tests/unit/auth-bridge.spec.ts`
  unless you changed it.
- `ui/server/og.ts` (`RECORDS`): nothing to do — entries that are there stay. Only new `add resource` runs changed:
  they list their detail page for link previews with `--og` alone.
- `.gitleaksignore` / uncommitted work: `npm run gate:ci` on a developer machine now also scans what is not committed
  yet (`gitleaks protect`), with the same rules and ignore file as the history scan — a finding there is fixed in the
  working tree before the commit, not ignored.

## 0.2.0 -> 0.3.0

- `api/src/app.ts` (auth): mount the auth middleware on every path — `api.use('*', auth.middleware)` instead of
  `/api/v1/*` — and keep each route's `publicRoute()` / `requireAuth()` / `requireRole()` as its FIRST middleware; a
  route outside `/api/v1` without a declaration is now refused (500).
- UI environment (og): set `NUXT_PUBLIC_SITE_URL` to the public origin on every deployed instance — `og:url`,
  canonical and site-relative images are only built from it; the request's host is no longer believed.
- `api/src/resources/*` written by hand or generated by kit 0.2.0: uniqueness among live rows must be a database
  index, not check-then-insert — port the `liveName` generated column + unique index + 409 mapping of the current
  `items` example (`liveValue` in `src/kit/db/schema.ts`) in a NEW migration.
- `docker/docker-compose.yml`: remove every `container_name:` line (compose names containers
  `<project>-<service>-1`; a second stage on the same host is `COMPOSE_PROJECT_NAME` in its `.env`). Scripts that
  addressed a container by name use `docker compose exec <service>` instead. A fullstack project MUST change the
  UI service's API address in the same edit: `API_URL: http://<name>-api:3000` (the old container name, which no
  longer resolves) becomes `API_URL: http://api:3000` — the compose SERVICE name. Check with
  `docker compose exec ui wget -qO- http://api:3000/health/live` after the deploy.
- Job locks are now `<JOB_LOCK_DIR>/<name>.lock.<n>`: delete leftover `<name>.lock` files once after the update.
- `api/src/app.ts` + `api/src/config.ts` (`/version` in an image): pass
  `build: buildInfo({ commit: config.APP_COMMIT, builtAt: config.APP_BUILT_AT, imageTag: config.APP_IMAGE_TAG })`
  (import `buildInfo` from `./kit/api/build-info.js`) and add `APP_IMAGE_TAG: z.string().optional()` to the env
  schema; in `docker/docker-compose.yml` give the `api` service `environment: { APP_IMAGE_TAG: ${API_TAG:-} }`.
- `docker/docker-compose.yml` of a fullstack project: remove the `ports:` block of the `api` service (the UI reaches
  it as `http://api:3000`; publish it on `127.0.0.1` only if something outside compose must call it) and drop
  `API_PORT` from the deploy host's `.env`. Unregister any route or health probe that pointed at the API's host port.
- `ui/playwright.config.ts`: replace the fixed e2e port `3999` with the project's own (`<UI port> + 10000`) so two
  projects can run e2e at the same time.
- `ui/package.json`: add `"overrides": { "editorconfig": { "minimatch": "^11.0.8" }, "readdir-glob": { "minimatch":
  "^11.0.8" }, "js-beautify": { "glob": "^14.0.6" } }`, then `npm install` — removes the moderate `npm audit`
  findings in transitive dev dependencies.
- Pages generated by `add page` / `add resource` of kit 0.2.0: change `@retry="load"` on `<AsyncState>` to
  `:retry="load"` (the retry button never showed) and the class `divide-border` to `divide-line`.
- `api/src/config.ts` + `api/src/auth/index.ts` (identity header names): add `AUTH_HEADER_PRESET`,
  `AUTH_HEADER_USERNAME`, `_UID`, `_EMAIL`, `_NAME`, `_GROUPS` and `AUTH_HEADER_GROUPS_SEPARATOR` (all
  `z.string().optional()`) to the env schema, and pass `headers: identityHeaders({ preset: config.AUTH_HEADER_PRESET,
  username: config.AUTH_HEADER_USERNAME, uid: …, email: …, name: …, groups: … })` and `groupsSeparator:
  config.AUTH_HEADER_GROUPS_SEPARATOR` in the `proxy` option of `createAuth` (import `identityHeaders` from
  `../kit/auth/proxy.js`). Without this the API keeps reading `X-Authentik-*` only.
- `ui/server/routes/api/[...path].ts` of a fullstack project with auth: carry the auth bridge —
  `import { authBridgeFromEnv } from '../../kit/auth-bridge'`, `const bridge = authBridgeFromEnv()` at module level
  and `bridge(event.node.req.headers, event.node.req.socket.remoteAddress)` before `proxyRequest(...)`. Then give the
  UI server `AUTH_PROXY_SECRET` (the API's value), `AUTH_BRIDGE_TRUSTED_PROXIES` (the forward-auth proxy's address as
  the UI sees it) and `AUTH_HEADER_PRESET`; in `docker/docker-compose.yml` add them to `environment:` of the `ui`
  service (`KEY: ${KEY:-}`). Remove a hand-written header translation in that route if you had one, and clear
  `AUTH_TRUSTED_PROXIES` of the API if it named the proxy (its peer is the UI server).
- `ui/server/og.ts` of a fullstack project (link previews of record pages): to use the new lookup, create the helper
  and its test (`scaffold update --show ui/server/utils/server-api.ts > ui/server/utils/server-api.ts`, the same for
  `ui/tests/unit/server-api.spec.ts`), take the `RECORDS` / `recordPreview` block and the
  `import { serverApi } from './utils/server-api'` line from `scaffold update --show ui/server/og.ts`, call
  `await recordPreview(path)` in `resolveOg` (make it `async`), and set `API_SERVICE_TOKEN` for the UI server (a
  service token created WITHOUT roles: `npm run auth:token -- create --name og-preview --days 365`; in compose
  `API_SERVICE_TOKEN: ${API_SERVICE_TOKEN:-}` under `environment:` of the `ui` service). Without this nothing
  changes; `add resource --og` then skips its og entry and says so.
- `ui/server/plugins/og.ts`: add `trustHost: import.meta.dev` to the options —
  `ogPlugin(resolveOg, { siteUrl: siteUrl || undefined, trustHost: import.meta.dev })(nitro)`. The request's Host is
  no longer believed by default, so without it `og:url` / canonical are missing in local development (a deployed
  instance gets them from `NUXT_PUBLIC_SITE_URL`); never pass `trustHost: true` on a deployed instance. In
  `ui/server/og.ts` remove any title derived from the URL path (unlisted URLs return the site preview).
- A resource page generated by kit 0.2.0 (`ui/app/pages/<name>.vue`, read-only list): it keeps working. To add
  pages below it (`scaffold add page <name>/[id]`), first `git mv ui/app/pages/<name>.vue
  ui/app/pages/<name>/index.vue`; new `add resource` runs write `<name>/index.vue` + `<name>/[id].vue` with forms.
- `.gitleaksignore`: KEEP the entries for `.scaffold.json` when the repository has commits made before this update.
  New commits no longer need one (hashes are written as `sha256:<hex>`), but `npm run gate:ci` scans the whole git
  history and the old commits still hold the bare hashes — removing the file makes gate:ci fail on them. The
  supported form is one line per finding exactly as `gitleaks detect -v` prints its `Fingerprint:`
  (`<commit>:.scaffold.json:generic-api-key:<line>`; the commit-less form `.scaffold.json:generic-api-key:<line>`
  also works, for the hook and for the history). Only a repository whose history starts after the update (or was
  rewritten) can drop the file. A history scan from a baseline commit (`gitleaks detect --log-opts=<commit>..HEAD`)
  is possible by hand but is not what gate:ci runs — the ignore file is the path the kit supports.
- `api/src/config.ts` + `api/src/app.ts` (trace ids): a caller no longer chooses the trace id. Add
  `TRUST_TRACEPARENT: z.enum(['0', '1']).default('0')` to the env schema; in `createApp` build the auth once
  (`const auth = appAuth(config, deps.database, logger)`), define
  `const trustTraceparent = (c: Context) => config.TRUST_TRACEPARENT === '1' || auth.viaProxy(c)` (`import type {
  Context } from 'hono'`; without the auth module: `() => config.TRUST_TRACEPARENT === '1'`), pass `trustTraceparent`
  to `createApi({ … })` and, with the trace module, `before: [traceMiddleware({ trustParent: trustTraceparent })]`.
- `api/tests/app.spec.ts` and `api/tests/trace.spec.ts` (the two tests that send a `traceparent` header —
  "continues the trace of an incoming traceparent header" and "continues the trace of the caller (traceparent)"):
  they fail after the update. Build the app with the setting where the trace must be continued —
  `t.build({}, { TRUST_TRACEPARENT: '1' })` — and assert that without it the response carries a NEW trace id. The
  current tests: `scaffold update --show api/tests/app.spec.ts` / `api/tests/trace.spec.ts`.
- `api/tests/*.spec.ts` and any route of yours outside `/api/v1`: every route now needs its declaration as the
  first middleware, test routes too — `app.get('/_test/500', publicRoute(), () => { … })` (import `publicRoute` from
  `../src/kit/auth/guard.js`). Without it the route answers 500 "undeclared" instead of what the test expects.
- `api/src/app.ts` + `api/src/config.ts` (rate limit): the budget is per client only when the proxy is trusted —
  give the `rateLimit` option `trust: { secret: config.AUTH_PROXY_SECRET, trustedProxies: config.AUTH_TRUSTED_PROXIES }`
  and `onSharedPeer: (peer) => logger.warn('rate limit: requests arrive through a proxy that is not trusted', {
  peer })`. In a fullstack project the API's only peer is the UI server, so all users would share one budget: change
  the default to off — `RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(0)` in the env schema and
  `RATE_LIMIT_MAX=0` in `api/.env.example`, `docker/env.example` and the deploy host's `.env` (rate-limit at the
  reverse proxy instead).
- `ui/nuxt.config.ts`: security headers on everything the UI server sends — add
  `routeRules: { '/**': { headers: { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin', 'content-security-policy': "frame-ancestors 'none'" } } },`
  to `defineNuxtConfig` (merge it into an existing `routeRules`).
- `package.json` at the root of a fullstack project: make `postinstall` follow the command that started it, so that
  `npm ci` in CI installs both parts from their lockfiles —
  `"postinstall": "c=install; [ \"$npm_command\" = ci ] && c=ci; npm $c --prefix api && npm $c --prefix ui"`.
- New generated tests a 0.2.0 project does not have — create each with `scaffold update --show <path> > <path>`,
  then run the gate: `ui/tests/unit/auth-bridge.spec.ts` (fullstack + auth), `ui/tests/unit/server-api.spec.ts`
  (fullstack + og), `ui/tests/unit/api-error.spec.ts` (fullstack + api). Tests that exist in both versions were
  extended (`api/tests/auth.spec.ts`: undeclared routes outside `/api/v1`, the header preset; `api/tests/security.spec.ts`;
  `ui/tests/unit/og.spec.ts` and `ui/tests/e2e/og.spec.ts`: no title from the path, the site URL): compare with `scaffold update --show <path> | diff - <path>` and take over the new cases.
- `api/openapi.json` and `ui/app/api/schema.d.ts`: after the update and the notes above, run `npm run contract` in
  the API directory and `npm run client` in `ui/`, commit the result, then `npm run gate` at the root.
- `brief.md` at the project root: new projects keep the brief only at `.memory/docs/brief/brief.md`; move yours
  there (add the `name` / `description` front matter) and point the README link at it.
