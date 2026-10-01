"""Fail-closed direct OpenAI Image connector for one frozen generation job."""

from __future__ import annotations

import base64
import binascii
import time
from typing import Any

import httpx

from gandiwa_api.artifact_store import ArtifactStore
from gandiwa_api.connectors.base import ConnectorError, DispatchIdentity
from gandiwa_api.queue import JobExecution, QueueError
from gandiwa_api.raster_preflight import RasterPreflightLimits, inspect_raster

OPENAI_IMAGE_ORIGIN = "https://api.openai.com/v1"
OPENAI_IMAGE_MODEL = "gpt-image-2.5-sunburst"
ADAPTER_VERSION = "openai-image-v1"
_SUPPORTED_QUALITIES = frozenset({"auto", "low", "medium", "high", "xhigh", "max"})
_SUPPORTED_FORMATS = frozenset({"png", "jpeg", "webp"})


class OpenAIImageError(ConnectorError):
    """Stable redacted failure from the direct OpenAI image boundary."""

    code = "INVALID_RESPONSE"

    def __init__(self, code: str = "INVALID_RESPONSE") -> None:
        self.code = code
        super().__init__(code)


class OpenAIImageClient:
    """One direct OpenAI Image API origin without routing or provider fallback."""

    capabilities = ("generate_image", "edit_image")

    def __init__(
        self,
        *,
        origin: str,
        transport: Any,
        artifact_store: ArtifactStore,
        artifact_ttl_seconds: int = 3_600,
        max_artifact_bytes: int = 50 * 1024 * 1024,
    ) -> None:
        if origin.rstrip("/") != OPENAI_IMAGE_ORIGIN:
            raise ValueError("OpenAI Image origin must be the official API origin")
        if artifact_ttl_seconds < 1 or max_artifact_bytes < 1:
            raise ValueError("artifact limits must be positive")
        self.origin = origin.rstrip("/")
        self.transport = transport
        self.artifact_store = artifact_store
        self.artifact_ttl_seconds = artifact_ttl_seconds
        self.max_artifact_bytes = max_artifact_bytes

    def dispatch(self, identity: DispatchIdentity, execution: object) -> dict[str, object]:
        if not isinstance(execution, JobExecution):
            raise OpenAIImageError("INVALID_REQUEST")
        if (
            identity.provider_id != "openai"
            or identity.model_id != OPENAI_IMAGE_MODEL
            or identity.origin.rstrip("/") != self.origin
            or identity.capability not in self.capabilities
        ):
            raise OpenAIImageError("IDENTITY_MISMATCH")
        payload = execution.job.parameters.get("generation_payload")
        rules_snapshot = execution.job.parameters.get("rules_snapshot")
        prompt_digest = execution.job.parameters.get("approved_prompt_digest")
        owner = execution.job.parameters.get("owner_session_id")
        if (
            not isinstance(payload, dict)
            or not isinstance(rules_snapshot, dict)
            or not rules_snapshot
            or not isinstance(prompt_digest, str)
            or not prompt_digest
            or not isinstance(owner, str)
            or not owner
        ):
            raise OpenAIImageError("INVALID_REQUEST")
        if execution.cancellation_requested():
            raise OpenAIImageError("CANCELLED")

        request, form, files = self._request_payload(identity, payload, owner)
        execution.heartbeat()
        execution.mark_dispatched(None)
        response = self._request(
            path="/images/generations"
            if identity.capability == "generate_image"
            else "/images/edits",
            payload=request,
            form=form,
            files=files,
            headers={"Idempotency-Key": identity.idempotency_key},
            timeout_seconds=self._remaining(execution),
        )
        provider_job_id = _provider_request_id(response, identity.idempotency_key)
        execution.record_remote_job_id(provider_job_id)
        encoded = _single_b64_image(response)
        request_parameters = request if request is not None else form or {}
        artifact = self._stage_image(
            encoded,
            owner,
            execution,
            expected_format=str(request_parameters["output_format"]),
        )
        return {
            "provider_job_id": provider_job_id,
            "provider_id": identity.provider_id,
            "model_id": identity.model_id,
            "adapter_version": ADAPTER_VERSION,
            "parameters": dict(request if request is not None else form or {}),
            "rules_snapshot": dict(rules_snapshot),
            "approved_prompt_digest": prompt_digest,
            "artifact": artifact,
        }

    def _request_payload(
        self,
        identity: DispatchIdentity,
        payload: dict[str, object],
        owner_session_id: str,
    ) -> tuple[
        dict[str, object] | None,
        dict[str, str] | None,
        list[tuple[str, tuple[str, bytes, str]]] | None,
    ]:
        prompt = payload.get("prompt")
        size = payload.get("size")
        quality = payload.get("quality")
        output_format = payload.get("output_format")
        background = payload.get("background")
        if (
            not isinstance(prompt, str)
            or not prompt.strip()
            or not _valid_sunburst_size(size)
            or quality not in _SUPPORTED_QUALITIES
            or output_format not in _SUPPORTED_FORMATS
            or background not in {"auto", "opaque", "transparent"}
            or (background == "transparent" and output_format != "png")
        ):
            raise OpenAIImageError("INVALID_REQUEST")
        compression = payload.get("output_compression")
        if compression is not None and (
            output_format == "png"
            or not isinstance(compression, int)
            or isinstance(compression, bool)
            or not 0 <= compression <= 100
        ):
            raise OpenAIImageError("INVALID_REQUEST")
        request: dict[str, object] = {
            "model": identity.model_id,
            "prompt": prompt,
            "size": size,
            "quality": quality,
            "output_format": output_format,
            "background": background,
            "n": 1,
        }
        if compression is not None:
            request["output_compression"] = compression
        if identity.capability != "edit_image":
            return request, None, None
        source_artifact_id = payload.get("source_artifact_id")
        if not isinstance(source_artifact_id, str) or not source_artifact_id:
            raise OpenAIImageError("INVALID_REQUEST")
        try:
            source = self.artifact_store.get_for_owner(source_artifact_id, owner_session_id)
            if not self.artifact_store.verify_integrity(source):
                raise OpenAIImageError("INVALID_ARTIFACT")
            decoded = self.artifact_store.private_path(source).read_bytes()
        except OpenAIImageError:
            raise
        except (OSError, ArtifactStore.AccessDenied, ArtifactStore.ExpiredArtifact):
            raise OpenAIImageError("INVALID_ARTIFACT") from None
        if not decoded or len(decoded) > self.max_artifact_bytes:
            raise OpenAIImageError("INVALID_ARTIFACT")
        form = {key: str(value) for key, value in request.items()}
        return None, form, [("image[]", (source.download_name, decoded, source.media_type))]

    def _stage_image(
        self,
        encoded: str,
        owner: str,
        execution: JobExecution,
        *,
        expected_format: str,
    ) -> dict[str, object]:
        try:
            payload = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise OpenAIImageError("INVALID_ARTIFACT") from None
        if not payload or len(payload) > self.max_artifact_bytes:
            raise OpenAIImageError("INVALID_ARTIFACT")
        if expected_format == "png":
            expected_mime = "image/png"
            extension = "png"
        elif expected_format == "jpeg":
            expected_mime = "image/jpeg"
            extension = "jpg"
        else:
            raise OpenAIImageError("INVALID_ARTIFACT")
        limits = RasterPreflightLimits(
            max_bytes=self.max_artifact_bytes,
            # Connector staging enforces FORMAT/decode integrity, metadata match
            # and hard byte/pixel bounds. The 4 MP Adobe submission minimum is a
            # Stage 4 audit concern, not a per-provider connector invariant: the
            # native max of this model (1536x1024) is below it by design.
            max_pixels=25_000_000,
        )
        report = inspect_raster(
            payload,
            declared_mime_type=expected_mime,
            filename=f"generated.{extension}",
            content_type="illustration",
            limits=limits,
        )
        integrity_failure = report.verdict == "fail" and any(
            "minimum-megapixels" not in finding.rule_id for finding in report.findings
        )
        if integrity_failure or report.detected_mime_type != expected_mime:
            raise OpenAIImageError("INVALID_ARTIFACT")
        extension = "png" if report.detected_mime_type == "image/png" else "jpg"
        record = self.artifact_store.stage_bytes(
            job_id=execution.id,
            owner_session_id=owner,
            download_name=f"generated.{extension}",
            media_type=report.detected_mime_type,
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

    def _remaining(self, execution: JobExecution) -> float:
        remaining = min(execution.timeout_seconds, execution.deadline_frozen - time.monotonic())
        if remaining <= 0:
            raise OpenAIImageError("PROVIDER_TIMEOUT")
        return remaining

    def _request(
        self,
        *,
        path: str,
        payload: dict[str, object] | None,
        form: dict[str, str] | None,
        files: list[tuple[str, tuple[str, bytes, str]]] | None,
        headers: dict[str, str],
        timeout_seconds: float,
    ) -> dict[str, object]:
        try:
            response = self.transport.request(
                origin=self.origin,
                method="POST",
                path=path,
                payload=payload,
                form=form,
                files=files,
                headers=headers,
                timeout_seconds=timeout_seconds,
            )
        except (TimeoutError, httpx.TimeoutException):
            raise OpenAIImageError("PROVIDER_TIMEOUT") from None
        except httpx.HTTPStatusError as error:
            status = error.response.status_code
            detail = ""
            try:
                body = error.response.json()
                if isinstance(body, dict):
                    inner = body.get("error")
                    if isinstance(inner, dict):
                        detail = f"{inner.get('code', '')} {inner.get('type', '')}".lower()
                    elif inner is not None:
                        detail = str(inner).lower()
            except (ValueError, TypeError):
                detail = ""
            if status == 401:
                raise OpenAIImageError("AUTH_REJECTED") from None
            if status == 403 and any(
                marker in detail
                for marker in (
                    "moderation",
                    "content_policy",
                    "safety",
                    "flagged",
                    "user_request",  # OpenAI safety refusal marker
                )
            ):
                raise OpenAIImageError("SAFETY_REFUSED") from None
            if status in {402, 403}:
                raise OpenAIImageError("ACCOUNT_RESTRICTED") from None
            if status == 404:
                raise OpenAIImageError("UNSUPPORTED_CAPABILITY") from None
            if status == 429:
                raise OpenAIImageError("QUOTA_EXCEEDED") from None
            if status >= 500:
                raise OpenAIImageError("PROVIDER_UNAVAILABLE") from None
            raise OpenAIImageError("INVALID_RESPONSE") from None
        except QueueError:
            raise
        except Exception:
            raise OpenAIImageError("PROVIDER_UNAVAILABLE") from None
        if not isinstance(response, dict):
            raise OpenAIImageError("INVALID_RESPONSE")
        return response


def _provider_request_id(response: dict[str, object], idempotency_key: str) -> str:
    raw = response.get("request_id")
    if raw is None:
        return f"openai:{idempotency_key}"
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 256:
        raise OpenAIImageError("INVALID_RESPONSE")
    return raw


def _valid_sunburst_size(value: object) -> bool:
    if not isinstance(value, str) or "x" not in value:
        return False
    try:
        width, height = (int(part) for part in value.split("x", 1))
    except ValueError:
        return False
    if width <= 0 or height <= 0 or width % 16 or height % 16 or max(width, height) > 3840:
        return False
    return 1 / 3 <= width / height <= 3 and 655_360 <= width * height <= 8_294_400


def _single_b64_image(response: dict[str, object]) -> str:
    data = response.get("data")
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
        raise OpenAIImageError("INVALID_RESPONSE")
    encoded = data[0].get("b64_json")
    if not isinstance(encoded, str) or not encoded:
        raise OpenAIImageError("INVALID_RESPONSE")
    return encoded
