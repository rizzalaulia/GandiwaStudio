"""Behavior tests for liveness and readiness probes."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any

import httpx
import pytest

from gandiwa_api.main import app

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def get(path: str) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path)


def create_ready_database(
    path: Path,
    *,
    revision: str = "0001",
    extra_revisions: tuple[str, ...] = (),
    include_queue: bool = True,
) -> None:
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num TEXT NOT NULL)")
        connection.executemany(
            "INSERT INTO alembic_version (version_num) VALUES (?)",
            [(revision,), *((item,) for item in extra_revisions)],
        )
        if include_queue:
            connection.execute("CREATE TABLE generation_job (id TEXT PRIMARY KEY)")


def corrupt_unrelated_data_page(path: Path) -> None:
    """Damage a late data page while leaving schema and readiness tables readable."""
    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA page_size=4096")
        connection.execute("CREATE TABLE ballast (id INTEGER PRIMARY KEY, payload BLOB)")
        connection.executemany(
            "INSERT INTO ballast (payload) VALUES (?)",
            [(b"x" * 3000,) for _ in range(40)],
        )
        page_count = connection.execute("PRAGMA page_count").fetchone()[0]

    with path.open("r+b") as database_file:
        database_file.seek((page_count - 2) * 4096 + 128)
        database_file.write(b"CORRUPTED-PAGE" * 150)


def configure(
    monkeypatch: pytest.MonkeyPatch,
    *,
    database: Path,
    artifacts: Path,
) -> None:
    monkeypatch.setenv("GANDIWA_DATABASE_URL", f"sqlite:///{database}")
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(artifacts))


def serialized(payload: dict[str, Any]) -> str:
    return str(payload).lower()


async def test_health_is_live_without_runtime_dependencies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GANDIWA_DATABASE_URL", "not-a-database-url")
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", "/definitely/missing")

    response = await get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "0.0.0"}


async def test_health_does_not_expose_secrets_or_paths() -> None:
    response = await get("/api/v1/health")

    body = serialized(response.json())
    for forbidden in ("secret", "token", "password", "database_url", "/tmp/"):
        assert forbidden not in body


async def test_ready_reports_every_required_check(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "gandiwa.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    create_ready_database(database)
    configure(monkeypatch, database=database, artifacts=artifacts)

    response = await get("/api/v1/ready")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ready",
        "checks": {
            "database": True,
            "migration": True,
            "queue": True,
            "artifacts_dir": True,
        },
    }
    with sqlite3.connect(database) as connection:
        probe_table = connection.execute(
            "SELECT name FROM sqlite_master WHERE name = ?",
            ("__gandiwa_readiness_probe",),
        ).fetchone()
    assert probe_table is None
    assert list(artifacts.iterdir()) == []


async def test_ready_does_not_create_a_missing_database(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "missing.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    configure(monkeypatch, database=database, artifacts=artifacts)
    assert not database.exists()

    response = await get("/api/v1/ready")

    assert response.status_code == 503
    assert response.json()["checks"] == {
        "database": False,
        "migration": False,
        "queue": False,
        "artifacts_dir": True,
    }
    assert not database.exists()


async def test_ready_rejects_a_stale_migration(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "stale.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    create_ready_database(database, revision="old")
    configure(monkeypatch, database=database, artifacts=artifacts)

    response = await get("/api/v1/ready")

    assert response.status_code == 503
    assert response.json()["checks"] == {
        "database": True,
        "migration": False,
        "queue": True,
        "artifacts_dir": True,
    }


async def test_environment_cannot_approve_a_stale_migration(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "stale.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    create_ready_database(database, revision="old")
    configure(monkeypatch, database=database, artifacts=artifacts)
    monkeypatch.setenv("GANDIWA_DATABASE_SCHEMA_REVISION", "old")

    response = await get("/api/v1/ready")

    assert response.status_code == 503
    assert response.json()["checks"]["migration"] is False


async def test_ready_rejects_a_corrupt_database(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "corrupt.sqlite3"
    database.write_bytes(b"not a sqlite database")
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    configure(monkeypatch, database=database, artifacts=artifacts)

    response = await get("/api/v1/ready")

    assert response.status_code == 503
    assert response.json()["checks"] == {
        "database": False,
        "migration": False,
        "queue": False,
        "artifacts_dir": True,
    }


async def test_ready_rejects_partial_database_corruption(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "partial-corruption.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    create_ready_database(database)
    corrupt_unrelated_data_page(database)
    configure(monkeypatch, database=database, artifacts=artifacts)

    response = await get("/api/v1/ready")

    assert response.status_code == 503
    assert response.json()["checks"] == {
        "database": False,
        "migration": False,
        "queue": False,
        "artifacts_dir": True,
    }


@pytest.mark.skipif(os.geteuid() == 0, reason="root bypasses file permission bits")
async def test_ready_rejects_a_read_only_database(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "read-only.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    create_ready_database(database)
    database.chmod(0o400)
    configure(monkeypatch, database=database, artifacts=artifacts)

    try:
        response = await get("/api/v1/ready")
    finally:
        database.chmod(0o600)

    assert response.status_code == 503
    assert response.json()["checks"]["database"] is False


async def test_ready_rejects_multiple_migration_heads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "multiple-heads.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    create_ready_database(database, extra_revisions=("unexpected",))
    configure(monkeypatch, database=database, artifacts=artifacts)

    response = await get("/api/v1/ready")

    assert response.status_code == 503
    assert response.json()["checks"]["migration"] is False


async def test_ready_rejects_a_missing_queue_table(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "no-queue.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    create_ready_database(database, include_queue=False)
    configure(monkeypatch, database=database, artifacts=artifacts)

    response = await get("/api/v1/ready")

    assert response.status_code == 503
    assert response.json()["checks"] == {
        "database": True,
        "migration": True,
        "queue": False,
        "artifacts_dir": True,
    }


async def test_ready_rejects_a_missing_artifact_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "gandiwa.sqlite3"
    artifacts = tmp_path / "missing-artifacts"
    create_ready_database(database)
    configure(monkeypatch, database=database, artifacts=artifacts)

    response = await get("/api/v1/ready")

    assert response.status_code == 503
    assert response.json()["checks"]["artifacts_dir"] is False


@pytest.mark.skipif(os.geteuid() == 0, reason="root bypasses directory permission bits")
async def test_ready_rejects_an_unwritable_artifact_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "gandiwa.sqlite3"
    artifacts = tmp_path / "read-only-artifacts"
    artifacts.mkdir(mode=0o500)
    create_ready_database(database)
    configure(monkeypatch, database=database, artifacts=artifacts)

    try:
        response = await get("/api/v1/ready")
    finally:
        artifacts.chmod(0o700)

    assert response.status_code == 503
    assert response.json()["checks"]["artifacts_dir"] is False


async def test_unavailable_response_does_not_expose_internal_paths(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "private" / "missing.sqlite3"
    artifacts = tmp_path / "private" / "artifacts"
    configure(monkeypatch, database=database, artifacts=artifacts)

    response = await get("/api/v1/ready")

    body = serialized(response.json())
    assert str(tmp_path).lower() not in body
    assert "database_url" not in body
    assert "error" not in body
