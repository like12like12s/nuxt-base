// Link-preview meta per URL of {{kit.name}}. Crawlers get these tags in the HTML (they do not run the app);
// people get the normal shell and the app sets its own head with useSiteHead().
//   - return an OgMeta for a URL, or null to leave the shell untouched
//   - it may be async: ask the API for the record a URL is about (keep it fast — it is abandoned after 3 s)
//   - `image` may be a path on this site (/og/default.png — needs NUXT_PUBLIC_SITE_URL) or an absolute URL
//   - only URLs listed here (or looked up) get a title of their own; every other URL gets the site's preview
import type { OgMeta, OgResolver } from './kit/og'
// @kit:if kind:fullstack
import { serverApi } from './utils/server-api'
// @kit:end

export const SITE = {{kit.titleJson}}
export const DESCRIPTION = {{kit.descriptionJson}}

/** Pages with their own preview. */
const PAGES: Record<string, OgMeta> = {
  '/': { title: SITE, description: DESCRIPTION },
}

// @kit:if kind:fullstack
/**
 * Record pages with a preview of their own: page prefix -> the API collection. `/orders/<id>` is previewed with the
 * name (and description, when it has one) of `GET /api/v1/orders/<id>`.
 * The lookup runs on the UI server through serverApi() (server/utils/server-api.ts) with the service token in
 * API_SERVICE_TOKEN — a crawler cannot sign in, and the API answers 401 to an anonymous caller. No token, no answer
 * or an unknown id = the site's generic preview, never an error.
 */
export const RECORDS: Record<string, string> = {
  // '/orders': '/api/v1/orders',
  // kit:anchor og-records — `scaffold add resource` lists its detail page above this line
}

type Lookup = (path: string) => Promise<unknown>

export async function recordPreview(path: string, records: Record<string, string> = RECORDS, lookup: Lookup = serverApi): Promise<OgMeta | null> {
  const match = /^(\/[a-z0-9-]+)\/([A-Za-z0-9_-]{1,64})$/.exec(path)
  const collection = match ? records[match[1]!] : undefined
  if (!match || !collection) return null
  const body = (await lookup(`${collection}/${encodeURIComponent(match[2]!)}`)) as { data?: { name?: unknown; description?: unknown } } | null
  const name = typeof body?.data?.name === 'string' ? body.data.name.trim() : ''
  if (!name) return null
  const description = typeof body?.data?.description === 'string' && body.data.description ? body.data.description : DESCRIPTION
  return { title: `${name} · ${SITE}`, description, siteName: SITE }
}

export const resolveOg: OgResolver = async ({ path }) => {
  const page = PAGES[path]
  if (page) return { siteName: SITE, ...page }
  const record = await recordPreview(path)
  if (record) return record
// @kit:else
export const resolveOg: OgResolver = ({ path }) => {
  const page = PAGES[path]
  if (page) return { siteName: SITE, ...page }
  // A record page would look its title up here (make the resolver async), e.g.:
  //   const m = /^\/orders\/([\w-]+)$/.exec(path)
  //   if (m) { const order = await fetchOrder(m[1]); return order ? { title: order.name, description: order.description ?? DESCRIPTION, siteName: SITE } : null }
  // If the backend asks who is calling, the server needs a credential of its own for that fetch (a read-only service
  // token from the environment): a crawler cannot sign in.
// @kit:end
  // Any other URL gets the site's own preview. Never derive a title from the path: whoever shares a link chooses the
  // path, and `/your-account-is-suspended` would become a preview card that looks like it came from this site.
  return { title: SITE, description: DESCRIPTION, siteName: SITE }
}
