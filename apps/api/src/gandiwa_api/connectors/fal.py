"""Fail-closed fal.ai queue connector for image generation (Issue #25)."""

from __future__ import annotations

import re
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

import httpx

from gandiwa_api.artifact_store import ArtifactStore
from gandiwa_api.connectors.base import ConnectorError, DispatchIdentity
from gandiwa_api.queue import JobExecution, QueueError
from gandiwa_api.raster_preflight import RasterPreflightLimits, inspect_raster
from gandiwa_api.security.ssrf import SSRFValidationError, validate_fal_media_url

_MODEL_ID = re.compile(r"^fal-ai/[a-z0-9][a-z0-9._/-]*[a-z0-9]$")
_REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_TERMINAL_STATUS = "COMPLETED"
_PENDING_STATUSES = {"IN_QUEUE", "IN_PROGRESS"}


class FalError(ConnectorError):
    """Stable, redacted fal.ai failure."""

    code = "INVALID_RESPONSE"

    def __init__(self, code: str = "INVALID_RESPONSE") -> None:
        self.code = code
        super().__init__(code)


class FalClient:
    """One fixed fal.ai queue origin; never routes or falls back."""

    capabilities = ("generate_image",)

    def __init__(
        self,
        *,
        origin: str,
        transport: Any,
        max_poll_attempts: int = 60,
        poll_interval_seconds: float = 2.0,
        artifact_downloader: Any | None = None,
        artifact_store: ArtifactStore | None = None,
        artifact_ttl_seconds: int = 3_600,
        max_artifact_bytes: int = 50 * 1024 * 1024,
        max_download_attempts: int = 2,
        artifact_url_validator: Callable[[str], object] = validate_fal_media_url,
    ) -> None:
        if origin.rstrip("/") != "https://queue.fal.run":
            raise ValueError("fal origin must be the official queue origin")
        if max_poll_attempts < 1:
            raise ValueError("fal max poll attempts must be positive")
        if poll_interval_seconds < 0:
            raise ValueError("fal poll interval cannot be negative")
        if artifact_ttl_seconds < 1 or max_artifact_bytes < 1 or max_download_attempts < 1:
            raise ValueError("fal artifact limits must be positive")
        self.origin = origin.rstrip("/")
        self.transport = transport
        self.max_poll_attempts = max_poll_attempts
        self.poll_interval_seconds = poll_interval_seconds
        self.artifact_downloader = artifact_downloader
        self.artifact_store = artifact_store
        self.artifact_ttl_seconds = artifact_ttl_seconds
        self.max_artifact_bytes = max_artifact_bytes
        self.max_download_attempts = max_download_attempts
        self.artifact_url_validator = artifact_url_validator

    def dispatch(self, identity: DispatchIdentity, execution: object) -> dict[str, object]:
        if (
            identity.provider_id != "fal"
            or identity.origin.rstrip("/") != self.origin
            or identity.capability != "generate_image"
        ):
            raise FalError("IDENTITY_MISMATCH")
        if not isinstance(execution, JobExecution):
            raise FalError("INVALID_REQUEST")
        if not _valid_model_id(identity.model_id):
            raise FalError("INVALID_REQUEST")

        parameters = execution.job.parameters
        payload = parameters.get("generation_payload")
        rules_snapshot = parameters.get("rules_snapshot")
        approved_prompt_digest = parameters.get("approved_prompt_digest")
        if (
            not isinstance(payload, dict)
            or not isinstance(rules_snapshot, dict)
            or not rules_snapshot
            or not isinstance(approved_prompt_digest, str)
            or not approved_prompt_digest
        ):
            raise FalError("INVALID_REQUEST")
        if execution.cancellation_requested():
            raise FalError("CANCELLED")

        execution.heartbeat()
        execution.mark_dispatched(None)
        model_path = f"/{identity.model_id}"
        submitted = self._request(
            method="POST",
            path=model_path,
            payload=payload,
            headers={
                "Idempotency-Key": identity.idempotency_key,
                "X-Fal-No-Retry": "1",
            },
            timeout_seconds=self._remaining(execution),
        )
        request_id = _required_string(submitted, "request_id")
        if not _REQUEST_ID.fullmatch(request_id):
            raise FalError()
        execution.record_remote_job_id(request_id)

        status_path = f"{model_path}/requests/{request_id}/status"
        completed = False
        for attempt in range(self.max_poll_attempts):
            if execution.cancellation_requested():
                self._cancel(model_path, request_id, execution)
                raise FalError("CANCELLED")
            execution.heartbeat()
            try:
                status_body = self._request(
                    method="GET",
                    path=status_path,
                    payload=None,
                    headers={},
                    timeout_seconds=self._remaining(execution),
                )
            except FalError as error:
                if error.code not in {"PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE"} or (
                    attempt + 1 >= self.max_poll_attempts
                ):
                    raise
                execution.heartbeat()
                continue
            echoed_id = status_body.get("request_id")
            if echoed_id is not None and echoed_id != request_id:
                raise FalError()
            status = _required_string(status_body, "status")
            if status == _TERMINAL_STATUS:
                completed = True
                break
            if status not in _PENDING_STATUSES:
                raise FalError()
            if attempt + 1 < self.max_poll_attempts and self.poll_interval_seconds:
                time.sleep(min(self.poll_interval_seconds, self._remaining(execution)))
        if not completed:
            raise FalError("PROVIDER_TIMEOUT")

        execution.heartbeat()
        result = self._request(
            method="GET",
            path=f"{model_path}/requests/{request_id}",
            payload=None,
            headers={},
            timeout_seconds=self._remaining(execution),
        )
        artifact = _parse_single_image(result)
        artifact_result = self._stage_artifact(artifact, execution)
        seed = result.get("seed")
        if seed is not None and (not isinstance(seed, int) or isinstance(seed, bool)):
            raise FalError()
        return {
            "provider_job_id": request_id,
            "provider_id": identity.provider_id,
            "model_id": identity.model_id,
            "seed": seed,
            "parameters": dict(payload),
            "rules_snapshot": dict(rules_snapshot),
            "approved_prompt_digest": approved_prompt_digest,
            "artifact": artifact_result,
        }

    def _stage_artifact(
        self,
        artifact: dict[str, object],
        execution: JobExecution,
    ) -> dict[str, object]:
        if self.artifact_downloader is None or self.artifact_store is None:
            raise FalError("INVALID_ARTIFACT")
        url = str(artifact["url"])
        try:
            validated_artifact_origin = self.artifact_url_validator(url)
        except (SSRFValidationError, ValueError):
            raise FalError("INVALID_ARTIFACT") from None
        if (
            not isinstance(validated_artifact_origin, tuple)
            or len(validated_artifact_origin) != 3
            or not isinstance(validated_artifact_origin[0], str)
            or not isinstance(validated_artifact_origin[1], int)
            or not isinstance(validated_artifact_origin[2], list)
            or not validated_artifact_origin[2]
        ):
            raise FalError("INVALID_ARTIFACT")
        artifact_host, artifact_port, artifact_ips = validated_artifact_origin
        declared_mime = str(artifact["content_type"])
        extension = "png" if declared_mime == "image/png" else "jpg"
        payload: bytes | None = None
        for attempt in range(self.max_download_attempts):
            try:
                payload = self.artifact_downloader.download(
                    url=url,
                    host=artifact_host,
                    port=artifact_port,
                    resolved_ips=artifact_ips,
                    max_bytes=self.max_artifact_bytes,
                    timeout_seconds=self._remaining(execution),
                )
                break
            except (TimeoutError, httpx.TimeoutException):
                if attempt + 1 >= self.max_download_attempts:
                    raise FalError("PROVIDER_TIMEOUT") from None
                execution.heartbeat()
            except httpx.HTTPStatusError as error:
                if error.response.status_code < 500 or attempt + 1 >= self.max_download_attempts:
                    raise FalError("INVALID_ARTIFACT") from None
                execution.heartbeat()
            except Exception:
                raise FalError("INVALID_ARTIFACT") from None
        if not isinstance(payload, bytes) or len(payload) > self.max_artifact_bytes:
            raise FalError("INVALID_ARTIFACT")
        report = inspect_raster(
            payload,
            declared_mime_type=declared_mime,
            filename=f"result.{extension}",
            content_type="illustration",
            limits=RasterPreflightLimits(max_bytes=self.max_artifact_bytes),
        )
        if (
            report.verdict == "fail"
            or report.detected_mime_type != declared_mime
            or report.width != artifact["width"]
            or report.height != artifact["height"]
        ):
            raise FalError("INVALID_ARTIFACT")
        owner = execution.job.parameters.get("owner_session_id")
        if not isinstance(owner, str) or not owner:
            raise FalError("INVALID_REQUEST")
        record = self.artifact_store.stage_bytes(
            job_id=execution.id,
            owner_session_id=owner,
            download_name=f"generated.{extension}",
            media_type=declared_mime,
            payload=payload,
            ttl_seconds=self.artifact_ttl_seconds,
        )
        return {
            "id": record.id,
            "media_type": record.media_type,
            "size_bytes": record.size_bytes,
            "sha256": record.sha256,
            "width": report.width,
            "height": report.height,
        }

    def _cancel(
        self,
        model_path: str,
        request_id: str,
        execution: JobExecution,
    ) -> None:
        response = self._request(
            method="PUT",
            path=f"{model_path}/requests/{request_id}/cancel",
            payload=None,
            headers={},
            timeout_seconds=self._remaining(execution),
        )
        if response.get("status") != "CANCELLATION_REQUESTED":
            raise FalError("UNKNOWN_PROVIDER_OUTCOME")

    def _remaining(self, execution: JobExecution) -> float:
        remaining = min(execution.timeout_seconds, execution.deadline_frozen - time.monotonic())
        if remaining <= 0:
            raise FalError("PROVIDER_TIMEOUT")
        return remaining

    def _request(self, **kwargs: Any) -> dict[str, object]:
        try:
            response = self.transport.request(origin=self.origin, **kwargs)
        except (TimeoutError, httpx.TimeoutException):
            raise FalError("PROVIDER_TIMEOUT") from None
        except httpx.HTTPStatusError as error:
            status = error.response.status_code
            code = "INVALID_RESPONSE"
            if status in (401, 403):
                code = "AUTH_REJECTED"
            elif status == 429:
                code = "QUOTA_EXCEEDED"
            elif status >= 500:
                code = "PROVIDER_UNAVAILABLE"
            raise FalError(code) from None
        except QueueError:
            raise
        except Exception:
            raise FalError("PROVIDER_UNAVAILABLE") from None
        if not isinstance(response, dict):
            raise FalError()
        return response


def _valid_model_id(model_id: str) -> bool:
    return bool(_MODEL_ID.fullmatch(model_id)) and ".." not in model_id and "//" not in model_id


def _required_string(body: dict[str, object], key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value.strip():
        raise FalError()
    return value


def _parse_single_image(body: dict[str, object]) -> dict[str, object]:
    images = body.get("images")
    if not isinstance(images, list) or len(images) != 1 or not isinstance(images[0], dict):
        raise FalError()
    image = images[0]
    url = _required_string(image, "url")
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in {"fal.media", "v3.fal.media"}:
        raise FalError("INVALID_ARTIFACT")
    width = image.get("width")
    height = image.get("height")
    media_type = image.get("content_type")
    if (
        not isinstance(width, int)
        or isinstance(width, bool)
        or width < 1
        or not isinstance(height, int)
        or isinstance(height, bool)
        or height < 1
        or media_type not in {"image/png", "image/jpeg"}
    ):
        raise FalError("INVALID_ARTIFACT")
    return {"url": url, "width": width, "height": height, "content_type": media_type}
