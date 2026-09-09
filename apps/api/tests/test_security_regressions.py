"""Regression tests for security-review findings in Issue #7."""

from __future__ import annotations

import ipaddress
from pathlib import Path

import httpx
import pytest

from gandiwa_api.config import Settings
from gandiwa_api.main import app
from gandiwa_api.security.providers import get_configured_providers
from gandiwa_api.security.ssrf import SSRFValidationError, validate_connector_url


@pytest.mark.parametrize(
    "url",
    [
        "http://192.0.0.1:20128/v1",
        "http://10.0.0.1:20128/v1",
        "http://127.0.0.1:20128/v1",
    ],
)
def test_9router_configuration_cannot_self_approve_non_tailscale_private_targets(url: str) -> None:
    with pytest.raises(SSRFValidationError):
        validate_connector_url(url, approved_9router_target=url)


def test_9router_configuration_requires_the_canonical_v1_base_path() -> None:
    approved = "http://100.98.114.115:20128/v1"
    for url in (
        "http://100.98.114.115:20128/admin",
        "http://100.98.114.115:20128/v10",
        "http://100.98.114.115:20128/v1?target=http://169.254.169.254",
    ):
        with pytest.raises(SSRFValidationError):
            validate_connector_url(url, approved_9router_target=approved)


def test_fal_is_not_configured_when_its_endpoint_is_not_the_official_https_origin() -> None:
    settings = Settings.model_validate(
        {
            "FAL" + "_KEY": "test-key",
            "FAL_BASE_URL": "https://attacker.example.invalid",
        }
    )
    providers = get_configured_providers(settings)
    provider_map = {provider.id: provider for provider in providers}

    assert provider_map["fal"].configured is False


def test_production_settings_reject_placeholder_session_secret_and_insecure_cookies() -> None:
    with pytest.raises(ValueError, match="SESSION_SECRET"):
        Settings(
            ENV="production",
            SESSION_SECRET="change-me-for-local-development",
            SECURE_COOKIES=True,
        )

    with pytest.raises(ValueError, match="SECURE_COOKIES"):
        Settings(
            ENV="production",
            SESSION_SECRET="a" * 32,
            SECURE_COOKIES=False,
        )


@pytest.mark.anyio
async def test_main_app_rejects_anonymous_artifact_download(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()
    (artifacts_dir / "known.svg").write_text(
        "<svg><script>alert(1)</script></svg>", encoding="utf-8"
    )
    monkeypatch.setenv("GANDIWA_ARTIFACT_DIR", str(artifacts_dir))

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get("/api/v1/artifacts/known.svg/download")

    assert response.status_code == 401


@pytest.mark.anyio
async def test_configured_cors_allows_only_the_configured_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GANDIWA_ALLOWED_ORIGINS", "http://localhost:5173")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        allowed = await client.options(
            "/api/v1/providers",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
            },
        )
        denied = await client.options(
            "/api/v1/providers",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "GET",
            },
        )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert denied.status_code == 400
    assert "access-control-allow-origin" not in denied.headers


def test_provider_config_rejects_mixed_public_and_private_dns_answers() -> None:
    def mixed_answers(_host: str, _port: int) -> list[ipaddress.IPv4Address]:
        return [ipaddress.ip_address("93.184.216.34"), ipaddress.ip_address("127.0.0.1")]

    with pytest.raises(SSRFValidationError):
        validate_connector_url(
            "https://mixed.example.invalid/v1",
            allow_custom_dns_resolver=mixed_answers,
        )
