"""TDD contract tests for Issue #21 durable queue semantics."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text

from gandiwa_api.config import Settings
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.queue import (
    ACTIVE_STATES,
    TERMINAL_STATES,
    QueueError,
    QueueStore,
    RetryableJobError,
    _dbtime,
)


def _config(database_url: str) -> Config:
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


@pytest.fixture
def store(tmp_path: Path) -> QueueStore:
    database_url = f"sqlite:///{tmp_path / 'queue.sqlite3'}"
    command.upgrade(_config(database_url), "head")
    return QueueStore(create_sqlite_engine(Settings(DATABASE_URL=database_url)))


def test_state_contract_is_explicit() -> None:
    assert {"running", "waiting_provider", "processing"} == ACTIVE_STATES
    assert {"needs_review", "succeeded", "failed", "cancelled"} == TERMINAL_STATES


def test_enqueue_only_allows_queued_initial_state(store: QueueStore) -> None:
    with pytest.raises(QueueError, match="state must be queued"):
        store.enqueue(job_type="generate", status="running")


def test_priority_then_fifo_claim_is_atomic(store: QueueStore) -> None:
    low = store.enqueue(job_type="generate", priority=1)
    high_old = store.enqueue(job_type="generate", priority=5)
    high_new = store.enqueue(job_type="generate", priority=5)

    claimed = store.claim_next("worker-a", lease_seconds=30)

    assert claimed is not None
    assert claimed.id == high_old
    assert claimed.status == "running"
    assert claimed.lease_owner == "worker-a"
    assert claimed.lease_expires_at is not None
    assert store.claim_next("worker-b", lease_seconds=30).id == high_new
    assert store.claim_next("worker-c", lease_seconds=30).id == low


def test_queued_position_matches_priority_then_fifo_order(store: QueueStore) -> None:
    """Issue #26 AC: queue position shown while the job waits.

    Position follows the exact claim_next order: priority DESC, then
    created_at ASC, then id ASC; running/non-queued jobs disclose None.
    """
    low = store.enqueue(job_type="generate", priority=1)
    high_old = store.enqueue(job_type="generate", priority=5)
    high_new = store.enqueue(job_type="generate", priority=5)

    assert store.queued_position(high_old) == 1
    assert store.queued_position(high_new) == 2
    assert store.queued_position(low) == 3

    first_claimed = store.claim_next("worker-a", lease_seconds=30)
    assert first_claimed is not None and first_claimed.id == high_old
    # Claimed job left the queue → position fail-closes to None, never a guess.
    assert store.queued_position(high_old) is None
    assert store.queued_position(high_new) == 1
    assert store.queued_position(low) == 2


def test_enqueue_rejects_unknown_state_and_negative_priority(store: QueueStore) -> None:
    with pytest.raises(QueueError, match="priority"):
        store.enqueue(job_type="generate", priority=-1)
    with pytest.raises(QueueError, match="state"):
        store.enqueue(job_type="generate", status="mystery")


def test_lease_heartbeat_and_expired_recovery_requeue(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="generate")
    claimed = store.claim_next("worker-a", lease_seconds=1)
    assert claimed is not None

    store.heartbeat(job_id, "worker-a", lease_seconds=60)
    renewed = store.get(job_id)
    assert renewed.heartbeat_at is not None
    assert renewed.lease_expires_at is not None

    expired_at = datetime.now(UTC) - timedelta(seconds=1)
    with store.engine.begin() as connection:
        connection.execute(
            text("UPDATE generation_job SET lease_expires_at = :expired WHERE id = :id"),
            {"expired": expired_at.replace(tzinfo=None).isoformat(), "id": job_id},
        )

    assert store.recover_expired() == 1
    recovered = store.get(job_id)
    assert recovered.status == "queued"
    assert recovered.lease_owner is None
    assert recovered.attempt_count == 1


def test_expired_unknown_dispatch_state_requires_review(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)
    store.transition(job_id, "worker-a", "waiting_provider")
    expired_at = datetime.now(UTC) - timedelta(seconds=1)
    with store.engine.begin() as connection:
        connection.execute(
            text("UPDATE generation_job SET lease_expires_at = :expired WHERE id = :id"),
            {"expired": expired_at.replace(tzinfo=None).isoformat(), "id": job_id},
        )

    assert store.recover_expired() == 1
    recovered = store.get(job_id)
    assert recovered.status == "needs_review"
    assert recovered.error_code == "LEASE_EXPIRED_UNKNOWN_DISPATCH"
    assert store.claim_next("worker-b", lease_seconds=30) is None


def test_heartbeat_requires_current_lease_owner(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)

    with pytest.raises(QueueError, match="lease"):
        store.heartbeat(job_id, "worker-b", lease_seconds=30)


def test_cooperative_cancellation_is_observable_and_terminal(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)

    store.request_cancel(job_id)
    assert store.get(job_id).cancel_requested_at is not None
    assert store.transition(job_id, "worker-a", "cancelled").status == "cancelled"

    with pytest.raises(QueueError, match="terminal"):
        store.transition(job_id, "worker-a", "running")


def test_all_state_transitions_are_explicit(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)
    for state in ("waiting_provider", "processing", "succeeded"):
        job = store.transition(job_id, "worker-a", state)
        assert job.status == state
    assert store.get(job_id).completed_at is not None

    review_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)
    review = store.transition(review_id, "worker-a", "needs_review")
    assert review.status == "needs_review"
    assert review.completed_at is not None


def test_unknown_dispatch_fails_closed_without_retry(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="not-registered")
    store.claim_next("worker-a", lease_seconds=30)

    result = store.dispatch_once(job_id, "worker-a", handlers={})

    assert result.status == "needs_review"
    assert result.error_code == "UNKNOWN_DISPATCH"
    assert result.attempt_count == 1
    assert "retry" not in (result.redacted_error or "").lower()


def test_retry_policy_is_explicit_per_job_type(store: QueueStore) -> None:
    retry_id = store.enqueue(job_type="preflight")
    store.claim_next("worker-a", lease_seconds=30)
    retryable = store.dispatch_once(
        retry_id,
        "worker-a",
        handlers={"preflight": lambda _job: (_ for _ in ()).throw(RetryableJobError())},
        retry_limits={"preflight": 2},
    )
    assert retryable.status == "queued"
    assert retryable.attempt_count == 1

    no_retry_id = store.enqueue(job_type="generate", priority=10)
    store.claim_next("worker-a", lease_seconds=30)
    failed = store.dispatch_once(
        no_retry_id,
        "worker-a",
        handlers={"generate": lambda _job: (_ for _ in ()).throw(RetryableJobError())},
        retry_limits={},
    )
    assert failed.status == "failed"
    assert failed.error_code == "RETRY_EXHAUSTED"


def test_retryable_error_after_dispatch_requires_review(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)

    def handler(execution: object) -> None:
        from gandiwa_api.queue import JobExecution

        assert isinstance(execution, JobExecution)
        execution.mark_dispatched("remote-charge")
        raise RetryableJobError()

    result = store.dispatch_once(
        job_id,
        "worker-a",
        handlers={"generate": handler},
        retry_limits={"generate": 2},
    )
    assert result.status == "needs_review"
    assert result.error_code == "UNKNOWN_PROVIDER_OUTCOME"
    assert result.remote_job_id == "remote-charge"


def test_expired_lease_owner_cannot_transition_terminal_state(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)
    expired_at = datetime.now(UTC) - timedelta(seconds=1)
    with store.engine.begin() as connection:
        connection.execute(
            text("UPDATE generation_job SET lease_expires_at = :expired WHERE id = :id"),
            {"expired": expired_at.replace(tzinfo=None).isoformat(), "id": job_id},
        )

    with pytest.raises(QueueError, match="lease"):
        store.transition(job_id, "worker-a", "succeeded")
    assert store.get(job_id).status == "running"


def test_cancel_request_blocks_non_cancel_transition(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)
    store.request_cancel(job_id)

    with pytest.raises(QueueError, match="cancel"):
        store.transition(job_id, "worker-a", "succeeded")
    assert store.transition(job_id, "worker-a", "cancelled").status == "cancelled"


def test_expired_lease_cannot_be_resurrected_by_heartbeat(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)
    expired_at = datetime.now(UTC) - timedelta(seconds=1)
    with store.engine.begin() as connection:
        connection.execute(
            text("UPDATE generation_job SET lease_expires_at = :expired WHERE id = :id"),
            {"expired": expired_at.replace(tzinfo=None).isoformat(), "id": job_id},
        )

    with pytest.raises(QueueError, match="lease"):
        store.heartbeat(job_id, "worker-a", lease_seconds=30)
    assert store.get(job_id).lease_expires_at == expired_at.replace(tzinfo=None)


def test_dispatch_boundary_is_durable_before_provider_io(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)

    def handler(execution: object) -> None:
        from gandiwa_api.queue import JobExecution

        assert isinstance(execution, JobExecution)
        execution.mark_dispatched("remote-123")
        raise RuntimeError("provider response lost")

    result = store.dispatch_once(job_id, "worker-a", handlers={"generate": handler})
    assert result.status == "needs_review"
    assert result.error_code == "UNKNOWN_PROVIDER_OUTCOME"
    assert result.remote_job_id == "remote-123"


def test_cancellation_during_handler_blocks_success(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)

    def handler(execution: object) -> dict[str, bool]:
        from gandiwa_api.queue import JobExecution

        assert isinstance(execution, JobExecution)
        store.request_cancel(job_id)
        assert execution.cancellation_requested() is True
        return {"completed": True}

    result = store.dispatch_once(job_id, "worker-a", handlers={"generate": handler})
    assert result.status == "cancelled"
    assert result.result_manifest is None


def test_record_remote_job_id_persists_immediately_after_dispatch(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)
    store.mark_dispatched(job_id, "worker-a")

    recorded = store.record_remote_job_id(job_id, "worker-a", "fal-request-123")

    assert recorded.status == "waiting_provider"
    assert recorded.remote_job_id == "fal-request-123"


def test_record_remote_job_id_is_idempotent_and_rejects_rebinding(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)
    store.mark_dispatched(job_id, "worker-a")
    store.record_remote_job_id(job_id, "worker-a", "fal-request-123")

    same = store.record_remote_job_id(job_id, "worker-a", "fal-request-123")
    assert same.remote_job_id == "fal-request-123"

    with pytest.raises(QueueError, match="remote job id"):
        store.record_remote_job_id(job_id, "worker-a", "different-request")


def test_finalize_success_atomically_persists_remote_job_id(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)
    store.mark_dispatched(job_id, "worker-a")

    final = store.finalize_success(
        job_id,
        "worker-a",
        {"artifact": "opaque-id"},
        remote_job_id="provider-job-123",
    )

    assert final.status == "succeeded"
    assert final.remote_job_id == "provider-job-123"
    assert final.result_manifest == {"artifact": "opaque-id"}


def test_failure_and_review_finalization_require_an_active_lease(store: QueueStore) -> None:
    job_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)
    with store.engine.begin() as connection:
        connection.execute(
            text("UPDATE generation_job SET lease_expires_at = :expired WHERE id = :id"),
            {"expired": _dbtime(datetime.now(UTC) - timedelta(seconds=1)), "id": job_id},
        )

    with pytest.raises(QueueError, match="failed job update"):
        store._fail(job_id, "worker-a", "HANDLER_ERROR")
    with pytest.raises(QueueError, match="needs-review update"):
        store._needs_review(job_id, "worker-a", "UNKNOWN_PROVIDER_OUTCOME")
    assert store.get(job_id).status == "running"


def test_handler_success_and_handler_failure_are_persisted(store: QueueStore) -> None:
    success_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)
    success = store.dispatch_once(
        success_id,
        "worker-a",
        handlers={"generate": lambda _job: {"artifact": "opaque-id"}},
    )
    assert success.status == "succeeded"
    assert success.result_manifest == {"artifact": "opaque-id"}

    failure_id = store.enqueue(job_type="generate")
    store.claim_next("worker-a", lease_seconds=30)
    failure = store.dispatch_once(
        failure_id,
        "worker-a",
        handlers={"generate": lambda _job: (_ for _ in ()).throw(RuntimeError("secret token"))},
    )
    assert failure.status == "failed"
    assert failure.error_code == "HANDLER_ERROR"
    assert "secret token" not in (failure.redacted_error or "")


def test_enqueue_derives_one_deterministic_ruleset_snapshot_id_for_equal_generation_rules(
    store: QueueStore,
) -> None:
    parameters = {
        "capability": "generate_image",
        "rules_snapshot": {"policy": "stock-safe", "version": 3, "items": ["a", "b"]},
    }
    first = store.enqueue(job_type="generate", provider_id="fal", parameters=dict(parameters))
    second = store.enqueue(job_type="generate", provider_id="fal", parameters=dict(parameters))

    first_id = store.get(first).ruleset_snapshot_id
    assert isinstance(first_id, str)
    assert len(first_id) == 36
    assert str(uuid.UUID(first_id)) == first_id
    assert store.get(second).ruleset_snapshot_id == first_id


def test_ruleset_snapshot_id_binds_snapshot_content_and_generation_identity(
    store: QueueStore,
) -> None:
    parameters = {"capability": "generate_image", "rules_snapshot": {"policy": "stock-safe"}}
    base = store.enqueue(
        job_type="generate",
        provider_id="fal",
        model_id="fal-ai/flux/dev",
        parameters=dict(parameters),
    )
    other_model = store.enqueue(
        job_type="generate",
        provider_id="fal",
        model_id="fal-ai/sdxl",
        parameters=dict(parameters),
    )
    changed_rules = store.enqueue(
        job_type="generate",
        provider_id="fal",
        model_id="fal-ai/flux/dev",
        parameters={
            "capability": "generate_image",
            "rules_snapshot": {"policy": "stock-safe", "version": 2},
        },
    )

    assert store.get(other_model).ruleset_snapshot_id != store.get(base).ruleset_snapshot_id
    assert store.get(changed_rules).ruleset_snapshot_id != store.get(base).ruleset_snapshot_id


def test_connector_contract_jobs_without_generation_rules_are_still_enqueueable(
    store: QueueStore,
) -> None:
    """Layer boundary: rules enforcement lives in the #58 dispatch policy,
    not the #21/#23 queue layer; capability-marker jobs stay legal there."""

    capability_job = store.enqueue(
        job_type="generate",
        provider_id="fake-provider",
        parameters={"capability": "generate_image", "origin": "fake://localhost"},
    )
    assert store.get(capability_job).ruleset_snapshot_id is None

    with_rules = store.enqueue(
        job_type="generate",
        provider_id="fal",
        parameters={
            "capability": "generate_image",
            "rules_snapshot": {"policy": "stock-safe"},
        },
    )
    assert len(store.get(with_rules).ruleset_snapshot_id or "") == 36

    generation_no_capability = store.enqueue(
        job_type="generate",
        provider_id="fal",
        parameters={"rules_snapshot": {"policy": "stock-safe"}},
    )
    assert store.get(generation_no_capability).ruleset_snapshot_id is None


def test_preexisting_legacy_rows_are_never_resnapshotted(store: QueueStore) -> None:
    """Regression guard: derivation happens at enqueue only, no read backfill."""
    legacy_id = str(uuid.uuid4())
    with store.engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO generation_job "
                "(id, job_type, status, priority, parameters, attempt_count, created_at) "
                "VALUES (:id, 'generate', 'queued', 0, :parameters, 0, :created_at)"
            ),
            {
                "id": legacy_id,
                "parameters": json.dumps({"capability": "generate_image"}),
                "created_at": _dbtime(datetime.now(UTC)),
            },
        )

    assert store.get(legacy_id).ruleset_snapshot_id is None
