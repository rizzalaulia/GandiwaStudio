"""Private temporary storage for hostile SVG preflight bytes and PNG previews."""

from __future__ import annotations

import os
import stat
import time
import uuid
from contextlib import suppress
from pathlib import Path

_MAX_PREVIEW_BYTES = 64 * 1024 * 1024


class SvgQuarantine:
    """Store untrusted SVG bytes privately and expose only short-lived PNG previews."""

    def __init__(self, root: Path, *, ttl_seconds: int) -> None:
        if ttl_seconds < 1:
            raise ValueError("SVG quarantine TTL must be positive")
        self._root = root
        self._ttl_seconds = ttl_seconds

    def store_failed_source(self, source: bytes) -> None:
        """Keep a rejected source briefly for cleanup/audit without returning an access token."""
        self._write_private(f"{uuid.uuid4().hex}.svg", source)

    def store_preview_png(self, preview_png: bytes) -> str:
        """Store a raster preview and return its opaque filename token only."""
        token = uuid.uuid4().hex
        self._write_private(f"{token}.png", preview_png)
        return token

    def read_preview_png(self, token: str) -> bytes | None:
        """Read a non-expired preview through no-follow directory and file descriptors."""
        if not _is_opaque_token(token):
            return None
        try:
            directory_fd = self._open_private_directory()
        except OSError:
            return None
        try:
            try:
                descriptor = os.open(
                    f"{token}.png",
                    os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW,
                    dir_fd=directory_fd,
                )
            except OSError:
                return None
            try:
                metadata = os.fstat(descriptor)
                if not stat.S_ISREG(metadata.st_mode):
                    return None
                if metadata.st_mtime <= time.time() - self._ttl_seconds:
                    _unlink_if_unchanged(f"{token}.png", metadata, directory_fd)
                    return None
                preview_png = bytearray()
                while len(preview_png) <= _MAX_PREVIEW_BYTES:
                    chunk = os.read(descriptor, _MAX_PREVIEW_BYTES + 1 - len(preview_png))
                    if not chunk:
                        break
                    preview_png.extend(chunk)
                if len(preview_png) > _MAX_PREVIEW_BYTES:
                    return None
                return bytes(preview_png)
            finally:
                os.close(descriptor)
        finally:
            os.close(directory_fd)

    def cleanup_expired(self, *, now: float | None = None) -> int:
        """Delete expired regular quarantine files without following paths or symlinks."""
        try:
            directory_fd = self._open_private_directory()
        except OSError:
            return 0
        try:
            cutoff = (time.time() if now is None else now) - self._ttl_seconds
            removed = 0
            for filename in os.listdir(directory_fd):
                if not filename.endswith((".png", ".svg")):
                    continue
                try:
                    metadata = os.stat(filename, dir_fd=directory_fd, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_mtime > cutoff:
                    continue
                if _unlink_if_unchanged(filename, metadata, directory_fd):
                    removed += 1
            return removed
        finally:
            os.close(directory_fd)

    def _write_private(self, filename: str, payload: bytes) -> None:
        directory_fd = self._open_private_directory(create=True)
        try:
            descriptor = os.open(
                filename,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=directory_fd,
            )
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(payload)
            except BaseException:
                with suppress(FileNotFoundError):
                    os.unlink(filename, dir_fd=directory_fd)
                raise
        finally:
            os.close(directory_fd)

    def _open_private_directory(self, *, create: bool = False) -> int:
        """Open the configured root only after no-follow traversal from filesystem root."""
        if not self._root.is_absolute():
            raise OSError("SVG quarantine root must be absolute")

        parts = self._root.parts[1:]
        if not parts:
            raise OSError("SVG quarantine root must not be filesystem root")
        descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            for component in parts:
                try:
                    next_descriptor = os.open(
                        component,
                        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                        dir_fd=descriptor,
                    )
                except FileNotFoundError:
                    if not create:
                        raise
                    with suppress(FileExistsError):
                        os.mkdir(component, mode=0o700, dir_fd=descriptor)
                    next_descriptor = os.open(
                        component,
                        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                        dir_fd=descriptor,
                    )
                os.close(descriptor)
                descriptor = next_descriptor
            metadata = os.fstat(descriptor)
            if not stat.S_ISDIR(metadata.st_mode):
                raise OSError("SVG quarantine root must be a directory")
            os.fchmod(descriptor, 0o700)
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise


def _is_opaque_token(token: str) -> bool:
    if len(token) != 32:
        return False
    try:
        int(token, 16)
    except ValueError:
        return False
    return True


def _unlink_if_unchanged(filename: str, expected: os.stat_result, directory_fd: int) -> bool:
    """Atomically move a file within the verified directory, then unlink only its inode."""
    tombstone = f".{uuid.uuid4().hex}{Path(filename).suffix}"
    try:
        os.replace(filename, tombstone, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
    except FileNotFoundError:
        return False
    try:
        current = os.stat(tombstone, dir_fd=directory_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(current.st_mode)
            or current.st_dev != expected.st_dev
            or current.st_ino != expected.st_ino
            or current.st_mtime_ns != expected.st_mtime_ns
            or current.st_size != expected.st_size
        ):
            return False
        os.unlink(tombstone, dir_fd=directory_fd)
    except FileNotFoundError:
        return False
    return True
