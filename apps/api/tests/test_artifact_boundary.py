"""Artifact boundary tests for the durable temporary record contract (Issue #22)."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config

from gandiwa_api.artifact_store import ArtifactStore, TemporaryArtifact
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


def _stage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    download_name: str,
    media_type: str,
    payload: bytes,
) -> TemporaryArtifact:
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
        download_name=download_name,
        media_type=media_type,
        payload=payload,
        ttl_seconds=300,
    )
    monkeypatch.setenv("GANDIWA_DATABASE_URL", database_url)
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(artifacts_dir))
    return artifact


def _owner_client() -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=app)
    client = httpx.AsyncClient(transport=transport, base_url="http://test")
    client.cookies.set(
        SESSION_COOKIE_NAME,
        sign_session_id("owner-session", "change-me-for-local-development"),
    )
    return client


pytestmark = pytest.mark.anyio


async def test_svg_download_uses_attachment_and_nosniff(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="5"/></svg>'
    artifact = _stage(
        tmp_path,
        monkeypatch,
        download_name="render.svg",
        media_type="image/svg+xml",
        payload=svg,
    )

    async with _owner_client() as client:
        response = await client.get(f"/api/v1/artifacts/{artifact.id}/download")

    assert response.status_code == 200
    assert response.content == svg
    content_disposition = response.headers.get("content-disposition", "")
    assert content_disposition.startswith("attachment;")
    assert 'filename="render.svg"' in content_disposition
    assert "inline" not in content_disposition.lower()
    assert response.headers.get("x-content-type-options") == "nosniff"
    assert response.headers.get("content-type", "").startswith("image/svg+xml")
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-gandiwa-sha256"] == artifact.sha256


async def test_png_download_uses_attachment_and_nosniff(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = b"\x89PNG\r\n\x1a\nfake-png-data"
    artifact = _stage(
        tmp_path,
        monkeypatch,
        download_name="sample.png",
        media_type="image/png",
        payload=payload,
    )

    async with _owner_client() as client:
        response = await client.get(f"/api/v1/artifacts/{artifact.id}/download")

    assert response.status_code == 200
    assert response.content == payload
    assert response.headers.get("content-disposition", "").startswith("attachment;")
    assert response.headers.get("x-content-type-options") == "nosniff"
    assert "image/png" in response.headers.get("content-type", "")


async def test_malformed_artifact_ids_fail_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stage(
        tmp_path,
        monkeypatch,
        download_name="render.svg",
        media_type="image/svg+xml",
        payload=b"<svg></svg>",
    )

    async with _owner_client() as client:
        for malicious_id in (
            "..",
            ".env",
            ".gandiwa-readiness-probe",
            "nested..test.svg",
            "illustration.svg",
        ):
            response = await client.get(f"/api/v1/artifacts/{malicious_id}/download")
            assert response.status_code == 404, malicious_id

    leaked = (tmp_path / "secret.txt").exists()
    assert leaked is False
