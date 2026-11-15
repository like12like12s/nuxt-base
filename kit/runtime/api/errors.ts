// DO NOT EDIT — locked file from the nuxt-base kit (runtime/api/errors.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// The one error shape of the API standard. Every response with status >= 400 has exactly this body:
//   { "error": { "code": "NOT_FOUND", "message": "...", "details": [...], "traceId": "..." } }   (details optional)
// Handlers throw an ApiError (helpers below); anything else that escapes a handler becomes a 500 whose body says
// nothing about the cause — the cause goes to the log, next to the same traceId.
import { z } from '@hono/zod-openapi'

/** The fixed set. A client switches on `code`, never on `message`. */
export const ERROR_CODES = ['VALIDATION', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED', 'INTERNAL'] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export const STATUS_OF = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const satisfies Record<ErrorCode, number>

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503

/** Any HTTP status >= 400 -> the code that describes it (other 4xx = the request is at fault, other 5xx = we are). */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401: return 'UNAUTHORIZED'
    case 403: return 'FORBIDDEN'
    case 404: return 'NOT_FOUND'
    case 409: return 'CONFLICT'
    case 429: return 'RATE_LIMITED'
    default: return status >= 500 ? 'INTERNAL' : 'VALIDATION'
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown[]; traceId: string }
}

export class ApiError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details?: unknown[]
  constructor(code: ErrorCode, message: string, options: { details?: unknown[]; status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ApiError'
    this.code = code
    this.status = options.status ?? STATUS_OF[code]
    this.details = options.details
  }
}

export const validation = (message: string, details?: unknown[]) => new ApiError('VALIDATION', message, { details })
export const unauthorized = (message = 'Authentication required') => new ApiError('UNAUTHORIZED', message)
export const forbidden = (message = 'Not allowed') => new ApiError('FORBIDDEN', message)
export const notFound = (what: string, id?: string) => new ApiError('NOT_FOUND', id === undefined ? `${what} not found` : `${what} ${id} not found`)
export const conflict = (message: string, details?: unknown[]) => new ApiError('CONFLICT', message, { details })
export const rateLimited = (message = 'Too many requests') => new ApiError('RATE_LIMITED', message)

export function errorBody(code: ErrorCode, message: string, traceId: string, details?: unknown[]): ErrorBody {
  return { error: { code, message, ...(details?.length ? { details } : {}), traceId } }
}

/** The error body as an OpenAPI component — every route lists its error statuses with `errorResponses()`. */
export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string(),
      details: z.array(z.unknown()).optional(),
      traceId: z.string(),
    }),
  })
  .openapi('Error')

const DESCRIPTION: Record<number, string> = {
  400: 'Validation failed',
  401: 'Authentication required',
  403: 'Not allowed',
  404: 'Not found',
  409: 'Conflict',
  429: 'Rate limited',
  500: 'Internal error',
  503: 'Not ready',
}

/** `responses: { 200: ..., ...errorResponses(400, 404) }` — 500 is always included. */
export function errorResponses<const S extends ErrorStatus>(...statuses: S[]) {
  const out = {} as Record<S | 500, { description: string; content: { 'application/json': { schema: typeof ErrorSchema } } }>
  for (const status of [...statuses, 500 as const]) {
    out[status] = { description: DESCRIPTION[status] ?? 'Error', content: { 'application/json': { schema: ErrorSchema } } }
  }
  return out
}
