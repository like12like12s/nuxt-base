// Child process of the job-lock race test (runtime-jobs.spec.ts): wait for the common start time, then
//   once   try to take the lock once, hold it for <hold ms>, record when it was held
//   churn  for <churn ms>: take, hold for <hold ms>, record, release — and every third time abandon the lock instead:
//          the run "dies" and its deadline passes. That is done without waiting and without depending on how fast
//          this machine is: the lock is taken normally, then its file is replaced (one atomic rename) by the same
//          record with a deadline in the past, and never released. So stale locks at ever higher generations are
//          superseded while other contenders are listing the directory.
// Overlap is detected without comparing clocks of different processes: a holder creates `<log>.held` exclusively and
// removes it before it releases — finding it there means somebody else holds the lock right now (`<log>.overlap`).
// argv: <module with acquireLock> <lock dir> <start at, ms> <log file> <hold ms> [once|churn] [churn ms]
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

const [module, dir, at, log, hold, mode = 'once', churnMs = '0'] = process.argv.slice(2)
const { acquireLock } = await import(module)
while (Date.now() < Number(at)) { /* spin: every contender starts in the same millisecond */ }
const end = Number(at) + Number(churnMs)
let taken = 0
do {
  if (mode === 'churn' && taken % 3 === 2) {
    const abandoned = acquireLock(dir, 'race', { ttlMs: 60_000 })
    if (abandoned) {
      taken++
      const record = JSON.parse(readFileSync(abandoned.file, 'utf8'))
      const temp = `${abandoned.file}.${process.pid}.expired`
      writeFileSync(temp, JSON.stringify({ ...record, expiresAt: new Date(Date.now() - 1000).toISOString() }))
      renameSync(temp, abandoned.file)
    }
    continue
  }
  const lock = acquireLock(dir, 'race', { ttlMs: 60_000 })
  if (!lock) continue
  taken++
  const from = Date.now()
  let witness = true
  try {
    writeFileSync(`${log}.held`, String(process.pid), { flag: 'wx' })
  } catch {
    witness = false
    appendFileSync(`${log}.overlap`, `${process.pid} ${lock.file}\n`)
  }
  const until = from + Number(hold)
  while (Date.now() < until) { /* hold */ }
  appendFileSync(log, `${process.pid} ${from} ${Date.now()}\n`)
  if (witness) rmSync(`${log}.held`)
  lock.release()
} while (mode === 'churn' && Date.now() < end)
