// {{kit.title}} — Nuxt 4 SPA on the nuxt-base layer (the layer sets ssr: false, Tailwind 4, tokens, head defaults).
// Do not add @nuxtjs/tailwindcss or a second tailwindcss() plugin. Bump the layer = change the tag below.
export default defineNuxtConfig({
  extends: ['{{kit.layerRef}}'],
  devServer: { host: '0.0.0.0', port: {{kit.port}} },
{{kit.nuxtConfig}}})
