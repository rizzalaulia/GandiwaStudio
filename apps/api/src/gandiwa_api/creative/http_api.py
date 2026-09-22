"""Browser-safe Issue #26 boundary for approved creative jobs.

The browser remains owner of the project-local creative sidecar. This module
accepts one immutable snapshot only to revalidate and enqueue a durable job;
it never persists project/session documents or exposes queue parameters.
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from gandiwa_api.config import Settings
from gandiwa_api.creative.dispatch_policy import (
    GenerationDispatchError,
    enqueue_approved_generation,
)
from gandiwa_api.creative.models import CreativeSession
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.queue import QueueError, QueueJob, QueueStore
from gandiwa_api.security.csrf import SESSION_COOKIE_NAME, session_id_from_token

_IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_FAL_ORIGIN = "https://queue.fal.run"


class CreativeJobRequest(BaseModel):
    """The sole browser-to-queue request; all state needed by the gate is explicit."""

    model_config = ConfigDict(extra="forbid")

    session: CreativeSession
    rules_snapshot: dict[str, Any] = Field(min_length=1)
    idempotency_key: str

    @field_validator("idempotency_key")
    @classmethod
    def require_safe_idempotency_key(cls, value: str) -> str:
        if not _IDEMPOTENCY_KEY.fullmatch(value):
            raise ValueError("idempotency key is invalid")
        return value


def require_owned_session(request: Request, settings: Settings) -> str:
    """Read the opaque cookie identity; never accept ownership from JSON."""
    owner = session_id_from_token(
        request.cookies.get(SESSION_COOKIE_NAME), settings.SESSION_SECRET
    )
    if owner is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )
    return owner


def enqueue_browser_job(
    payload: CreativeJobRequest,
    *,
    owner_session_id: str,
    settings: Settings,
) -> QueueJob:
    """Revalidate a browser snapshot then enqueue exactly one owned durable job."""
    queue = QueueStore(create_sqlite_engine(settings))
    try:
        job_id = enqueue_approved_generation(
            queue,
            payload.session,
            owner_session_id=owner_session_id,
            rules_snapshot=payload.rules_snapshot,
            idempotency_key=payload.idempotency_key,
            origin=_FAL_ORIGIN,
        )
        return queue.get(job_id)
    except GenerationDispatchError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(error),
        ) from None


def get_owned_job(job_id: str, *, owner_session_id: str, settings: Settings) -> QueueJob:
    """Return a job only when its durable private owner binding matches the cookie."""
    queue = QueueStore(create_sqlite_engine(settings))
    try:
        job = queue.get(job_id)
    except QueueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found") from None
    if job.parameters.get("owner_session_id") != owner_session_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    return job


def request_owned_cancel(job_id: str, *, owner_session_id: str, settings: Settings) -> QueueJob:
    """Request cancellation only for the caller's own nonterminal job."""
    get_owned_job(job_id, owner_session_id=owner_session_id, settings=settings)
    queue = QueueStore(create_sqlite_engine(settings))
    try:
        return queue.request_cancel(job_id)
    except QueueError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Job cannot be cancelled",
        ) from None


def public_job_view(job: QueueJob) -> dict[str, object]:
    """Whitelisted public job state; queue parameters and provider IDs stay private."""
    artifact: dict[str, object] | None = None
    if isinstance(job.result_manifest, dict):
        raw = job.result_manifest.get("artifact")
        if isinstance(raw, dict):
            identifier = raw.get("id")
            media_type = raw.get("media_type")
            size_bytes = raw.get("size_bytes")
            sha256 = raw.get("sha256")
            width = raw.get("width")
            height = raw.get("height")
            if (
                isinstance(identifier, str)
                and isinstance(media_type, str)
                and isinstance(size_bytes, int)
                and isinstance(sha256, str)
                and isinstance(width, int)
                and isinstance(height, int)
            ):
                artifact = {
                    "id": identifier,
                    "media_type": media_type,
                    "size_bytes": size_bytes,
                    "sha256": sha256,
                    "width": width,
                    "height": height,
                }
    return {
        "id": job.id,
        "status": job.status,
        "provider_id": job.provider_id,
        "model_id": job.model_id,
        "attempt_count": job.attempt_count,
        "cancel_requested": job.cancel_requested_at is not None,
        "created_at": job.created_at.isoformat(),
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "error_code": job.error_code,
        "message": job.redacted_error,
        "artifact": artifact,
    }
