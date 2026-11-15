// Calls the API from the UI SERVER (never from the browser) — what a link preview needs to show a record's own title.
// A crawler has no session: behind single sign-on its request carries no identity, and the API answers 401 to an
// anonymous caller. So the UI server reads with a service token of its own:
//   API_SERVICE_TOKEN   create it once — `npm run auth:token -- create --name og-preview --days 365` in the API
//                       (no --roles = authenticated and read-only) — and set it in the UI server's environment
//   API_URL             where the API is (the same setting the /api proxy uses)
// Read-only by construction (GET), short timeout, and never an exception: `null` means "no answer" — unknown record,
// not allowed, API down, token missing — and the caller falls back to the generic preview.
import { apiTarget } from './api-target'

export interface ServerApiOptions {
  /** Default: process.env.API_SERVICE_TOKEN. Empty = the request goes out without credentials. */
  token?: string
  /** Default: process.env.API_URL. */
  apiUrl?: string
  /** Default 2500 — the preview as a whole is abandoned after 3 s. */
  timeoutMs?: number
  fetch?: typeof fetch
}

export async function serverApi<T = unknown>(path: string, options: ServerApiOptions = {}): Promise<T | null> {
  // Only a path of the API: the target host comes from configuration, never from the caller's input.
  if (!path.startsWith('/') || path.startsWith('//')) return null
  const token = options.token ?? process.env.API_SERVICE_TOKEN ?? ''
  try {
    const res = await (options.fetch ?? fetch)(apiTarget(options.apiUrl ?? process.env.API_URL, path), {
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 2500),
    })
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}
