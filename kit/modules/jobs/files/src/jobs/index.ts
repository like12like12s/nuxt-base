// Every job of {{kit.name}}, by name. `scaffold add job <name>` writes src/jobs/<name>.ts and registers it here.
// Run one: `npm run job -- <name>` (dev) · `node dist/jobs/run.js <name>` (built). Nothing here schedules anything:
// the scheduler entry to register is in .memory/docs/guides/job-<name>.md.
import type { Schema } from '../db/schema.js'
import type { Job } from '../kit/jobs/runner.js'
// kit:anchor job-imports — `scaffold add job` adds its import above this line

export const jobs: Record<string, Job<Schema>> = {
  // kit:anchor jobs — and registers the job above this line
}
