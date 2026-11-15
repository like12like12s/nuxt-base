// Contract of the `items` resource: what goes in and what comes out. Declared before any handler — the OpenAPI
// document and the typed client are generated from these schemas.
import { z } from '@hono/zod-openapi'

export const ItemSchema = z
  .object({
    id: z.string().openapi({ example: '3f0c9a52-7d4e-4c1b-9a3e-5b8f1d2c6e70' }),
    name: z.string().openapi({ example: 'Widget' }),
    description: z.string().nullable(),
    quantity: z.number().int(),
    createdAt: z.string().openapi({ example: '2026-01-01T00:00:00.000Z' }),
    updatedAt: z.string(),
  })
  .openapi('Item')
export type Item = z.infer<typeof ItemSchema>

export const ItemCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(191),
    description: z.string().max(2000).nullable().optional(),
    quantity: z.number().int().min(0).max(1_000_000).optional(),
  })
  .openapi('ItemCreate')
export type ItemCreate = z.infer<typeof ItemCreateSchema>

export const ItemUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(191).optional(),
    description: z.string().max(2000).nullable().optional(),
    quantity: z.number().int().min(0).max(1_000_000).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'at least one field is required' })
  .openapi('ItemUpdate')
export type ItemUpdate = z.infer<typeof ItemUpdateSchema>

export const ItemIdParam = z.object({
  id: z.string().min(1).max(36).openapi({ param: { name: 'id', in: 'path' }, example: '3f0c9a52-7d4e-4c1b-9a3e-5b8f1d2c6e70' }),
})

/** Columns a client may sort the list by. */
export const ITEM_SORTABLE = ['createdAt', 'updatedAt', 'name', 'quantity'] as const
