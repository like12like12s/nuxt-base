## Database (`{{kit.apiDir}}`, module `db` — default `{{kit.db}}`)

```bash
npm run db:migrate -- up        # backup -> apply pending migrations -> verify database == code
npm run db:migrate -- down      # revert the newest migration (after a backup)
npm run db:migrate -- status
npm run db:seed                 # deterministic, safe to repeat
npm run db:check                # exit 0 only when database == code (what /health/ready and the deploy ask)
```

- `DATABASE_URL` picks the engine at run time: `sqlite:./data/{{kit.name}}.db` or `mysql://<user>:<password>@<host>:3306/<database>`.
  The code, the migrations and the tests are the same for both.
- Migrations live in `src/db/migrations/` (Kysely schema builder, every one with `down()`), listed in `index.ts`.
  Never edit one that has shipped. Types of the tables: `src/db/schema.ts`. Column rules (ids, ISO timestamps, JSON as
  text): header of `src/kit/db/schema.ts`.
- Base tables: `users`, `audit`, `service_tokens`. Business tables get `id / createdAt / updatedAt / deletedAt`
  (`standardColumns`), are soft-deleted (`softDeleted()`), and every write goes through `audited()` so the audit row
  commits with it (`src/kit/db/repo.ts`).
- Resilience: connect and statement deadlines (`DB_CONNECT_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS`), `DB_RETRIES` extra
  attempts on transient errors only (deadlock, lock wait, connection refused; a lost connection is replayed for reads,
  not for writes). `withTransaction()` replays a whole transaction on a deadlock. The pool closes on SIGTERM.
- Backup before migrate: SQLite — a verified snapshot in `data/backups/` (automatic; a backup that fails or does not verify stops the migration, exit 3). MySQL — set `DB_BACKUP_CMD` to your dump
  command; without it `db:migrate` refuses (exit 3) unless you pass `--no-backup` / `DB_MIGRATE_NO_BACKUP=1` because
  the backup was taken another way. Register the database with your backup job (`scaffold new --json` lists it under
  `backup`).
- In a built image: `node dist/db/cli.js check|migrate up|seed|predeploy`.
- Container deploy: the compose file has a one-shot `db-check` service (`node dist/db/cli.js predeploy`) that the API
  container depends on — the API starts only when the database matches the image. With `DB_MIGRATE_ON_DEPLOY=1` (the
  default in `docker/env.example`) it applies pending migrations first, after the backup. It fails closed: if it exits
  non-zero the deploy fails and no API container runs (compose has already removed the previous one) — migrate, or
  roll back to the previous tag. `docker compose run --rm db-check` checks without replacing anything.
