# Operations — Gandiwa Studio MVP

**Status:** Planned operational contract; application not deployed

## Services

Production on `bejo2-vnic` consists of:

```text
host nginx
Docker Compose: api + worker
SQLite durable queue/database
temporary artifact storage
```

The frontend is static. There is no permanent Node process, Redis, Celery, PostgreSQL, or local AI inference.

## Health Model

- **Liveness:** process responds without asserting provider availability.
- **Readiness:** database, migration version, artifact path, and queue access are valid.
- Provider health is reported separately; a provider outage must not prevent opening a local project.

## Logs

- Container logs go to Docker logging/journald according to deployment configuration.
- Never log Authorization headers, cookies, API keys, unredacted credentials, or raw private assets.
- Every background operation has `job_id`; provider calls also record a redacted provider request ID.
- User-facing errors contain an actionable code and `job_id`, not a secret-bearing traceback.
- Configure log rotation and bounded retention before production.
- Monitor worker heartbeat, queue depth/oldest age, failure rate, `needs_review`, SQLite WAL size/lock errors, artifact/disk usage, RAM/OOM, backup age, TLS renewal, and 9Router reachability.

## Queue Operations

Normal state flow:

```text
QUEUED → RUNNING → WAITING_PROVIDER → PROCESSING → SUCCEEDED
                    ↘ NEEDS_REVIEW
```

Terminal alternatives:

```text
FAILED | CANCELLED
```

Operational rules:

- one active worker/job;
- priority then FIFO;
- lease and heartbeat detect abandoned work;
- expired lease enters recovery, not blind redispatch;
- unknown provider-dispatch outcome requires review;
- cancellation is cooperative;
- retry is bounded, backoff-aware, and only used when idempotency is known.

## Temporary Artifact Retention

- Artifacts are temporary until the browser downloads and writes them into the user-owned project folder.
- Each artifact has checksum, size, creation time, expiry, and owning job.
- Cleanup removes expired files and stale database records safely.
- Retention duration is configured; the UI must display expiry.
- Cleanup must not delete active-job artifacts.

## Data Ownership and Backup

| Data | Source of truth | Durable | Backup posture |
|---|---|---:|---|
| Project assets/manifest | User-owned local project folder | Yes | User responsibility; outside server backup |
| Creative cache/index | SQLite, derivable from manifest | No | May be rebuilt |
| Provider config references | SQLite + backend environment | Yes | SQLite + encrypted secret backup |
| Queue/job/events/provenance | SQLite | Yes | Consistent SQLite backup |
| Moderation feedback | SQLite/project export when implemented | Yes | Consistent SQLite backup |
| Unretrieved completed artifact | Backend artifact store until expiry | Temporarily | Retain with matching DB snapshot during recovery window |
| Retrieved/expired temp artifact | Backend cache | No | Do not preserve as only user copy |

Back up:

```text
/var/lib/gandiwa/gandiwa.sqlite3
unretrieved artifacts required by the chosen recovery window
/etc/gandiwa/gandiwa.env (separate encrypted/restricted backup)
release identifier and deployment configuration
```

SQLite runs with `foreign_keys=ON`, WAL, configured `busy_timeout`, explicit synchronous/checkpoint policy, and monitored WAL size. Backup must use the SQLite online backup API/`.backup` or a controlled service stop, never an unsafe copy of only the main file while WAL writes are active. Before production, define and test RPO, RTO, encrypted off-host destination, retention, backup-age monitoring, and a disposable restore drill.

Restore stops intake/API/worker, restores ownership and matching artifacts/config, runs `quick_check`/`integrity_check`, reconciles `RUNNING`/`WAITING_PROVIDER` jobs against remote IDs without blind redispatch, applies the compatible migration, then verifies readiness and a synthetic queue job.

## Update

1. Identify exact approved release SHA/tag.
2. Run pre-deployment backup.
3. Build/pull ARM64 image.
4. Run migration explicitly.
5. Recreate API and worker.
6. publish frontend atomically.
7. validate Nginx and reload.
8. run health and smoke tests.
9. retain rollback artifacts until observation completes.

## Security Maintenance

- Rotate provider/session secrets after suspected exposure.
- Review Dependabot PR diffs and upstream release notes; never auto-merge major upgrades.
- Keep container base images and GitHub Actions pinned/reviewed according to supply-chain policy.
- Preserve least privilege on secret, database, and artifact directories.
- Review Tailscale ACL and Nginx exposure independently from application authentication.

## Capacity

Initial bejo2 guardrails:

```text
1 API process
1 worker process
1 active job
bounded upload/artifact size
bounded SVG nodes and raster dimensions
2 GiB swap recommended before production
```

Scale only after measured queue delay, lock contention, memory, CPU, and artifact growth justify an ADR.

## Incident Checklist

### API unavailable

- verify container/service state;
- inspect redacted logs by time/job ID;
- verify SQLite/artifact permissions and free disk;
- verify Nginx upstream and health endpoint;
- do not reset the database as a troubleshooting shortcut.

### Job stuck

- inspect status, lease, heartbeat, attempt count, and remote job ID;
- query provider state when a remote ID exists;
- do not requeue a possibly accepted paid generation request blindly;
- mark/manual-recover according to idempotency evidence.

### Disk pressure

- stop accepting new large jobs if threshold is crossed;
- clean only expired temporary artifacts through the supported cleanup path;
- retain SQLite and user-retrieval evidence;
- investigate retention or failed downloads before adding capacity.

### Secret exposure

- disable/rotate the affected credential first;
- preserve redacted evidence;
- remove secret from all reachable history/artifacts;
- assess unauthorized usage;
- publish a security advisory when open-source users are affected.

## Known Limits

- single-user and single-host;
- no built-in project sync;
- browser must be open to write completed artifacts into its local folder;
- provider jobs can finish while browser is closed, but results remain temporary on backend until retrieved or expired;
- Adobe-ready status is not a guarantee of marketplace acceptance.