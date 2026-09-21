"""Provider connector contract for Issue #23.

A connector owns exactly one provider endpoint.Routing and fallback are
forbidden: each durable job freezes exactly one connector, one model, and one
origin before any network boundary is crossed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

DEFAULT_DISPATCH_TIMEOUT_SECONDS = 300


class ConnectorError(RuntimeError):
    """Fail-closed connector failure with a stable, redacted error code."""

    code = "CONNECTOR_ERROR"


class CapabilityNotDeclaredError(ConnectorError):
    """Job asked for a capability the frozen connector never declared."""

    code = "CAPABILITY_NOT_DECLARED"


@dataclass(frozen=True, slots=True)
class DispatchIdentity:
    """Frozen per-job dispatch identity; mutation is a contract violation."""

    provider_id: str
    model_id: str
    origin: str
    idempotency_key: str
    capability: str


@runtime_checkable
class ProviderConnector(Protocol):
    """One connector = one provider endpoint. No routing, no fallback."""

    def dispatch(
        self,
        identity: DispatchIdentity,
        execution: object,
    ) -> dict[str, object] | None:
        """Run one frozen dispatch; must honor JobExecution's safe surface."""
        ...


class FakeProviderServer:
    """Scripted fake provider covering Issue #23's six dispatch outcomes."""

    def __init__(
        self,
        *,
        remote_job_id: str = "fake-job-001",
        capabilities: tuple[str, ...] = ("generate_image",),
    ) -> None:
        self.calls: list[DispatchIdentity] = []
        self.scripted_code: str | None = None
        self.scripted_remote_job_id = remote_job_id
        self.capabilities = tuple(capabilities)

    def script(self, code: str | None) -> None:
        self.scripted_code = code

    def dispatch(
        self,
        identity: DispatchIdentity,
        execution: object | None = None,
    ) -> dict[str, object] | None:
        self.calls.append(identity)
        if self.scripted_code is None:
            return {
                "provider_job_id": self.scripted_remote_job_id,
                "provider_id": identity.provider_id,
                "model_id": identity.model_id,
                "remote_request_id": "fake-req-0001",
            }
        if self.scripted_code == "AUTH_REJECTED":
            raise FakeAuthError("authentication was rejected by the fake provider")
        if self.scripted_code == "QUOTA_EXCEEDED":
            raise FakeQuotaError("quota was exceeded on the fake provider")
        if self.scripted_code == "TIMEOUT":
            raise FakeTimeoutError("fake provider did not answer in time")
        raise FakeInvalidResponseError("fake provider returned an unusable response")


class FakeAuthError(ConnectorError):
    code = "AUTH_REJECTED"


class FakeQuotaError(ConnectorError):
    code = "QUOTA_EXCEEDED"


class FakeTimeoutError(ConnectorError):
    code = "PROVIDER_TIMEOUT"


class FakeInvalidResponseError(ConnectorError):
    code = "INVALID_RESPONSE"
