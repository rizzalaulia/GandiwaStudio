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


def _fal_configured(settings: Settings) -> bool:
    if not settings.fal_api_key():
        return False
    try:
        validate_fal_base_url(settings.FAL_BASE_URL)
    except SSRFValidationError:
        return False
    return True


def get_configured_providers(settings: Settings) -> list[ProviderInfo]:
    """Expose each MVP backend-configured connector; fail-closed on bad targets.

    Every named 9Router instance is listed separately by its instance id. The
    response never contains a base URL or API key — only a ``configured``
    boolean per instance.
    """
    providers = [
        ProviderInfo(
            id="fal",
            name="fal.ai",
            configured=_fal_configured(settings),
            auth_required=True,
        ),
    ]
    for instance_id, origin in settings.ninerouter_instance_origins().items():
        configured = False
        if settings.ninerouter_instance_api_key(instance_id):
            try:
                validate_9router_base_url(origin)
                configured = True
            except SSRFValidationError:
                configured = False
        providers.append(
            ProviderInfo(
                id=instance_id,
                name=f"9Router · {instance_id}",
                configured=configured,
                auth_required=True,
            )
        )
    return providers
