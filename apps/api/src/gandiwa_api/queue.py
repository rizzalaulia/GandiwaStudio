"""Durable SQLite queue state machine for Issue #21.

The queue owns durable scheduling semantics only. Provider routing and fallback
remain outside this module; handlers are explicitly injected by the worker.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import Engine, text

QUEUE_STATES = {
    "queued",
    "running",
    "waiting_provider",
    "processing",
    "needs_review",
    "succeeded",
    "failed",
    "cancelled",
}
ACTIVE_STATES = {"running", "waiting_provider", "processing"}
TERMINAL_STATES = {"needs_review", "succeeded", "failed", "cancelled"}

_TRANSITIONS: dict[str, set[str]] = {
    "running": ACTIVE_STATES | TERMINAL_STATES,
    "waiting_provider": {
        "running",
        "processing",
        "needs_review",
        "succeeded",
        "failed",
        "cancelled",
    },
    "processing": {
        "waiting_provider",
        "needs_review",
        "succeeded",
        "failed",
        "cancelled",
    },
}


class QueueError(RuntimeError):
    """Raised when a queue contract would be violated."""


class RetryableJobError(RuntimeError):
    """Explicitly signal a safe-to-retry failure before irreversible dispatch."""


@dataclass(frozen=True, slots=True)
class QueueJob:
    """Immutable read model returned after a queue operation."""

    id: str
    job_type: str
    status: str
    priority: int
    provider_id: str | None
    model_id: str | None
    parameters: dict[str, Any]
    attempt_count: int
    remote_job_id: str | None
    lease_owner: str | None
    lease_expires_at: datetime | None
    heartbeat_at: datetime | None
    cancel_requested_at: datetime | None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    error_code: str | None
    redacted_error: str | None
    result_manifest: dict[str, Any] | None


@dataclass(frozen=True, slots=True)
class JobExecution:
    """Safe handler surface for durable dispatch and cooperative cancellation."""

    job: QueueJob
    mark_dispatched: Callable[[str | None], QueueJob]
    heartbeat: Callable[[], QueueJob]
    cancellation_requested: Callable[[], bool]

    @property
    def id(self) -> str:
        return self.job.id


Handler = Callable[[JobExecution], dict[str, Any] | None]


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _dbtime(value: datetime) -> str:
    """Serialize timestamps explicitly; Python 3.12 deprecated sqlite's adapter."""
    return value.isoformat(timespec="microseconds")


def _parse_dbtime(value: Any) -> datetime | None:
    if value is None or isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value))


def _require_dbtime(value: Any) -> datetime:
    parsed = _parse_dbtime(value)
    if parsed is None:
        raise QueueError("required queue timestamp is missing")
    return parsed


def _row_to_job(row: Any) -> QueueJob:
    mapping = row._mapping
    return QueueJob(
        id=str(mapping["id"]),
        job_type=str(mapping["job_type"]),
        status=str(mapping["status"]),
        priority=int(mapping["priority"]),
        provider_id=mapping["provider_id"],
        model_id=mapping["model_id"],
        parameters=json.loads(mapping["parameters"] or "{}"),
        attempt_count=int(mapping["attempt_count"]),
        remote_job_id=mapping["remote_job_id"],
        lease_owner=mapping["lease_owner"],
        lease_expires_at=_parse_dbtime(mapping["lease_expires_at"]),
        heartbeat_at=_parse_dbtime(mapping["heartbeat_at"]),
        cancel_requested_at=_parse_dbtime(mapping["cancel_requested_at"]),
        created_at=_require_dbtime(mapping["created_at"]),
        started_at=_parse_dbtime(mapping["started_at"]),
        completed_at=_parse_dbtime(mapping["completed_at"]),
        error_code=mapping["error_code"],
        redacted_error=mapping["redacted_error"],
        result_manifest=(
            json.loads(mapping["result_manifest"])
            if mapping["result_manifest"] is not None
            else None
        ),
    )


_SELECT = text("SELECT * FROM generation_job WHERE id = :id")


class QueueStore:
    """SQLite-backed queue with explicit leases and state transitions."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    def enqueue(
        self,
        *,
        job_type: str,
        priority: int = 0,
        status: str = "queued",
        provider_id: str | None = None,
        model_id: str | None = None,
        parameters: dict[str, Any] | None = None,
    ) -> str:
        if status != "queued":
            raise QueueError("initial state must be queued")
        if priority < 0:
            raise QueueError("priority must be non-negative")
        if not job_type.strip():
            raise QueueError("job_type is required")
        job_id = str(uuid.uuid4())
        with self.engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO generation_job "
                    "(id, job_type, status, priority, provider_id, model_id, parameters, "
                    "attempt_count, created_at) VALUES "
                    "(:id, :job_type, :status, :priority, :provider_id, :model_id, "
                    ":parameters, 0, :created_at)"
                ),
                {
                    "id": job_id,
                    "job_type": job_type,
                    "status": status,
                    "priority": priority,
                    "provider_id": provider_id,
                    "model_id": model_id,
                    "parameters": json.dumps(parameters or {}),
                    "created_at": _dbtime(_utcnow()),
                },
            )
        return job_id

    def get(self, job_id: str) -> QueueJob:
        with self.engine.connect() as connection:
            row = connection.execute(_SELECT, {"id": job_id}).fetchone()
        if row is None:
            raise QueueError("job not found")
        return _row_to_job(row)

    def claim_next(self, worker_id: str, *, lease_seconds: int) -> QueueJob | None:
        if not worker_id.strip() or lease_seconds < 1:
            raise QueueError("worker and lease are required")
        with self.engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            try:
                row = connection.execute(
                    text(
                        "SELECT id FROM generation_job WHERE status = 'queued' "
                        "ORDER BY priority DESC, created_at ASC, id ASC LIMIT 1"
                    )
                ).fetchone()
                if row is None:
                    connection.commit()
                    return None
                now = _utcnow()
                expires = now + timedelta(seconds=lease_seconds)
                connection.execute(
                    text(
                        "UPDATE generation_job SET status = 'running', lease_owner = :owner, "
                        "lease_expires_at = :expires, heartbeat_at = :now, started_at = "
                        "COALESCE(started_at, :now), attempt_count = attempt_count + 1 "
                        "WHERE id = :id AND status = 'queued'"
                    ),
                    {
                        "owner": worker_id,
                        "expires": _dbtime(expires),
                        "now": _dbtime(now),
                        "id": row[0],
                    },
                )
                claimed = connection.execute(_SELECT, {"id": row[0]}).fetchone()
                connection.commit()
            except Exception:
                connection.rollback()
                raise
        if claimed is None:
            raise QueueError("claim failed")
        return _row_to_job(claimed)

    def heartbeat(self, job_id: str, worker_id: str, *, lease_seconds: int) -> QueueJob:
        if lease_seconds < 1:
            raise QueueError("lease must be positive")
        now = _utcnow()
        with self.engine.begin() as connection:
            result = connection.execute(
                text(
                    "UPDATE generation_job SET heartbeat_at = :now, lease_expires_at = :expires "
                    "WHERE id = :id AND lease_owner = :owner AND status IN "
                    "('running', 'waiting_provider', 'processing') "
                    "AND lease_expires_at >= :now"
                ),
                {
                    "now": _dbtime(now),
                    "expires": _dbtime(now + timedelta(seconds=lease_seconds)),
                    "id": job_id,
                    "owner": worker_id,
                },
            )
            if result.rowcount != 1:
                raise QueueError("lease is not owned by worker")
        return self.get(job_id)

    def request_cancel(self, job_id: str) -> QueueJob:
        with self.engine.begin() as connection:
            result = connection.execute(
                text(
                    "UPDATE generation_job SET cancel_requested_at = :now "
                    "WHERE id = :id AND status NOT IN "
                    "('succeeded', 'failed', 'cancelled', 'needs_review')"
                ),
                {"now": _dbtime(_utcnow()), "id": job_id},
            )
            if result.rowcount != 1:
                raise QueueError("job is terminal or not found")
        return self.get(job_id)

    def transition(self, job_id: str, worker_id: str, target: str) -> QueueJob:
        if target not in QUEUE_STATES or target == "queued":
            raise QueueError("invalid state transition")
        with self.engine.begin() as connection:
            row = connection.execute(_SELECT, {"id": job_id}).fetchone()
            if row is None:
                raise QueueError("job not found")
            job = _row_to_job(row)
            if job.status in TERMINAL_STATES:
                raise QueueError("job is terminal")
            if target not in _TRANSITIONS.get(job.status, set()):
                raise QueueError("invalid state transition")
            if job.lease_owner != worker_id:
                raise QueueError("lease is not owned by worker")
            now = _dbtime(_utcnow())
            result = connection.execute(
                text(
                    "UPDATE generation_job SET status = :status, completed_at = "
                    "CASE WHEN :terminal = 1 THEN :now ELSE completed_at END "
                    "WHERE id = :id AND status = :source AND lease_owner = :owner "
                    "AND lease_expires_at >= :now AND "
                    "(:is_cancel = 1 OR cancel_requested_at IS NULL)"
                ),
                {
                    "status": target,
                    "source": job.status,
                    "owner": worker_id,
                    "terminal": int(target in TERMINAL_STATES),
                    "is_cancel": int(target == "cancelled"),
                    "now": now,
                    "id": job_id,
                },
            )
            if result.rowcount != 1:
                current = connection.execute(_SELECT, {"id": job_id}).fetchone()
                if (
                    target != "cancelled"
                    and current is not None
                    and current._mapping["cancel_requested_at"] is not None
                ):
                    raise QueueError("cancellation blocks transition")
                raise QueueError("lease is expired or no longer authoritative")
        return self.get(job_id)

    def mark_dispatched(
        self,
        job_id: str,
        worker_id: str,
        *,
        remote_job_id: str | None = None,
    ) -> QueueJob:
        """Persist the irreversible provider-I/O boundary before transport."""
        with self.engine.begin() as connection:
            result = connection.execute(
                text(
                    "UPDATE generation_job SET status = 'waiting_provider', "
                    "remote_job_id = COALESCE(:remote_job_id, remote_job_id) "
                    "WHERE id = :id AND lease_owner = :owner AND status = 'running' "
                    "AND cancel_requested_at IS NULL AND lease_expires_at >= :now"
                ),
                {
                    "remote_job_id": remote_job_id,
                    "id": job_id,
                    "owner": worker_id,
                    "now": _dbtime(_utcnow()),
                },
            )
            if result.rowcount != 1:
                raise QueueError("dispatch boundary requires an active uncancelled lease")
        return self.get(job_id)

    def cancellation_requested(self, job_id: str) -> bool:
        return self.get(job_id).cancel_requested_at is not None

    def recover_expired(self) -> int:
        now = _dbtime(_utcnow())
        with self.engine.begin() as connection:
            safe_retry = connection.execute(
                text(
                    "UPDATE generation_job SET status = 'queued', lease_owner = NULL, "
                    "lease_expires_at = NULL, heartbeat_at = NULL "
                    "WHERE status = 'running' AND lease_expires_at IS NOT NULL "
                    "AND lease_expires_at < :now"
                ),
                {"now": now},
            )
            unknown_dispatch = connection.execute(
                text(
                    "UPDATE generation_job SET status = 'needs_review', lease_owner = NULL, "
                    "lease_expires_at = NULL, heartbeat_at = NULL, completed_at = :now, "
                    "error_code = 'LEASE_EXPIRED_UNKNOWN_DISPATCH', "
                    "redacted_error = 'provider dispatch state is unknown; inspect before retry' "
                    "WHERE status IN ('waiting_provider', 'processing') "
                    "AND lease_expires_at IS NOT NULL AND lease_expires_at < :now"
                ),
                {"now": now},
            )
        return int(safe_retry.rowcount + unknown_dispatch.rowcount)

    def dispatch_once(
        self,
        job_id: str,
        worker_id: str,
        *,
        handlers: Mapping[str, Handler],
        retry_limits: Mapping[str, int] | None = None,
    ) -> QueueJob:
        job = self.get(job_id)
        if job.lease_owner != worker_id or job.status not in ACTIVE_STATES:
            raise QueueError("lease is not owned by worker")
        if job.cancel_requested_at is not None:
            return self.transition(job_id, worker_id, "cancelled")
        handler = handlers.get(job.job_type)
        if handler is None:
            return self._needs_review(job_id, worker_id, "UNKNOWN_DISPATCH")

        def mark_dispatched(remote_id: str | None = None) -> QueueJob:
            return self.mark_dispatched(
                job_id,
                worker_id,
                remote_job_id=remote_id,
            )

        execution = JobExecution(
            job=job,
            mark_dispatched=mark_dispatched,
            heartbeat=lambda: self.heartbeat(
                job_id,
                worker_id,
                lease_seconds=30,
            ),
            cancellation_requested=lambda: self.cancellation_requested(job_id),
        )
        try:
            result = handler(execution)
        except RetryableJobError:
            current = self.get(job_id)
            if current.status in {"waiting_provider", "processing"}:
                return self._needs_review(
                    job_id,
                    worker_id,
                    "UNKNOWN_PROVIDER_OUTCOME",
                )
            limit = (retry_limits or {}).get(job.job_type, 0)
            if job.attempt_count <= limit:
                return self._requeue(job_id, worker_id)
            return self._fail(job_id, worker_id, "RETRY_EXHAUSTED")
        except Exception:
            if self.get(job_id).status in {"waiting_provider", "processing"}:
                return self._needs_review(
                    job_id,
                    worker_id,
                    "UNKNOWN_PROVIDER_OUTCOME",
                )
            return self._fail(job_id, worker_id, "HANDLER_ERROR")
        current = self.get(job_id)
        if current.cancel_requested_at is not None:
            return self.transition(job_id, worker_id, "cancelled")
        with self.engine.begin() as connection:
            finalized = connection.execute(
                text(
                    "UPDATE generation_job SET status = 'succeeded', result_manifest = :result, "
                    "completed_at = :completed WHERE id = :id AND lease_owner = :owner "
                    "AND status IN ('running', 'waiting_provider', 'processing') "
                    "AND cancel_requested_at IS NULL AND lease_expires_at >= :completed"
                ),
                {
                    "result": json.dumps(result or {}),
                    "completed": _dbtime(_utcnow()),
                    "id": job_id,
                    "owner": worker_id,
                },
            )
            if finalized.rowcount != 1:
                raise QueueError("cannot finalize without an active uncancelled lease")
        return self.get(job_id)

    def finalize_success(
        self,
        job_id: str,
        worker_id: str,
        result: dict[str, Any] | None,
    ) -> QueueJob:
        """Same CAS contract as dispatch_once's success path; safe for callers."""
        current = self.get(job_id)
        if current.cancel_requested_at is not None:
            return self.transition(job_id, worker_id, "cancelled")
        with self.engine.begin() as connection:
            finalized = connection.execute(
                text(
                    "UPDATE generation_job SET status = 'succeeded', result_manifest = :result, "
                    "completed_at = :completed WHERE id = :id AND lease_owner = :owner "
                    "AND status IN ('running', 'waiting_provider', 'processing') "
                    "AND cancel_requested_at IS NULL AND lease_expires_at >= :completed"
                ),
                {
                    "result": json.dumps(result or {}),
                    "completed": _dbtime(_utcnow()),
                    "id": job_id,
                    "owner": worker_id,
                },
            )
            if finalized.rowcount != 1:
                raise QueueError("cannot finalize without an active uncancelled lease")
        return self.get(job_id)

    def _requeue(self, job_id: str, worker_id: str) -> QueueJob:
        with self.engine.begin() as connection:
            result = connection.execute(
                text(
                    "UPDATE generation_job SET status = 'queued', lease_owner = NULL, "
                    "lease_expires_at = NULL, heartbeat_at = NULL "
                    "WHERE id = :id AND lease_owner = :owner"
                ),
                {"id": job_id, "owner": worker_id},
            )
            if result.rowcount != 1:
                raise QueueError("retry requeue failed")
        return self.get(job_id)

    def _needs_review(self, job_id: str, worker_id: str, error_code: str) -> QueueJob:
        with self.engine.begin() as connection:
            result = connection.execute(
                text(
                    "UPDATE generation_job SET status = 'needs_review', error_code = :code, "
                    "redacted_error = :message, completed_at = :completed "
                    "WHERE id = :id AND lease_owner = :owner"
                ),
                {
                    "code": error_code,
                    "message": "dispatch cannot proceed safely; manual review required",
                    "completed": _dbtime(_utcnow()),
                    "id": job_id,
                    "owner": worker_id,
                },
            )
            if result.rowcount != 1:
                raise QueueError("needs-review update failed")
        return self.get(job_id)

    def _fail(self, job_id: str, worker_id: str, error_code: str) -> QueueJob:
        with self.engine.begin() as connection:
            result = connection.execute(
                text(
                    "UPDATE generation_job SET status = 'failed', error_code = :code, "
                    "redacted_error = :message, completed_at = :completed "
                    "WHERE id = :id AND lease_owner = :owner"
                ),
                {
                    "code": error_code,
                    "message": "job failed; inspect error code and worker logs",
                    "completed": _dbtime(_utcnow()),
                    "id": job_id,
                    "owner": worker_id,
                },
            )
            if result.rowcount != 1:
                raise QueueError("failed job update")
        return self.get(job_id)


__all__ = [
    "ACTIVE_STATES",
    "QUEUE_STATES",
    "TERMINAL_STATES",
    "QueueError",
    "QueueJob",
    "QueueStore",
    "RetryableJobError",
]
