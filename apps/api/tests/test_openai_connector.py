"""Offline direct OpenAI Image connector contracts for Issue #65."""

from __future__ import annotations

import base64
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
from gandiwa_api.connectors.openai import OpenAIImageClient
from gandiwa_api.database import create_sqlite_engine
from gandiwa_api.queue import JobExecution, QueueStore


@dataclass
class ScriptedOpenAITransport:
    responses: list[dict[str, object] | Exception]

    def __post_init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def request(self, **kwargs: Any) -> dict[str, object]:
        self.calls.append(kwargs)
        if not self.responses:
            raise AssertionError("unexpected OpenAI transport call")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def _alembic_config(database_url: str) -> Config:
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


def queue_store(tmp_path: Path) -> QueueStore:
    database_url = f"sqlite:///{tmp_path / 'openai.sqlite3'}"
    command.upgrade(_alembic_config(database_url), "head")
    return QueueStore(create_sqlite_engine(Settings(DATABASE_URL=database_url)))


def png_bytes() -> bytes:
    image = Image.new("RGB", (2400, 1667), color=(12, 34, 56))
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def enqueue_claimed_openai_job(
    queue: QueueStore,
    *,
    capability: str = "generate_image",
    payload_overrides: dict[str, object] | None = None,
) -> str:
    payload: dict[str, object] = {
        "prompt": "Editorial ceramic mug on linen, 2400x1667 output",
        "size": "1536x1024",
        "quality": "high",
        "output_format": "png",
        "background": "opaque",
    }
    payload.update(payload_overrides or {})
    job_id = queue.enqueue(
        job_type="generate",
        provider_id="openai",
        model_id="gpt-image-2.5-sunburst",
        parameters={
            "origin": "https://api.openai.com/v1",
            "idempotency_key": "idem-openai-001",
            "capability": capability,
            "owner_session_id": "session-a",
            "generation_payload": payload,
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


def openai_client(
    queue: QueueStore, tmp_path: Path, transport: ScriptedOpenAITransport
) -> OpenAIImageClient:
    return OpenAIImageClient(
        origin="https://api.openai.com/v1",
        transport=transport,
        artifact_store=ArtifactStore(queue.engine, tmp_path / "artifacts"),
    )


def test_generate_posts_one_explicit_image_request_and_stages_checked_base64_artifact(
    tmp_path: Path,
) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_openai_job(queue)
    encoded = base64.b64encode(png_bytes()).decode("ascii")
    transport = ScriptedOpenAITransport(
        [{"data": [{"b64_json": encoded}], "request_id": "req-openai-1"}]
    )

    result = openai_client(queue, tmp_path, transport).dispatch(
        DispatchIdentity(
            "openai",
            "gpt-image-2.5-sunburst",
            "https://api.openai.com/v1",
            "idem-openai-001",
            "generate_image",
        ),
        execution_for(queue, job_id),
    )

    assert [call["path"] for call in transport.calls] == ["/images/generations"]
    assert transport.calls[0]["payload"] == {
        "model": "gpt-image-2.5-sunburst",
        "prompt": "Editorial ceramic mug on linen, 2400x1667 output",
        "size": "1536x1024",
        "quality": "high",
        "output_format": "png",
        "background": "opaque",
        "n": 1,
    }
    assert transport.calls[0].get("files") is None
    assert transport.calls[0].get("form") is None
    assert queue.get(job_id).remote_job_id == "req-openai-1"
    assert result["provider_job_id"] == "req-openai-1"
    assert result["adapter_version"] == "openai-image-v1"
    assert result["parameters"] == transport.calls[0]["payload"]
    assert result["artifact"] == {
        "id": pytest.approx(result["artifact"]["id"]),
        "media_type": "image/png",
        "size_bytes": len(png_bytes()),
        "sha256": pytest.approx(result["artifact"]["sha256"]),
        "width": 2400,
        "height": 1667,
    }
    assert "b64_json" not in repr(result)


@pytest.mark.parametrize(
    "overrides",
    [
        {"background": "transparent", "output_format": "jpeg"},
        {"output_format": "png", "output_compression": 60},
        {"quality": "ultra"},
    ],
)
def test_rejects_unsupported_output_combination_before_any_provider_request(
    tmp_path: Path, overrides: dict[str, object]
) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_openai_job(queue, payload_overrides=overrides)
    transport = ScriptedOpenAITransport([])

    with pytest.raises(Exception, match="INVALID_REQUEST"):
        openai_client(queue, tmp_path, transport).dispatch(
            DispatchIdentity(
                "openai",
                "gpt-image-2.5-sunburst",
                "https://api.openai.com/v1",
                "idem-openai-001",
                "generate_image",
            ),
            execution_for(queue, job_id),
        )

    assert transport.calls == []


def test_supports_transparent_png_request_when_the_model_and_local_pipeline_allow_it(
    tmp_path: Path,
) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_openai_job(
        queue,
        payload_overrides={"background": "transparent"},
    )
    encoded = base64.b64encode(png_bytes()).decode("ascii")
    transport = ScriptedOpenAITransport([{"data": [{"b64_json": encoded}]}])

    openai_client(queue, tmp_path, transport).dispatch(
        DispatchIdentity(
            "openai",
            "gpt-image-2.5-sunburst",
            "https://api.openai.com/v1",
            "idem-openai-001",
            "generate_image",
        ),
        execution_for(queue, job_id),
    )

    assert transport.calls[0]["payload"]["background"] == "transparent"


def test_supports_sunburst_xhigh_jpeg_compression_and_records_actual_jpeg(tmp_path: Path) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_openai_job(
        queue,
        payload_overrides={
            "quality": "xhigh",
            "output_format": "jpeg",
            "output_compression": 60,
        },
    )
    image = Image.new("RGB", (2400, 1667), color=(12, 34, 56))
    buffer = BytesIO()
    image.save(buffer, format="JPEG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    transport = ScriptedOpenAITransport([{"data": [{"b64_json": encoded}]}])

    result = openai_client(queue, tmp_path, transport).dispatch(
        DispatchIdentity(
            "openai",
            "gpt-image-2.5-sunburst",
            "https://api.openai.com/v1",
            "idem-openai-001",
            "generate_image",
        ),
        execution_for(queue, job_id),
    )

    assert transport.calls[0]["payload"]["quality"] == "xhigh"
    assert transport.calls[0]["payload"]["output_compression"] == 60
    assert result["artifact"]["media_type"] == "image/jpeg"


def test_edit_uses_image_edits_route_with_one_private_artifact_input(tmp_path: Path) -> None:
    queue = queue_store(tmp_path)
    source_store = ArtifactStore(queue.engine, tmp_path / "artifacts")
    source = source_store.stage_bytes(
        job_id="source-job",
        owner_session_id="session-a",
        download_name="source.png",
        media_type="image/png",
        payload=png_bytes(),
        ttl_seconds=3_600,
    )
    job_id = enqueue_claimed_openai_job(
        queue,
        capability="edit_image",
        payload_overrides={"source_artifact_id": source.id},
    )
    encoded = base64.b64encode(png_bytes()).decode("ascii")
    transport = ScriptedOpenAITransport([{"data": [{"b64_json": encoded}]}])

    result = openai_client(queue, tmp_path, transport).dispatch(
        DispatchIdentity(
            "openai",
            "gpt-image-2.5-sunburst",
            "https://api.openai.com/v1",
            "idem-openai-001",
            "edit_image",
        ),
        execution_for(queue, job_id),
    )

    assert transport.calls[0]["path"] == "/images/edits"
    assert transport.calls[0]["payload"] is None
    assert transport.calls[0]["form"] == {
        "model": "gpt-image-2.5-sunburst",
        "prompt": "Editorial ceramic mug on linen, 2400x1667 output",
        "size": "1536x1024",
        "quality": "high",
        "output_format": "png",
        "background": "opaque",
        "n": "1",
    }
    assert transport.calls[0]["files"] == [("image[]", ("source.png", png_bytes(), "image/png"))]
    assert result["provider_job_id"] == "openai:idem-openai-001"


def test_submit_timeout_never_reposts_an_uncertain_image_request(tmp_path: Path) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_openai_job(queue)
    transport = ScriptedOpenAITransport([TimeoutError("synthetic timeout")])

    with pytest.raises(Exception, match="PROVIDER_TIMEOUT"):
        openai_client(queue, tmp_path, transport).dispatch(
            DispatchIdentity(
                "openai",
                "gpt-image-2.5-sunburst",
                "https://api.openai.com/v1",
                "idem-openai-001",
                "generate_image",
            ),
            execution_for(queue, job_id),
        )

    assert len(transport.calls) == 1


def test_response_without_b64_payload_is_invalid_response(tmp_path: Path) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_openai_job(queue)
    transport = ScriptedOpenAITransport([{"data": [{"url": "https://x.invalid/a.png"}]}])

    with pytest.raises(Exception, match="INVALID_RESPONSE"):
        openai_client(queue, tmp_path, transport).dispatch(
            DispatchIdentity(
                "openai",
                "gpt-image-2.5-sunburst",
                "https://api.openai.com/v1",
                "idem-openai-001",
                "generate_image",
            ),
            execution_for(queue, job_id),
        )

    assert len(transport.calls) == 1


def _status_transport(status: int, body: bytes) -> Any:
    request = httpx.Request("POST", "https://api.openai.com/v1/images/generations")
    response = httpx.Response(status, content=body, request=request)

    class Transport:
        def request(self, **kwargs: Any) -> dict[str, object]:
            raise httpx.HTTPStatusError("provider error", request=request, response=response)

    return Transport()


@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        (401, b'{"error": {"message": "bad key"}}', "AUTH_REJECTED"),
        (403, b'{"error": {"code": "moderation_blocked"}}', "SAFETY_REFUSED"),
        (403, b'{"error": {"code": "billing_hard_limit_reached"}}', "ACCOUNT_RESTRICTED"),
        (404, b'{"error": {"message": "unknown model"}}', "UNSUPPORTED_CAPABILITY"),
        (429, b'{"error": {"code": "rate_limit_exceeded"}}', "QUOTA_EXCEEDED"),
        (503, b'{"error": {"message": "upstream"}}', "PROVIDER_UNAVAILABLE"),
        (400, b'{"error": {"message": "bad request shape"}}', "INVALID_RESPONSE"),
    ],
)
def test_failure_status_map_covers_every_issue_65_class(
    tmp_path: Path, status: int, body: bytes, expected: str
) -> None:
    queue = queue_store(tmp_path)
    job_id = enqueue_claimed_openai_job(queue)

    with pytest.raises(Exception, match=expected):
        openai_client(queue, tmp_path, _status_transport(status, body)).dispatch(
            DispatchIdentity(
                "openai",
                "gpt-image-2.5-sunburst",
                "https://api.openai.com/v1",
                "idem-openai-001",
                "generate_image",
            ),
            execution_for(queue, job_id),
        )
