import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import fitz


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "verify_translation.py"
SPEC = importlib.util.spec_from_file_location("verify_translation", SCRIPT_PATH)
VERIFY_MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(VERIFY_MODULE)

FIXTURE_SPEC = importlib.util.spec_from_file_location(
    "generate_pdf_translation_fixtures",
    REPO_ROOT / "tests" / "pdf-translate" / "generate_fixtures.py",
)
FIXTURE_MODULE = importlib.util.module_from_spec(FIXTURE_SPEC)
assert FIXTURE_SPEC.loader is not None
FIXTURE_SPEC.loader.exec_module(FIXTURE_MODULE)
FIXTURE_MODULE.register_fonts()


# A tiny opaque PNG is enough to exercise decoded-image occurrence hashing.
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def solid_png(rgb):
    pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 4, 4), False)
    for y in range(4):
        for x in range(4):
            pixmap.set_pixel(x, y, rgb)
    return pixmap.tobytes("png")


RED_PNG = solid_png((255, 0, 0))
BLUE_PNG = solid_png((0, 0, 255))


def make_pdf(path, pages):
    """Create a deterministic PDF from small page specifications."""

    document = fitz.open()
    for spec in pages:
        page = document.new_page(
            width=spec.get("width", 612),
            height=spec.get("height", 792),
        )
        text = spec.get("text", "")
        if text:
            page.insert_text(
                (72, 72),
                text,
                fontsize=spec.get("fontsize", 11),
                fontname=spec.get("fontname", "helv"),
            )
        for placement in spec.get("placements", []):
            page.insert_text(
                placement.get("point", (72, 72)),
                placement["text"],
                fontsize=placement.get("fontsize", spec.get("fontsize", 11)),
                fontname=placement.get("fontname", spec.get("fontname", "helv")),
            )
        image_streams = spec.get("image_streams")
        if image_streams is None:
            image_streams = [PNG_BYTES] * spec.get("images", 0)
        for index, image_stream in enumerate(image_streams):
            if spec.get("full_page_image"):
                image_rect = page.rect
            else:
                top = 110 + index * 70
                image_rect = fitz.Rect(72, top, 132, top + 60)
            page.insert_image(image_rect, stream=image_stream)
        if spec.get("black_page"):
            page.draw_rect(page.rect, color=(0, 0, 0), fill=(0, 0, 0), overlay=True)
        if spec.get("vector_color"):
            color = spec["vector_color"]
            page.draw_rect(
                fitz.Rect(100, 150, 500, 500),
                color=color,
                fill=color,
                overlay=True,
            )
            page.draw_line(
                fitz.Point(100, 500),
                fitz.Point(500, 150),
                color=(0, 0, 0),
                width=8,
                overlay=True,
            )
        for uri in spec.get("links", []):
            page.insert_link(
                {
                    "kind": fitz.LINK_URI,
                    "from": fitz.Rect(72, 82, 300, 100),
                    "uri": uri,
                }
            )
        if spec.get("rotation"):
            page.set_rotation(spec["rotation"])
        if spec.get("cropbox"):
            page.set_cropbox(fitz.Rect(*spec["cropbox"]))
    document.save(path, garbage=4, deflate=True)
    document.close()


def make_dense_text_overlay_pdf(path, overlay_rect=None, overlay_color=(0, 0, 0)):
    """Build a dense text block, optionally covered by an opaque overlay.

    The extracted block bbox is intentionally broad.  This reproduces the
    class of attack where a block-level text mask can hide a large visual
    corruption even though the text objects remain extractable underneath it.
    """

    document = fitz.open()
    page = document.new_page(width=612, height=792)
    text = "Invariant source text 12.5 kg must stay exact. " * 120
    remaining = page.insert_textbox(
        fitz.Rect(36, 36, 576, 756),
        text,
        fontsize=8,
        fontname="helv",
        lineheight=1.1,
    )
    if remaining < 0:
        raise AssertionError("dense synthetic text did not fit")
    if overlay_rect is not None:
        page.draw_rect(
            fitz.Rect(overlay_rect),
            color=None,
            fill=overlay_color,
            overlay=True,
        )
    document.save(path, garbage=4, deflate=True)
    document.close()


def rewrite_fixture_internal_link(
    source,
    output,
    *,
    delete=False,
    target_page=None,
    rect_shift=(0, 0),
    add_unsafe=False,
    destination_container="Dest",
    destination_view="Fit",
    destination_arguments=(),
):
    document = fitz.open(source)
    found = None
    for page in document:
        for link in page.get_links():
            if link.get("kind") in {fitz.LINK_GOTO, fitz.LINK_NAMED}:
                found = (page, link)
                break
        if found:
            break
    assert found is not None, "fixture internal link not found"
    page, link = found
    page.delete_link(link)
    if not delete:
        rect = fitz.Rect(link["from"])
        rect.x0 += rect_shift[0]
        rect.x1 += rect_shift[0]
        rect.y0 += rect_shift[1]
        rect.y1 += rect_shift[1]
        before_xrefs = {
            int(item.get("xref") or 0) for item in page.get_links() if item.get("xref")
        }
        xref_floor = document.xref_length()
        resolved_target = 0 if target_page is None else target_page
        page.insert_link(
            {
                "kind": fitz.LINK_GOTO,
                "from": rect,
                "page": resolved_target,
                "to": fitz.Point(0, 0),
            }
        )
        inserted = [
            int(item.get("xref") or 0)
            for item in page.get_links()
            if item.get("xref") and int(item["xref"]) not in before_xrefs
        ]
        if len(inserted) != 1:
            inserted = []
            for xref in range(xref_floor, document.xref_length()):
                subtype_type, subtype = document.xref_get_key(xref, "Subtype")
                if subtype_type == "name" and subtype == "/Link":
                    inserted.append(xref)
        assert len(inserted) == 1, inserted
        xref = inserted[0]
        arguments = " ".join(
            "null" if value is None else str(value) for value in destination_arguments
        )
        destination = (
            f"[{document.page_xref(resolved_target)} 0 R /{destination_view}"
            + (f" {arguments}" if arguments else "")
            + "]"
        )
        if destination_container == "Dest":
            document.xref_set_key(xref, "A", "null")
            document.xref_set_key(xref, "Dest", destination)
        else:
            document.xref_set_key(xref, "Dest", "null")
            document.xref_set_key(xref, "A/S", "/GoTo")
            document.xref_set_key(xref, "A/D", destination)
    if add_unsafe:
        page.insert_link(
            {
                "kind": fitz.LINK_URI,
                "from": fitz.Rect(300, 300, 440, 320),
                "uri": "javascript:alert(1)",
            }
        )
        page.insert_link(
            {
                "kind": fitz.LINK_URI,
                "from": fitz.Rect(300, 330, 440, 350),
                "uri": "file:///tmp/unsafe-link",
            }
        )
        page.insert_link(
            {
                "kind": fitz.LINK_LAUNCH,
                "from": fitz.Rect(300, 360, 440, 380),
                "file": "/tmp/unsafe-launch",
            }
        )
    document.save(output, garbage=4, deflate=True)
    document.close()


class VerifyTranslationTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)

    def tearDown(self):
        self.tempdir.cleanup()

    def paths(self):
        return self.root / "source.pdf", self.root / "translated.pdf"

    def assert_gate(self, report, name, status):
        self.assertIn(name, report["gates"])
        self.assertEqual(report["gates"][name]["status"], status, report["gates"][name])

    def test_valid_inplace_pair_passes_stable_contract(self):
        source, output = self.paths()
        url = "https://example.com/data?run=7"
        make_pdf(source, [{"text": f"Mass 12.5 kg. {url}", "links": [url]}])
        make_pdf(output, [{"text": f"Result 12.5 kg. {url}", "links": [url]}])

        report = VERIFY_MODULE.verify(str(output), str(source))

        self.assertTrue(report["passed"])
        self.assertEqual(report["hard_failures"], [])
        self.assertEqual(report["exit_code"], 0)
        self.assertEqual(report["schema_version"], 2)
        for gate in (
            "pdf_open",
            "page_correspondence",
            "page_render",
            "blank_pages",
            "black_pages",
            "nontext_visual_preservation",
            "vector_provenance",
            "content_coverage",
            "page_order",
            "number_preservation",
            "unit_preservation",
            "chemical_formula_preservation",
            "url_preservation",
            "image_duplicates",
            "link_preservation",
        ):
            self.assert_gate(report, gate, "pass")

    def test_page_count_size_and_rotation_are_hard_failures(self):
        cases = {
            "count": (
                [{"text": "Source"}],
                [{"text": "Output"}, {"text": "Extra"}],
            ),
            "size": (
                [{"text": "Source", "width": 612, "height": 792}],
                [{"text": "Output", "width": 500, "height": 792}],
            ),
            "rotation": (
                [{"text": "Source", "rotation": 90}],
                [{"text": "Output", "rotation": 0}],
            ),
            "cropbox": (
                [{"text": "Source"}],
                [{"text": "Output", "cropbox": (0, 0, 500, 700)}],
            ),
        }
        for name, (source_pages, output_pages) in cases.items():
            with self.subTest(name=name):
                source = self.root / f"{name}-source.pdf"
                output = self.root / f"{name}-output.pdf"
                make_pdf(source, source_pages)
                make_pdf(output, output_pages)
                report = VERIFY_MODULE.verify(str(output), str(source))
                self.assertFalse(report["passed"])
                self.assert_gate(report, "page_correspondence", "fail")
                self.assertIn("page_correspondence", report["hard_failures"])

    def test_inplace_stable_identifier_large_horizontal_drift_is_hard_failure(self):
        source, output = self.paths()
        make_pdf(
            source,
            [{"placements": [{"point": (470, 72), "text": "FIXTURE-TEXT-001"}]}],
        )
        make_pdf(
            output,
            [{"placements": [{"point": (72, 72), "text": "FIXTURE-TEXT-001"}]}],
        )

        report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")

        self.assert_gate(report, "page_correspondence", "fail")
        anchors = report["gates"]["page_correspondence"]["details"]["stable_anchors"]
        self.assertFalse(anchors["matched"])
        mismatch = next(item for item in anchors["mismatches"] if item["token"] == "FIXTURE-TEXT-001")
        self.assertGreater(mismatch["pairs"][0]["dx"], 300)

    def test_inplace_stable_anchors_allow_local_reflow_and_real_line_wrap(self):
        source, output = self.paths()
        make_pdf(
            source,
            [{
                "placements": [
                    {"point": (72, 120), "text": "Mass 12.50 g"},
                    {"point": (470, 220), "text": "sample A-17"},
                ]
            }],
        )
        make_pdf(
            output,
            [{
                "placements": [
                    {"point": (112, 145), "text": "result 12.50 g"},
                    {"point": (72, 235), "text": "sample A-17"},
                ]
            }],
        )

        report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")

        self.assert_gate(report, "page_correspondence", "pass")
        anchors = report["gates"]["page_correspondence"]["details"]["stable_anchors"]
        self.assertTrue(anchors["matched"])
        self.assertGreaterEqual(anchors["checked_occurrences"], 2)

    def test_duplicate_stable_anchor_occurrences_use_optimal_matching(self):
        source_rects = [
            fitz.Rect(450, 90, 500, 105),
            fitz.Rect(72, 390, 122, 405),
        ]
        output_rects = [
            fitz.Rect(76, 392, 126, 407),
            fitz.Rect(446, 92, 496, 107),
        ]

        comparison = VERIFY_MODULE._match_anchor_occurrences(
            source_rects,
            output_rects,
            612,
        )

        self.assertTrue(comparison["matched"])
        self.assertEqual(
            [(item["source_occurrence"], item["output_occurrence"]) for item in comparison["pairs"]],
            [(1, 2), (2, 1)],
        )

    def test_repeated_scientific_literal_allows_same_row_translation_reflow(self):
        source = [
            fitz.Rect(353, 80, 393, 95),
            fitz.Rect(357, 104, 397, 119),
        ]
        output = [
            fitz.Rect(99, 80, 139, 94),
            fitz.Rect(288, 104, 328, 118),
        ]

        comparison = VERIFY_MODULE._match_anchor_occurrences(
            source,
            output,
            595.276,
            anchor_kinds=["number_unit"],
        )

        self.assertTrue(comparison["matched"], comparison)
        self.assertEqual(comparison["reason"], "repeated_literal_same_row_reflow")

    def test_stable_anchor_boundary_and_line_wrap_policy(self):
        source = fitz.Rect(72, 90, 112, 105)
        within_50 = VERIFY_MODULE._anchor_pair_metrics(
            source,
            fitz.Rect(102, 130, 142, 145),
            612,
        )
        over_50 = VERIFY_MODULE._anchor_pair_metrics(
            source,
            fitz.Rect(103, 130, 143, 145),
            612,
        )
        line_wrap = VERIFY_MODULE._anchor_pair_metrics(
            fitz.Rect(470, 200, 520, 215),
            fitz.Rect(72, 215, 122, 230),
            612,
        )

        self.assertTrue(within_50["matched"])
        self.assertEqual(within_50["reason"], "local_reflow")
        self.assertFalse(over_50["matched"])
        self.assertEqual(over_50["reason"], "large_drift")
        self.assertTrue(line_wrap["matched"])
        self.assertEqual(line_wrap["reason"], "line_wrap")

    def test_same_baseline_horizontal_reflow_allows_100pt_but_rejects_170pt(self):
        source = fitz.Rect(300, 180, 350, 195)
        same_line_100 = VERIFY_MODULE._anchor_pair_metrics(
            source,
            fitz.Rect(200, 180, 250, 195),
            595,
        )
        same_line_170 = VERIFY_MODULE._anchor_pair_metrics(
            source,
            fitz.Rect(130, 180, 180, 195),
            595,
        )

        self.assertTrue(same_line_100["matched"])
        self.assertEqual(same_line_100["reason"], "same_line_reflow")
        self.assertEqual(same_line_100["same_line_limit"], 148.75)
        self.assertFalse(same_line_170["matched"])
        self.assertEqual(same_line_170["reason"], "large_drift")

    def test_formula_glyph_stack_reflow_requires_formula_type_and_same_visual_row(self):
        # A subscript fragment can sit almost below the translated base glyph:
        # centre dy exceeds the ordinary baseline tolerance, while the visual
        # glyph boxes still overlap / nearly touch in the same row.
        source = fitz.Rect(180.367, 183.032, 186.824, 196.153)
        output = fitz.Rect(121.516, 166.564, 130.954, 182.060)

        ordinary = VERIFY_MODULE._anchor_pair_metrics(source, output, 595.276)
        formula = VERIFY_MODULE._anchor_pair_metrics(
            source,
            output,
            595.276,
            allow_glyph_stack_reflow=True,
        )

        self.assertFalse(ordinary["matched"])
        self.assertTrue(formula["matched"])
        self.assertEqual(formula["reason"], "glyph_stack_reflow")
        self.assertLessEqual(
            formula["vertical_edge_gap"],
            VERIFY_MODULE.STABLE_ANCHOR_GLYPH_STACK_MAX_EDGE_GAP_PT,
        )

        source_stack = [
            fitz.Rect(170.916, 174.628, 180.367, 190.136),
            source,
        ]
        output_stack = [
            output,
            fitz.Rect(131.000, 172.847, 136.027, 183.075),
        ]
        restricted = VERIFY_MODULE._match_anchor_occurrences(
            source_stack,
            output_stack,
            595.276,
            anchor_kinds=["identifier"],
        )
        allowed = VERIFY_MODULE._match_anchor_occurrences(
            source_stack,
            output_stack,
            595.276,
            anchor_kinds=["chemical_formula"],
        )
        self.assertFalse(restricted["matched"])
        self.assertTrue(allowed["matched"])

        # A formula type by itself is insufficient: both source and output
        # must carry touching fragments with real baseline / height differences.
        unsupported_singleton = VERIFY_MODULE._match_anchor_occurrences(
            [source],
            [output],
            595.276,
            anchor_kinds=["chemical_formula"],
        )
        self.assertFalse(unsupported_singleton["matched"])

        # One-sided stack evidence must not license pairing its fragments with
        # nearby plain occurrences.  Both the source and output occurrence
        # need independently observable stacked geometry.
        one_sided_stack = VERIFY_MODULE._match_anchor_occurrences(
            source_stack,
            [
                fitz.Rect(80, 166, 88, 182),
                fitz.Rect(100, 166, 108, 182),
            ],
            595.276,
            anchor_kinds=["chemical_formula"],
        )
        self.assertFalse(one_sided_stack["matched"], one_sided_stack)

    def test_formula_glyph_stack_reflow_rejects_other_row_column_large_move_and_count_change(self):
        source = fitz.Rect(180, 183, 188, 196)
        adversarial = {
            # Same horizontal displacement, but the token moved to a real
            # different row with no vertical glyph-band contact.
            "different_row": fitz.Rect(100, 250, 108, 263),
            # Same visual row, but beyond the unchanged 150pt horizontal cap
            # (representative of migration to another column).
            "different_column": fitz.Rect(29, 181, 37, 194),
            "large_move": fitz.Rect(380, 181, 388, 194),
        }
        for name, output in adversarial.items():
            with self.subTest(name=name):
                comparison = VERIFY_MODULE._match_anchor_occurrences(
                    [source],
                    [output],
                    612,
                    anchor_kinds=["chemical_formula"],
                )
                self.assertFalse(comparison["matched"], comparison)

        count_change = VERIFY_MODULE._match_anchor_occurrences(
            [source, fitz.Rect(220, 183, 228, 196)],
            [fitz.Rect(100, 181, 108, 194)],
            612,
            anchor_kinds=["chemical_formula"],
        )
        self.assertFalse(count_change["matched"])
        self.assertEqual(count_change["reason"], "occurrence_count")

    def test_unexpected_visually_blank_page_fails(self):
        source, output = self.paths()
        make_pdf(source, [{"text": "Visible source content"}])
        make_pdf(output, [{}])

        report = VERIFY_MODULE.verify(str(output), str(source))

        self.assert_gate(report, "blank_pages", "fail")
        self.assertIn("blank_pages", report["hard_failures"])

    def test_raw_marker_garbling_and_untranslated_prose_fail(self):
        source, output = self.paths()
        make_pdf(source, [{"text": "Source"}])
        make_pdf(
            output,
            [
                {
                    "text": (
                        "%%FIG:12%% ft>sec This entire English sentence remains fully "
                        "untranslated and therefore must fail verification"
                    )
                }
            ],
        )

        report = VERIFY_MODULE.verify(str(output), str(source))

        self.assert_gate(report, "raw_markers", "fail")
        self.assert_gate(report, "garbling", "fail")
        self.assert_gate(report, "untranslated_text", "fail")

    def test_long_source_replaced_by_ok_fails_content_coverage(self):
        source, output = self.paths()
        make_pdf(
            source,
            [{"text": "This source paragraph contains substantial explanatory content that must survive translation completely"}],
        )
        make_pdf(output, [{"text": "OK"}])

        report = VERIFY_MODULE.verify(str(output), str(source))

        self.assert_gate(report, "content_coverage", "fail")
        self.assertIn("content_coverage", report["hard_failures"])

    def test_two_pages_reversed_fail_deterministic_order_gate(self):
        source, output = self.paths()
        first = "alpha source page unique"
        second = "beta destination page unique"
        make_pdf(source, [{"text": first}, {"text": second}])
        make_pdf(output, [{"text": second}, {"text": first}])

        report = VERIFY_MODULE.verify(str(output), str(source))

        self.assert_gate(report, "page_order", "fail")
        self.assertIn("page_order", report["hard_failures"])

    def test_missing_number_unit_text_url_and_link_all_fail(self):
        source, output = self.paths()
        url = "https://example.com/measurements?id=42"
        make_pdf(source, [{"text": f"Mass 12.5 kg. {url}", "links": [url]}])
        make_pdf(output, [{"text": "Result unavailable"}])

        report = VERIFY_MODULE.verify(str(output), str(source))

        for gate in (
            "number_preservation",
            "unit_preservation",
            "url_preservation",
            "link_preservation",
        ):
            self.assert_gate(report, gate, "fail")
            self.assertIn(gate, report["hard_failures"])

    def test_fixture01_explicit_fit_destination_is_preserved_exactly(self):
        source, output = self.paths()
        FIXTURE_MODULE.generate_text_links(source)
        rewrite_fixture_internal_link(source, output)

        report = VERIFY_MODULE.verify(str(output), str(source), intent="restore")

        self.assert_gate(report, "link_preservation", "pass")
        details = report["gates"]["link_preservation"]["details"]
        self.assertEqual(details["internal"]["source_count"], 1)
        self.assertEqual(details["internal"]["output_count"], 1)
        match = details["internal"]["matches"][0]
        self.assertEqual(match["target_page"], 1)
        self.assertEqual(match["destination_container"], "Dest")
        self.assertEqual(match["destination_view"], "Fit")
        self.assertEqual(match["destination_arguments"], [])
        self.assertEqual(details["uri"]["missing_count"], 0)
        self.assertEqual(details["uri"]["unexpected_count"], 0)
        self.assertTrue(report["passed"], report["hard_failures"])

    def test_fixture01_round1_fit_to_xyz_action_downgrade_fails(self):
        source, output = self.paths()
        FIXTURE_MODULE.generate_text_links(source)
        rewrite_fixture_internal_link(
            source,
            output,
            destination_container="A/D",
            destination_view="XYZ",
            destination_arguments=(0, 0, 0),
        )

        report = VERIFY_MODULE.verify(str(output), str(source), intent="restore")

        self.assert_gate(report, "link_preservation", "fail")
        internal = report["gates"]["link_preservation"]["details"]["internal"]
        self.assertEqual(
            internal["unmatched_source"][0]["best_semantics"],
            "destination_container_changed",
        )

    def test_fixture01_direct_destination_cannot_become_action_destination(self):
        source, output = self.paths()
        FIXTURE_MODULE.generate_text_links(source)
        rewrite_fixture_internal_link(
            source,
            output,
            destination_container="A/D",
            destination_view="Fit",
        )

        report = VERIFY_MODULE.verify(str(output), str(source), intent="restore")

        self.assert_gate(report, "link_preservation", "fail")
        internal = report["gates"]["link_preservation"]["details"]["internal"]
        self.assertEqual(
            internal["unmatched_source"][0]["best_semantics"],
            "destination_container_changed",
        )

    def test_xyz_destination_x_y_zoom_and_null_changes_fail(self):
        fixture = self.root / "fixture01.pdf"
        FIXTURE_MODULE.generate_text_links(fixture)
        cases = {
            "x": ((120, 240, 1.25), (121, 240, 1.25)),
            "y": ((120, 240, 1.25), (120, 241, 1.25)),
            "zoom": ((120, 240, 1.25), (120, 240, 1.5)),
            "null": ((None, 240, 1.25), (120, 240, 1.25)),
        }
        for name, (source_arguments, output_arguments) in cases.items():
            with self.subTest(name=name):
                source = self.root / f"xyz-{name}-source.pdf"
                output = self.root / f"xyz-{name}-output.pdf"
                rewrite_fixture_internal_link(
                    fixture,
                    source,
                    destination_container="A/D",
                    destination_view="XYZ",
                    destination_arguments=source_arguments,
                )
                rewrite_fixture_internal_link(
                    source,
                    output,
                    destination_container="A/D",
                    destination_view="XYZ",
                    destination_arguments=output_arguments,
                )

                report = VERIFY_MODULE.verify(str(output), str(source), intent="restore")

                self.assert_gate(report, "link_preservation", "fail")
                internal = report["gates"]["link_preservation"]["details"]["internal"]
                self.assertEqual(
                    internal["unmatched_source"][0]["best_semantics"],
                    "destination_arguments_changed",
                )

    def test_fith_fitv_fitr_destination_arity_changes_fail_closed(self):
        fixture = self.root / "fixture01.pdf"
        FIXTURE_MODULE.generate_text_links(fixture)
        cases = {
            "FitH": ((120,), (120, 240)),
            "FitV": ((80,), ()),
            "FitR": ((10, 20, 300, 400), (10, 20, 300)),
        }
        for view, (source_arguments, output_arguments) in cases.items():
            with self.subTest(view=view):
                source = self.root / f"{view}-source.pdf"
                output = self.root / f"{view}-output.pdf"
                rewrite_fixture_internal_link(
                    fixture,
                    source,
                    destination_container="Dest",
                    destination_view=view,
                    destination_arguments=source_arguments,
                )
                rewrite_fixture_internal_link(
                    source,
                    output,
                    destination_container="Dest",
                    destination_view=view,
                    destination_arguments=output_arguments,
                )

                report = VERIFY_MODULE.verify(str(output), str(source), intent="restore")

                self.assert_gate(report, "link_preservation", "fail")
                details = report["gates"]["link_preservation"]["details"]
                self.assertTrue(
                    details["unsafe_output"] or details["internal"]["unmatched_source"],
                    details,
                )

    def test_named_source_may_normalize_to_safe_explicit_destination(self):
        source = {
            "source_page": 1,
            "target_page": 2,
            "rect": [72.0, 82.0, 180.0, 100.0],
            "destination_container": "named",
            "destination_view": "named",
            "destination_arguments": [],
            "named_resolved": True,
        }
        output = {
            "source_page": 1,
            "target_page": 2,
            "rect": [72.0, 82.0, 180.0, 100.0],
            "destination_container": "Dest",
            "destination_view": "Fit",
            "destination_arguments": [],
            "named_resolved": False,
        }

        comparison = VERIFY_MODULE._compare_internal_links([source], [output])

        self.assertTrue(comparison["matched"], comparison)
        self.assertEqual(
            comparison["matches"][0]["semantic_equivalence"],
            "named_source_resolved_to_safe_target",
        )

    def test_fixture01_internal_link_deletion_target_and_rect_changes_fail(self):
        fixture = self.root / "fixture01.pdf"
        FIXTURE_MODULE.generate_text_links(fixture)

        # Add a second page to both sides so a valid but wrong target exists.
        source = self.root / "fixture01-two-pages.pdf"
        with fitz.open(fixture) as document:
            second = document.new_page()
            second.insert_text((72, 72), "Second destination page")
            document.save(source, garbage=4, deflate=True)

        cases = {
            "deleted": {"delete": True},
            "wrong-target": {"target_page": 1},
            "moved-rect": {"rect_shift": (12, 0)},
        }
        for name, options in cases.items():
            with self.subTest(name=name):
                output = self.root / f"fixture01-{name}.pdf"
                rewrite_fixture_internal_link(source, output, **options)
                report = VERIFY_MODULE.verify(str(output), str(source), intent="restore")
                self.assert_gate(report, "link_preservation", "fail")
                internal = report["gates"]["link_preservation"]["details"]["internal"]
                self.assertTrue(internal["unmatched_source"])
                self.assertFalse(report["passed"])

    def test_unsafe_output_link_actions_are_always_rejected(self):
        source, output = self.paths()
        FIXTURE_MODULE.generate_text_links(source)
        rewrite_fixture_internal_link(source, output, add_unsafe=True)

        report = VERIFY_MODULE.verify(str(output), str(source), intent="restore")

        self.assert_gate(report, "link_preservation", "fail")
        unsafe = report["gates"]["link_preservation"]["details"]["unsafe_output"]
        self.assertGreaterEqual(len(unsafe), 3)
        self.assertIn("unsafe_uri", {item["kind"] for item in unsafe})
        self.assertTrue({"launch", "remote_goto"} & {item["kind"] for item in unsafe})

    def test_uri_action_allowlist_matches_renderer_policy(self):
        allowed = [
            "http://example.com/plain",
            "https://example.com/secure",
            "mailto:reviewer@example.com",
            "HTTPS://example.com/case-insensitive",
        ]
        blocked = [
            "ftp://example.com/archive",
            "ssh://example.com/session",
            "custom-handler:payload",
            "javascript:alert(1)",
            "file:///tmp/unsafe",
        ]

        for uri in allowed:
            with self.subTest(uri=uri, expected="allowed"):
                self.assertTrue(VERIFY_MODULE._safe_external_uri(uri))
        for uri in blocked + ["relative/path", " https://example.com/space"]:
            with self.subTest(uri=uri, expected="blocked"):
                self.assertFalse(VERIFY_MODULE._safe_external_uri(uri))

    def test_disallowed_source_uri_actions_may_be_removed_by_policy(self):
        source, output = self.paths()
        allowed = [
            "https://example.com/secure",
            "mailto:reviewer@example.com",
        ]
        blocked = [
            "ftp://example.com/archive",
            "ssh://example.com/session",
            "custom-handler:payload",
        ]
        make_pdf(source, [{"text": "URI action policy", "links": allowed + blocked}])
        make_pdf(output, [{"text": "URI action policy", "links": allowed}])

        report = VERIFY_MODULE.verify(str(output), str(source), intent="restore")

        self.assert_gate(report, "link_preservation", "pass")
        details = report["gates"]["link_preservation"]["details"]
        self.assertEqual(
            {item["uri"] for item in details["unsafe_source_removed_by_policy"]},
            set(blocked),
        )
        self.assertEqual(details["unsafe_output"], [])
        self.assertTrue(report["passed"], report["hard_failures"])

    def test_disallowed_output_uri_actions_fail_closed(self):
        for index, uri in enumerate(
            (
                "ftp://example.com/archive",
                "ssh://example.com/session",
                "custom-handler:payload",
            )
        ):
            with self.subTest(uri=uri):
                source = self.root / f"blocked-uri-{index}-source.pdf"
                output = self.root / f"blocked-uri-{index}-output.pdf"
                make_pdf(source, [{"text": "URI action policy"}])
                make_pdf(output, [{"text": "URI action policy", "links": [uri]}])

                report = VERIFY_MODULE.verify(str(output), str(source), intent="restore")

                self.assert_gate(report, "link_preservation", "fail")
                unsafe = report["gates"]["link_preservation"]["details"][
                    "unsafe_output"
                ]
                self.assertEqual(unsafe[0]["kind"], "unsafe_uri")
                self.assertEqual(unsafe[0]["uri"], uri)
                self.assertFalse(report["passed"])

    def test_url_followed_by_a_sentence_is_not_accidentally_joined(self):
        for separator in (" ", "\n"):
            with self.subTest(separator=repr(separator)):
                text = f"Read https://example.com/path.{separator}Next sentence starts here."
                self.assertEqual(VERIFY_MODULE.extract_urls(text), ["https://example.com/path"])

    def test_url_domain_wrapped_after_dot_is_rejoined(self):
        text = "Read https://example.\ncom/path for details."
        self.assertEqual(VERIFY_MODULE.extract_urls(text), ["https://example.com/path"])

    def test_new_duplicate_image_placement_fails(self):
        source, output = self.paths()
        make_pdf(source, [{"text": "First", "images": 1}, {"text": "Second"}])
        make_pdf(output, [{"text": "First", "images": 1}, {"text": "Second", "images": 1}])

        report = VERIFY_MODULE.verify(str(output), str(source))

        self.assert_gate(report, "image_duplicates", "fail")
        self.assertEqual(report["summary"]["suspicious_duplicate_image_groups"], 1)
        self.assertIn("image_duplicates", report["hard_failures"])

    def test_source_duplicate_image_placement_is_allowed(self):
        source, output = self.paths()
        pages = [{"text": "First", "images": 1}, {"text": "Second", "images": 1}]
        make_pdf(source, pages)
        make_pdf(output, pages)

        report = VERIFY_MODULE.verify(str(output), str(source))

        self.assert_gate(report, "image_duplicates", "pass")
        self.assertEqual(report["summary"]["duplicate_image_groups"], 1)

    def test_inplace_image_pixel_mutation_fails_preservation(self):
        source, output = self.paths()
        make_pdf(source, [{"text": "Image", "image_streams": [RED_PNG]}])
        make_pdf(output, [{"text": "Image", "image_streams": [BLUE_PNG]}])

        report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")

        self.assert_gate(report, "image_preservation", "fail")
        self.assertIn("image_preservation", report["hard_failures"])

    def test_retypeset_cannot_delete_all_content_images(self):
        source, output = self.paths()
        make_pdf(source, [{"text": "Figure", "image_streams": [RED_PNG]}])
        make_pdf(output, [{"text": "Figure"}])

        report = VERIFY_MODULE.verify(str(output), str(source), mode="retypeset")

        self.assert_gate(report, "image_preservation", "fail")
        self.assertIn("image_preservation", report["hard_failures"])

    def test_retypeset_rejects_unrelated_same_count_image(self):
        source, output = self.paths()
        make_pdf(source, [{"text": "Image", "image_streams": [RED_PNG]}])
        make_pdf(output, [{"text": "Image", "image_streams": [BLUE_PNG]}])

        report = VERIFY_MODULE.verify(str(output), str(source), mode="retypeset")

        self.assert_gate(report, "image_preservation", "fail")
        self.assertTrue(report["gates"]["image_preservation"]["details"]["needs_visual_review"])

    def test_retypeset_requires_one_to_one_image_preservation(self):
        source, output = self.paths()
        make_pdf(source, [{"text": "Images", "image_streams": [RED_PNG, BLUE_PNG]}])
        make_pdf(output, [{"text": "Images", "image_streams": [RED_PNG]}])

        report = VERIFY_MODULE.verify(str(output), str(source), mode="retypeset")

        self.assert_gate(report, "image_preservation", "fail")
        details = report["gates"]["image_preservation"]["details"]
        self.assertEqual(details["required_preservation_ratio"], 1.0)
        self.assertEqual(len(details["unmatched"]), 1)

    def test_full_page_scan_exact_identity_passes_and_changed_output_fails(self):
        for mode in ("inplace", "retypeset"):
            with self.subTest(mode=mode):
                source = self.root / f"scan-{mode}-source.pdf"
                exact = self.root / f"scan-{mode}-exact.pdf"
                changed = self.root / f"scan-{mode}-changed.pdf"
                make_pdf(source, [{"image_streams": [RED_PNG], "full_page_image": True}])
                make_pdf(exact, [{"image_streams": [RED_PNG], "full_page_image": True}])
                make_pdf(changed, [{"black_page": True}])

                exact_report = VERIFY_MODULE.verify(str(exact), str(source), mode=mode)
                changed_report = VERIFY_MODULE.verify(str(changed), str(source), mode=mode)

                self.assert_gate(exact_report, "image_preservation", "pass")
                self.assertTrue(exact_report["passed"], exact_report["hard_failures"])
                self.assert_gate(changed_report, "image_preservation", "fail")
                self.assert_gate(changed_report, "black_pages", "fail")
                details = changed_report["gates"]["image_preservation"]["details"]
                self.assertEqual(details["source_full_page_rasters"], 1)

    def test_retypeset_full_page_scans_must_keep_page_order(self):
        source, output = self.paths()
        make_pdf(
            source,
            [
                {"image_streams": [RED_PNG], "full_page_image": True},
                {"image_streams": [BLUE_PNG], "full_page_image": True},
            ],
        )
        make_pdf(
            output,
            [
                {"image_streams": [BLUE_PNG], "full_page_image": True},
                {"image_streams": [RED_PNG], "full_page_image": True},
            ],
        )

        report = VERIFY_MODULE.verify(str(output), str(source), mode="retypeset")

        self.assert_gate(report, "image_preservation", "fail")
        details = report["gates"]["image_preservation"]["details"]
        self.assertEqual(len(details["unmatched"]), 2)

    def test_inplace_nontext_visual_gate_rejects_vector_loss_recolor_and_black_overlay(self):
        source = self.root / "vector-source.pdf"
        make_pdf(source, [{"text": "Result value 5 kg", "vector_color": (1, 0, 0)}])
        cases = {
            "deleted": {"text": "Result value 5 kg"},
            "recolored": {"text": "Result value 5 kg", "vector_color": (0, 0, 1)},
            "black": {"text": "Result value 5 kg", "black_page": True},
        }
        for name, spec in cases.items():
            with self.subTest(name=name):
                output = self.root / f"vector-{name}.pdf"
                make_pdf(output, [spec])
                report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")
                self.assert_gate(report, "nontext_visual_preservation", "fail")
                if name == "black":
                    self.assert_gate(report, "black_pages", "fail")
                self.assertFalse(report["passed"])

    def test_large_black_overlay_cannot_hide_inside_dense_text_block_mask(self):
        source, output = self.paths()
        make_dense_text_overlay_pdf(source)
        # This rectangle sits wholly inside the extracted text-block bbox.  A
        # block-mask-only comparison therefore sees zero changed unmasked
        # pixels, even though roughly 39% of the page is now black.
        make_dense_text_overlay_pdf(output, (36.1, 36.1, 569.9, 387.4))

        report = VERIFY_MODULE.verify(str(output), str(source), intent="restore")

        self.assert_gate(report, "black_pages", "fail")
        black = report["gates"]["black_pages"]["details"]["unexpected"][0]
        self.assertEqual(black["reason"], "severe_darkening")
        self.assertGreater(black["dark_ratio"] - black["source_dark_ratio"], 0.35)

        self.assert_gate(report, "nontext_visual_preservation", "fail")
        mismatch = report["gates"]["nontext_visual_preservation"]["details"]["mismatches"][0]
        self.assertEqual(mismatch["changed_pixel_ratio"], 0.0)
        self.assertTrue(mismatch["catastrophic_global_change"])
        self.assertGreater(mismatch["global_large_change_ratio"], 0.35)
        self.assertIn("black_pages", report["hard_failures"])
        self.assertIn("nontext_visual_preservation", report["hard_failures"])

    def test_mostly_dark_overlay_fails_but_preserved_black_page_passes(self):
        source = self.root / "mostly-dark-source.pdf"
        corrupted = self.root / "mostly-dark-corrupted.pdf"
        black_source = self.root / "black-source.pdf"
        black_copy = self.root / "black-copy.pdf"
        make_dense_text_overlay_pdf(source)
        make_dense_text_overlay_pdf(
            corrupted,
            (18, 18, 594, 774),
            overlay_color=(0.05, 0.10, 0.15),
        )
        make_pdf(black_source, [{"text": "Preserved dark original", "black_page": True}])
        make_pdf(black_copy, [{"text": "Preserved dark original", "black_page": True}])

        corrupted_report = VERIFY_MODULE.verify(
            str(corrupted), str(source), intent="restore"
        )
        preserved_report = VERIFY_MODULE.verify(
            str(black_copy), str(black_source), intent="restore"
        )

        self.assert_gate(corrupted_report, "black_pages", "fail")
        unexpected = corrupted_report["gates"]["black_pages"]["details"]["unexpected"][0]
        self.assertEqual(unexpected["reason"], "newly_mostly_black")
        self.assertGreater(unexpected["dark_ratio"], 0.80)
        self.assert_gate(corrupted_report, "nontext_visual_preservation", "fail")

        self.assert_gate(preserved_report, "black_pages", "pass")
        self.assert_gate(preserved_report, "nontext_visual_preservation", "pass")
        self.assertTrue(preserved_report["passed"], preserved_report["hard_failures"])

    def test_small_preserved_black_shape_is_not_a_black_page_false_positive(self):
        source = self.root / "small-shape-source.pdf"
        output = self.root / "small-shape-output.pdf"
        rect = (500, 700, 550, 750)
        make_dense_text_overlay_pdf(source, rect)
        make_dense_text_overlay_pdf(output, rect)

        report = VERIFY_MODULE.verify(str(output), str(source), intent="restore")

        self.assert_gate(report, "black_pages", "pass")
        self.assert_gate(report, "nontext_visual_preservation", "pass")
        self.assertTrue(report["passed"], report["hard_failures"])

    def test_inplace_normal_translation_may_change_vocabulary_and_length(self):
        source, output = self.paths()
        make_pdf(
            source,
            [{
                "text": (
                    "Careful scientific translation can reorganize clause structure and replace "
                    "nearly every lexical item while preserving complete meaning"
                )
            }],
        )
        make_pdf(
            output,
            [{
                "text": "정확한 과학 번역은 핵심 의미를 보존하면서 문장 구조와 어휘를 크게 바꿀 수 있습니다",
                "fontname": "korea",
            }],
        )

        report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")

        self.assert_gate(report, "content_coverage", "pass")
        self.assert_gate(report, "nontext_visual_preservation", "pass")
        self.assertTrue(report["passed"], report["hard_failures"])

    def test_retypeset_meaningful_vector_requires_provenance_review(self):
        source, output = self.paths()
        make_pdf(source, [{"text": "Result value 5 kg", "vector_color": (1, 0, 0)}])
        make_pdf(output, [{"text": "Result value 5 kg"}])

        report = VERIFY_MODULE.verify(str(output), str(source), mode="retypeset")

        self.assert_gate(report, "vector_provenance", "fail")
        self.assertTrue(report["gates"]["vector_provenance"]["details"]["needs_visual_review"])

    def test_retypeset_rejects_unexpected_unique_image(self):
        source, output = self.paths()
        make_pdf(source, [{"text": "Figure", "image_streams": [RED_PNG]}])
        make_pdf(output, [{"text": "Figure", "image_streams": [RED_PNG, BLUE_PNG]}])

        report = VERIFY_MODULE.verify(str(output), str(source), mode="retypeset")

        self.assert_gate(report, "image_preservation", "fail")
        details = report["gates"]["image_preservation"]["details"]
        self.assertTrue(details["needs_visual_review"])
        self.assertEqual(len(details["unexpected_output"]), 1)

    def test_tiny_text_is_pdf_object_nonempty_and_cannot_be_deleted(self):
        source = self.root / "tiny-source.pdf"
        exact = self.root / "tiny-exact.pdf"
        translated = self.root / "tiny-translated.pdf"
        deleted = self.root / "tiny-deleted.pdf"
        spec = {"text": "Compact source text", "fontsize": 0.25}
        make_pdf(source, [spec])
        make_pdf(exact, [spec])
        make_pdf(translated, [{"text": "Compact target text", "fontsize": 0.25}])
        make_pdf(deleted, [{}])

        exact_report = VERIFY_MODULE.verify(str(exact), str(source))
        translated_report = VERIFY_MODULE.verify(str(translated), str(source))
        deleted_report = VERIFY_MODULE.verify(str(deleted), str(source))

        self.assert_gate(exact_report, "blank_pages", "pass")
        self.assertTrue(exact_report["passed"])
        self.assert_gate(translated_report, "blank_pages", "pass")
        self.assertTrue(translated_report["passed"])
        self.assert_gate(deleted_report, "blank_pages", "fail")
        self.assertFalse(deleted_report["passed"])

    def test_changed_chemical_formula_fails(self):
        source, output = self.paths()
        make_pdf(source, [{"text": "Acid H2SO4 and gas CO2"}])
        make_pdf(output, [{"text": "Acid H3SO5 and gas CO9"}])

        report = VERIFY_MODULE.verify(str(output), str(source))

        self.assert_gate(report, "chemical_formula_preservation", "fail")
        self.assertIn("chemical_formula_preservation", report["hard_failures"])

    def test_short_code_command_is_not_misclassified_as_untranslated(self):
        issues = VERIFY_MODULE.scan_page_text(
            "git checkout feature branch and run npm install command"
        )
        self.assertNotIn("untranslated", [kind for kind, _detail in issues])

    def test_command_does_not_exempt_long_untranslated_explanation(self):
        issues = VERIFY_MODULE.scan_page_text(
            "Run npm install because this entire English explanation remains untranslated for many pages"
        )
        self.assertIn("untranslated", [kind for kind, _detail in issues])

    def test_parenthesized_and_fake_copyright_prose_are_not_exempt(self):
        for text in (
            "(this entire English sentence remains untranslated inside parentheses for users)",
            "Copyright means this entire English paragraph remains completely untranslated",
        ):
            with self.subTest(text=text):
                issues = VERIFY_MODULE.scan_page_text(text)
                self.assertIn("untranslated", [kind for kind, _detail in issues])

    def test_mixed_korean_short_lowercase_english_prose_is_untranslated(self):
        for text in (
            "이 born-digital 페이지는 번역되어야 합니다.",
            "이 ordinary paragraph 문구는 아직 번역되지 않았습니다.",
        ):
            with self.subTest(text=text):
                issues = VERIFY_MODULE.scan_page_text(text)
                untranslated = [detail for kind, detail in issues if kind == "untranslated"]
                self.assertTrue(untranslated)
                self.assertIn(
                    "born-digital" if "born-digital" in text else "ordinary paragraph",
                    untranslated[0],
                )

    def test_mixed_korean_preserved_literals_do_not_trigger_short_english_gate(self):
        safe_cases = (
            "주소는 HTTPS이며 https://example.com/a-b 를 사용합니다.",
            "샘플 A-17의 농도는 0.250 mol/L이고 GPU로 처리했습니다.",
            "용어는 어텐션(attention)으로 표기합니다.",
            "명령은 git checkout feature/anchor 입니다.",
            "코드는 `npm install package-name`으로 실행합니다.",
            "OpenAI Codex와 PyMuPDF API를 사용합니다.",
        )
        for text in safe_cases:
            with self.subTest(text=text):
                issues = VERIFY_MODULE.scan_page_text(text)
                self.assertNotIn("untranslated", [kind for kind, _detail in issues])

    def test_normal_korean_synthetic_translation_passes_untranslated_gate(self):
        source, output = self.paths()
        make_pdf(source, [{"text": "Measured mass 12.50 kg for sample A-17"}])
        make_pdf(
            output,
            [{"text": "측정 질량은 12.50 kg이고 샘플은 A-17입니다", "fontname": "korea"}],
        )

        report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")

        self.assert_gate(report, "untranslated_text", "pass")
        self.assertNotIn("untranslated_text", report["hard_failures"])

    def test_restore_intent_preserves_english_and_skips_untranslated_gate(self):
        source, output = self.paths()
        text = "This English source sentence should remain exactly unchanged during restoration"
        make_pdf(source, [{"text": text}])
        make_pdf(output, [{"text": text}])

        translated = VERIFY_MODULE.verify(str(output), str(source), intent="translate")
        restored = VERIFY_MODULE.verify(str(output), str(source), intent="restore")

        self.assert_gate(translated, "untranslated_text", "fail")
        self.assert_gate(restored, "untranslated_text", "skip")
        self.assert_gate(restored, "text_preservation", "pass")
        self.assertTrue(restored["passed"])
        self.assertEqual(restored["intent"], "restore")

    def test_restore_intent_rejects_changed_source_tokens(self):
        source, output = self.paths()
        make_pdf(source, [{"text": "Restore this exact English source sentence safely"}])
        make_pdf(output, [{"text": "Restore a different English target sentence safely"}])

        report = VERIFY_MODULE.verify(str(output), str(source), intent="restore")

        self.assert_gate(report, "text_preservation", "fail")
        self.assertIn("text_preservation", report["hard_failures"])

    def test_restore_intent_rejects_token_reordering(self):
        source, output = self.paths()
        make_pdf(source, [{"text": "restore alpha beta gamma delta source tokens safely"}])
        make_pdf(output, [{"text": "safely tokens source delta gamma beta alpha restore"}])

        report = VERIFY_MODULE.verify(str(output), str(source), intent="restore")

        self.assert_gate(report, "text_preservation", "fail")
        details = report["gates"]["text_preservation"]["details"]
        self.assertTrue(details["ordered"])

    def test_retypeset_zero_lexical_overlap_requires_semantic_review(self):
        source, output = self.paths()
        make_pdf(
            source,
            [{
                "text": (
                    "Careful scientific translation can reorganize clause structure and "
                    "replace nearly every lexical item while preserving complete meaning"
                )
            }],
        )
        make_pdf(
            output,
            [{
                "text": "정확한 과학 번역은 핵심 의미를 보존하면서 문장 구조와 어휘를 크게 바꿀 수 있습니다",
                "fontname": "korea",
            }],
        )

        report = VERIFY_MODULE.verify(str(output), str(source), mode="retypeset")

        self.assert_gate(report, "semantic_correspondence", "fail")
        self.assertTrue(
            report["gates"]["semantic_correspondence"]["details"]["needs_semantic_review"]
        )

    def test_retypeset_translated_page_reversal_requires_semantic_review(self):
        source, output = self.paths()
        make_pdf(
            source,
            [
                {"text": "The northern laboratory documents pressure changes and material behavior in a sealed chamber."},
                {"text": "The southern station records seasonal migration patterns across the coastal wetland."},
            ],
        )
        make_pdf(
            output,
            [
                {"text": "남부 현장 기지는 해안 습지의 계절 이동 양상을 체계적으로 기록합니다", "fontname": "korea"},
                {"text": "북부 실험실은 밀폐 공간의 압력 변화와 재료 거동을 세심하게 기록합니다", "fontname": "korea"},
            ],
        )

        report = VERIFY_MODULE.verify(str(output), str(source), mode="retypeset")

        self.assert_gate(report, "page_order", "pass")
        self.assert_gate(report, "semantic_correspondence", "fail")
        self.assertFalse(report["passed"])

    def test_retypeset_mode_allows_small_paper_change_but_default_does_not(self):
        source, output = self.paths()
        make_pdf(source, [{"text": "Value 5 kg", "width": 612, "height": 792}])
        make_pdf(output, [{"text": "Value 5 kg", "width": 595, "height": 842}])

        inplace = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")
        retypeset = VERIFY_MODULE.verify(str(output), str(source), mode="retypeset")

        self.assert_gate(inplace, "page_correspondence", "fail")
        self.assert_gate(retypeset, "page_correspondence", "pass")
        self.assertTrue(retypeset["passed"])

    def test_one_page_to_two_pages_fails_even_in_retypeset_mode(self):
        source, output = self.paths()
        make_pdf(source, [{"text": "Source"}])
        make_pdf(output, [{"text": "Output"}, {"text": "Extra"}])

        report = VERIFY_MODULE.verify(str(output), str(source), mode="retypeset")

        self.assert_gate(report, "page_correspondence", "fail")

    def test_cli_writes_failure_json_before_exit_one(self):
        source, output = self.paths()
        report_path = self.root / "report.json"
        make_pdf(source, [{"text": "Source"}])
        make_pdf(output, [{"text": "Output"}, {"text": "Extra"}])

        completed = subprocess.run(
            [
                sys.executable,
                str(SCRIPT_PATH),
                str(output),
                "--original",
                str(source),
                "--json",
                str(report_path),
            ],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 1, completed.stdout + completed.stderr)
        self.assertTrue(report_path.exists())
        payload = json.loads(report_path.read_text(encoding="utf-8"))
        self.assertFalse(payload["passed"])
        self.assertEqual(payload["exit_code"], 1)
        self.assertIn("page_correspondence", payload["hard_failures"])

    def test_malformed_pdf_is_reported_as_validation_failure(self):
        output = self.root / "broken.pdf"
        report_path = self.root / "broken-report.json"
        output.write_bytes(b"not a pdf")

        completed = subprocess.run(
            [sys.executable, str(SCRIPT_PATH), str(output), "--json", str(report_path)],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 1, completed.stdout + completed.stderr)
        payload = json.loads(report_path.read_text(encoding="utf-8"))
        self.assert_gate(payload, "pdf_open", "fail")
        self.assertIn("pdf_open", payload["hard_failures"])


if __name__ == "__main__":
    unittest.main()
