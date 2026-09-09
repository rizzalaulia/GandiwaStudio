"""Integration tests for main security endpoints (providers, csrf, artifact download)."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from gandiwa_api.main import app
from gandiwa_api.security.csrf import SESSION_COOKIE_NAME, sign_session_id

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


async def test_main_app_artifact_download(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()
    sample_svg = artifacts_dir / "render.svg"
    sample_svg.write_text("<svg></svg>", encoding="utf-8")

    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(artifacts_dir))

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        anonymous_response = await client.get("/api/v1/artifacts/render.svg/download")
        assert anonymous_response.status_code == 401

        client.cookies.set(
            SESSION_COOKIE_NAME,
            sign_session_id("test-session", "change-me-for-local-development"),
        )
        response = await client.get("/api/v1/artifacts/render.svg/download")

    assert response.status_code == 200
    assert response.text == "<svg></svg>"
    assert response.headers.get("content-disposition", "").startswith("attachment;")
    assert response.headers.get("x-content-type-options") == "nosniff"
