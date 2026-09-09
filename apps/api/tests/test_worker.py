"""Behavior tests for the worker process foundation."""

from __future__ import annotations

import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest
from alembic.config import Config

from gandiwa_api.config import Settings
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.worker import Worker


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    database = tmp_path / "worker.sqlite3"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    return Settings(
        DATABASE_URL=f"sqlite:///{database}",
        ARTIFACT_DIR=artifacts,
    )


def _alembic_config(database_url: str) -> Config:
    api_root = Path(__file__).resolve().parents[1]
    config = Config(str(api_root / "alembic.ini"))
    config.set_main_option("script_location", str(api_root / "migrations"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


def test_worker_starts_and_reports_idle_status(settings: Settings) -> None:
    worker = Worker(settings)

    assert worker.status == "idle"
    assert worker.is_running is False


def test_worker_starts_in_background_and_reports_running(settings: Settings) -> None:
    worker = Worker(settings)
    worker.start()

    try:
        assert worker.is_running is True
        assert worker.status == "running"
    finally:
        worker.stop()


def test_worker_stops_gracefully(settings: Settings) -> None:
    worker = Worker(settings)
    worker.start()
    worker.stop()

    assert worker.is_running is False
    assert worker.status == "stopped"


def test_worker_stop_is_idempotent(settings: Settings) -> None:
    worker = Worker(settings)
    worker.start()
    worker.stop()
    worker.stop()

    assert worker.is_running is False
    assert worker.status == "stopped"


def test_worker_concurrency_is_fixed_to_one(settings: Settings) -> None:
    worker = Worker(settings)

    assert worker.concurrency == 1


def test_worker_does_not_bind_to_any_port(settings: Settings) -> None:
    """Worker uses no public port — it is a background poller, not a server.

    We mock socket.socket to ensure the worker never creates a listener.
    """
    import socket

    original_socket = socket.socket
    sockets_created: list[socket.socket] = []

    class TrackingSocket(original_socket):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, **kwargs)  # type: ignore[arg-type]
            sockets_created.append(self)

    with patch("socket.socket", TrackingSocket):
        worker = Worker(settings)
        worker.start()

        try:
            time.sleep(0.3)
        finally:
            worker.stop()

    # The worker should not have created any sockets
    assert len(sockets_created) == 0, (
        f"Worker created {len(sockets_created)} socket(s) — it should be a pure poller"
    )


def test_worker_writes_heartbeat_to_database(settings: Settings) -> None:
    """Worker heartbeat/status is observable through backend state."""
    from alembic import command as alembic_command
    from sqlalchemy import text

    alembic_command.upgrade(_alembic_config(settings.DATABASE_URL), "head")

    worker = Worker(settings)
    worker.start()

    try:
        time.sleep(1.5)

        engine = create_sqlite_engine(settings)
        try:
            with engine.connect() as connection:
                row = connection.execute(
                    text("SELECT status, heartbeat_at FROM worker_state WHERE id = 1")
                ).fetchone()
        finally:
            engine.dispose()

        assert row is not None
        assert row[0] == "running"
        assert row[1] is not None
    finally:
        worker.stop()


def test_worker_stops_on_signal(settings: Settings) -> None:
    """Worker handles graceful shutdown when stop is called (simulating SIGTERM)."""
    worker = Worker(settings)
    worker.start()

    def signal_handler() -> None:
        time.sleep(0.5)
        worker.stop()

    handler_thread = threading.Thread(target=signal_handler)
    handler_thread.start()

    handler_thread.join(timeout=3.0)

    assert worker.is_running is False
    assert worker.status == "stopped"
