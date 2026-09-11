"""FastAPI application entrypoint and process probes."""

from __future__ import annotations

import sqlite3
import tempfile
from collections.abc import AsyncIterator
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Literal, TypedDict, cast
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from gandiwa_api.config import Settings
from gandiwa_api.raster_preflight import DEFAULT_LIMITS, inspect_raster
from gandiwa_api.security.artifacts import build_artifact_download_response
from gandiwa_api.security.csrf import (
    SESSION_COOKIE_NAME,
    CSRFProtectionMiddleware,
    generate_csrf_token,
    set_csrf_cookie,
    verify_session_token,
)
from gandiwa_api.security.providers import ProviderInfo, get_configured_providers

try:
    APP_VERSION = version("gandiwa-api")
except PackageNotFoundError:  # pragma: no cover - editable and wheel installs provide metadata
    APP_VERSION = "0.0.0"

# Application-owned contract: Issue #4 must make the Alembic head match this value.
# Never move this value to environment configuration, which could approve a stale schema.
EXPECTED_SCHEMA_REVISION = "0002"
MVP_VERSION = "mvp-1.0"
SQLITE_URL_PREFIX = "sqlite:///"

WorkerPublicStatus = Literal["idle", "running", "stopped", "unavailable"]


class WorkerStatusPayload(TypedDict):
    status: WorkerPublicStatus
    heartbeat_at: str | None


app = FastAPI(title="Gandiwa Studio API", version=APP_VERSION)

# Explicit origins only: credentials/cookies are never paired with a wildcard origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=Settings().ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-CSRF-Token"],
)
app.add_middleware(
    CSRFProtectionMiddleware,
    exempt_paths={
        "/api/v1/health",
        "/api/v1/ready",
        "/api/v1/auth/csrf",
        "/api/v1/providers",
    },
)


def _sqlite_path(database_url: str) -> Path | None:
    """Return a SQLite path without accepting another database scheme or URI options."""
    if not database_url.startswith(SQLITE_URL_PREFIX):
        return None

    raw_path = database_url.removeprefix(SQLITE_URL_PREFIX)
    if not raw_path or "?" in raw_path or "#" in raw_path:
        return None
    return Path(raw_path)


def _open_existing_database(database_path: Path) -> sqlite3.Connection:
    """Open an existing SQLite database read/write without creating it."""
    absolute_path = database_path.resolve(strict=True)
    uri = f"file:{quote(str(absolute_path), safe='/')}?mode=rw"
    return sqlite3.connect(uri, uri=True, timeout=2.0)


def _check_database(
    database_url: str,
    expected_revision: str,
) -> tuple[bool, bool, bool]:
    database_path = _sqlite_path(database_url)
    if database_path is None:
        return False, False, False

    try:
        with _open_existing_database(database_path) as connection:
            quick_check = connection.execute("PRAGMA quick_check").fetchone()
            if quick_check != ("ok",):
                return False, False, False

            try:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute('CREATE TABLE "__gandiwa_readiness_probe" (id INTEGER)')
            except sqlite3.Error:
                connection.rollback()
                return False, False, False

            database_ok = True
            try:
                revisions = connection.execute("SELECT version_num FROM alembic_version").fetchall()
                migration_ok = revisions == [(expected_revision,)]
            except sqlite3.Error:
                migration_ok = False

            try:
                connection.execute('SELECT 1 FROM "generation_job" LIMIT 1').fetchone()
                queue_ok = True
            except sqlite3.Error:
                queue_ok = False
            finally:
                connection.rollback()
    except (OSError, sqlite3.Error):
        return False, False, False

    return database_ok, migration_ok, queue_ok


def _check_artifact_directory(artifact_dir: Path) -> bool:
    """Prove the artifact directory supports a real temporary write and cleanup."""
    if not artifact_dir.is_dir():
        return False

    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=".gandiwa-readiness-",
            dir=artifact_dir,
        ) as probe:
            probe.write(b"ready")
            probe.flush()
    except OSError:
        return False
    return True


@app.get("/api/v1/health")
def get_health() -> dict[str, str]:
    """Report process liveness without inspecting runtime dependencies."""
    return {"status": "ok", "version": APP_VERSION}


@app.get("/api/v1/ready")
def get_ready() -> JSONResponse:
    """Report whether durable runtime dependencies satisfy their contracts."""
    current_settings = Settings()
    database_ok, migration_ok, queue_ok = _check_database(
        current_settings.DATABASE_URL,
        EXPECTED_SCHEMA_REVISION,
    )
    checks = {
        "database": database_ok,
        "migration": migration_ok,
        "queue": queue_ok,
        "artifacts_dir": _check_artifact_directory(current_settings.ARTIFACT_DIR),
    }
    is_ready = all(checks.values())

    return JSONResponse(
        status_code=(status.HTTP_200_OK if is_ready else status.HTTP_503_SERVICE_UNAVAILABLE),
        content={
            "status": "ready" if is_ready else "unavailable",
            "checks": checks,
        },
    )


def _read_worker_state(
    database_url: str,
    stale_after_seconds: int,
) -> WorkerStatusPayload:
    """Read worker state and fail closed when a running heartbeat is stale."""
    database_path = _sqlite_path(database_url)
    unavailable = WorkerStatusPayload(status="unavailable", heartbeat_at=None)
    if database_path is None:
        return unavailable
    try:
        with _open_existing_database(database_path) as connection:
            row = connection.execute(
                "SELECT status, heartbeat_at FROM worker_state WHERE id = 1"
            ).fetchone()
    except (OSError, sqlite3.Error):
        return unavailable
    if row is None:
        return unavailable

    raw_status = str(row[0])
    if raw_status not in {"idle", "running", "stopped"}:
        return unavailable
    worker_status = cast(WorkerPublicStatus, raw_status)
    heartbeat_text = str(row[1]) if row[1] is not None else None
    if worker_status == "running":
        try:
            if heartbeat_text is None:
                return unavailable
            heartbeat = datetime.fromisoformat(heartbeat_text)
            if heartbeat.tzinfo is None:
                heartbeat = heartbeat.replace(tzinfo=UTC)
            stale_before = datetime.now(UTC) - timedelta(seconds=stale_after_seconds)
            if heartbeat.astimezone(UTC) < stale_before:
                return {"status": "unavailable", "heartbeat_at": heartbeat_text}
        except ValueError:
            return unavailable

    return {"status": worker_status, "heartbeat_at": heartbeat_text}


@app.get("/api/v1/status")
def get_status() -> JSONResponse:
    """Return the minimal public runtime contract needed by the first UI shell."""
    current_settings = Settings()
    health = get_health()
    worker = _read_worker_state(
        current_settings.DATABASE_URL,
        current_settings.WORKER_HEARTBEAT_STALE_SECONDS,
    )
    database_ok, migration_ok, queue_ok = _check_database(
        current_settings.DATABASE_URL,
        EXPECTED_SCHEMA_REVISION,
    )
    ready_checks = {
        "database": database_ok,
        "migration": migration_ok,
        "queue": queue_ok,
        "artifacts_dir": _check_artifact_directory(current_settings.ARTIFACT_DIR),
    }
    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={
            "version": health["version"],
            "mvp_version": MVP_VERSION,
            "backend": {
                "health": health["status"],
                "ready": all(ready_checks.values()),
                "checks": ready_checks,
            },
            "worker": worker,
        },
    )


@app.get("/api/v1/auth/csrf")
def get_csrf_token() -> JSONResponse:
    """Provide a signed CSRF token and set the matching client cookie."""
    current_settings = Settings()
    token = generate_csrf_token(current_settings.SESSION_SECRET)
    response = JSONResponse(content={"csrf_token": token})
    set_csrf_cookie(response, token, secure=current_settings.SECURE_COOKIES)
    return response


@app.get("/api/v1/providers")
def list_providers() -> list[ProviderInfo]:
    """List available AI connectors configured on backend without exposing secrets."""
    current_settings = Settings()
    return get_configured_providers(current_settings)


async def read_limited_request_body(
    stream: AsyncIterator[bytes], *, max_bytes: int
) -> tuple[bytes, bool]:
    """Read no more than max_bytes plus one sentinel byte from an untrusted stream."""
    source = bytearray()
    async for chunk in stream:
        remaining = max_bytes + 1 - len(source)
        source.extend(chunk[:remaining])
        if len(source) > max_bytes:
            return bytes(source), True
    return bytes(source), False


@app.post("/api/v1/raster/preflight")
async def preflight_raster(
    content_type: Literal["photo", "illustration"], request: Request
) -> JSONResponse:
    """Inspect a PNG/JPEG request body in memory only; no browser file is persisted."""
    source, _ = await read_limited_request_body(
        request.stream(), max_bytes=DEFAULT_LIMITS.max_bytes
    )
    report = inspect_raster(
        bytes(source),
        declared_mime_type=request.headers.get("content-type", ""),
        filename=request.headers.get("x-upload-filename", ""),
        content_type=content_type,
    )
    return JSONResponse(content=asdict(report))


@app.get("/api/v1/artifacts/{filename}/download")
def download_artifact(filename: str, request: Request) -> FileResponse:
    """Download an artifact only for an authenticated session, always as an attachment.

    Identity/session issuance is deliberately outside Issue #7. Until that MVP decision is
    implemented, requests without a server-signed HttpOnly session fail closed with 401.
    """
    current_settings = Settings()
    if not verify_session_token(
        request.cookies.get(SESSION_COOKIE_NAME), current_settings.SESSION_SECRET
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )
    return build_artifact_download_response(filename, current_settings.ARTIFACT_DIR)
