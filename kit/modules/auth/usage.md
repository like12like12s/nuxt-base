## Auth (`{{kit.apiDir}}`, module `auth`)

Three ways a request gets an identity — everything else is anonymous:

```
dev user          AUTH_DEV_MODE=1: every request is `dev` with every role. Local only — the API refuses to start
                  with it when NODE_ENV=production.
service token     Authorization: Bearer kit_...   (machines: jobs, other services)
forward-auth      identity headers added by the forward-auth proxy after the identity provider signed the user in
```

- Routes say who may call them, in `createRoute`: `middleware: [requireAuth()] as const`, `requireRole('admin', 'editor')`
  or `publicRoute()` (`src/kit/auth/guard.ts`). A route without one is refused at run time (500, logged) and fails
  `tests/auth.spec.ts`, which also holds the role x endpoint matrix — add every new route to it.
- Roles are the app's own (`src/auth/roles.ts`). `AUTH_ROLE_MAP` maps identity-provider groups onto them:
  `AUTH_ROLE_MAP={"app-admins":["admin"],"app-editors":["editor"]}`. A group that is not mapped grants nothing.
  Signed-in users are mirrored into `users` (written and audited only when something changed); the audit actor of
  every write is the caller's subject.
- `GET /api/v1/me` returns the caller (`subject`, `name`, `email`, `roles`, `kind`), 401 when nobody is signed in.
- Service tokens (`service_tokens`: sha256 only, roles, expiry, `revokedAt`, `lastUsedAt`). A token created without
  `--roles` is authenticated and holds no role: it may call every `requireAuth()` route (reads) and no
  `requireRole()` route — the token for a machine that only reads:

```bash
npm run auth:token -- create --name nightly-sync --roles editor --days 90   # prints the token ONCE
npm run auth:token -- create --name og-preview --days 365                   # no --roles: authenticated, read-only
npm run auth:token -- list
npm run auth:token -- revoke nightly-sync                                   # by name or id; effective at once
node dist/auth/cli.js token list                                            # in a built image
```

### What the operator sets up (nothing here creates or changes it)

"The forward-auth proxy" = the reverse proxy in front of the app that asks the identity provider before it forwards
a request, and then adds the signed-in user as request headers. Those headers can be typed by anyone who reaches the
app directly, so they are believed **only** when the request provably came through that proxy. Until the settings
below are in place the API ignores them (service tokens keep working) and logs `forward-auth headers ignored`.

**1. Which headers the proxy sets** — `AUTH_HEADER_PRESET` (the same value wherever it is asked for):

```
authentik (default)   X-Authentik-Username   X-Authentik-Uid   X-Authentik-Email   X-Authentik-Name   X-Authentik-Groups
remote                Remote-User            (none)            Remote-Email        Remote-Name        Remote-Groups
```

Without a uid header the user name is the stable subject. One identity per request: a user name, uid or email that
arrives twice — or with a comma in it, which is what a repeated header is joined into — is refused (the request is
anonymous, 401, logged as `ambiguous-identity`), never read as one subject. A user name that itself contains a comma
is therefore not supported; display name and groups may. A single name that differs: `AUTH_HEADER_USERNAME`,
`AUTH_HEADER_UID`, `AUTH_HEADER_EMAIL`, `AUTH_HEADER_NAME`, `AUTH_HEADER_GROUPS`. Groups are separated by `|`
(`AUTH_HEADER_GROUPS_SEPARATOR=,` for a proxy that sends a comma list). An unknown preset or an unusable name stops
the boot.

**2. How the app knows a request came through the proxy**

<!-- @kit:if kind:fullstack -->
The proxy talks to the UI server, and the UI server is the only caller of the API. Its `/api` proxy carries the
**auth bridge** (`{{kit.uiDir}}/server/kit/auth-bridge.ts`): for every request it removes whatever the client sent
under an identity header name or as `x-auth-proxy-secret`, and only when the request's TCP peer is the forward-auth
proxy does it pass the proxy's identity headers on and add the secret the API checks. The proxy itself needs no
special configuration beyond forward-auth with the header preset above.

A request whose identity headers are ambiguous (sent twice, or a
user name with a comma) gets neither identity nor secret. A header that means something else on every request
(`Authorization`, `Cookie`, `X-Forwarded-For`, …) cannot be named as an identity header: the bridge then stays off
and says so, as the API refuses to boot.

```
AUTH_PROXY_SECRET             UI + API   the same value, >= 16 random characters (`openssl rand -base64 32`)
AUTH_BRIDGE_TRUSTED_PROXIES   UI         address / CIDR of the forward-auth proxy as the UI server sees the TCP peer
AUTH_HEADER_PRESET            UI + API   see 1.
```

Both of the first two are required: with either missing the bridge passes nothing on (it says so at boot) and every
request reaches the API anonymous or with its own `Authorization: Bearer` token. Leave `AUTH_TRUSTED_PROXIES` of the
API empty — its peer is the UI server; the secret is what it checks. With the container preset all three live in
the one `.env` next to the compose file, which hands them to both services.
<!-- @kit:else -->
The proxy forwards straight to the API. One of these two, or both (then both must hold):

```
AUTH_TRUSTED_PROXIES   the proxy's address or CIDR as the API sees the TCP peer — enough when nothing else can
                       connect from that address
AUTH_PROXY_SECRET      a shared secret (>= 16 random characters, `openssl rand -base64 32`) the proxy adds to every
                       forwarded request as `x-auth-proxy-secret`
```
<!-- @kit:end -->

**3. What the proxy must do** — whichever product it is:

- run forward-auth against the identity provider for the app's URL and copy the provider's identity headers (the
  preset of step 1) onto the request it forwards;
- **remove** those header names (and `x-auth-proxy-secret`) from what the client sent, before anything else looks at
  the request — a forward-auth integration that only *adds* headers lets a client's own copy through on paths the
  provider does not answer for;
<!-- @kit:if kind:fullstack -->
- nothing else: it does not need to know the secret.
<!-- @kit:else -->
- when `AUTH_PROXY_SECRET` is used: add it as `x-auth-proxy-secret` on the forwarded request.
<!-- @kit:end -->

If your proxy is configured through a management tool, set the app's route to "forward-auth / single sign-on" there
and pick the matching header preset here — do not hand-edit the generated proxy configuration. For a proxy you
configure by hand, the same thing as a Caddy site block (one example; nginx and Traefik have the same three steps):

```
app.example.com {
    route {
        # whatever a client sent under these names is dropped before anything else looks at the request
        request_header -X-Authentik-*
        request_header -x-auth-proxy-secret
        reverse_proxy /outpost.goauthentik.io/* <outpost>:9000
        forward_auth <outpost>:9000 {
            uri /outpost.goauthentik.io/auth/caddy
            copy_headers X-Authentik-Username X-Authentik-Uid X-Authentik-Email X-Authentik-Name X-Authentik-Groups
        }
        reverse_proxy <app>:<port>
    }
}
```

**4. Identity provider** ({{kit.authentikUrl}}): a provider in forward-auth mode for the app's external URL, an
application bound to it, the provider added to the outpost / gateway the proxy asks, and the groups the app maps
(`AUTH_ROLE_MAP`). Restrict the application to those groups if only they may sign in.

**5. Check from outside**, with the header names of your preset — both must answer 401:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Authentik-Username: admin' https://<app>/api/v1/me
curl -s -o /dev/null -w '%{http_code}\n' -H 'Remote-User: admin' -H 'x-auth-proxy-secret: guess' https://<app>/api/v1/me
```

Never set `AUTH_DEV_MODE` on a deployed instance.
