import { expect, test } from '@playwright/test'

// Against the BUILT app: what a crawler gets (it does not run JavaScript) and what a person gets.
const head = (html: string) => /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? ''
const content = (html: string, key: string) => new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(head(html))?.[1]

for (const userAgent of ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'Twitterbot/1.0', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)']) {
  test(`crawler ${userAgent.split(/[ /]/)[0]}: per-URL title, description, og:* and twitter:*`, async ({ request, baseURL }) => {
    const home = await (await request.get('/', { headers: { 'user-agent': userAgent } })).text()
    expect(content(home, 'og:title')).toBe({{kit.titleJson}})
    expect(content(home, 'og:url')).toBe(`${baseURL}/`)
    expect(content(home, 'twitter:card')).toBe('summary')
    expect(head(home).match(/<title>/g)).toHaveLength(1)

    const page = await (await request.get('/order-history/2026?ref=share', { headers: { 'user-agent': userAgent } })).text()
    expect(content(page, 'og:title')).toBe(`Order History / 2026 · ${{{kit.titleJson}}}`)
    expect(content(page, 'twitter:title')).toBe(content(page, 'og:title'))
    expect(content(page, 'og:url')).toBe(`${baseURL}/order-history/2026`)
    expect(page).toContain('<div id="__nuxt">') // still the app shell
  })
}

test('a browser gets the plain shell (and a cache is told the HTML varies by user agent)', async ({ request }) => {
  const res = await request.get('/order-history/2026', { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' } })
  const html = await res.text()
  expect(content(html, 'og:title')).toBeUndefined()
  expect(html).toContain('<div id="__nuxt">')
  expect(res.headers()['vary'] ?? '').toContain('User-Agent')
})
