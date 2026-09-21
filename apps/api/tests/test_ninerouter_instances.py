"""Slice B: two named, backend-configured 9Router instances (Issue #24)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config

from gandiwa_api.config import Settings
from gandiwa_api.connectors.ninerouter import NineRouterClient
from gandiwa_api.connectors.registry import ConnectorRegistry
from gandiwa_api.connectors.runtime import build_assistant_registry
from gandiwa_api.connectors.task import run_connector_dispatch
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.queue import QueueStore
from gandiwa_api.security.providers import get_configured_providers

ORIGIN_A = "http://100.64.0.10:20128/v1"
ORIGIN_B = "http://100.64.0.11:20128/v1"


def settings_with_instances(tmp_path: Path | None = None, **extra: Any) -> Settings:
    fields: dict[str, Any] = {
        "NINEROUTER_INSTANCES": f"studio-a={ORIGIN_A};studio-b={ORIGIN_B}",
        "NINEROUTER_API_KEY_INSTANCE": {"STUDIO-A": "token-A", "STUDIO-B": "token-B"},
    }
    fields.update(extra)
    if tmp_path is not None and "DATABASE_URL" not in fields:
        fields["DATABASE_URL"] = f"sqlite:///{tmp_path / 'settings.sqlite3'}"
    return Settings(**fields)


def os_env_with_instances(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GANDIWA_NINEROUTER_INSTANCES", f"studio-a={ORIGIN_A};studio-b={ORIGIN_B}")
    monkeypatch.setenv("GANDIWA_NINEROUTER_API_KEY_STUDIO_A", "token-A")
    monkeypatch.setenv("GANDIWA_NINEROUTER_API_KEY_STUDIO_B", "token-B")


@pytest.fixture
def queue(tmp_path: Path) -> QueueStore:
    settings = Settings(DATABASE_URL=f"sqlite:///{tmp_path / 'queue.sqlite3'}")
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)
    command.upgrade(config, "head")
    return QueueStore(create_sqlite_engine(settings))


class FakeTransport:
    def __init__(self, body: dict[str, object]) -> None:
        self.body = body
        self.calls: list[dict[str, object]] = []

    def request(self, **kwargs: object) -> dict[str, object]:
        self.calls.append(kwargs)
        return self.body


def _chat_body(model: str, remote_id: str) -> dict[str, object]:
    return {
        "id": remote_id,
        "model": model,
        "choices": [
            {
                "message": {
                    "content": '{"questions": ["q1", "q2", "q3"], "recommendation": "r"}',
                },
            },
        ],
    }


# --- Behavior 1: settings parse two named instances -------------------------


def test_settings_parse_two_named_instances_with_per_instance_keys(tmp_path: Path) -> None:
    settings = settings_with_instances(tmp_path)
    assert settings.ninerouter_instance_origins() == {"studio-a": ORIGIN_A, "studio-b": ORIGIN_B}
    assert settings.ninerouter_instance_api_key("studio-a") == "token-A"
    assert settings.ninerouter_instance_api_key("studio-b") == "token-B"
    assert settings.ninerouter_instance_api_key("studio-c") is None


def test_settings_instances_parse_from_os_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    os_env_with_instances(monkeypatch)
    settings = Settings()
    assert settings.ninerouter_instance_origins() == {"studio-a": ORIGIN_A, "studio-b": ORIGIN_B}
    assert settings.ninerouter_instance_api_key("studio-a") == "token-A"
    assert settings.ninerouter_instance_api_key("studio-b") == "token-B"


def test_settings_reject_malformed_instances_spec(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="NINEROUTER_INSTANCES"):
        settings_with_instances(tmp_path, NINEROUTER_INSTANCES="studio-a")


def test_settings_reject_key_without_matching_instance(tmp_path: Path) -> None:
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setenv("GANDIWA_NINEROUTER_API_KEY_STUDIO_B", "token-B")
    try:
        with pytest.raises(ValueError, match="unknown instance"):
            Settings(NINEROUTER_INSTANCES=f"studio-a={ORIGIN_A}")
    finally:
        monkeypatch.undo()


# --- Behavior 2: providers list each named instance, no URLs/keys -----------


def test_providers_list_both_instances_without_endpoints_or_secrets(tmp_path: Path) -> None:
    settings = settings_with_instances(tmp_path)
    providers = get_configured_providers(settings)
    provider_map = {provider.id: provider for provider in providers}
    assert provider_map["fal"].configured is False  # no fal key in this env
    assert provider_map["studio-a"].configured is True
    assert provider_map["studio-b"].configured is True
    assert all(provider.auth_required for provider in providers)
    raw_text = repr([provider.model_dump() for provider in providers])
    assert ORIGIN_A not in raw_text
    assert ORIGIN_B not in raw_text
    assert "token-A" not in raw_text
    assert "token-B" not in raw_text


# --- Behavior 3: connector registry construction from validated instances ----


class KeyInjectingTransport(FakeTransport):
    """Records the Authorization header the client injected for one instance."""

    def request(self, **kwargs: object) -> dict[str, object]:
        self.calls.append(kwargs)
        return self.body


def build_registry_from_settings(
    settings: Settings,
    transports: dict[str, FakeTransport],
) -> ConnectorRegistry:
    return build_assistant_registry(settings, base_transports=dict(transports))


def test_registry_builds_one_ready_connector_per_configured_instance(tmp_path: Path) -> None:
    settings = settings_with_instances(tmp_path)
    transports: dict[str, FakeTransport] = {
        "studio-a": FakeTransport(_chat_body("combo/Exact ID", "chat-1")),
        "studio-b": FakeTransport(_chat_body("combo/Exact ID", "chat-2")),
    }
    registry = build_registry_from_settings(settings, transports)
    assert registry.registered_providers == ("studio-a", "studio-b")


def test_registry_refuses_unconfigured_or_invalid_instance(tmp_path: Path) -> None:
    settings = settings_with_instances(tmp_path)
    registry = build_registry_from_settings(
        settings,
        {"studio-a": FakeTransport({}), "studio-b": FakeTransport({})},
    )
    with pytest.raises(LookupError):
        registry.resolve("studio-c")
    # A settings with a malformed origin must not yield a ready connector either.
    bad = Settings(
        NINEROUTER_INSTANCES="studio-a=http://192.168.1.9:20128/v1",
        NINEROUTER_API_KEY_INSTANCE={"STUDIO_A": "token"},
    )
    bad_registry = build_registry_from_settings(bad, {"studio-a": FakeTransport({})})
    assert bad_registry.registered_providers == ()


def test_unknown_instance_job_resolves_needs_review_unknown_dispatch(queue: QueueStore) -> None:
    client = NineRouterClient(
        "studio-a",
        ORIGIN_A,
        FakeTransport(_chat_body("combo/Exact ID", "chat-1")),
    )
    registry = ConnectorRegistry({"studio-a": client})
    job_id = queue.enqueue(
        job_type="assistant",
        provider_id="studio-unknown",
        model_id="combo/Exact ID",
        parameters={
            "origin": ORIGIN_A,
            "idempotency_key": "job-key",
            "capability": "brainstorm",
            "assistant_payload": {"topic": "Leaves"},
        },
    )
    queue.claim_next("worker", lease_seconds=30)
    run_connector_dispatch(queue, registry, job_id, "worker")
    job = queue.get(job_id)
    assert job.status == "needs_review"
    assert job.error_code == "UNKNOWN_DISPATCH"


# --- Behavior 5: durable job stores the selected named instance --------------


def test_durable_job_binds_selected_instance_with_origin_from_that_instance(
    queue: QueueStore,
) -> None:
    settings = settings_with_instances()  # instance configuration
    transports = {
        "studio-a": FakeTransport(_chat_body("combo/Exact ID", "remote-A")),
        "studio-b": FakeTransport(_chat_body("combo/Exact ID", "remote-B")),
    }
    registry = build_registry_from_settings(settings, transports)
    job_id = queue.enqueue(
        job_type="assistant",
        provider_id="studio-b",  # the human picked studio-b in the UI
        model_id="combo/Exact ID",
        parameters={
            "origin": ORIGIN_B,
            "idempotency_key": "pick-b",
            "capability": "brainstorm",
            "assistant_payload": {"topic": "Leaves"},
        },
    )
    queue.claim_next("worker", lease_seconds=30)
    run_connector_dispatch(queue, registry, job_id, "worker")
    job = queue.get(job_id)
    assert job.status == "succeeded"
    assert job.provider_id == "studio-b"
    assert job.remote_job_id == "remote-B"
    assert job.result_manifest is not None
    assert job.result_manifest["provider_id"] == "studio-b"
    assert job.result_manifest["origin"] == ORIGIN_B
    # The other instance made zero calls: no fallback, no autoselection.
    assert transports["studio-a"].calls == []


def test_identity_mismatch_between_instances_fails_closed(queue: QueueStore) -> None:
    settings = settings_with_instances()
    transports = {
        "studio-a": FakeTransport(_chat_body("combo/Exact ID", "remote-A")),
        "studio-b": FakeTransport(_chat_body("combo/Exact ID", "remote-B")),
    }
    registry = build_registry_from_settings(settings, transports)
    # Job claims studio-b but its origin parameter is studio-a's: identity frozen fails closed.
    job_id = queue.enqueue(
        job_type="assistant",
        provider_id="studio-b",
        model_id="combo/Exact ID",
        parameters={
            "origin": ORIGIN_A,
            "idempotency_key": "mismatch",
            "capability": "brainstorm",
            "assistant_payload": {"topic": "Leaves"},
        },
    )
    queue.claim_next("worker", lease_seconds=30)
    run_connector_dispatch(queue, registry, job_id, "worker")
    job = queue.get(job_id)
    assert job.status == "failed"
    assert job.error_code == "IDENTITY_MISMATCH"


# --- Key injection stays server-side only -----------------------------------


def test_registry_injects_only_the_selected_instances_key(tmp_path: Path) -> None:
    transport = FakeTransport({"data": []})
    settings = settings_with_instances(tmp_path)
    registry = build_assistant_registry(settings, base_transports={"studio-b": transport})
    registry.resolve("studio-b").models()
    headers = transport.calls[-1]["headers"]
    assert headers["Authorization"] == "Bearer token-B"
    assert "token-B" not in repr(settings.model_dump())


def test_job_result_and_parameters_never_carry_the_instance_key(queue: QueueStore) -> None:
    settings = settings_with_instances()
    transports = {
        "studio-a": FakeTransport(_chat_body("combo/Exact ID", "remote-A")),
        "studio-b": FakeTransport(_chat_body("combo/Exact ID", "remote-B")),
    }
    registry = build_registry_from_settings(settings, transports)
    job_id = queue.enqueue(
        job_type="assistant",
        provider_id="studio-b",
        model_id="combo/Exact ID",
        parameters={
            "origin": ORIGIN_B,
            "idempotency_key": "secret-boundary",
            "capability": "brainstorm",
            "assistant_payload": {"topic": "Leaves"},
        },
    )
    queue.claim_next("worker", lease_seconds=30)
    run_connector_dispatch(queue, registry, job_id, "worker")
    job = queue.get(job_id)
    raw = repr(
        {
            "parameters": job.parameters,
            "result": job.result_manifest,
            "provider_id": job.provider_id,
        }
    )
    assert "token-B" not in raw and "token-A" not in raw
