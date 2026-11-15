import { describe, expect, it } from 'vitest'
import { applyOg, isBot, ogTags } from '../../server/kit/og'
import { DESCRIPTION, SITE, resolveOg } from '../../server/og'

const request = (href: string) => {
  const url = new URL(href, 'https://app.example.com')
  return { path: url.pathname, query: url.searchParams, url }
}

describe('link previews', () => {
  it('the home page has the site title and description', async () => {
    expect(await resolveOg(request('/'))).toMatchObject({ title: SITE, description: DESCRIPTION })
  })

  it('other pages get a title of their own', async () => {
    const meta = await resolveOg(request('/order-history/2026'))
    expect(meta?.title).toBe(`Order History / 2026 · ${SITE}`)
  })

  it('the tags a crawler reads carry the page URL, escaped values, and replace the generic ones', async () => {
    const page = request('/order-history/2026?utm_source=x')
    const html = applyOg(['<title>Generic</title><meta property="og:title" content="Generic">'], (await resolveOg(page))!, page.url).join('\n')
    expect(html).not.toContain('Generic')
    expect(html).toContain('<meta property="og:url" content="https://app.example.com/order-history/2026">')
    expect(ogTags({ title: 'A <b> & "c"' }, page.url)).toContain('<title>A &lt;b&gt; &amp; &quot;c&quot;</title>')
  })

  it('crawlers are recognised, browsers are not', () => {
    for (const ua of ['facebookexternalhit/1.1', 'Twitterbot/1.0', 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Slackbot-LinkExpanding 1.0', 'WhatsApp/2.23', 'Linespider/1.1']) expect(isBot(ua), ua).toBe(true)
    for (const ua of ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36', '', undefined]) expect(isBot(ua), String(ua)).toBe(false)
  })
})
