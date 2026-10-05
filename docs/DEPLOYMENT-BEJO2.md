# GandiwaStudio production deployment on bejo2

This runbook deploys the ARM64 production artifacts from Issue #30. It does **not** authorize changing any existing bejo2 virtual host. Always install Gandiwa as a new, dedicated site and validate the current services before and after the change.

## Runtime contract

- Architecture: `linux/arm64`.
- API host exposure: `127.0.0.1:8010` only.
- Frontend: static releases in `/var/www/gandiwa/releases` with `/var/www/gandiwa/current` as the active symlink; no Node runtime.
- Durable SQLite: `/srv/gandiwa/data/gandiwa.sqlite3` mounted at `/var/lib/gandiwa/gandiwa.sqlite3`.
- Durable artifacts: `/srv/gandiwa/artifacts` mounted at `/var/cache/gandiwa`.
- Runtime identity: numeric UID/GID `10001:10001` by default.
- Runtime containers are read-only, drop all capabilities, set `no-new-privileges`, use a private PID namespace, and have CPU/RAM/PID limits.
- The Docker socket is never mounted.
- Schema migration is an explicit one-shot command; API and worker startup never migrates implicitly.

## Build and publish immutable artifacts

On an ARM64 builder or a working multi-platform BuildKit builder:

```bash
docker build --platform linux/arm64 \
  -f deploy/bejo2/Dockerfile \
  -t REGISTRY/GandiwaStudio-api:GIT_SHA .
docker push REGISTRY/GandiwaStudio-api:GIT_SHA
docker inspect --format '{{.Os}}/{{.Architecture}} {{.Config.User}}' \
  REGISTRY/GandiwaStudio-api:GIT_SHA

docker build --platform linux/arm64 \
  -f deploy/bejo2/Dockerfile.frontend \
  -t REGISTRY/GandiwaStudio-frontend-builder:GIT_SHA .
docker push REGISTRY/GandiwaStudio-frontend-builder:GIT_SHA
```

The expected output is `linux/arm64 10001:10001`. Prefer setting `GANDIWA_IMAGE` to the registry digest (`...@sha256:...`) at deployment time.

Build the static frontend from the same checkout:

```bash
GANDIWA_IMAGE=unused \
GANDIWA_FRONTEND_BUILDER_IMAGE='REGISTRY/GandiwaStudio-frontend-builder@sha256:BUILDER_DIGEST' \
  docker compose -f deploy/bejo2/compose.yaml --profile release run --rm frontend-build
```

The one-shot builder copies the static output to `/var/www/gandiwa/releases/staging`. Empty that directory before the build, validate its contents, rename it to `/var/www/gandiwa/releases/GIT_SHA`, recreate an empty staging directory, and switch `/var/www/gandiwa/current` atomically only after validation.

## Provision host paths and secrets

Create host directories once. The owner must match the configured container UID/GID:

```bash
sudo install -d -o 10001 -g 10001 -m 0750 /srv/gandiwa/data
sudo install -d -o 10001 -g 10001 -m 0750 /srv/gandiwa/artifacts
sudo install -d -o 10001 -g 10001 -m 0755 /var/www/gandiwa/releases
sudo install -d -o 10001 -g 10001 -m 0755 /var/www/gandiwa/releases/staging
sudo install -d -o root -g root -m 0750 /etc/gandiwa
sudo install -o root -g root -m 0600 .env.production /etc/gandiwa/gandiwa.env
```

Generate `GANDIWA_SESSION_SECRET` with a cryptographic random source and retain it across restarts; the provider-key store derives its encryption key from that secret. Keep provider API keys out of the Compose file, image layers, Git, and process arguments.

## Preflight without changing production

Set the immutable image reference, then run the read-only validator:

```bash
export GANDIWA_IMAGE='REGISTRY/GandiwaStudio-api@sha256:IMAGE_DIGEST'
export GANDIWA_FRONTEND_BUILDER_IMAGE='REGISTRY/GandiwaStudio-frontend-builder@sha256:BUILDER_DIGEST'
python3 deploy/bejo2/validate-production.py \
  --image "$GANDIWA_IMAGE" \
  --frontend-image "$GANDIWA_FRONTEND_BUILDER_IMAGE" \
  --existing-vhost /etc/nginx/sites-enabled/komputermu.my.id \
  --check-host
```

The validator checks:

- ARM64 image architecture;
- effective Compose hardening and loopback-only port binding;
- absence of Docker socket mounts and published worker ports;
- port `8010` availability;
- Nginx example syntax in a disposable container;
- presence of any named existing vhost file supplied with `--existing-vhost`.

It does not start services, edit Nginx, request certificates, or touch the current database.

## Deploy with an explicit migration gate

Before migrating, complete the Issue #31 backup and rollback drill. Then:

```bash
export GANDIWA_IMAGE='REGISTRY/GandiwaStudio-api@sha256:IMAGE_DIGEST'
export GANDIWA_FRONTEND_BUILDER_IMAGE='REGISTRY/GandiwaStudio-frontend-builder@sha256:BUILDER_DIGEST'
docker compose -f deploy/bejo2/compose.yaml pull api worker migrate
docker compose -f deploy/bejo2/compose.yaml --profile migration run --rm migrate
docker compose -f deploy/bejo2/compose.yaml up -d api worker
curl --fail --silent --show-error http://127.0.0.1:8010/api/v1/health
```

Migration failure is a hard stop. Do not start the new API or worker after a failed migration.

## Install the isolated Nginx site

Copy `deploy/bejo2/nginx-gandiwa.conf.example` to a **new** filename, replace `GANDIWA_HOSTNAME`, and provision a matching certificate. Do not edit an existing vhost file and do not reuse `komputermu.my.id`.

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Verify both the new hostname and every existing protected hostname after reload. The example proxies only `/api/` to loopback and serves the frontend from `/var/www/gandiwa/current`; it does not use port `3000`.

## Post-deploy verification

```bash
docker compose -f deploy/bejo2/compose.yaml ps
curl --fail --silent https://GANDIWA_HOSTNAME/api/v1/health
ss -ltn | grep ':8010'
docker inspect gandiwa-api --format '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}}'
```

Port `8010` must be bound only to `127.0.0.1`. No worker port may be published.
Uvicorn trusts the bridge proxy headers because Docker NAT does not present host Nginx as container loopback; the host port remains loopback-only and is never exposed publicly.

## Rollback boundary

Code rollback means restoring the prior immutable image digest and prior static frontend artifact. Schema/data rollback is **not** `alembic downgrade` by default; restore the verified Issue #31 backup into an isolated path, validate it, stop API/worker, then perform the documented atomic replacement. Never point old code at a newer schema without a proven compatibility or restore procedure.
