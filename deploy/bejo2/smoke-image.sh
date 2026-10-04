#!/usr/bin/env bash
set -euo pipefail

IMAGE=${1:?usage: smoke-image.sh IMAGE}
TMP=$(mktemp -d)
CID=""
cleanup() {
  if [[ -n "$CID" ]]; then docker rm -f "$CID" >/dev/null 2>&1 || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

ARCH=$(docker image inspect "$IMAGE" --format '{{.Architecture}}')
USER=$(docker image inspect "$IMAGE" --format '{{.Config.User}}')
[[ "$ARCH" == arm64 ]] || { echo "expected arm64 image, got $ARCH" >&2; exit 1; }
[[ "$USER" == 10001:10001 ]] || { echo "expected user 10001:10001, got $USER" >&2; exit 1; }

mkdir -p "$TMP/lib" "$TMP/cache/artifacts" "$TMP/cache/svg-quarantine"
chmod -R 0777 "$TMP/lib" "$TMP/cache"
COMMON=(
  --read-only
  --tmpfs /tmp:rw,noexec,nosuid,size=64m
  --cap-drop ALL
  --security-opt no-new-privileges
  -e GANDIWA_ENV=production
  -e GANDIWA_SESSION_SECRET=0123456789abcdef0123456789abcdef
  -e GANDIWA_SECURE_COOKIES=true
  -e GANDIWA_ALLOWED_ORIGINS=https://gandiwa.invalid
  -e GANDIWA_DATABASE_URL=sqlite:////var/lib/gandiwa/gandiwa.sqlite3
  -e GANDIWA_ARTIFACT_DIR=/var/cache/gandiwa/artifacts
  -e GANDIWA_SVG_QUARANTINE_DIR=/var/cache/gandiwa/svg-quarantine
  -v "$TMP/lib:/var/lib/gandiwa"
  -v "$TMP/cache:/var/cache/gandiwa"
)

docker run --rm "${COMMON[@]}" "$IMAGE" \
  python -c "import cairocffi, cairosvg, PIL, lxml, gandiwa_api"
docker run --rm "${COMMON[@]}" "$IMAGE" \
  alembic -c /app/alembic.ini upgrade head
python3 - "$TMP/lib/gandiwa.sqlite3" <<'PY'
import sqlite3
import sys
with sqlite3.connect(sys.argv[1]) as db:
    assert db.execute("select version_num from alembic_version").fetchone() == ("0003",)
    assert db.execute("pragma quick_check").fetchone() == ("ok",)
PY

CID=$(docker run -d "${COMMON[@]}" -p 127.0.0.1::8000 "$IMAGE")
PORT=$(docker port "$CID" 8000/tcp | sed 's/.*://')
for _ in $(seq 1 30); do
  if python3 - "$PORT" 2>/dev/null <<'PY'
import json
import sys
import urllib.request
with urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/api/v1/health", timeout=1) as response:
    assert response.status == 200
    json.load(response)
PY
  then
    echo "ARM64 image smoke passed: architecture=$ARCH user=$USER migration=0003 health=200"
    exit 0
  fi
  sleep 1
done

docker logs "$CID" >&2
exit 1
