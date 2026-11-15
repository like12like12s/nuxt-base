// DO NOT EDIT — locked file from the nuxt-base kit (runtime/testing/factory.ts). Its hash is recorded in .scaffold.json;
// `scaffold check` reports local edits and `scaffold update` overwrites them. Change it in the kit instead.
//
// Deterministic test data: a seeded random source, a clock that starts at a fixed instant, sequential ids. The same
// test produces the same rows on every run and on every machine — no Math.random(), no Date.now() in a fixture.
import { setClock, setIdGenerator } from '../db/clock.js'

/** mulberry32 — small, fast, good enough for fixtures. Returns floats in [0, 1). */
export function seededRandom(seed = 1): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const FIXED_START = '2026-01-01T00:00:00.000Z'

/** A clock that starts at `start` and advances `stepMs` on every reading, so rows get distinct, ordered timestamps. */
export function fixedClock(start: string = FIXED_START, stepMs = 1000): () => Date {
  let at = Date.parse(start)
  return () => {
    const value = new Date(at)
    at += stepMs
    return value
  }
}

/** 00000000-0000-4000-8000-000000000001, ...002, ... — valid UUIDs, in order. */
export function sequentialIds(): () => string {
  let n = 0
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
}

/**
 * Pin the data layer's clock and id generator (db/clock). Call restore() when the test file is done — or use
 * useDeterministic() from test-db.ts, which does both around every test.
 */
export function deterministic(options: { start?: string; stepMs?: number } = {}): { restore: () => void } {
  setClock(fixedClock(options.start, options.stepMs))
  setIdGenerator(sequentialIds())
  return {
    restore: () => {
      setClock()
      setIdGenerator()
    },
  }
}

export interface FactoryContext {
  /** 1 for the first object built, 2 for the second, ... */
  n: number
  random: () => number
  /** One element of `list`, chosen by the seeded random source. */
  pick: <T>(list: readonly T[]) => T
}

export interface Factory<T> {
  build(overrides?: Partial<T>): T
  buildList(count: number, overrides?: Partial<T>): T[]
}

/** `const item = defineFactory(({ n }) => ({ name: `Item ${n}`, quantity: n }))` -> item.build({ quantity: 0 }) */
export function defineFactory<T extends object>(build: (context: FactoryContext) => T, seed = 1): Factory<T> {
  let n = 0
  const random = seededRandom(seed)
  const pick = <V>(list: readonly V[]): V => {
    if (!list.length) throw new Error('pick() needs a non-empty list')
    return list[Math.floor(random() * list.length)] as V
  }
  const one = (overrides?: Partial<T>): T => ({ ...build({ n: ++n, random, pick }), ...overrides })
  return { build: one, buildList: (count, overrides) => Array.from({ length: count }, () => one(overrides)) }
}
