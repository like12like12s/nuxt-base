// Compile-time test of the typed client. Nothing imports this file; `npm run typecheck` (part of the gate) compiles
// it. It fails when app/api/schema.d.ts stops describing the API these lines use — or when the client loses its
// types (every `@ts-expect-error` below must really be an error).
import type { ApiClient } from '~/composables/useApi'

// @kit:if sample
export async function typedClientCompiles(api: ApiClient) {
  const list = await api.GET('/api/v1/items', { params: { query: { limit: 2, sort: '-createdAt' } } })
  const total: number | undefined = list.data?.meta.total
  const one = await api.GET('/api/v1/items/{id}', { params: { path: { id: 'x' } } })
  const name: string | undefined = one.data?.data.name
  const code: string | undefined = one.error?.error.code
  const created = await api.POST('/api/v1/items', { body: { name: 'Widget', quantity: 1 } })
  const id: string | undefined = created.data?.data.id

  // @ts-expect-error — not a path of the API
  await api.GET('/api/v1/not-a-resource', {})
  // @ts-expect-error — `name` is a string
  await api.POST('/api/v1/items', { body: { name: 1 } })
  // @ts-expect-error — `name` is not a number
  const wrong: number | undefined = one.data?.data.name

  return { total, name, code, id, wrong }
}
// @kit:else
// The API has no resource yet, so the check covers the system routes; `scaffold add resource` gives you paths with
// params and bodies — add a call for each here (GET list, GET one, POST) and a `@ts-expect-error` for a wrong one.
export async function typedClientCompiles(api: ApiClient) {
  const version = await api.GET('/version', {})
  const kit: string | undefined = version.data?.kit
  const ready = await api.GET('/health/ready', {})
  const code: string | undefined = ready.error?.error.code

  // @ts-expect-error — not a path of the API
  await api.GET('/api/v1/not-a-resource', {})
  // @ts-expect-error — `kit` is not a number
  const wrong: number | undefined = version.data?.kit

  return { kit, code, wrong }
}
// @kit:end
