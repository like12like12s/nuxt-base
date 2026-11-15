## Deploy — Cloudflare Pages

```bash
npx wrangler whoami         # must be logged in
npm run cf:create           # once: creates the Pages project "{{kit.name}}"
npm run deploy              # gate -> build (dist/) -> wrangler pages deploy
npm run serve               # local preview of dist/ with wrangler
```

- `nitro.preset = 'cloudflare-pages'`: server routes run as Pages Functions — `fetch()` only, no Node built-ins
  (`net`, `tls`, `fs`, `child_process`), no LAN-only backends.
- Custom domain: add it to the Pages project in the Cloudflare dashboard.
