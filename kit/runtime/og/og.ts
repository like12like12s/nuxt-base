// DO NOT EDIT — locked file from the nuxt-base kit (runtime/og/og.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Per-URL Open Graph / Twitter meta for link previews. The app is a SPA: its HTML shell is the same for every URL and
// crawlers do not run JavaScript, so a shared link would always show the generic title. This rewrites the shell's
// <head> on the server — for crawlers only (by user agent), so people get the unchanged, cacheable shell.
// It hooks into the server's HTML renderer (Nitro `render:html`), which is the same code on the Node server
// (container, pm2) and on Cloudflare Pages (the Pages worker) — no platform-specific function to keep in sync.
// Dependency-free on purpose: it runs in a worker and is copied as is.
//
// Where the absolute URLs come from: og:url, canonical and a site-relative og:image need the public origin, and the
// only origin that can be believed is the configured one (`siteUrl`, NUXT_PUBLIC_SITE_URL). The request's Host /
// X-Forwarded-Host are whatever the client sent — a crawler-visible page built from them can be pointed at another
// site, and a shared cache would keep it. So without `siteUrl` those tags are left out (the preview still has its
// title and description), unless `trustHost` says the Host header is safe here (local development). The path is
// never allowed to change the origin either (`//host/x`, `/\host/x`, an absolute-form request line).

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
  /** The full requested URL as the outside world sees it — its origin is a placeholder when `originTrusted` is false. */
  url: URL
  /** false = no configured site URL: do not build absolute links from `url.origin`. */
  originTrusted?: boolean
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

const isAbsolute = (value: string): boolean => /^https?:\/\//i.test(value.trim())

/**
 * The tags for a page, every value HTML-escaped (titles come from data — a title must never become markup).
 * `originTrusted = false`: the origin of `url` is not known to be this site's, so nothing is built from it — og:url
 * and canonical are left out, and so is an image given as a path (an absolute http(s) URL from the resolver is kept).
 */
export function ogTags(meta: OgMeta, url: URL, originTrusted = true): string {
  const from = (value: string | undefined, fallback?: string): string => {
    if (originTrusted) return absolute(value ?? fallback ?? '', url.origin)
    return value && isAbsolute(value) ? absolute(value, url.origin) : ''
  }
  const pageUrl = from(meta.url, url.pathname)
  const image = meta.image ? from(meta.image) : ''
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
export function applyOg(head: readonly string[], meta: OgMeta, url: URL, originTrusted = true): string[] {
  return [...head.map(stripOgTags), ogTags(meta, url, originTrusted)]
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

const UNKNOWN_ORIGIN = 'http://localhost'

/** Path + query of the request as a path on THIS site: nothing in it may select another host. */
function sitePath(raw: string): string {
  let path = raw
  // absolute-form request line (`GET http://other/x`): keep only what follows the authority
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(path)
  if (scheme) path = path.slice(scheme[0].length)
  // `//host/x` and `/\host/x` are network-path references for a URL parser: collapse to one leading slash
  return `/${path.replace(/^[/\\]+/, '')}`
}

export interface RequestOrigin {
  url: URL
  /** true when the origin is the configured site URL (or the Host header was explicitly trusted). */
  trusted: boolean
}

/**
 * The URL the client asked for. With `siteUrl` the origin is that and nothing else. Without it the origin is unknown
 * (`trusted: false`, placeholder origin) — unless `trustHost`, which believes the Host header (never
 * X-Forwarded-Host; local development only).
 */
export function resolveRequest(event: EventLike, options: { siteUrl?: string; trustHost?: boolean } = {}): RequestOrigin {
  const path = sitePath(event.path ?? event.node?.req?.url ?? '/')
  const on = (origin: string): URL | null => {
    try {
      const base = new URL(origin)
      const url = new URL(path, base)
      return url.origin === base.origin ? url : new URL('/', base)
    } catch {
      return null
    }
  }
  if (options.siteUrl) {
    const url = on(options.siteUrl)
    if (url && ['http:', 'https:'].includes(url.protocol)) return { url, trusted: true }
  } else if (options.trustHost) {
    const host = headerOf(event, 'host')
    const proto = (headerOf(event, 'x-forwarded-proto') ?? 'http').split(',')[0]!.trim()
    const url = host ? on(`${proto === 'https' ? 'https' : 'http'}://${host}`) : null
    if (url) return { url, trusted: true }
  }
  return { url: on(UNKNOWN_ORIGIN)!, trusted: false }
}

/** The requested URL (see resolveRequest; this form believes the Host header when no site URL is given). */
export const requestUrl = (event: EventLike, siteUrl?: string): URL => resolveRequest(event, { siteUrl, trustHost: true }).url

export interface OgPluginOptions {
  /**
   * Fixed public origin (https://app.example.com) — set it on every deployed instance. Without it the previews carry
   * no og:url / canonical / site-relative image, because the request's host cannot be believed.
   */
  siteUrl?: string
  /** Believe the Host header when `siteUrl` is not set. For local development only (`import.meta.dev`). */
  trustHost?: boolean
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
  node?: EventLike['node'] & { res?: { setHeader?(name: string, value: string): unknown; getHeader?(name: string): unknown } }
}

/** Add `User-Agent` to the Vary header without dropping what is already there (`Accept-Encoding`, `Origin`, …). */
function varyByUserAgent(event: ResponseEvent): void {
  const res = event.node?.res
  if (!res?.setHeader) return
  const current = res.getHeader?.('vary')
  const have = (Array.isArray(current) ? current.join(', ') : typeof current === 'string' ? current : '').split(',').map((part) => part.trim()).filter(Boolean)
  if (have.includes('*') || have.some((part) => part.toLowerCase() === 'user-agent')) return
  res.setHeader('vary', [...have, 'User-Agent'].join(', '))
}

/** `export default defineNitroPlugin(ogPlugin(resolveOg))` — see server/plugins/og.ts. */
export function ogPlugin(resolve: OgResolver, options: OgPluginOptions = {}) {
  const { timeoutMs = 3000, onError = (error) => console.warn('[og] resolver failed:', error instanceof Error ? error.message : error) } = options
  return (nitro: NitroLike): void => {
    nitro.hooks.hook('render:html', async (html, { event }) => {
      // The HTML now depends on who asks: a cache in front must not hand one audience's shell to the other.
      if (!options.always) varyByUserAgent(event as ResponseEvent)
      if (!options.always && !isBot(headerOf(event, 'user-agent'))) return
      try {
        const { url, trusted } = resolveRequest(event, options)
        let timer: ReturnType<typeof setTimeout> | undefined
        const meta = await Promise.race([
          Promise.resolve(resolve({ path: url.pathname, query: url.searchParams, url, originTrusted: trusted })),
          new Promise<null>((done) => {
            timer = setTimeout(() => done(null), timeoutMs)
          }),
        ]).finally(() => clearTimeout(timer))
        if (meta?.title) html.head = applyOg(html.head, meta, url, trusted)
      } catch (error) {
        // A preview is never worth a failed page: the crawler gets the generic shell.
        onError(error)
      }
    })
  }
}
