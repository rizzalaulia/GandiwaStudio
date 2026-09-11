"""Tests for secure, ephemeral PNG/JPEG import preflight."""

from __future__ import annotations

import struct
import zlib
from io import BytesIO
from pathlib import Path

from PIL import Image

from gandiwa_api.raster_preflight import (
    DEFAULT_LIMITS,
    RasterFinding,
    RasterPreflightLimits,
    inspect_raster,
)

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "tests" / "fixtures" / "raster-preflight"


def read_fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def make_image_bytes(
    *,
    image_format: str,
    size: tuple[int, int],
    mode: str = "RGB",
) -> bytes:
    """Build a synthetic in-memory image; never use private media in tests."""
    image = Image.new(mode, size, color=(12, 34, 56, 255) if mode == "RGBA" else (12, 34, 56))
    buffer = BytesIO()
    image.save(buffer, format=image_format)
    return buffer.getvalue()


def png_header(width: int, height: int) -> bytes:
    """Return enough synthetic PNG structure for Pillow to inspect only its dimensions."""
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    ihdr_chunk = b"IHDR" + ihdr
    iend_chunk = b"IEND"
    return (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", len(ihdr))
        + ihdr_chunk
        + struct.pack(">I", zlib.crc32(ihdr_chunk))
        + struct.pack(">I", 0)
        + iend_chunk
        + struct.pack(">I", zlib.crc32(iend_chunk))
    )


def test_photo_jpeg_reports_technical_metadata_and_submission_eligibility() -> None:
    report = inspect_raster(
        read_fixture("photo-jpeg-4mp.jpeg"),
        declared_mime_type="image/jpeg",
        filename="studio-photo.jpeg",
        content_type="photo",
    )

    assert report.verdict == "pass"
    assert report.detected_mime_type == "image/jpeg"
    assert report.detected_extension == "jpeg"
    assert report.width == 2_000
    assert report.height == 2_000
    assert report.megapixels == 4.0
    assert report.has_alpha is False
    assert report.eligible_for_submission is True
    assert report.findings == ()


def test_mime_or_extension_mismatch_fails_from_detected_bytes() -> None:
    report = inspect_raster(
        read_fixture("photo-jpeg-4mp.jpeg"),
        declared_mime_type="image/png",
        filename="pretends-to-be-png.png",
        content_type="photo",
    )

    assert report.verdict == "fail"
    assert report.detected_mime_type == "image/jpeg"
    assert report.detected_extension == "jpeg"
    assert report.eligible_for_submission is False
    assert report.findings == (
        RasterFinding(
            rule_id="universal.mime-matches-format",
            message="Declared MIME type and filename extension must match decoded raster format.",
        ),
    )


def test_photo_png_is_valid_working_master_but_not_submission_eligible() -> None:
    report = inspect_raster(
        make_image_bytes(image_format="PNG", size=(2_000, 2_000)),
        declared_mime_type="image/png",
        filename="photo-working.png",
        content_type="photo",
    )

    assert report.verdict == "warning"
    assert report.detected_mime_type == "image/png"
    assert report.detected_extension == "png"
    assert report.has_alpha is False
    assert report.eligible_for_submission is False
    assert report.findings == (
        RasterFinding(
            rule_id="photo.submission-format",
            message=(
                "Photo PNG is working/master only and must be converted to JPEG for submission."
            ),
        ),
    )


def test_illustration_jpeg_at_least_four_megapixels_is_submission_eligible() -> None:
    report = inspect_raster(
        make_image_bytes(image_format="JPEG", size=(2_000, 2_000)),
        declared_mime_type="image/jpeg",
        filename="illustration.jpeg",
        content_type="illustration",
    )

    assert report.verdict == "pass"
    assert report.eligible_for_submission is True
    assert report.findings == ()


def test_illustration_png_is_not_submission_eligible() -> None:
    report = inspect_raster(
        make_image_bytes(image_format="PNG", size=(2_000, 2_000)),
        declared_mime_type="image/png",
        filename="illustration-working.png",
        content_type="illustration",
    )

    assert report.verdict == "warning"
    assert report.eligible_for_submission is False
    assert report.findings == (
        RasterFinding(
            rule_id="illustration-raster.submission-format",
            message=(
                "Illustration PNG is working/master only and must be converted "
                "to JPEG for submission."
            ),
        ),
    )


def test_illustration_below_four_megapixels_uses_the_ruleset_id() -> None:
    report = inspect_raster(
        make_image_bytes(image_format="JPEG", size=(1_999, 2_000)),
        declared_mime_type="image/jpeg",
        filename="illustration-under-four-megapixels.jpeg",
        content_type="illustration",
    )

    assert report.verdict == "fail"
    assert report.findings == (
        RasterFinding(
            rule_id="illustration-raster.minimum-megapixels",
            message="Raster submission requires at least 4 megapixels.",
        ),
    )


def test_png_alpha_is_reported_even_when_photo_needs_jpeg_submission() -> None:
    report = inspect_raster(
        read_fixture("photo-png-alpha.png"),
        declared_mime_type="image/png",
        filename="transparent-working.png",
        content_type="photo",
    )

    assert report.verdict == "warning"
    assert report.has_alpha is True
    assert report.eligible_for_submission is False


def test_corrupt_raster_fails_without_raising_parser_detail() -> None:
    report = inspect_raster(
        read_fixture("corrupt.jpeg"),
        declared_mime_type="image/jpeg",
        filename="broken.jpeg",
        content_type="photo",
    )

    assert report.verdict == "fail"
    assert report.detected_mime_type is None
    assert report.detected_extension is None
    assert report.width is None
    assert report.height is None
    assert report.megapixels is None
    assert report.has_alpha is None
    assert report.eligible_for_submission is False
    assert report.findings == (
        RasterFinding(
            rule_id="universal.readable-file",
            message="Raster file could not be decoded as a supported PNG or JPEG image.",
        ),
    )


def test_default_pixel_limit_blocks_a_pillow_decompression_bomb_before_decode() -> None:
    pillow_limit = Image.MAX_IMAGE_PIXELS
    assert pillow_limit is not None
    assert DEFAULT_LIMITS.max_pixels < pillow_limit
    report = inspect_raster(
        png_header(10_000, 10_000),
        declared_mime_type="image/png",
        filename="compressed-bomb.png",
        content_type="photo",
    )

    assert report.verdict == "fail"
    assert report.width is None
    assert report.height is None
    assert report.megapixels is None
    assert report.eligible_for_submission is False
    assert report.findings == (
        RasterFinding(
            rule_id="RASTER_RESOURCE_LIMIT",
            message="Raster dimensions exceed the configured safe import limit.",
        ),
    )


def test_byte_limit_blocks_payload_before_image_decode() -> None:
    report = inspect_raster(
        b"x" * 5,
        declared_mime_type="image/jpeg",
        filename="oversized.jpeg",
        content_type="photo",
        limits=RasterPreflightLimits(
            max_bytes=4,
            max_width=2_000,
            max_height=2_000,
            max_pixels=4_000_000,
        ),
    )

    assert report.verdict == "fail"
    assert report.width is None
    assert report.eligible_for_submission is False
    assert report.findings == (
        RasterFinding(
            rule_id="RASTER_RESOURCE_LIMIT",
            message="Raster dimensions exceed the configured safe import limit.",
        ),
    )


def test_pixel_limit_blocks_image_bomb_before_full_decode() -> None:
    report = inspect_raster(
        make_image_bytes(image_format="JPEG", size=(2_000, 2_000)),
        declared_mime_type="image/jpeg",
        filename="oversized.jpeg",
        content_type="photo",
        limits=RasterPreflightLimits(max_pixels=3_999_999, max_width=2_000, max_height=2_000),
    )

    assert report.verdict == "fail"
    assert report.width == 2_000
    assert report.height == 2_000
    assert report.megapixels == 4.0
    assert report.eligible_for_submission is False
    assert report.findings == (
        RasterFinding(
            rule_id="RASTER_RESOURCE_LIMIT",
            message="Raster dimensions exceed the configured safe import limit.",
        ),
    )


def test_photo_jpeg_below_four_megapixels_is_not_submission_eligible() -> None:
    report = inspect_raster(
        make_image_bytes(image_format="JPEG", size=(1_999, 2_000)),
        declared_mime_type="image/jpeg",
        filename="under-four-megapixels.jpeg",
        content_type="photo",
    )

    assert report.verdict == "fail"
    assert report.megapixels == 3.998
    assert report.has_alpha is False
    assert report.eligible_for_submission is False
    assert report.findings == (
        RasterFinding(
            rule_id="photo.minimum-megapixels",
            message="Raster submission requires at least 4 megapixels.",
        ),
    )
