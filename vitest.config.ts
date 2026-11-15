import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: {
    // kit/tests = the generator's own unit tests; they opt out of the nuxt environment per file (@vitest-environment node)
    include: ['tests/unit/**/*.spec.ts', 'kit/tests/**/*.spec.ts'],
    environment: 'nuxt',
    environmentOptions: { nuxt: { rootDir: 'playground', domEnvironment: 'happy-dom' } },
  },
})
