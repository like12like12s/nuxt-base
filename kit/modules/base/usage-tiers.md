## Test tiers — tiers-check (`{{kit.uiDir}}tests/kit/tiers-check.mjs`)

- Runs as the first stage of `gate` (no tests execute): every spec reachable from `tests/tiers.json` `map` or listed in `fullOnly`; tags inside the closed set `@smoke @layout @quarantine` (+ `tags` declared in tiers.json); spec files not in `baseline` named after the module/page, never `t1405-*` / `v112-*` / `fix3`.
- An unmatched `map`/`fullOn` glob only warns — a rename never turns the gate red. No tiers.json at all: exit 0.
- A test that branches on the Playwright project or viewport (`test.skip`, an `if`) carries `@layout`, or T1 would run it on one viewport only.
- `node tests/kit/tiers-check.mjs --init-baseline` records the current spec paths once, when adopting.
- `node tests/kit/tiers-check.mjs --write-map` regenerates the page→spec part of `map` from the flow catalog (needs `"flows": "tests/flows/catalog.mjs"` in tiers.json — a data-only module or JSON of `{ id, pages[] }` flows; specs reference flows by title `"[P7.F3] …"`). Hand-written `map` keys outside `app/pages/**` are kept.
