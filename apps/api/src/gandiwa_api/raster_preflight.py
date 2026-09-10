"""Ephemeral, deterministic technical preflight for PNG and JPEG bytes."""

from __future__ import annotations

import warnings
from dataclasses import dataclass
from io import BytesIO
from typing import Literal

from PIL import Image, UnidentifiedImageError

RasterContentType = Literal["photo", "illustration"]
RasterVerdict = Literal["pass", "warning", "fail"]
_SUPPORTED_FORMATS = frozenset({"JPEG", "PNG"})
_FORMAT_DETAILS = {
    "JPEG": ("image/jpeg", "jpeg"),
    "PNG": ("image/png", "png"),
}
_EXTENSION_ALIASES = {"jpg": "jpeg", "jpeg": "jpeg", "png": "png"}
_MINIMUM_MEGAPIXEL_RULE_IDS = {
    "photo": "photo.minimum-megapixels",
    "illustration": "illustration-raster.minimum-megapixels",
}
_SUBMISSION_FORMAT_RULES = {
    "photo": (
        "photo.submission-format",
        "Photo PNG is working/master only and must be converted to JPEG for submission.",
    ),
    "illustration": (
        "illustration-raster.submission-format",
        "Illustration PNG is working/master only and must be converted to JPEG for submission.",
    ),
}


@dataclass(frozen=True)
class RasterPreflightLimits:
    """Hard bounds that keep ephemeral inspection from becoming an image-bomb decoder."""

    max_bytes: int = 50 * 1024 * 1024
    max_width: int = 20_000
    max_height: int = 20_000
    max_pixels: int = 25_000_000

    def __post_init__(self) -> None:
        if min(self.max_bytes, self.max_width, self.max_height, self.max_pixels) < 1:
            raise ValueError("Raster preflight limits must be positive")


DEFAULT_LIMITS = RasterPreflightLimits()


@dataclass(frozen=True)
class RasterFinding:
    """One deterministic preflight finding, without source bytes or local paths."""

    rule_id: str
    message: str


@dataclass(frozen=True)
class RasterPreflightReport:
    """Technical facts and blocking verdict derived only from uploaded bytes."""

    verdict: RasterVerdict
    detected_mime_type: str | None
    detected_extension: str | None
    width: int | None
    height: int | None
    megapixels: float | None
    has_alpha: bool | None
    eligible_for_submission: bool
    findings: tuple[RasterFinding, ...]


def _decode_failure_report() -> RasterPreflightReport:
    return RasterPreflightReport(
        verdict="fail",
        detected_mime_type=None,
        detected_extension=None,
        width=None,
        height=None,
        megapixels=None,
        has_alpha=None,
        eligible_for_submission=False,
        findings=(
            RasterFinding(
                rule_id="universal.readable-file",
                message="Raster file could not be decoded as a supported PNG or JPEG image.",
            ),
        ),
    )


def _resource_limit_report(
    *,
    detected_mime_type: str | None,
    detected_extension: str | None,
    width: int | None,
    height: int | None,
) -> RasterPreflightReport:
    megapixels = None if width is None or height is None else width * height / 1_000_000
    return RasterPreflightReport(
        verdict="fail",
        detected_mime_type=detected_mime_type,
        detected_extension=detected_extension,
        width=width,
        height=height,
        megapixels=megapixels,
        has_alpha=None,
        eligible_for_submission=False,
        findings=(
            RasterFinding(
                rule_id="RASTER_RESOURCE_LIMIT",
                message="Raster dimensions exceed the configured safe import limit.",
            ),
        ),
    )


def _declared_extension(filename: str) -> str:
    """Return a canonical filename extension without treating it as trusted format data."""
    if "." not in filename:
        return ""
    return _EXTENSION_ALIASES.get(filename.rsplit(".", 1)[-1].lower(), "")


def inspect_raster(
    source: bytes,
    *,
    declared_mime_type: str,
    filename: str,
    content_type: RasterContentType,
    limits: RasterPreflightLimits = DEFAULT_LIMITS,
) -> RasterPreflightReport:
    """Inspect bytes in memory only; browser metadata must match the decoded format."""
    if len(source) > limits.max_bytes:
        return _resource_limit_report(
            detected_mime_type=None,
            detected_extension=None,
            width=None,
            height=None,
        )

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(source), formats=tuple(_SUPPORTED_FORMATS)) as image:
                image_format = image.format
                if image_format not in _FORMAT_DETAILS:
                    return _decode_failure_report()
                detected_mime_type, detected_extension = _FORMAT_DETAILS[image_format]
                width, height = image.size
                if (
                    width > limits.max_width
                    or height > limits.max_height
                    or width * height > limits.max_pixels
                ):
                    return _resource_limit_report(
                        detected_mime_type=detected_mime_type,
                        detected_extension=detected_extension,
                        width=width,
                        height=height,
                    )
                image.load()
                has_alpha = "A" in image.getbands()
    except (Image.DecompressionBombWarning, Image.DecompressionBombError):
        return _resource_limit_report(
            detected_mime_type=None,
            detected_extension=None,
            width=None,
            height=None,
        )
    except (OSError, UnidentifiedImageError, ValueError):
        return _decode_failure_report()

    megapixels = width * height / 1_000_000
    metadata_matches = (
        declared_mime_type == detected_mime_type
        and _declared_extension(filename) == detected_extension
    )
    findings: list[RasterFinding] = []
    if not metadata_matches:
        findings.append(
            RasterFinding(
                rule_id="universal.mime-matches-format",
                message=(
                    "Declared MIME type and filename extension must match decoded raster format."
                ),
            )
        )
    if megapixels < 4:
        findings.append(
            RasterFinding(
                rule_id=_MINIMUM_MEGAPIXEL_RULE_IDS[content_type],
                message="Raster submission requires at least 4 megapixels.",
            )
        )
    if detected_extension == "png":
        submission_rule_id, submission_message = _SUBMISSION_FORMAT_RULES[content_type]
        findings.append(RasterFinding(rule_id=submission_rule_id, message=submission_message))

    verdict: RasterVerdict = "pass"
    submission_rule_ids = frozenset(rule_id for rule_id, _ in _SUBMISSION_FORMAT_RULES.values())
    if any(finding.rule_id not in submission_rule_ids for finding in findings):
        verdict = "fail"
    elif findings:
        verdict = "warning"

    return RasterPreflightReport(
        verdict=verdict,
        detected_mime_type=detected_mime_type,
        detected_extension=detected_extension,
        width=width,
        height=height,
        megapixels=megapixels,
        has_alpha=has_alpha,
        eligible_for_submission=verdict == "pass" and detected_extension == "jpeg",
        findings=tuple(findings),
    )
