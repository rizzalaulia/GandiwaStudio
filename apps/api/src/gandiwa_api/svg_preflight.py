"""Ephemeral SVG preflight; previews are raster bytes, never raw SVG."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from io import BytesIO
from typing import Literal

import cairosvg  # type: ignore[import-untyped]
from lxml import etree  # type: ignore[import-untyped]

SvgContentType = Literal["illustration", "vector"]
SvgVerdict = Literal["pass", "warning", "fail"]
_SVG_NAMESPACE = "http://www.w3.org/2000/svg"
_SUPPORTED_MIME = "image/svg+xml"
_DTD_OR_ENTITY = re.compile(rb"<!\s*(?:DOCTYPE|ENTITY)\b", re.IGNORECASE)
_LOCAL_URL_REFERENCE = re.compile(r"^url\(\s*#([A-Za-z_][\w.:-]*)\s*\)$")
_ANIMATION_ELEMENTS = frozenset({"animate", "animateMotion", "animateTransform", "set"})
_SAFE_ELEMENTS = frozenset(
    {
        "svg",
        "g",
        "defs",
        "path",
        "rect",
        "circle",
        "ellipse",
        "line",
        "polyline",
        "polygon",
        "linearGradient",
        "radialGradient",
        "stop",
        "title",
        "desc",
    }
)
_SAFE_ATTRIBUTE_NAMES = frozenset(
    {
        "alignment-baseline",
        "cx",
        "cy",
        "d",
        "display",
        "dominant-baseline",
        "fill",
        "fill-opacity",
        "fill-rule",
        "gradientTransform",
        "gradientUnits",
        "height",
        "id",
        "offset",
        "opacity",
        "orient",
        "overflow",
        "pathLength",
        "points",
        "preserveAspectRatio",
        "r",
        "rx",
        "ry",
        "spreadMethod",
        "stop-color",
        "stop-opacity",
        "stroke",
        "stroke-dasharray",
        "stroke-dashoffset",
        "stroke-linecap",
        "stroke-linejoin",
        "stroke-miterlimit",
        "stroke-opacity",
        "stroke-width",
        "transform",
        "viewBox",
        "visibility",
        "width",
        "x",
        "x1",
        "x2",
        "y",
        "y1",
        "y2",
    }
)


@dataclass(frozen=True)
class SvgPreflightLimits:
    """Hard parser and renderer bounds for untrusted SVG input."""

    max_bytes: int = 5 * 1024 * 1024
    max_output_width: int = 4_096
    max_output_height: int = 4_096
    max_output_pixels: int = 16_000_000
    max_nodes: int = 10_000
    max_depth: int = 128

    def __post_init__(self) -> None:
        if (
            min(
                self.max_bytes,
                self.max_output_width,
                self.max_output_height,
                self.max_output_pixels,
                self.max_nodes,
                self.max_depth,
            )
            < 1
        ):
            raise ValueError("SVG preflight limits must be positive")


DEFAULT_LIMITS = SvgPreflightLimits()


@dataclass(frozen=True)
class SvgFinding:
    rule_id: str
    message: str


@dataclass(frozen=True)
class SvgPreflightReport:
    verdict: SvgVerdict
    eligible_for_submission: bool
    findings: tuple[SvgFinding, ...]
    sanitized_svg: bytes | None
    preview_png: bytes | None


def _valid_view_box(value: str | None) -> tuple[float, float, float, float] | None:
    if value is None:
        return None
    try:
        parsed = tuple(float(part) for part in value.replace(",", " ").split())
    except ValueError:
        return None
    if len(parsed) != 4 or not all(math.isfinite(part) for part in parsed):
        return None
    if parsed[2] <= 0 or parsed[3] <= 0:
        return None
    return parsed  # type: ignore[return-value]


def _exceeds_depth_limit(nodes: tuple[etree._Element, ...], *, max_depth: int) -> bool:
    for node in nodes:
        depth = 0
        parent = node.getparent()
        while parent is not None:
            depth += 1
            if depth > max_depth:
                return True
            parent = parent.getparent()
    return False


def _has_processing_instruction(root: etree._Element) -> bool:
    """Reject PIs inside the SVG and document-level PIs before or after its root."""
    if any(isinstance(node, etree._ProcessingInstruction) for node in root.iter()):
        return True
    sibling = root.getprevious()
    while sibling is not None:
        if isinstance(sibling, etree._ProcessingInstruction):
            return True
        sibling = sibling.getprevious()
    sibling = root.getnext()
    while sibling is not None:
        if isinstance(sibling, etree._ProcessingInstruction):
            return True
        sibling = sibling.getnext()
    return False


def _active_content_failure() -> SvgPreflightReport:
    return SvgPreflightReport(
        verdict="fail",
        eligible_for_submission=False,
        findings=(
            SvgFinding(
                "vector.no-active-content",
                "SVG contains active content that is not allowed before preview.",
            ),
        ),
        sanitized_svg=None,
        preview_png=None,
    )


def inspect_svg(
    source: bytes,
    *,
    declared_mime_type: str,
    filename: str,
    content_type: SvgContentType,
    limits: SvgPreflightLimits = DEFAULT_LIMITS,
) -> SvgPreflightReport:
    """Create a PNG preview only from a parseable SVG whose metadata and viewBox are valid."""
    del content_type
    if len(source) > limits.max_bytes:
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding("SVG_RESOURCE_LIMIT", "SVG exceeds the configured safe import limit."),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    if declared_mime_type.split(";", 1)[
        0
    ].strip().lower() != _SUPPORTED_MIME or not filename.lower().endswith(".svg"):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding(
                    "universal.mime-matches-format",
                    "Declared MIME type and filename extension must match SVG.",
                ),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    if _DTD_OR_ENTITY.search(source):
        return _active_content_failure()
    parser = etree.XMLParser(
        resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False
    )
    try:
        document = etree.parse(BytesIO(source), parser=parser)
        root = document.getroot()
    except (etree.XMLSyntaxError, ValueError):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding(
                    "universal.readable-file",
                    "SVG file could not be parsed as a valid SVG document.",
                ),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    if not isinstance(root, etree._Element) or root.tag != f"{{{_SVG_NAMESPACE}}}svg":
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding(
                    "vector.valid-document", "SVG root element and namespace must be valid."
                ),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    if document.docinfo.doctype or _has_processing_instruction(root):
        return _active_content_failure()
    nodes = tuple(node for node in root.iter() if isinstance(node.tag, str))
    if _exceeds_depth_limit(nodes, max_depth=limits.max_depth):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding(
                    "SVG_RESOURCE_LIMIT", "SVG structure exceeds the configured safe depth limit."
                ),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    findings: list[SvgFinding] = []
    if len(nodes) > limits.max_nodes:
        findings.append(
            SvgFinding(
                "vector.node-count",
                "SVG node count exceeds the configured review threshold.",
            )
        )
    if any(etree.QName(node).localname == "image" for node in nodes):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding(
                    "vector.no-raster", "SVG must not contain embedded or linked raster images."
                ),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    if any(
        etree.QName(node).localname == "foreignObject"
        or etree.QName(node).namespace != _SVG_NAMESPACE
        for node in nodes
    ):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding(
                    "vector.no-active-content",
                    "SVG contains active content that is not allowed before preview.",
                ),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    if any(
        etree.QName(node).localname == "script"
        or etree.QName(node).localname in _ANIMATION_ELEMENTS
        or any(
            etree.QName(attribute).localname.lower().startswith("on") for attribute in node.attrib
        )
        for node in nodes
    ):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding(
                    "vector.no-active-content",
                    "SVG contains active content that is not allowed before preview.",
                ),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    if any(
        etree.QName(attribute).localname == "href" and not value.strip().startswith("#")
        for node in nodes
        for attribute, value in node.attrib.items()
    ):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding(
                    "vector.no-external-resource",
                    "SVG must not reference external or unsafe resources.",
                ),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    if any(etree.QName(node).localname == "text" for node in nodes):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding("vector.no-live-text", "SVG must not contain unresolved live text."),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    if any(etree.QName(node).localname not in _SAFE_ELEMENTS for node in nodes):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding(
                    "vector.valid-document", "SVG contains elements outside the static MVP profile."
                ),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    if any(
        etree.QName(attribute).localname == "style" for node in nodes for attribute in node.attrib
    ):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding("vector.no-external-resource", "SVG must not use inline CSS resources."),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    if any(
        etree.QName(attribute).localname not in _SAFE_ATTRIBUTE_NAMES
        for node in nodes
        for attribute in node.attrib
    ):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding(
                    "vector.valid-document",
                    "SVG contains attributes outside the static MVP profile.",
                ),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    if any(
        etree.QName(node).localname == "path" and not (node.get("d") or "").strip()
        for node in nodes
    ):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(SvgFinding("vector.no-empty-path", "SVG must not contain an empty path."),),
            sanitized_svg=None,
            preview_png=None,
        )
    attribute_values = tuple(value.strip() for node in nodes for value in node.attrib.values())
    if any(
        "url(" in value.lower() and not _LOCAL_URL_REFERENCE.fullmatch(value)
        for value in attribute_values
    ):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding(
                    "vector.no-external-resource",
                    "SVG must not reference external or unsafe resources.",
                ),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    gradient_identifiers = {
        node.get("id")
        for node in nodes
        if etree.QName(node).localname in {"linearGradient", "radialGradient"} and node.get("id")
    }
    local_url_targets = tuple(
        match.group(1)
        for value in attribute_values
        if (match := _LOCAL_URL_REFERENCE.fullmatch(value)) is not None
    )
    if any(target not in gradient_identifiers for target in local_url_targets):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding(
                    "vector.resolved-references", "SVG contains unresolved local references."
                ),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    view_box = _valid_view_box(root.get("viewBox"))
    if view_box is None:
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding("vector.valid-document", "SVG requires a finite positive viewBox."),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    output_width = max(1, math.ceil(view_box[2]))
    output_height = max(1, math.ceil(view_box[3]))
    if (
        output_width > limits.max_output_width
        or output_height > limits.max_output_height
        or output_width * output_height > limits.max_output_pixels
    ):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(
                SvgFinding(
                    "SVG_RESOURCE_LIMIT", "SVG preview dimensions exceed the configured safe limit."
                ),
            ),
            sanitized_svg=None,
            preview_png=None,
        )
    sanitized_svg = etree.tostring(root, encoding="utf-8", xml_declaration=True)
    try:
        preview_png = cairosvg.svg2png(
            bytestring=sanitized_svg,
            output_width=output_width,
            output_height=output_height,
            unsafe=False,
        )
    except (RecursionError, TypeError, ValueError, OSError):
        return SvgPreflightReport(
            verdict="fail",
            eligible_for_submission=False,
            findings=(SvgFinding("universal.readable-file", "SVG could not be rendered safely."),),
            sanitized_svg=None,
            preview_png=None,
        )
    verdict: SvgVerdict = "warning" if findings else "pass"
    return SvgPreflightReport(
        verdict=verdict,
        eligible_for_submission=verdict == "pass",
        findings=tuple(findings),
        sanitized_svg=sanitized_svg,
        preview_png=preview_png,
    )
