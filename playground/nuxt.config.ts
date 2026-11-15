// Fixture app: extends the layer by relative path (CI/local). Real apps use 'github:like12like12s/nuxt-base#vX.Y.Z'.
export default defineNuxtConfig({
  extends: ['..'],
  devServer: { host: '0.0.0.0', port: 3517 },
})
