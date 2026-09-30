"""Issue #26 HTTP boundary: 9Router assistant brainstorm is fail-closed.

Auth + CSRF must gate the route before any upstream contact, and without a
configured 9Router instance/credential the route reports 503 honestly instead
of pretending or auto-routing. Upstream contact itself is exercised by the
connector/adapter suites; this boundary test never touches the network.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config

from gandiwa_api.main import app

pytestmark = pytest.mark.anyio


def _alembic_config(database_url: str) -> Config:
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


def _request_payload() -> dict[str, str]:
    return {
        "instance_id": "studio-a",
        "topic": "Ceramic mug",
        "content_type": "illustration",
        "model_id": "qwen/qwen3-32b",
    }


async def _csrf(client: httpx.AsyncClient) -> str:
    response = await client.get("/api/v1/auth/csrf")
    assert response.status_code == 200
    return str(response.json()["csrf_token"])


@pytest.fixture(autouse=True)
def _isolate_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    database = tmp_path / "assistant.sqlite3"
    command.upgrade(_alembic_config(f"sqlite:///{database}"), "head")
    monkeypatch.setenv("GANDIWA_DATABASE_URL", f"sqlite:///{database}")
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(tmp_path / "artifacts"))


@pytest.mark.anyio
async def test_brainstorm_requires_an_owned_session_and_csrf() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        denied = await client.post("/api/v1/creative/assistant/brainstorm", json=_request_payload())
        assert denied.status_code == 403

        anonymous = httpx.AsyncClient(transport=transport, base_url="http://test")
        try:
            # Kontrak lobby fail-closed: token CSRF milik sesi lain tidak
            # menyelamatkan sesi anonim — tetap 401 tanpa sesi owned.
            await anonymous.get("/api/v1/auth/csrf")
            anon_csrf = await anonymous.get("/api/v1/auth/csrf")
            unowned = await anonymous.post(
                "/api/v1/creative/assistant/brainstorm",
                json=_request_payload(),
                headers={"X-CSRF-Token": str(anon_csrf.json()["csrf_token"])},
            )
            assert unowned.status_code == 401
        finally:
            await anonymous.aclose()


@pytest.mark.anyio
async def test_brainstorm_without_the_selected_instance_is_fail_closed_404() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        await client.get("/api/v1/creative/bootstrap")
        csrf = await _csrf(client)
        response = await client.post(
            "/api/v1/creative/assistant/brainstorm",
            json=_request_payload(),
            headers={"X-CSRF-Token": csrf},
        )
        # Pilihan manusia harus dipenuhi persis. Instance yang tidak tersedia
        # berhenti 404 — tidak ada auto-pick/fallback dan tidak ada upstream.
        assert response.status_code == 404


@pytest.mark.anyio
async def test_brainstorm_payload_is_schema_validated() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        await client.get("/api/v1/creative/bootstrap")
        csrf = await _csrf(client)
        malformed = {
            "topic": "Ceramic mug",
            "content_type": "illustration",
            "model_id": "qwen/qwen3-32b",
            "question_count": 4,
        }
        response = await client.post(
            "/api/v1/creative/assistant/brainstorm",
            json=malformed,
            headers={"X-CSRF-Token": csrf},
        )
        assert response.status_code == 422
