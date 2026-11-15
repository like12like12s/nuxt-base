import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: {
    include: ['tests/unit/**/*.spec.ts'],
    environment: 'nuxt',
    environmentOptions: { nuxt: { rootDir: 'playground', domEnvironment: 'happy-dom' } },
  },
})
