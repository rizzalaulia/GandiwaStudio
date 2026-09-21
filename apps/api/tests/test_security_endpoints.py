"""Integration tests for main security endpoints (providers, csrf, artifact download)."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config

from gandiwa_api.artifact_store import ArtifactStore
from gandiwa_api.config import Settings
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.main import app
from gandiwa_api.security.csrf import SESSION_COOKIE_NAME, sign_session_id


def _alembic_config(database_url: str) -> Config:
    api_root = Path(__file__).resolve().parents[1]
    config = Config(str(api_root / "alembic.ini"))
    config.set_main_option("script_location", str(api_root / "migrations"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


pytestmark = pytest.mark.anyio


async def test_providers_endpoint_does_not_leak_secrets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret_key = "super-secret-fal-key-123"
    monkeypatch.setenv("GANDIWA_FAL_KEY", secret_key)
    monkeypatch.setenv("GANDIWA_NINEROUTER_BASE_URL", "http://100.98.114.115:20128/v1")
    monkeypatch.setenv("GANDIWA_NINEROUTER_API_KEY", "secret-9router-token")

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/v1/providers")
        assert response.status_code == 200

        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 2

        # Check no secret leaks
        raw_text = response.text
        assert secret_key not in raw_text
        assert "secret-9router-token" not in raw_text
        assert "100.98.114.115" not in raw_text  # URL is not exposed to frontend

        provider_map = {item["id"]: item for item in data}
        assert provider_map["fal"]["configured"] is True
        assert provider_map["9router"]["configured"] is True


async def test_providers_endpoint_reflects_unconfigured_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GANDIWA_FAL_KEY", raising=False)
    monkeypatch.delenv("FAL_KEY", raising=False)
    monkeypatch.delenv("GANDIWA_NINEROUTER_BASE_URL", raising=False)
    monkeypatch.delenv("NINEROUTER_BASE_URL", raising=False)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/v1/providers")
        assert response.status_code == 200
        data = response.json()
        provider_map = {item["id"]: item for item in data}
        assert provider_map["fal"]["configured"] is False
        assert provider_map["9router"]["configured"] is False


async def test_main_app_csrf_endpoint() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/v1/auth/csrf")
        assert response.status_code == 200
        data = response.json()
        assert "csrf_token" in data
        assert "gandiwa_csrf" in response.cookies


async def test_artifact_record_download_requires_matching_owner_and_is_safe(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()
    database_url = f"sqlite:///{tmp_path / 'artifacts.sqlite3'}"
    command.upgrade(_alembic_config(database_url), "head")
    store = ArtifactStore(
        create_sqlite_engine(Settings(DATABASE_URL=database_url, ARTIFACT_DIR=artifacts_dir)),
        artifacts_dir,
    )
    artifact = store.stage_bytes(
        job_id="11111111-1111-1111-1111-111111111111",
        owner_session_id="owner-session",
        download_name="render.svg",
        media_type="image/svg+xml",
        payload=b"<svg></svg>",
        ttl_seconds=300,
    )
    monkeypatch.setenv("GANDIWA_DATABASE_URL", database_url)
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(artifacts_dir))

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.set(
            SESSION_COOKIE_NAME,
            sign_session_id("owner-session", "change-me-for-local-development"),
        )
        response = await client.get(f"/api/v1/artifacts/{artifact.id}/download")
        reopened = await client.get(f"/api/v1/artifacts/{artifact.id}/download")
        client.cookies.set(
            SESSION_COOKIE_NAME,
            sign_session_id("other-session", "change-me-for-local-development"),
        )
        forbidden = await client.get(f"/api/v1/artifacts/{artifact.id}/download")

    assert response.status_code == 200
    assert reopened.status_code == 200
    assert response.content == b"<svg></svg>"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-gandiwa-sha256"] == artifact.sha256
    assert forbidden.status_code == 404


async def test_artifact_download_refuses_checksum_tampering(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()
    database_url = f"sqlite:///{tmp_path / 'artifacts.sqlite3'}"
    command.upgrade(_alembic_config(database_url), "head")
    store = ArtifactStore(
        create_sqlite_engine(Settings(DATABASE_URL=database_url, ARTIFACT_DIR=artifacts_dir)),
        artifacts_dir,
    )
    artifact = store.stage_bytes(
        job_id="11111111-1111-1111-1111-111111111111",
        owner_session_id="owner-session",
        download_name="result.png",
        media_type="image/png",
        payload=b"trusted bytes",
        ttl_seconds=300,
    )
    store.private_path(artifact).write_bytes(b"tampered bytes")
    monkeypatch.setenv("GANDIWA_DATABASE_URL", database_url)
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(artifacts_dir))

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.set(
            SESSION_COOKIE_NAME,
            sign_session_id("owner-session", "change-me-for-local-development"),
        )
        response = await client.get(f"/api/v1/artifacts/{artifact.id}/download")

    assert response.status_code == 404


async def test_main_app_artifact_download_requires_auth_before_record_lookup(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()
    database_url = f"sqlite:///{tmp_path / 'artifacts.sqlite3'}"
    command.upgrade(_alembic_config(database_url), "head")
    monkeypatch.setenv("GANDIWA_DATABASE_URL", database_url)
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(artifacts_dir))

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        anonymous_response = await client.get(
            "/api/v1/artifacts/11111111-1111-1111-1111-111111111111/download"
        )
        assert anonymous_response.status_code == 401

        client.cookies.set(
            SESSION_COOKIE_NAME,
            sign_session_id("test-session", "change-me-for-local-development"),
        )
        unknown_response = await client.get(
            "/api/v1/artifacts/11111111-1111-1111-1111-111111111111/download"
        )

    assert unknown_response.status_code == 404
