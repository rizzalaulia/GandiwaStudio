"""Tests for SSRF guard, connector URL validation, and redirect policies."""

from __future__ import annotations

import ipaddress

import httpx
import pytest

from gandiwa_api.security.ssrf import (
    SSRFValidationError,
    handle_safe_redirect,
    validate_connector_url,
)

pytestmark = pytest.mark.anyio


def mock_public_resolver(
    host: str,
    port: int,
) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    if host == "queue.fal.run":
        return [ipaddress.ip_address("104.18.20.21")]
    if host == "api.9router.internal":
        return [ipaddress.ip_address("100.98.114.115")]
    return [ipaddress.ip_address("93.184.216.34")]


def test_rejects_disallowed_schemes() -> None:
    for url in (
        "file:///etc/passwd",
        "ftp://example.com/file",
        "gopher://127.0.0.1:70",
        "data:text/plain;base64,SGVsbG8=",
        "javascript:alert(1)",
    ):
        with pytest.raises(SSRFValidationError, match="Disallowed URL scheme"):
            validate_connector_url(url)


def test_rejects_urls_with_userinfo() -> None:
    for url in (
        "https://user:password@example.com/api",
        "https://admin@example.com/v1",
        "http://foo:bar@100.98.114.115:20128/v1",
    ):
        with pytest.raises(SSRFValidationError, match="userinfo"):
            validate_connector_url(url)


def test_rejects_loopback_addresses() -> None:
    for url in (
        "http://127.0.0.1:8000/probe",
        "https://127.0.0.1:8000/probe",
        "http://127.0.0.2:8000",
        "http://[::1]:8000",
        "http://[::ffff:127.0.0.1]:8000",
        "http://localhost:8000",
    ):
        with pytest.raises(SSRFValidationError):
            validate_connector_url(url)


def test_rejects_link_local_and_cloud_metadata() -> None:
    for url in (
        "http://169.254.169.254/latest/meta-data/",
        "http://169.254.1.1",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://[fe80::1]/test",
    ):
        with pytest.raises(SSRFValidationError):
            validate_connector_url(url)


def test_rejects_unsafe_private_cidrs() -> None:
    for url in (
        "http://10.0.0.1:8080",
        "https://10.254.0.1",
        "http://172.16.0.5:8000",
        "http://172.31.255.255:8000",
        "http://192.168.1.1:8000",
        "http://[fc00::1]:8000",
    ):
        with pytest.raises(SSRFValidationError):
            validate_connector_url(url)


def test_rejects_plain_http_for_unapproved_providers() -> None:
    with pytest.raises(SSRFValidationError, match="Plain HTTP is prohibited"):
        validate_connector_url(
            "http://queue.fal.run",
            allow_custom_dns_resolver=mock_public_resolver,
        )


def test_allows_https_public_endpoint() -> None:
    host, port, ips = validate_connector_url(
        "https://queue.fal.run/generate",
        allow_custom_dns_resolver=mock_public_resolver,
    )
    assert host == "queue.fal.run"
    assert port == 443
    assert ips == [ipaddress.ip_address("104.18.20.21")]


def test_rejects_unapproved_tailscale_target() -> None:
    # Tailscale IP without approved configuration is rejected
    with pytest.raises(SSRFValidationError, match="not the approved"):
        validate_connector_url("https://100.98.114.115/v1")


def test_rejects_tailscale_target_mismatched_port_or_host() -> None:
    approved = "http://100.98.114.115:20128/v1"
    # Wrong port
    with pytest.raises(SSRFValidationError):
        validate_connector_url("http://100.98.114.115:9999/v1", approved_9router_target=approved)
    # Wrong IP
    with pytest.raises(SSRFValidationError):
        validate_connector_url("http://100.98.114.116:20128/v1", approved_9router_target=approved)
    # Wrong Scheme (https vs http)
    with pytest.raises(SSRFValidationError):
        validate_connector_url("https://100.98.114.115:20128/v1", approved_9router_target=approved)


def test_allows_approved_9router_tailscale_target() -> None:
    approved = "http://100.98.114.115:20128/v1"
    host, port, ips = validate_connector_url(
        "http://100.98.114.115:20128/v1",
        approved_9router_target=approved,
    )
    assert host == "100.98.114.115"
    assert port == 20128
    assert ips == [ipaddress.ip_address("100.98.114.115")]


def test_allows_approved_9router_tailscale_hostname() -> None:
    approved = "http://api.9router.internal:20128/v1"
    host, port, ips = validate_connector_url(
        "http://api.9router.internal:20128/v1",
        approved_9router_target=approved,
        allow_custom_dns_resolver=mock_public_resolver,
    )
    assert host == "api.9router.internal"
    assert port == 20128
    assert ips == [ipaddress.ip_address("100.98.114.115")]


async def test_redirect_handler_blocks_cross_origin_redirect() -> None:
    request = httpx.Request("POST", "https://queue.fal.run/api")
    response = httpx.Response(
        302,
        headers={"location": "https://evil.com/leak"},
        request=request,
    )
    with pytest.raises(SSRFValidationError, match="Cross-origin redirect"):
        await handle_safe_redirect(response)


async def test_redirect_handler_blocks_redirect_to_loopback() -> None:
    request = httpx.Request("POST", "https://queue.fal.run/api")
    response = httpx.Response(
        302,
        headers={"location": "http://127.0.0.1:8000/internal"},
        request=request,
    )
    with pytest.raises(SSRFValidationError):
        await handle_safe_redirect(response)


async def test_redirect_handler_allows_only_the_exact_approved_9router_base() -> None:
    approved = "http://100.98.114.115:20128/v1"
    request = httpx.Request("POST", "https://queue.fal.run/api")
    response = httpx.Response(302, headers={"location": approved}, request=request)

    await handle_safe_redirect(response, approved_9router_target=approved)


@pytest.mark.parametrize(
    ("location", "approved"),
    [
        ("http://100.98.114.115:20128/admin", "http://100.98.114.115:20128/v1"),
        ("http://192.0.0.1:20128/v1", "http://192.0.0.1:20128/v1"),
    ],
)
async def test_redirect_handler_rejects_non_exact_or_non_tailscale_9router_target(
    location: str,
    approved: str,
) -> None:
    request = httpx.Request("POST", "https://queue.fal.run/api")
    response = httpx.Response(302, headers={"location": location}, request=request)

    with pytest.raises(SSRFValidationError):
        await handle_safe_redirect(response, approved_9router_target=approved)
