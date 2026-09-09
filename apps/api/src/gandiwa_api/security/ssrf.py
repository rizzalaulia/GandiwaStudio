"""Validation for the fixed server-side provider connector targets."""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable
from urllib.parse import urljoin, urlsplit

import httpx

TAILSCALE_NETWORK = ipaddress.ip_network("100.64.0.0/10")
FAL_QUEUE_ORIGIN = ("https", "queue.fal.run", 443)
BLOCKED_HOSTNAMES = {"localhost", "metadata.google.internal", "instance-data"}

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
DNSResolver = Callable[[str, int], list[IPAddress]]


class SSRFValidationError(ValueError):
    """Raised when an outbound URL violates the connector safety policy."""


def _parse_ip(host: str) -> IPAddress | None:
    try:
        parsed = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return None
    if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped:
        return parsed.ipv4_mapped
    return parsed


def is_tailscale_ip(ip: IPAddress) -> bool:
    """Return whether an address is in Tailscale's CGNAT range."""
    return isinstance(ip, ipaddress.IPv4Address) and ip in TAILSCALE_NETWORK


def resolve_host_ips(hostname: str, port: int = 443) -> list[IPAddress]:
    """Resolve all A/AAAA answers or reject the target closed."""
    try:
        answers = socket.getaddrinfo(hostname, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as error:
        raise SSRFValidationError(f"DNS resolution failed for host '{hostname}'") from error

    resolved: list[IPAddress] = []
    for answer in answers:
        parsed = _parse_ip(str(answer[4][0]))
        if parsed is not None and parsed not in resolved:
            resolved.append(parsed)
    return resolved


def _origin(parsed_url: object) -> tuple[str, str | None, int]:
    parsed = parsed_url
    # urlsplit result is intentionally structural here; keeping this helper narrow avoids
    # accepting URL text comparisons that normalize paths or credentials unexpectedly.
    return (parsed.scheme, parsed.hostname, parsed.port or (80 if parsed.scheme == "http" else 443))  # type: ignore[attr-defined]


def _require_no_ambiguous_url_parts(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"}:
        raise SSRFValidationError("Disallowed URL scheme; only HTTP(S) provider URLs are permitted")
    if not parsed.hostname:
        raise SSRFValidationError("Provider URL must include a hostname")
    if parsed.username or parsed.password:
        raise SSRFValidationError("Provider URLs must not contain userinfo")
    if parsed.query or parsed.fragment:
        raise SSRFValidationError("Provider base URLs must not contain query strings or fragments")
    if parsed.hostname.lower() in BLOCKED_HOSTNAMES:
        raise SSRFValidationError("Provider hostname is blocked")


def _require_safe_public_ip(ip: IPAddress) -> None:
    if (
        ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or ip.is_private
        or is_tailscale_ip(ip)
    ):
        raise SSRFValidationError(
            f"Provider target '{ip}' is not the approved 9Router target or a public address"
        )


def validate_9router_base_url(
    url: str,
    *,
    dns_resolver: DNSResolver = resolve_host_ips,
) -> tuple[str, int, list[IPAddress]]:
    """Validate the only permitted non-HTTPS connector: fixed 9Router /v1 on Tailscale."""
    _require_no_ambiguous_url_parts(url)
    parsed = urlsplit(url)
    if parsed.scheme != "http" or parsed.path.rstrip("/") != "/v1":
        raise SSRFValidationError("9Router must use plain HTTP only at its exact /v1 base path")

    port = parsed.port or 80
    direct_ip = _parse_ip(parsed.hostname or "")
    resolved = [direct_ip] if direct_ip else dns_resolver(parsed.hostname or "", port)
    if not resolved or not all(is_tailscale_ip(ip) for ip in resolved):
        raise SSRFValidationError("9Router must resolve only to a Tailscale address")
    return parsed.hostname or "", port, resolved


def validate_fal_base_url(
    url: str,
    *,
    dns_resolver: DNSResolver = resolve_host_ips,
) -> tuple[str, int, list[IPAddress]]:
    """Validate fal's fixed official HTTPS queue origin, including all DNS answers."""
    _require_no_ambiguous_url_parts(url)
    parsed = urlsplit(url)
    if _origin(parsed) != FAL_QUEUE_ORIGIN or parsed.path not in {"", "/"}:
        raise SSRFValidationError(
            "fal connector must use the official https://queue.fal.run origin"
        )
    resolved = dns_resolver("queue.fal.run", 443)
    if not resolved:
        raise SSRFValidationError("fal hostname did not resolve")
    for ip in resolved:
        _require_safe_public_ip(ip)
    return "queue.fal.run", 443, resolved


def validate_connector_url(
    url: str,
    *,
    approved_9router_target: str | None = None,
    allow_custom_dns_resolver: DNSResolver | None = None,
) -> tuple[str, int, list[IPAddress]]:
    """Validate a concrete outbound URL without granting it provider configuration status.

    HTTPS targets must resolve only to public addresses. Plain HTTP is permitted solely when
    the exact URL equals the configured 9Router base and that base resolves only to Tailscale.
    The provider registry uses ``validate_9router_base_url`` and ``validate_fal_base_url``
    directly, so arbitrary URLs can never become configured connectors through this helper.
    """
    _require_no_ambiguous_url_parts(url)
    parsed = urlsplit(url)
    resolver = allow_custom_dns_resolver or resolve_host_ips

    if parsed.scheme == "http":
        if url != approved_9router_target:
            raise SSRFValidationError("Plain HTTP is prohibited for external providers")
        return validate_9router_base_url(url, dns_resolver=resolver)

    port = parsed.port or 443
    direct_ip = _parse_ip(parsed.hostname or "")
    resolved = [direct_ip] if direct_ip else resolver(parsed.hostname or "", port)
    if not resolved:
        raise SSRFValidationError("Provider hostname did not resolve")
    for ip in resolved:
        _require_safe_public_ip(ip)
    return parsed.hostname or "", port, resolved


async def handle_safe_redirect(
    response: httpx.Response,
    *,
    approved_9router_target: str | None = None,
) -> None:
    """Reject redirects that leave the fixed connector origin or violate its URL policy."""
    if not response.is_redirect or "location" not in response.headers:
        return
    target = urljoin(str(response.url), response.headers["location"])
    if _origin(urlsplit(str(response.url))) != _origin(urlsplit(target)):
        # The sole cross-origin exception is the exact backend-configured 9Router base.
        # Dispatch code must still not forward credentials across origins when it is added.
        if target != approved_9router_target:
            raise SSRFValidationError("Cross-origin redirect to another provider is blocked")
        validate_9router_base_url(target)
        return
    validate_connector_url(target, approved_9router_target=approved_9router_target)
