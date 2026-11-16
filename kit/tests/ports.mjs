// Host ports of the kit gate. Every combo gets a block of consecutive ports; before a block is handed out each of its
// ports is probed (a real listen on all interfaces), and a block with a port somebody else holds is skipped — the
// combo simply gets the next one. A block is never handed out twice in one run.
// (v0.3.0 post-tag run: one combo failed because another session's server sat on a port of its block.)
import { createServer } from 'node:net'

/** Can a server listen on `port` right now — i.e. nothing holds it on any interface? */
export function isFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/**
 * `next()` -> the first port of a free block, searching upwards from `base` in steps of `size`.
 *   attempts   how many blocks one call may skip before it gives up (a machine with no free block is an error)
 *   probe      injectable for tests
 *   onSkip     told which block was skipped and which port was busy
 * Calls are serialised: two combos starting at once never probe — or get — the same block.
 */
export function portBlocks({ base, size = 10, attempts = 50, max = 65535, probe = isFree, onSkip = () => undefined }) {
  let cursor = base
  let queue = Promise.resolve()
  const take = async () => {
    for (let skipped = 0; skipped <= attempts; skipped++) {
      const start = cursor
      cursor += size
      if (start + size - 1 > max) break
      let busy = null
      for (let port = start; port < start + size && busy === null; port++) if (!(await probe(port))) busy = port
      if (busy === null) return start
      onSkip({ start, busy })
    }
    throw new Error(`kit gate: no free block of ${size} ports found from ${base} (${attempts + 1} blocks tried) — pass --port-base`)
  }
  return {
    next() {
      const result = queue.then(take)
      queue = result.catch(() => undefined)
      return result
    },
  }
}
