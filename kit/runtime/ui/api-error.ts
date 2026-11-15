// DO NOT EDIT — locked file from the nuxt-base kit (runtime/ui/api-error.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// What to show a person when an API call failed. The API answers every error in one shape —
//   { error: { code, message, details?, traceId } }
// — and for a rejected input (400 VALIDATION) `details` says which field and why:
//   [{ path: 'json.name', message: 'Too small: expected string to have >=1 characters' }]
// "Request validation failed" alone tells the person nothing, so:
//   apiProblem(res.error).text      one line for a toast or an error state: the message, the fields, the trace id
//   apiProblem(res.error).fields    { name: '…' }: the message per field, to put under the input it belongs to
// Use it on the `error` of a useApi() call (auto-imported from app/utils).
export interface ApiProblem {
  /** VALIDATION, NOT_FOUND, CONFLICT, … — or `NETWORK` when no answer in the API's shape came back. */
  code: string
  message: string
  /** Quote it to find the request in the server log. Empty when there is none. */
  traceId: string
  /** field name -> what is wrong with it (the first issue per field). */
  fields: Record<string, string>
  /** Issues that belong to no single field of the form (the whole body, a query parameter of the page). */
  other: string[]
  /** `message — field: why; field: why (trace abc123)` */
  text: string
}

const WHERE = /^(json|form|query|param|header|cookie)(\.|$)/

function issue(detail: unknown): { path: string; message: string } | null {
  if (typeof detail === 'string') return { path: '', message: detail }
  if (!detail || typeof detail !== 'object') return null
  const { path, message } = detail as { path?: unknown; message?: unknown }
  if (typeof message !== 'string' || !message) return null
  return { path: typeof path === 'string' ? path : '', message }
}

export function apiProblem(error: unknown): ApiProblem {
  const body = error && typeof error === 'object' && 'error' in error ? (error as { error: unknown }).error : undefined
  if (!body || typeof body !== 'object') {
    const message = error instanceof Error ? error.message : typeof error === 'string' && error ? error : 'The request did not reach the API'
    return { code: 'NETWORK', message, traceId: '', fields: {}, other: [], text: message }
  }
  const { code, message, details, traceId } = body as { code?: unknown; message?: unknown; details?: unknown; traceId?: unknown }
  const fields: Record<string, string> = {}
  const other: string[] = []
  for (const detail of Array.isArray(details) ? details : []) {
    const found = issue(detail)
    if (!found) continue
    // `json.name` -> `name`, `json.address.city` -> `address.city`; a query / path parameter keeps its place name
    const inBody = /^(json|form)\./.test(found.path)
    const field = found.path.replace(WHERE, '')
    if (inBody && field) fields[field] ??= found.message
    else other.push(found.path && !/^(json|form)$/.test(found.path) ? `${found.path}: ${found.message}` : found.message)
  }
  const text = typeof message === 'string' && message ? message : 'Request failed'
  const parts = [...Object.entries(fields).map(([field, why]) => `${field}: ${why}`), ...other]
  const trace = typeof traceId === 'string' ? traceId : ''
  return {
    code: typeof code === 'string' ? code : 'INTERNAL',
    message: text,
    traceId: trace,
    fields,
    other,
    text: `${text}${parts.length ? ` — ${parts.join('; ')}` : ''}${trace ? ` (trace ${trace})` : ''}`,
  }
}
