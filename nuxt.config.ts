// nuxt-base — Nuxt 4 base layer. Consumers: `extends: ['github:like12like12s/nuxt-base#v0.1.0']`.
// Relative paths in a layer config resolve against the CONSUMER project, so everything here is absolute (currentDir).
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import tailwindcss from '@tailwindcss/vite'

const currentDir = dirname(fileURLToPath(import.meta.url))

export default defineNuxtConfig({
  // Internal apps are SPAs behind Caddy + Authentik; `nuxt generate` for static hosts (CF Pages). Override per app if SSR is needed.
  ssr: false,
  devtools: { enabled: false },
  compatibilityDate: '2026-11-15',

  // Tailwind 4 via the Vite plugin — do NOT add @nuxtjs/tailwindcss or a second tailwindcss() plugin in the consumer.
  vite: { plugins: [tailwindcss()] },
  css: [join(currentDir, 'app/assets/css/base.css')],

  app: {
    head: {
      htmlAttrs: { lang: 'th', class: 'dark' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'theme-color', content: '#09090b' }, // zinc-950 — matches --color-bg
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },

  runtimeConfig: {
    public: {
      // API base for the app's own backend. '' = same origin (prod behind Caddy / API serving the SPA); set NUXT_PUBLIC_API_BASE in dev.
      apiBase: '',
    },
  },

  typescript: { strict: true },
})
