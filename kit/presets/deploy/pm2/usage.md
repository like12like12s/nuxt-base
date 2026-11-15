## Deploy — pm2 (through the Pilot API)

`ecosystem.config.cjs` is the single source of truth for process names, ports and env (`time: true` = timestamped logs).

```bash
npm run gate && npm run build
```

Start / stop / restart only through the Pilot API — never `pm2 start|restart` by hand (names, host and cwd then always
match the registered stage):

```bash
curl -s -X POST -H "authorization: Bearer $PILOT_TOKEN" -H 'content-type: application/json' \
  -d '{"action":"start"}' "$PILOT_URL/projects/{{kit.name}}/stages/<stageId>/services/<service>/action"
```

- First start: the service is not in the pm2 list yet, so Pilot `start` loads it from `ecosystem.config.cjs`.
- Pilot `restart` reuses the env pm2 already holds — it does **not** re-read the ecosystem file. After changing the
  port or env: action `delete`, then `start`, then `pm2 describe <name>` to confirm the new values are live.
- Ports live in the ecosystem file only (`env.PORT`); register them before the first start so they cannot collide.
- After every start: status online, last log lines clean, and one real request to the health path.
