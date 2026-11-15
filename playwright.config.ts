import { defineConfig } from '@playwright/test'

// Runs against the BUILT playground (npm run build first) — same artefact a real deploy ships.
const port = Number(process.env.NB_E2E_PORT) || 3518
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: { testIdAttribute: 'data-test', baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 800 } },
  webServer: {
    command: `node playground/.output/server/index.mjs`,
    env: { PORT: String(port), HOST: '127.0.0.1', NITRO_PORT: String(port), NITRO_HOST: '127.0.0.1' },
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
