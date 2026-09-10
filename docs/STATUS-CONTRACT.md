# Runtime Status Contract

## Endpoint

The Stage 1 web shell fetches `GET /api/v1/status` from the same origin. In development, Vite proxies `/api` to `http://127.0.0.1:8000`; production routes the same path through the host reverse proxy.

The endpoint always returns HTTP `200` when the API process is alive. It distinguishes dependency failure through `backend.ready`, so the shell can render an actionable state rather than treating a healthy-but-unready process as a network outage.

## Public payload

```json
{
  "version": "0.0.0",
  "mvp_version": "mvp-1.0",
  "backend": {
    "health": "ok",
    "ready": true,
    "checks": {
      "database": true,
      "migration": true,
      "queue": true,
      "artifacts_dir": true
    }
  },
  "worker": {
    "status": "running",
    "heartbeat_at": "2026-09-09T06:00:00+00:00"
  }
}
```

`worker.status` is one of `idle`, `running`, `stopped`, or `unavailable`. A `running` worker with a missing, malformed, or older-than-`GANDIWA_WORKER_HEARTBEAT_STALE_SECONDS` heartbeat is returned as `unavailable`. This is fail-closed: an old database row never appears as a live worker.

The payload never returns provider credentials, database URLs, filesystem paths, raw exceptions, private assets, job parameters, or queue contents.

## Local Stage 1 runbook

1. Copy `.env.example` into an untracked environment file, export its `GANDIWA_*` values into the API/worker process environment (or configure them in the service manager), and create the configured artifact directory. The Python process does not automatically load `.env` files.
2. Apply the explicit schema migration in that same environment: `corepack pnpm migrate`.
3. In one terminal start the API: `uv run --project apps/api uvicorn gandiwa_api.main:app --host 127.0.0.1 --port 8000`.
4. In another terminal start the separate single-concurrency worker: `corepack pnpm worker`.
5. Start the web app: `corepack pnpm --filter @gandiwa/web dev`.
6. Open the Vite address through VS Code Remote SSH port forwarding and inspect `GET /api/v1/status`.

Create Project dan Open Project tersedia pada Tahap 2 melalui File System Access API. Open/reopen memvalidasi manifest secara read-only dan memulihkan permission read hanya dari tindakan pengguna; pemeriksaan perubahan eksternal menahan overwrite dan meminta Reload, download copy, atau Cancel. No generation action exists in this shell.
