"""Encrypted-at-rest provider API keys, private to the backend process."""

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
    try:
        with open(tmp, "xb") as handle:
            os.chmod(tmp, 0o600)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    finally:
        tmp.unlink(missing_ok=True)


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
            if not isinstance(envelope, dict) or envelope.get("version") != STORE_VERSION:
                return None
            keys = envelope.get("keys")
            sealed = keys.get(provider_id) if isinstance(keys, dict) else None
            if not isinstance(sealed, str):
                return None
            value: bytes = self._fernet.decrypt(sealed.encode("ascii"))
            text = value.decode("utf-8")
            return text or None
        except (OSError, ValueError, InvalidToken, UnicodeDecodeError):
            return None

    def set(self, provider_id: str, key: str) -> None:
        keys_map: dict[str, str] = {}
        if self._path.exists():
            try:
                existing = json.loads(self._path.read_text(encoding="utf-8"))
                keys = existing.get("keys") if isinstance(existing, dict) else None
                if (
                    isinstance(existing, dict)
                    and existing.get("version") == STORE_VERSION
                    and isinstance(keys, dict)
                    and all(isinstance(value, str) for value in keys.values())
                ):
                    keys_map.update(keys)
            except (OSError, ValueError):
                pass
        keys_map[provider_id] = self._fernet.encrypt(key.encode("utf-8")).decode("ascii")
        _atomic_write(
            self._path,
            json.dumps(
                {"version": STORE_VERSION, "keys": keys_map}, separators=(",", ":")
            ).encode(),
        )
