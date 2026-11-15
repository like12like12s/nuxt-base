// Link-preview meta per URL of {{kit.name}}. Crawlers get these tags in the HTML (they do not run the app);
// people get the normal shell and the app sets its own head with useSiteHead().
//   - return an OgMeta for a URL, or null to leave the shell untouched
//   - it may be async: ask the API for the record a URL is about (keep it fast — it is abandoned after 3 s)
//   - `image` may be a path on this site (/og/default.png — needs NUXT_PUBLIC_SITE_URL) or an absolute URL
//   - only URLs listed here (or looked up) get a title of their own; every other URL gets the site's preview
import type { OgMeta, OgResolver } from './kit/og'

export const SITE = {{kit.titleJson}}
export const DESCRIPTION = {{kit.descriptionJson}}

/** Pages with their own preview. */
const PAGES: Record<string, OgMeta> = {
  '/': { title: SITE, description: DESCRIPTION },
}

export const resolveOg: OgResolver = ({ path }) => {
  const page = PAGES[path]
  if (page) return { siteName: SITE, ...page }
  // A record page would look its title up here, e.g.:
  //   const m = /^\/items\/([\w-]+)$/.exec(path)
  //   if (m) { const item = await fetchItem(m[1]); return item ? { title: item.name, description: item.description ?? DESCRIPTION, siteName: SITE } : null }
  // Any other URL gets the site's own preview. Never derive a title from the path: whoever shares a link chooses the
  // path, and `/your-account-is-suspended` would become a preview card that looks like it came from this site.
  return { title: SITE, description: DESCRIPTION, siteName: SITE }
}
