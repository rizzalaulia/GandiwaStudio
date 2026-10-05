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

## Backup, restore, and rollback drill (Issue #31)

Run this drill on a **disposable copy** before a production release. It uses SQLite's
online backup API, encrypts the archive with AES-256-GCM before writing to the
operator-provided encrypted off-host destination, and never copies a live WAL database
file directly. The 32-byte key is an independent root-owned secret (mode `0600`); it is
not the session secret and is never placed in Git, shell history, Compose, or logs.

Set a release identity to the immutable digest being protected. Retain encrypted bundles
for the documented recovery window in an encrypted off-host destination. Initial
operational targets, to revise only from drill evidence: **RPO ≤ 24 hours** (or one
pre-deploy backup) and **RTO ≤ 60 minutes**. Monitor the age of the newest verified
manifest and alert before it exceeds 24 hours.

```bash
export RELEASE_ID='REGISTRY/GandiwaStudio-api@sha256:APPROVED_DIGEST'
export BACKUP_KEY=/etc/gandiwa/backup.key
python3 deploy/bejo2/backup-drill.py backup \
  --database /srv/gandiwa/data/gandiwa.sqlite3 \
  --artifacts /srv/gandiwa/artifacts \
  --destination /mnt/encrypted-offhost/gandiwa \
  --key-file "$BACKUP_KEY" \
  --release-id "$RELEASE_ID" \
  --retention-hours 168
```

Copy both printed bundle paths to the protected off-host destination if it is not already
mounted there. Record the manifest checksum, release digest, completion time, elapsed
backup/restore time, and observed artifact count as drill evidence; do not include keys,
provider secrets, or private artifact contents. Check backup age from a read-only timer or
monitor (exit `0` fresh, `1` stale, `2` invalid/missing manifest):

```bash
python3 deploy/bejo2/check-backup-age.py \
  --directory /mnt/encrypted-offhost/gandiwa \
  --max-age-hours 24
```

The monitor reads only manifests; it does not decrypt any archive or access the backup key.

### Restore verification — staging only

Never restore over `/srv/gandiwa` first. Choose a new disposable staging path on the
same filesystem, verify the archive and its manifest, and reconcile active jobs. The
reconciliation changes `running`, `waiting_provider`, and `processing` to
`needs_review` with their remote IDs retained; it performs **zero** provider calls and
never redispatches an uncertain paid request.

```bash
python3 deploy/bejo2/backup-drill.py restore-verify \
  --archive /mnt/encrypted-offhost/gandiwa/BUNDLE.gandiwa \
  --manifest /mnt/encrypted-offhost/gandiwa/BUNDLE.manifest.json \
  --key-file "$BACKUP_KEY" \
  --staging /srv/gandiwa-restore-drill/STAGING \
  --uid 10001 --gid 10001 \
  --expected-release-id "$RELEASE_ID" \
  --expected-revision 0003
```

The command validates archive/database checksums, every durable artifact path and hash,
ownership, `PRAGMA quick_check`, `PRAGMA integrity_check`, and the **target** Alembic
revision before sealing a private HMAC-authenticated receipt. Staging is traversed
no-follow (every ancestor and member must be an owned real directory/regular file; no
symlinks). Do not mutate staging after this command: rollback repeats that no-follow
tree check and rechecks the sealed release ID/revision, database checksum,
artifact hashes, and integrity immediately before any replacement. Migration failure,
missing/changed artifact, invalid integrity result, a modified/forged receipt, or a
`waiting_provider`/`processing` job lacking its required remote ID is a hard stop.
`running` may lack a remote ID because it can be pre-dispatch; all active jobs become
`needs_review` and are never redispatched. Reconcile every `needs_review` job manually
against the provider before resuming intake.

### Data rollback — explicit, service-stopped swap

Code rollback restores the prior immutable API digest and static release. Schema/data
rollback is **not** `alembic downgrade` by default. It is allowed only from a verified
staging restore compatible with the code release being returned to service.

1. Stop intake and both API/worker services; verify they are stopped with `docker compose ps`.
2. Retain the current `/srv/gandiwa/data` and `/srv/gandiwa/artifacts` paths; the command
   renames them to timestamped `pre-rollback` paths rather than deleting them.
3. Invoke the same-filesystem directory replacements only after the explicit acknowledgement. Each rename is atomic, but POSIX cannot make the two data/artifact renames one cross-directory transaction; keep services stopped and preserve the timestamped previous paths. If the host fails mid-swap, do not restart services—inspect both current and `pre-rollback` paths, then complete recovery manually from the verified receipt.

```bash
# The staging path must share the /srv/gandiwa filesystem; the tool rejects a cross-device swap.
```

4. Invoke the replacement only after the explicit acknowledgement. The tool verifies the
   sealed receipt with the root-owned backup key and compensates all completed renames if
   any later rename fails; if compensation fails too, it keeps services stopped and reports
   the paths requiring manual recovery.

```bash
python3 deploy/bejo2/backup-drill.py rollback-apply \
  --staging /srv/gandiwa-restore-drill/STAGING \
  --data-dir /srv/gandiwa/data \
  --artifacts-dir /srv/gandiwa/artifacts \
  --key-file "$BACKUP_KEY" \
  --expected-release-id "$RELEASE_ID" \
  --expected-revision 0003 \
  --uid 10001 --gid 10001 \
  --services-stopped
```

5. Start the compatible API/worker release, run the health/readiness check, and execute a
   synthetic queue job that does not call a paid provider. Keep pre-rollback paths until
   the observation window completes.

## Rollback boundary

Never point old code at a newer schema without a proven compatibility or restore
procedure. The verified Issue #31 backup/restore drill above is required before a
production migration.
