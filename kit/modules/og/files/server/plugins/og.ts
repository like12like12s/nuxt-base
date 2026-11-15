// Rewrites the <head> of the HTML shell for crawlers (see server/og.ts for what each URL says).
// NUXT_PUBLIC_SITE_URL is the public origin used in og:url / canonical / og:image — set it on every deployed
// instance. Without it those tags are left out: the request's Host header is client-controlled and is believed only
// in development (`trustHost`).
import { ogPlugin } from '../kit/og'
import { resolveOg } from '../og'

export default defineNitroPlugin((nitro) => {
  const siteUrl = String(useRuntimeConfig().public.siteUrl || '')
  ogPlugin(resolveOg, { siteUrl: siteUrl || undefined, trustHost: import.meta.dev })(nitro)
})
