import { expect, test, type Page } from '@playwright/test'

// Every e2e test watches for JS errors: a page that renders but throws is a failed page.
function watchErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  return errors
}

test('home renders with the layer styles and no JS errors', async ({ page }) => {
  const errors = watchErrors(page)
  // @kit:if auth
  // the app asks the API who is signed in; e2e runs without a backend
  await page.route('**/api/v1/me', (route) => route.fulfill({ json: { data: { subject: 'e2e', name: 'E2E User', email: null, roles: [], kind: 'user' } } }))
  // @kit:end
  await page.goto('/')
  await expect(page.getByTestId('title')).toHaveText({{kit.titleJson}})
  await expect(page).toHaveTitle({{kit.titleJson}})

  // Tailwind compiled the layer's classes: the body is not browser-default white.
  const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(body).not.toBe('rgba(0, 0, 0, 0)')
  expect(body).not.toBe('rgb(255, 255, 255)')

  await page.getByTestId('hello').click()
  await expect(page.getByText('It works')).toBeVisible()
  expect(errors).toEqual([])
})

test('unknown routes show the layer error page', async ({ page }) => {
  // @kit:if auth
  await page.route('**/api/v1/me', (route) => route.fulfill({ json: { data: { subject: 'e2e', name: 'E2E User', email: null, roles: [], kind: 'user' } } }))
  // @kit:end
  await page.goto('/does-not-exist')
  await expect(page.getByText('404')).toBeVisible()
})
