// Title + OG/Twitter defaults for a page. SPA mode does not render app.head into the initial HTML, so call this
// in app.vue (site-wide) and in pages that need their own title/description (skill nuxt-spa-head).
export function useSiteHead(opts: { title?: string; description?: string; image?: string; url?: string; noIndex?: boolean } = {}) {
  const site = useAppConfig().nuxtBase.site
  const title = opts.title ? `${opts.title} — ${site.name}` : site.name
  const description = opts.description ?? site.description
  const image = opts.image ?? site.ogImage
  useHead({ title })
  useSeoMeta({
    title,
    description,
    ogTitle: title,
    ogDescription: description,
    ogSiteName: site.name,
    ogType: 'website',
    ogLocale: site.locale,
    ogImage: image || undefined,
    ogUrl: opts.url,
    twitterCard: image ? site.twitterCard : 'summary',
    twitterTitle: title,
    twitterDescription: description,
    twitterImage: image || undefined,
    robots: opts.noIndex ? 'noindex, nofollow' : undefined,
  })
}
