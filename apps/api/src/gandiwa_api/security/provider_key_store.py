"""Encrypted-at-rest provider API key store (Slice 2, Issue #26).

Keys live server-side only. At rest they are sealed with Fernet (AES-128-CBC
+ HMAC, from ``cryptography``) under a key derived from the session secret —
the same secret that already guards cookies, so no second root secret exists.
The plaintext key never appears in logs, responses, or the store file.

Restart-free by design: every read loads the current file, so another
process (or a later request lifecycle) observes saved keys immediately.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from gandiwa_api.config import Settings

STORE_VERSION = 1
_KDF_INFO = b"gandiwa-provider-key-store-v1"


def _fernet_for_secret(secret: str) -> Fernet:
    """Derive the store key from the session secret via HKDF-SHA256."""
    derived = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=_KDF_INFO,
    ).derive(secret.encode("utf-8"))
    return Fernet(base64.urlsafe_b64encode(derived))


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


class ProviderKeyStore:
    """Fernet-sealed provider key store; reads are authoritative per call."""

    def __init__(self, settings: Settings) -> None:
        self._path = settings.PROVIDER_KEY_STORE
        self._fernet = _fernet_for_secret(settings.SESSION_SECRET)

    def get(self, provider_id: str) -> str | None:
        if not self._path.exists():
            return None
        try:
            envelope = json.loads(self._path.read_text(encoding="utf-8"))
            if envelope.get("version") != STORE_VERSION:
                return None
            sealed = envelope.get("keys", {}).get(provider_id)
            if not isinstance(sealed, str):
                return None
            value: bytes = self._fernet.decrypt(sealed.encode("ascii"))
            text = value.decode("utf-8")
            return text or None
        except (OSError, ValueError, InvalidToken, UnicodeDecodeError):
            return None

    def set(self, provider_id: str, key: str) -> None:
        keys_map: dict[str, str] = {}
        envelope: dict[str, object] = {"version": STORE_VERSION, "keys": keys_map}
        if self._path.exists():
            try:
                existing = json.loads(self._path.read_text(encoding="utf-8"))
                keys = existing.get("keys") if isinstance(existing, dict) else None
                if (
                    isinstance(existing, dict)
                    and existing.get("version") == STORE_VERSION
                    and isinstance(keys, dict)
                    and all(isinstance(k, str) for k in keys.values())
                ):
                    keys_map.update(keys)
            except (OSError, ValueError):
                keys_map = {}
                envelope = {"version": STORE_VERSION, "keys": keys_map}
        sealed = self._fernet.encrypt(key.encode("utf-8")).decode("ascii")
        keys_map[provider_id] = sealed
        _atomic_write(self._path, json.dumps(envelope, separators=(",", ":")).encode("utf-8"))

    def remove(self, provider_id: str) -> None:
        if not self._path.exists():
            return
        try:
            envelope = json.loads(self._path.read_text(encoding="utf-8"))
            keys = envelope.get("keys", {})
        except (OSError, ValueError):
            return
        if provider_id in keys:
            keys.pop(provider_id, None)
            envelope["keys"] = keys
            _atomic_write(self._path, json.dumps(envelope, separators=(",", ":")).encode("utf-8"))
