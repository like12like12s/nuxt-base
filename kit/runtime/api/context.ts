// DO NOT EDIT — locked file from the nuxt-base kit (runtime/api/context.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Request context: one object per request, reachable from anywhere below the handler without passing it around
// (AsyncLocalStorage). It carries the trace id and the `user` slot the auth module fills.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'

/** Who is calling. Filled by the auth module; `undefined` = nobody authenticated (or no auth module). */
export interface RequestUser {
  subject: string
  roles: readonly string[]
  email?: string
  name?: string
}

export interface RequestContext {
  traceId: string
  user?: RequestUser
}

const storage = new AsyncLocalStorage<RequestContext>()

export const runWithContext = <T>(context: RequestContext, fn: () => T): T => storage.run(context, fn)
export const getContext = (): RequestContext | undefined => storage.getStore()

/** The trace id of the request being handled — the ONE function the logger and the audit writer read it from. */
export const currentTraceId = (): string | undefined => storage.getStore()?.traceId

/** `subject` of the authenticated caller, or 'anonymous' / 'system' (outside a request). Used as the audit actor. */
export const currentActor = (): string => {
  const context = storage.getStore()
  return context ? context.user?.subject ?? 'anonymous' : 'system'
}

// Seam for the trace module: a provider that returns the id of the active OpenTelemetry span. Checked first.
let activeTraceId: () => string | undefined = () => undefined
export function setTraceIdProvider(provider: () => string | undefined): void {
  activeTraceId = provider
}

const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/

/** W3C `traceparent` header -> trace id; undefined when the header is absent, malformed or all zeros. */
export function parseTraceparent(header: string | null | undefined): string | undefined {
  const id = header ? TRACEPARENT.exec(header.trim().toLowerCase())?.[1] : undefined
  return id && !/^0+$/.test(id) ? id : undefined
}

export const newTraceId = (): string => randomBytes(16).toString('hex')

/** Active span (trace module) -> incoming `traceparent` -> a new id. */
export const resolveTraceId = (traceparent: string | null | undefined): string =>
  activeTraceId() ?? parseTraceparent(traceparent) ?? newTraceId()
