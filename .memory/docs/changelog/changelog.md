---
name: nuxt-base-changelog
description: Change history of nuxt-base (newest first)
---
# nuxt-base — Changelog

### t1444b — tiers-check wired into the generated gate (t1449 merge) + module-spec map fix
- Merged `t1449-tiers-check` (9ed30fa + 3ac3c1f) and wired `node tests/kit/tiers-check.mjs && ` first in the nuxt-app kind's ui gate (both kinds' ui parts get it; api kind stays without — no tiers.json there). Fresh-app proof: scaffold → checker exit 0 against the generated tiers.json.
- The first post-merge kit gate caught a real gap (19/21): og combos ship `tests/e2e/og.spec.ts` with no map entry → "spec not reachable" → gate red. Template fix: `server/**` → `[app.spec, og.spec]` when og (both kinds), `ui/server/utils/**` → the api proxy spec under fullstack+api. All 5 variants render valid JSON, checker exit 0 on each.
- Edge reported to t1449: without a git toplevel (fresh project before `git init`, or no gitleaks in the kit gate) the checker loses the `ui/` pkg prefix → fullstack first gate would be red; nuxt-app at root unaffected. Fix belongs to the checker.

### t1444 — test tiers in the kit + the repo, queue helper in every playwright run
- GATE.md tiers (t1438 wave 2, task #5). Repo scripts: `gate` = typecheck + lint + vitest + templates mirror (playground build + e2e moved OUT — the contract: no build artefacts, no browser); `test:smoke` = build + the 4 `@smoke` layer tests; `gate:full` = gate + all e2e; `npm test` composite dropped. `tests/tiers.json` (exclusive — e2e port 3518 fixed; map app/playground/server/public → layer.spec; **fullOn `kit/**`** so an ai-verify diff on the kit pulls T2 = `gate:full && gate:kit`).
- Queue: `scripts/lib/heavy-run-global-setup.mjs` (copy of the t1441 helper, sanitized for the public repo — no host names) wired into the repo's own playwright config via globalSetup; smoke grep = light slot, full = heavy, bare `npx playwright test` queues too. Proved live (heavy-run log row for like12like12s/nuxt-base, light, at the smoke run).
- **Playwright >= 1.45 wiring break found**: function `globalSetup` is rejected ("must be a string") — the ai-cli helper's documented wiring throws on 1.65 before any test runs. Working form: string path (default export runs) + bare import for the env side effect; no globalTeardown (process-exit hook releases). Told t1445/t1442; helper header doc updated in both copies.
- Kit gate self-wraps heavy-run at startup (one heavy slot for the whole run; `HEAVY_RUN_HELD` passes the env filter so grandchildren — each combo's `npm run gate`, its playwright — stay out; `--list` skips; exit 75 = not run). The pulse kit-gate-weekly job and `ai verify` T2 inherit the queue for free.
- Templates: nuxt-app/fullstack(ui) get `test:smoke` + `gate:full` scripts, `@smoke` on all 3 skeleton tests, locked `scripts/lib/heavy-run-global-setup.mjs`, `tests/tiers.json` (repo-root-relative map; `ui/` prefixes under fullstack via `@kit:if kind:fullstack` — the else-comma layout keeps both renders valid JSON); api kind gets `gate:full` (= gate + build, no e2e — script split alone). Kit gate: the plain nuxt-app combo proves the generated `npm run test:smoke` itself (build + grep + helper) instead of the raw runner.
- Docs: README/usage.md (kinds + repo), UPGRADING.md 0.4.0→next by-hand steps for existing kit projects (scripts are app-owned), ai-verify lines → `gate && test:smoke` + `ai-verify-full: gate:full && gate:kit` (contract with t1445). CI keeps e2e coverage via `test:smoke` after gate:ci (browser install stays; dogfood extra-lines updated).
- t1449 (tiers-check) coordinates: they add the checker + `node tests/kit/tiers-check.mjs` first in the generated gate chain from their branch; kinds' gate script unchanged in this task.
### t1449 — tiers-check: the shared tier-contract guard + the page→spec map generator, shipped from base
- New locked runtime `kit/runtime/testing/tiers-check.mjs` → `tests/kit/tiers-check.mjs` of every UI part (registered in the **base** module's new `ui` contribute, so it is there with or without testkit — tiers are default-on once a tiers.json exists). Zero-dep, runs no tests, no-ops (exit 0) while a repo has no tests/tiers.json (tests/ then test/, one level down from a repo root too; several tiers.json = all checked).
- The 3 checks of the GATE.md contract: (1) every discovered spec reachable from `map` or listed in `fullOnly` (2) tags inside the closed set @smoke @layout @quarantine + declared `tags` — both the `tag:` option form and title-end tags — and a test branching on project/viewport (test.skip/fixme/if within a 3-line window; describe's @layout covers its tests; test.skip(cond) inside a test is a statement, not an opener) must carry @layout (3) spec files not in `baseline` are not named t1405-* / v112-* / fix3 / settings-v2 (tv-guide, nav2, cov19 pass). Unmatched map/fullOn glob or a stale map value = WARN, never red.
- `--init-baseline` records current spec paths; `--write-map` regenerates the page→spec part of `map` from the flow catalog (`"flows"` key; .mjs/.js/.json, personas flattened; specs reference flows by `[P7.F3]` titles). Route→glob: dynamic leaf = `*` (whole filename — `[slug]` written out would be a glob char class), catch-all `**`, flat file wins, index folder when that is what exists, neither = flat + warn; keys under `pages` only, hand-written entries kept; empty entries omitted. All paths repo-root-relative (ui/ prefix of a fullstack), repo root = git toplevel.
- t1444 wires `node tests/kit/tiers-check.mjs && ` into the generated gate chains in kind.json (separate commit, master); UPGRADING.md tells existing projects how to adopt. agent-remote (t1442) vendors the same file.
- Tests: +26 in kit/tests/runtime-tiers-check.spec.ts (fixtures in tmp repos; glob `/**/` zero-segment case, tag forms, opener-vs-statement skip, baseline, monorepo prefix, CLI exit codes + --json); modules.spec asserts the new locked set + base-without-testkit. Unit 616 green, e2e 4 green, templates in sync, typecheck + oxlint clean; gate:kit via heavy-run.

### t1368c — fresh-review round 1 (0🔴 5🟡): fixed 4, kept 1
- IconButton header now states `class` is a layout-only contract (visual state goes through `variant`). The class-on-wrapper split stays (deliberate, matches agent-remote).
- +1 unit test: `aria-expanded` flipped after mount (host component with a ref) reaches the control and hides the bubble. Fails on v0.5.4.
- ports.spec `freeBase`: band moved to [lo-1900, lo-200], above every pid's kit-gate `defaultBase` (≤ lo-2000), so concurrent gate servers don't start there. Throws when the ephemeral range starts too low to fit a band. The `base+40 ≤ lo` guard is kept (cheap).
- Comment/test-only on top of v0.5.5: no version bump. Gate green (589 unit + 4 e2e, templates in sync).

### t1368b — kit ports.spec flake: freeBase drew bases inside the ephemeral range and under-probed
- `ai verify` run 2 failed `a block with a port in use is skipped` (expected 40130, got 40140). `freeBase()` picked bases in 20000–59900, which overlaps the kernel ephemeral range (32768–60999, same root cause as t1349), and probed only base..base+29 while the test reaches base+39, so a busy fourth block slipped through.
- Fix: bases come from 15000…(ephemeral lo − 1000), all 40 ports are probed, and the test asserts base+40 ≤ lo. Sweep: the only random-port picker in tests/ scripts/ kit/tests. 10/10 isolated runs green; full gate green.

### t1368 — IconButton: fallthrough attrs land on the control, not Tooltip's wrapper (v0.5.5)
- Bug (fresh-review t1338 #1): IconButton's root is `<Tooltip>`, so `id` / `data-testid` / `aria-*` / `@click` from consumers fell through to Tooltip's wrapper `<span>`. A menu trigger's `aria-expanded` sat on the wrapper, and Tooltip reads it off its *first child*, so the hide-while-menu-open bubble never hid; the testid/id pointed at a non-interactive span; and `@click` on a disabled button still fired through the wrapper.
- Fix: `inheritAttrs: false`. `class`/`style` stay on the wrapper (it's the box the parent lays out: ml-auto, xl:hidden). Every other attr is `v-bind`-ed onto the interactive element (button / `<a>` / NuxtLink), before the component's own attrs, so `label` still wins for aria-label/title. Same split agent-remote's local copy already used.
- Tests: +3 unit (attrs on control + class/style on wrapper + link form; disabled swallows consumer click; consumer aria-expanded="true" hides the bubble). The attrs and aria-expanded tests fail on v0.5.4. `npm run gate` green (588 unit + 4 e2e, templates 26 in sync); mirror synced (`~/.dev-mem` 97b2000).
- Version 0.5.4 → 0.5.5 (package.json + kit-version.ts), tag v0.5.5.
- Consumer sweep (`grep "<IconButton" ~/projects`): no consumer of the canonical layer/mirror component passes attrs (drill/ui, kit-ref have no IconButton usages, so no bump needed). intzone's local copy only gets props + @click (bubbling made it work). agent-remote's copy already splits attrs this way. Nothing to change downstream.

### t1338 — IconButton target/rel passthrough (v0.5.4); consumers catch up to the v0.5.3 vertical clamp
- IconButton (canonical, layer + template mirror): `target`/`rel` props pass through to the link forms (`to`/`href`) for external new-tab icon links; `target="_blank"` without an explicit rel defaults to `noopener noreferrer` (tabnabbing); the button form carries neither. +1 unit test (explicit rel kept, safe default, button form clean). `npm run gate` green (585 unit + 4 e2e + templates 26 in sync).
- Version 0.5.3 → 0.5.4 (package.json + `kit/runtime/api/kit-version.ts`), tag v0.5.4.
- Consumers: drill/ui extends bumped #v0.5.2 → #v0.5.4 (superset of the v0.5.3 clamp + the passthrough), deployed 20261120-002119-745d243 (healthy, smoke 200, live chunk DHhCvT-q.js has both clamps) · dock + agent-monitor Tooltip copies re-synced from the layer and deployed/restarted (live chunks DSOUn-qc.js / C9PkazoD.js) · pilot's forked Tooltip ported the vertical clamp into its `tooltip-position` util (its width-cap fork stays), built on the serving host, PILOT-WEB restarted via the Pilot API (live chunk yLn51DNA.js) · laab checked: no Tooltip/IconButton copy — bespoke CSS `data-tooltip` in style.css, nothing to sync.
- Post-release `gate:kit` rerun against the tag: 21/21 passed (per the after-a-release rule).
- Changelog housekeeping: t1349/t1329/t1335 entries had landed above the frontmatter (t388 shape) — moved below the title.

### t1349 — kit gate: port bases out of the kernel's ephemeral range (EADDRINUSE flake)
- Root cause of the t1335-verify flake: the run base `30000 + (pid%140)*250` could land inside the kernel's ephemeral range (`ip_local_port_range` = 32768-60999 here) — every outgoing connection takes a source port from that range, so a block `isFree()`-probed one minute was someone else's by the time the combo's server bound it (EADDRINUSE on 32774/44554, 1-3 combos/run while other sessions tested).
- `ports.mjs` gains `ephemeralRange()` (reads /proc, Linux default as fallback) and `defaultBase(pid, lo)` (11000…lo-2000, 200 apart per pid); the gate refuses a pinned `--port-base` inside the range and caps the block walk at `max: lo-1` (65000 when pinned above it), so even a long skip-walk cannot cross into the range. `listen(0)` rejected: combos consume blocks of *consecutive* ports bound by their own child processes.
- Tests: +2 unit (ephemeralRange parse/fallback incl. the real host file; defaultBase determinism, every pid < lo-2000, degenerate-host value the gate refuses loudly) + structural gate test pins the cap and bans the old formula. `npm run gate` 584 pass · full `gate:kit` 21/21 (ports 14400-32767, zero NOTICE, zero EADDRINUSE) · `--port-base 40000` → exit 2 naming the range.
- Sweep: the pid-derived port formula existed only in kit-gate.mjs (grep over kit/, scripts/, tests/); nothing under `kit/runtime/**` changed → no version bump, no consumer action.

### t1329 — Tooltip: clamp the vertical axis — below-the-fold triggers left resting bubbles past the viewport edge (v0.5.3)
- Found deploying the intzone A11Y-010 fix (icon-only sweep t1308): a trigger at/below the fold (long list rows, intzone manage) put its resting bubble h+6 above itself — still outside the viewport, so lens A11Y-011 fired on every clipped row.
- position() now computes the CSS side spot, and when it falls outside [8, vh-8-h] clamps the bubble in via inline `top` and drops the side classes (their insets would fight it); scroll/resize repositions as before. X axis unchanged.
- Tests: below-the-fold clamp asserts inline top = clamp + classes detached; fully-visible trigger asserts CSS placement kept; the side=bottom test now mocks real geometry (it leaned on happy-dom's zero rect, which the clamp catches). 582 pass.

### t1335 — sweep: v0.5.2 fix confirmed as the port of pilot aade66a6; one stale consumer copy fixed
- Task asked to port the pilot fix (aade66a6: apply `left-1/2 -translate-x-1/2` only while `left == null`) — already shipped here as v0.5.2 (t1322, e2e5d0c) with the unit test asserting the centring classes are gone; mirror 4630011 identical. Closed as duplicate for the layer itself.
- Consumer sweep (`grep "Rule t1308" ~/projects`): drill/ui extends #v0.5.2 (f9f5710) ✓ · pilot has its own fixed copy (aade66a6) ✓ · kit-ref on v0.4.0 predates Tooltip ✓ · agent-monitor had copied the mirror 18 min before the t1322 fix landed (t1324, v0.5.1 shape) — re-copied, tested, built, restarted via Pilot, live-verified (bundle has the conditional translate; health ok) · crg uses element-plus, not ours.
- Lens A11Y-011 fixture (right-edge only) gained the left-edge pair — the shape this bug actually produces (lens 110578b).

### t1322 — Tooltip: clamped bubble no longer shifted left by half its width (v0.5.2)
- Bug from v0.5.1: once `position()` set an inline `left`, the bubble kept `left-1/2 -translate-x-1/2`, so every measured bubble sat w/2 left of where the clamp put it (drill /coverage first-column dots: bubble at x=-18, trigger at x=201). Found by lens A11Y-011 on drill after adopting Tooltip.
- Fix: the CSS centring classes apply only until `left` is measured. Why tests missed it: the unit test asserted `style.left` only; it now also asserts the centring classes are gone (fails on v0.5.1, passes now). `npm run gate` green (580 unit + 4 e2e, templates in sync).
- Sweep (`grep translate app/components`): UiHint is the only other computed-offset bubble and was already right — its bubble has no translate, and its arrow's `-translate-x-1/2` is intended (that `left` is the arrow centre). Nothing else combines an inline offset with a translate.

### t1308b — Tooltip: viewport clamp + flip + hide while its own menu is open (v0.5.1)
- Follow-up from t1307 (jot at 390px): a centred bubble on a right-edge trigger ran past the viewport edge and stayed visible over its own open dropdown.
- Tooltip now positions on mount (not only on hover, so the resting box a lens audit measures is the clamped one): clamps 8px inside the viewport, flips below the trigger when there is no room above, repositions on resize/scroll (capture), and force-hides (`!opacity-0`) while the trigger carries `aria-expanded="true"` (MutationObserver — menu toggles don't fire events near the tooltip).
- 2 new unit tests (clamped left at 390px + flip; aria-expanded show/hide round-trip), full `npm test` green. Companion lens rule A11Y-011 (tooltip box inside viewport), standard 1.3.0.

### t1308 — Tooltip + IconButton: icon-only controls get a hover/focus tooltip + aria-label
- User rule (2026-11-19): every icon-only button/link must show a tooltip on hover AND keyboard focus with the action name, matching aria-label — native `title=` alone is not enough ("ระบบเราเยอะ จำไม่หมด").
- New `Tooltip.vue` (primitive wrapper: `label` + `side`, shows via group-hover/group-focus-within) and `IconButton.vue` (`label` REQUIRED → aria-label + title + tooltip; ghost/danger × sm/md/lg; `to`/`href` like Btn) in `app/components/`, mirrored to `~/.dev-mem/templates/components/` (sync-templates only verifies existing files — new ones copied once, now 26).
- Version 0.4.0 → 0.5.0 (KIT_VERSION bumped with it), README component list + icon-only rule note. 4 new unit tests (tooltip render/side, label wiring, variants/link form); full `npm test` green (578 unit + 4 e2e + templates check).
- Detection lives in lens ui-audit rule A11Y-010 (separate commit in lens); per-app fixes tracked as their own Pilot tasks.

### t1135 — kit: flaky generated request-log test (marker colliding with the hex trace id)
- Root cause: `tests/app.spec.ts` asserts the request log does not contain the query-string marker `abc`, but the same log line carries the random hex trace id (`randomBytes(16).toString('hex')`) — an id containing `abc` trips the assertion. Measured 0.743% of ids (1M samples); reproduced deterministically by continuing a trusted traceparent with id `abcd`×8 through the real app (`/tmp/t1135-proof.mts`): log line contains `abc` → old assertion fails, marker absent → new one passes.
- Fix: marker is now `zz-secret-zz` (contains `z`, not a hex digit — collision probability exactly 0) in `kit/modules/api/files/tests/app.spec.ts`, `kit/kinds/api/files-plain/tests/app.spec.ts`, `kit/tests/runtime-trace.spec.ts:96`.
- Sweep of the same pattern repo-wide: `kit/tests/runtime-api.spec.ts:242` uses `?secret=abc` but has no not-contains assertion (no flake possible — left as is); `kit/modules/api/files-sample/tests/items.spec.ts:129` `limit=abc` is intentional invalid input for a validation test (no collision). No other `not.toContain` on a short hex-colliding marker.
- `tests/app.spec.ts` is app-owned → `kit/UPGRADING.md` gained a `0.4.0 -> next` step (take the file over with `scaffold update --show`, or hand-edit the two lines). Applied to kit-ref (api/tests/app.spec.ts taken over; only the 2 marker lines differ).

## 2026-11-16

### v0.4.0 + t1123 — dev-kit fix4: second-review findings + upgrade-path gaps (epic t1092)
- CI: spawn-heavy kit specs have explicit timeouts (v0.3.0 release run was red on a 5 s default)
- db: a QUERY_TIMEOUT inside a transaction runs the unit once and reaches the caller (the failed ROLLBACK on the destroyed connection no longer replaces it / triggers replays); `addLiveUnique` / `dropLiveUnique` for an existing table, portable SQLite/MySQL
- jobs: lock race tests pin the confirm step (stale lock at generation >= 1, churn round; mutation-proven); grace period on the injected clock; superseded/own lock files removed only while they hold the judged record
- api: `CommitOutcomeUnknownError` -> 503 `COMMIT_OUTCOME_UNKNOWN` (new code in the Error schema)
- auth: one identity per request on both hops (repeated header / comma in user name, uid, email = 401); bridge refuses reserved header names; a service-token role the app dropped is ignored
- generator: `update` never downgrades (`kit_older`); `update --show <path>`; duplicate route params refused; `add resource --og` is opt-in
- gate:ci scans history + (locally) uncommitted changes; kit gate probes port blocks before use
- UPGRADING: 0.2.0 -> 0.3.0 complete without a fresh scaffold; new 0.3.0 -> next section
- Tests: gate 574 unit + 4 e2e; gate:kit 21/21; CI green on 9247f60
- Release v0.4.0 (tag): contract changes for wrappers — `add resource --og`, `update --show <path>`, exit 4 `kit_older`, exit 2 `duplicate_param`/`og_unavailable`, error code `COMMIT_OUTCOME_UNKNOWN`; by-hand steps in `kit/UPGRADING.md` "0.3.0 -> 0.4.0"
- Second review (t1116): 0 Critical/High, 8 Medium, 21 Low — kit part fixed here; ai-cli part t1124, pilot/pulse part t1125

### v0.3.0 — kit after review + first real use (epic t1092)
- Tag v0.3.0 = fix round 1 (t1106) + fix round 2 (t1112) · `kit/UPGRADING.md` section `0.2.0 -> 0.3.0` lists the by-hand steps; `scaffold update` prints them

### t1112 — fix round 2: findings from the reference app kit-ref (t1096)
- Auth behind a forward-auth proxy (#1, 6d515c8): identity header names configurable (`AUTH_HEADER_PRESET`, incl. the Remote-* preset); the fullstack UI's `/api` proxy carries the bridge — forwards identity + proxy secret only for the trusted proxy peer, strips them otherwise (spoofing with the real secret from another peer = 401 on the built app)
- `.scaffold.json` hashes are `sha256:<hex>` so a fresh scaffold passes gitleaks (#2); kit gate commits every combo through gitleaks
- Generators (#3 #4): list page retry fixed; `add resource` → `<name>/index.vue` + `[id].vue` with create/edit/soft-delete forms and per-field 400 details; `add page` takes nested/dynamic paths
- New flags: `--no-sample` (#13), `--lang th|en` (#15, default th; layer labels follow `nuxtBase.lang`) · role-less service tokens (#5) · og + auth reads records with a service token (#6) · `/version` reports commit + builtAt in images (#11) · fullstack container API publishes no host port, `services[].internal` (#14) · e2e ports derive from the project's ports (#17) · scanner findings in locked files fixed, `npm audit` moderate = 0 in a fresh scaffold (#12) · title derived, one brief at `.memory/docs/brief/brief.md` (#10) · `# kit:generated KEY` line in docker/env.example for secrets created on the host
- `check` reports `state: clean | drift | kit-unreleased` with the kit commit (#7 #18); unreleased kit work is not project drift
- Tests: gate 549 unit (5 MySQL-only skipped) + 4 e2e · `gate:kit` 21 combos

### t1106 — review fix round 1 (review t1097: High 3, Medium 14, Low 19; epic t1092)
- H1 (29f0f55): a COMMIT whose acknowledgement is lost is never replayed — error `COMMIT_OUTCOME_UNKNOWN` (before: write + audit applied twice) · H2 (a1d9ff0): SQLite pre-migrate backup = `VACUUM INTO` + `integrity_check`, a failed backup refuses the migration (exit 3) · H3 (8c94d06, a253a0f): job lock by atomic `link()` per generation — 12-process race test, 1 holder every round
- M1/M2/M14 (fae1a0a): `--context`, title, description validated (hostile values refused; stored answers of existing projects only warn); no `container_name` in compose templates (two stages on one host); generated README + `next[]` say the repo must stay private · M3 (523f12d): CI runs gitleaks for real, `npm ci`, actions pinned by SHA · M4/M13 (0e28974): rate limit per client only through the trusted proxy (fullstack default off); auth fail-closed on every path, declaration must be the first handler · M5 (f8d3022): og URLs only from `NUXT_PUBLIC_SITE_URL` · M6/M7 (21324e0): MySQL timeout kills the server-side query; SQLite lock waits no longer block the event loop · M8 (42b0c7e): live-unique via generated column + UNIQUE index, duplicate → 409
- L1–L16 all fixed (client `traceparent` trusted only via the proxy or `TRUST_TRACEPARENT=1`; log fields cannot override standard ones; symlink-safe update; UI security headers; reserved words refused by generators; public guard also scans `.memory/` + README)
- Tests: gate 462 unit (5 MySQL-only skipped) + 4 e2e · `gate:kit` 18/18 twice in a row · GitHub Actions green
- Upgrade notes for v0.2.0 projects (app-owned files are not rewritten by `update`): mount auth on `*`; set `NUXT_PUBLIC_SITE_URL`; port the items live-unique pattern by hand; drop `container_name` from compose; job locks are now `<name>.lock.<n>`

### v0.2.0 — first kit release (epic t1092)
- Tag v0.2.0 = layer + kit (package.json and `kit/runtime/api/kit-version.ts` bumped together) · layer change: `useAuth` also reads the API envelope of `GET /api/v1/me`

### t1095 — dev-kit E: auth, trace, og, security, jobs, notify + playbooks (epic t1092)
- `auth`: Authentik forward-auth headers believed only with the proxy secret and/or trusted source (nothing set = never), users upserted, roles from groups, `publicRoute()` / `requireAuth()` / `requireRole()` with undeclared routes listed and refused, service tokens (hash, expiry, revoke, lastUsedAt, CLI), dev mode refuses production · `trace`: OpenTelemetry server span from a hono middleware, OTLP endpoint from env, same id in `x-trace-id` and the JSON log · `og`: one Nitro `render:html` plugin for every target · `security`: secure headers, CORS allowlist, rate limit, body limit · `jobs`: skeleton + lock + exit codes, scheduler entry as a generated doc · `notify`: 65-line client
- Playbooks `playbook-add-{resource,page,job}.md` land in the project's `.memory/docs/guides/`; `scaffold add resource|page|job` patch app files at `kit:anchor` comments (`patched[]`, exit 2 `anchor_missing`); templates use `@kit:if` blocks
- Kit fixes: `scaffold check` reads the layer tag from nuxt.config · generated gates = typecheck → oxlint → test · nuxt-base has its own CI workflow from the `ci-github` template (GitHub Actions run green) · gate:kit builds/removes docker images one at a time (flake)
- Tests: gate = 373 unit (4 MySQL-only skipped) + 4 e2e · `gate:kit` 18 combos incl. fullstack with every module + all three generators, api+container, nuxt-app+og+auth on wrangler's Pages runtime
- Limits: outgoing calls untraced; rate limit per peer and per process

### t1094 — dev-kit D: api + db + testkit modules (epic t1092)
- `api`: locked runtime `kit/runtime/api` → hono + zod-openapi `createApi`, `/api/v1`, error `{ error: { code, message, details, traceId } }` (fixed code set, 500 never leaks), `x-trace-id` + JSON request log, pagination (`limit` ≤ 200, `offset`, `sort`, `ids=`; out of range = 400, never clamped), `/health/live`, `/health/ready` (503 + checks), `/version`, `/openapi.json` + committed contract test, example `items` resource · typed client (openapi-typescript + openapi-fetch) lives in the UI as `useApi()`
- `db`: Kysely — one migration set for SQLite (`node:sqlite` adapter, no native build) and MySQL (mysql2); base tables users / audit / service_tokens + id/createdAt/updatedAt/deletedAt; ISO-8601 varchar timestamps, JSON as text, app-generated UUIDs; pool timeouts, bounded retry on transient errors (reads replayed after a lost connection, writes never); `db:migrate` up/down/status, `db:seed`, `db:check` (used by `/health/ready` and the container preset — fails closed; `DB_MIGRATE_ON_DEPLOY=1` migrates with a backup first); `new --json` gains `backup[]`
- `testkit`: deterministic factories (fixed seed + clock), temp DB per test file, app test client, playwright helpers · `api` and `db` require each other
- Generator: `when.with/without/db` conditions, `mysqlHost` context; locked runtime moved `src/kit/*.ts` → `src/kit/<area>/` (projects from 0.1.3-era scaffolds show drift until `scaffold update`)
- Tests: gate = 201 unit (4 MySQL-only skipped with a loud notice) + 4 e2e · `gate:kit` 15/15 (adds api+db on SQLite, MySQL 8.4 throwaway container, container, fullstack) · real MySQL: migrate up→down→up, KILL-connection recovery, lock-wait retry, backup refusal
- Open: not run on the central dev MySQL (needs a user with grants on `test_%`) · check-before-replace needs a pre-up `db-check` hook in the private deploy-docker.sh · bump `kit/runtime/api/kit-version.ts` with package.json

### t1093 — dev-kit A: kit core in `kit/` (epic t1092)
- `kit/bin/scaffold.mjs` + `kit/lib` — zero-dependency Node generator: `new | add | check | update | list`, `--json`, exit codes 0/1 drift/2 usage/3 dir not empty/4 unknown or planned/70 internal · pure (writes only under `--dir`; infra values arrive via `--context`, resolved by the `ai scaffold` wrapper in ai-cli, t1087)
- Kinds `nuxt-app` (extends the layer by tag), `api` (hono, zod env schema that fails fast, `/health/live`, JSON log, graceful shutdown), `fullstack` (`api/` + `ui/`, root gate runs both) · modules `base`, `ci-github` + 9 planned stubs (api, db, auth, trace, og, testkit, security, jobs, notify → t1094/t1095) · deploy presets cf-pages / container / pm2 · `gate:ci` = gate + gitleaks + npm audit
- Locked files: byte-copied from `kit/runtime/**`, sha256 in the project's `.scaffold.json`; `check` reports an edited/missing locked file or an old layer tag, `update` restores them (never touches app files or package.json)
- Public-repo ruling: `deploy-docker.sh` and the docker-node template are NOT shipped (internal hosts) — kit has its own locked Dockerfiles; the wrapper copies deploy-docker.sh · guard test fails on private IPs / `.int.` hosts / token shapes under `kit/`
- Tests: 94 kit unit specs in the vitest suite (gate: 105 unit + 4 e2e) · `npm run gate:kit` scaffolds 10 combos into temp dirs → install → gate → build → boot/health → tamper/check/update, builds and runs the container images (75 s) · `ai-verify:` = `npm run gate && npm run gate:kit`
- Notes: kit version = package.json version = layer tag (bump both together) · generated gates have no lint step yet · api uses typescript 7, the ui keeps the layer's 5.9 range · container combos in gate:kit build against the last released tag, not HEAD

## 2026-11-15

### t1086 — proof: drill/ui migrated to the layer (deployed)
- drill `ui/` now `extends github:like12like12s/nuxt-base#v0.1.3`; 11 copied components + main.css + own Tailwind plugin removed (drill 1a17df8), deployed tag `20261115-132406-1a17df8` on the container host, healthy
- Parity with `scripts/parity-shots.mjs` (10 routes, before vs after on the same live API, repeated on live): all 200, no new JS errors, pixel diff 0–3.3% on 8 routes, `/scenarios` 8.6% (+1 px/row × 365), error page replaced by the layer's. Every delta = the app's copies being behind the template (Toggle 20→24 px, Input 38→36 px, muted text zinc-500/600→400, focus ring, Modal Esc) — i.e. the drift the layer removes
- Evidence `~/archive/research/t1086-nuxt-base/` · jot note linked from the task report
- Follow-ups: t1087 (`ai scaffold`), t1088 (drift job), t1089 (remaining apps), t1090 (deploy-docker .env preflight)

### t1086 — v0.1.3: default favicon, vue-router 5 devDep
- `public/favicon.svg` default (the layer's head links `/favicon.svg`; apps without one — e.g. drill — would 404) · app's own `public/favicon.svg` overrides it · e2e +1
- devDep `vue-router` ^4.6 → ^5.5.1 to match what Nuxt 4.6.4 resolves (removed the duplicate + the `vue-router/volar/sfc-route-blocks` warning in typecheck)

### t1086 — v0.1.2: Card header-right slot + parity-shots tool
- `Card.vue`: `#header-right` slot ported back from drill's local copy (markup unchanged when the slot is absent) — mirror synced to `~/.dev-mem/templates/components`
- `scripts/parity-shots.mjs`: `shoot` (full-page screenshots per route, JS errors, optional API `--rewrite`) + `diff` (pixelmatch % per page) — used for the drill/ui migration proof; devDeps pixelmatch + pngjs
- Repo made **public** (user decision 2026-11-15) — no `GIGET_AUTH` needed in Docker/CF builds; never commit internal hosts/credentials here

### t1086 — v0.1.0: layer created (dev-velocity pilot step 1)
- New repo: Nuxt 4.6 layer with Tailwind 4 vite plugin, `base.css` (`@theme` tokens zinc dark, class-driven `dark:`, scrollbar/focus/reduced-motion), head defaults, `runtimeConfig.public.apiBase`
- Components: 24 moved from `~/.dev-mem/templates/components` (that dir is now a mirror; `scripts/sync-templates.sh --check` in `npm test`) + LoadingState / EmptyState / ErrorState / AsyncState (loading → error → empty → content, no empty flash while pending)
- Composables: `useSiteHead` (title + OG/Twitter from app.config), `useToast` (reactive), `useAuth` hook point (off by default; Nitro `GET /api/_me` reads X-Authentik-* headers) + `auth.client` plugin · `app/error.vue`
- Fixture `playground/` extends `..` · tests: vitest nuxt env (11) · playwright on the built playground (3: render/tokens/toast/async/head, 404 page, /api/_me) · typecheck 0 errors
- Gotchas found: `app.config.ts` must live in `app/` (root one is ignored in Nuxt 4 → `useAppConfig().nuxtBase` undefined) · playwright `testIdAttribute` set to `data-test` · composables return `reactive()` so `toast.message` / `auth.user` unwrap in templates

### t1086 — v0.1.1: peer deps instead of install:true
- Measured on a scratch consumer: `extends: 'github:…#v0.1.0'` with the 3 peers installed in the app → build 6 s, layer fetched to `node_modules/.c12/github_like12like12s_nuxt_*`, Tailwind compiled the layer's classes (`@source` works from node_modules) · `{ install: true }` also worked but ran `npm install` of the layer's dev deps (~600 pkgs)
- `package.json`: deps → `peerDependencies` (@tailwindcss/vite, tailwindcss, lucide-vue-next) · README/usage updated
- ui-kit now serves its registry Vue column from this repo (submodule `vendor/nuxt-base`) — see ui-kit changelog
