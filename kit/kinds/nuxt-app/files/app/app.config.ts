// The UI speaks ONE language (`scaffold new --lang th|en`): `lang` drives the layer's own words — loading, empty,
// error, retry, confirm / cancel, the error page — and the generated pages were written in the same language.
export default defineAppConfig({
  // @kit:if auth
  nuxtBase: {
    // @kit:if lang:en
    lang: 'en',
    site: { name: {{kit.titleJson}}, description: {{kit.descriptionJson}}, locale: 'en_US' },
    // @kit:else
    site: { name: {{kit.titleJson}}, description: {{kit.descriptionJson}} },
    // @kit:end
    // Who is signed in comes from the API (GET /api/v1/me); `{rd}` = the page to come back to after signing in.
    auth: { enabled: true, meEndpoint: '/api/v1/me', loginUrl: '/outpost.goauthentik.io/start?rd={rd}' },
  },
  // @kit:else
  // @kit:if lang:en
  nuxtBase: { lang: 'en', site: { name: {{kit.titleJson}}, description: {{kit.descriptionJson}}, locale: 'en_US' } },
  // @kit:else
  nuxtBase: { site: { name: {{kit.titleJson}}, description: {{kit.descriptionJson}} } },
  // @kit:end
  // @kit:end
})
