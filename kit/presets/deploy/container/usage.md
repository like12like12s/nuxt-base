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
- Containers run as `node`, have a HEALTHCHECK (API: `/health/live`, UI: `/`), and write data only under `./data`.
- A service dir that is a symlink to the repo root (`api -> .` / `web -> .`) is how a single-app repo fits the
  one-dir-per-image layout.
