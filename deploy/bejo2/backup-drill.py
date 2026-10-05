#!/usr/bin/env python3
"""Encrypted, staged backup/restore/rollback drill for Gandiwa on bejo2.

This tool never stops services itself.  Operators stop API/worker, then pass the
explicit ``--services-stopped`` acknowledgement to the destructive swap command.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import io
import json
import os
import shutil
import sqlite3
import stat
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

FORMAT = "gandiwa-backup-v1"
AAD = FORMAT.encode("ascii")
ACTIVE_JOB_STATES = ("running", "waiting_provider", "processing")


class DrillError(RuntimeError):
    """Raised before an unsafe backup, restore, or rollback action."""


@dataclass(frozen=True)
class BackupBundle:
    archive_path: Path
    manifest_path: Path
    database_sha256: str


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _private_mode(path: Path) -> None:
    os.chmod(path, 0o600)


def _write_new_private(path: Path, value: bytes) -> None:
    """Create an owner-only file without a check-then-create overwrite race."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
    except Exception:
        path.unlink(missing_ok=True)
        raise


def _require_private_key(key_file: Path, *, required_uid: int | None = None) -> bytes:
    """Read one regular key without following a symlink; CLI requires root ownership."""
    try:
        details = key_file.lstat()
        if not stat.S_ISREG(details.st_mode):
            raise DrillError("backup key must be a regular file, not a symlink")
        if required_uid is not None and details.st_uid != required_uid:
            raise DrillError("backup key has an unexpected owner")
        if stat.S_IMODE(details.st_mode) & 0o077:
            raise DrillError("backup key must not be group/world accessible")
        descriptor = os.open(key_file, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode) or opened.st_ino != details.st_ino:
                raise DrillError("backup key changed while being opened")
            key = os.read(descriptor, 33)
        finally:
            os.close(descriptor)
    except OSError as exc:
        raise DrillError(f"cannot read backup key: {exc}") from exc
    if len(key) != 32:
        raise DrillError("backup key must contain exactly 32 bytes")
    return key


def _online_sqlite_backup(database: Path, destination: Path) -> None:
    if not database.is_file():
        raise DrillError(f"database is missing: {database}")
    source = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    target = sqlite3.connect(destination)
    try:
        source.backup(target)
        target.execute("PRAGMA foreign_keys=ON")
        target.commit()
    except sqlite3.Error as exc:
        raise DrillError(f"SQLite online backup failed: {exc}") from exc
    finally:
        target.close()
        source.close()


def _tar_add_file(archive: tarfile.TarFile, path: Path, arcname: str) -> None:
    info = archive.gettarinfo(str(path), arcname=arcname)
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    with path.open("rb") as handle:
        archive.addfile(info, handle)


def _build_plaintext_archive(database: Path, artifacts: Path) -> tuple[bytes, str, list[dict[str, str]]]:
    if not artifacts.is_dir():
        raise DrillError(f"artifact directory is missing: {artifacts}")
    with tempfile.TemporaryDirectory(prefix="gandiwa-backup-") as temporary:
        copied_database = Path(temporary) / "gandiwa.sqlite3"
        _online_sqlite_backup(database, copied_database)
        database_sha256 = _sha256_file(copied_database)
        output = io.BytesIO()
        artifact_files: list[dict[str, str]] = []
        with tarfile.open(fileobj=output, mode="w") as archive:
            _tar_add_file(archive, copied_database, "data/gandiwa.sqlite3")
            for path in sorted(artifacts.rglob("*")):
                if path.is_symlink():
                    raise DrillError(f"artifact symlink is not backup-safe: {path}")
                if path.is_file():
                    relative = path.relative_to(artifacts).as_posix()
                    _tar_add_file(archive, path, str(Path("artifacts") / relative))
                    artifact_files.append({"path": relative, "sha256": _sha256_file(path)})
        return output.getvalue(), database_sha256, artifact_files


def create_backup(
    *,
    database: Path,
    artifacts: Path,
    destination: Path,
    key_file: Path,
    release_id: str,
    retention_hours: int,
    key_owner_uid: int | None = None,
) -> BackupBundle:
    """Create an encrypted portable bundle using SQLite's online backup API."""
    if not release_id or "\n" in release_id:
        raise DrillError("release_id must be a non-empty single line")
    if retention_hours < 1:
        raise DrillError("retention_hours must be positive")
    key = _require_private_key(key_file, required_uid=key_owner_uid)
    destination.mkdir(parents=True, exist_ok=True)
    if not destination.is_dir():
        raise DrillError("backup destination is not a directory")
    os.chmod(destination, 0o700)
    plaintext, database_sha256, artifact_files = _build_plaintext_archive(database, artifacts)
    nonce = os.urandom(12)
    encrypted = AESGCM(key).encrypt(nonce, plaintext, AAD)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    archive_path = destination / f"gandiwa-{stamp}.gandiwa"
    manifest_path = destination / f"gandiwa-{stamp}.manifest.json"
    manifest = {
        "format": FORMAT,
        "created_at": datetime.now(UTC).isoformat(),
        "release_id": release_id,
        "retention_hours": retention_hours,
        "encryption": {"algorithm": "AES-256-GCM", "nonce_b64": base64.b64encode(nonce).decode("ascii")},
        "database": {"path": "data/gandiwa.sqlite3", "sha256": database_sha256},
        "artifacts": {"path": "artifacts", "files": artifact_files},
        "archive_sha256": _sha256_bytes(encrypted),
    }
    wrote_archive = False
    try:
        _write_new_private(archive_path, encrypted)
        wrote_archive = True
        _write_new_private(
            manifest_path,
            (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        )
    except Exception as exc:
        if wrote_archive:
            archive_path.unlink(missing_ok=True)
        if isinstance(exc, FileExistsError):
            raise DrillError("refusing to overwrite existing backup") from exc
        raise DrillError("cannot write complete backup bundle") from exc
    return BackupBundle(archive_path, manifest_path, database_sha256)


def _load_manifest(path: Path) -> dict[str, Any]:
    try:
        loaded: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DrillError(f"invalid backup manifest: {exc}") from exc
    if not isinstance(loaded, dict) or loaded.get("format") != FORMAT:
        raise DrillError("unsupported backup manifest")
    return loaded


def _safe_extract(plaintext: bytes, destination: Path) -> None:
    with tarfile.open(fileobj=io.BytesIO(plaintext), mode="r:") as archive:
        members = archive.getmembers()
        for member in members:
            candidate = Path(member.name)
            if member.issym() or member.islnk() or candidate.is_absolute() or ".." in candidate.parts:
                raise DrillError("backup archive contains unsafe path")
        archive.extractall(destination, members=members, filter="data")


def _open_directory_nofollow(path: Path) -> int:
    """Open every absolute path component without allowing a symlink hop."""
    if not path.is_absolute():
        raise DrillError("staging path must be absolute for no-follow verification")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:]:
            next_descriptor = os.open(
                component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor
            )
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _verify_private_tree_nofollow(root: Path, uid: int, gid: int) -> None:
    """Walk staging from directory descriptors and reject every symlink before swap."""
    def walk(directory_fd: int, display: Path) -> None:
        details = os.fstat(directory_fd)
        if details.st_uid != uid or details.st_gid != gid:
            raise DrillError(f"ownership mismatch: {display}")
        with os.scandir(directory_fd) as entries:
            for entry in entries:
                child = display / entry.name
                try:
                    child_fd = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
                except OSError as exc:
                    raise DrillError(f"staging tree contains unsafe symlink or unreadable path: {child}") from exc
                try:
                    child_details = os.fstat(child_fd)
                    if child_details.st_uid != uid or child_details.st_gid != gid:
                        raise DrillError(f"ownership mismatch: {child}")
                    if stat.S_ISDIR(child_details.st_mode):
                        walk(child_fd, child)
                    elif not stat.S_ISREG(child_details.st_mode):
                        raise DrillError(f"staging tree contains non-regular path: {child}")
                finally:
                    os.close(child_fd)

    try:
        root_fd = _open_directory_nofollow(root)
    except OSError as exc:
        raise DrillError(f"staging tree contains unsafe symlink or unreadable path: {root}") from exc
    try:
        walk(root_fd, root)
    finally:
        os.close(root_fd)


def _verify_artifacts(artifacts: Path, metadata: dict[str, Any]) -> list[dict[str, str]]:
    declared = metadata.get("artifacts", {}).get("files")
    if not isinstance(declared, list):
        raise DrillError("backup manifest lacks artifact checksums")
    expected: dict[str, str] = {}
    for entry in declared:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not isinstance(entry.get("sha256"), str):
            raise DrillError("backup manifest has invalid artifact checksum entry")
        relative = Path(entry["path"])
        if relative.is_absolute() or ".." in relative.parts or entry["path"] in expected:
            raise DrillError("backup manifest has unsafe artifact path")
        expected[entry["path"]] = entry["sha256"]
    actual: dict[str, str] = {}
    for path in artifacts.rglob("*"):
        if path.is_symlink():
            raise DrillError("restored artifacts contain a symlink")
        if path.is_file():
            actual[path.relative_to(artifacts).as_posix()] = _sha256_file(path)
    if actual != expected:
        raise DrillError("restored artifacts do not match manifest checksums")
    return [{"path": path, "sha256": checksum} for path, checksum in sorted(actual.items())]


def _verified_revision(database: Path, expected_revision: str | None) -> dict[str, str | None]:
    """Read Alembic state from staging; never migrate or downgrade implicitly."""
    connection = sqlite3.connect(database)
    try:
        available = {
            row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        if "alembic_version" not in available:
            raise DrillError("staging database has no alembic_version table")
        row = connection.execute("SELECT version_num FROM alembic_version").fetchone()
    except sqlite3.Error as exc:
        raise DrillError(f"cannot verify staged migration revision: {exc}") from exc
    finally:
        connection.close()
    revision = str(row[0]) if row is not None else None
    if expected_revision is not None and revision != expected_revision:
        raise DrillError(
            f"staging revision {revision!r} does not match expected revision {expected_revision!r}; "
            "run the target release migration against staging, then verify again"
        )
    return {"revision": revision, "expected": expected_revision}


def _reconcile_active_jobs(database: Path) -> list[str]:
    connection = sqlite3.connect(database)
    try:
        available = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "generation_job" not in available:
            return []
        placeholders = ",".join("?" for _ in ACTIVE_JOB_STATES)
        active_rows = list(
            connection.execute(
                f"SELECT id, status, remote_job_id FROM generation_job "
                f"WHERE status IN ({placeholders}) ORDER BY id",
                ACTIVE_JOB_STATES,
            )
        )
        missing_remote = [
            row[0]
            for row in active_rows
            if row[1] in {"waiting_provider", "processing"} and not row[2]
        ]
        if missing_remote:
            raise DrillError(
                "active provider-dispatch job lacks remote_job_id: " + ", ".join(missing_remote)
            )
        rows = [row[0] for row in active_rows]
        if rows:
            connection.execute(
                f"UPDATE generation_job SET status='needs_review', lease_owner=NULL, "
                f"lease_expires_at=NULL, heartbeat_at=NULL, completed_at=COALESCE(completed_at, datetime('now')), "
                f"error_code='RESTORE_REQUIRES_PROVIDER_RECONCILIATION' "
                f"WHERE status IN ({placeholders})",
                ACTIVE_JOB_STATES,
            )
            connection.commit()
        return rows
    except sqlite3.Error as exc:
        raise DrillError(f"queue reconciliation failed: {exc}") from exc
    finally:
        connection.close()


def _receipt_mac(key: bytes, receipt: dict[str, Any]) -> str:
    canonical = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hmac.new(key, b"gandiwa-restore-receipt-v1\0" + canonical, hashlib.sha256).hexdigest()


def _integrity(database: Path) -> dict[str, str]:
    connection = sqlite3.connect(database)
    try:
        quick_check = connection.execute("PRAGMA quick_check").fetchone()[0]
        integrity_check = connection.execute("PRAGMA integrity_check").fetchone()[0]
    except sqlite3.Error as exc:
        raise DrillError(f"SQLite integrity check failed: {exc}") from exc
    finally:
        connection.close()
    if quick_check != "ok" or integrity_check != "ok":
        raise DrillError("SQLite integrity check did not return ok")
    return {"quick_check": quick_check, "integrity_check": integrity_check}


def restore_verify(
    *,
    archive: Path,
    manifest: Path,
    key_file: Path,
    staging: Path,
    expected_uid: int,
    expected_gid: int,
    expected_release_id: str,
    expected_revision: str | None = None,
    key_owner_uid: int | None = None,
) -> dict[str, Any]:
    """Decrypt to a new staging directory and validate before any live swap."""
    if staging.exists():
        raise DrillError("restore staging path must not already exist")
    metadata = _load_manifest(manifest)
    if metadata.get("release_id") != expected_release_id:
        raise DrillError("backup release_id does not match expected release")
    if _sha256_file(archive) != metadata.get("archive_sha256"):
        raise DrillError("archive checksum does not match manifest")
    try:
        nonce = base64.b64decode(metadata["encryption"]["nonce_b64"], validate=True)
        receipt_key = _require_private_key(key_file, required_uid=key_owner_uid)
        plaintext = AESGCM(receipt_key).decrypt(nonce, archive.read_bytes(), AAD)
    except (KeyError, ValueError, OSError) as exc:
        raise DrillError(f"cannot decrypt backup: {exc}") from exc
    except Exception as exc:
        raise DrillError("cannot decrypt backup") from exc
    try:
        staging.mkdir(mode=0o750)
        _safe_extract(plaintext, staging)
        database = staging / "data" / "gandiwa.sqlite3"
        artifacts = staging / "artifacts"
        if not database.is_file() or not artifacts.is_dir():
            raise DrillError("backup lacks required database or artifact paths")
        if _sha256_file(database) != metadata.get("database", {}).get("sha256"):
            raise DrillError("database checksum does not match manifest")
        artifact_files = _verify_artifacts(artifacts, metadata)
        for path in [staging, *staging.rglob("*")]:
            os.chown(path, expected_uid, expected_gid)
        _verify_private_tree_nofollow(staging, expected_uid, expected_gid)
        migration = _verified_revision(database, expected_revision)
        needs_review = _reconcile_active_jobs(database)
        report = {
            "format": "gandiwa-restore-receipt-v1",
            "verified_at": datetime.now(UTC).isoformat(),
            "release_id": metadata["release_id"],
            "migration": migration,
            "integrity": _integrity(database),
            "database_sha256": _sha256_file(database),
            "artifacts": artifact_files,
            "reconciliation": {"needs_review": needs_review, "redispatched": []},
        }
        sealed = {"receipt": report, "hmac_sha256": _receipt_mac(receipt_key, report)}
        receipt_path = staging / ".gandiwa-restore-verified.json"
        _write_new_private(
            receipt_path,
            (json.dumps(sealed, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        )
        return report
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def _verify_rollback_receipt(
    *,
    staging: Path,
    database: Path,
    artifacts: Path,
    key_file: Path,
    expected_uid: int,
    expected_gid: int,
    expected_release_id: str,
    expected_revision: str,
    key_owner_uid: int | None,
) -> dict[str, Any]:
    receipt_path = staging / ".gandiwa-restore-verified.json"
    try:
        details = receipt_path.lstat()
        if not stat.S_ISREG(details.st_mode) or stat.S_IMODE(details.st_mode) & 0o077:
            raise DrillError("restore receipt is not a private regular file")
        if details.st_uid != expected_uid or details.st_gid != expected_gid:
            raise DrillError("restore receipt ownership does not match staging")
        sealed: Any = json.loads(receipt_path.read_text(encoding="utf-8"))
        report = sealed["receipt"]
        signature = sealed["hmac_sha256"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise DrillError(f"invalid restore receipt: {exc}") from exc
    if not isinstance(report, dict) or not isinstance(signature, str):
        raise DrillError("invalid restore receipt")
    key = _require_private_key(key_file, required_uid=key_owner_uid)
    if not hmac.compare_digest(signature, _receipt_mac(key, report)):
        raise DrillError("restore receipt signature is invalid")
    if report.get("format") != "gandiwa-restore-receipt-v1":
        raise DrillError("restore receipt format is invalid")
    if report.get("release_id") != expected_release_id:
        raise DrillError("restore receipt release_id does not match rollback target")
    migration = report.get("migration")
    if not isinstance(migration, dict) or migration.get("revision") != expected_revision:
        raise DrillError("restore receipt migration revision does not match rollback target")
    if _sha256_file(database) != report.get("database_sha256"):
        raise DrillError("staging database changed after restore verification")
    try:
        current_artifacts = _verify_artifacts(
            artifacts, {"artifacts": {"files": report.get("artifacts")}}
        )
    except DrillError as exc:
        raise DrillError("staging artifacts changed after restore verification") from exc
    if current_artifacts != report.get("artifacts"):
        raise DrillError("staging artifacts changed after restore verification")
    if _integrity(database) != report.get("integrity"):
        raise DrillError("staging integrity changed after restore verification")
    return report


def apply_rollback(
    *, staging: Path,
    data_dir: Path,
    artifacts_dir: Path,
    expected_uid: int,
    expected_gid: int,
    key_file: Path,
    expected_release_id: str,
    expected_revision: str,
    key_owner_uid: int | None = None,
) -> dict[str, Any]:
    """Replace durable paths only with an authenticated, unchanged staging restore."""
    source_data = staging / "data"
    source_artifacts = staging / "artifacts"
    if not source_data.is_dir() or not source_artifacts.is_dir():
        raise DrillError("rollback requires a verified restore staging directory")
    _verify_private_tree_nofollow(staging, expected_uid, expected_gid)
    verified = _verify_rollback_receipt(
        staging=staging,
        database=source_data / "gandiwa.sqlite3",
        artifacts=source_artifacts,
        key_file=key_file,
        expected_uid=expected_uid,
        expected_gid=expected_gid,
        expected_release_id=expected_release_id,
        expected_revision=expected_revision,
        key_owner_uid=key_owner_uid,
    )
    parent = data_dir.parent
    if parent != artifacts_dir.parent:
        raise DrillError("data and artifact directories must share a parent for rollback")
    if not data_dir.is_dir() or not artifacts_dir.is_dir():
        raise DrillError("live data and artifact directories must both exist before rollback")
    try:
        target_device = parent.stat().st_dev
        source_data_device = source_data.stat().st_dev
        source_artifacts_device = source_artifacts.stat().st_dev
    except OSError as exc:
        raise DrillError(f"cannot preflight rollback filesystem: {exc}") from exc
    if source_data_device != target_device or source_artifacts_device != target_device:
        raise DrillError("verified staging must be on the same filesystem as /srv/gandiwa")
    token = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    previous_data = parent / f"{data_dir.name}.pre-rollback-{token}"
    previous_artifacts = parent / f"{artifacts_dir.name}.pre-rollback-{token}"
    if any(path.exists() for path in (previous_data, previous_artifacts)):
        raise DrillError("rollback retention destination already exists")
    steps = [
        (data_dir, previous_data),
        (artifacts_dir, previous_artifacts),
        (source_data, data_dir),
        (source_artifacts, artifacts_dir),
    ]
    completed: list[tuple[Path, Path]] = []
    try:
        for source, target in steps:
            os.replace(source, target)
            completed.append((source, target))
    except OSError as exc:
        compensation_errors: list[str] = []
        for source, target in reversed(completed):
            try:
                os.replace(target, source)
            except OSError as compensation_error:
                compensation_errors.append(str(compensation_error))
        if compensation_errors:
            raise DrillError(
                "rollback replacement failed and compensation is incomplete; services must remain stopped: "
                + "; ".join(compensation_errors)
            ) from exc
        raise DrillError("rollback replacement failed; original live paths were restored") from exc
    receipt = {
        "applied": True,
        "release_id": verified["release_id"],
        "revision": verified["migration"]["revision"],
        "previous_data": str(previous_data),
        "previous_artifacts": str(previous_artifacts),
        "restored_data": str(data_dir),
        "restored_artifacts": str(artifacts_dir),
    }
    return receipt


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    backup = commands.add_parser("backup")
    backup.add_argument("--database", type=Path, required=True)
    backup.add_argument("--artifacts", type=Path, required=True)
    backup.add_argument("--destination", type=Path, required=True, help="encrypted off-host destination")
    backup.add_argument("--key-file", type=Path, required=True)
    backup.add_argument("--release-id", required=True)
    backup.add_argument("--retention-hours", type=int, required=True)
    restore = commands.add_parser("restore-verify")
    restore.add_argument("--archive", type=Path, required=True)
    restore.add_argument("--manifest", type=Path, required=True)
    restore.add_argument("--key-file", type=Path, required=True)
    restore.add_argument("--staging", type=Path, required=True)
    restore.add_argument("--uid", type=int, default=10001)
    restore.add_argument("--gid", type=int, default=10001)
    restore.add_argument("--expected-release-id", required=True)
    restore.add_argument("--expected-revision", required=True)
    rollback = commands.add_parser("rollback-apply")
    rollback.add_argument("--staging", type=Path, required=True)
    rollback.add_argument("--data-dir", type=Path, required=True)
    rollback.add_argument("--artifacts-dir", type=Path, required=True)
    rollback.add_argument("--uid", type=int, default=10001)
    rollback.add_argument("--gid", type=int, default=10001)
    rollback.add_argument("--key-file", type=Path, required=True)
    rollback.add_argument("--expected-release-id", required=True)
    rollback.add_argument("--expected-revision", required=True)
    rollback.add_argument("--services-stopped", action="store_true")
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        values = vars(args).copy()
        command = values.pop("command")
        if command == "backup":
            values["key_owner_uid"] = 0
            result: Any = create_backup(**values)
            print(json.dumps({"archive": str(result.archive_path), "manifest": str(result.manifest_path)}))
        elif command == "restore-verify":
            values["key_owner_uid"] = 0
            values["expected_uid"] = values.pop("uid")
            values["expected_gid"] = values.pop("gid")
            print(json.dumps(restore_verify(**values), sort_keys=True))
        else:
            if not args.services_stopped:
                raise DrillError("rollback-apply requires --services-stopped after API/worker are stopped")
            values.pop("services_stopped")
            values["key_owner_uid"] = 0
            values["expected_uid"] = values.pop("uid")
            values["expected_gid"] = values.pop("gid")
            print(json.dumps(apply_rollback(**values), sort_keys=True))
    except DrillError as exc:
        print(f"backup drill failed: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
