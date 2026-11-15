## Test kit (`{{kit.apiDir}}/src/kit/testing`)

- `useTestDb({ migrations })` — one throwaway database per test file: a SQLite file in the OS temp dir, or a MySQL
  `test_*` schema when `TEST_MYSQL_URL=mysql://<user>:<password>@<host>:3306` is set (the same suite then runs on MySQL;
  the user needs create/drop on `test_%`). Removed after the file.
- `useDeterministic()` pins the clock and the id generator; `defineFactory()` builds fixtures from a seeded source —
  the same rows on every run. No `Math.random()` / `Date.now()` in a fixture.
- `testClient(app)` calls the app in-process and returns `{ status, body, traceId }`.
- `tests/helpers.ts` (yours) wires the three together: `const t = useApp()` then `t.build().api.get(...)`.
