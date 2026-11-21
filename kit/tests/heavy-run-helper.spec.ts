// @vitest-environment node
// The heavy-run queue helper exists twice by design: scripts/lib/ is what THIS repo's playwright config imports,
// kit/runtime/testing/ is the locked copy every generated UI project gets. Both were edited together by hand in
// t1444 — nothing else compares them, so a future one-sided edit would silently leave generated projects on the
// stale copy (fresh-review r1 #8). Byte-identical, or this spec says so.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KIT_ROOT } from './helpers'

describe('heavy-run helper mirror', () => {
  it('scripts/lib/ and kit/runtime/testing/ copies are byte-identical', () => {
    const repo = readFileSync(join(KIT_ROOT, '..', 'scripts', 'lib', 'heavy-run-global-setup.mjs'), 'utf8')
    const kit = readFileSync(join(KIT_ROOT, 'runtime', 'testing', 'heavy-run-global-setup.mjs'), 'utf8')
    expect(repo).toBe(kit)
  })
})
