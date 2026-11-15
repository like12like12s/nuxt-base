import { describe, expect, it } from 'vitest'
import { applyOg, isBot, ogTags, resolveRequest } from '../../server/kit/og'
import { DESCRIPTION, SITE, resolveOg } from '../../server/og'

const request = (href: string) => {
  const url = new URL(href, 'https://app.example.com')
  return { path: url.pathname, query: url.searchParams, url }
}

describe('link previews', () => {
  it('the home page has the site title and description', async () => {
    expect(await resolveOg(request('/'))).toMatchObject({ title: SITE, description: DESCRIPTION })
  })

  it('a URL nobody listed gets the site preview — its path never becomes a title', async () => {
    const meta = await resolveOg(request('/your-account-is-suspended/click-here'))
    expect(meta).toMatchObject({ title: SITE, description: DESCRIPTION })
    expect(JSON.stringify(meta)).not.toMatch(/suspended/i)
  })

  it('the tags a crawler reads carry the page URL, escaped values, and replace the generic ones', async () => {
    const page = request('/order-history/2026?utm_source=x')
    const html = applyOg(['<title>Generic</title><meta property="og:title" content="Generic">'], (await resolveOg(page))!, page.url).join('\n')
    expect(html).not.toContain('Generic')
    expect(html).toContain('<meta property="og:url" content="https://app.example.com/order-history/2026">')
    expect(ogTags({ title: 'A <b> & "c"' }, page.url)).toContain('<title>A &lt;b&gt; &amp; &quot;c&quot;</title>')
  })

  it('og:url and canonical only ever name the configured site', () => {
    const event = (path: string, headers: Record<string, string> = {}) => ({ path, headers: new Headers({ host: 'evil.example', 'x-forwarded-host': 'evil.example', ...headers }) })
    for (const path of ['//evil.example/x', '/\\evil.example/x', 'https://evil.example/x']) {
      const { url, trusted } = resolveRequest(event(path), { siteUrl: 'https://app.example.com' })
      expect(trusted).toBe(true)
      expect(url.origin, path).toBe('https://app.example.com')
      // whatever is left of the path is a path on this site — no tag points at the other host
      expect(ogTags({ title: 't', image: '/og.png' }, url), path).not.toMatch(/(?:content|href)="(?:https?:)?\/\/evil\.example/)
    }
    // no site URL configured: nothing is built from the request's host
    const unknown = resolveRequest(event('/p'))
    expect(unknown.trusted).toBe(false)
    expect(ogTags({ title: 't', image: '/og.png' }, unknown.url, unknown.trusted)).not.toMatch(/og:url|canonical|og:image|evil/)
  })

  it('crawlers are recognised, browsers are not', () => {
    for (const ua of ['facebookexternalhit/1.1', 'Twitterbot/1.0', 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Slackbot-LinkExpanding 1.0', 'WhatsApp/2.23', 'Linespider/1.1']) expect(isBot(ua), ua).toBe(true)
    for (const ua of ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36', '', undefined]) expect(isBot(ua), String(ua)).toBe(false)
  })
})
