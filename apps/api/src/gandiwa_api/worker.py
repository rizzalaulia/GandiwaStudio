"""Background worker process for durable job queue."""

from __future__ import annotations

import logging
import signal
import threading
import uuid
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from types import FrameType
from typing import Literal

from sqlalchemy import text

from gandiwa_api.artifact_store import ArtifactStore
from gandiwa_api.config import Settings
from gandiwa_api.connectors.registry import ConnectorRegistry
from gandiwa_api.connectors.runtime import (
    HttpxArtifactDownloader,
    HttpxJsonTransport,
    build_generation_registry,
)
from gandiwa_api.connectors.task import run_connector_dispatch
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.queue import Handler, QueueStore
from gandiwa_api.security.ssrf import validate_fal_base_url

logger = logging.getLogger(__name__)

WorkerStatus = Literal["idle", "running", "stopped"]


class Worker:
    """Single-concurrency worker that polls and dispatches the durable queue."""

    def __init__(
        self,
        settings: Settings,
        *,
        handlers: Mapping[str, Handler] | None = None,
        retry_limits: Mapping[str, int] | None = None,
        connector_registry: ConnectorRegistry | None = None,
        connector_job_types: set[str] | frozenset[str] | None = None,
        worker_id: str | None = None,
        lease_seconds: int = 30,
    ) -> None:
        if lease_seconds < 1:
            raise ValueError("lease_seconds must be positive")
        self._settings = settings
        self._handlers = dict(handlers or {})
        self._retry_limits = dict(retry_limits or {})
        self._connector_registry = connector_registry
        self._connector_job_types = frozenset(connector_job_types or ())
        if self._connector_job_types and self._connector_registry is None:
            raise ValueError("connector job types require a connector registry")
        if any(limit < 0 for limit in self._retry_limits.values()):
            raise ValueError("retry limits cannot be negative")
        self._worker_id = worker_id or f"worker-{uuid.uuid4()}"
        self._lease_seconds = lease_seconds
        self._engine = create_sqlite_engine(settings)
        self._queue = QueueStore(self._engine)
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

    def run_once(self) -> bool:
        """Recover stale leases, then claim and dispatch at most one job."""
        self._queue.recover_expired()
        job = self._queue.claim_next(self._worker_id, lease_seconds=self._lease_seconds)
        if job is None:
            return False

        heartbeat_stop = threading.Event()
        heartbeat_thread = threading.Thread(
            target=self._maintain_job_lease,
            args=(job.id, heartbeat_stop),
            daemon=True,
        )
        heartbeat_thread.start()
        try:
            if job.job_type in self._connector_job_types:
                assert self._connector_registry is not None
                run_connector_dispatch(
                    self._queue,
                    self._connector_registry,
                    job.id,
                    self._worker_id,
                    lease_seconds=self._lease_seconds,
                )
            else:
                self._queue.dispatch_once(
                    job.id,
                    self._worker_id,
                    handlers=self._handlers,
                    retry_limits=self._retry_limits,
                )
        finally:
            heartbeat_stop.set()
            heartbeat_thread.join(timeout=max(1.0, self._lease_seconds / 2))
        return True

    def _maintain_job_lease(self, job_id: str, stop: threading.Event) -> None:
        interval = max(0.1, self._lease_seconds / 3)
        while not stop.wait(timeout=interval):
            try:
                self._queue.heartbeat(
                    job_id,
                    self._worker_id,
                    lease_seconds=self._lease_seconds,
                )
            except Exception:
                logger.exception("Unable to renew job lease")
                return

    def _run(self) -> None:
        """Main worker loop. Poll and dispatch one job at a time."""
        while not self._stop_event.is_set():
            self._update_heartbeat("running")
            try:
                dispatched = self.run_once()
            except Exception:
                logger.exception("Unable to process durable queue")
                dispatched = False
            if not dispatched:
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


def build_production_worker(
    settings: Settings,
    *,
    origin_validator: Callable[[str], object] = validate_fal_base_url,
) -> Worker:
    """Wire the production fal connector without placing its key in worker state."""
    engine = create_sqlite_engine(settings)
    store = ArtifactStore(engine, settings.ARTIFACT_DIR)
    registry = build_generation_registry(
        settings,
        base_transport=HttpxJsonTransport(),
        artifact_downloader=HttpxArtifactDownloader(),
        artifact_store=store,
        origin_validator=origin_validator,
    )
    return Worker(
        settings,
        connector_registry=registry,
        connector_job_types={"generate"} if "fal" in registry.registered_providers else set(),
    )


def main() -> None:
    """Run one worker process until SIGINT or SIGTERM requests shutdown."""
    worker = build_production_worker(Settings())
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
