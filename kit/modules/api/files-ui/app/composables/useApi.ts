// Typed client of the API ({{kit.apiDir}}/openapi.json -> app/api/schema.d.ts, `npm run client`).
// Calls go to the UI's own origin: the server route /api/** proxies them to the API.
// @kit:if sample
//   const { data, error } = await useApi().GET('/api/v1/items', { params: { query: { limit: 20 } } })
// @kit:else
//   const { data, error } = await useApi().GET('/api/v1/<resource>', { params: { query: { limit: 20 } } })
// @kit:end
// `error` is the API's error body: { error: { code, message, details?, traceId } }.
import createClient from 'openapi-fetch'
import type { paths } from '~/api/schema'

export type ApiClient = ReturnType<typeof createClient<paths>>

export function useApi(): ApiClient {
  const base = useRuntimeConfig().public.apiBase
  // `fetch` is looked up per call, so a test (or a plugin) that replaces globalThis.fetch is honoured.
  return createClient<paths>({ baseUrl: typeof base === 'string' ? base : '', fetch: (request) => globalThis.fetch(request) })
}
