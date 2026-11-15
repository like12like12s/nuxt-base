## Auth in the UI (`{{kit.uiDir}}`)

- `app/app.config.ts` turns the layer's `useAuth()` on and points it at the API: `GET /api/v1/me` (same origin).
  `const auth = useAuth()` -> `auth.ready`, `auth.isAuthenticated`, `auth.user` (`id`, `name`, `email`, `roles`),
  `auth.login()` (sends the browser to the outpost's start URL).
- The UI never decides who the user is and never checks a permission for real — it only hides what the API would
  refuse anyway. The API enforces every rule.
- Tests: unit tests answer `/api/v1/me` with `registerEndpoint`; e2e tests stub it with `page.route` (a page that
  loads without the stub logs a failed request, which fails the e2e error check).
