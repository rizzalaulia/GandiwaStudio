"""SSRF protection and provider URL validation boundaries."""

from __future__ import annotations

import ipaddress
import socket
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx

# Tailscale Carrier-Grade NAT network range
TAILSCALE_NETWORK = ipaddress.ip_network("100.64.0.0/10")

# Standard prohibited private and special-purpose networks
BLOCKED_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("192.0.2.0/24"),
    ipaddress.ip_network("198.51.100.0/24"),
    ipaddress.ip_network("203.0.113.0/24"),
    ipaddress.ip_network("198.18.0.0/15"),
    ipaddress.ip_network("224.0.0.0/4"),
    ipaddress.ip_network("240.0.0.0/4"),
    ipaddress.ip_network("255.255.255.255/32"),
    # IPv6 blocked ranges
    ipaddress.ip_network("::/128"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("ff00::/8"),
    ipaddress.ip_network("2001:db8::/32"),
]

BLOCKED_HOSTNAMES = {
    "localhost",
    "metadata.google.internal",
    "instance-data",
}


class SSRFValidationError(ValueError):
    """Raised when an outbound URL violates SSRF safety policy."""


def _parse_ip(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """Attempt to parse a host string into an IP address."""
    clean_host = host.strip("[]")
    try:
        ip = ipaddress.ip_address(clean_host)
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            return ip.ipv4_mapped
        return ip
    except ValueError:
        return None


def is_tailscale_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Return True if the IP belongs to the Tailscale CGNAT subnet."""
    return isinstance(ip, ipaddress.IPv4Address) and ip in TAILSCALE_NETWORK


def resolve_host_ips(
    hostname: str,
    port: int = 443,
) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    """Resolve hostname via DNS to all associated IP addresses."""
    try:
        addr_info = socket.getaddrinfo(hostname, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as err:
        raise SSRFValidationError(f"DNS resolution failed for host '{hostname}': {err}") from err

    ips: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for entry in addr_info:
        sockaddr = entry[4]
        ip_str = str(sockaddr[0])
        parsed = _parse_ip(ip_str)
        if parsed and parsed not in ips:
            ips.append(parsed)
    return ips


def validate_connector_url(
    url: str,
    *,
    approved_9router_target: str | None = None,
    allow_custom_dns_resolver: Any = None,
) -> tuple[str, int, list[ipaddress.IPv4Address | ipaddress.IPv6Address]]:
    """Validate a provider connector URL against SSRF rules.

    Acceptance criteria:
    - Rejects non-HTTP(S) schemes.
    - Rejects userinfo (username / password).
    - Rejects loopback, link-local, metadata, unsafe private CIDR.
    - Permits narrow approved 9Router Tailscale target when configured.
    - Default requires HTTPS; plain HTTP is only allowed for the approved 9Router Tailscale target.
    """
    if not url or not isinstance(url, str):
        raise SSRFValidationError("URL must be a non-empty string")

    parsed = urlsplit(url)

    if parsed.scheme not in ("http", "https"):
        raise SSRFValidationError(
            f"Disallowed URL scheme '{parsed.scheme}'. Only http and https are permitted"
        )

    if parsed.username or parsed.password:
        raise SSRFValidationError(
            "URLs with embedded userinfo (credentials) are strictly prohibited"
        )

    hostname = parsed.hostname
    if not hostname:
        raise SSRFValidationError("URL has missing or invalid hostname")

    port = parsed.port or (80 if parsed.scheme == "http" else 443)

    if hostname.lower() in BLOCKED_HOSTNAMES:
        raise SSRFValidationError(f"Target host '{hostname}' is in the SSRF blocked list")

    # Determine if this host/url matches the narrow approved 9Router target
    is_approved_9router = False
    approved_host = None
    approved_port = None
    if approved_9router_target:
        approved_split = urlsplit(approved_9router_target)
        approved_host = approved_split.hostname
        approved_port = approved_split.port or (80 if approved_split.scheme == "http" else 443)
        if (
            approved_host
            and hostname.lower() == approved_host.lower()
            and port == approved_port
        ):
            is_approved_9router = True

    # Check plain HTTP usage
    if parsed.scheme == "http" and not is_approved_9router:
        raise SSRFValidationError("Plain HTTP is prohibited. All external providers must use HTTPS")

    # Resolve host to IP addresses
    resolved_ips: list[ipaddress.IPv4Address | ipaddress.IPv6Address]
    direct_ip = _parse_ip(hostname)
    if direct_ip:
        resolved_ips = [direct_ip]
    elif allow_custom_dns_resolver:
        resolved_ips = allow_custom_dns_resolver(hostname, port)
    else:
        resolved_ips = resolve_host_ips(hostname, port)

    if not resolved_ips:
        raise SSRFValidationError(f"No IP addresses resolved for host '{hostname}'")

    for ip in resolved_ips:
        # Check cloud metadata explicitly
        if str(ip) in ("169.254.169.254", "fd00:ec2::254"):
            raise SSRFValidationError(f"Access to cloud metadata IP '{ip}' is blocked")

        # Check loopback
        if ip.is_loopback:
            raise SSRFValidationError(f"Access to loopback address '{ip}' is blocked")

        # Check link-local
        if ip.is_link_local:
            raise SSRFValidationError(f"Access to link-local address '{ip}' is blocked")

        # Check multicast / reserved / unspecified
        if ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            raise SSRFValidationError(f"Access to special-purpose IP '{ip}' is blocked")

        # Check standard blocked private / documentation CIDRs
        for net in BLOCKED_NETWORKS:
            if ip in net:
                raise SSRFValidationError(
                    f"Access to blocked network range '{net}' ({ip}) is prohibited"
                )

        # Check Tailscale range exception
        if is_tailscale_ip(ip):
            if not is_approved_9router:
                raise SSRFValidationError(
                    f"Tailscale address '{ip}' is not the approved 9Router target"
                )
            # Approved 9Router target on Tailscale is permitted
            continue

        # If IP is private according to stdlib but not in approved exception
        if ip.is_private and not is_approved_9router:
            raise SSRFValidationError(f"Access to private IP '{ip}' is prohibited")

    return hostname, port, resolved_ips


async def handle_safe_redirect(response: httpx.Response) -> None:
    """Validate HTTP redirect targets against cross-origin and SSRF rules."""
    if response.is_redirect and "location" in response.headers:
        redirect_target = response.headers["location"]
        full_target_url = urljoin(str(response.url), redirect_target)

        initial_parsed = urlsplit(str(response.url))
        target_parsed = urlsplit(full_target_url)

        initial_origin = (initial_parsed.scheme, initial_parsed.hostname, initial_parsed.port)
        target_origin = (target_parsed.scheme, target_parsed.hostname, target_parsed.port)

        if initial_origin != target_origin:
            raise SSRFValidationError(
                f"Cross-origin redirect from '{response.url}' to '{full_target_url}' is blocked"
            )

        validate_connector_url(full_target_url)


def build_safe_http_client(
    *,
    approved_9router_target: str | None = None,
    timeout: float = 15.0,
) -> httpx.AsyncClient:
    """Build an httpx AsyncClient configured with safe redirect enforcement."""
    async def _on_response(response: httpx.Response) -> None:
        await handle_safe_redirect(response)

    return httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=False,
        event_hooks={"response": [_on_response]},
    )
