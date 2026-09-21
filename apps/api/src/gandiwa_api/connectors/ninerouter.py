"""Named-instance 9Router assistant client; transport wiring is explicit."""

import json
import threading
import time
from dataclasses import asdict
from typing import Any, ClassVar

import httpx

from gandiwa_api.connectors.base import ConnectorError, DispatchIdentity
from gandiwa_api.creative import assistant_adapter
from gandiwa_api.queue import JobExecution, QueueError
from gandiwa_api.security.ssrf import validate_9router_base_url


class _ResponseTransport:
    def __init__(self, body: dict[str, Any]) -> None:
        self.body = body

    def request(self, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self.body


class NineRouterError(ConnectorError):
    code = "INVALID_RESPONSE"

    def __init__(self, code: str = "INVALID_RESPONSE") -> None:
        self.code = code
        super().__init__(code)


class _LeaseRenewalThread:
    """Renews the durable lease while one blocking provider call runs."""

    def __init__(self, execution: JobExecution, interval_seconds: float) -> None:
        self._execution = execution
        self._interval_seconds = interval_seconds
        self._failure: BaseException | None = None
        self._stopping = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stopping.wait(self._interval_seconds):
            try:
                self._execution.heartbeat()
            except QueueError as error:
                self._failure = error
                return
            except BaseException as error:  # pragma: no cover - defensive
                self._failure = error
                return

    def stop(self) -> None:
        """Deterministic shutdown: wait one poll interval past a single beat."""
        self._stopping.set()
        self._thread.join(timeout=self._interval_seconds * 2 + 1.0)

    @property
    def failure(self) -> BaseException | None:
        return self._failure


class NineRouterClient:
    _operations: ClassVar[dict[str, Any]] = {
        "brainstorm": assistant_adapter.brainstorm,
        "finalize_prompt": assistant_adapter.finalize_prompt,
        "analyze_image": assistant_adapter.analyze_image,
        "suggest_metadata": assistant_adapter.suggest_metadata,
    }
    capabilities = tuple(_operations)
    _instructions: ClassVar[dict[str, str]] = {
        "brainstorm": "Exactly three distinct questions (strings) and one recommendation (string).",
        "finalize_prompt": "Nonempty prompt_text and negative_prompt_text strings.",
        "analyze_image": "Advisory only: summary string, concerns string array, blocker boolean.",
        "suggest_metadata": "title string, keywords string array, release_group one of "
        "editorial/commercial/social/decor. Human confirmation required.",
    }

    def dispatch(self, identity: DispatchIdentity, execution: object) -> dict[str, object]:
        if identity.provider_id != self.instance_id or identity.origin != self.origin:
            raise NineRouterError("IDENTITY_MISMATCH")
        if not isinstance(execution, JobExecution):
            raise NineRouterError("INVALID_REQUEST")
        if identity.capability not in self._operations:
            raise NineRouterError("INVALID_REQUEST")
        payload = execution.job.parameters.get("assistant_payload")
        if not isinstance(payload, dict):
            raise NineRouterError("INVALID_REQUEST")
        request = {
            "model": identity.model_id,
            "stream": False,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": identity.capability
                    + ": return JSON. "
                    + self._instructions[identity.capability],
                },
                {"role": "user", "content": json.dumps(payload)},
            ],
        }
        if execution.cancellation_requested():
            raise NineRouterError("CANCELLED")
        remaining = min(execution.timeout_seconds, execution.deadline_frozen - time.monotonic())
        if remaining <= 0:
            raise NineRouterError("PROVIDER_TIMEOUT")
        execution.heartbeat()
        execution.mark_dispatched(None)
        renewer = _LeaseRenewalThread(execution, self._heartbeat_interval_seconds)
        try:
            response = self._request(
                instance_id=self.instance_id,
                origin=self.origin,
                method="POST",
                path="/chat/completions",
                payload=request,
                headers={"Idempotency-Key": identity.idempotency_key},
                timeout_seconds=execution.deadline_frozen - time.monotonic(),
            )
        finally:
            renewer.stop()
        if renewer.failure is not None:
            raise NineRouterError("PROVIDER_TIMEOUT") from None
        if time.monotonic() >= execution.deadline_frozen:
            raise NineRouterError("PROVIDER_TIMEOUT")
        execution.heartbeat()
        try:
            remote_id = response["id"]
            response_model = response["model"]
            if not isinstance(remote_id, str) or not remote_id.strip():
                raise NineRouterError()
            if (
                not isinstance(response_model, str)
                or not response_model.strip()
                or response_model != identity.model_id
            ):
                raise NineRouterError()
            body = json.loads(response["choices"][0]["message"]["content"])
            if not isinstance(body, dict) or "model" in body:
                raise NineRouterError()
            body["model"] = response_model
            result = self._operations[identity.capability](_ResponseTransport(body), payload)
        except QueueError:
            raise
        except Exception:
            raise NineRouterError() from None
        return {
            "provider_job_id": remote_id,
            "provider_id": identity.provider_id,
            "model_id": identity.model_id,
            "origin": identity.origin,
            "assistant": asdict(result),
        }

    def __init__(
        self,
        instance_id: str,
        origin: str,
        transport: Any,
        heartbeat_interval_seconds: float = 10.0,
    ) -> None:
        validate_9router_base_url(origin)
        if heartbeat_interval_seconds <= 0:
            raise ValueError("heartbeat interval must be positive")
        self.instance_id = instance_id
        self.origin = origin
        self.transport = transport
        self._heartbeat_interval_seconds = heartbeat_interval_seconds

    def _request(self, **kwargs: Any) -> Any:
        try:
            return self.transport.request(**kwargs)
        except (TimeoutError, httpx.TimeoutException):
            raise NineRouterError("PROVIDER_TIMEOUT") from None
        except httpx.HTTPStatusError as error:
            status = error.response.status_code
            code = "INVALID_RESPONSE"
            if status in (401, 403):
                code = "AUTH_REJECTED"
            elif status == 429:
                code = "QUOTA_EXCEEDED"
            elif status >= 500:
                code = "PROVIDER_UNAVAILABLE"
            raise NineRouterError(code) from None
        except QueueError:
            raise
        except Exception:
            raise NineRouterError("PROVIDER_UNAVAILABLE") from None

    def models(self) -> tuple[str, ...]:
        body = self._request(
            instance_id=self.instance_id,
            origin=self.origin,
            method="GET",
            path="/models",
            payload=None,
            timeout_seconds=30.0,
        )
        if not isinstance(body, dict) or not isinstance(body.get("data"), list):
            raise NineRouterError()
        ids: list[str] = []
        for item in body["data"]:
            if not isinstance(item, dict):
                raise NineRouterError()
            model_id = item.get("id")
            if not isinstance(model_id, str) or not model_id.strip():
                raise NineRouterError()
            ids.append(model_id)
        return tuple(ids)
