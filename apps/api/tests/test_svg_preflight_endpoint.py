"""HTTP boundary tests for hostile SVG preflight and raster-only preview delivery."""

from __future__ import annotations

import httpx
import pytest

from gandiwa_api.main import app
from gandiwa_api.security.csrf import CSRF_HEADER_NAME

pytestmark = pytest.mark.anyio

SAFE_SVG = b"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2">
<path d="M0 0 L2 2" fill="#123456"/>
</svg>"""
HOSTILE_SVG = b"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2">
<script>alert(1)</script>
</svg>"""


async def test_svg_preflight_requires_csrf_token() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/svg/preflight?content_type=vector",
            content=SAFE_SVG,
            headers={"Content-Type": "image/svg+xml", "X-Upload-Filename": "safe.svg"},
        )

    assert response.status_code == 403


async def test_svg_preflight_exposes_only_raster_preview_and_no_svg_bytes(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GANDIWA_SVG_QUARANTINE_DIR", str(tmp_path / "svg-quarantine"))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        csrf_response = await client.get("/api/v1/auth/csrf")
        token = csrf_response.json()["csrf_token"]
        response = await client.post(
            "/api/v1/svg/preflight?content_type=vector",
            content=SAFE_SVG,
            headers={
                "Content-Type": "image/svg+xml",
                "X-Upload-Filename": "safe.svg",
                CSRF_HEADER_NAME: token,
            },
        )

        assert response.status_code == 200
        payload = response.json()
        assert payload["verdict"] == "pass"
        assert payload["eligible_for_submission"] is True
        assert payload["findings"] == []
        assert set(payload) == {"verdict", "eligible_for_submission", "findings", "preview_url"}
        assert payload["preview_url"].startswith("/api/v1/svg/preflight/previews/")
        assert SAFE_SVG.decode("utf-8") not in response.text
        assert "sanitized_svg" not in payload
        assert "preview_png" not in payload

        preview = await client.get(payload["preview_url"])

    assert preview.status_code == 200
    assert preview.headers["content-type"] == "image/png"
    assert preview.headers["x-content-type-options"] == "nosniff"
    assert preview.headers["cache-control"] == "no-store"
    assert preview.content.startswith(b"\x89PNG\r\n\x1a\n")


async def test_cyclic_local_use_is_a_fail_closed_report_not_a_server_error(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = b"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2">
    <use id="first" href="#second"/><use id="second" href="#first"/>
    </svg>"""
    monkeypatch.setenv("GANDIWA_SVG_QUARANTINE_DIR", str(tmp_path / "svg-quarantine"))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        csrf_response = await client.get("/api/v1/auth/csrf")
        token = csrf_response.json()["csrf_token"]
        response = await client.post(
            "/api/v1/svg/preflight?content_type=vector",
            content=source,
            headers={
                "Content-Type": "image/svg+xml",
                "X-Upload-Filename": "cyclic.svg",
                CSRF_HEADER_NAME: token,
            },
        )

    assert response.status_code == 200
    assert response.json()["verdict"] == "fail"
    assert response.json()["findings"][0]["rule_id"] == "vector.valid-document"
    assert response.json()["preview_url"] is None


async def test_failed_svg_has_no_preview_url_and_is_quarantined_temporarily(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    quarantine_root = tmp_path / "svg-quarantine"
    monkeypatch.setenv("GANDIWA_SVG_QUARANTINE_DIR", str(quarantine_root))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        csrf_response = await client.get("/api/v1/auth/csrf")
        token = csrf_response.json()["csrf_token"]
        response = await client.post(
            "/api/v1/svg/preflight?content_type=vector",
            content=HOSTILE_SVG,
            headers={
                "Content-Type": "image/svg+xml",
                "X-Upload-Filename": "hostile.svg",
                CSRF_HEADER_NAME: token,
            },
        )

    assert response.status_code == 200
    assert response.json() == {
        "verdict": "fail",
        "eligible_for_submission": False,
        "findings": [
            {
                "rule_id": "vector.no-active-content",
                "message": "SVG contains active content that is not allowed before preview.",
            }
        ],
        "preview_url": None,
    }
    quarantined_sources = list(quarantine_root.glob("*.svg"))
    assert len(quarantined_sources) == 1
    assert quarantined_sources[0].read_bytes() == HOSTILE_SVG
