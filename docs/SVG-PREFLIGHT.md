# SVG Sanitization and Safe Preview

Status: implemented by Issue #15 for temporary structural SVG preflight and raster preview.

## Boundary

When a project is active, the **SVG security preflight** panel accepts an `Illustration vector` or `Vector` candidate. The browser sends SVG bytes to `POST /api/v1/svg/preflight` over the same-origin API only for ephemeral inspection.

The browser does not retain the selected source in application state, write it to the user-owned project folder, create a manifest entry, asset, revision, or SQLite record. The API response never includes raw SVG, sanitized SVG, local paths, or PNG bytes.

Unsafe SVG is never displayed inline or served as a same-origin SVG preview. A passing or warning candidate may receive an opaque URL to a temporary backend-rendered PNG. The browser validates that the URL is exactly an API preview path before placing it in an `<img>` element.

## Request and report

The endpoint inherits double-submit CSRF protection:

```text
GET /api/v1/auth/csrf
POST /api/v1/svg/preflight?content_type=vector
Content-Type: image/svg+xml
X-Upload-Filename: candidate.svg
X-CSRF-Token: <token>

<raw SVG bytes>
```

`content_type` is `vector` or `illustration`. The declared MIME type and filename extension must both be SVG claims that match the expected SVG import boundary.

The JSON response contains only metadata and rule findings:

```json
{
  "verdict": "pass | warning | fail",
  "eligible_for_submission": true,
  "findings": [{"rule_id": "vector.no-active-content", "message": "..."}],
  "preview_url": "/api/v1/svg/preflight/previews/<opaque-token> | null"
}
```

A preview endpoint returns `image/png` with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. It has no source-SVG route. Invalid, expired, malformed, or missing preview tokens resolve to `404`.

## Static SVG MVP profile

The preflight parser is fail-closed. It rejects before raster rendering when it finds:

- DTD declarations or entities, including documents encoded as UTF-16, plus XML processing instructions (including `xml-stylesheet`);
- scripts, event-handler attributes, SVG animation elements, `foreignObject`, non-SVG namespaces, live `<text>`, and inline CSS;
- raster `<image>` elements;
- external or unsafe `href`/`url(...)` resources;
- every `href`/`<use>` reference (the static MVP intentionally has no renderer-reference expansion), or a `url(#id)` target that is not a local gradient;
- empty paths, invalid/non-positive `viewBox`, unsupported static elements, or attributes outside the MVP profile;
- payloads over 5 MiB, nested elements deeper than 128, or raster previews over 4,096 pixels per side / 16,000,000 pixels total.

The initial static profile supports basic geometry, groups, definitions, local linear/radial gradients, and common paint/transform attributes. It deliberately excludes renderer-reference expansion (`href`/`<use>`), symbols, clip paths, masks, patterns, and markers. SVG that uses an unsupported feature fails rather than being partially rewritten or rendered unpredictably.

`vector.node-count` is a warning after 10,000 nodes: it can receive a PNG preview but is not submission eligible. Resource-limit findings use `SVG_RESOURCE_LIMIT`; structural/security findings use the versioned vector rule IDs in `ADOBE-RULESET.md`.

The parser uses `lxml` with external entity resolution and network loading disabled. CairoSVG is invoked only after the document passes the static structural profile, with its unsafe mode disabled.

## Quarantine and cleanup

The backend uses a dedicated quarantine directory (`GANDIWA_SVG_QUARANTINE_DIR`, default `./var/svg-quarantine`), never `ARTIFACT_DIR` or a browser-owned project folder.

- Rejected source bytes are retained only temporarily for operational cleanup; they receive no token and no download/preview endpoint.
- Safe PNG previews are stored under an opaque 128-bit token as private files.
- The directory is owner-only (`0700`) and files are private (`0600`).
- The default retention is 3,600 seconds (`GANDIWA_SVG_QUARANTINE_TTL_SECONDS`), which must be positive.
- Cleanup runs before each SVG preflight request and on preview lookup. It removes expired regular `.svg`/`.png` entries without following symlinks; expired preview lookups remove the preview and return `404`.

## Parity fixtures and verification

Only synthetic fixtures are committed under `tests/fixtures/svg-preflight/`:

- `safe-gradient.svg` — static SVG gradient accepted by the MVP profile;
- `safe-gradient.expected.png` — expected raster output.

The parity test compares RGBA dimensions and pixel bytes, not compressed PNG bytes, so a visual renderer/sanitizer drift is caught without coupling to PNG metadata or compression details.

Run focused backend checks with:

```bash
uv run --project apps/api pytest \
  apps/api/tests/test_svg_preflight.py \
  apps/api/tests/test_svg_quarantine.py \
  apps/api/tests/test_svg_preflight_endpoint.py -q
```
