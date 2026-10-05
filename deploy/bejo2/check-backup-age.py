#!/usr/bin/env python3
"""Read-only backup-age monitor for encrypted Gandiwa backup manifests."""
from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

FORMAT = "gandiwa-backup-v1"


def check_backup_age(directory: Path, *, max_age_hours: float, now: datetime | None = None) -> dict[str, Any]:
    if max_age_hours <= 0:
        raise ValueError("max_age_hours must be positive")
    manifests = sorted(directory.glob("*.manifest.json"))
    if not manifests:
        raise RuntimeError("no backup manifest found")
    newest = manifests[-1]
    try:
        metadata: Any = json.loads(newest.read_text(encoding="utf-8"))
        if not isinstance(metadata, dict) or metadata.get("format") != FORMAT:
            raise ValueError("wrong format")
        created_at = datetime.fromisoformat(str(metadata["created_at"]).replace("Z", "+00:00"))
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"invalid backup manifest: {newest.name}") from exc
    if created_at.tzinfo is None:
        raise RuntimeError(f"invalid backup manifest: {newest.name}")
    current = now or datetime.now(UTC)
    age_hours = (current - created_at.astimezone(UTC)).total_seconds() / 3600
    if age_hours < 0:
        raise RuntimeError(f"backup manifest is from the future: {newest.name}")
    return {
        "status": "ok" if age_hours <= max_age_hours else "stale",
        "manifest": str(newest),
        "release_id": metadata.get("release_id"),
        "age_hours": round(age_hours, 3),
        "max_age_hours": max_age_hours,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--max-age-hours", type=float, required=True)
    args = parser.parse_args()
    try:
        result = check_backup_age(args.directory, max_age_hours=args.max_age_hours)
    except (RuntimeError, ValueError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
