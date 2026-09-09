# Processing API and Worker

Python 3.12 FastAPI package foundation. The process probes from Issue #3, the SQLite/Alembic foundation from Issue #4, and the worker process from Issue #5 are implemented.

## Implemented Process Probes

- `GET /api/v1/health` reports process liveness and package version without touching runtime dependencies.
- `GET /api/v1/ready` returns `200` only when the existing SQLite database passes open/read/write checks, its Alembic revision matches the application contract, the queue table is queryable, and the artifact directory supports a temporary write and cleanup.
- `GET /api/v1/status` gives the Stage 1 browser shell a non-sensitive aggregate of backend readiness and durable worker state. See [the status contract](../../docs/STATUS-CONTRACT.md).
- The database write probe is rolled back and leaves no table or row behind. On a WAL database, SQLite may still create or maintain normal `-wal`/`-shm` sidecar files.
- Unavailable responses expose boolean check names only—never paths, database URLs, secrets, or raw exceptions.

## SQLite and Alembic Foundation

- SQLAlchemy 2 typed declarative models with `DeclarativeBase`.
- `GenerationJob` durable queue model matching the ADR-0001 contract.
- `WorkerState` singleton table tracking worker process heartbeat.
- Alembic migration `0001` creates the queue and worker state schema.
- SQLite runtime: `foreign_keys=ON`, WAL, configurable busy timeout.
- Migration is an explicit command (`corepack pnpm migrate`), never automatic on startup.
- `alembic check` confirms model-migration synchronization.
- Settings reject non-SQLite URLs and invalid busy timeout values.

## Worker Process

- Packaged `gandiwa-worker` command, independent from FastAPI; run it with `corepack pnpm worker`.
- Single concurrency (fixed to 1).
- Writes heartbeat and status to `worker_state` table in SQLite.
- Handles `SIGINT` and `SIGTERM` through a graceful `stop_event` and thread join.
- No public port — pure poller, not a server.
- Heartbeat write failures remain visible in service logs without exposing them through public API responses.
- Actual job dispatch belongs to a later issue.

## API Responsibilities