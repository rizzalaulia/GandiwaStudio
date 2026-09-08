# Deployment Contract — bejo2-vnic

**Target:** `bejo2-vnic`  
**Tailscale IP:** `100.98.114.115`  
**Status:** Deployment design locked; application not deployed  
**Last verified:** 8 September 2026

## Host Role

- `bejo1-oracle`: development workspace dan VS Code Remote SSH.
- `bejo2-vnic`: production host Gandiwa Studio.

Source development tidak dilakukan langsung di production. Promotion mengikuti review, commit, CI, release/tag, lalu deployment manual.

## Verified Host Inventory

```text
OS             Ubuntu 24.04.4 LTS
Architecture   ARM64 / aarch64
CPU            1 vCPU
RAM            5.8 GiB (sekitar 3.7 GiB available saat audit)
Swap           none
Root disk       96 GiB (sekitar 92 GiB available saat audit)
Docker          29.7.2, active
Docker Compose  5.5.0
Nginx           active
SSH             active
```

Existing services occupy:

```text
22       SSH
80/443   Nginx; existing komputermu.my.id virtual host
3000     existing application
```

Gandiwa tidak boleh mengambil port 3000 atau mengganti virtual host `komputermu.my.id`.

## Production Topology

```text
Dedicated Gandiwa HTTPS hostname (TBD)
             │
             ▼
Host Nginx :443
├── /          static frontend
└── /api/      proxy to 127.0.0.1:8010
                        │
                 Docker Compose
                 ├── api
                 └── worker (concurrency 1)
                         │
                    SQLite + temp artifacts
                         ├── 9Router over Tailscale
                         └── fal.ai over internet
```

A dedicated hostname and certificate must be selected before public/browser production smoke testing. Plain HTTP over a Tailscale IP is not accepted as the production browser origin because File System Access API requires a secure context. Do not alter Tailscale Serve or the existing Nginx TLS configuration until the hostname/access-mode decision is explicit.

## Filesystem Layout

```text
/opt/gandiwa/source/                 release source/build context
/opt/gandiwa/current/                active release symlink or active checkout
/etc/gandiwa/gandiwa.env             production secrets/config (not Git)
/var/lib/gandiwa/gandiwa.sqlite3     durable database/queue
/var/cache/gandiwa/artifacts/        temporary artifacts
/var/www/gandiwa/                    static frontend output
/etc/nginx/sites-available/gandiwa   dedicated virtual host
```

Recommended ownership:

```text
/etc/gandiwa/gandiwa.env   root:gandiwa 0640
/var/lib/gandiwa           gandiwa:gandiwa
/var/cache/gandiwa         gandiwa:gandiwa
/var/www/gandiwa           root:root, readable by Nginx
```

Exact UID/GID handling must be explicit in Compose; containers must not run as root without a documented reason.

## Compose Services

### `api`

- same application image as worker;
- one Uvicorn process for MVP;
- internal port 8000 mapped only to `127.0.0.1:8010`;
- healthcheck uses `/api/v1/health`;
- persistent SQLite and artifact mounts;
- restart policy `unless-stopped`.

### `worker`

- same application image;
- separate command for queue consumer;
- one active job;
- same SQLite/artifact mounts;
- no public port;
- restart policy `unless-stopped`.

No Redis, Celery, PostgreSQL, Node server, or local AI model runs in production MVP.

## Nginx Contract

Nginx:

- serves Vite build as static files;
- falls back to `index.html` for client routing;
- proxies only `/api/` to `127.0.0.1:8010`;
- terminates TLS;
- sets upload/body/time limits deliberately;
- uses streaming/no buffering where artifact response requires it;
- adds a CSP compatible with rasterized/sandboxed SVG preview;
- never serves raw uploaded SVG or temporary artifacts from its document root;
- forces authorized artifact downloads to use attachment + nosniff headers;
- sets secure headers and trusts forwarded headers only from the loopback Nginx hop;
- does not expose the API container directly.

Actual server name and certificate command remain placeholders until the owner selects the hostname.

## Environment Contract

Production starts from `.env.production.example`, copied outside the repository to `/etc/gandiwa/gandiwa.env`.

Required categories:

- environment, public origin, and trusted hosts;
- session/CSRF secret and secure cookie flags;
- SQLite and artifact paths;
- queue polling, lease, heartbeat, retry, and retention;
- upload/artifact limits;
- selected connector URLs and credentials;
- log level and redaction posture.

Real values must never appear in Git, image layers, Compose YAML, build arguments, shell history, or deployment logs.

## Resource Guardrails

Given 1 vCPU:

- worker concurrency remains `1`;
- Uvicorn process count remains `1` until measurements justify change;
- AI inference runs at providers, never locally;
- heavy SVG/raster tasks are bounded by timeout, dimensions, file size, and node count;
- Docker images must support `linux/arm64`;
- Compose must set non-root UID/GID, `no-new-privileges`, dropped capabilities, no privileged mode/Docker socket, bounded PID/temp, and measured CPU/RAM limits;
- add a 2 GiB swap file before production as OOM protection, but do not treat swap as capacity;
- reserve capacity for Nginx, Docker, Tailscale, and the existing application;
- reject/backpressure new jobs when queue depth, free disk, or available memory crosses configured thresholds;
- monitor disk because temporary generated artifacts can grow silently.

## Manual Deployment Flow

Deployment is not executed by a push alone.

```text
1. Develop and test on bejo1-oracle.
2. Owner reviews changes via VS Code Remote SSH.
3. After explicit approval: commit, push branch, PR, and CI.
4. Merge requires separate approval.
5. Create/select a release commit or tag.
6. On bejo2: fetch the exact release and verify SHA.
7. Build ARM64-compatible images and frontend static output.
8. Back up SQLite and environment configuration.
9. Run Alembic migration as a one-shot release step.
10. Start/recreate API and worker.
11. Publish static frontend atomically.
12. Validate Nginx configuration, then reload.
13. Verify health, readiness, queue claim/recovery, logs, and browser flow.
```

Alembic migrations must not be hidden in every container startup. A failed migration stops the release and triggers rollback; never run destructive reset commands on production data.

## Deployment Acceptance Gate

A release is successful only after real checks confirm:

- exact expected Git SHA/image is running;
- HTTPS and application authentication work;
- `/api/v1/health` and `/api/v1/ready` pass;
- API port is not publicly exposed;
- one synthetic queued job reaches terminal success;
- restart recovery does not duplicate provider dispatch;
- browser can create/open a local project folder;
- temporary artifact download and cleanup work;
- no secret appears in frontend bundle or logs;
- existing `komputermu.my.id` remains healthy.

## Rollback

- retain the previous application image/static release;
- back up SQLite before schema migration;
- rollback application first when schema is backward compatible;
- use a tested Alembic downgrade only when explicitly supported;
- restore database backup if migration is not reversible;
- verify both Gandiwa and the existing Nginx site after rollback.

## Current Blockers Before First Production Deployment

- application code does not yet exist;
- dedicated Gandiwa hostname/access mode has not been selected;
- application identity/bootstrap mechanism has not been selected or implemented;
- bejo2 currently has no swap;
- Compose/Nginx manifests and backup scripts have not yet been implemented or tested.

These are deployment gates, not permission to expand product scope.