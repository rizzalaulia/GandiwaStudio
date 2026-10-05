# Issue #31 — Backup, Restore, Migration, and Rollback Drill

## Scope

`deploy/bejo2/backup-drill.py` turns the bejo2 operations contract into executable,
fail-closed commands:

- `backup`: copies SQLite through the online SQLite backup API, packages durable
  artifacts, then encrypts the bundle with AES-256-GCM before writing it to the
  operator-provided off-host destination;
- `restore-verify`: validates archive and database checksums, decrypts only into a new
  staging directory, fixes/verifies numeric ownership, runs SQLite integrity checks,
  verifies the expected Alembic revision, and reconciles uncertain active jobs;
- `rollback-apply`: requires a previous private staging receipt plus the explicit
  `--services-stopped` acknowledgement before replacing durable directories.

`deploy/bejo2/check-backup-age.py` is a read-only monitor: it reads the newest manifest
and exits `0` fresh, `1` stale, or `2` invalid/missing.

## Security and recovery contracts

- The backup key is exactly 32 random bytes and must be owner-only (`0600`). It is
  independent from `GANDIWA_SESSION_SECRET`, absent from Git/Compose/logs, and is never
  printed by the tools.
- Backup does not copy an active SQLite main database/WAL by filesystem copy. It uses the
  SQLite online backup API.
- Restore refuses checksum mismatch before creating staging, rejects archive traversal
  and links, verifies the staging tree descriptor-relatively with no symlink hops, and
  never writes the live `/srv/gandiwa` paths. Rollback repeats that no-follow tree check
  immediately before its directory swaps.
- `running`, `waiting_provider`, and `processing` jobs restore as `needs_review`, retain
  remote IDs, and get `RESTORE_REQUIRES_PROVIDER_RECONCILIATION`. There is no automatic
  redispatch or provider call.
- Schema rollback is never `alembic downgrade` by default. A rollback return release must
  be compatible with the receipt's verified Alembic revision, or operators must migrate
  the **staging** copy with the intended target release before replacing live paths.
- POSIX lacks one transaction across both `data` and `artifacts` directory renames. The
  tool rejects cross-device staging, requires services stopped, retains timestamped
  `pre-rollback` paths, and the runbook defines the manual recovery decision if a host
  failure interrupts the two swaps.

## Operational evidence

Record release digest, manifest checksum, backup/restore elapsed time, artifact count,
and latest-manifest age. Initial targets are RPO <= 24h (or pre-deploy backup) and RTO <=
60m; revise only using completed drill measurements. Do not put secrets or private
artifact content in evidence.

## Verification

`tests/deployment/test_bejo2_backup_restore_drill.py` covers encrypted online backup,
checksum refusal, ownership/integrity/Alembic verification, active-job reconciliation,
no-secret CLI output, stop acknowledgement, same-filesystem rollback, and backup-age
fresh/stale/invalid statuses.
