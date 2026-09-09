# Processing API and Worker

Python 3.12 FastAPI package foundation. The process probes from Issue #3 are implemented; the separate worker command remains absent until Issue #5 is implemented with tests.

## Implemented Process Probes

- `GET /api/v1/health` reports process liveness and package version without touching runtime dependencies.
- `GET /api/v1/ready` returns `200` only when the existing SQLite database passes open/read/write checks, its Alembic revision matches the application contract, the queue table is queryable, and the artifact directory supports a temporary write and cleanup.
- The database write probe is rolled back and leaves no table or row behind. On a WAL database, SQLite may still create or maintain normal `-wal`/`-shm` sidecar files.
- Unavailable responses expose boolean check names only—never paths, database URLs, secrets, or raw exceptions.

Issue #4 owns the actual SQLAlchemy models, Alembic migration, and SQLite runtime configuration; Issue #3 only verifies their expected operational contract.

## API Responsibilities

- secure single-user session and CSRF posture;
- provider/capability configuration from backend secret file/environment only;
- immutable ruleset snapshots;
- enqueue and return `job_id` without blocking on provider work;
- status, cancellation request, preflight, artifact, and export-validation endpoints;
- redacted structured logs.

## Worker Responsibilities

- one active job using SQLite priority+FIFO queue;
- lease, heartbeat, recovery, `needs_review` for unknown dispatch, and cooperative cancellation;
- exact user-selected 9Router/fal.ai calls;
- safe/idempotent retry only;
- sanitization, audit, conversion, and temporary artifact staging.

The backend never writes directly to a browser-owned project folder. Production API/worker run as separate Docker Compose services on bejo2-vnic and are exposed only through host Nginx.