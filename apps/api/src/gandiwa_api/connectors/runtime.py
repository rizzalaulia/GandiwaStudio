"""Server-side construction of the named 9Router connector registry (Issue #24 Slice B).

The API key of every named instance is injected only here, inside the backend,
at call time through a credentialling transport. No key or base URL ever
reaches the browser: the provider endpoint exposes only per-instance booleans.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

from gandiwa_api.config import Settings
from gandiwa_api.connectors.base import ProviderConnector
from gandiwa_api.connectors.ninerouter import NineRouterClient
from gandiwa_api.connectors.registry import ConnectorRegistry
from gandiwa_api.security.ssrf import validate_9router_base_url


class ConnectorTransport(Protocol):
    """One server-side transport to a single provider instance."""

    def request(self, **kwargs: Any) -> Any: ...


class CredentialledTransport:
    """Injects one instance's bearer key at call time; the key never leaves the server."""

    def __init__(self, api_key: str, base: ConnectorTransport) -> None:
        self._api_key = api_key
        self._base = base

    def request(self, **kwargs: Any) -> Any:
        headers = dict(kwargs.get("headers") or {})
        headers["Authorization"] = f"Bearer {self._api_key}"
        kwargs["headers"] = headers
        return self._base.request(**kwargs)


class InstanceOrigins:
    """Validated per-instance origin mapping (server-side only)."""

    def __init__(self, origins: Mapping[str, str]) -> None:
        self._origins: dict[str, str] = dict(origins)

    def origin_for(self, instance_id: str) -> str | None:
        return self._origins.get(instance_id)


def build_assistant_regorigins(settings: Settings) -> InstanceOrigins:
    """Validated origins of configured instances; called rarely, never serialized."""
    validated: dict[str, str] = {}
    for instance_id, origin in settings.ninerouter_instance_origins().items():
        try:
            validate_9router_base_url(origin)
        except ValueError:
            continue
        validated[instance_id] = origin
    return InstanceOrigins(validated)


def build_assistant_registry(
    settings: Settings,
    base_transports: dict[str, ConnectorTransport] | None = None,
) -> ConnectorRegistry:
    """Connectors ready only from validated, key-carrying configured instances.

    Fail-closed: an instance with a missing key, an unvalidated target, or no
    server-side transport is simply not registered, so a job bound to it lands
    ``needs_review UNKNOWN_DISPATCH`` through the registry LookupError path.
    """
    transports: Mapping[str, ConnectorTransport] = (
        base_transports if base_transports is not None else {}
    )
    connectors: dict[str, ProviderConnector] = {}
    for instance_id, origin in settings.ninerouter_instance_origins().items():
        api_key = settings.ninerouter_instance_api_key(instance_id)
        base = transports.get(instance_id)
        if not api_key or base is None:
            continue
        try:
            validate_9router_base_url(origin)
        except ValueError:
            continue
        connectors[instance_id] = NineRouterClient(
            instance_id,
            origin,
            CredentialledTransport(api_key, base),
        )
    return ConnectorRegistry(connectors)  # structural match
