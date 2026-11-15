// DO NOT EDIT — locked file from the nuxt-base kit (runtime/testing/e2e.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Playwright helpers for the UI's e2e tests.
//   captureErrors(page)   a page that renders but throws is a failed page: collects pageerror + console.error
//   stubApi(page, {...})  answer /api/** from the test, in the API standard's envelopes — no backend needed, and a
//                         call the test did not expect fails loudly (501) instead of reaching a real server
import type { Page, Request } from '@playwright/test'

export interface ErrorCapture {
  readonly errors: string[]
  /** Throws, listing them, when the page logged an error or threw. */
  assertNone(): void
}

export function captureErrors(page: Page, options: { ignore?: RegExp[] } = {}): ErrorCapture {
  const errors: string[] = []
  const add = (line: string) => {
    if (!options.ignore?.some((re) => re.test(line))) errors.push(line)
  }
  page.on('pageerror', (error) => add(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') add(`console: ${message.text()}`)
  })
  return {
    errors,
    assertNone() {
      if (errors.length) throw new Error(`the page reported ${errors.length} error(s):\n${errors.join('\n')}`)
    },
  }
}

export interface StubResponse {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}
export type Stub = StubResponse | ((request: Request) => StubResponse | Promise<StubResponse>)

export interface ApiCall {
  method: string
  path: string
  query: string
  body: unknown
}

/** `{ data }` */
export const one = <T>(data: T): StubResponse => ({ status: 200, body: { data } })
/** `{ data, meta: { limit, offset, total } }` */
export const list = <T>(data: T[], meta: Partial<{ limit: number; offset: number; total: number }> = {}): StubResponse => ({
  status: 200,
  body: { data, meta: { limit: 50, offset: 0, total: data.length, ...meta } },
})
/** `{ error: { code, message, traceId } }` */
export const failure = (status: number, code: string, message: string): StubResponse => ({
  status,
  body: { error: { code, message, traceId: 'e2e-stub' } },
})

/**
 * Stub the API for this page. Keys are `"<METHOD> <path>"` (path without query string), e.g. `"GET /api/v1/items"`.
 * Returns the calls the page made, in order.
 */
export async function stubApi(page: Page, stubs: Record<string, Stub>, options: { prefix?: string } = {}): Promise<{ calls: ApiCall[] }> {
  const prefix = options.prefix ?? '/api/'
  const calls: ApiCall[] = []
  await page.route(
    (url) => url.pathname.startsWith(prefix),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      let body: unknown = null
      try {
        body = request.postDataJSON()
      } catch {
        body = request.postData()
      }
      calls.push({ method: request.method(), path: url.pathname, query: url.search, body })
      const stub = stubs[`${request.method()} ${url.pathname}`]
      const response = typeof stub === 'function' ? await stub(request) : stub ?? failure(501, 'INTERNAL', `no stub for ${request.method()} ${url.pathname}`)
      await route.fulfill({
        status: response.status ?? 200,
        contentType: 'application/json',
        headers: response.headers,
        body: response.body === undefined ? '' : JSON.stringify(response.body),
      })
    },
  )
  return { calls }
}
