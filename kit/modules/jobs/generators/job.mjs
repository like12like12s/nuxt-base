// `scaffold add job <name>` — a scheduled job: src/jobs/<name>.ts (the skeleton), its test (runs twice: the second
// run must change nothing and write no audit row; it cannot overlap itself), the registration in src/jobs/index.ts,
// and the scheduler entry the operator adds. Nothing is scheduled by the generator.
import { names } from '../../../lib/names.mjs'

export default function generate({ name, manifest, parts }) {
  const n = names(name)
  const project = manifest.answers?.name ?? 'app'
  const apiDir = parts.api?.dir || ''
  const container = manifest.deploy === 'container'
  const command = container
    ? `docker exec ${project}-api node dist/jobs/run.js ${n.kebab}`
    : `cd <project dir>${apiDir ? `/${apiDir}` : ''} && node --env-file-if-exists=.env dist/jobs/run.js ${n.kebab}`

  const job = `// Job \`${n.kebab}\`. Run it: \`npm run job -- ${n.kebab}\` · built: \`node dist/jobs/run.js ${n.kebab}\`.
// Rules of a job:
//   - idempotent: a second run right after the first changes nothing
//   - writes go through audited() (src/kit/db/repo.ts) — the actor is \`job:${n.kebab}\`, and nothing changed = no audit row
//   - check \`signal.aborted\` in long loops (the run is abandoned after timeoutMs) and return what it did
import type { Schema } from '../db/schema.js'
import { defineJob } from '../kit/jobs/runner.js'

export const ${n.camel} = defineJob<Schema>({
  name: '${n.kebab}',
  description: 'TODO: one line — what this job does',
  timeoutMs: 10 * 60_000,
  async run({ database, logger, signal }) {
    let changed = 0
    // TODO: the work. Example of the shape:
    //   for (const row of await database.db.selectFrom('items').selectAll().where('deletedAt', 'is', null).execute()) {
    //     if (signal.aborted) break
    //     ... decide what the row should be, write through audited() only when it differs, changed++ ...
    //   }
    void database
    void signal
    logger.debug('${n.kebab}: nothing to do yet')
    return { changed }
  },
})
`

  const test = `// Job \`${n.kebab}\`: it runs, it is idempotent (a second run changes nothing and writes no audit row), and it
// cannot overlap itself.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { appLogger } from '../src/app.js'
import { ${n.camel} } from '../src/jobs/${n.kebab}.js'
import { jobs } from '../src/jobs/index.js'
import { JOB_EXIT, acquireLock, runJob } from '../src/kit/jobs/runner.js'
import { testConfig, useApp } from './helpers.js'

const t = useApp()
const lockDir = mkdtempSync(join(tmpdir(), 'job-${n.kebab}-'))
afterAll(() => rmSync(lockDir, { recursive: true, force: true }))

function run() {
  const lines: Record<string, unknown>[] = []
  const logger = appLogger(testConfig(), (line) => lines.push(JSON.parse(line) as Record<string, unknown>))
  return runJob(${n.camel}, { database: t.database, logger, lockDir }).then((code) => ({ code, lines }))
}
const auditCount = async () => (await t.db.selectFrom('audit').select('id').execute()).length

describe('job ${n.kebab}', () => {
  it('is registered under its name', () => {
    expect(jobs['${n.kebab}']).toBe(${n.camel})
  })

  it('runs: exit 0, a start and an end line in JSON', async () => {
    const { code, lines } = await run()
    expect(code).toBe(JOB_EXIT.OK)
    expect(lines.filter((l) => l.msg === 'job start' || l.msg === 'job end').map((l) => [l.msg, l.job])).toEqual([['job start', '${n.kebab}'], ['job end', '${n.kebab}']])
    expect(lines.at(-1)).toMatchObject({ status: 'ok' })
    expect(typeof lines.at(-1)!.changed).toBe('number')
  })

  it('is idempotent: a second run changes nothing and adds no audit row', async () => {
    await run()
    const before = await auditCount()
    const second = await run()
    expect(second.code).toBe(JOB_EXIT.OK)
    expect(second.lines.at(-1)).toMatchObject({ changed: 0 })
    expect(await auditCount()).toBe(before)
  })

  it('cannot overlap itself: while a run holds the lock, another start exits 3', async () => {
    const held = acquireLock(lockDir, '${n.kebab}', { ttlMs: 60_000 })
    try {
      expect((await run()).code).toBe(JOB_EXIT.LOCKED)
    } finally {
      held?.release()
    }
    expect((await run()).code).toBe(JOB_EXIT.OK)
  })
})
`

  const doc = `---
name: ${project}-job-${n.kebab}
description: Scheduler registration of the ${n.kebab} job of ${project}
---
# Job \`${n.kebab}\` — register it with the scheduler

The project schedules nothing itself. Add this entry to the scheduler's job registry (pulse: \`registry/jobs.json\`),
fill in the placeholders, then let the scheduler pick it up:

\`\`\`json
{
  "id": "${project}-${n.kebab}",
  "category": "app",
  "name": "${project}: ${n.kebab}",
  "schedule": "<cron expression, e.g. 15 3 * * *>",
  "device": "<host that runs ${project}>",
  "command": "${command}",
  "timeout": 660,
  "notify": "fail",
  "enabled": true
}
\`\`\`

- \`timeout\` (seconds) must be above the job's own deadline (\`timeoutMs\` in \`src/jobs/${n.kebab}.ts\`, 10 minutes by
  default) so the job reports its own timeout (exit 4) instead of being killed from outside.
- Exit codes: \`0\` ok · \`1\` failed · \`2\` unknown job · \`3\` the previous run is still going (the schedule is tighter than
  the run time — widen it) · \`4\` timed out. Anything but 0 is a failure for the scheduler.
- The job needs the app's environment (\`DATABASE_URL\`, \`JOB_LOCK_DIR\`)${container ? ' — inside the running api container it has it already' : ' — the command loads `.env` of the api directory'}.
- Try it by hand first: \`${command}\` and check the two JSON lines (\`job start\`, \`job end\`).
- Removing the job: disable the entry in the scheduler first, then delete the code.
`

  return {
    files: [
      { path: `src/jobs/${n.kebab}.ts`, content: job },
      { path: `tests/job-${n.kebab}.spec.ts`, content: test },
      { part: 'project', path: `.memory/docs/guides/job-${n.kebab}.md`, content: doc },
    ],
    patches: [
      { path: 'src/jobs/index.ts', anchor: 'job-imports', insert: `import { ${n.camel} } from './${n.kebab}.js'` },
      { path: 'src/jobs/index.ts', anchor: 'jobs', insert: `'${n.kebab}': ${n.camel},` },
    ],
    next: [
      `${apiDir || '.'}: write the job in src/jobs/${n.kebab}.ts and assert what it does in tests/job-${n.kebab}.spec.ts (keep the idempotence and overlap tests)`,
      'npm run gate',
      `register it with the scheduler: .memory/docs/guides/job-${n.kebab}.md (nothing is scheduled until you do)`,
    ],
  }
}
