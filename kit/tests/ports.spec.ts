// @vitest-environment node
// fix4 C: the kit gate lost a combo of the v0.3.0 post-tag run to a host port another session held. A block is now
// probed before it is used, and a busy one is skipped.
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KIT_ROOT } from './helpers'
// @ts-expect-error plain ESM, no types
import { isFree, portBlocks } from './ports.mjs'

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

/** A base whose first three blocks are free right now (the test machine runs other things too). */
async function freeBase(): Promise<number> {
  for (let tries = 0; tries < 40; tries++) {
    const base = 20000 + Math.floor(Math.random() * 400) * 100
    let free = true
    for (let port = base; port < base + 30 && free; port++) free = await isFree(port)
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

  it('the kit gate takes every combo\'s ports from it', () => {
    const gate = readFileSync(join(KIT_ROOT, 'tests/kit-gate.mjs'), 'utf8')
    expect(gate).toContain('const ports = portBlocks({ base: PORT_BASE, size: 10,')
    expect(gate).toContain('const port = await ports.next()')
    expect(gate).not.toMatch(/PORT_BASE \+ index/)
  })
})
