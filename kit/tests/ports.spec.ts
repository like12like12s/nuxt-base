// @vitest-environment node
// fix4 C: the kit gate lost a combo of the v0.3.0 post-tag run to a host port another session held. A block is now
// probed before it is used, and a busy one is skipped.
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KIT_ROOT } from './helpers'
// @ts-expect-error plain ESM, no types
import { defaultBase, ephemeralRange, isFree, portBlocks } from './ports.mjs'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))) })

/** Hold a port the way another gate run's server would. */
function hold(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, host, () => { servers.push(server); resolve(true) })
  })
}

/** A base whose first four blocks are free right now (the test machine runs other things too).
 * Drawn just below the kernel ephemeral range, above the gate's defaultBase band (same reason as t1349: any outgoing connection can grab a port in
 * it between the probe and the assert) and probing every port the tests touch — the block test reaches
 * base+39; probing only base+29 let a busy fourth block through (t1368 verify flake: 40130 -> 40140). */
async function freeBase(): Promise<number> {
  // band [lo-1900, lo-200]: above every pid's defaultBase (≤ lo-2000), so a concurrent gate run's own servers
  // don't start there either; and +40 still ends below lo
  const { lo } = ephemeralRange()
  if (lo - 1900 < 1024) throw new Error(`ephemeral range starts at ${lo}: no room for a test port band below it`)
  for (let tries = 0; tries < 40; tries++) {
    const base = lo - 1900 + Math.floor(Math.random() * 18) * 100
    let free = true
    for (let port = base; port < base + 40 && free; port++) free = await isFree(port)
    if (free) return base
  }
  throw new Error('no free port range found for the test')
}

describe('kit gate ports', () => {
  it('isFree: a port held on loopback or on every interface is not free; it is again once released', async () => {
    const base = await freeBase()
    expect(await hold(base + 1)).toBe(true)
    expect(await hold(base + 2, '0.0.0.0')).toBe(true)
    expect([await isFree(base), await isFree(base + 1), await isFree(base + 2)]).toEqual([true, false, false])
    await new Promise((resolve) => servers.pop()!.close(resolve))
    expect(await isFree(base + 2)).toBe(true)
  })

  it('a block with a port in use is skipped: the combo gets the next block, with a notice naming the busy port', async () => {
    const base = await freeBase()
    expect(base + 40).toBeLessThanOrEqual(ephemeralRange().lo) // every port this test touches sits below the ephemeral range
    expect(await hold(base + 14)).toBe(true) // in the middle of the second block
    const skipped: unknown[] = []
    const ports = portBlocks({ base, size: 10, onSkip: (info: unknown) => skipped.push(info) })
    expect(await ports.next()).toBe(base) // first block: free
    expect(await ports.next()).toBe(base + 20) // second block has a busy port -> third
    expect(skipped).toEqual([{ start: base + 10, busy: base + 14 }])
    expect(await ports.next()).toBe(base + 30) // never handed out twice, never goes back
  })

  it('combos starting at the same moment get different blocks', async () => {
    const probed: number[] = []
    const ports = portBlocks({ base: 40000, size: 10, probe: async (port: number) => { probed.push(port); await new Promise((resolve) => setTimeout(resolve, 1)); return port !== 40025 } })
    const blocks = await Promise.all([ports.next(), ports.next(), ports.next(), ports.next()])
    expect(blocks).toEqual([40000, 40010, 40030, 40040])
    expect(new Set(probed.filter((port) => port !== 40025)).size).toBe(probed.filter((port) => port !== 40025).length) // no port probed for two combos
  })

  it('gives up with a clear error instead of searching forever, and the next call still works', async () => {
    let busy = true
    const ports = portBlocks({ base: 50000, size: 10, attempts: 3, probe: async () => !busy })
    await expect(ports.next()).rejects.toThrow(/no free block of 10 ports found from 50000 \(4 blocks tried\) — pass --port-base/)
    busy = false
    expect(await ports.next()).toBe(50040)
    await expect(portBlocks({ base: 65530, size: 10, probe: async () => true }).next()).rejects.toThrow(/no free block/)
  })

  it('ephemeralRange: read from the kernel, with the Linux default when the file is missing or garbage', () => {
    const read = (path: string) => (path === '/proc/sys/net/ipv4/ip_local_port_range' ? '32768\t60999\n' : (() => { throw new Error('nope') })())
    expect(ephemeralRange(read)).toEqual({ lo: 32768, hi: 60999 })
    expect(ephemeralRange(() => '1024  65535\n')).toEqual({ lo: 1024, hi: 65535 })
    const fallback = { lo: 32768, hi: 60999 }
    expect(ephemeralRange(() => { throw new Error('ENOENT') })).toEqual(fallback) // not Linux
    expect(ephemeralRange(() => '')).toEqual(fallback)
    expect(ephemeralRange(() => 'garbage')).toEqual(fallback)
    expect(ephemeralRange(() => '60999 32768')).toEqual(fallback) // lo > hi
    expect(ephemeralRange()).toEqual(fallback) // the real host file parses (Linux default on this fleet)
  })

  it('defaultBase: per pid deterministic, and every pid lands below the ephemeral range with room for a run on top', () => {
    expect(defaultBase(1234, 32768)).toBe(defaultBase(1234, 32768))
    expect(defaultBase(0, 32768)).toBe(11000)
    for (let pid = 0; pid < 1000; pid++) {
      const base = defaultBase(pid, 32768)
      expect(base).toBeGreaterThanOrEqual(11000)
      expect(base).toBeLessThanOrEqual(32768 - 2000) // headroom: 200 blocks of 10 below the ephemeral start
      expect((base - 11000) % 200).toBe(0) // blocks of two runs never interleave arbitrarily
    }
    expect(new Set(Array.from({ length: 90 }, (_, pid) => defaultBase(pid, 32768))).size).toBeGreaterThan(50) // real spread across pids
    expect(defaultBase(7, 11000)).toBe(11000) // degenerate host (ephemeral from 11000): no room below — the gate's range check refuses this loudly
  })

  it('the kit gate takes every combo\'s ports from it, below the ephemeral range', () => {
    const gate = readFileSync(join(KIT_ROOT, 'tests/kit-gate.mjs'), 'utf8')
    expect(gate).toContain('const ports = portBlocks({ base: PORT_BASE, size: 10, max: PORT_MAX,')
    expect(gate).toContain('const port = await ports.next()')
    expect(gate).toContain('defaultBase(process.pid, ephemeral.lo)')
    expect(gate).toContain('is inside the ephemeral range') // a pinned base inside the range is refused, not flaked on
    expect(gate).not.toMatch(/PORT_BASE \+ index/)
    expect(gate).not.toMatch(/30000 \+ \(process\.pid/) // the old formula reached into the ephemeral range (t1349)
  })
})
