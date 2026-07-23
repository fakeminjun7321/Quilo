#!/usr/bin/env python3
"""Regressions for source-language residue around formulas, figures and captions."""

import importlib.util
from pathlib import Path
import tempfile
import unittest

import fitz


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"
SPEC = importlib.util.spec_from_file_location("quilo_residual_forensics", MODULE_PATH)
translate_pdf = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(translate_pdf)


def span(text, font, bbox, size=10):
    return {"text": text, "font": font, "bbox": bbox, "size": size, "flags": 0}


def line(*spans, bbox=None):
    if bbox is None:
        rect = fitz.Rect(spans[0]["bbox"])
        for item in spans[1:]:
            rect |= fitz.Rect(item["bbox"])
        bbox = tuple(rect)
    return {"bbox": bbox, "dir": (1, 0), "spans": list(spans)}


def block(lines):
    rect = fitz.Rect(lines[0]["bbox"])
    for item in lines[1:]:
        rect |= fitz.Rect(item["bbox"])
    return {"type": 0, "bbox": tuple(rect), "lines": lines}


class ResidualSourceForensicsTest(unittest.TestCase):
    def test_real_short_prose_fragments_are_never_formula_keep_blocks(self):
        fixtures = (
            "by Sν:",
            "0.577. Us-",
            "in 1054. (c) -7.4.",
            "be m=0.577 + as.",
        )
        for text in fixtures:
            with self.subTest(text=text):
                candidate = block(
                    [line(span(text, "Times-Roman", (51, 380, 245, 391)))]
                )
                self.assertFalse(translate_pdf._formula_only_visible_text(text))
                self.assertFalse(
                    translate_pdf._line_is_display_formula(candidate["lines"][0])
                )
                self.assertFalse(translate_pdf._keep_original_block(candidate))

    def test_short_formula_controls_survive_narrow_prose_fragment_guards(self):
        fixtures = (
            ("Be + He", "Times-Roman"),
            ("In+x", "Times-Roman"),
            ("AT = 2", "Times-Roman"),
            ("5 in", "MTMI"),
            ("x=by", "Times-Roman"),
        )
        for text, font in fixtures:
            with self.subTest(text=text):
                candidate = block(
                    [line(span(text, font, (51, 380, 145, 391)))]
                )
                self.assertTrue(
                    translate_pdf._line_is_display_formula(candidate["lines"][0])
                )
                segments = translate_pdf._split_mixed_display_formula_lines(
                    candidate
                )
                self.assertEqual(len(segments), 1)
                self.assertTrue(segments[0].get("_preserve_formula", False))
                self.assertTrue(translate_pdf._keep_original_block(segments[0]))

    def test_uppercase_glued_math_identifier_requires_an_exact_function_suffix(self):
        for token in ("Asin", "Xcos", "Dcosh"):
            with self.subTest(token=token):
                self.assertTrue(
                    translate_pdf._looks_like_glued_math_identifier(token)
                )
        for token in ("Using", "Cost", "Sine", "Aside"):
            with self.subTest(token=token):
                self.assertFalse(
                    translate_pdf._looks_like_glued_math_identifier(token)
                )

    def test_run_in_at_formula_row_stays_with_following_prose(self):
        candidate = block(
            [
                line(
                    span(
                        "at r=R⊙/2)",
                        "Times-Roman",
                        (51, 380, 112, 391),
                    )
                ),
                line(
                    span(
                        "Using the preceding equation, the result follows.",
                        "Times-Roman",
                        (51, 392, 245, 403),
                    )
                ),
            ]
        )

        self.assertFalse(translate_pdf._line_is_display_formula(candidate["lines"][0]))
        segments = translate_pdf._split_mixed_display_formula_lines(candidate)
        self.assertEqual(len(segments), 1)
        self.assertFalse(segments[0].get("_preserve_formula", False))

    def test_layout_obstacle_uses_matching_glyph_boxes_not_tall_raw_span(self):
        doc = fitz.open()
        page = doc.new_page(width=240, height=120)
        page.insert_text((80, 45), "s = 2", fontsize=10, fontname="helv")
        page.insert_text((80, 65), "Nearby prose", fontsize=10, fontname="helv")
        formula_span = next(
            item
            for candidate in page.get_text("dict").get("blocks", [])
            for text_line in candidate.get("lines", [])
            for item in text_line.get("spans", [])
            if item.get("text") == "s = 2"
        )
        descriptor = translate_pdf._preserved_span_descriptor(formula_span)
        raw = fitz.Rect(78, 24, 112, 69)
        descriptor["bbox"] = fitz.Rect(raw)

        tight = translate_pdf._tight_preserved_layout_obstacle(
            page.get_texttrace(), [descriptor], raw
        )

        self.assertLess(tight.height, 18.0)
        self.assertLess(tight.y1, 55.0)
        self.assertGreaterEqual(tight.x0, raw.x0)
        self.assertLessEqual(tight.x1, raw.x1)
        doc.close()

    def test_layout_obstacle_falls_back_to_raw_rect_on_incomplete_trace_match(self):
        doc = fitz.open()
        page = doc.new_page(width=240, height=120)
        page.insert_text((80, 45), "s = 2", fontsize=10, fontname="helv")
        raw = fitz.Rect(78, 24, 112, 69)
        descriptors = [
            {
                "font": "Helvetica",
                "origin_y": 45.0,
                "bbox": fitz.Rect(raw),
            },
            {
                "font": "MissingScientificFont",
                "origin_y": 45.0,
                "bbox": fitz.Rect(raw),
            },
        ]

        actual = translate_pdf._tight_preserved_layout_obstacle(
            page.get_texttrace(), descriptors, raw
        )

        self.assertEqual(tuple(actual), tuple(raw))
        doc.close()

    def test_text_object_scanner_ignores_bt_et_inside_pdf_strings(self):
        stream = b"BT /F1 10 Tf (literal BT and ET) Tj <4254204554> Tj ET"

        ranges = translate_pdf._pdf_text_object_ranges(stream)

        self.assertEqual(ranges, [(0, len(stream))])

    def test_overlapping_formula_replay_is_exact_without_replaying_prose(self):
        doc = fitz.open()
        page = doc.new_page(width=240, height=120)
        # The two source bboxes overlap vertically, matching the real textbook
        # failure.  They deliberately share a font and x origin: the baseline is
        # what proves the selected BT..ET object belongs to the formula.
        page.insert_text((50, 50), "x = 2", fontsize=11, fontname="helv")
        page.insert_text(
            (50, 58), "Nearby English prose", fontsize=11, fontname="helv"
        )
        spans = [
            item
            for candidate in page.get_text("dict").get("blocks", [])
            for text_line in candidate.get("lines", [])
            for item in text_line.get("spans", [])
        ]
        formula = next(item for item in spans if item.get("text") == "x = 2")
        prose = next(
            item for item in spans if item.get("text") == "Nearby English prose"
        )
        descriptors = [translate_pdf._preserved_span_descriptor(formula)]

        def trace_signature(trace):
            return (
                trace.get("font"),
                trace.get("size"),
                trace.get("type"),
                trace.get("color"),
                tuple(
                    (
                        char[0],
                        char[1],
                        tuple(round(float(value), 5) for value in char[2]),
                        tuple(round(float(value), 5) for value in char[3]),
                    )
                    for char in trace.get("chars", [])
                ),
            )

        source_formula_traces = [
            trace_signature(trace)
            for trace in page.get_texttrace()
            if translate_pdf._trace_matches_preserved_span(trace, descriptors)
        ]
        overlay, selected = translate_pdf._build_preserved_text_overlay(
            doc, page, descriptors
        )
        self.assertEqual(selected, 1)

        # Redact the neighbouring prose around the exact formula geometry, just
        # as the production renderer does.  Then remove the redaction-rewritten
        # formula copy and replay its original operators at the top of Contents.
        for rect in translate_pdf._split_out_keeps(
            fitz.Rect(prose["bbox"]), [fitz.Rect(formula["bbox"])]
        ):
            page.add_redact_annot(rect, fill=(1, 1, 1))
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
        self.assertEqual(
            translate_pdf._remove_preserved_text_objects(doc, page, descriptors),
            1,
        )
        page = doc.reload_page(page)
        page = translate_pdf._append_page_content_stream(doc, page, overlay)

        output_formula_traces = [
            trace_signature(trace)
            for trace in page.get_texttrace()
            if translate_pdf._trace_matches_preserved_span(trace, descriptors)
        ]
        self.assertEqual(output_formula_traces, source_formula_traces)
        self.assertIn("x = 2", page.get_text())
        self.assertNotIn("Nearby English prose", page.get_text())
        doc.close()

    def test_formula_replay_clips_distant_prose_from_the_same_text_object(self):
        doc = fitz.open()
        page = doc.new_page(width=240, height=120)
        # Real astronomy source encoded ``0circle`` in one TJ object and separated
        # the two visual fields with character spacing.  A formula descriptor may
        # therefore select an object that also contains translatable prose.
        page.insert_text((50, 50), "0circle", fontsize=11, fontname="helv")
        trace = page.get_texttrace()[0]
        zero = trace["chars"][0]
        descriptor = {
            "font": trace["font"],
            "origin_y": float(zero[2][1]),
            "bbox": fitz.Rect(zero[3]),
        }

        overlay, selected = translate_pdf._build_preserved_text_overlay(
            doc, page, [descriptor]
        )
        self.assertEqual(selected, 1)
        self.assertEqual(
            translate_pdf._remove_preserved_text_objects(doc, page, [descriptor]),
            1,
        )
        page = doc.reload_page(page)
        page = translate_pdf._append_page_content_stream(doc, page, overlay)

        self.assertIn("0", page.get_text())
        self.assertNotIn("circle", page.get_text())
        doc.close()

    def test_tall_math_bbox_does_not_mix_adjacent_prose_baselines(self):
        def positioned(text, font, bbox, origin, size=10):
            item = span(text, font, bbox, size)
            item["origin"] = origin
            return item

        candidate = block(
            [
                line(
                    positioned("B", "MTMI", (51, 179, 58, 190), (51, 187)),
                    positioned(" - V = ", "MTSYN", (58, 178, 88, 198), (58, 187)),
                    positioned("1.6, and absolute magnitude M", "Times-Roman", (88, 178, 213, 190), (88, 187)),
                    positioned("V", "Times-Roman", (213, 182, 219, 190), (213, 188.5), 7.5),
                    positioned(" = 1.3.", "Times-Roman", (219, 178, 247, 190), (219, 187)),
                    bbox=(51, 178, 247, 198),
                ),
                line(
                    positioned(
                        "The extinction in the direction of the star in the",
                        "Times-Roman",
                        (51, 190, 247, 202),
                        (51, 199.3),
                    ),
                    bbox=(51, 190, 247, 202),
                ),
            ]
        )

        text = translate_pdf.block_text(candidate, tag=True)
        self.assertEqual(
            text,
            "B - V = 1.6, and absolute magnitude M<sub>V</sub> = 1.3. "
            "The extinction in the direction of the star in the",
        )
        self.assertNotIn("BThe", text)

    def test_wrapped_prose_with_equation_reference_is_not_stacked_formula_keep(self):
        # Fundamental Astronomy p. 61 / chunk-2 local page 4.  The very short
        # second row geometrically overlaps the first like a denominator, and the
        # equation reference used to supply the only required numeric signal.
        # ``ﬁnd`` also verifies that a compatibility ligature cannot hide prose.
        prose = block(
            [
                line(
                    span(
                        "Next, we use (2.47) to ﬁnd the sidereal time at",
                        "Times-Roman",
                        (257.962, 592.557, 453.570, 603.675),
                    )
                ),
                line(
                    span(
                        "0 UT:",
                        "Times-Roman",
                        (257.961, 604.725, 281.487, 615.844),
                    )
                ),
            ]
        )

        self.assertTrue(translate_pdf._has_ordinary_font_prose(prose))
        self.assertFalse(translate_pdf._is_stacked_math(prose))
        self.assertFalse(translate_pdf._keep_original_block(prose))

    def test_stacked_formula_only_block_still_keeps_original_pixels(self):
        fraction = block(
            [
                line(span("m", "MTMI", (80, 20, 100, 30))),
                line(span("V", "MTMI", (80, 40, 100, 50))),
            ]
        )

        self.assertFalse(translate_pdf._has_ordinary_font_prose(fraction))
        self.assertTrue(translate_pdf._is_stacked_math(fraction))
        self.assertTrue(translate_pdf._keep_original_block(fraction))

    def test_stacked_geometry_does_not_hide_caption_table_or_code_text(self):
        cases = {
            "caption": block(
                [
                    line(span("Fig. 2.5 The rotated frame", "Times-Roman", (20, 20, 180, 30))),
                    line(span("is shown here.", "Times-Roman", (20, 40, 90, 50))),
                ]
            ),
            "table_header": block(
                [
                    line(span("Atomic orbital", "Times-Roman", (20, 20, 100, 30))),
                    line(span("(Atom A)", "Times-Roman", (20, 40, 65, 50))),
                ]
            ),
            # Code enters the response layer, where the existing exact code-only
            # grammar reuses it unchanged; Python must not mislabel it as a 2-D
            # formula solely because it wrapped across two physical rows.
            "code": block(
                [
                    line(span("total = value +", "Courier", (20, 20, 120, 30))),
                    line(span("offset", "Courier", (20, 40, 60, 50))),
                ]
            ),
        }

        for name, candidate in cases.items():
            with self.subTest(name=name):
                self.assertTrue(translate_pdf._has_ordinary_font_prose(candidate))
                self.assertFalse(translate_pdf._is_stacked_math(candidate))
                self.assertFalse(translate_pdf._keep_original_block(candidate))

    def test_formula_introduction_is_not_preserved_as_display_math(self):
        introduction = line(
            span("is", "Times-Roman", (10, 10, 20, 21)),
            span(" a", "MTMI", (20, 10, 28, 21)),
            span(":", "Times-Roman", (28, 10, 31, 21)),
        )
        equation = line(
            span("sin", "Times-Roman", (10, 30, 23, 41)),
            span(" a", "MTMI", (23, 30, 31, 41)),
            span(" = ", "MTSYN", (31, 30, 40, 41)),
            span("b", "MTMI", (40, 30, 46, 41)),
        )

        self.assertFalse(translate_pdf._line_is_display_formula(introduction))
        self.assertTrue(translate_pdf._line_is_display_formula(equation))

    def test_keep_subtraction_redacts_both_sides_of_narrow_formula(self):
        source = fitz.Rect(0, 0, 200, 80)
        formula = fitz.Rect(90, 20, 100, 55)
        pieces = translate_pdf._split_out_keeps(source, [formula])

        def covered(x, y):
            return any(piece.contains(fitz.Point(x, y)) for piece in pieces)

        self.assertTrue(covered(20, 35))
        self.assertTrue(covered(170, 35))
        self.assertTrue(covered(95, 10))
        self.assertTrue(covered(95, 70))
        self.assertFalse(covered(95, 35))

    def test_running_head_rule_does_not_seed_a_cross_column_table(self):
        doc = fitz.open()
        page = doc.new_page(width=504, height=720)
        page.draw_line((51, 47), (454, 47), width=1)
        # A nearby left-column illustration contains several horizontal rules.
        for y in (80, 110, 140, 170):
            page.draw_line((66, y), (230, y), width=1)
        page.draw_line((66, 80), (66, 170), width=1)
        page.draw_line((230, 80), (230, 170), width=1)

        regions = translate_pdf._table_regions(page)

        self.assertFalse(
            any(region.y0 < 60 and region.width > 300 for region in regions),
            regions,
        )
        doc.close()

    def test_side_by_side_caption_is_merged_in_column_reading_order(self):
        left = block(
            [
                line(span("Fig. 2.25 Left caption", "Times-Roman", (50, 500, 240, 510), 8.5)),
                line(span("ends on a plate", "Times-Roman", (50, 512, 150, 522), 8.5)),
            ]
        )
        right = block(
            [
                line(span("taken on November 7", "Times-Roman", (258, 500, 430, 510), 8.5)),
                line(span("and continues here.", "Times-Roman", (258, 512, 400, 522), 8.5)),
            ]
        )

        merged = translate_pdf._merge_caption_continuation_blocks([left, right])

        self.assertEqual(len(merged), 1)
        self.assertTrue(merged[0].get("_caption_chain"))
        text = translate_pdf.block_text(merged[0])
        self.assertLess(text.index("ends on a plate"), text.index("taken on November 7"))

    def test_caption_column_is_not_absorbed_as_a_superscript_fragment(self):
        # Fundamental Astronomy chunk 15, local p. 19 encoded the left-column
        # body and the Fig. 19.22 caption below a right-column image as separate
        # MuPDF blocks.  Their 11 pt gutter and overlapping vertical bands used
        # to fool the ion-fragment merger: the caption's rounded 8.5 pt dominant
        # size passed the 10 pt host threshold while its raw 8.468 pt first span
        # looked like a superscript.  The merger then interleaved caption formula
        # spans across the body paragraph.
        body = block(
            [
                line(
                    span(
                        "Clusters of galaxies can be ordered in a sequence",
                        "Times-Roman",
                        (51, 520, 247, 531),
                        10,
                    )
                ),
                line(
                    span(
                        "The galaxy type composition also varies along this sequence",
                        "Times-Roman",
                        (51, 533, 247, 544),
                        10,
                    )
                ),
                line(
                    span(
                        "The nearest cluster is the Virgo Cluster.",
                        "Times-Roman",
                        (51, 546, 247, 557),
                        10,
                    )
                ),
            ]
        )
        caption = block(
            [
                line(
                    span(
                        "Fig. 19.22 A theoretical X-ray spectrum for plasma with",
                        "Times-Roman",
                        (258, 533, 454, 543),
                        8.4682,
                    )
                ),
                line(
                    span(
                        "a temperature of 10",
                        "Times-Roman",
                        (258, 546, 330, 556),
                        8.4682,
                    ),
                    span("8", "Times-Roman", (330, 542, 334, 550), 6.4),
                    span(" K.", "Times-Roman", (334, 546, 346, 556), 8.4682),
                ),
            ]
        )

        separated = translate_pdf._merge_superscript_ions([body, caption])

        self.assertEqual(len(separated), 2)
        body_text = translate_pdf.block_text(separated[0], tag=True)
        caption_text = translate_pdf.block_text(separated[1], tag=True)
        self.assertIn("Clusters of galaxies", body_text)
        self.assertNotIn("Fig. 19.22", body_text)
        self.assertEqual(
            caption_text,
            "Fig. 19.22 A theoretical X-ray spectrum for plasma with "
            "a temperature of 10<sup>8</sup> K.",
        )
        self.assertNotIn("<sup>theoretical", caption_text)

    def test_running_header_wholly_above_figure_is_not_hidden_by_halo(self):
        header = (51, 34, 166, 44)
        figure = fitz.Rect(52, 56, 452, 534)
        self.assertFalse(translate_pdf._line_in_figs(header, [figure]))

    def test_postflight_reports_original_font_english_in_translated_box(self):
        doc = fitz.open()
        page = doc.new_page(width=240, height=120)
        page.insert_text((20, 50), "Residual English", fontsize=10, fontname="helv")
        redactions = [(fitz.Rect(15, 35, 180, 60), 0, False, 7)]

        residuals = translate_pdf._translated_source_residuals(page, redactions, [])
        protected = translate_pdf._translated_source_residuals(
            page, redactions, [fitz.Rect(15, 35, 180, 60)]
        )

        self.assertEqual([item["id"] for item in residuals], [7])
        self.assertEqual(protected, [])
        doc.close()


if __name__ == "__main__":
    unittest.main()
