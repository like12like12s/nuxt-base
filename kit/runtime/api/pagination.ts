// DO NOT EDIT — locked file from the nuxt-base kit (runtime/api/pagination.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// List conventions of the API standard:
//   GET /api/v1/things?limit=50&offset=0&sort=-createdAt,name     -> { data: [...], meta: { limit, offset, total } }
//   GET /api/v1/things?ids=a,b                                     -> the same envelope, only those ids (one call, not N)
//   GET /api/v1/things/{id}                                        -> { data: {...} }
// Out-of-range values are rejected (400 VALIDATION), never silently clamped — a client that asks for limit=5000 has a bug.
import { z } from '@hono/zod-openapi'

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200
export const MAX_IDS = 200

export interface SortTerm<C extends string = string> {
  column: C
  direction: 'asc' | 'desc'
}

export interface ListParams<C extends string = string> {
  limit: number
  offset: number
  sort: SortTerm<C>[]
  /** Set when the caller asked for specific ids (`?ids=a,b`). */
  ids?: string[]
}

export interface ListMeta {
  limit: number
  offset: number
  total: number
}

/** `-createdAt,name` -> [{ createdAt desc }, { name asc }]; null when a field is not sortable or the syntax is off. */
export function parseSort<C extends string>(value: string, sortable: readonly C[]): SortTerm<C>[] | null {
  const terms: SortTerm<C>[] = []
  for (const raw of value.split(',')) {
    const term = raw.trim()
    const column = (term.startsWith('-') ? term.slice(1) : term) as C
    if (!sortable.includes(column) || terms.some((t) => t.column === column)) return null
    terms.push({ column, direction: term.startsWith('-') ? 'desc' : 'asc' })
  }
  return terms
}

// Query numbers are plain decimal digits. Anything else that Number() would happily read — `0x10`, `1e2`, ` 5 `,
// an empty `offset=` — is not a number here and fails validation (400) instead of meaning something surprising.
const decimal = (value: unknown): unknown => (value === undefined ? undefined : typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : typeof value === 'number' ? value : Number.NaN)

/**
 * A list endpoint's query: `const list = listQuery({ sortable: [...], defaultSort: '-createdAt' })`, then
 * `request: { query: list.schema }` in the route and `list.parse(c.req.valid('query'))` in the handler.
 */
export function listQuery<const C extends string>(options: { sortable: readonly C[]; defaultSort: string }) {
  const { sortable, defaultSort } = options
  if (!parseSort(defaultSort, sortable)) throw new Error(`listQuery: defaultSort "${defaultSort}" is not made of sortable columns`)
  const schema = z.object({
    limit: z.preprocess(decimal, z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)).openapi({ description: `Page size (1-${MAX_LIMIT}); with ids: at least the number of ids`, example: DEFAULT_LIMIT }),
    offset: z.preprocess(decimal, z.number().int().min(0).default(0)).openapi({ description: 'Rows to skip', example: 0 }),
    sort: z
      .string()
      .default(defaultSort)
      .refine((value) => parseSort(value, sortable) !== null, { message: `sort must be a comma-separated list of: ${sortable.join(', ')} (prefix - for descending)` })
      .openapi({ description: `Comma-separated columns, - prefix = descending. Sortable: ${sortable.join(', ')}`, example: defaultSort }),
    ids: z
      .string()
      .optional()
      .refine((value) => value === undefined || (value.split(',').every((id) => id.trim().length > 0) && value.split(',').length <= MAX_IDS), {
        message: `ids must be a comma-separated list of at most ${MAX_IDS} ids`,
      })
      .openapi({ description: 'Only these ids (comma-separated) — fetch many in one call', example: 'a,b' }),
  })
  const parse = (query: z.infer<typeof schema>): ListParams<C> => {
    const ids = query.ids === undefined ? undefined : [...new Set(query.ids.split(',').map((id) => id.trim()))]
    return {
      // `?ids=` asks for exactly those records: they all fit one page (MAX_IDS <= MAX_LIMIT), never a silent cut at 50.
      limit: ids ? Math.max(query.limit, ids.length) : query.limit,
      offset: query.offset,
      sort: parseSort(query.sort, sortable) ?? [],
      ...(ids === undefined ? {} : { ids }),
    }
  }
  return { schema, parse }
}

/** `{ data: T }` */
export const dataOf = <T extends z.ZodType>(schema: T) => z.object({ data: schema })

export const ListMetaSchema = z.object({ limit: z.number().int(), offset: z.number().int(), total: z.number().int() }).openapi('ListMeta')

/** `{ data: T[], meta: { limit, offset, total } }` */
export const listOf = <T extends z.ZodType>(schema: T) => z.object({ data: z.array(schema), meta: ListMetaSchema })

export const one = <T>(data: T) => ({ data })
export const page = <T>(data: T[], params: Pick<ListParams, 'limit' | 'offset'>, total: number) => ({
  data,
  meta: { limit: params.limit, offset: params.offset, total },
})
