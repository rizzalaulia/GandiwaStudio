"""Provider registry and backend configuration allowlist."""

from __future__ import annotations

from pydantic import BaseModel

from gandiwa_api.config import Settings
from gandiwa_api.security.ssrf import validate_connector_url


class ProviderInfo(BaseModel):
    """Safe representation of an available provider connector."""

    id: str
    name: str
    configured: bool
    auth_required: bool


def get_configured_providers(settings: Settings) -> list[ProviderInfo]:
    """Return backend-configured providers without exposing secrets or arbitrary URLs."""
    fal_configured = bool(settings.FAL_KEY)

    ninerouter_configured = False
    if settings.NINEROUTER_BASE_URL:
        try:
            validate_connector_url(
                settings.NINEROUTER_BASE_URL,
                approved_9router_target=settings.NINEROUTER_BASE_URL,
            )
            ninerouter_configured = True
        except Exception:
            ninerouter_configured = False

    return [
        ProviderInfo(
            id="fal",
            name="fal.ai",
            configured=fal_configured,
            auth_required=True,
        ),
        ProviderInfo(
            id="9router",
            name="9Router",
            configured=ninerouter_configured,
            auth_required=bool(settings.NINEROUTER_API_KEY),
        ),
    ]
