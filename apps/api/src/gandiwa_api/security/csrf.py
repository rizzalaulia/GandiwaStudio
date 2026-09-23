"""Session and CSRF protection boundary for state-changing endpoints."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from collections.abc import Callable
from typing import Any

from fastapi import Request, Response, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from gandiwa_api.config import Settings

CSRF_COOKIE_NAME = "gandiwa_csrf"
SESSION_COOKIE_NAME = "gandiwa_session"
CSRF_HEADER_NAME = "x-csrf-token"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}


def generate_csrf_token(secret: str) -> str:
    """Generate a high-entropy random token signed with the application secret."""
    raw_token = secrets.token_hex(32)
    signature = hmac.new(
        secret.encode("utf-8"),
        raw_token.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{raw_token}.{signature}"


def verify_csrf_token(token: str, secret: str) -> bool:
    """Verify that a CSRF token has not been tampered with and was signed by secret."""
    parts = token.split(".")
    if len(parts) != 2:
        return False
    raw_token, signature = parts
    expected_signature = hmac.new(
        secret.encode("utf-8"),
        raw_token.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(signature, expected_signature)


def set_csrf_cookie(
    response: Response,
    token: str,
    *,
    secure: bool = False,
) -> None:
    """Set the client-readable CSRF cookie used for double-submit header validation."""
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=token,
        httponly=False,  # Client JS must read this to supply X-CSRF-Token header
        samesite="lax",
        secure=secure,
        path="/",
    )


def sign_session_id(session_id: str, secret: str) -> str:
    """Return an opaque signed session value suitable for an HttpOnly cookie."""
    signature = hmac.new(
        secret.encode("utf-8"), session_id.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return f"{session_id}.{signature}"


def session_id_from_token(token: str | None, secret: str) -> str | None:
    """Return the signed session identity, or None without exposing parse errors."""
    if not token or "." not in token:
        return None
    session_id, signature = token.rsplit(".", 1)
    if not session_id or not signature:
        return None
    expected = sign_session_id(session_id, secret).rsplit(".", 1)[1]
    return session_id if hmac.compare_digest(signature, expected) else None


def verify_session_token(token: str | None, secret: str) -> bool:
    """Verify an opaque session cookie; session issuance belongs to a future identity flow."""
    return session_id_from_token(token, secret) is not None


def set_session_cookie(
    response: Response,
    session_id: str,
    *,
    secret: str,
    secure: bool = False,
) -> None:
    """Set the HttpOnly, signed session cookie inaccessible to client scripts."""
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=sign_session_id(session_id, secret),
        httponly=True,
        samesite="lax",
        secure=secure,
        path="/",
    )


class CSRFProtectionMiddleware(BaseHTTPMiddleware):
    """Enforce CSRF protection on unsafe methods for API requests."""

    def __init__(
        self,
        app: Callable[..., Any],
        settings: Settings | None = None,
        exempt_paths: set[str] | None = None,
    ) -> None:
        super().__init__(app)
        # Live read, not an import-time snapshot: tests (and uvicorn
        # --reload) re-read SESSION_SECRET from the env per request;
        # a frozen Settings() here makes tokens signed with the live
        # secret fail verification (403 cascades across the suite).
        self._frozen_settings = settings
        self.exempt_paths = exempt_paths or set()

    @property
    def settings(self) -> Settings:
        return self._frozen_settings or Settings()

    async def dispatch(self, request: Request, call_next: Callable[..., Any]) -> Response:
        normalized_path = request.url.path.rstrip("/") or "/"
        if (
            request.method in SAFE_METHODS
            or request.url.path in self.exempt_paths
            or normalized_path in self.exempt_paths
        ):
            return await call_next(request)  # type: ignore[no-any-return]

        # Check for CSRF header and cookie on state-changing methods
        # Issue #26 slice 2: the Settings UI ships the token as
        # X-Companion-Token; honour it as an exact alias of X-CSRF-Token.
        csrf_header = request.headers.get(CSRF_HEADER_NAME) or request.headers.get(
            "x-companion-token"
        )
        csrf_cookie = request.cookies.get(CSRF_COOKIE_NAME)

        if not csrf_header or not csrf_cookie:
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={"detail": "CSRF validation failed: missing token in header or cookie"},
            )

        if not hmac.compare_digest(csrf_header, csrf_cookie):
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={"detail": "CSRF validation failed: header and cookie tokens do not match"},
            )

        if not verify_csrf_token(csrf_header, self.settings.SESSION_SECRET):
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={"detail": "CSRF validation failed: invalid token signature"},
            )

        return await call_next(request)  # type: ignore[no-any-return]
