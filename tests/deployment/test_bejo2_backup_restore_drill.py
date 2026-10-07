"""Executable contract for the Issue #31 bejo2 backup/restore drill."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import signal
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "deploy" / "bejo2" / "backup-drill.py"
SPEC = importlib.util.spec_from_file_location("backup_drill", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
backup_drill = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = backup_drill
SPEC.loader.exec_module(backup_drill)


class BackupRestoreDrillContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.database = self.root / "gandiwa.sqlite3"
        self.artifacts = self.root / "artifacts"
        self.artifacts.mkdir()
        self.offsite = self.root / "offsite"
        self.offsite.mkdir()
        self.key = self.root / "backup.key"
        self.key.write_bytes(os.urandom(32))
        os.chmod(self.key, 0o600)
        self._seed_database()
        (self.artifacts / "job-queued.bin").write_bytes(b"queued artifact")
        (self.artifacts / "job-waiting.bin").write_bytes(b"waiting artifact")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _seed_database(self) -> None:
        connection = sqlite3.connect(self.database)
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
            connection.execute("INSERT INTO alembic_version (version_num) VALUES ('0003')")
            connection.execute(
                "CREATE TABLE generation_job ("
                "id TEXT PRIMARY KEY, status TEXT NOT NULL, remote_job_id TEXT, "
                "lease_owner TEXT, lease_expires_at TEXT, heartbeat_at TEXT, "
                "completed_at TEXT, error_code TEXT)"
            )
            connection.executemany(
                "INSERT INTO generation_job "
                "(id, status, remote_job_id, lease_owner) VALUES (?, ?, ?, ?)",
                [
                    ("queued", "queued", None, None),
                    ("running", "running", None, "worker-a"),
                    ("waiting", "waiting_provider", "remote-123", "worker-a"),
                    ("done", "succeeded", "remote-done", None),
                ],
            )
            connection.commit()
        finally:
            connection.close()

    def test_backup_is_online_encrypted_and_manifest_bound(self) -> None:
        bundle = backup_drill.create_backup(
            database=self.database,
            artifacts=self.artifacts,
            destination=self.offsite,
            key_file=self.key,
            release_id="sha256:test-release",
            retention_hours=24,
        )

        self.assertTrue(bundle.archive_path.is_file())
        self.assertTrue(bundle.manifest_path.is_file())
        self.assertEqual(bundle.archive_path.suffix, ".gandiwa")
        self.assertNotIn(b"SQLite format 3", bundle.archive_path.read_bytes())
        manifest = json.loads(bundle.manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["format"], "gandiwa-backup-v1")
        self.assertEqual(manifest["release_id"], "sha256:test-release")
        self.assertEqual(manifest["database"]["sha256"], bundle.database_sha256)
        self.assertEqual(
            manifest["archive_sha256"],
            hashlib.sha256(bundle.archive_path.read_bytes()).hexdigest(),
        )
        self.assertEqual(
            manifest["artifacts"]["files"],
            [
                {"path": "job-queued.bin", "sha256": hashlib.sha256(b"queued artifact").hexdigest()},
                {"path": "job-waiting.bin", "sha256": hashlib.sha256(b"waiting artifact").hexdigest()},
            ],
        )
        self.assertEqual(stat.S_IMODE(bundle.archive_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(bundle.manifest_path.stat().st_mode), 0o600)

    def test_backup_collision_never_overwrites_or_leaves_new_orphan_archive(self) -> None:
        original = backup_drill.datetime

        class FrozenDateTime:
            @classmethod
            def now(cls, _timezone: object) -> object:
                return original(2026, 10, 5, 2, 0, 0, tzinfo=backup_drill.UTC)

        backup_drill.datetime = FrozenDateTime
        try:
            first = backup_drill.create_backup(
                database=self.database,
                artifacts=self.artifacts,
                destination=self.offsite,
                key_file=self.key,
                release_id="sha256:test-release",
                retention_hours=24,
            )
            first_archive = first.archive_path.read_bytes()
            first_manifest = first.manifest_path.read_bytes()
            with self.assertRaisesRegex(backup_drill.DrillError, "refusing to overwrite"):
                backup_drill.create_backup(
                    database=self.database,
                    artifacts=self.artifacts,
                    destination=self.offsite,
                    key_file=self.key,
                    release_id="sha256:test-release",
                    retention_hours=24,
                )
            self.assertEqual(first.archive_path.read_bytes(), first_archive)
            self.assertEqual(first.manifest_path.read_bytes(), first_manifest)
            self.assertEqual(list(self.offsite.glob("*.gandiwa")), [first.archive_path])
        finally:
            backup_drill.datetime = original

    def test_backup_manifest_write_failure_removes_new_archive(self) -> None:
        original_writer = backup_drill._write_new_private
        calls = 0

        def fail_manifest(path: Path, value: bytes) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("simulated manifest I/O failure")
            original_writer(path, value)

        with (
            patch.object(backup_drill, "_write_new_private", side_effect=fail_manifest),
            self.assertRaisesRegex(backup_drill.DrillError, "cannot write complete"),
        ):
            backup_drill.create_backup(
                database=self.database,
                artifacts=self.artifacts,
                destination=self.offsite,
                key_file=self.key,
                release_id="sha256:test-release",
                retention_hours=24,
            )
        self.assertEqual(list(self.offsite.glob("*.gandiwa")), [])
        self.assertEqual(list(self.offsite.glob("*.manifest.json")), [])

    def test_backup_rejects_a_symlinked_artifact_root_before_writing_bundle(self) -> None:
        actual_artifacts = self.root / "actual-artifacts"
        os.replace(self.artifacts, actual_artifacts)
        self.artifacts.symlink_to(actual_artifacts, target_is_directory=True)

        with self.assertRaisesRegex(backup_drill.DrillError, "artifact directory.*symlink"):
            backup_drill.create_backup(
                database=self.database,
                artifacts=self.artifacts,
                destination=self.offsite,
                key_file=self.key,
                release_id="sha256:test-release",
                retention_hours=24,
            )

        self.assertEqual(list(self.offsite.iterdir()), [])

    def test_backup_rejects_an_artifact_root_with_a_symlinked_ancestor(self) -> None:
        external_parent = self.root / "external-parent"
        external_parent.mkdir()
        actual_artifacts = external_parent / "artifacts"
        os.replace(self.artifacts, actual_artifacts)
        linked_parent = self.root / "linked-parent"
        linked_parent.symlink_to(external_parent, target_is_directory=True)

        with self.assertRaisesRegex(backup_drill.DrillError, "unsafe symlink"):
            backup_drill.create_backup(
                database=self.database,
                artifacts=linked_parent / "artifacts",
                destination=self.offsite,
                key_file=self.key,
                release_id="sha256:test-release",
                retention_hours=24,
            )

        self.assertEqual(list(self.offsite.iterdir()), [])

    def test_backup_rejects_a_fifo_swapped_in_for_an_artifact_file_without_hanging(self) -> None:
        original_open = backup_drill.os.open
        swapped = False

        def swap_file_for_fifo(path: str | bytes | os.PathLike[str] | os.PathLike[bytes], flags: int, *args: object, **kwargs: object) -> int:
            nonlocal swapped
            if path == "job-queued.bin" and not swapped and kwargs.get("dir_fd") is not None:
                swapped = True
                os.unlink(self.artifacts / "job-queued.bin")
                os.mkfifo(self.artifacts / "job-queued.bin")
            return original_open(path, flags, *args, **kwargs)

        previous_handler = signal.getsignal(signal.SIGALRM)
        signal.signal(signal.SIGALRM, lambda _signum, _frame: (_ for _ in ()).throw(TimeoutError("backup blocked on FIFO")))
        signal.alarm(2)
        started = time.monotonic()
        try:
            with (
                patch.object(backup_drill.os, "open", side_effect=swap_file_for_fifo),
                self.assertRaisesRegex(backup_drill.DrillError, "artifact file changed"),
            ):
                backup_drill.create_backup(
                    database=self.database,
                    artifacts=self.artifacts,
                    destination=self.offsite,
                    key_file=self.key,
                    release_id="sha256:test-release",
                    retention_hours=24,
                )
        finally:
            elapsed = time.monotonic() - started
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous_handler)

        self.assertTrue(swapped)
        self.assertLess(elapsed, 0.5, "artifact FIFO race must fail closed without blocking")
        self.assertEqual(list(self.offsite.iterdir()), [])

    def test_backup_holds_artifact_root_descriptor_across_a_symlink_swap(self) -> None:
        original_root = self.root / "artifacts-before-swap"
        external_root = self.root / "outside-artifacts"
        external_root.mkdir()
        (external_root / "outside-secret.bin").write_bytes(b"must never enter backup")
        original_archive_tree = backup_drill._archive_artifact_tree

        def swap_root_after_descriptor_open(*args: object, **kwargs: object) -> list[dict[str, str]]:
            os.replace(self.artifacts, original_root)
            self.artifacts.symlink_to(external_root, target_is_directory=True)
            return original_archive_tree(*args, **kwargs)

        with patch.object(backup_drill, "_archive_artifact_tree", side_effect=swap_root_after_descriptor_open):
            bundle = backup_drill.create_backup(
                database=self.database,
                artifacts=self.artifacts,
                destination=self.offsite,
                key_file=self.key,
                release_id="sha256:test-release",
                retention_hours=24,
            )

        staging = self.root / "descriptor-swap-staging"
        report = backup_drill.restore_verify(
            archive=bundle.archive_path,
            manifest=bundle.manifest_path,
            key_file=self.key,
            staging=staging,
            expected_uid=os.getuid(),
            expected_gid=os.getgid(),
            expected_release_id="sha256:test-release",
            expected_revision="0003",
        )

        self.assertEqual(
            [entry["path"] for entry in report["artifacts"]],
            ["job-queued.bin", "job-waiting.bin"],
        )
        self.assertFalse((staging / "artifacts" / "outside-secret.bin").exists())

    def test_restore_accepts_a_backup_with_no_durable_artifacts(self) -> None:
        for artifact in self.artifacts.iterdir():
            artifact.unlink()
        bundle = backup_drill.create_backup(
            database=self.database,
            artifacts=self.artifacts,
            destination=self.offsite,
            key_file=self.key,
            release_id="sha256:test-release",
            retention_hours=24,
        )

        staging = self.root / "empty-artifacts-staging"
        report = backup_drill.restore_verify(
            archive=bundle.archive_path,
            manifest=bundle.manifest_path,
            key_file=self.key,
            staging=staging,
            expected_uid=os.getuid(),
            expected_gid=os.getgid(),
            expected_release_id="sha256:test-release",
            expected_revision="0003",
        )

        self.assertEqual(report["artifacts"], [])
        self.assertTrue((staging / "artifacts").is_dir())
        self.assertEqual(list((staging / "artifacts").iterdir()), [])

    def test_restore_verifies_then_reconciles_active_jobs_without_redispatch(self) -> None:
        bundle = backup_drill.create_backup(
            database=self.database,
            artifacts=self.artifacts,
            destination=self.offsite,
            key_file=self.key,
            release_id="sha256:test-release",
            retention_hours=24,
        )
        staging = self.root / "restore-staging"

        report = backup_drill.restore_verify(
            archive=bundle.archive_path,
            manifest=bundle.manifest_path,
            key_file=self.key,
            staging=staging,
            expected_uid=os.getuid(),
            expected_gid=os.getgid(),
            expected_release_id="sha256:test-release",
            expected_revision="0003",
        )

        self.assertEqual(report["migration"], {"revision": "0003", "expected": "0003"})
        self.assertEqual(report["integrity"], {"quick_check": "ok", "integrity_check": "ok"})
        self.assertEqual(report["reconciliation"]["needs_review"], ["running", "waiting"])
        restored = sqlite3.connect(staging / "data" / "gandiwa.sqlite3")
        try:
            rows = dict(restored.execute("SELECT id, status FROM generation_job"))
        finally:
            restored.close()
        self.assertEqual(rows["queued"], "queued")
        self.assertEqual(rows["running"], "needs_review")
        self.assertEqual(rows["waiting"], "needs_review")
        self.assertEqual(rows["done"], "succeeded")
        self.assertTrue((staging / "artifacts" / "job-waiting.bin").is_file())

    def test_restore_rejects_dispatched_job_without_remote_id(self) -> None:
        # Build a signed test bundle whose provider-dispatch state lacks a remote ID.
        connection = sqlite3.connect(self.database)
        try:
            connection.execute("UPDATE generation_job SET remote_job_id=NULL WHERE id='waiting'")
            connection.commit()
        finally:
            connection.close()
        broken = backup_drill.create_backup(
            database=self.database,
            artifacts=self.artifacts,
            destination=self.root / "offsite-broken",
            key_file=self.key,
            release_id="sha256:test-release",
            retention_hours=24,
        )
        staging = self.root / "missing-remote-staging"
        with self.assertRaisesRegex(backup_drill.DrillError, "lacks remote_job_id"):
            backup_drill.restore_verify(
                archive=broken.archive_path,
                manifest=broken.manifest_path,
                key_file=self.key,
                staging=staging,
                expected_uid=os.getuid(),
                expected_gid=os.getgid(),
                expected_release_id="sha256:test-release",
                expected_revision="0003",
            )
        self.assertFalse(staging.exists())

    def test_restore_rejects_tampered_archive_before_staging_write(self) -> None:
        bundle = backup_drill.create_backup(
            database=self.database,
            artifacts=self.artifacts,
            destination=self.offsite,
            key_file=self.key,
            release_id="sha256:test-release",
            retention_hours=24,
        )
        bundle.archive_path.write_bytes(bundle.archive_path.read_bytes() + b"tampered")
        staging = self.root / "must-stay-absent"

        with self.assertRaisesRegex(backup_drill.DrillError, "archive checksum"):
            backup_drill.restore_verify(
                archive=bundle.archive_path,
                manifest=bundle.manifest_path,
                key_file=self.key,
                staging=staging,
                expected_uid=os.getuid(),
                expected_gid=os.getgid(),
                expected_release_id="sha256:test-release",
            )
        self.assertFalse(staging.exists())

    def test_rollback_requires_verified_staging_and_atomic_replacement(self) -> None:
        bundle = backup_drill.create_backup(
            database=self.database,
            artifacts=self.artifacts,
            destination=self.offsite,
            key_file=self.key,
            release_id="sha256:test-release",
            retention_hours=24,
        )
        staging = self.root / "restore-staging"
        backup_drill.restore_verify(
            archive=bundle.archive_path,
            manifest=bundle.manifest_path,
            key_file=self.key,
            staging=staging,
            expected_uid=os.getuid(),
            expected_gid=os.getgid(),
            expected_release_id="sha256:test-release",
        )
        live_data = self.root / "live-data"
        live_artifacts = self.root / "live-artifacts"
        live_data.mkdir()
        live_artifacts.mkdir()
        (live_data / "gandiwa.sqlite3").write_bytes(b"newer database")
        (live_artifacts / "do-not-lose.bin").write_bytes(b"newer artifact")

        receipt = backup_drill.apply_rollback(
            staging=staging,
            data_dir=live_data,
            artifacts_dir=live_artifacts,
            expected_uid=os.getuid(),
            expected_gid=os.getgid(),
            key_file=self.key,
            expected_release_id="sha256:test-release",
            expected_revision="0003",
        )

        self.assertTrue(receipt["applied"])
        self.assertTrue((live_data / "gandiwa.sqlite3").is_file())
        self.assertTrue((live_artifacts / "job-queued.bin").is_file())
        self.assertFalse((live_artifacts / "do-not-lose.bin").exists())
        self.assertTrue(Path(receipt["previous_data"]).is_dir())
        self.assertTrue(Path(receipt["previous_artifacts"]).is_dir())

    def test_rollback_rejects_tampered_receipt_and_staging_artifact(self) -> None:
        bundle = backup_drill.create_backup(
            database=self.database, artifacts=self.artifacts, destination=self.offsite,
            key_file=self.key, release_id="sha256:test-release", retention_hours=24,
        )
        staging = self.root / "sealed-staging"
        backup_drill.restore_verify(
            archive=bundle.archive_path, manifest=bundle.manifest_path, key_file=self.key,
            staging=staging, expected_uid=os.getuid(), expected_gid=os.getgid(),
            expected_release_id="sha256:test-release", expected_revision="0003",
        )
        live_data = self.root / "sealed-live-data"
        live_artifacts = self.root / "sealed-live-artifacts"
        live_data.mkdir(); live_artifacts.mkdir()
        (live_data / "gandiwa.sqlite3").write_bytes(b"live")
        receipt_path = staging / ".gandiwa-restore-verified.json"
        sealed = json.loads(receipt_path.read_text(encoding="utf-8"))
        sealed["receipt"]["release_id"] = "sha256:forged"
        receipt_path.write_text(json.dumps(sealed), encoding="utf-8")
        os.chmod(receipt_path, 0o600)
        with self.assertRaisesRegex(backup_drill.DrillError, "signature"):
            backup_drill.apply_rollback(
                staging=staging, data_dir=live_data, artifacts_dir=live_artifacts,
                expected_uid=os.getuid(), expected_gid=os.getgid(), key_file=self.key,
                expected_release_id="sha256:test-release", expected_revision="0003",
            )
        self.assertTrue(live_data.is_dir())

    def test_rollback_rejects_staging_root_symlink_with_fail_closed_error(self) -> None:
        bundle = backup_drill.create_backup(
            database=self.database, artifacts=self.artifacts, destination=self.offsite,
            key_file=self.key, release_id="sha256:test-release", retention_hours=24,
        )
        staging = self.root / "symlink-root-staging"
        backup_drill.restore_verify(
            archive=bundle.archive_path, manifest=bundle.manifest_path, key_file=self.key,
            staging=staging, expected_uid=os.getuid(), expected_gid=os.getgid(),
            expected_release_id="sha256:test-release", expected_revision="0003",
        )
        original_staging = self.root / "verified-staging-outside"
        os.replace(staging, original_staging)
        staging.symlink_to(original_staging, target_is_directory=True)
        live_data = self.root / "symlink-root-live-data"
        live_artifacts = self.root / "symlink-root-live-artifacts"
        live_data.mkdir(); live_artifacts.mkdir()
        with self.assertRaisesRegex(backup_drill.DrillError, "unsafe symlink"):
            backup_drill.apply_rollback(
                staging=staging, data_dir=live_data, artifacts_dir=live_artifacts,
                expected_uid=os.getuid(), expected_gid=os.getgid(), key_file=self.key,
                expected_release_id="sha256:test-release", expected_revision="0003",
            )
        self.assertTrue(live_data.is_dir())
        self.assertTrue(live_artifacts.is_dir())

    def test_rollback_rejects_database_symlink_inserted_after_signed_receipt(self) -> None:
        bundle = backup_drill.create_backup(
            database=self.database, artifacts=self.artifacts, destination=self.offsite,
            key_file=self.key, release_id="sha256:test-release", retention_hours=24,
        )
        staging = self.root / "symlink-db-staging"
        backup_drill.restore_verify(
            archive=bundle.archive_path, manifest=bundle.manifest_path, key_file=self.key,
            staging=staging, expected_uid=os.getuid(), expected_gid=os.getgid(),
            expected_release_id="sha256:test-release", expected_revision="0003",
        )
        staged_database = staging / "data" / "gandiwa.sqlite3"
        original_database = self.root / "same-hash-outside.sqlite3"
        os.replace(staged_database, original_database)
        staged_database.symlink_to(original_database)
        live_data = self.root / "symlink-db-live-data"
        live_artifacts = self.root / "symlink-db-live-artifacts"
        live_data.mkdir(); live_artifacts.mkdir()
        with self.assertRaisesRegex(backup_drill.DrillError, "symlink"):
            backup_drill.apply_rollback(
                staging=staging, data_dir=live_data, artifacts_dir=live_artifacts,
                expected_uid=os.getuid(), expected_gid=os.getgid(), key_file=self.key,
                expected_release_id="sha256:test-release", expected_revision="0003",
            )
        self.assertTrue(live_data.is_dir())
        self.assertFalse((live_data / "gandiwa.sqlite3").exists())

    def test_rollback_rejects_artifact_changed_after_signed_receipt(self) -> None:
        bundle = backup_drill.create_backup(
            database=self.database, artifacts=self.artifacts, destination=self.offsite,
            key_file=self.key, release_id="sha256:test-release", retention_hours=24,
        )
        staging = self.root / "changed-artifact-staging"
        backup_drill.restore_verify(
            archive=bundle.archive_path, manifest=bundle.manifest_path, key_file=self.key,
            staging=staging, expected_uid=os.getuid(), expected_gid=os.getgid(),
            expected_release_id="sha256:test-release", expected_revision="0003",
        )
        (staging / "artifacts" / "job-waiting.bin").write_bytes(b"tampered")
        live_data = self.root / "changed-artifact-data"
        live_artifacts = self.root / "changed-artifact-artifacts"
        live_data.mkdir(); live_artifacts.mkdir()
        with self.assertRaisesRegex(backup_drill.DrillError, "artifacts changed"):
            backup_drill.apply_rollback(
                staging=staging, data_dir=live_data, artifacts_dir=live_artifacts,
                expected_uid=os.getuid(), expected_gid=os.getgid(), key_file=self.key,
                expected_release_id="sha256:test-release", expected_revision="0003",
            )
        self.assertTrue(live_data.is_dir())
        self.assertTrue(live_artifacts.is_dir())

    def test_rollback_compensates_a_failed_final_rename(self) -> None:
        bundle = backup_drill.create_backup(
            database=self.database, artifacts=self.artifacts, destination=self.offsite,
            key_file=self.key, release_id="sha256:test-release", retention_hours=24,
        )
        staging = self.root / "compensate-staging"
        backup_drill.restore_verify(
            archive=bundle.archive_path, manifest=bundle.manifest_path, key_file=self.key,
            staging=staging, expected_uid=os.getuid(), expected_gid=os.getgid(),
            expected_release_id="sha256:test-release", expected_revision="0003",
        )
        live_data = self.root / "compensate-data"
        live_artifacts = self.root / "compensate-artifacts"
        live_data.mkdir(); live_artifacts.mkdir()
        (live_data / "original.db").write_bytes(b"original")
        (live_artifacts / "original.bin").write_bytes(b"original")
        original_replace = backup_drill.os.replace
        calls = 0
        def fail_fourth(source: Path, target: Path) -> None:
            nonlocal calls
            calls += 1
            if calls == 4:
                raise OSError("simulated final rename failure")
            original_replace(source, target)
        with (
            patch.object(backup_drill.os, "replace", side_effect=fail_fourth),
            self.assertRaisesRegex(backup_drill.DrillError, "original live paths were restored"),
        ):
            backup_drill.apply_rollback(
                staging=staging, data_dir=live_data, artifacts_dir=live_artifacts,
                expected_uid=os.getuid(), expected_gid=os.getgid(), key_file=self.key,
                expected_release_id="sha256:test-release", expected_revision="0003",
            )
        self.assertEqual((live_data / "original.db").read_bytes(), b"original")
        self.assertEqual((live_artifacts / "original.bin").read_bytes(), b"original")

    def test_cli_rejects_non_root_key_without_secret_output(self) -> None:
        created = subprocess.run(
            [
                sys.executable,
                str(SCRIPT_PATH),
                "backup",
                "--database",
                str(self.database),
                "--artifacts",
                str(self.artifacts),
                "--destination",
                str(self.offsite),
                "--key-file",
                str(self.key),
                "--release-id",
                "sha256:test-release",
                "--retention-hours",
                "24",
            ],
            check=False,
            text=True,
            capture_output=True,
        )
        self.assertEqual(created.returncode, 2)
        self.assertIn("unexpected owner", created.stderr)
        self.assertNotIn(self.key.read_bytes().hex(), created.stdout + created.stderr)

    def test_cli_rollback_contract_requires_key_release_revision_and_stop_ack(self) -> None:
        help_result = subprocess.run(
            [sys.executable, str(SCRIPT_PATH), "rollback-apply", "--help"],
            check=True,
            text=True,
            capture_output=True,
        )
        self.assertIn("--key-file", help_result.stdout)
        self.assertIn("--expected-release-id", help_result.stdout)
        self.assertIn("--expected-revision", help_result.stdout)
        self.assertIn("--services-stopped", help_result.stdout)

        missing_ack = subprocess.run(
            [
                sys.executable, str(SCRIPT_PATH), "rollback-apply",
                "--staging", str(self.root / "missing"),
                "--data-dir", str(self.root / "data"),
                "--artifacts-dir", str(self.root / "artifacts-live"),
                "--key-file", str(self.key),
                "--expected-release-id", "sha256:test-release",
                "--expected-revision", "0003",
            ],
            check=False,
            text=True,
            capture_output=True,
        )
        self.assertEqual(missing_ack.returncode, 2)
        self.assertIn("--services-stopped", missing_ack.stderr)

    def test_backup_age_monitor_distinguishes_fresh_stale_and_invalid_manifests(self) -> None:
        bundle = backup_drill.create_backup(
            database=self.database,
            artifacts=self.artifacts,
            destination=self.offsite,
            key_file=self.key,
            release_id="sha256:test-release",
            retention_hours=24,
        )
        monitor = ROOT / "deploy" / "bejo2" / "check-backup-age.py"
        fresh = subprocess.run(
            [sys.executable, str(monitor), "--directory", str(self.offsite), "--max-age-hours", "24"],
            check=False,
            text=True,
            capture_output=True,
        )
        self.assertEqual(fresh.returncode, 0)
        self.assertEqual(json.loads(fresh.stdout)["status"], "ok")
        manifest = json.loads(bundle.manifest_path.read_text(encoding="utf-8"))
        manifest["created_at"] = "2000-01-01T00:00:00+00:00"
        bundle.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        stale = subprocess.run(
            [sys.executable, str(monitor), "--directory", str(self.offsite), "--max-age-hours", "24"],
            check=False,
            text=True,
            capture_output=True,
        )
        self.assertEqual(stale.returncode, 1)
        self.assertEqual(json.loads(stale.stdout)["status"], "stale")
        bundle.manifest_path.write_text("not-json", encoding="utf-8")
        invalid = subprocess.run(
            [sys.executable, str(monitor), "--directory", str(self.offsite), "--max-age-hours", "24"],
            check=False,
            text=True,
            capture_output=True,
        )
        self.assertEqual(invalid.returncode, 2)
        self.assertEqual(json.loads(invalid.stdout)["status"], "error")

    def test_cli_and_runbook_prohibit_downgrade_and_require_stop_confirmation(self) -> None:
        source = SCRIPT_PATH.read_text(encoding="utf-8")
        runbook = (ROOT / "docs" / "DEPLOYMENT-BEJO2.md").read_text(encoding="utf-8")
        self.assertIn("backup", source)
        self.assertIn("restore-verify", source)
        self.assertIn("rollback-apply", source)
        self.assertIn("--services-stopped", source)
        self.assertIn("alembic downgrade", runbook)
        self.assertIn("--services-stopped", runbook)
        self.assertIn("RPO", runbook)
        self.assertIn("RTO", runbook)
