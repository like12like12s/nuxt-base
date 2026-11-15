import { expect, test } from '@playwright/test'

// Against the BUILT app: what a crawler gets (it does not run JavaScript) and what a person gets.
// The e2e server runs without NUXT_PUBLIC_SITE_URL, i.e. like an instance somebody forgot to configure: the preview
// has its title and description, and nothing that depends on the origin — the request's host is never believed.
const head = (html: string) => /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? ''
const content = (html: string, key: string) => new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(head(html))?.[1]

for (const userAgent of ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'Twitterbot/1.0', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)']) {
  test(`crawler ${userAgent.split(/[ /]/)[0]}: title, description, og:* and twitter:*`, async ({ request }) => {
    const home = await (await request.get('/', { headers: { 'user-agent': userAgent } })).text()
    expect(content(home, 'og:title')).toBe({{kit.titleJson}})
    expect(content(home, 'og:description')).toBe({{kit.descriptionJson}})
    expect(content(home, 'twitter:card')).toBe('summary')
    expect(head(home).match(/<title>/g)).toHaveLength(1)

    const page = await (await request.get('/order-history/2026?ref=share', { headers: { 'user-agent': userAgent } })).text()
    expect(content(page, 'og:title')).toBe({{kit.titleJson}}) // an unlisted URL: the site preview, never a title made from the path
    expect(content(page, 'twitter:title')).toBe(content(page, 'og:title'))
    expect(page).toContain('<div id="__nuxt">') // still the app shell
  })
}

test('a crawler-visible page cannot be pointed at another site through the request', async ({ request, baseURL }) => {
  const crawler = { 'user-agent': 'Twitterbot/1.0' }
  for (const [path, headers] of [
    ['/', { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }],
    ['//evil.example/x', {}],
    ['/your-account-is-suspended', { 'x-forwarded-host': 'evil.example' }],
  ] as [string, Record<string, string>][]) {
    // an absolute URL: the client must send the path as it is (`//host/x` alone would be resolved to that host here)
    const html = await (await request.get(`${baseURL}${path}`, { headers: { ...crawler, ...headers } })).text()
    expect(head(html), path).not.toContain('evil.example')
    expect(head(html), path).not.toMatch(/suspended/i)
    expect(content(html, 'og:url'), path).toBeUndefined() // no configured site URL -> no URL is claimed
    expect(content(html, 'og:title'), path).toBe({{kit.titleJson}})
  }
})

test('a browser gets the plain shell (and a cache is told the HTML varies by user agent)', async ({ request }) => {
  const res = await request.get('/order-history/2026', { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' } })
  const html = await res.text()
  expect(content(html, 'og:title')).toBeUndefined()
  expect(html).toContain('<div id="__nuxt">')
  expect(res.headers()['vary'] ?? '').toContain('User-Agent')
})
