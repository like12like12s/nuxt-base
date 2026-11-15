import { expect, test } from '@playwright/test'
// @kit:if auth
import { captureErrors, failure, list, one, stubApi } from '../kit/e2e'

// The app asks the API who is signed in on every page load; e2e runs without a backend.
const me = { 'GET /api/v1/me': one({ subject: 'e2e', name: 'E2E User', email: null, roles: [], kind: 'user' }) }
const background = ['/api/v1/me']
// @kit:else
import { captureErrors, failure, list, stubApi } from '../kit/e2e'

const me = {}
const background: string[] = [] // calls the app makes on its own on every page load
// @kit:end

// UI e2e tests run without a backend: the API is stubbed in the standard envelopes, and JS errors fail the test.
test('stubApi answers /api/** in the standard envelope and records the calls', async ({ page }) => {
  const errors = captureErrors(page)
  const { calls } = await stubApi(page, {
    ...me,
    'GET /api/v1/items': list([{ id: '1', name: 'Widget' }]),
    'GET /api/v1/items/missing': failure(404, 'NOT_FOUND', 'Item missing not found'),
  })
  await page.goto('/')

  const body = await page.evaluate(() => fetch('/api/v1/items?limit=5').then((r) => r.json()))
  expect(body).toEqual({ data: [{ id: '1', name: 'Widget' }], meta: { limit: 50, offset: 0, total: 1 } })
  expect(calls.filter((call) => !background.includes(call.path))).toEqual([{ method: 'GET', path: '/api/v1/items', query: '?limit=5', body: null }])
  errors.assertNone()

  const missing = await page.evaluate(() => fetch('/api/v1/items/missing').then(async (r) => ({ status: r.status, body: await r.json() })))
  expect(missing).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Item missing not found', traceId: 'e2e-stub' } } })
  // a call the test did not stub never reaches a real server
  expect(await page.evaluate(() => fetch('/api/v1/unexpected', { method: 'POST', body: '{"a":1}' }).then((r) => r.status))).toBe(501)
  expect(calls.at(-1)).toEqual({ method: 'POST', path: '/api/v1/unexpected', query: '', body: { a: 1 } })
})

test('captureErrors turns a page error into a failed assertion', async ({ page }) => {
  const errors = captureErrors(page)
  await stubApi(page, me)
  await page.goto('/')
  errors.assertNone()
  await page.evaluate(() => { setTimeout(() => { throw new Error('boom from the page') }, 0) })
  await expect.poll(() => errors.errors).toContain('pageerror: boom from the page')
  expect(() => errors.assertNone()).toThrow(/boom from the page/)
})
