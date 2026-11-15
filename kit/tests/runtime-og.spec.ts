// @vitest-environment node
// The locked link-preview runtime (kit/runtime/og/og.ts) at the source, including the Nitro hook driven by hand.
import { describe, expect, it, vi } from 'vitest'
import { applyOg, escapeHtml, isBot, ogPlugin, ogTags, requestUrl, stripOgTags, type OgResolver } from '../runtime/og/og'

const url = (href: string) => new URL(href, 'https://app.example.com')

describe('isBot', () => {
  it.each([
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'Facebot', 'Twitterbot/1.0', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'LinkedInBot/1.0 (compatible; Mozilla/5.0)', 'WhatsApp/2.23.20 A', 'TelegramBot (like TwitterBot)',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'Mozilla/5.0 (compatible; Linespider/1.1)',
    'facebookexternalhit/1.1;line-poker/1.0', 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1)', 'Pinterest/0.2 (+http://www.pinterest.com/)',
    'Iframely/1.3.1', 'Mozilla/5.0 (compatible; YandexBot/3.0)', 'Baiduspider', 'Google-InspectionTool/1.0',
  ])('crawler: %s', (ua) => expect(isBot(ua)).toBe(true))

  it.each([
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36 Line/14.9.0',
    'curl/8.5.0', '',
  ])('not a crawler: %s', (ua) => expect(isBot(ua)).toBe(false))

  it('no user agent is not a crawler', () => {
    expect(isBot(undefined)).toBe(false)
    expect(isBot(null)).toBe(false)
  })
})

describe('ogTags', () => {
  it('writes title, description, og:*, twitter:* and canonical with absolute URLs', () => {
    const tags = ogTags({ title: 'Widget', description: 'A thing', image: '/og/widget.png', siteName: 'Shop' }, url('/items/42?ref=x'))
    expect(tags.split('\n')).toEqual([
      '<title>Widget</title>',
      '<meta name="description" content="A thing">',
      '<meta property="og:type" content="website">',
      '<meta property="og:title" content="Widget">',
      '<meta property="og:description" content="A thing">',
      '<meta property="og:url" content="https://app.example.com/items/42">',
      '<meta property="og:image" content="https://app.example.com/og/widget.png">',
      '<meta property="og:site_name" content="Shop">',
      '<meta name="twitter:card" content="summary_large_image">',
      '<meta name="twitter:title" content="Widget">',
      '<meta name="twitter:description" content="A thing">',
      '<meta name="twitter:image" content="https://app.example.com/og/widget.png">',
      '<link rel="canonical" href="https://app.example.com/items/42">',
    ])
  })

  it('leaves out what is not given; a card without an image is `summary`', () => {
    const tags = ogTags({ title: 'Only a title' }, url('/'))
    expect(tags).not.toMatch(/description|og:image|twitter:image|site_name/)
    expect(tags).toContain('<meta name="twitter:card" content="summary">')
  })

  it('escapes every value — a record title can never become markup', () => {
    const evil = '"><script>alert(1)</script>'
    const tags = ogTags({ title: evil, description: evil, siteName: evil, url: `/x?q=${evil}`, image: `/i.png?${evil}` }, url('/'))
    expect(tags).not.toContain('<script>')
    expect(tags).not.toMatch(/content="[^"]*"[^>]*"/) // no attribute is broken out of
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;')
  })

  it('an absolute image / url is kept; a non-http one is dropped', () => {
    expect(ogTags({ title: 't', image: 'https://cdn.example.net/a.png', url: 'https://other.example.org/p' }, url('/'))).toContain('content="https://cdn.example.net/a.png"')
    const bad = ogTags({ title: 't', image: 'javascript:alert(1)', url: 'data:text/html,x' }, url('/'))
    expect(bad).not.toMatch(/javascript:|data:/)
  })
})

describe('applyOg', () => {
  it('removes the generic title / description / og / twitter / canonical tags and nothing else', () => {
    const head = [
      '<meta charset="utf-8"><title>App</title><meta name="description" content="generic">',
      '<meta property="og:title" content="App"><meta name="twitter:card" content="summary"><link rel="canonical" href="/"><link rel="icon" href="/favicon.svg"><meta name="theme-color" content="#000">',
    ]
    expect(stripOgTags(head.join(''))).toBe('<meta charset="utf-8"><link rel="icon" href="/favicon.svg"><meta name="theme-color" content="#000">')
    const out = applyOg(head, { title: 'Page' }, url('/p')).join('\n')
    expect(out.match(/<title>/g)).toHaveLength(1)
    expect(out).toContain('<title>Page</title>')
    expect(out).toContain('<link rel="icon" href="/favicon.svg">')
  })
})

describe('requestUrl', () => {
  it('uses the proxy headers, then the host header; a fixed site URL wins', () => {
    const event = (headers: Record<string, string>, path = '/a?b=1') => ({ path, headers: new Headers(headers) })
    expect(requestUrl(event({ host: 'internal:3000', 'x-forwarded-host': 'app.example.com', 'x-forwarded-proto': 'https' })).href).toBe('https://app.example.com/a?b=1')
    expect(requestUrl(event({ host: 'localhost:3000' })).href).toBe('http://localhost:3000/a?b=1')
    expect(requestUrl(event({ host: 'evil.example' }), 'https://app.example.com').href).toBe('https://app.example.com/a?b=1')
    expect(requestUrl({ node: { req: { url: '/x', headers: { host: 'h.example' } } } }).href).toBe('http://h.example/x')
    expect(requestUrl(event({ host: 'bad host name' })).origin).toBe('http://localhost')
  })
})

describe('the render hook', () => {
  type Hook = (html: { head: string[] }, context: { event: any }) => Promise<void> | void
  function plugin(resolve: OgResolver, options = {}) {
    let hook: Hook | undefined
    const onError = vi.fn()
    ogPlugin(resolve, { onError, ...options })({ hooks: { hook: (_name, fn) => { hook = fn } } })
    const render = async (path: string, ua: string | undefined) => {
      const html = { head: ['<title>Generic</title>'] }
      const vary: string[] = []
      await hook!(html, { event: { path, headers: new Headers({ host: 'app.example.com', 'x-forwarded-proto': 'https', ...(ua ? { 'user-agent': ua } : {}) }), node: { res: { setHeader: (_n: string, v: string) => vary.push(v) } } } })
      return { head: html.head.join('\n'), vary }
    }
    return { render, onError }
  }
  const resolver: OgResolver = ({ path, query }) => (path === '/none' ? null : { title: `Page ${path}${query.get('v') ?? ''}` })

  it('rewrites the head for a crawler, per URL; a browser gets the shell untouched', async () => {
    const { render } = plugin(resolver)
    expect((await render('/a', 'Twitterbot/1.0')).head).toContain('<title>Page /a</title>')
    expect((await render('/b?v=2', 'facebookexternalhit/1.1')).head).toContain('<meta property="og:title" content="Page /b2">')
    const browser = await render('/a', 'Mozilla/5.0 Chrome/126.0 Safari/537.36')
    expect(browser.head).toBe('<title>Generic</title>')
    expect(browser.vary).toEqual(['User-Agent'])
    expect((await render('/a', undefined)).head).toBe('<title>Generic</title>')
  })

  it('a resolver that returns nothing leaves the shell alone', async () => {
    expect((await plugin(resolver).render('/none', 'Twitterbot/1.0')).head).toBe('<title>Generic</title>')
  })

  it('a resolver that throws or hangs never breaks the page', async () => {
    const throwing = plugin(() => { throw new Error('api down') })
    expect((await throwing.render('/a', 'Twitterbot/1.0')).head).toBe('<title>Generic</title>')
    expect(throwing.onError).toHaveBeenCalledTimes(1)
    const hanging = plugin(() => new Promise(() => undefined), { timeoutMs: 20 })
    expect((await hanging.render('/a', 'Twitterbot/1.0')).head).toBe('<title>Generic</title>')
  })

  it('`always` rewrites for everyone', async () => {
    const { render } = plugin(resolver, { always: true })
    const res = await render('/a', 'Mozilla/5.0 Chrome/126.0 Safari/537.36')
    expect(res.head).toContain('<title>Page /a</title>')
    expect(res.vary).toEqual([])
  })
})
