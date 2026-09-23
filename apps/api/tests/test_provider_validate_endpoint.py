"""Honest provider test-connection: real provider auth probe, not just key presence.

Guru's requirement (23 Sep): the Settings "Tes API" button must prove whether
the stored key is VALID at the real provider, not merely that a key exists.
Endpoint: POST /api/v1/settings/providers/{provider}/validate
- 200 {ok: true,  provider, probe: "provider_auth"} — provider accepted the key
- 200 {ok: false, provider, probe: "provider_auth", reason: "auth_rejected"} —
  provider explicitly rejected it (bad/revoked key)
- 200 {ok: false, provider, probe: "provider_auth", reason: "unreachable"} —
  network/timeout/provider 5xx: verdict unknown, must NOT claim validity
- 404 unknown provider; 409 no key stored yet
The probe must never leak the key and never enqueue a billable generation job.
"""

from __future__ import annotations

import httpx
import pytest

from gandiwa_api import main as api_main
from gandiwa_api.config import Settings  # noqa: F401
from gandiwa_api.main import app as real_app

pytestmark = pytest.mark.anyio


class _FakeProbe:
    """Swap the probe transport so tests never touch the real network."""

    def __init__(self, handler) -> None:
        self._client = httpx.Client(transport=httpx.MockTransport(handler))
        self.requests: list[httpx.Request] = []

    def get(self, url, headers=None, timeout=None):
        return self._client.get(url, headers=headers or {}, timeout=timeout)

    def post(self, url, headers=None, timeout=None):
        request = httpx.Request("POST", url, headers=headers or {})
        self.requests.append(request)
        return self._client.post(url, headers=headers or {}, timeout=timeout)


@pytest.fixture()
def probe(monkeypatch):
    def install(handler):
        fake = _FakeProbe(handler)
        monkeypatch.setattr(api_main, "_probe_client", fake)
        return fake

    return install


def _env(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("GANDIWA_PROVIDER_KEY_STORE", str(tmp_path / "provider-keys.json"))
    monkeypatch.setenv("GANDIWA_SESSION_SECRET", "test-secret")


async def _save_key(client: httpx.AsyncClient, provider: str, api_key: str) -> None:
    token = (await client.get("/api/v1/auth/csrf")).json()["csrf_token"]
    res = await client.post(
        "/api/v1/settings/providers",
        json={"providers": [{"provider": provider, "apiKey": api_key}]},
        headers={"X-Companion-Token": token},
    )
    assert res.status_code == 200, res.text


async def test_validate_returns_ok_when_provider_accepts_the_key(
    tmp_path, monkeypatch, probe
) -> None:
    _env(tmp_path, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        # Kunci sah melewati auth lalu ditangkap 404 request-tidak-ada.
        return httpx.Response(404)

    sent = probe(handler)
    transport = httpx.ASGITransport(app=real_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        await _save_key(client, "fal", "fal-valid-key-123")
        res = await client.get("/api/v1/settings/providers/fal/validate")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["probe"] == "provider_auth"
    # Bukti probe nyata: request keluar memakai skema fal "Key", kunci utuh.
    assert sent.requests[0].headers["Authorization"] == "Key fal-valid-key-123"
    assert sent.requests[0].url.host == "queue.fal.run"


async def test_validate_returns_auth_rejected_when_provider_refuses_the_key(
    tmp_path, monkeypatch, probe
) -> None:
    _env(tmp_path, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401)

    probe(handler)
    transport = httpx.ASGITransport(app=real_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        await _save_key(client, "fal", "fal-invalid-key-000")
        res = await client.get("/api/v1/settings/providers/fal/validate")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert body["reason"] == "auth_rejected"


async def test_validate_returns_unreachable_not_ok_on_provider_timeout(
    tmp_path, monkeypatch, probe
) -> None:
    _env(tmp_path, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("provider unreachable")

    probe(handler)
    transport = httpx.ASGITransport(app=real_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        await _save_key(client, "fal", "fal-valid-key-123")
        res = await client.get("/api/v1/settings/providers/fal/validate")
    assert res.status_code == 200
    body = res.json()
    # Jaringan/provider gagal ≠ kunci invalid; verdict harus "unknown", bukan ok.
    assert body["ok"] is False
    assert body["reason"] == "unreachable"


async def test_validate_without_stored_key_is_conflict(tmp_path, monkeypatch) -> None:
    _env(tmp_path, monkeypatch)
    transport = httpx.ASGITransport(app=real_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/settings/providers/fal/validate")
    assert res.status_code == 409
    assert res.json() == {"detail": "no key stored for this provider"}


async def test_validate_unknown_provider_is_not_found(tmp_path, monkeypatch) -> None:
    _env(tmp_path, monkeypatch)
    transport = httpx.ASGITransport(app=real_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/settings/providers/hantu/validate")
    assert res.status_code == 404


async def test_validate_never_leaks_the_key_material(tmp_path, monkeypatch) -> None:
    _env(tmp_path, monkeypatch)
    transport = httpx.ASGITransport(app=real_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        await _save_key(client, "fal", "fal-secret-material-777")
        res = await client.get("/api/v1/settings/providers/fal/validate")
    assert "fal-secret-material-777" not in res.text
