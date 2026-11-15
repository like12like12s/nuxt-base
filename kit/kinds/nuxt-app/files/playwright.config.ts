import { defineConfig } from '@playwright/test'

// Runs against the BUILT app (npm run test:e2e builds first) — the same artefact a deploy ships.
// The port is this project's own (its UI port {{kit.uiPort}} + 10000 — no two projects share it); E2E_PORT overrides it.
const port = Number(process.env.E2E_PORT) || {{kit.e2ePort}}
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: { testIdAttribute: 'data-test', baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 800 } },
  webServer: {
    command: 'npm run serve',
    env: { PORT: String(port), HOST: '127.0.0.1', NITRO_PORT: String(port), NITRO_HOST: '127.0.0.1' },
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
