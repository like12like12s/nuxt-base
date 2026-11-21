import { defineConfig } from '@playwright/test'
// The bare import is load-bearing: it runs at import time — before the config object below is built — and sets
// HEAVY_RUN_WORKERS / HEAVY_RUN_JSON (tier caps + the queue's JSON report path). The string globalSetup (Playwright
// >= 1.45 requires a path, whose default export is the setup) then takes the slot; release rides process exit.
import { heavyRunReporters } from './scripts/lib/heavy-run-global-setup.mjs'

// Runs against the BUILT playground (npm run build first) — same artefact a real deploy ships.
// The whole run holds a slot in the host-wide heavy-run queue (globalSetup, t1441): a bare `npx playwright test`
// queues too, smoke greps take a light slot, and off the queue host (no heavy-run on PATH) it is a no-op.
const port = Number(process.env.NB_E2E_PORT) || 3518
export default defineConfig({
  globalSetup: './scripts/lib/heavy-run-global-setup.mjs',
  reporter: [...heavyRunReporters(), ['list']], // reporter SINGULAR — a plural key is silently ignored
  workers: Number(process.env.HEAVY_RUN_WORKERS) || undefined,
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: 0,
  use: { testIdAttribute: 'data-test', baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 800 } },
  webServer: {
    command: `node playground/.output/server/index.mjs`,
    env: { PORT: String(port), HOST: '127.0.0.1', NITRO_PORT: String(port), NITRO_HOST: '127.0.0.1' },
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
