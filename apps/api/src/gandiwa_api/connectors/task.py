"""One durable dispatch through a frozen connector; the queue owns all state."""

from __future__ import annotations

import time
from typing import Any

from gandiwa_api.connectors.base import (
    DEFAULT_DISPATCH_TIMEOUT_SECONDS,
    ConnectorError,
    DispatchIdentity,
)
from gandiwa_api.connectors.registry import ConnectorRegistry
from gandiwa_api.queue import JobExecution, QueueError, QueueStore


def run_connector_dispatch(
    queue: QueueStore,
    registry: ConnectorRegistry,
    job_id: str,
    worker_id: str,
    *,
    lease_seconds: int = 30,
    mark_dispatched_remote_job_id: str | None = None,
    dispatch_timeout_seconds: int = DEFAULT_DISPATCH_TIMEOUT_SECONDS,
) -> Any:
    """Resolve one connector from the job's frozen identity and run it once.

    Caller contract: termination returns (final job record); the queue owns all
    state transitions. One QueueError propagates unchanged to the caller only
    when the worker lost its lease before the durable dispatch boundary
    (status ``running``, no cancel flag): the job stays claimable and recovery
    belongs to the queue's expired-lease reaper (``recover_expired``), never to
    this bridge. Callers must not treat it as a dispatch failure.
    """
    job = queue.get(job_id)
    if queue.cancellation_requested(job_id):
        return queue.transition(job_id, worker_id, "cancelled")
    parameters = job.parameters
    origin = parameters.get("origin")
    idempotency_key = parameters.get("idempotency_key")
    if not isinstance(origin, str) or not origin:
        return queue._fail(job_id, worker_id, "INVALID_RESPONSE")
    if not isinstance(idempotency_key, str) or not idempotency_key:
        return queue._fail(job_id, worker_id, "INVALID_RESPONSE")
    if job.provider_id is None or job.model_id is None:
        return queue._needs_review(job_id, worker_id, "UNKNOWN_DISPATCH")

    try:
        connector = registry.resolve(job.provider_id)
    except LookupError:
        return queue._needs_review(job_id, worker_id, "UNKNOWN_DISPATCH")

    capability = parameters.get("capability") or "generate_image"
    declared: tuple[str, ...] = tuple(getattr(connector, "capabilities", ()))
    if capability not in declared:
        return queue._needs_review(job_id, worker_id, "CAPABILITY_NOT_DECLARED")

    identity = DispatchIdentity(
        provider_id=job.provider_id,
        model_id=job.model_id,
        origin=origin,
        idempotency_key=idempotency_key,
        capability=capability,
    )

    def mark_dispatched_closure(
        remote: str | None = mark_dispatched_remote_job_id,
    ) -> Any:
        return queue.mark_dispatched(
            job_id,
            worker_id,
            remote_job_id=remote,
        )

    mark_dispatched = mark_dispatched_closure
    deadline_frozen = time.monotonic() + dispatch_timeout_seconds
    execution = JobExecution(
        job=job,
        mark_dispatched=mark_dispatched,
        heartbeat=lambda: queue.heartbeat(
            job_id,
            worker_id,
            lease_seconds=lease_seconds,
        ),
        cancellation_requested=lambda: queue.cancellation_requested(job_id),
        timeout_seconds=dispatch_timeout_seconds,
        deadline_frozen=deadline_frozen,
    )

    try:
        result = connector.dispatch(identity, execution)
    except QueueError:
        claimed = queue.get(job_id)
        if claimed.status != "waiting_provider" and claimed.cancel_requested_at is not None:
            return queue.transition(job_id, worker_id, "cancelled")
        if claimed.status == "waiting_provider":
            return queue._needs_review(job_id, worker_id, "UNKNOWN_PROVIDER_OUTCOME")
        raise
    except ConnectorError as error:
        claimed = queue.get(job_id)
        if (
            error.code == "CANCELLED"
            and claimed.status != "waiting_provider"
            and claimed.cancel_requested_at is not None
        ):
            return queue.transition(job_id, worker_id, "cancelled")
        if claimed.status != "waiting_provider":
            return queue._fail(job_id, worker_id, error.code)
        return queue._needs_review(job_id, worker_id, "UNKNOWN_PROVIDER_OUTCOME")
    except Exception:
        claimed = queue.get(job_id)
        if claimed.status != "waiting_provider":
            return queue._fail(job_id, worker_id, "CONNECTOR_ERROR")
        return queue._needs_review(job_id, worker_id, "UNKNOWN_PROVIDER_OUTCOME")

    claimed = queue.get(job_id)
    remote_job_id = claimed.remote_job_id
    if isinstance(result, dict):
        provider_job_id_value = result.get("provider_job_id")
        if isinstance(provider_job_id_value, str) and provider_job_id_value:
            remote_job_id = provider_job_id_value
    if remote_job_id is None:
        return queue._fail(job_id, worker_id, "INVALID_RESPONSE")

    finalized = queue.finalize_success(
        job_id,
        worker_id,
        result,
        remote_job_id=remote_job_id,
    )
    if remote_job_id and finalized.remote_job_id != remote_job_id:
        raise QueueError("remote job id was not persisted atomically")
    return queue.get(job_id)
