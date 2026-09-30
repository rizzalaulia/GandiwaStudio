"""Metadata assistant HTTP boundary must be owned and fail closed."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config

from gandiwa_api.main import app

pytestmark = pytest.mark.anyio


def _cfg(url: str) -> Config:
    root = Path(__file__).resolve().parents[1]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "migrations"))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


def payload() -> dict[str, str]:
    return {
        "instance_id": "studio-a",
        "topic": "Ceramic mug",
        "content_type": "illustration",
        "model_id": "qwen/qwen3-32b",
    }


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    database = tmp_path / "metadata.sqlite3"
    command.upgrade(_cfg(f"sqlite:///{database}"), "head")
    monkeypatch.setenv("GANDIWA_DATABASE_URL", f"sqlite:///{database}")
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(tmp_path / "artifacts"))


async def test_metadata_suggestion_requires_owned_session_and_csrf() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        denied = await client.post("/api/v1/creative/assistant/metadata", json=payload())
        assert denied.status_code == 403
        await client.get("/api/v1/creative/bootstrap")
        csrf = (await client.get("/api/v1/auth/csrf")).json()["csrf_token"]
        malformed = await client.post(
            "/api/v1/creative/assistant/metadata",
            json={"topic": "Ceramic mug"},
            headers={"X-CSRF-Token": csrf},
        )
        assert malformed.status_code == 422
        unavailable = await client.post(
            "/api/v1/creative/assistant/metadata",
            json=payload(),
            headers={"X-CSRF-Token": csrf},
        )
        assert unavailable.status_code == 404
