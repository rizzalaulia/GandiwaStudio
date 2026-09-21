"""Offline Slice A contracts; no live credentials or endpoint access."""

import json
import threading
import time
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text

from gandiwa_api.config import Settings
from gandiwa_api.connectors.base import DispatchIdentity
from gandiwa_api.connectors.ninerouter import NineRouterClient, NineRouterError
from gandiwa_api.connectors.registry import ConnectorRegistry
from gandiwa_api.connectors.task import run_connector_dispatch
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.queue import JobExecution, QueueJob, QueueStore


@pytest.mark.parametrize(
    "body",
    [None, {}, {"data": None}, {"data": [None]}, {"data": [{"id": ""}]}, {"data": [{"id": 1}]}],
)
def test_discovery_rejects_invalid_response(body: Any) -> None:
    with pytest.raises(NineRouterError, match=r"^INVALID_RESPONSE$"):
        NineRouterClient("studio-a", ORIGIN, FakeTransport(body)).models()


ORIGIN = "http://100.64.0.10:20128/v1"

# Deterministic mid-call lease window: call outlives one lease, renew at small interval.
_MIDCALL_LEASE_SECONDS = 1
_MIDCALL_SLEEP_SECONDS = 1.5
_MIDCALL_INTERVAL_SECONDS = 0.3
_MIDCALL_MIN_BEATS = 2


class FakeTransport:
    def __init__(self, response: Any) -> None:
        self.response = response
        self.calls: list[dict[str, Any]] = []

    def request(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return self.response


def identity(operation: str = "brainstorm") -> DispatchIdentity:
    return DispatchIdentity("studio-a", "combo/Exact ID", ORIGIN, "job-key", operation)


def test_discovery_preserves_upstream_ids_order_and_duplicates() -> None:
    transport = FakeTransport({"data": [{"id": "combo/Z"}, {"id": "Model A"}, {"id": "combo/Z"}]})
    client = NineRouterClient("studio-a", ORIGIN, transport)
    assert client.models() == ("combo/Z", "Model A", "combo/Z")
    assert transport.calls == [
        {
            "instance_id": "studio-a",
            "origin": ORIGIN,
            "method": "GET",
            "path": "/models",
            "payload": None,
            "timeout_seconds": 30.0,
        }
    ]


@pytest.mark.parametrize(
    "origin",
    [
        "http://127.0.0.1:20128/v1",
        "http://192.168.1.9:20128/v1",
        "https://100.64.0.10:20128/v1",
        "http://100.64.0.10:20128/not-v1",
    ],
)
def test_constructor_rejects_non_tailnet_or_non_v1_origin(origin: str) -> None:
    with pytest.raises(ValueError):
        NineRouterClient("studio-a", origin, FakeTransport({}))


@pytest.fixture
def queue(tmp_path: Path) -> QueueStore:
    settings = Settings(DATABASE_URL=f"sqlite:///{tmp_path / 'queue.sqlite3'}")
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)
    command.upgrade(config, "head")
    return QueueStore(create_sqlite_engine(settings))


def enqueue(
    queue: QueueStore,
    operation: str = "brainstorm",
    payload: dict[str, object] | None = None,
    *,
    include_payload: bool = True,
) -> str:
    parameters: dict[str, object] = {
        "origin": ORIGIN,
        "idempotency_key": "job-key",
        "capability": operation,
    }
    if include_payload:
        parameters["assistant_payload"] = payload or {"topic": "Leaves"}
    job_id = queue.enqueue(
        job_type="assistant",
        provider_id="studio-a",
        model_id="combo/Exact ID",
        parameters=parameters,
    )
    queue.claim_next("worker", lease_seconds=30)
    return job_id


def test_brainstorm_job_uses_selected_instance_and_validated_result(queue: QueueStore) -> None:
    transport = FakeTransport(
        {
            "id": "chat-1",
            "model": "combo/Exact ID",
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "questions": ["Who?", "What?", "Where?"],
                                "recommendation": "Leaves",
                            }
                        )
                    }
                }
            ],
        }
    )
    client = NineRouterClient("studio-a", ORIGIN, transport)
    job_id = enqueue(queue)
    run_connector_dispatch(queue, ConnectorRegistry({"studio-a": client}), job_id, "worker")
    job = queue.get(job_id)
    assert job.status == "succeeded"
    assert job.remote_job_id == "chat-1"
    assert job.result_manifest is not None
    assert job.result_manifest["assistant"]["questions"] == ["Who?", "What?", "Where?"]
    assert job.result_manifest["model_id"] == "combo/Exact ID"
    call = transport.calls[0]
    assert call["instance_id"] == "studio-a"
    assert call["origin"] == ORIGIN
    assert call["path"] == "/chat/completions"
    assert call["payload"]["model"] == "combo/Exact ID"
    assert call["payload"]["stream"] is False
    assert 0 < call["timeout_seconds"] <= 300
    assert call["headers"] == {"Idempotency-Key": "job-key"}


@pytest.mark.parametrize(
    "operation,body",
    [
        ("finalize_prompt", {"prompt_text": "Leaves", "negative_prompt_text": "No logos"}),
        ("analyze_image", {"summary": "Leaves", "concerns": [], "blocker": False}),
        (
            "suggest_metadata",
            {"title": "Leaves", "keywords": ["leaf"], "release_group": "commercial"},
        ),
    ],
)
def test_other_assistant_operations(queue: QueueStore, operation: str, body: Any) -> None:
    transport = FakeTransport(
        {
            "id": "chat-2",
            "model": "combo/Exact ID",
            "choices": [{"message": {"content": json.dumps(body)}}],
        }
    )
    client = NineRouterClient("studio-a", ORIGIN, transport)
    job_id = enqueue(queue, operation)
    run_connector_dispatch(queue, ConnectorRegistry({"studio-a": client}), job_id, "worker")
    job = queue.get(job_id)
    assert job.status == "succeeded"
    assert job.result_manifest is not None
    assert job.result_manifest["assistant"] == {
        **body,
        "model_id": "combo/Exact ID",
        "operation": operation,
    }
    assert operation in transport.calls[0]["payload"]["messages"][0]["content"]


@pytest.mark.parametrize(
    "instance,origin", [("studio-b", ORIGIN), ("studio-a", "http://100.64.0.11:20128/v1")]
)
def test_mismatched_instance_or_origin_never_dispatches(
    queue: QueueStore,
    instance: str,
    origin: str,
) -> None:
    transport = FakeTransport({})
    client = NineRouterClient(instance, origin, transport)
    job_id = enqueue(queue)
    run_connector_dispatch(queue, ConnectorRegistry({"studio-a": client}), job_id, "worker")
    assert queue.get(job_id).status == "failed"
    assert queue.get(job_id).error_code == "IDENTITY_MISMATCH"
    assert transport.calls == []


def execution_for(queue: QueueStore, job_id: str) -> JobExecution:
    def mark_dispatched(remote: str | None) -> QueueJob:
        return queue.mark_dispatched(job_id, "worker", remote_job_id=remote)

    return JobExecution(
        job=queue.get(job_id),
        mark_dispatched=mark_dispatched,
        heartbeat=lambda: queue.heartbeat(job_id, "worker", lease_seconds=30),
        cancellation_requested=lambda: queue.cancellation_requested(job_id),
        timeout_seconds=300,
        deadline_frozen=time.monotonic() + 300,
    )


@pytest.mark.parametrize(
    "cancel,deadline,code", [(True, False, "CANCELLED"), (False, True, "PROVIDER_TIMEOUT")]
)
def test_preflight_cancellation_and_deadline_make_zero_calls(
    queue: QueueStore,
    cancel: bool,
    deadline: bool,
    code: str,
) -> None:
    job_id = enqueue(queue)
    execution = replace(
        execution_for(queue, job_id),
        cancellation_requested=lambda: cancel,
        deadline_frozen=0 if deadline else float("inf"),
    )
    transport = FakeTransport({})
    with pytest.raises(NineRouterError, match=f"^{code}$"):
        NineRouterClient("studio-a", ORIGIN, transport).dispatch(identity(), execution)
    assert transport.calls == []
    assert queue.get(job_id).status == "running"


@pytest.mark.parametrize(
    "response",
    [
        None,
        {},
        {
            "id": "x",
            "choices": [
                {"message": {"content": '{"questions":["A","B","C"],"recommendation":"OK"}'}}
            ],
        },
        {
            "id": "x",
            "model": "other-model",
            "choices": [
                {"message": {"content": '{"questions":["A","B","C"],"recommendation":"OK"}'}}
            ],
        },
        {"id": "x", "choices": []},
        {"id": "x", "choices": [{"message": {"content": "not JSON secret-value"}}]},
        {"id": "x", "choices": [{"message": {"content": "{}"}}]},
        {
            "id": "",
            "choices": [
                {"message": {"content": '{"questions":["A","B","C"],"recommendation":"OK"}'}}
            ],
        },
    ],
)
def test_malformed_response_is_redacted(queue: QueueStore, response: Any) -> None:
    import traceback

    job_id = enqueue(queue)
    client = NineRouterClient("studio-a", ORIGIN, FakeTransport(response))
    with pytest.raises(NineRouterError, match=r"^INVALID_RESPONSE$") as error:
        client.dispatch(identity(), execution_for(queue, job_id))
    assert "secret-value" not in "".join(traceback.format_exception(error.value))
    assert queue.get(job_id).status == "waiting_provider"


@pytest.mark.parametrize(
    "identity_value, parameters",
    [
        (identity("not-an-assistant-operation"), {"assistant_payload": {"topic": "Leaves"}}),
        (identity(), {}),
    ],
)
def test_unrecognized_operation_or_missing_payload_fails_closed_before_transport(
    queue: QueueStore,
    identity_value: DispatchIdentity,
    parameters: dict[str, object],
) -> None:
    payload_value = parameters.get("assistant_payload")
    payload = payload_value if isinstance(payload_value, dict) else None
    job_id = enqueue(
        queue,
        identity_value.capability,
        payload,
        include_payload="assistant_payload" in parameters,
    )
    transport = FakeTransport({})

    with pytest.raises(NineRouterError, match=r"^INVALID_REQUEST$"):
        NineRouterClient("studio-a", ORIGIN, transport).dispatch(
            identity_value,
            execution_for(queue, job_id),
        )

    assert transport.calls == []


@pytest.mark.parametrize(
    "status,code",
    [
        (401, "AUTH_REJECTED"),
        (403, "AUTH_REJECTED"),
        (429, "QUOTA_EXCEEDED"),
        (503, "PROVIDER_UNAVAILABLE"),
        (302, "INVALID_RESPONSE"),
        (0, "PROVIDER_TIMEOUT"),
        (-1, "PROVIDER_UNAVAILABLE"),
    ],
)
def test_transport_errors_are_stable_and_do_not_expose_secrets(status: int, code: str) -> None:
    import traceback

    import httpx

    class BrokenTransport(FakeTransport):
        def request(self, **kwargs: Any) -> Any:
            self.calls.append(kwargs)
            if status == 0:
                raise TimeoutError("secret-value")
            if status == -1:
                raise RuntimeError("secret-value")
            response = httpx.Response(status, request=httpx.Request("GET", ORIGIN))
            raise httpx.HTTPStatusError("secret-value", request=response.request, response=response)

    transport = BrokenTransport(None)
    with pytest.raises(NineRouterError, match=f"^{code}$") as error:
        NineRouterClient("studio-a", ORIGIN, transport).models()
    assert "secret-value" not in "".join(traceback.format_exception(error.value))
    assert len(transport.calls) == 1


@pytest.mark.parametrize("execution", [None, {}, object()])
def test_invalid_execution_is_fail_closed(execution: Any) -> None:
    transport = FakeTransport({})
    with pytest.raises(NineRouterError, match=r"^INVALID_REQUEST$"):
        NineRouterClient("studio-a", ORIGIN, transport).dispatch(identity(), execution)
    assert transport.calls == []


def test_cancel_requested_before_9router_transport_becomes_cancelled(
    queue: QueueStore,
) -> None:
    transport = FakeTransport({})
    client = NineRouterClient("studio-a", ORIGIN, transport)
    job_id = enqueue(queue)
    queue.request_cancel(job_id)

    run_connector_dispatch(queue, ConnectorRegistry({"studio-a": client}), job_id, "worker")

    final = queue.get(job_id)
    assert final.status == "cancelled"
    assert transport.calls == []


def test_cancel_arriving_after_bridge_preflight_becomes_cancelled(
    queue: QueueStore,
) -> None:
    class CancellingClient(NineRouterClient):
        def dispatch(
            self,
            identity: DispatchIdentity,
            execution: object,
        ) -> dict[str, object]:
            if not isinstance(execution, JobExecution):
                raise NineRouterError("INVALID_REQUEST")
            queue.request_cancel(execution.job.id)
            return super().dispatch(identity, execution)

    transport = FakeTransport({})
    client = CancellingClient("studio-a", ORIGIN, transport)
    job_id = enqueue(queue)

    run_connector_dispatch(queue, ConnectorRegistry({"studio-a": client}), job_id, "worker")

    final = queue.get(job_id)
    assert final.status == "cancelled"
    assert transport.calls == []


def test_response_after_frozen_deadline_requires_review(
    queue: QueueStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ticks = iter((0.0, 0.0, 0.0, 2.0))
    monkeypatch.setattr("gandiwa_api.connectors.ninerouter.time.monotonic", lambda: next(ticks))
    transport = FakeTransport(
        {
            "id": "chat-late",
            "model": "combo/Exact ID",
            "choices": [
                {
                    "message": {
                        "content": (
                            '{"questions":["Who?","What?","Where?"],"recommendation":"Leaves"}'
                        )
                    }
                }
            ],
        }
    )
    job_id = enqueue(queue)

    run_connector_dispatch(
        queue,
        ConnectorRegistry({"studio-a": NineRouterClient("studio-a", ORIGIN, transport)}),
        job_id,
        "worker",
        dispatch_timeout_seconds=1,
    )

    final = queue.get(job_id)
    assert final.status == "needs_review"
    assert final.error_code == "UNKNOWN_PROVIDER_OUTCOME"
    assert final.remote_job_id is None


def test_cancel_immediately_before_dispatch_boundary_is_cancelled_without_transport(
    queue: QueueStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_id = enqueue(queue)
    original_mark_dispatched = queue.mark_dispatched

    def cancel_before_mark(
        _job_id: str,
        worker_id: str,
        *,
        remote_job_id: str | None = None,
    ) -> QueueJob:
        queue.request_cancel(job_id)
        return original_mark_dispatched(job_id, worker_id, remote_job_id=remote_job_id)

    monkeypatch.setattr(queue, "mark_dispatched", cancel_before_mark)
    transport = FakeTransport({})

    run_connector_dispatch(
        queue,
        ConnectorRegistry({"studio-a": NineRouterClient("studio-a", ORIGIN, transport)}),
        job_id,
        "worker",
    )

    final = queue.get(job_id)
    assert final.status == "cancelled"
    assert transport.calls == []


def test_stale_lease_success_is_needs_review(
    queue: QueueStore,
) -> None:
    """A success arriving after the worker lost its lease maps to review, not success."""
    job_id = enqueue(queue)

    class _LeaseExpiringTransport:
        """Real transport whose DB lease expires while the blocking call runs."""

        def __init__(self) -> None:
            self.calls: list[str] = []

        def request(self, **kwargs: Any) -> Any:
            self.calls.append("io")
            with queue.engine.begin() as connection:
                connection.execute(
                    text("UPDATE generation_job SET lease_expires_at = :past WHERE id = :id"),
                    {"past": datetime(2000, 1, 1).isoformat(), "id": job_id},
                )
            return {
                "id": "chat-stale",
                "model": "combo/Exact ID",
                "choices": [
                    {
                        "message": {
                            "content": (
                                '{"questions":["Who?","What?","Where?"],"recommendation":"Leaves"}'
                            )
                        }
                    }
                ],
            }

    client = NineRouterClient("studio-a", ORIGIN, _LeaseExpiringTransport())
    run_connector_dispatch(
        queue,
        ConnectorRegistry({"studio-a": client}),
        job_id,
        "worker",
    )
    final = queue.get(job_id)
    assert final.status == "needs_review"
    assert final.error_code == "UNKNOWN_PROVIDER_OUTCOME"
    assert final.remote_job_id is None


def test_mid_call_lease_renewal_thread_keeps_lease_alive(queue: QueueStore) -> None:
    """A blocking call longer than the lease window renews it from the client."""
    beats: list[tuple[str, QueueJob]] = []
    original_heartbeat = queue.heartbeat
    parameters: dict[str, object] = {
        "origin": ORIGIN,
        "idempotency_key": "job-key",
        "capability": "brainstorm",
        "assistant_payload": {"topic": "Leaves"},
    }
    job_id = queue.enqueue(
        job_type="assistant",
        provider_id="studio-a",
        model_id="combo/Exact ID",
        parameters=parameters,
    )
    queue.claim_next("worker", lease_seconds=_MIDCALL_LEASE_SECONDS)

    def counting_heartbeat(inner_job_id: str, inner_worker: str, *, lease_seconds: int) -> QueueJob:
        beats.append(
            (
                threading.current_thread().name,
                original_heartbeat(inner_job_id, inner_worker, lease_seconds=lease_seconds),
            )
        )
        return beats[-1][1]

    class _SlowTransport:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def request(self, **kwargs: Any) -> Any:
            self.calls.append("io")
            time.sleep(_MIDCALL_SLEEP_SECONDS)
            return {
                "id": "chat-mid",
                "model": "combo/Exact ID",
                "choices": [
                    {
                        "message": {
                            "content": (
                                '{"questions":["Who?","What?","Where?"],"recommendation":"Leaves"}'
                            )
                        }
                    }
                ],
            }

    transport = _SlowTransport()
    client_with_thread = NineRouterClient(
        "studio-a",
        ORIGIN,
        transport,
        heartbeat_interval_seconds=_MIDCALL_INTERVAL_SECONDS,
    )
    queue.heartbeat = counting_heartbeat  # type: ignore[method-assign]
    try:
        run_connector_dispatch(
            queue,
            ConnectorRegistry({"studio-a": client_with_thread}),
            job_id,
            "worker",
        )
    finally:
        delattr(queue, "heartbeat")  # type: ignore[attr-defined]

    renewal_beats = [beat for thread_name, beat in beats if thread_name != "MainThread"]
    assert len(beats) >= _MIDCALL_MIN_BEATS
    assert renewal_beats, "the renewal thread must renew the lease while the call is still running"

    final = queue.get(job_id)
    assert final.status == "succeeded"
    assert final.remote_job_id == "chat-mid"
    assert transport.calls == ["io"]


def test_dispatch_renews_lease_around_blockcall(queue: QueueStore) -> None:
    """The 9Router connector itself must renew the lease around a slow call."""
    job_id = enqueue(queue)
    beats: list[QueueJob] = []
    original_heartbeat = queue.heartbeat

    def counting_heartbeat(inner_job_id: str, inner_worker: str, *, lease_seconds: int) -> QueueJob:
        beats.append(original_heartbeat(inner_job_id, inner_worker, lease_seconds=lease_seconds))
        return beats[-1]

    class SlowTransport:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def request(self, **kwargs: Any) -> Any:
            self.calls.append("io")
            return {
                "id": "slow-job",
                "model": "combo/Exact ID",
                "choices": [
                    {
                        "message": {
                            "content": (
                                '{"questions":["Who?","What?","Where?"],"recommendation":"Leaves"}'
                            )
                        }
                    }
                ],
            }

    transport = SlowTransport()
    client = NineRouterClient("studio-a", ORIGIN, transport)
    queue.heartbeat = counting_heartbeat  # type: ignore[method-assign]
    try:
        run_connector_dispatch(
            queue,
            ConnectorRegistry({"studio-a": client}),
            job_id,
            "worker",
        )
    finally:
        delattr(queue, "heartbeat")  # type: ignore[attr-defined]

    final = queue.get(job_id)
    assert final.status == "succeeded"
    assert final.remote_job_id == "slow-job"
    assert transport.calls == ["io"]
    assert len(beats) >= 2, "expected lease renewal before and after the blocking call"
