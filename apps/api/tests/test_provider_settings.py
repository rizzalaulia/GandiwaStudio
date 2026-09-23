"""Slice 2 — Settings provider API keys: encrypted runtime store + honest endpoints.

Contract under test (kesepakatan ronde 4):
- POST /api/v1/settings/providers stores keys server-side, encrypted at rest.
- Keys never round-trip to the browser: GET-only state is configured/masked.
- CSRF envelope: UI sends ``X-Companion-Token``; backend must accept it exactly
  as it accepts ``X-CSRF-Token`` (double-submit cookie semantics unchanged).
- No restart: a saved key is visible to a fresh Settings/store instance.
"""

from __future__ import annotations

import os

import httpx
import pytest

from gandiwa_api import main as api_main
from gandiwa_api.config import Settings
from gandiwa_api.main import app as real_app

pytestmark = pytest.mark.anyio


async def _fetch_csrf(client: httpx.AsyncClient) -> str:
    res = await client.get("/api/v1/auth/csrf")
    assert res.status_code == 200
    return res.json()["csrf_token"]


def _settings(tmp_path) -> Settings:
    # Secret & store path are set via monkeypatch.setenv in each test (the same
    # source the app reads) — NEVER via os.environ here: a leaked env var
    # reconfigures the global app (cookie secret mismatch → 401 cascades in
    # the full run). Pytest monkeypatch restores them automatically.
    return Settings(
        SESSION_SECRET=os.environ["GANDIWA_SESSION_SECRET"],
        NINEROUTER_INSTANCES={"studio-a": "https://9router.example.net"},
    )


async def test_save_fal_key_via_companion_token_makes_provider_configured(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("GANDIWA_PROVIDER_KEY_STORE", str(tmp_path / "provider-keys.json"))
    monkeypatch.setenv("GANDIWA_SESSION_SECRET", "test-secret")
    _settings(tmp_path)
    transport = httpx.ASGITransport(app=real_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        token = await _fetch_csrf(client)
        res = await client.post(
            "/api/v1/settings/providers",
            json={"providers": [{"provider": "fal", "apiKey": "fal-live-key-123456"}]},
            headers={"X-Companion-Token": token},
        )
        assert res.status_code == 200, res.text
        state = await client.get("/api/v1/providers")
        flags = {item["id"]: item["configured"] for item in state.json()}
        assert flags["fal"] is True


async def test_saved_key_is_masked_and_never_round_trips(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("GANDIWA_PROVIDER_KEY_STORE", str(tmp_path / "provider-keys.json"))
    monkeypatch.setenv("GANDIWA_SESSION_SECRET", "test-secret")
    _settings(tmp_path)
    transport = httpx.ASGITransport(app=real_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        token = await _fetch_csrf(client)
        await client.post(
            "/api/v1/settings/providers",
            json={"providers": [{"provider": "fal", "apiKey": "fal-live-key-123456"}]},
            headers={"X-Companion-Token": token},
        )
        state = await client.get("/api/v1/settings/providers")
        assert state.status_code == 200
        body = state.text
        assert "fal-live-key-123456" not in body


async def test_key_is_encrypted_at_rest_never_plaintext(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("GANDIWA_PROVIDER_KEY_STORE", str(tmp_path / "provider-keys.json"))
    monkeypatch.setenv("GANDIWA_SESSION_SECRET", "test-secret")
    settings = _settings(tmp_path)
    transport = httpx.ASGITransport(app=real_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        token = await _fetch_csrf(client)
        await client.post(
            "/api/v1/settings/providers",
            json={"providers": [{"provider": "fal", "apiKey": "fal-live-key-123456"}]},
            headers={"X-Companion-Token": token},
        )
    raw_file = settings.PROVIDER_KEY_STORE.read_bytes()
    assert b"fal-live-key-123456" not in raw_file
    assert b"123456" not in raw_file


async def test_saved_key_survives_without_restart(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("GANDIWA_PROVIDER_KEY_STORE", str(tmp_path / "provider-keys.json"))
    monkeypatch.setenv("GANDIWA_SESSION_SECRET", "test-secret")
    settings = _settings(tmp_path)
    transport = httpx.ASGITransport(app=real_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        token = await _fetch_csrf(client)
        await client.post(
            "/api/v1/settings/providers",
            json={"providers": [{"provider": "fal", "apiKey": "fal-live-key-123456"}]},
            headers={"X-Companion-Token": token},
        )
    # Fresh store instance (e.g. another process/request lifecycle) — no restart.
    from gandiwa_api.security.provider_key_store import ProviderKeyStore

    fresh = ProviderKeyStore(settings)
    assert fresh.get("fal") == "fal-live-key-123456"


async def test_rejects_unknown_provider_and_empty_key(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("GANDIWA_PROVIDER_KEY_STORE", str(tmp_path / "provider-keys.json"))
    monkeypatch.setenv("GANDIWA_SESSION_SECRET", "test-secret")
    _settings(tmp_path)
    transport = httpx.ASGITransport(app=real_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        token = await _fetch_csrf(client)
        bad_provider = await client.post(
            "/api/v1/settings/providers",
            json={"providers": [{"provider": "not-a-provider", "apiKey": "x"}]},
            headers={"X-Companion-Token": token},
        )
        assert bad_provider.status_code == 400
        empty_key = await client.post(
            "/api/v1/settings/providers",
            json={"providers": [{"provider": "fal", "apiKey": "   "}]},
            headers={"X-Companion-Token": token},
        )
        assert empty_key.status_code == 400


async def test_missing_csrf_still_rejected(tmp_path) -> None:
    transport = httpx.ASGITransport(app=real_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/api/v1/settings/providers",
            json={"providers": [{"provider": "fal", "apiKey": "k"}]},
        )
        assert res.status_code == 403


async def test_companion_token_accepted_where_csrf_header_was_required(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("GANDIWA_PROVIDER_KEY_STORE", str(tmp_path / "provider-keys.json"))
    monkeypatch.setenv("GANDIWA_SESSION_SECRET", "test-secret")
    _settings(tmp_path)
    transport = httpx.ASGITransport(app=real_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        token = await _fetch_csrf(client)
        res = await client.post(
            "/api/v1/settings/providers",
            json={"providers": [{"provider": "fal", "apiKey": "k-alias"}]},
            headers={"X-CSRF-Token": token},
        )
        assert res.status_code == 200


async def test_test_connection_endpoint_is_honest(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("GANDIWA_PROVIDER_KEY_STORE", str(tmp_path / "provider-keys.json"))
    monkeypatch.setenv("GANDIWA_SESSION_SECRET", "test-secret")
    monkeypatch.setattr(api_main, "_probe_provider_auth", lambda _provider, _key: (True, None))
    _settings(tmp_path)
    transport = httpx.ASGITransport(app=real_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        token = await _fetch_csrf(client)
        await client.post(
            "/api/v1/settings/providers",
            json={"providers": [{"provider": "fal", "apiKey": "k-test"}]},
            headers={"X-Companion-Token": token},
        )
        ok = await client.get("/api/v1/settings/providers/fal/test")
        assert ok.status_code == 200
        assert ok.json()["ok"] is True
        unknown = await client.get("/api/v1/settings/providers/ghost/test")
        assert unknown.status_code == 404
