// DO NOT EDIT — locked file from the nuxt-base kit (runtime/db/clock.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// The two sources of non-determinism of the data layer — the clock and the id generator — behind one seam, so tests
// (kit/testing) can pin both. Timestamps are ISO-8601 UTC strings: identical on SQLite and MySQL, sortable as text.
import { randomUUID } from 'node:crypto'

let clock: () => Date = () => new Date()
let idGenerator: () => string = randomUUID

/** Current time as `2026-01-31T12:00:00.000Z` — the format of every timestamp column. */
export const now = (): string => clock().toISOString()
/** A new primary key (UUID, 36 chars). */
export const newId = (): string => idGenerator()

/** Tests only: pin the clock / the id generator. Pass nothing to restore the real one. */
export function setClock(fn?: () => Date): void {
  clock = fn ?? (() => new Date())
}
export function setIdGenerator(fn?: () => string): void {
  idGenerator = fn ?? randomUUID
}
