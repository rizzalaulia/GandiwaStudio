"""OpenAI worker wiring contracts without a live provider request."""

from __future__ import annotations

from pathlib import Path

from gandiwa_api.config import Settings
from gandiwa_api.worker import build_production_worker


def test_production_worker_claims_generation_jobs_when_only_openai_is_registered(
    tmp_path: Path,
) -> None:
    settings = Settings(
        DATABASE_URL=f"sqlite:///{tmp_path / 'worker.sqlite3'}",
        ARTIFACT_DIR=tmp_path / "artifacts",
        **{"OPENAI_API_KEY": "synthetic-openai-token"},
    )

    worker = build_production_worker(settings)

    assert worker._connector_job_types == frozenset({"generate"})
    # Registry is rebuilt per claimed job so Settings key rotation needs no restart.
    assert worker._connector_registry is None
    assert worker._connector_registry_factory is not None
    assert worker._connector_registry_factory().registered_providers == ("openai",)
