// Link-preview meta per URL of {{kit.name}}. Crawlers get these tags in the HTML (they do not run the app);
// people get the normal shell and the app sets its own head with useSiteHead().
//   - return an OgMeta for a URL, or null to leave the shell untouched
//   - it may be async: ask the API for the record a URL is about (keep it fast — it is abandoned after 3 s)
//   - `image` may be a path on this site (/og/default.png) or an absolute URL
import type { OgMeta, OgResolver } from './kit/og'

export const SITE = {{kit.titleJson}}
export const DESCRIPTION = {{kit.descriptionJson}}

/** Pages with their own preview. */
const PAGES: Record<string, OgMeta> = {
  '/': { title: SITE, description: DESCRIPTION },
}

// `/order-history/2026` -> `Order History / 2026`
const titleOf = (path: string): string =>
  path
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part).split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' '))
    .join(' / ')

export const resolveOg: OgResolver = ({ path }) => {
  const page = PAGES[path]
  if (page) return { siteName: SITE, ...page }
  // A record page would look its title up here, e.g.:
  //   const m = /^\/items\/([\w-]+)$/.exec(path)
  //   if (m) { const item = await fetchItem(m[1]); return item ? { title: item.name, description: item.description ?? DESCRIPTION, siteName: SITE } : null }
  return { title: `${titleOf(path)} · ${SITE}`, description: DESCRIPTION, siteName: SITE }
}
