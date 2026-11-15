## Typed API client (`{{kit.uiDir}}`)

```bash
npm run contract --prefix {{kit.apiDir}}   # API routes -> {{kit.apiDir}}/openapi.json
npm run client --prefix {{kit.uiDir}}      # openapi.json -> {{kit.uiDir}}/app/api/schema.d.ts
```

- `useApi()` (`app/composables/useApi.ts`) is an `openapi-fetch` client typed by that file: paths, params and bodies
  are checked by `npm run typecheck`. `const { data, error } = await useApi().GET('/api/v1/items', { params: { query: { limit: 20 } } })`.
- `tests/unit/api-client.spec.ts` fails when `schema.d.ts` is older than `{{kit.apiDir}}/openapi.json`; `app/api/schema.check.ts`
  is the compile-time test that the client is really typed (it runs with `npm run typecheck`).
