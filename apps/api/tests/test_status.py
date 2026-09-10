"""Behavior tests for the /api/v1/status endpoint."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from gandiwa_api.main import app


async def get(path: str) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        return await client.get(path)


def create_ready_database(
    path: Path,
    *,
    worker_status: str = "running",
    heartbeat_at: datetime | None = None,
) -> None:
    heartbeat = (heartbeat_at or datetime.now(UTC)).isoformat()
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num TEXT NOT NULL)")
        connection.execute("INSERT INTO alembic_version VALUES ('0002')")
        connection.execute("CREATE TABLE generation_job (id TEXT PRIMARY KEY)")
        connection.execute(
            "CREATE TABLE worker_state "
            "(id INTEGER PRIMARY KEY, status TEXT NOT NULL, heartbeat_at TEXT, started_at TEXT)"
        )
        connection.execute(
            "INSERT INTO worker_state (id, status, heartbeat_at) VALUES (1, ?, ?)",
            (worker_status, heartbeat),
        )


@pytest.mark.anyio
async def test_status_returns_real_worker_and_backend_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "gandiwa.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    heartbeat = datetime.now(UTC)
    create_ready_database(database, worker_status="running", heartbeat_at=heartbeat)
    monkeypatch.setenv("GANDIWA_DATABASE_URL", f"sqlite:///{database}")
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(artifacts))

    response = await get("/api/v1/status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["mvp_version"] == "mvp-1.0"
    assert payload["backend"]["health"] == "ok"
    assert payload["backend"]["ready"] is True
    assert payload["worker"] == {
        "status": "running",
        "heartbeat_at": heartbeat.isoformat(),
    }


@pytest.mark.anyio
async def test_status_is_actionable_when_backend_dependencies_are_unavailable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "missing.sqlite3"
    artifacts = tmp_path / "missing-artifacts"
    monkeypatch.setenv("GANDIWA_DATABASE_URL", f"sqlite:///{database}")
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(artifacts))

    response = await get("/api/v1/status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["backend"]["health"] == "ok"
    assert payload["backend"]["ready"] is False
    assert payload["worker"] == {"status": "unavailable", "heartbeat_at": None}
    assert not database.exists()


@pytest.mark.anyio
async def test_status_does_not_report_a_stale_running_worker_as_online(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "stale.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    stale_heartbeat = datetime.now(UTC) - timedelta(minutes=1)
    create_ready_database(
        database,
        worker_status="running",
        heartbeat_at=stale_heartbeat,
    )
    monkeypatch.setenv("GANDIWA_DATABASE_URL", f"sqlite:///{database}")
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(artifacts))
    monkeypatch.setenv("GANDIWA_WORKER_HEARTBEAT_STALE_SECONDS", "5")

    response = await get("/api/v1/status")

    assert response.status_code == 200
    assert response.json()["worker"] == {
        "status": "unavailable",
        "heartbeat_at": stale_heartbeat.isoformat(),
    }
