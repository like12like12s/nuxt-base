## Jobs (`{{kit.apiDir}}`, module `jobs`)

```bash
scaffold add job <name>            # src/jobs/<name>.ts + its test + the scheduler entry (.memory/docs/guides/job-<name>.md)
npm run job -- --list
npm run job -- <name>              # dev (tsx)
node dist/jobs/run.js <name>       # built / in the image
```

- Exit codes, read by the scheduler: `0` ok · `1` failed · `2` unknown job · `3` already running (skipped) · `4` timed out.
- A job cannot overlap itself: one lock file per job in `JOB_LOCK_DIR` (default `./data/locks`). A lock left by a
  killed run is taken over once its owner is gone or its deadline (`timeoutMs` + 1 min) has passed.
- Logs: one JSON line at the start, one at the end (`job`, `status`, `ms`, `changed`, whatever the job returns), with
  one `traceId` for the run.
- Writes go through `audited()`: the audit actor is `job:<name>`, and a run that changes nothing writes no audit row —
  a job must be idempotent (its test runs it twice and expects zero new rows).
- Nothing is scheduled by this project. Register the job with the scheduler you use — the generated
  `job-<name>.md` holds the entry to add. Step by step: `.memory/docs/guides/playbook-add-job.md`.
