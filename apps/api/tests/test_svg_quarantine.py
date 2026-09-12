"""Temporary, private storage for SVG preflight source and raster previews."""

from __future__ import annotations

import os
from pathlib import Path

import gandiwa_api.svg_quarantine as svg_quarantine_module
from gandiwa_api.svg_quarantine import SvgQuarantine


def test_quarantine_keeps_source_private_and_serves_only_png_preview(tmp_path: Path) -> None:
    root = tmp_path / "svg-quarantine"
    quarantine = SvgQuarantine(root, ttl_seconds=60)

    quarantine.store_failed_source(b"<svg>hostile</svg>")
    token = quarantine.store_preview_png(b"\x89PNG\r\n\x1a\npreview")

    assert quarantine.read_preview_png(token) == b"\x89PNG\r\n\x1a\npreview"
    assert quarantine.read_preview_png("../../hostile") is None
    assert sorted(path.suffix for path in root.iterdir()) == [".png", ".svg"]
    assert all(path.stat().st_mode & 0o077 == 0 for path in root.iterdir())


def test_quarantine_refuses_a_symlinked_root_directory(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "svg-quarantine"
    root.symlink_to(outside, target_is_directory=True)
    quarantine = SvgQuarantine(root, ttl_seconds=60)

    assert quarantine.read_preview_png("0" * 32) is None
    assert quarantine.cleanup_expired() == 0
    try:
        quarantine.store_preview_png(b"\\x89PNG\\r\\n\\x1a\\npreview")
    except OSError:
        pass
    else:
        raise AssertionError("symlinked quarantine root must be rejected")
    assert list(outside.iterdir()) == []


def test_quarantine_refuses_a_symlinked_ancestor_directory(tmp_path: Path) -> None:
    outside_parent = tmp_path / "outside-parent"
    outside_root = outside_parent / "svg-quarantine"
    outside_root.mkdir(parents=True)
    configured_parent = tmp_path / "configured-parent"
    configured_parent.symlink_to(outside_parent, target_is_directory=True)
    quarantine = SvgQuarantine(configured_parent / "svg-quarantine", ttl_seconds=60)
    victim = outside_root / ("0" * 32 + ".svg")
    victim.write_bytes(b"must-not-be-touched")
    os.utime(victim, (1_000_000_000, 1_000_000_000))

    assert quarantine.read_preview_png("0" * 32) is None
    assert quarantine.cleanup_expired(now=1_000_000_061) == 0
    try:
        quarantine.store_preview_png(b"\\x89PNG\\r\\n\\x1a\\npreview")
    except OSError:
        pass
    else:
        raise AssertionError("symlinked quarantine ancestor must be rejected")
    assert victim.read_bytes() == b"must-not-be-touched"


def test_quarantine_refuses_a_preview_path_replaced_by_a_symlink(tmp_path: Path) -> None:
    root = tmp_path / "svg-quarantine"
    quarantine = SvgQuarantine(root, ttl_seconds=60)
    token = quarantine.store_preview_png(b"\x89PNG\r\n\x1a\npreview")
    preview = root / f"{token}.png"
    preview.unlink()
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"must-not-be-read")
    preview.symlink_to(outside)

    assert quarantine.read_preview_png(token) is None
    assert outside.read_bytes() == b"must-not-be-read"


def test_expired_preview_lookup_does_not_delete_a_file_replaced_before_cleanup(
    tmp_path: Path, monkeypatch
) -> None:
    root = tmp_path / "svg-quarantine"
    quarantine = SvgQuarantine(root, ttl_seconds=60)
    token = quarantine.store_preview_png(b"\x89PNG\r\n\x1a\nexpired")
    preview = root / f"{token}.png"
    os.utime(preview, (1_000_000_000, 1_000_000_000))
    replacement = b"\x89PNG\r\n\x1a\nreplacement"
    real_time = svg_quarantine_module.time.time

    def replace_then_return_now() -> float:
        preview.unlink()
        preview.write_bytes(replacement)
        return real_time()

    monkeypatch.setattr(svg_quarantine_module.time, "time", replace_then_return_now)

    assert quarantine.read_preview_png(token) is None
    assert not preview.exists()
    assert any(path.read_bytes() == replacement for path in root.iterdir())


def test_periodic_cleanup_does_not_delete_a_file_replaced_after_expiry_check(
    tmp_path: Path, monkeypatch
) -> None:
    root = tmp_path / "svg-quarantine"
    quarantine = SvgQuarantine(root, ttl_seconds=60)
    token = quarantine.store_preview_png(b"\x89PNG\r\n\x1a\nexpired")
    preview = root / f"{token}.png"
    os.utime(preview, (1_000_000_000, 1_000_000_000))
    replacement = b"\x89PNG\r\n\x1a\nreplacement"
    real_unlink_if_unchanged = svg_quarantine_module._unlink_if_unchanged

    def replace_then_unlink_if_unchanged(
        filename: str, expected: os.stat_result, directory_fd: int
    ) -> bool:
        os.unlink(filename, dir_fd=directory_fd)
        descriptor = os.open(
            filename,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
            dir_fd=directory_fd,
        )
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(replacement)
        return real_unlink_if_unchanged(filename, expected, directory_fd)

    monkeypatch.setattr(
        svg_quarantine_module, "_unlink_if_unchanged", replace_then_unlink_if_unchanged
    )

    assert quarantine.cleanup_expired(now=1_000_000_061) == 0
    assert not preview.exists()
    assert any(path.read_bytes() == replacement for path in root.iterdir())


def test_quarantine_does_not_resolve_expired_preview(tmp_path: Path) -> None:
    root = tmp_path / "svg-quarantine"
    quarantine = SvgQuarantine(root, ttl_seconds=60)
    token = quarantine.store_preview_png(b"\x89PNG\r\n\x1a\npreview")
    preview = root / f"{token}.png"
    os.utime(preview, (1_000_000_000, 1_000_000_000))

    assert quarantine.read_preview_png(token) is None
    assert not preview.exists()


def test_quarantine_cleanup_removes_only_expired_regular_files(tmp_path: Path) -> None:
    root = tmp_path / "svg-quarantine"
    quarantine = SvgQuarantine(root, ttl_seconds=60)
    preview_token = quarantine.store_preview_png(b"\x89PNG\r\n\x1a\npreview")
    quarantine.store_failed_source(b"<svg>failed</svg>")
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"do not delete")
    escaped_link = root / "escaped.png"
    escaped_link.symlink_to(outside)
    expired = 1_000_000_000
    for path in root.iterdir():
        if path.is_symlink():
            continue
        os.utime(path, (expired, expired))

    removed = quarantine.cleanup_expired(now=expired + 61)

    assert removed == 2
    assert quarantine.read_preview_png(preview_token) is None
    assert outside.read_bytes() == b"do not delete"
    assert escaped_link.is_symlink()
