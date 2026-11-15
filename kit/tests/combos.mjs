// What `npm run gate:kit` proves: every entry is scaffolded into a fresh temp dir, installed, gated and built.
// Tasks that add modules append entries here (e.g. { id: 'fullstack+db+auth', kind: 'fullstack', with: ['db', 'auth'] }).
//
//   id       unique label, shown in every failure line
//   kind     nuxt-app | api | fullstack
//   with     modules (--with)             db      --db value            deploy   --deploy value
//   e2e      also run the UI's playwright suite against the built app
//   layer    'local' (default) = the UI extends this working tree, so the layer and the kit are tested together
//            'tag'   = the UI extends the latest git tag from GitHub — required when the image is built by docker
//   checks   extra async (t) => {} steps; `t` is the helper object documented in kit-gate.mjs
export const combos = [
  { id: 'nuxt-app', kind: 'nuxt-app', e2e: true },
  { id: 'nuxt-app+cf-pages', kind: 'nuxt-app', deploy: 'cf-pages' },
  { id: 'nuxt-app+container', kind: 'nuxt-app', deploy: 'container', layer: 'tag' },
  { id: 'nuxt-app+pm2', kind: 'nuxt-app', deploy: 'pm2' },
  { id: 'api', kind: 'api', with: ['ci-github'] },
  { id: 'api+container', kind: 'api', deploy: 'container' },
  { id: 'api+pm2', kind: 'api', deploy: 'pm2' },
  { id: 'fullstack', kind: 'fullstack' },
  { id: 'fullstack+container', kind: 'fullstack', deploy: 'container', layer: 'tag' },
  { id: 'fullstack+pm2', kind: 'fullstack', deploy: 'pm2' },
]
