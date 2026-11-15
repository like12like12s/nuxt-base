## Deploy — container

```
docker/deploy.conf           app name, service dirs, deploy host/user, smoke URL — the only per-app deploy config
docker/docker-compose.yml    what runs on the deploy host (synced there by the deploy script)
docker/env.example           template of the .env next to the compose file on the deploy host (tags, ports, secrets)
Dockerfile, .dockerignore    one per service dir — locked kit files, do not edit
docker/deploy-docker.sh      NOT generated: copy it verbatim from your docker-node template (it is kept identical
                             across projects by that template's own check) — it reads deploy.conf
```

```bash
docker/deploy-docker.sh                   # gate -> build -> push -> deploy -> wait healthy -> smoke
docker/deploy-docker.sh --build-only      # gate -> build -> push
docker/deploy-docker.sh --rollback <tag>
docker build -t {{kit.name}}-local <service dir>   # local image build, no registry needed
```

- Images are `<registry>/{{kit.name}}-<service>:<tag>`; the registry in `docker-compose.yml` is `{{kit.registry}}`.
- The deploy runs `npm run gate` first and refuses a dirty tree. Each service dir needs a committed `package-lock.json`.
- No fixed container names: compose names them `<project>-<service>-1`. Run commands through compose on the deploy
  host (`cd /srv/{{kit.name}} && docker compose exec api …`). Two stages on one host = two directories, the second
  with `COMPOSE_PROJECT_NAME={{kit.name}}-<stage>` and its own host ports in `.env`.
- `GET /version` of a deployed API reports the commit and the build time without any change to the deploy script:
  the compose file hands the container its image tag (`APP_IMAGE_TAG: ${API_TAG}`), whose trailing commit
  (`20260131-235959-abc1234`) becomes `commit`, and the Dockerfile stamps the build time into the image
  (`builtAt`). A deploy script that wants exact values passes two build args, which win over both:
  `docker build --build-arg APP_COMMIT=$(git rev-parse HEAD) --build-arg APP_BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) …`
<!-- @kit:if kind:fullstack -->
- Only the UI has a host port (`UI_PORT`). The API is not published: the UI server reaches it as `http://api:3000`
  over the compose network, so nobody can call it around the UI. Check it with `docker compose ps` (health) or
  `docker compose exec api wget -qO- http://127.0.0.1:3000/health/ready`; `docker-compose.yml` has a commented
  loopback-only `ports:` block for the rare caller outside compose.
<!-- @kit:end -->
- Containers run as `node`, have a HEALTHCHECK (API: `/health/live`, UI: `/`), and write data only under `./data`.
- A service dir that is a symlink to the repo root (`api -> .` / `web -> .`) is how a single-app repo fits the
  one-dir-per-image layout.
