// DO NOT EDIT — locked file from the nuxt-base kit (runtime/og/og.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Per-URL Open Graph / Twitter meta for link previews. The app is a SPA: its HTML shell is the same for every URL and
// crawlers do not run JavaScript, so a shared link would always show the generic title. This rewrites the shell's
// <head> on the server — for crawlers only (by user agent), so people get the unchanged, cacheable shell.
// It hooks into the server's HTML renderer (Nitro `render:html`), which is the same code on the Node server
// (container, pm2) and on Cloudflare Pages (the Pages worker) — no platform-specific function to keep in sync.
// Dependency-free on purpose: it runs in a worker and is copied as is.

export interface OgMeta {
  title: string
  description?: string
  /** Absolute, or a path on this site. */
  image?: string
  /** Canonical URL of the page; default: the requested URL without its query string. */
  url?: string
  /** og:type — default `website`. */
  type?: string
  siteName?: string
  /** Default: `summary_large_image` with an image, `summary` without. */
  twitterCard?: 'summary' | 'summary_large_image'
}

export interface OgRequest {
  /** Path without the query string, e.g. `/items/42`. */
  path: string
  query: URLSearchParams
  /** The full requested URL as the outside world sees it. */
  url: URL
}

/** Return the meta of a URL, or null / undefined to leave the shell as it is. May be async (e.g. ask the API). */
export type OgResolver = (request: OgRequest) => OgMeta | null | undefined | Promise<OgMeta | null | undefined>

// Link-preview fetchers and search crawlers. Generic words first (bot, crawler, spider, preview), then the ones that
// use none of them.
const BOT = /bot\b|bot\/|crawl|spider|slurp|preview|facebookexternalhit|facebot|whatsapp|telegram|linespider|line-poker|embedly|iframely|vkshare|pinterest|quora|skypeuripreview|mastodon|bluesky|google-inspectiontool|lighthouse/i

export const isBot = (userAgent: string | null | undefined): boolean => Boolean(userAgent && BOT.test(userAgent))

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!)

const absolute = (value: string, origin: string): string => {
  try {
    const url = new URL(value, origin)
    // Only http(s) may end up in a tag a crawler will fetch.
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''
  } catch {
    return ''
  }
}

/** The tags for a page, every value HTML-escaped (titles come from data — a title must never become markup). */
export function ogTags(meta: OgMeta, url: URL): string {
  const pageUrl = absolute(meta.url ?? url.pathname, url.origin)
  const image = meta.image ? absolute(meta.image, url.origin) : ''
  const card = meta.twitterCard ?? (image ? 'summary_large_image' : 'summary')
  const tag = (attr: 'property' | 'name', key: string, value: string | undefined) => (value ? `<meta ${attr}="${key}" content="${escapeHtml(value)}">` : '')
  return [
    `<title>${escapeHtml(meta.title)}</title>`,
    tag('name', 'description', meta.description),
    tag('property', 'og:type', meta.type ?? 'website'),
    tag('property', 'og:title', meta.title),
    tag('property', 'og:description', meta.description),
    tag('property', 'og:url', pageUrl),
    tag('property', 'og:image', image),
    tag('property', 'og:site_name', meta.siteName),
    tag('name', 'twitter:card', card),
    tag('name', 'twitter:title', meta.title),
    tag('name', 'twitter:description', meta.description),
    tag('name', 'twitter:image', image),
    pageUrl ? `<link rel="canonical" href="${escapeHtml(pageUrl)}">` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

const STALE = [
  /<title\b[^>]*>[\s\S]*?<\/title>/gi,
  /<meta\b[^>]*\b(?:property|name)\s*=\s*["']?(?:og:[\w:.-]+|twitter:[\w:.-]+|description)["']?[^>]*>/gi,
  /<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>/gi,
]
/** Remove the tags ogTags() replaces from a chunk of <head> HTML, so a crawler never sees two titles. */
export const stripOgTags = (head: string): string => STALE.reduce((html, pattern) => html.replace(pattern, ''), head)

/** The <head> chunks of the shell with this page's tags in place of the generic ones. */
export function applyOg(head: readonly string[], meta: OgMeta, url: URL): string[] {
  return [...head.map(stripOgTags), ogTags(meta, url)]
}

interface EventLike {
  path?: string
  headers?: { get(name: string): string | null }
  node?: { req?: { url?: string; headers?: Record<string, string | string[] | undefined> } }
}
const headerOf = (event: EventLike, name: string): string | undefined => {
  const value = event.headers?.get(name) ?? event.node?.req?.headers?.[name]
  return (Array.isArray(value) ? value[0] : value) ?? undefined
}

/** The URL the client asked for: host and scheme from the proxy headers when there are any. */
export function requestUrl(event: EventLike, siteUrl?: string): URL {
  const path = event.path ?? event.node?.req?.url ?? '/'
  if (siteUrl) return new URL(path, siteUrl)
  const host = headerOf(event, 'x-forwarded-host') ?? headerOf(event, 'host') ?? 'localhost'
  const proto = (headerOf(event, 'x-forwarded-proto') ?? 'http').split(',')[0]!.trim()
  try {
    return new URL(path, `${proto === 'https' ? 'https' : 'http'}://${host}`)
  } catch {
    return new URL(path, 'http://localhost')
  }
}

export interface OgPluginOptions {
  /** Fixed public origin (https://app.example.com). Default: taken from the request. */
  siteUrl?: string
  /** true = rewrite for every visitor, not only crawlers. */
  always?: boolean
  /** A resolver slower than this is abandoned and the shell goes out unchanged (default 3 000 ms). */
  timeoutMs?: number
  onError?: (error: unknown) => void
}

interface NitroLike {
  hooks: { hook(name: 'render:html', fn: (html: { head: string[] }, context: { event: EventLike }) => void | Promise<void>): unknown }
}

interface ResponseEvent extends EventLike {
  node?: EventLike['node'] & { res?: { setHeader?(name: string, value: string): unknown } }
}

/** `export default defineNitroPlugin(ogPlugin(resolveOg))` — see server/plugins/og.ts. */
export function ogPlugin(resolve: OgResolver, options: OgPluginOptions = {}) {
  const { timeoutMs = 3000, onError = (error) => console.warn('[og] resolver failed:', error instanceof Error ? error.message : error) } = options
  return (nitro: NitroLike): void => {
    nitro.hooks.hook('render:html', async (html, { event }) => {
      // The HTML now depends on who asks: a cache in front must not hand one audience's shell to the other.
      if (!options.always) (event as ResponseEvent).node?.res?.setHeader?.('vary', 'User-Agent')
      if (!options.always && !isBot(headerOf(event, 'user-agent'))) return
      try {
        const url = requestUrl(event, options.siteUrl)
        let timer: ReturnType<typeof setTimeout> | undefined
        const meta = await Promise.race([
          Promise.resolve(resolve({ path: url.pathname, query: url.searchParams, url })),
          new Promise<null>((done) => {
            timer = setTimeout(() => done(null), timeoutMs)
          }),
        ]).finally(() => clearTimeout(timer))
        if (meta?.title) html.head = applyOg(html.head, meta, url)
      } catch (error) {
        // A preview is never worth a failed page: the crawler gets the generic shell.
        onError(error)
      }
    })
  }
}
