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


def set_session_cookie(
    response: Response,
    session_id: str,
    *,
    secure: bool = False,
) -> None:
    """Set the HttpOnly session cookie inaccessible to client scripts."""
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_id,
        httponly=True,  # Inaccessible to JS
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
        self.settings = settings or Settings()
        self.exempt_paths = exempt_paths or set()

    async def dispatch(self, request: Request, call_next: Callable[..., Any]) -> Response:
        if request.method in SAFE_METHODS or request.url.path in self.exempt_paths:
            return await call_next(request)  # type: ignore[no-any-return]

        # Check for CSRF header and cookie on state-changing methods
        csrf_header = request.headers.get(CSRF_HEADER_NAME)
        csrf_cookie = request.cookies.get(CSRF_COOKIE_NAME)

        if not csrf_header or not csrf_cookie:
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={"detail": "CSRF validation failed: missing token in header or cookie"},
            )

        if not hmac.compare_digest(csrf_header, csrf_cookie):
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={
                    "detail": "CSRF validation failed: header and cookie tokens do not match"
                },
            )

        if not verify_csrf_token(csrf_header, self.settings.SESSION_SECRET):
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={"detail": "CSRF validation failed: invalid token signature"},
            )

        return await call_next(request)  # type: ignore[no-any-return]
