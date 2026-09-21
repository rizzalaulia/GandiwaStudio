"""One durable dispatch through a frozen connector; the queue owns all state."""

from __future__ import annotations

from typing import Any

from sqlalchemy import text

from gandiwa_api.connectors.base import ConnectorError, DispatchIdentity
from gandiwa_api.connectors.registry import ConnectorRegistry
from gandiwa_api.queue import JobExecution, QueueStore


def run_connector_dispatch(
    queue: QueueStore,
    registry: ConnectorRegistry,
    job_id: str,
    worker_id: str,
    *,
    lease_seconds: int = 30,
    mark_dispatched_remote_job_id: str | None = None,
) -> Any:
    """Resolve one connector from the job's frozen identity and run it once."""
    job = queue.get(job_id)
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

    identity = DispatchIdentity(
        provider_id=job.provider_id,
        model_id=job.model_id,
        origin=origin,
        idempotency_key=idempotency_key,
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
    execution = JobExecution(
        job=job,
        mark_dispatched=mark_dispatched,
        heartbeat=lambda: queue.heartbeat(
            job_id,
            worker_id,
            lease_seconds=lease_seconds,
        ),
        cancellation_requested=lambda: queue.cancellation_requested(job_id),
    )

    try:
        result = connector.dispatch(identity, execution)
    except ConnectorError as error:
        claimed = queue.get(job_id)
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

    finalized = queue.finalize_success(job_id, worker_id, result)
    if remote_job_id and finalized.remote_job_id != remote_job_id:
        with queue.engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE generation_job SET remote_job_id = :remote "
                    "WHERE id = :id AND lease_owner = :owner AND status = 'succeeded'"
                ),
                {"remote": remote_job_id, "id": job_id, "owner": worker_id},
            )
    return queue.get(job_id)
