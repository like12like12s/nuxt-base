## Test kit — e2e (`{{kit.uiDir}}/tests/kit/e2e.ts`)

- `captureErrors(page)` collects `pageerror` and `console.error`; end a test with `errors.assertNone()`.
- `stubApi(page, { 'GET /api/v1/items': list([...]) })` answers `/api/**` from the test in the standard envelopes
  (`one`, `list`, `failure`); a call without a stub gets a 501, so a test never reaches a real backend by accident.
