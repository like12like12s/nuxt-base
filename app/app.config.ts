// Layer-wide defaults. Consumers override any key in their own app.config.ts (deep-merged).
export default defineAppConfig({
  nuxtBase: {
    site: {
      name: 'App',
      description: '',
      // Absolute URL of the default OG image; '' = none
      ogImage: '',
      locale: 'th_TH',
      twitterCard: 'summary_large_image' as 'summary' | 'summary_large_image',
    },
    auth: {
      // Hook point for SSO (Authentik forward-auth via Caddy). enabled=false → useAuth() reports an anonymous, ready state.
      enabled: false,
      // Endpoint returning the current user ({ id, name, email?, groups? }) or 401/204. Default = the layer's Nitro route that reads X-Authentik-* headers.
      meEndpoint: '/api/_me',
      // Where to send unauthenticated users (Authentik outpost start URL). '' = just show the anonymous state.
      loginUrl: '',
    },
  },
})

declare module 'nuxt/schema' {
  interface AppConfigInput {
    nuxtBase?: {
      site?: { name?: string; description?: string; ogImage?: string; locale?: string; twitterCard?: 'summary' | 'summary_large_image' }
      auth?: { enabled?: boolean; meEndpoint?: string; loginUrl?: string }
    }
  }
}
