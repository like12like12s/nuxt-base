// DO NOT EDIT — locked file from the nuxt-base kit (runtime/testing/client.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Call the app in-process (no port, no network): `const api = testClient(app)` -> `await api.get('/api/v1/items')`.
// Every result carries the parsed JSON body and the x-trace-id header, which is what most assertions need.

export interface TestApp {
  request(input: string, init?: RequestInit): Response | Promise<Response>
}

export interface TestResponse<T = any> {
  status: number
  headers: Headers
  /** Parsed JSON, or the text when the response is not JSON, or null when it has no body. */
  body: T
  traceId: string | null
}

export interface CallOptions {
  headers?: Record<string, string>
  /** Sent as-is instead of a JSON body (to test malformed input). */
  raw?: string
}

export function testClient(app: TestApp, defaults: { headers?: Record<string, string> } = {}) {
  async function call<T = any>(method: string, path: string, body?: unknown, options: CallOptions = {}): Promise<TestResponse<T>> {
    const headers: Record<string, string> = { ...defaults.headers, ...options.headers }
    let payload: string | undefined
    if (options.raw !== undefined) payload = options.raw
    else if (body !== undefined) payload = JSON.stringify(body)
    if (payload !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
    const res = await app.request(path, { method, headers, body: payload })
    const text = await res.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }
    return { status: res.status, headers: res.headers, body: parsed as T, traceId: res.headers.get('x-trace-id') }
  }
  return {
    call,
    get: <T = any>(path: string, options?: CallOptions) => call<T>('GET', path, undefined, options),
    post: <T = any>(path: string, body?: unknown, options?: CallOptions) => call<T>('POST', path, body, options),
    put: <T = any>(path: string, body?: unknown, options?: CallOptions) => call<T>('PUT', path, body, options),
    patch: <T = any>(path: string, body?: unknown, options?: CallOptions) => call<T>('PATCH', path, body, options),
    delete: <T = any>(path: string, options?: CallOptions) => call<T>('DELETE', path, undefined, options),
  }
}
