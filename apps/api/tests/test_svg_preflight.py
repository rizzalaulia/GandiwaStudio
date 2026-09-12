"""TDD contract for hostile SVG preflight: safe files only get raster previews."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

from PIL import Image

from gandiwa_api.svg_preflight import (
    SvgFinding,
    SvgPreflightLimits,
    SvgPreflightReport,
    inspect_svg,
)

FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "svg-preflight"

SAFE_SVG = b"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <defs><linearGradient id="sky"><stop offset="0" stop-color="#1e90ff"/></linearGradient></defs>
  <path id="bird" d="M 1 8 L 8 1 L 15 8 Z" fill="url(#sky)"/>
</svg>"""


def _svg(body: bytes, *, view_box: bytes = b"0 0 1 1") -> bytes:
    opening = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + view_box + b'">'
    return opening + body + b"</svg>"


def _report(source: bytes, *, limits: SvgPreflightLimits | None = None) -> SvgPreflightReport:
    if limits is None:
        return inspect_svg(
            source,
            declared_mime_type="image/svg+xml",
            filename="candidate.svg",
            content_type="vector",
        )
    return inspect_svg(
        source,
        declared_mime_type="image/svg+xml",
        filename="candidate.svg",
        content_type="vector",
        limits=limits,
    )


def _assert_no_preview(report: SvgPreflightReport, rule_id: str) -> None:
    assert report.verdict == "fail"
    assert report.sanitized_svg is None
    assert report.preview_png is None
    assert report.findings[0].rule_id == rule_id


def test_safe_svg_is_sanitized_and_receives_a_raster_preview() -> None:
    report = _report(SAFE_SVG)

    assert report.verdict == "pass"
    assert report.eligible_for_submission is True
    assert report.preview_png.startswith(b"\x89PNG\r\n\x1a\n")
    assert b"<script" not in report.sanitized_svg.lower()
    assert b"onload=" not in report.sanitized_svg.lower()
    assert report.findings == ()


def test_safe_fixture_raster_preview_matches_expected_parity_pixels() -> None:
    report = _report((FIXTURES / "safe-gradient.svg").read_bytes())
    expected = (FIXTURES / "safe-gradient.expected.png").read_bytes()

    assert report.verdict == "pass"
    assert report.preview_png is not None
    with (
        Image.open(BytesIO(report.preview_png)) as actual_image,
        Image.open(BytesIO(expected)) as expected_image,
    ):
        actual_rgba = actual_image.convert("RGBA")
        expected_rgba = expected_image.convert("RGBA")
        assert actual_rgba.size == expected_rgba.size
        assert actual_rgba.tobytes() == expected_rgba.tobytes()


def test_svg_script_is_rejected_before_any_preview_is_created() -> None:
    report = _report(_svg(b"<script>alert(1)</script>"))

    assert report.verdict == "fail"
    assert report.eligible_for_submission is False
    assert report.sanitized_svg is None
    assert report.preview_png is None
    assert report.findings == (
        SvgFinding(
            rule_id="vector.no-active-content",
            message="SVG contains active content that is not allowed before preview.",
        ),
    )


def test_svg_event_handler_is_rejected_before_any_preview_is_created() -> None:
    _assert_no_preview(
        _report(_svg(b'<path d="M0 0" onload="alert(1)"/>')), "vector.no-active-content"
    )


def test_svg_dtd_or_entity_is_rejected_before_xml_parser_or_preview() -> None:
    source = b'<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' + _svg(
        b'<path d="M0 0"/>'
    )
    _assert_no_preview(_report(source), "vector.no-active-content")


def test_svg_utf16_dtd_is_rejected_before_preview() -> None:
    source = (
        '<?xml version="1.0" encoding="UTF-16"?>'
        '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0"/></svg>'
    ).encode("utf-16")

    _assert_no_preview(_report(source), "vector.no-active-content")


def test_svg_processing_instruction_is_rejected_without_crashing_or_preview() -> None:
    source = _svg(b'<?xml-stylesheet href="https://evil.test/style.css"?><path d="M0 0"/>')

    _assert_no_preview(_report(source), "vector.no-active-content")


def test_svg_external_processing_instruction_before_root_is_rejected_without_preview() -> None:
    source = b'<?xml-stylesheet type="text/css" href="https://evil.test/style.css"?>' + _svg(
        b'<path d="M0 0"/>'
    )

    _assert_no_preview(_report(source), "vector.no-active-content")


def test_svg_external_resource_is_rejected_before_any_preview_is_created() -> None:
    _assert_no_preview(
        _report(_svg(b'<image href="https://example.test/a.png"/>')), "vector.no-raster"
    )


def test_svg_foreign_object_is_rejected_before_any_preview_is_created() -> None:
    body = (
        b'<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">unsafe</body></foreignObject>'
    )
    _assert_no_preview(_report(_svg(body)), "vector.no-active-content")


def test_svg_external_use_reference_is_rejected_before_any_preview_is_created() -> None:
    _assert_no_preview(
        _report(_svg(b'<use href="https://example.test/external.svg#shape"/>')),
        "vector.no-external-resource",
    )


def test_svg_broken_local_reference_fails_without_preview() -> None:
    _assert_no_preview(
        _report(_svg(b'<path d="M0 0" fill="url(#missing)"/>')),
        "vector.resolved-references",
    )


def test_svg_use_is_rejected_before_renderer_expansion() -> None:
    _assert_no_preview(_report(_svg(b'<use href="#shape"/>')), "vector.valid-document")


def test_svg_self_referential_use_is_rejected_before_renderer_expansion() -> None:
    _assert_no_preview(_report(_svg(b'<use id="self" href="#self"/>')), "vector.valid-document")


def test_svg_cyclic_use_references_are_rejected_before_renderer_expansion() -> None:
    _assert_no_preview(
        _report(_svg(b'<use id="first" href="#second"/><use id="second" href="#first"/>')),
        "vector.valid-document",
    )


def test_svg_excessively_deep_acyclic_use_chain_fails_without_preview() -> None:
    body = (
        b"".join(
            f'<use id="node-{index}" href="#node-{index + 1}"/>'.encode() for index in range(130)
        )
        + b'<g id="node-130"/>'
    )

    _assert_no_preview(_report(_svg(body)), "vector.valid-document")


def test_svg_nested_use_chain_fails_before_renderer_expansion() -> None:
    body = (
        b'<g id="second"><path d="M0 0"/></g>'
        b'<g id="first"><use href="#second"/></g><use href="#first"/>'
    )

    _assert_no_preview(_report(_svg(body)), "vector.valid-document")


def test_svg_renderer_type_error_fails_without_preview(monkeypatch) -> None:
    import gandiwa_api.svg_preflight as svg_preflight_module

    def raise_type_error(**_kwargs: object) -> bytes:
        raise TypeError("renderer rejected SVG")

    monkeypatch.setattr(svg_preflight_module.cairosvg, "svg2png", raise_type_error)

    _assert_no_preview(_report(SAFE_SVG), "universal.readable-file")


def test_svg_empty_path_fails_without_preview() -> None:
    _assert_no_preview(_report(_svg(b'<path d="   "/>')), "vector.no-empty-path")


def test_svg_external_url_paint_server_fails_without_preview() -> None:
    body = b'<path d="M0 0" fill="url(https://example.test/paint.svg#gradient)"/>'
    _assert_no_preview(_report(_svg(body)), "vector.no-external-resource")


def test_svg_broken_local_url_reference_fails_without_preview() -> None:
    _assert_no_preview(
        _report(_svg(b'<path d="M0 0" fill="url(#missing)"/>')), "vector.resolved-references"
    )


def test_svg_invalid_view_box_fails_without_preview() -> None:
    _assert_no_preview(
        _report(_svg(b'<path d="M0 0"/>', view_box=b"0 0 0 1")), "vector.valid-document"
    )


def test_svg_unknown_attribute_fails_without_preview() -> None:
    _assert_no_preview(_report(_svg(b'<path d="M0 0" data-unsafe="1"/>')), "vector.valid-document")


def test_svg_inline_style_fails_without_preview() -> None:
    _assert_no_preview(
        _report(_svg(b'<path d="M0 0" style="fill:#000"/>')), "vector.no-external-resource"
    )


def test_svg_unsupported_element_fails_without_preview() -> None:
    _assert_no_preview(_report(_svg(b'<discard begin="0s"/>')), "vector.valid-document")


def test_svg_animation_element_fails_without_preview() -> None:
    body = b'<path d="M0 0"><animate attributeName="d" values="M0 0;M1 1"/></path>'
    _assert_no_preview(_report(_svg(body)), "vector.no-active-content")


def test_svg_live_text_fails_without_preview() -> None:
    _assert_no_preview(
        _report(_svg(b'<text x="0" y="1">unsafe font dependency</text>')),
        "vector.no-live-text",
    )


def test_svg_depth_limit_fails_before_preview() -> None:
    report = _report(
        _svg(b'<g><g><path d="M0 0"/></g></g>'),
        limits=SvgPreflightLimits(max_depth=2),
    )

    _assert_no_preview(report, "SVG_RESOURCE_LIMIT")


def test_svg_node_count_limit_warns_but_keeps_a_raster_preview() -> None:
    report = _report(
        _svg(b'<path d="M0 0"/><path d="M1 1"/>'),
        limits=SvgPreflightLimits(max_nodes=2),
    )

    assert report.verdict == "warning"
    assert report.eligible_for_submission is False
    assert report.sanitized_svg is not None
    assert report.preview_png is not None
    assert report.findings[0].rule_id == "vector.node-count"


def test_svg_view_box_output_limit_fails_before_preview() -> None:
    report = _report(
        _svg(b'<path d="M0 0"/>', view_box=b"0 0 100 100"),
        limits=SvgPreflightLimits(max_output_pixels=9),
    )

    _assert_no_preview(report, "SVG_RESOURCE_LIMIT")


def test_svg_byte_limit_fails_before_parse_or_preview() -> None:
    report = _report(SAFE_SVG, limits=SvgPreflightLimits(max_bytes=len(SAFE_SVG) - 1))

    _assert_no_preview(report, "SVG_RESOURCE_LIMIT")
