"""Issue #26 HTTP boundary: browser-approved snapshot → owned durable queue job."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config

from gandiwa_api.config import Settings
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.main import app
from gandiwa_api.queue import QueueStore

pytestmark = pytest.mark.anyio


def _alembic_config(database_url: str) -> Config:
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


def _payload() -> dict[str, object]:
    return {
        "session": {
            "topic": "Ceramic mug",
            "human_prompt_approval": True,
            "approved_prompt_digest": "",  # replaced after client-side digest fixture setup
            "prompt": {
                "prompt_text": "Editorial ceramic mug on linen, 2400x1667 output",
                "negative_prompt_text": "logo, brand, watermark, random text",
                "content_type": "illustration",
                "creation_method": "generative_ai",
                "provider_id": "fal",
                "model_id": "fal-ai/flux/dev",
                "target_width": 2400,
                "target_height": 1667,
                "aspect_ratio": "3:2",
                "orientation": "landscape",
                "stock_constraints": {
                    "no_logo": True,
                    "no_brand": True,
                    "no_watermark": True,
                    "no_random_text": True,
                    "no_fake_ui": True,
                    "no_unintentional_crop": True,
                    "no_malformed_anatomy": True,
                    "no_copyrighted_property": True,
                    "negative_space_decision": "right third open",
                },
            },
        },
        "rules_snapshot": {
            "id": "adobe-stock-2026-09-08-v1",
            "version": "adobe-stock-2026-09-08-v1",
        },
        "idempotency_key": "beranda-job-001",
    }


async def _csrf(client: httpx.AsyncClient) -> str:
    response = await client.get("/api/v1/auth/csrf")
    assert response.status_code == 200
    return str(response.json()["csrf_token"])


def _approved_payload() -> dict[str, object]:
    from gandiwa_api.creative.approval import current_prompt_digest
    from gandiwa_api.creative.models import CreativeSession

    payload = _payload()
    session = CreativeSession.model_validate(payload["session"])
    payload["session"]["approved_prompt_digest"] = current_prompt_digest(session)  # type: ignore[index]
    return payload


@pytest.mark.anyio
async def test_creative_job_requires_an_owned_session_and_csrf(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "creative.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    command.upgrade(_alembic_config(f"sqlite:///{database}"), "head")
    monkeypatch.setenv("GANDIWA_DATABASE_URL", f"sqlite:///{database}")
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(artifacts))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/v1/creative/jobs", json=_payload())
        assert response.status_code == 403

        csrf = await _csrf(client)
        response = await client.post(
            "/api/v1/creative/jobs",
            json=_payload(),
            headers={"X-CSRF-Token": csrf},
        )
        assert response.status_code == 401


@pytest.mark.anyio
async def test_creative_job_enqueues_only_an_exact_human_approved_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "creative.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    command.upgrade(_alembic_config(f"sqlite:///{database}"), "head")
    monkeypatch.setenv("GANDIWA_DATABASE_URL", f"sqlite:///{database}")
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(artifacts))
    payload = _approved_payload()

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        bootstrap = await client.get("/api/v1/creative/bootstrap")
        assert bootstrap.status_code == 200
        assert bootstrap.json() == {"session_ready": True}
        csrf = await _csrf(client)
        response = await client.post(
            "/api/v1/creative/jobs",
            json=payload,
            headers={"X-CSRF-Token": csrf},
        )
        assert response.status_code == 201
        job = response.json()
        assert job["status"] == "queued"
        assert job["provider_id"] == "fal"
        assert job["model_id"] == "fal-ai/flux/dev"
        assert job["artifact"] is None
        assert "parameters" not in job
        assert "owner_session_id" not in job

        own_status = await client.get(f"/api/v1/creative/jobs/{job['id']}")
        assert own_status.status_code == 200
        assert own_status.json()["id"] == job["id"]

        other = httpx.AsyncClient(transport=transport, base_url="http://test")
        try:
            await other.get("/api/v1/creative/bootstrap")
            denied = await other.get(f"/api/v1/creative/jobs/{job['id']}")
            assert denied.status_code == 404
        finally:
            await other.aclose()

        cancelled = await client.delete(
            f"/api/v1/creative/jobs/{job['id']}",
            headers={"X-CSRF-Token": csrf},
        )
        assert cancelled.status_code == 200
        assert cancelled.json()["cancel_requested"] is True

        queue = QueueStore(create_sqlite_engine(Settings()))
        assert queue.get(str(job["id"])).cancel_requested_at is not None


@pytest.mark.anyio
async def test_creative_enqueue_retry_returns_the_owned_existing_job_without_a_second_queue_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "creative.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    command.upgrade(_alembic_config(f"sqlite:///{database}"), "head")
    monkeypatch.setenv("GANDIWA_DATABASE_URL", f"sqlite:///{database}")
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(artifacts))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        await client.get("/api/v1/creative/bootstrap")
        csrf = await _csrf(client)
        payload = _approved_payload()
        first = await client.post(
            "/api/v1/creative/jobs", json=payload, headers={"X-CSRF-Token": csrf}
        )
        retry = await client.post(
            "/api/v1/creative/jobs", json=payload, headers={"X-CSRF-Token": csrf}
        )
        assert first.status_code == 201
        assert retry.status_code == 201
        assert retry.json()["id"] == first.json()["id"]
        queue = QueueStore(create_sqlite_engine(Settings()))
        assert queue.claim_next("worker-a", lease_seconds=30).id == first.json()["id"]
        assert queue.claim_next("worker-b", lease_seconds=30) is None


@pytest.mark.anyio
async def test_creative_job_refuses_unapproved_snapshot_before_queue_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "creative.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    command.upgrade(_alembic_config(f"sqlite:///{database}"), "head")
    monkeypatch.setenv("GANDIWA_DATABASE_URL", f"sqlite:///{database}")
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(artifacts))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        await client.get("/api/v1/creative/bootstrap")
        csrf = await _csrf(client)
        response = await client.post(
            "/api/v1/creative/jobs",
            json=_payload(),
            headers={"X-CSRF-Token": csrf},
        )
        assert response.status_code == 422
        assert "approval" in response.json()["detail"].lower()
        queue = QueueStore(create_sqlite_engine(Settings()))
        assert queue.claim_next("worker", lease_seconds=30) is None
