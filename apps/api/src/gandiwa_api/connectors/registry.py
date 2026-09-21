"""Connector registry for Issue #23 — fail-closed, no routing, no fallback."""

from __future__ import annotations

from gandiwa_api.connectors.base import ProviderConnector


class ConnectorRegistry:
    """Explicit connector injection; unknown providers are refused, never routed."""

    def __init__(self, connectors: dict[str, ProviderConnector]) -> None:
        self._connectors = dict(connectors)

    def resolve(self, provider_id: str) -> ProviderConnector:
        connector = self._connectors.get(provider_id)
        if connector is None:
            raise LookupError(f"provider is not registered: {provider_id}")
        return connector

    @property
    def registered_providers(self) -> tuple[str, ...]:
        return tuple(sorted(self._connectors))
