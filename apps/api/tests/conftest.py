"""Test isolation for the provider key store — Selendang (Issue #26, Slice 2).

Insiden 23 Sep: production mapping var/provider-keys.json dengan kunci asli
Guru terhapus dua kali saat sesi smoke, dan pytest tanpa isolation bisa liter
store asli. Autouse fixture ini memaksa SEMUA test ke store sementara per-test,
jadi var/ production tak pernah disentuh suite — positif pun untuk test yang
lupa mengisolasi.
"""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _isolate_provider_key_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = tmp_path / "provider-keys.json"
    monkeypatch.setenv("GANDIWA_PROVIDER_KEY_STORE", str(store))
