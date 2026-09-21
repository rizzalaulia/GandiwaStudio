"""Issue #25 integration: approved creative session → durable fal job → connector worker."""

from __future__ import annotations

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config

from gandiwa_api.config import Settings
from gandiwa_api.connectors.base import DispatchIdentity
from gandiwa_api.connectors.registry import ConnectorRegistry
from gandiwa_api.creative.dispatch_policy import (
    GenerationDispatchError,
    enqueue_approved_generation,
    prompt_snapshot_digest,
)
from gandiwa_api.creative.models import CreativeSession, PromptSnapshot, StockConstraints
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.queue import JobExecution, QueueStore
from gandiwa_api.worker import Worker


def _alembic_config(database_url: str) -> Config:
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


def settings(tmp_path: Path) -> Settings:
    return Settings(
        DATABASE_URL=f"sqlite:///{tmp_path / 'integration.sqlite3'}",
        ARTIFACT_DIR=tmp_path / "artifacts",
    )


def valid_session(*, approved: bool = True) -> CreativeSession:
    session = CreativeSession(
        topic="ceramic mug",
        human_prompt_approval=approved,
        prompt=PromptSnapshot(
            prompt_text="Editorial ceramic mug on linen, 2400x1667 output",
            negative_prompt_text="logo, brand, watermark, random text",
            content_type="raster",
            creation_method="generative_ai",
            provider_id="fal",
            model_id="fal-ai/flux/dev",
            target_width=2400,
            target_height=1667,
            aspect_ratio="3:2",
            orientation="landscape",
            stock_constraints=StockConstraints(
                no_logo=True,
                no_brand=True,
                no_watermark=True,
                no_random_text=True,
                no_fake_ui=True,
                no_unintentional_crop=True,
                no_malformed_anatomy=True,
                no_copyrighted_property=True,
                negative_space_decision="right third open",
            ),
        ),
    )
    if approved:
        session.approved_prompt_digest = prompt_snapshot_digest(session)
    return session


def test_enqueue_records_explicit_model_parameters_rules_and_approval(tmp_path: Path) -> None:
    runtime = settings(tmp_path)
    command.upgrade(_alembic_config(runtime.DATABASE_URL), "head")
    queue = QueueStore(create_sqlite_engine(runtime))
    session = valid_session()
    rules_snapshot = {
        "id": "adobe-stock",
        "version": "2026-09-15",
        "constraints": ["no-logo", "no-watermark"],
    }

    job_id = enqueue_approved_generation(
        queue,
        session,
        owner_session_id="session-a",
        rules_snapshot=rules_snapshot,
        idempotency_key="fal-job-idem-001",
        origin="https://queue.fal.run",
    )

    job = queue.get(job_id)
    assert job.provider_id == "fal"
    assert job.model_id == "fal-ai/flux/dev"
    assert job.parameters["rules_snapshot"] == rules_snapshot
    assert job.parameters["approved_prompt_digest"] == prompt_snapshot_digest(session)
    assert job.parameters["generation_payload"] == {
        "prompt": session.prompt.prompt_text,
        "negative_prompt": session.prompt.negative_prompt_text,
        "image_size": {"width": 2400, "height": 1667},
        "num_images": 1,
    }
    assert job.parameters["owner_session_id"] == "session-a"
    assert job.parameters["origin"] == "https://queue.fal.run"
    assert job.parameters["idempotency_key"] == "fal-job-idem-001"
    assert job.parameters["capability"] == "generate_image"
    assert session.last_dispatched_prompt_digest == prompt_snapshot_digest(session)

    with pytest.raises(GenerationDispatchError, match="already"):
        enqueue_approved_generation(
            queue,
            session,
            owner_session_id="session-a",
            rules_snapshot=rules_snapshot,
            idempotency_key="fal-job-idem-002",
            origin="https://queue.fal.run",
        )


@pytest.mark.parametrize("mutation", ["unapproved", "blocked", "empty_rules", "bad_origin"])
def test_enqueue_refuses_before_durable_job_when_gate_or_approval_missing(
    tmp_path: Path, mutation: str
) -> None:
    runtime = settings(tmp_path)
    command.upgrade(_alembic_config(runtime.DATABASE_URL), "head")
    queue = QueueStore(create_sqlite_engine(runtime))
    session = valid_session()
    rules: dict[str, object] = {"id": "adobe-stock", "version": "2026-09-15"}
    if mutation == "unapproved":
        session.human_prompt_approval = False
        session.approved_prompt_digest = None
    elif mutation == "blocked":
        session.prompt.target_width = 800
        session.prompt.target_height = 600
    elif mutation == "empty_rules":
        rules = {}
    origin = "https://evil.example" if mutation == "bad_origin" else "https://queue.fal.run"

    with pytest.raises(GenerationDispatchError):
        enqueue_approved_generation(
            queue,
            session,
            owner_session_id="session-a",
            rules_snapshot=rules,
            idempotency_key="fal-job-idem-001",
            origin=origin,
        )

    assert queue.claim_next("worker", lease_seconds=30) is None


class SuccessfulConnector:
    capabilities = ("generate_image",)

    def __init__(self) -> None:
        self.calls: list[DispatchIdentity] = []

    def dispatch(self, identity: DispatchIdentity, execution: object) -> dict[str, object]:
        assert isinstance(execution, JobExecution)
        self.calls.append(identity)
        execution.mark_dispatched(None)
        execution.record_remote_job_id("fal-request-123")
        return {"provider_job_id": "fal-request-123", "artifact": {"id": "opaque"}}


def test_unknown_fal_dispatch_is_needs_review_without_fallback(tmp_path: Path) -> None:
    runtime = settings(tmp_path)
    command.upgrade(_alembic_config(runtime.DATABASE_URL), "head")
    queue = QueueStore(create_sqlite_engine(runtime))
    job_id = queue.enqueue(
        job_type="generate",
        provider_id="fal",
        model_id="fal-ai/flux/dev",
        parameters={
            "origin": "https://queue.fal.run",
            "idempotency_key": "fal-job-idem-001",
            "capability": "generate_image",
        },
    )
    worker = Worker(
        runtime,
        connector_registry=ConnectorRegistry({}),
        connector_job_types={"generate"},
        worker_id="worker-test",
    )

    assert worker.run_once() is True
    final = queue.get(job_id)
    assert final.status == "needs_review"
    assert final.error_code == "UNKNOWN_DISPATCH"


def test_worker_connector_path_dispatches_once_without_double_finalization(tmp_path: Path) -> None:
    runtime = settings(tmp_path)
    command.upgrade(_alembic_config(runtime.DATABASE_URL), "head")
    queue = QueueStore(create_sqlite_engine(runtime))
    connector = SuccessfulConnector()
    registry = ConnectorRegistry({"fal": connector})
    job_id = queue.enqueue(
        job_type="generate",
        provider_id="fal",
        model_id="fal-ai/flux/dev",
        parameters={
            "origin": "https://queue.fal.run",
            "idempotency_key": "fal-job-idem-001",
            "capability": "generate_image",
        },
    )
    worker = Worker(
        runtime,
        connector_registry=registry,
        connector_job_types={"generate"},
        worker_id="worker-test",
    )

    assert worker.run_once() is True
    final = queue.get(job_id)
    assert final.status == "succeeded"
    assert final.remote_job_id == "fal-request-123"
    assert final.result_manifest == {
        "provider_job_id": "fal-request-123",
        "artifact": {"id": "opaque"},
    }
    assert len(connector.calls) == 1
