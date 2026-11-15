## Auth (`{{kit.apiDir}}`, module `auth`)

Three ways a request gets an identity — everything else is anonymous:

```
dev user          AUTH_DEV_MODE=1: every request is `dev` with every role. Local only — the API refuses to start
                  with it when NODE_ENV=production.
service token     Authorization: Bearer kit_...   (machines: jobs, other services)
forward-auth      X-Authentik-* headers added by the reverse proxy after the identity provider signed the user in
```

- Routes say who may call them, in `createRoute`: `middleware: [requireAuth()] as const`, `requireRole('admin', 'editor')`
  or `publicRoute()` (`src/kit/auth/guard.ts`). A route without one is refused at run time (500, logged) and fails
  `tests/auth.spec.ts`, which also holds the role x endpoint matrix — add every new route to it.
- Roles are the app's own (`src/auth/roles.ts`). `AUTH_ROLE_MAP` maps identity-provider groups onto them:
  `AUTH_ROLE_MAP={"app-admins":["admin"],"app-editors":["editor"]}`. A group that is not mapped grants nothing.
  Signed-in users are mirrored into `users` (written and audited only when something changed); the audit actor of
  every write is the caller's subject.
- `GET /api/v1/me` returns the caller (`subject`, `name`, `email`, `roles`, `kind`), 401 when nobody is signed in.
- Service tokens (`service_tokens`: sha256 only, roles, expiry, `revokedAt`, `lastUsedAt`):

```bash
npm run auth:token -- create --name nightly-sync --roles editor --days 90   # prints the token ONCE
npm run auth:token -- list
npm run auth:token -- revoke nightly-sync                                   # by name or id; effective at once
node dist/auth/cli.js token list                                            # in a built image
```

### What the operator sets up (nothing here creates or changes it)

Forward-auth headers can be typed by anyone who reaches the API, so they are believed **only** when the request
provably came through the proxy. Until one of the two settings below is in place the API ignores them (service tokens
keep working) and logs `forward-auth headers ignored`.

1. Identity provider ({{kit.authentikUrl}}): a **Proxy Provider** in *forward auth (single application)* mode for the
   app's external URL, an **Application** bound to it, the provider added to an **outpost**, and the groups the app
   maps (`AUTH_ROLE_MAP`). Bind the application to those groups if only they may sign in.
2. Reverse proxy, in front of the app's URL: forward-auth to the outpost, copy the `X-Authentik-*` response headers
   to the upstream request, **remove** any `X-Authentik-*` and `x-auth-proxy-secret` header a client sent, and add
   the shared secret. Caddy:

```
app.example.com {
    route {
        reverse_proxy /outpost.goauthentik.io/* <outpost>:9000
        forward_auth <outpost>:9000 {
            uri /outpost.goauthentik.io/auth/caddy
            copy_headers X-Authentik-Username X-Authentik-Uid X-Authentik-Email X-Authentik-Name X-Authentik-Groups
        }
        reverse_proxy <app>:<port> {
            header_up x-auth-proxy-secret {env.AUTH_PROXY_SECRET}
        }
    }
}
```

3. The API's environment: `AUTH_PROXY_SECRET` (the same value, >= 16 random characters — `openssl rand -base64 32`)
   and/or `AUTH_TRUSTED_PROXIES` (the proxy's address or CIDR as the API sees the TCP peer). When both are set both
   must hold. Behind the fullstack UI the peer of the API is the UI server, so use the secret there — the UI forwards
   the proxy's headers unchanged. Never set `AUTH_DEV_MODE` on a deployed instance.
4. Check: `curl -H 'X-Authentik-Username: admin' https://<app>/api/v1/me` from outside must answer 401.
