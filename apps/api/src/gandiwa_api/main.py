"""FastAPI application entrypoint and process probes."""

from __future__ import annotations

import sqlite3
import tempfile
import uuid
from collections.abc import AsyncIterator
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Literal, TypedDict, cast
from urllib.parse import quote

import httpx
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response

from gandiwa_api.artifact_store import AccessDenied, ArtifactStore, ExpiredArtifact
from gandiwa_api.config import Settings
from gandiwa_api.creative.http_api import (
    CreativeJobRequest,
    enqueue_browser_job,
    get_owned_job,
    public_job_view,
    request_owned_cancel,
    require_owned_session,
)
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.raster_preflight import DEFAULT_LIMITS as RASTER_PREFLIGHT_LIMITS
from gandiwa_api.raster_preflight import inspect_raster
from gandiwa_api.security.artifacts import build_artifact_download_response
from gandiwa_api.security.csrf import (
    SESSION_COOKIE_NAME,
    CSRFProtectionMiddleware,
    generate_csrf_token,
    session_id_from_token,
    set_csrf_cookie,
    set_session_cookie,
)
from gandiwa_api.security.provider_key_store import ProviderKeyStore
from gandiwa_api.security.providers import ProviderInfo, get_configured_providers
from gandiwa_api.svg_preflight import DEFAULT_LIMITS as SVG_PREFLIGHT_LIMITS
from gandiwa_api.svg_preflight import inspect_svg
from gandiwa_api.svg_quarantine import SvgQuarantine

try:
    APP_VERSION = version("gandiwa-api")
except PackageNotFoundError:  # pragma: no cover - editable and wheel installs provide metadata
    APP_VERSION = "0.0.0"

# Application-owned contract: Issue #4 must make the Alembic head match this value.
# Never move this value to environment configuration, which could approve a stale schema.
EXPECTED_SCHEMA_REVISION = "0003"
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
    """List available AI connectors configured on backend without exposing secrets.

    Slice 2 (Issue #26): a key saved through Settings (encrypted store) flips
    the provider to configured without a restart — env-based config remains
    the underlying source when the store has no entry.
    """
    current_settings = Settings()
    providers = get_configured_providers(current_settings)
    store = ProviderKeyStore(current_settings)
    if store.get("fal"):
        providers = [
            p if p.id != "fal" else p.model_copy(update={"configured": True}) for p in providers
        ]
    stored_router_key = store.get("9router")
    router_providers = [provider for provider in providers if provider.id != "fal"]
    if stored_router_key and len(router_providers) == 1:
        router_id = router_providers[0].id
        providers = [
            provider
            if provider.id != router_id
            else provider.model_copy(update={"configured": True})
            for provider in providers
        ]
    return providers


# Slice 2 (Issue #26): Settings API keys — encrypted server-side store.
# Fail-closed: redacted errors, no secrets in responses, CSRF via the
# double-submit cookie; the UI's X-Companion-Token alias is honoured by the
# CSRF middleware exactly like X-CSRF-Token.

_SETTINGS_PROVIDERS = ("fal", "9router")


@app.post("/api/v1/settings/providers")
def save_provider_settings(request: Request, payload: dict[str, object]) -> JSONResponse:
    current_settings = Settings()
    entries = payload.get("providers")
    if not isinstance(entries, list) or not entries:
        raise HTTPException(status_code=400, detail="payload must contain providers[]")
    store = ProviderKeyStore(current_settings)
    for entry in entries:
        if not isinstance(entry, dict):
            raise HTTPException(status_code=400, detail="each provider entry must be an object")
        provider = entry.get("provider")
        key = entry.get("apiKey")
        if provider not in _SETTINGS_PROVIDERS:
            raise HTTPException(status_code=400, detail="unknown provider")
        if not isinstance(key, str) or not key.strip():
            raise HTTPException(status_code=400, detail="apiKey must be a non-empty string")
    for entry in entries:
        store.set(entry["provider"], entry["apiKey"].strip())
    return JSONResponse(content={"saved": [entry["provider"] for entry in entries]})


@app.get("/api/v1/settings/providers")
def provider_settings_state() -> list[dict[str, object]]:
    """Masked state only — never returns the stored key material."""
    current_settings = Settings()
    store = ProviderKeyStore(current_settings)
    states: list[dict[str, object]] = []
    for provider in _SETTINGS_PROVIDERS:
        key = store.get(provider)
        states.append(
            {
                "provider": provider,
                "configured": key is not None,
                "maskedKey": (f"****{key[-4:]}" if key and len(key) >= 4 else None),
            }
        )
    return states


@app.get("/api/v1/settings/providers/{provider}/test")
def test_provider_connection(provider: str) -> JSONResponse:
    """Compatibility alias for the real upstream authentication probe."""
    return validate_provider_key(provider)


_PROBE_REQUEST_ID = "00000000-0000-0000-0000-000000000000"
_PROBE_TIMEOUT_SECONDS = 10.0
_probe_client: httpx.Client | None = None  # test seam; None = real network


def _probe_get(url: str, headers: dict[str, str]) -> httpx.Response:
    """Bounded GET for auth probing; redirects stay off at the connector boundary."""
    if _probe_client is not None:
        return _probe_client.get(url, headers=headers, timeout=_PROBE_TIMEOUT_SECONDS)
    return httpx.get(url, headers=headers, timeout=_PROBE_TIMEOUT_SECONDS, follow_redirects=False)


def _probe_post(url: str, headers: dict[str, str]) -> httpx.Response:
    """Bounded body-less POST for fal queue-status auth probing."""
    if _probe_client is not None:
        return _probe_client.post(url, headers=headers, timeout=_PROBE_TIMEOUT_SECONDS)
    return httpx.post(url, headers=headers, timeout=_PROBE_TIMEOUT_SECONDS, follow_redirects=False)


def _probe_provider_auth(provider: str, key: str) -> tuple[bool, str | None]:
    """Ask the REAL provider whether this key authenticates — no billable job.

    fal: GET request-status of a nil UUID on the official queue origin; a valid
    key passes auth and reaches the 404 "request not found", an invalid key
    gets 401/403. 9Router: GET /v1/models on the first configured instance.
    Never returns or logs the key; network trouble is "unreachable", which is
    NOT a validity verdict.
    """
    try:
        if provider == "fal":
            # fal's queue status endpoint only answers POST (GET is 405 for
            # everyone). A valid key passes auth and reaches the 404
            # "request not found"; an invalid key is bounced 401/403 first.
            # The nil UUID never exists: nothing is enqueued or charged.
            response = _probe_post(
                f"https://queue.fal.run/fal-ai/flux/schnell/requests/{_PROBE_REQUEST_ID}/status",
                headers={"Authorization": f"Key {key}"},
            )
        else:
            instances = Settings().NINEROUTER_INSTANCES
            if not instances:
                return (False, "unreachable")
            origin = next(iter(instances.values())).rstrip("/")
            response = _probe_get(
                f"{origin}/v1/models",
                headers={"Authorization": f"Bearer {key}"},
            )
    except (httpx.TimeoutException, httpx.TransportError, OSError):
        return (False, "unreachable")
    if response.status_code == 404 and provider == "fal":
        return (True, None)
    if provider == "9router" and response.status_code == 200:
        return (True, None)
    if response.status_code in (401, 403):
        return (False, "auth_rejected")
    return (False, "unreachable")


@app.get("/api/v1/settings/providers/{provider}/validate")
def validate_provider_key(provider: str) -> JSONResponse:
    """Prove the stored key is valid at the real provider — not merely present."""
    if provider not in _SETTINGS_PROVIDERS:
        raise HTTPException(status_code=404, detail="unknown provider")
    current_settings = Settings()
    key = ProviderKeyStore(current_settings).get(provider)
    if key is None:
        raise HTTPException(status_code=409, detail="no key stored for this provider")
    ok, reason = _probe_provider_auth(provider, key)
    body: dict[str, object] = {"ok": ok, "provider": provider, "probe": "provider_auth"}
    if reason is not None:
        body["reason"] = reason
    return JSONResponse(content=body)


@app.get("/api/v1/creative/bootstrap")
def bootstrap_creative_session(request: Request) -> JSONResponse:
    """Issue an opaque browser ownership cookie without persisting project data server-side."""
    current_settings = Settings()
    existing = session_id_from_token(
        request.cookies.get(SESSION_COOKIE_NAME), current_settings.SESSION_SECRET
    )
    response = JSONResponse(content={"session_ready": True})
    if existing is None:
        set_session_cookie(
            response,
            str(uuid.uuid4()),
            secret=current_settings.SESSION_SECRET,
            secure=current_settings.SECURE_COOKIES,
        )
    return response


@app.post("/api/v1/creative/jobs", status_code=status.HTTP_201_CREATED)
def enqueue_creative_job(payload: CreativeJobRequest, request: Request) -> JSONResponse:
    """Revalidate an approved local snapshot and enqueue one owned image-generation job."""
    current_settings = Settings()
    owner = require_owned_session(request, current_settings)
    job = enqueue_browser_job(payload, owner_session_id=owner, settings=current_settings)
    view = public_job_view(job, current_settings.ARTIFACT_RETENTION_HOURS)
    return JSONResponse(status_code=status.HTTP_201_CREATED, content=view)


@app.get("/api/v1/creative/jobs/{job_id}")
def read_creative_job(job_id: str, request: Request) -> JSONResponse:
    """Read whitelisted progress for the caller's own job only."""
    current_settings = Settings()
    owner = require_owned_session(request, current_settings)
    job = get_owned_job(job_id, owner_session_id=owner, settings=current_settings)
    return JSONResponse(content=public_job_view(job, current_settings.ARTIFACT_RETENTION_HOURS))


@app.delete("/api/v1/creative/jobs/{job_id}")
def cancel_creative_job(job_id: str, request: Request) -> JSONResponse:
    """Request cancellation; worker decides the safe terminal outcome."""
    current_settings = Settings()
    owner = require_owned_session(request, current_settings)
    job = request_owned_cancel(job_id, owner_session_id=owner, settings=current_settings)
    return JSONResponse(content=public_job_view(job, current_settings.ARTIFACT_RETENTION_HOURS))


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
        request.stream(), max_bytes=RASTER_PREFLIGHT_LIMITS.max_bytes
    )
    report = inspect_raster(
        bytes(source),
        declared_mime_type=request.headers.get("content-type", ""),
        filename=request.headers.get("x-upload-filename", ""),
        content_type=content_type,
    )
    return JSONResponse(content=asdict(report))


@app.post("/api/v1/svg/preflight")
async def preflight_svg(
    content_type: Literal["illustration", "vector"], request: Request
) -> JSONResponse:
    """Inspect hostile SVG bytes and expose only a short-lived raster preview when safe."""
    current_settings = Settings()
    quarantine = SvgQuarantine(
        current_settings.SVG_QUARANTINE_DIR,
        ttl_seconds=current_settings.SVG_QUARANTINE_TTL_SECONDS,
    )
    quarantine.cleanup_expired()
    source, _ = await read_limited_request_body(
        request.stream(), max_bytes=SVG_PREFLIGHT_LIMITS.max_bytes
    )
    report = inspect_svg(
        source,
        declared_mime_type=request.headers.get("content-type", ""),
        filename=request.headers.get("x-upload-filename", ""),
        content_type=content_type,
    )
    preview_url: str | None = None
    if report.preview_png is None:
        quarantine.store_failed_source(source)
    else:
        token = quarantine.store_preview_png(report.preview_png)
        preview_url = f"/api/v1/svg/preflight/previews/{token}"
    return JSONResponse(
        content={
            "verdict": report.verdict,
            "eligible_for_submission": report.eligible_for_submission,
            "findings": [asdict(finding) for finding in report.findings],
            "preview_url": preview_url,
        }
    )


@app.get("/api/v1/svg/preflight/previews/{token}")
def get_svg_preflight_preview(token: str) -> Response:
    """Serve a temporary raster preview; source SVG bytes are never reachable by this API."""
    current_settings = Settings()
    quarantine = SvgQuarantine(
        current_settings.SVG_QUARANTINE_DIR,
        ttl_seconds=current_settings.SVG_QUARANTINE_TTL_SECONDS,
    )
    preview_png = quarantine.read_preview_png(token)
    if preview_png is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="SVG preview not found")
    return Response(
        content=preview_png,
        media_type="image/png",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@app.get("/api/v1/artifacts/{artifact_id}/download")
def download_artifact(artifact_id: str, request: Request) -> FileResponse:
    """Retrieve a durable temporary artifact only for its signed-session owner."""
    current_settings = Settings()
    session_id = session_id_from_token(
        request.cookies.get(SESSION_COOKIE_NAME),
        current_settings.SESSION_SECRET,
    )
    if session_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )
    store = ArtifactStore(
        create_sqlite_engine(current_settings),
        current_settings.ARTIFACT_DIR,
    )
    try:
        artifact = store.claim_retrieval(
            artifact_id,
            session_id,
            lease_seconds=60,
        )
    except (AccessDenied, ExpiredArtifact):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Artifact not found",
        ) from None
    file_path = store.private_path(artifact)
    if not store.verify_integrity(artifact):
        store.complete_retrieval(artifact.id, session_id)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Artifact not found")
    return build_artifact_download_response(
        file_path,
        download_name=artifact.download_name,
        media_type=artifact.media_type,
        sha256=artifact.sha256,
        on_complete=lambda: store.complete_retrieval(artifact.id, session_id),
    )
