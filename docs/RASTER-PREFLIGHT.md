# Raster Import Preflight

Status: implemented by Issue #14 for temporary PNG/JPEG technical inspection.

## Boundary

The browser retains ownership of the selected local project folder. When a project is active, its **Raster technical preflight** panel lets the user choose a PNG/JPEG candidate and a `Photo` or `Illustration` classification. It sends the candidate bytes to `POST /api/v1/raster/preflight` over the existing same-origin HTTPS API only for ephemeral inspection. The endpoint does not write an artifact, project file, local path, browser directory handle, credential, or source bytes to SQLite or disk.

The displayed report is technical preflight only. Selecting a file does not create a source, asset, revision, or manifest entry; later import/revision and audit work owns those durable steps.

The route is state-changing request handling and therefore inherits the API's double-submit CSRF protection. Clients first obtain `GET /api/v1/auth/csrf`, retain the `gandiwa_csrf` cookie, and send its value in `X-CSRF-Token`.

## Request

```text
POST /api/v1/raster/preflight?content_type=photo
Content-Type: image/jpeg
X-Upload-Filename: example.jpeg
X-CSRF-Token: <token>

<raw PNG or JPEG bytes>
```

`content_type` is `photo` or `illustration`. The request `Content-Type` and `X-Upload-Filename` extension are claims only: both must match the format decoded from the bytes. `jpg` is accepted as the filename alias of decoded `jpeg`.

## Report

The response contains only deterministic technical facts:

```json
{
  "verdict": "pass | warning | fail",
  "detected_mime_type": "image/jpeg | image/png | null",
  "detected_extension": "jpeg | png | null",
  "width": 2000,
  "height": 2000,
  "megapixels": 4.0,
  "has_alpha": false,
  "eligible_for_submission": true,
  "findings": [{"rule_id": "photo.minimum-megapixels", "message": "..."}]
}
```

For a decode/resource failure, fields not safely known are `null`; parser exception details are never returned. Existing ruleset IDs are used where applicable:

- `universal.readable-file` — corrupt or unsupported bytes;
- `universal.mime-matches-format` — browser MIME or filename extension conflicts with decoded bytes;
- `photo.submission-format` and `illustration-raster.submission-format` — a PNG is a valid working/master source but not final JPEG submission;
- `photo.minimum-megapixels` and `illustration-raster.minimum-megapixels` — less than 4,000,000 pixels.

`RASTER_RESOURCE_LIMIT` is an internal security finding rather than an Adobe rule. It blocks a payload larger than 50 MiB, a dimension above 20,000 pixels, or more than 25,000,000 pixels. The request body reader retains at most the limit plus one sentinel byte before stopping, dimensions are checked before Pillow decodes full pixel data, and Pillow decompression-bomb warnings/errors are fail-closed as resource-limit findings.

`eligible_for_submission` is true only for a decoded JPEG with a passing technical preflight and at least 4 MP. It is a technical gate, not a guarantee of Adobe Stock acceptance; the later audit, metadata, human approval, conversion, and export gates remain separate work.

## Test corpus

Safe synthetic fixtures live in `tests/fixtures/raster-preflight/`: exact-4-MP RGB JPEG, exact-4-MP RGBA PNG, and corrupt bytes. Run the focused checks with:

```bash
uv run --project apps/api pytest apps/api/tests/test_raster_preflight.py \
  apps/api/tests/test_raster_preflight_endpoint.py -q
```
