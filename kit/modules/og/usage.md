## Link previews (`{{kit.uiDir}}`, module `og`)

- The app is a SPA: one HTML shell for every URL, and crawlers (Facebook, LINE, Slack, X, search engines) do not run
  JavaScript. `server/plugins/og.ts` rewrites the shell's `<head>` for them — title, description, `og:*`, `twitter:*`,
  canonical — per URL. People get the unchanged shell (`Vary: User-Agent` keeps a cache from mixing the two).
- What each URL says: `server/og.ts` (`resolveOg`). Return `{ title, description?, image?, url? }` or `null` to leave
  the shell alone. It may be async — ask the API for the record a URL is about; it is abandoned after 3 s, and an error
  never breaks the page (the crawler gets the generic shell).
- `NUXT_PUBLIC_SITE_URL` pins the public origin for `og:url` / `og:image`; without it the request's host (and
  `x-forwarded-proto` / `x-forwarded-host`) is used.
- It runs in the server's HTML renderer, so it is the same on the Node server (container, pm2) and on Cloudflare
  Pages (the Pages worker).
- Check a URL: `curl -A 'facebookexternalhit/1.1' https://<site>/<path> | grep og:` · tests: `tests/unit/og.spec.ts`
  (resolver + tags) and `tests/e2e/og.spec.ts` (the built app, with crawler user agents).
