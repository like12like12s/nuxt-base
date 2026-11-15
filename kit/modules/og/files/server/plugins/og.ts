// Rewrites the <head> of the HTML shell for crawlers (see server/og.ts for what each URL says).
// NUXT_PUBLIC_SITE_URL pins the public origin used in og:url / og:image; without it the request's host is used.
import { ogPlugin } from '../kit/og'
import { resolveOg } from '../og'

export default defineNitroPlugin((nitro) => {
  const siteUrl = String(useRuntimeConfig().public.siteUrl || '')
  ogPlugin(resolveOg, { siteUrl: siteUrl || undefined })(nitro)
})
