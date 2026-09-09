"""Background worker process for durable job queue."""

from __future__ import annotations

import logging
import signal
import threading
from datetime import UTC, datetime
from types import FrameType
from typing import Literal

from sqlalchemy import text

from gandiwa_api.config import Settings
from gandiwa_api.database import create_sqlite_engine

logger = logging.getLogger(__name__)

WorkerStatus = Literal["idle", "running", "stopped"]


class Worker:
    """Single-concurrency worker that polls the durable queue.

    This foundation handles lifecycle and heartbeat only. Actual job dispatch
    belongs to a later issue.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._status: WorkerStatus = "idle"

    @property
    def status(self) -> WorkerStatus:
        return self._status

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def concurrency(self) -> int:
        return 1

    def start(self) -> None:
        """Start the worker in a background thread."""
        if self.is_running:
            return
        self._stop_event.clear()
        self._status = "running"
        self._update_heartbeat("running")
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Signal the worker to stop and wait for graceful shutdown."""
        if not self.is_running:
            self._status = "stopped"
            self._update_heartbeat("stopped")
            return
        self._stop_event.set()
        assert self._thread is not None
        self._thread.join(timeout=5.0)
        self._status = "stopped"
        self._update_heartbeat("stopped")

    def _run(self) -> None:
        """Main worker loop. Polls for jobs at regular intervals."""
        while not self._stop_event.is_set():
            self._update_heartbeat("running")
            # Worker foundation: no job dispatch yet.
            # Sleep in small increments so stop() is responsive.
            self._stop_event.wait(timeout=1.0)

    def _update_heartbeat(self, status: str) -> None:
        """Write current status and timestamp to the worker_state table."""
        now = datetime.now(UTC).isoformat()
        engine = create_sqlite_engine(self._settings)
        try:
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "UPDATE worker_state SET status = :status, "
                        "heartbeat_at = :heartbeat WHERE id = 1"
                    ),
                    {"status": status, "heartbeat": now},
                )
                if status == "running":
                    connection.execute(
                        text(
                            "UPDATE worker_state SET started_at = :started "
                            "WHERE id = 1 AND started_at IS NULL"
                        ),
                        {"started": now},
                    )
        except Exception:
            # Heartbeat failure must not crash the worker, but must remain observable.
            logger.exception("Unable to update worker heartbeat")
        finally:
            engine.dispose()


def main() -> None:
    """Run one worker process until SIGINT or SIGTERM requests shutdown."""
    worker = Worker(Settings())
    shutdown_requested = threading.Event()

    def request_shutdown(_signum: int, _frame: FrameType | None) -> None:
        shutdown_requested.set()

    signal.signal(signal.SIGINT, request_shutdown)
    signal.signal(signal.SIGTERM, request_shutdown)
    worker.start()
    try:
        shutdown_requested.wait()
    finally:
        worker.stop()
