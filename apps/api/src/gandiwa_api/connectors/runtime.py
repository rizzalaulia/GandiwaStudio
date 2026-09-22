"""Server-side construction of the named 9Router connector registry (Issue #24 Slice B).

The API key of every named instance is injected only here, inside the backend,
at call time through a credentialling transport. No key or base URL ever
reaches the browser: the provider endpoint exposes only per-instance booleans.
"""

from __future__ import annotations

import socket
import ssl
from collections.abc import Callable, Mapping
from http.client import HTTPSConnection
from ipaddress import IPv4Address, IPv6Address
from typing import Any, Protocol
from urllib.parse import urlsplit

import httpx

from gandiwa_api.artifact_store import ArtifactStore
from gandiwa_api.config import Settings
from gandiwa_api.connectors.base import ProviderConnector
from gandiwa_api.connectors.fal import FalClient
from gandiwa_api.connectors.ninerouter import NineRouterClient
from gandiwa_api.connectors.registry import ConnectorRegistry
from gandiwa_api.security.ssrf import validate_9router_base_url, validate_fal_base_url


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


class FalCredentialledTransport:
    """Inject the official fal ``Key`` scheme only inside the backend."""

    def __init__(self, api_key: str, base: ConnectorTransport) -> None:
        self._api_key = api_key
        self._base = base

    def request(self, **kwargs: Any) -> Any:
        headers = dict(kwargs.get("headers") or {})
        headers["Authorization"] = f"Key {self._api_key}"
        kwargs["headers"] = headers
        return self._base.request(**kwargs)


class HttpxJsonTransport:
    """Bounded JSON transport; redirects stay disabled at the connector boundary."""

    def request(self, **kwargs: Any) -> dict[str, object]:
        origin = str(kwargs["origin"]).rstrip("/")
        path = str(kwargs["path"])
        response = httpx.request(
            str(kwargs["method"]),
            f"{origin}{path}",
            json=kwargs.get("payload"),
            headers=dict(kwargs.get("headers") or {}),
            timeout=float(kwargs.get("timeout_seconds", 30.0)),
            follow_redirects=False,
        )
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict):
            raise ValueError("provider response must be a JSON object")
        return body


class _PinnedHTTPSConnection(HTTPSConnection):
    """Connect to one validated IP while TLS verifies the canonical hostname."""

    def __init__(
        self, *, host: str, ip: IPv4Address | IPv6Address, port: int, timeout: float
    ) -> None:
        self._tls_context = ssl.create_default_context()
        super().__init__(host=host, port=port, timeout=timeout, context=self._tls_context)
        self._validated_ip = str(ip)

    def connect(self) -> None:
        raw_socket = socket.create_connection((self._validated_ip, self.port), self.timeout)
        self.sock = self._tls_context.wrap_socket(raw_socket, server_hostname=self.host)


class HttpxArtifactDownloader:
    """Download only through a validated IP; TLS remains hostname-verified.

    The name is retained for compatibility with the existing runtime factory.
    It deliberately does not call HTTPX for artifact URLs: HTTPX would resolve
    the hostname again after SSRF validation, reopening DNS-rebinding risk.
    """

    def download(
        self,
        *,
        url: str,
        host: str,
        port: int,
        resolved_ips: list[IPv4Address | IPv6Address],
        max_bytes: int,
        timeout_seconds: float,
    ) -> bytes:
        parsed = urlsplit(url)
        if parsed.hostname != host or parsed.port not in {None, port}:
            raise ValueError("artifact URL diverged from validated origin")
        target = parsed.path or "/"
        if parsed.query:
            target = f"{target}?{parsed.query}"
        last_error: OSError | None = None
        for validated_ip in resolved_ips:
            connection = _PinnedHTTPSConnection(
                host=host,
                ip=validated_ip,
                port=port,
                timeout=timeout_seconds,
            )
            try:
                connection.request("GET", target, headers={"Host": host})
                response = connection.getresponse()
                if response.status >= 500:
                    raise httpx.HTTPStatusError(
                        "artifact upstream unavailable",
                        request=httpx.Request("GET", url),
                        response=httpx.Response(response.status),
                    )
                if response.status < 200 or response.status >= 300:
                    raise ValueError("artifact request was not successful")
                declared = response.getheader("content-length")
                if declared is not None and int(declared) > max_bytes:
                    raise ValueError("artifact is too large")
                chunks: list[bytes] = []
                total = 0
                while chunk := response.read(min(64 * 1024, max_bytes + 1)):
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError("artifact is too large")
                    chunks.append(chunk)
                return b"".join(chunks)
            except OSError as error:
                last_error = error
            finally:
                connection.close()
        if last_error is not None:
            raise last_error
        raise ValueError("artifact validator supplied no addresses")


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


def build_generation_registry(
    settings: Settings,
    *,
    base_transport: ConnectorTransport | None,
    artifact_downloader: Any,
    artifact_store: ArtifactStore,
    origin_validator: Callable[[str], object] = validate_fal_base_url,
) -> ConnectorRegistry:
    """Build the one fixed fal generator, or fail closed with an empty registry."""
    api_key = settings.fal_api_key()
    if not api_key or base_transport is None:
        return ConnectorRegistry({})
    try:
        origin_validator(settings.FAL_BASE_URL)
    except ValueError:
        return ConnectorRegistry({})
    connector = FalClient(
        origin=settings.FAL_BASE_URL,
        transport=FalCredentialledTransport(api_key, base_transport),
        artifact_downloader=artifact_downloader,
        artifact_store=artifact_store,
        artifact_ttl_seconds=settings.ARTIFACT_RETENTION_HOURS * 3_600,
        max_artifact_bytes=settings.MAX_ARTIFACT_BYTES,
    )
    return ConnectorRegistry({"fal": connector})
