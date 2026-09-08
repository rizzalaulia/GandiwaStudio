# Processing API and Worker

Python 3.12 FastAPI package foundation. API routes and the separate worker command intentionally remain absent until Issues #3 and #5 are implemented with tests.

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