# Safe Test Fixtures

Only synthetic, redistributable fixtures may be committed. Never add contributor submissions, private media, brand assets, credentials, or model/property releases.

## Fixture groups

- valid/invalid JPEG, PNG, and SVG Adobe checks;
- hostile SVG and render-parity cases;
- SQLite queue priority/FIFO, lease expiry, restart recovery, cancellation, and unknown provider-dispatch outcomes;
- fake 9Router/fal.ai success, auth, quota, timeout, invalid-result, and artifact-download responses;
- approval invalidation and final export gate.

## Raster preflight

`raster-preflight/` contains only synthetic byte fixtures for Issue #14:

- `photo-jpeg-4mp.jpeg`: RGB `2000 × 2000` JPEG (exactly 4 MP);
- `photo-png-alpha.png`: RGBA `2000 × 2000` PNG (exactly 4 MP);
- `corrupt.jpeg`: deliberately non-image bytes.

The API tests read these fixture bytes directly. They carry no contributor asset,
brand, metadata, release, or secret.

## Project manifest conformance

`project-manifest/conformance.json` is the single verdict list for portable project-manifest fixtures. Each fixture must be synthetic JSON and declare whether both TypeScript and Python validators must accept it.

The corpus explicitly covers a valid empty project (before its first asset), valid raster/vector manifests, and rejection of POSIX, Windows-drive, and UNC absolute paths; backslash separators and traversal; duplicate asset IDs/paths; unknown/secret fields; non-integer schema versions; queue/event/artifact durable state; and unsupported creation methods. See `docs/PROJECT-MANIFEST.md` for the schema and rebuild boundary.
