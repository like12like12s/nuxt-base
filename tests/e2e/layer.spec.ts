import { test, expect, type Page } from '@playwright/test'

function watchErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  return errors
}

test('layer renders: tokens, components, async patterns, head defaults, no JS errors', { tag: ['@smoke'] }, async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/')
  await expect(page.getByTestId('title')).toHaveText('nuxt-base playground')

  // Tailwind actually compiled the layer's classes (component lives in the layer, not the app)
  const btn = page.getByTestId('btn-primary')
  const bg = await btn.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg).not.toBe('rgba(0, 0, 0, 0)')
  // token utility (bg-accent) resolves to the same colour as the Btn primary (emerald-700)
  const swatch = await page.getByTestId('swatch-accent').evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(swatch).toBe(bg)
  // body background = --color-bg (zinc-950), not browser default white
  const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(body).not.toBe('rgba(0, 0, 0, 0)')
  expect(body).not.toBe('rgb(255, 255, 255)')

  // head defaults (SPA → applied client-side by useSiteHead)
  await expect(page).toHaveTitle('nuxt-base playground')
  expect(await page.locator('html').getAttribute('class')).toContain('dark')
  expect(await page.locator('html').getAttribute('lang')).toBe('th')
  expect(await page.locator('meta[property="og:site_name"]').getAttribute('content')).toBe('nuxt-base playground')

  // toast via useToast
  await btn.click()
  await expect(page.getByText('primary clicked')).toBeVisible()

  // async patterns: loading skeleton has no empty text; error shows message + retry returns to data
  await page.getByRole('radio', { name: 'loading' }).click()
  await expect(page.getByTestId('async').getByRole('status')).toBeVisible()
  await expect(page.getByTestId('async')).not.toContainText('ยังไม่มี')
  await page.getByRole('radio', { name: 'error' }).click()
  await expect(page.getByTestId('async').getByRole('alert')).toContainText('API 503')
  await page.getByTestId('async').getByRole('button', { name: 'ลองใหม่' }).click()
  await expect(page.getByTestId('async')).toContainText('item 1')
  await page.getByRole('radio', { name: 'empty' }).click()
  await expect(page.getByTestId('async')).toContainText('ยังไม่มีรายการ')

  // auth hook disabled → ready + anonymous
  await expect(page.getByTestId('auth')).toHaveText('enabled=false ready=true user=anonymous')

  await page.screenshot({ path: 'test-results/playground-index.png', fullPage: true })
  expect(errors).toEqual([])
})

test('error page from the layer renders for unknown routes', { tag: ['@smoke'] }, async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/does-not-exist')
  await expect(page.getByRole('heading', { name: 'ไม่พบหน้านี้' })).toBeVisible()
  await expect(page.getByText('404')).toBeVisible()
  await page.getByRole('button', { name: 'กลับหน้าแรก' }).click()
  await expect(page.getByTestId('title')).toBeVisible()
  expect(errors.filter((e) => !e.includes('404') && !e.includes('NUXT_E1005'))).toEqual([])
})

test('default favicon ships with the layer (apps without public/favicon.svg get no 404)', { tag: ['@smoke'] }, async ({ request }) => {
  const res = await request.get('/favicon.svg')
  expect(res.status()).toBe(200)
  expect(await res.text()).toContain('<svg')
})

test('auth hook route answers 401 without proxy headers and a user with them', { tag: ['@smoke'] }, async ({ request }) => {
  const anon = await request.get('/api/_me')
  expect(anon.status()).toBe(401)
  const me = await request.get('/api/_me', { headers: { 'x-authentik-username': 'not', 'x-authentik-email': 'n@x', 'x-authentik-groups': 'admins|dev' } })
  expect(me.status()).toBe(200)
  expect(await me.json()).toEqual({ id: 'not', name: 'not', email: 'n@x', groups: ['admins', 'dev'] })
})
