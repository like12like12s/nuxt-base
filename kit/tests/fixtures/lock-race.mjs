// Child process of the job-lock race test (runtime-jobs.spec.ts): wait for the common start time, try to take the lock
// once, hold it for a while, and record when it was held.   argv: <module with acquireLock> <lock dir> <start at, ms> <log file> <hold ms>
import { appendFileSync } from 'node:fs'

const [module, dir, at, log, hold] = process.argv.slice(2)
const { acquireLock } = await import(module)
while (Date.now() < Number(at)) { /* spin: every contender starts in the same millisecond */ }
const lock = acquireLock(dir, 'race', { ttlMs: 60_000 })
if (lock) {
  const from = Date.now()
  const until = from + Number(hold)
  while (Date.now() < until) { /* hold */ }
  appendFileSync(log, `${process.pid} ${from} ${Date.now()}\n`)
  lock.release()
}
