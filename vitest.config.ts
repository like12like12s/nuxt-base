import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: {
    // kit/tests = the generator's own unit tests; they opt out of the nuxt environment per file (@vitest-environment node)
    include: ['tests/unit/**/*.spec.ts', 'kit/tests/**/*.spec.ts'],
    environment: 'nuxt',
    // The kit specs start real processes (the CLI, git, gitleaks, lock contenders): a slow CI runner must not turn that
    // into a timeout. No spec relies on the 5 s default (kit/tests/dogfood.spec.ts checks this value).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environmentOptions: { nuxt: { rootDir: 'playground', domEnvironment: 'happy-dom' } },
  },
})
