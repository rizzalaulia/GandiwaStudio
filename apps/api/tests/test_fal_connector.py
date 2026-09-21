"""Offline fal.ai connector contracts; no live key or network access."""

from __future__ import annotations

import time
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

import httpx
import pytest
from alembic import command
from alembic.config import Config
from PIL import Image

from gandiwa_api.artifact_store import ArtifactStore
from gandiwa_api.config import Settings
from gandiwa_api.connectors.base import DispatchIdentity
from gandiwa_api.connectors.fal import FalClient
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.queue import JobExecution, QueueStore


@dataclass
class ScriptedFalTransport:
    responses: list[dict[str, object]]

    def __post_init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.remote_id_seen_during_poll: str | None = None
        self.queue: QueueStore | None = None
        self.job_id: str | None = None

    def request(self, **kwargs: Any) -> dict[str, object]:
        self.calls.append(kwargs)
        if (
            kwargs["method"] == "GET"
            and kwargs["path"].endswith("/status")
            and self.queue is not None
            and self.job_id is not None
        ):
            self.remote_id_seen_during_poll = self.queue.get(self.job_id).remote_job_id
        if not self.responses:
            raise AssertionError("unexpected fal transport call")
        return self.responses.pop(0)


def _alembic_config(database_url: str) -> Config:
    cfg = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", database_url)
    return cfg


def queue_store(tmp_path: Path) -> QueueStore:
    database_url = f"sqlite:///{tmp_path / 'fal.sqlite3'}"
    command.upgrade(_alembic_config(database_url), "head")
    return QueueStore(create_sqlite_engine(Settings(DATABASE_URL=database_url)))


def enqueue_claimed_fal_job(queue: QueueStore) -> str:
    job_id = queue.enqueue(
        job_type="generate",
        provider_id="fal",
        model_id="fal-ai/flux/dev",
        parameters={
            "origin": "https://queue.fal.run",
            "idempotency_key": "idem-fal-001",
            "capability": "generate_image",
            "owner_session_id": "session-a",
            "generation_payload": {
                "prompt": "Editorial ceramic mug on linen, 2400x1667 output",
                "negative_prompt": "logo, brand, watermark, random text",
                "image_size": {"width": 2400, "height": 1667},
                "num_images": 1,
            },
            "rules_snapshot": {"id": "adobe-stock", "version": "2026-09-15"},
            "approved_prompt_digest": "sha256:approved",
        },
    )
    claimed = queue.claim_next("worker", lease_seconds=30)
    assert claimed is not None and claimed.id == job_id
    return job_id


def execution_for(queue: QueueStore, job_id: str) -> JobExecution:
    return JobExecution(
        job=queue.get(job_id),
        mark_dispatched=lambda remote=None: queue.mark_dispatched(
            job_id, "worker", remote_job_id=remote
        ),
        record_remote_job_id=lambda remote: queue.record_remote_job_id(job_id, "worker", remote),
        heartbeat=lambda: queue.heartbeat(job_id, "worker", lease_seconds=30),
        cancellation_requested=lambda: queue.cancellation_requested(job_id),
        timeout_seconds=300,
        deadline_frozen=time.monotonic() + 300,
    )


def test_submit_persists_remote_id_before_bounded_poll_and_result(tmp_path: Path) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_fal_job(queue)
    transport = ScriptedFalTransport(
        [
            {"request_id": "fal-request-123"},
            {"status": "IN_QUEUE", "request_id": "fal-request-123"},
            {"status": "COMPLETED", "request_id": "fal-request-123"},
            {
                "images": [
                    {
                        "url": "https://v3.fal.media/files/example/result.png",
                        "width": 2400,
                        "height": 1667,
                        "content_type": "image/png",
                    }
                ],
                "seed": 17,
            },
        ]
    )
    transport.queue = queue
    transport.job_id = job_id
    client = FalClient(
        origin="https://queue.fal.run",
        transport=transport,
        max_poll_attempts=3,
        poll_interval_seconds=0,
        artifact_downloader=ScriptedArtifactDownloader(png_bytes()),
        artifact_store=ArtifactStore(queue.engine, tmp_path / "artifacts"),
    )

    result = client.dispatch(
        DispatchIdentity(
            provider_id="fal",
            model_id="fal-ai/flux/dev",
            origin="https://queue.fal.run",
            idempotency_key="idem-fal-001",
            capability="generate_image",
        ),
        execution_for(queue, job_id),
    )

    assert transport.remote_id_seen_during_poll == "fal-request-123"
    assert queue.get(job_id).remote_job_id == "fal-request-123"
    assert [call["method"] for call in transport.calls] == ["POST", "GET", "GET", "GET"]
    assert result["provider_job_id"] == "fal-request-123"
    assert result["model_id"] == "fal-ai/flux/dev"
    assert result["seed"] == 17
    assert "url" not in result["artifact"]
    assert "id" in result["artifact"]


def test_poll_attempts_are_bounded(tmp_path: Path) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_fal_job(queue)
    transport = ScriptedFalTransport(
        [
            {"request_id": "fal-request-123"},
            {"status": "IN_QUEUE", "request_id": "fal-request-123"},
            {"status": "IN_PROGRESS", "request_id": "fal-request-123"},
        ]
    )
    client = FalClient(
        origin="https://queue.fal.run",
        transport=transport,
        max_poll_attempts=2,
        poll_interval_seconds=0,
    )

    with pytest.raises(Exception) as error:
        client.dispatch(
            DispatchIdentity(
                provider_id="fal",
                model_id="fal-ai/flux/dev",
                origin="https://queue.fal.run",
                idempotency_key="idem-fal-001",
                capability="generate_image",
            ),
            execution_for(queue, job_id),
        )

    assert getattr(error.value, "code", None) == "PROVIDER_TIMEOUT"
    assert [call["method"] for call in transport.calls] == ["POST", "GET", "GET"]


@dataclass
class ExceptionFalTransport:
    error: Exception

    def __post_init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def request(self, **kwargs: Any) -> dict[str, object]:
        self.calls.append(kwargs)
        raise self.error


def response_error(status_code: int) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://queue.fal.run/fal-ai/flux/dev")
    response = httpx.Response(status_code, request=request)
    return httpx.HTTPStatusError("upstream error", request=request, response=response)


@pytest.mark.parametrize(
    ("status_code", "expected_code"),
    [(401, "AUTH_REJECTED"), (403, "AUTH_REJECTED"), (429, "QUOTA_EXCEEDED")],
)
def test_submit_maps_auth_and_quota_to_stable_redacted_codes(
    tmp_path: Path, status_code: int, expected_code: str
) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_fal_job(queue)
    transport = ExceptionFalTransport(response_error(status_code))
    client = FalClient(origin="https://queue.fal.run", transport=transport)

    with pytest.raises(Exception) as error:
        client.dispatch(
            DispatchIdentity(
                "fal",
                "fal-ai/flux/dev",
                "https://queue.fal.run",
                "idem-fal-001",
                "generate_image",
            ),
            execution_for(queue, job_id),
        )

    assert getattr(error.value, "code", None) == expected_code
    assert str(error.value) == expected_code
    assert queue.get(job_id).status == "waiting_provider"


def test_cancel_before_submit_makes_zero_transport_calls(tmp_path: Path) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_fal_job(queue)
    queue.request_cancel(job_id)
    transport = ScriptedFalTransport([])
    client = FalClient(origin="https://queue.fal.run", transport=transport)

    with pytest.raises(Exception) as error:
        client.dispatch(
            DispatchIdentity(
                "fal",
                "fal-ai/flux/dev",
                "https://queue.fal.run",
                "idem-fal-001",
                "generate_image",
            ),
            execution_for(queue, job_id),
        )

    assert getattr(error.value, "code", None) == "CANCELLED"
    assert transport.calls == []
    assert queue.get(job_id).remote_job_id is None


class CancelAfterSubmitTransport(ScriptedFalTransport):
    def request(self, **kwargs: Any) -> dict[str, object]:
        result = super().request(**kwargs)
        if kwargs["method"] == "POST" and self.queue is not None and self.job_id is not None:
            self.queue.request_cancel(self.job_id)
        return result


def test_cancel_after_submit_sends_remote_cancel_once(tmp_path: Path) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_fal_job(queue)
    transport = CancelAfterSubmitTransport(
        [
            {"request_id": "fal-request-123"},
            {"status": "CANCELLATION_REQUESTED"},
        ]
    )
    transport.queue = queue
    transport.job_id = job_id
    client = FalClient(origin="https://queue.fal.run", transport=transport)

    with pytest.raises(Exception) as error:
        client.dispatch(
            DispatchIdentity(
                "fal",
                "fal-ai/flux/dev",
                "https://queue.fal.run",
                "idem-fal-001",
                "generate_image",
            ),
            execution_for(queue, job_id),
        )

    assert getattr(error.value, "code", None) == "CANCELLED"
    assert queue.get(job_id).remote_job_id == "fal-request-123"
    assert [call["method"] for call in transport.calls] == ["POST", "PUT"]
    assert transport.calls[-1]["path"].endswith("/fal-request-123/cancel")


def test_result_requires_private_artifact_staging(tmp_path: Path) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_fal_job(queue)
    transport = ScriptedFalTransport(
        [
            {"request_id": "fal-request-123"},
            {"status": "COMPLETED", "request_id": "fal-request-123"},
            {
                "images": [
                    {
                        "url": "https://v3.fal.media/files/example/result.png",
                        "width": 2400,
                        "height": 1667,
                        "content_type": "image/png",
                    }
                ]
            },
        ]
    )
    client = FalClient(origin="https://queue.fal.run", transport=transport)

    with pytest.raises(Exception) as error:
        client.dispatch(
            DispatchIdentity(
                "fal",
                "fal-ai/flux/dev",
                "https://queue.fal.run",
                "idem-fal-001",
                "generate_image",
            ),
            execution_for(queue, job_id),
        )

    assert getattr(error.value, "code", None) == "INVALID_ARTIFACT"


def test_invalid_artifact_host_fails_closed(tmp_path: Path) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_fal_job(queue)
    transport = ScriptedFalTransport(
        [
            {"request_id": "fal-request-123"},
            {"status": "COMPLETED", "request_id": "fal-request-123"},
            {
                "images": [
                    {
                        "url": "https://evil.example/private.png",
                        "width": 2400,
                        "height": 1667,
                        "content_type": "image/png",
                    }
                ]
            },
        ]
    )
    client = FalClient(origin="https://queue.fal.run", transport=transport)

    with pytest.raises(Exception) as error:
        client.dispatch(
            DispatchIdentity(
                "fal",
                "fal-ai/flux/dev",
                "https://queue.fal.run",
                "idem-fal-001",
                "generate_image",
            ),
            execution_for(queue, job_id),
        )

    assert getattr(error.value, "code", None) == "INVALID_ARTIFACT"


def test_unsafe_remote_request_id_is_rejected_before_poll(tmp_path: Path) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_fal_job(queue)
    transport = ScriptedFalTransport([{"request_id": "../escape?secret=x"}])
    client = FalClient(origin="https://queue.fal.run", transport=transport)

    with pytest.raises(Exception) as error:
        client.dispatch(
            DispatchIdentity(
                "fal",
                "fal-ai/flux/dev",
                "https://queue.fal.run",
                "idem-fal-001",
                "generate_image",
            ),
            execution_for(queue, job_id),
        )

    assert getattr(error.value, "code", None) == "INVALID_RESPONSE"
    assert [call["method"] for call in transport.calls] == ["POST"]
    assert queue.get(job_id).remote_job_id is None


def png_bytes(width: int = 2400, height: int = 1667) -> bytes:
    output = BytesIO()
    Image.new("RGB", (width, height), "white").save(output, format="PNG")
    return output.getvalue()


@dataclass
class ScriptedArtifactDownloader:
    payload: bytes | list[bytes | Exception]

    def __post_init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def download(self, **kwargs: Any) -> bytes:
        self.calls.append(kwargs)
        if isinstance(self.payload, list):
            outcome = self.payload.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        return self.payload


def test_download_validates_and_stages_private_artifact_without_remote_url(tmp_path: Path) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_fal_job(queue)
    transport = ScriptedFalTransport(
        [
            {"request_id": "fal-request-123"},
            {"status": "COMPLETED", "request_id": "fal-request-123"},
            {
                "images": [
                    {
                        "url": "https://v3.fal.media/files/example/result.png",
                        "width": 2400,
                        "height": 1667,
                        "content_type": "image/png",
                    }
                ],
                "seed": 17,
            },
        ]
    )
    downloader = ScriptedArtifactDownloader(png_bytes())
    store = ArtifactStore(queue.engine, tmp_path / "artifacts")
    client = FalClient(
        origin="https://queue.fal.run",
        transport=transport,
        artifact_downloader=downloader,
        artifact_store=store,
        artifact_ttl_seconds=3600,
        max_artifact_bytes=20 * 1024 * 1024,
    )

    result = client.dispatch(
        DispatchIdentity(
            "fal",
            "fal-ai/flux/dev",
            "https://queue.fal.run",
            "idem-fal-001",
            "generate_image",
        ),
        execution_for(queue, job_id),
    )

    artifact = result["artifact"]
    assert isinstance(artifact, dict)
    assert "url" not in artifact
    record = store.get_for_owner(str(artifact["id"]), "session-a")
    assert store.verify_integrity(record) is True
    assert record.media_type == "image/png"
    assert record.size_bytes == len(downloader.payload)
    assert downloader.calls == [
        {
            "url": "https://v3.fal.media/files/example/result.png",
            "max_bytes": 20 * 1024 * 1024,
            "timeout_seconds": pytest.approx(downloader.calls[0]["timeout_seconds"]),
        }
    ]


def test_download_retries_transient_failure_with_a_strict_bound(tmp_path: Path) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_fal_job(queue)
    transport = ScriptedFalTransport(
        [
            {"request_id": "fal-request-123"},
            {"status": "COMPLETED", "request_id": "fal-request-123"},
            {
                "images": [
                    {
                        "url": "https://v3.fal.media/files/example/result.png",
                        "width": 2400,
                        "height": 1667,
                        "content_type": "image/png",
                    }
                ]
            },
        ]
    )
    downloader = ScriptedArtifactDownloader([TimeoutError("transient"), png_bytes()])
    store = ArtifactStore(queue.engine, tmp_path / "artifacts")
    client = FalClient(
        origin="https://queue.fal.run",
        transport=transport,
        artifact_downloader=downloader,
        artifact_store=store,
        artifact_ttl_seconds=3600,
        max_artifact_bytes=20 * 1024 * 1024,
        max_download_attempts=2,
    )

    result = client.dispatch(
        DispatchIdentity(
            "fal",
            "fal-ai/flux/dev",
            "https://queue.fal.run",
            "idem-fal-001",
            "generate_image",
        ),
        execution_for(queue, job_id),
    )

    assert len(downloader.calls) == 2
    assert isinstance(result["artifact"], dict)
    assert "id" in result["artifact"]


def test_download_rejects_spoofed_or_sub_four_megapixel_artifact(tmp_path: Path) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_fal_job(queue)
    transport = ScriptedFalTransport(
        [
            {"request_id": "fal-request-123"},
            {"status": "COMPLETED", "request_id": "fal-request-123"},
            {
                "images": [
                    {
                        "url": "https://v3.fal.media/files/example/result.png",
                        "width": 2400,
                        "height": 1667,
                        "content_type": "image/png",
                    }
                ]
            },
        ]
    )
    downloader = ScriptedArtifactDownloader(png_bytes(800, 600))
    store = ArtifactStore(queue.engine, tmp_path / "artifacts")
    client = FalClient(
        origin="https://queue.fal.run",
        transport=transport,
        artifact_downloader=downloader,
        artifact_store=store,
        artifact_ttl_seconds=3600,
        max_artifact_bytes=20 * 1024 * 1024,
    )

    with pytest.raises(Exception) as error:
        client.dispatch(
            DispatchIdentity(
                "fal",
                "fal-ai/flux/dev",
                "https://queue.fal.run",
                "idem-fal-001",
                "generate_image",
            ),
            execution_for(queue, job_id),
        )

    assert getattr(error.value, "code", None) == "INVALID_ARTIFACT"
    assert not (tmp_path / "artifacts").exists()
