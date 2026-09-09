"""Fixed server-side provider registry for the MVP connectors."""

from __future__ import annotations

from pydantic import BaseModel

from gandiwa_api.config import Settings
from gandiwa_api.security.ssrf import (
    SSRFValidationError,
    validate_9router_base_url,
    validate_fal_base_url,
)


class ProviderInfo(BaseModel):
    """Safe representation of a configured connector; never includes endpoint or credential."""

    id: str
    name: str
    configured: bool
    auth_required: bool


def get_configured_providers(settings: Settings) -> list[ProviderInfo]:
    """Expose only the two MVP backend-configured connectors, fail-closed on bad targets."""
    fal_configured = False
    if settings.FAL_KEY:
        try:
            validate_fal_base_url(settings.FAL_BASE_URL)
            fal_configured = True
        except SSRFValidationError:
            fal_configured = False

    ninerouter_configured = False
    if settings.NINEROUTER_BASE_URL and settings.NINEROUTER_API_KEY:
        try:
            validate_9router_base_url(settings.NINEROUTER_BASE_URL)
            ninerouter_configured = True
        except SSRFValidationError:
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
            auth_required=True,
        ),
    ]
