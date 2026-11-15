---
name: {{kit.name}}-playbook-add-job
description: Playbook — add a scheduled job to {{kit.name}} and hand its registration to the operator
---
# Playbook: add a job

```bash
scaffold add job <name>             # kebab-case: nightly-sync   (from the project root)
```

## What it generates

```
{{kit.apiDir}}/src/jobs/<name>.ts            the job skeleton: defineJob({ name, timeoutMs, run })
{{kit.apiDir}}/tests/job-<name>.spec.ts      runs it, runs it again (no change, no audit row), proves it cannot overlap itself
.memory/docs/guides/job-<name>.md   the scheduler entry to register (command, timeout, exit codes)
```

and registers the job in `src/jobs/index.ts` (at the `kit:anchor` comments).

## What you fill in

1. `run()` in `src/jobs/<name>.ts`. Rules: idempotent; write only through `audited()` so the audit trail shows real
   changes (actor `job:<name>`); check `signal.aborted` in loops; return `{ changed }` (+ any counters worth logging).
2. `description` and `timeoutMs` of the job.
3. The test: seed data, run the job, assert what changed — keep the idempotence and the overlap test.

## Then

```bash
npm run job -- <name>               # in {{kit.apiDir}}: two JSON lines (job start / job end), exit code 0
npm run gate                        # must be green
```

Registration is **not** done by this project and not by the generator: give `.memory/docs/guides/job-<name>.md` to
whoever operates the scheduler (cron expression and host are theirs to decide). Until then the job never runs.

## Tests that must pass

- `tests/job-<name>.spec.ts` — runs, second run = `changed: 0` and zero new audit rows, a held lock = exit 3.
- Exit codes are the contract with the scheduler: `0` ok · `1` failed · `2` unknown job · `3` already running · `4` timed out.
