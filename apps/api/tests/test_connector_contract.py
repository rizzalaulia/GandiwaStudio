"""Issue #23 RED/GREEN: connector dispatch contract over the durable queue."""

from __future__ import annotations

import time
from dataclasses import FrozenInstanceError
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config

from gandiwa_api.config import Settings
from gandiwa_api.connectors.base import (
    DEFAULT_DISPATCH_TIMEOUT_SECONDS,
    ConnectorError,
    DispatchIdentity,
    FakeAuthError,
    FakeInvalidResponseError,
    FakeProviderServer,
    FakeQuotaError,
    FakeTimeoutError,
    ProviderConnector,
)
from gandiwa_api.connectors.registry import ConnectorRegistry
from gandiwa_api.connectors.task import run_connector_dispatch
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.queue import QueueStore


def _annotate(execution: Any) -> Any:
    return execution


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    return Settings(
        DATABASE_URL=f"sqlite:///{tmp_path / 'connector.sqlite3'}",
        ARTIFACT_DIR=artifacts,
    )


@pytest.fixture
def queue(settings: Settings) -> QueueStore:
    api_root = Path(__file__).resolve().parents[1]
    config = Config(str(api_root / "alembic.ini"))
    config.set_main_option("script_location", str(api_root / "migrations"))
    config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)
    command.upgrade(config, "head")
    return QueueStore(create_sqlite_engine(settings))


def test_frozen_identity_is_immutable() -> None:
    identity = DispatchIdentity(
        provider_id="fake-provider",
        model_id="fake-model-1",
        origin="fake://localhost",
        idempotency_key="idem-0001",
        capability="generate_image",
    )

    with pytest.raises(FrozenInstanceError):
        identity.model_id = "mutated-model"  # type: ignore[misc]


def test_fake_provider_satisfies_connector_protocol() -> None:
    server = FakeProviderServer()

    assert isinstance(server, ProviderConnector)


def test_unknown_dispatch_is_refused_not_routed(queue: QueueStore) -> None:
    server = FakeProviderServer()
    registry = ConnectorRegistry({"fake-provider": server})
    job_id = queue.enqueue(
        job_type="generate",
        provider_id="never-registered-provider",
        model_id="any",
        parameters={"origin": "fake://localhost", "idempotency_key": "k1"},
    )

    worker_id = "worker-a"
    queue.claim_next(worker_id, lease_seconds=30)
    run_connector_dispatch(queue, registry, job_id, worker_id)

    final = queue.get(job_id)
    assert final.status == "needs_review"
    assert final.error_code == "UNKNOWN_DISPATCH"
    assert server.calls == []


def test_successful_dispatch_freezes_one_connector_one_remote_id(
    queue: QueueStore,
) -> None:
    server = FakeProviderServer()
    registry = ConnectorRegistry({"fake-provider": server})
    job_id = queue.enqueue(
        job_type="generate",
        provider_id="fake-provider",
        model_id="fake-model-1",
        parameters={
            "origin": "fake://localhost",
            "idempotency_key": "idem-success",
        },
    )

    worker_id = "worker-a"
    queue.claim_next(worker_id, lease_seconds=30)
    run_connector_dispatch(queue, registry, job_id, worker_id)

    final = queue.get(job_id)
    assert final.status == "succeeded"
    assert final.remote_job_id == "fake-job-001"
    assert [call.provider_id for call in server.calls] == ["fake-provider"]


@pytest.mark.parametrize(
    ("scripted_code", "error_class", "expected_code"),
    [
        ("AUTH_REJECTED", FakeAuthError, "AUTH_REJECTED"),
        ("QUOTA_EXCEEDED", FakeQuotaError, "QUOTA_EXCEEDED"),
        ("TIMEOUT", FakeTimeoutError, "PROVIDER_TIMEOUT"),
        ("INVALID_RESPONSE", FakeInvalidResponseError, "INVALID_RESPONSE"),
    ],
)
def test_scripted_provider_failures_are_reduacted_failures(
    queue: QueueStore,
    scripted_code: str,
    error_class: type[ConnectorError],
    expected_code: str,
) -> None:
    server = FakeProviderServer()
    server.script(scripted_code)
    registry = ConnectorRegistry({"fake-provider": server})
    job_id = queue.enqueue(
        job_type="generate",
        provider_id="fake-provider",
        model_id="fake-model-1",
        parameters={
            "origin": "fake://localhost",
            "idempotency_key": "idem-" + scripted_code,
        },
    )

    worker_id = "worker-a"
    queue.claim_next(worker_id, lease_seconds=30)
    run_connector_dispatch(queue, registry, job_id, worker_id)

    final = queue.get(job_id)
    assert final.status == "failed"
    assert final.error_code == expected_code
    assert final.redacted_error is not None
    for secret in ("api", "key", "token", "password"):
        assert secret not in final.redacted_error.lower()


def test_post_dispatch_scripted_failure_becomes_needs_review(
    queue: QueueStore,
) -> None:
    server = FakeProviderServer()
    server.script("TIMEOUT")
    registry = ConnectorRegistry({"fake-provider": server})
    job_id = queue.enqueue(
        job_type="generate",
        provider_id="fake-provider",
        model_id="fake-model-1",
        parameters={
            "origin": "fake://localhost",
            "idempotency_key": "idem-timeout-post-dispatch",
        },
    )

    worker_id = "worker-a"
    queue.claim_next(worker_id, lease_seconds=30)
    # Boundary BEFORE the scripted failure, matching a real handler that dispatches
    # provider transport after the durable credit-spend boundary (Issue #21).
    queue.mark_dispatched(job_id, worker_id, remote_job_id="fake-job-pre-001")
    run_connector_dispatch(queue, registry, job_id, worker_id)

    final = queue.get(job_id)
    assert final.status == "needs_review"
    assert final.error_code == "UNKNOWN_PROVIDER_OUTCOME"
    assert final.remote_job_id == "fake-job-pre-001"


def test_connector_declares_capabilities_and_task_refusals_unknown_capability(
    queue: QueueStore,
) -> None:
    server = FakeProviderServer(capabilities=())
    registry = ConnectorRegistry({"fake-provider": server})
    job_id = queue.enqueue(
        job_type="generate",
        provider_id="fake-provider",
        model_id="fake-model-1",
        parameters={
            "origin": "fake://localhost",
            "idempotency_key": "idem-capability",
            "capability": "generate_image",
        },
    )

    worker_id = "worker-a"
    queue.claim_next(worker_id, lease_seconds=30)
    run_connector_dispatch(queue, registry, job_id, worker_id)

    assert queue.get(job_id).status == "needs_review"
    final = queue.get(job_id)
    assert final.error_code == "CAPABILITY_NOT_DECLARED"
    assert server.calls == []


def test_declared_capability_passes_to_frozen_identity(
    queue: QueueStore,
) -> None:
    server = FakeProviderServer(capabilities=("generate_image",))
    registry = ConnectorRegistry({"fake-provider": server})
    job_id = queue.enqueue(
        job_type="generate",
        provider_id="fake-provider",
        model_id="fake-model-1",
        parameters={
            "origin": "fake://localhost",
            "idempotency_key": "idem-capability-ok",
            "capability": "generate_image",
        },
    )

    worker_id = "worker-a"
    queue.claim_next(worker_id, lease_seconds=30)
    run_connector_dispatch(queue, registry, job_id, worker_id)

    final = queue.get(job_id)
    assert final.status == "succeeded"
    identity = server.calls[0]
    assert identity.capability == "generate_image"


def test_execution_carries_timeout_policy(queue: QueueStore) -> None:
    captured: dict[str, object] = {}

    class TimeoutProbeServer(FakeProviderServer):
        def dispatch(
            self,
            identity: DispatchIdentity,
            execution: object = None,
        ) -> dict[str, object] | None:
            captured["timeout_seconds"] = _annotate(execution).timeout_seconds
            execution_annotated = _annotate(execution)
            captured["deadline_frozen"] = execution_annotated.deadline_frozen
            captured["before_dispatch"] = time.monotonic()
            captured["deadline_residual"] = (
                execution_annotated.deadline_frozen - captured["before_dispatch"]
            )
            return super().dispatch(identity, execution)

    server = TimeoutProbeServer(capabilities=("generate_image",))
    registry = ConnectorRegistry({"fake-provider": server})
    job_id = queue.enqueue(
        job_type="generate",
        provider_id="fake-provider",
        model_id="fake-model-1",
        parameters={
            "origin": "fake://localhost",
            "idempotency_key": "idem-timeout-policy",
            "capability": "generate_image",
        },
    )

    worker_id = "worker-a"
    queue.claim_next(worker_id, lease_seconds=30)
    run_connector_dispatch(
        queue,
        registry,
        job_id,
        worker_id,
        dispatch_timeout_seconds=42,
    )

    final = queue.get(job_id)
    assert final.status == "succeeded"
    assert captured["timeout_seconds"] == 42
    deadline = captured["deadline_frozen"]
    assert isinstance(deadline, float)
    residual = captured["deadline_residual"]
    assert isinstance(residual, float)
    # The deadline was frozen BEFORE the probe ran its first statement: at most
    # the whole budget may remain, and the frozen value never moves.
    assert 0 < residual <= 42


def test_default_timeout_policy_flows_through_run(
    queue: QueueStore,
) -> None:
    captured: dict[str, object] = {}

    class DefaultProbeServer(FakeProviderServer):
        def dispatch(
            self,
            identity: DispatchIdentity,
            execution: object = None,
        ) -> dict[str, object] | None:
            captured["timeout_seconds"] = _annotate(execution).timeout_seconds
            return super().dispatch(identity, execution)

    server = DefaultProbeServer(capabilities=("generate_image",))
    registry = ConnectorRegistry({"fake-provider": server})
    job_id = queue.enqueue(
        job_type="generate",
        provider_id="fake-provider",
        model_id="fake-model-1",
        parameters={
            "origin": "fake://localhost",
            "idempotency_key": "idem-default-timeout",
            "capability": "generate_image",
        },
    )

    worker_id = "worker-a"
    queue.claim_next(worker_id, lease_seconds=30)
    run_connector_dispatch(queue, registry, job_id, worker_id)

    assert queue.get(job_id).status == "succeeded"
    assert captured["timeout_seconds"] == DEFAULT_DISPATCH_TIMEOUT_SECONDS
