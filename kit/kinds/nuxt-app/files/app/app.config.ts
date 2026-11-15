export default defineAppConfig({
  // @kit:if auth
  nuxtBase: {
    site: { name: {{kit.titleJson}}, description: {{kit.descriptionJson}} },
    // Who is signed in comes from the API (GET /api/v1/me); `{rd}` = the page to come back to after signing in.
    auth: { enabled: true, meEndpoint: '/api/v1/me', loginUrl: '/outpost.goauthentik.io/start?rd={rd}' },
  },
  // @kit:else
  nuxtBase: { site: { name: {{kit.titleJson}}, description: {{kit.descriptionJson}} } },
  // @kit:end
})
