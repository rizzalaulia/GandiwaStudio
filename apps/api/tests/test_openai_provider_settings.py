"""OpenAI Settings key storage and non-generative probe contracts."""

from __future__ import annotations

import httpx
import pytest

from gandiwa_api import main as api_main
from gandiwa_api.config import Settings
from gandiwa_api.main import app

pytestmark = pytest.mark.anyio


async def _csrf(client: httpx.AsyncClient) -> str:
    response = await client.get("/api/v1/auth/csrf")
    assert response.status_code == 200
    return str(response.json()["csrf_token"])


async def _save_openai_key(client: httpx.AsyncClient, key: str) -> httpx.Response:
    return await client.post(
        "/api/v1/settings/providers",
        json={"providers": [{"provider": "openai", "apiKey": key}]},
        headers={"X-CSRF-Token": await _csrf(client)},
    )


async def test_openai_settings_key_is_encrypted_masked_and_marks_provider_configured(
    tmp_path, monkeypatch
) -> None:
    secret = Settings().SESSION_SECRET
    monkeypatch.setenv("GANDIWA_PROVIDER_KEY_STORE", str(tmp_path / "provider-keys.json"))
    monkeypatch.setenv("GANDIWA_SESSION_SECRET", secret)
    key = "synthetic-openai-key-not-for-network"
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        saved = await _save_openai_key(client, key)
        assert saved.status_code == 200, saved.text
        stored = await client.get("/api/v1/settings/providers")
        listed = await client.get("/api/v1/providers")

    assert stored.status_code == 200
    assert key not in stored.text
    states = {item["provider"]: item for item in stored.json()}
    assert states["openai"] == {"provider": "openai", "configured": True, "maskedKey": "****work"}
    assert states["fal"]["configured"] is False
    assert states["9router"]["configured"] is False
    assert {item["id"]: item["configured"] for item in listed.json()}["openai"] is True
    assert key.encode() not in (tmp_path / "provider-keys.json").read_bytes()


async def test_openai_connection_probe_is_non_generative_and_redacts_account_restriction(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setenv("GANDIWA_PROVIDER_KEY_STORE", str(tmp_path / "provider-keys.json"))
    monkeypatch.setattr(
        api_main,
        "_probe_provider_auth",
        lambda provider, _key: (
            (False, "account_restricted", True)
            if provider == "openai"
            else (False, "unreachable", False)
        ),
    )
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        saved = await _save_openai_key(client, "synthetic-openai-key-not-for-network")
        assert saved.status_code == 200, saved.text
        probe = await client.get("/api/v1/settings/providers/openai/validate")

    assert probe.status_code == 200
    assert probe.json() == {
        "ok": False,
        "provider": "openai",
        "probe": "provider_auth",
        "reason": "account_restricted",
        "authenticated": True,
    }
