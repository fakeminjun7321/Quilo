#!/usr/bin/env python3
"""Regressions for glyph-specific recovery from damaged math ToUnicode maps."""

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"
SPEC = importlib.util.spec_from_file_location("quilo_math_trace_decoder", MODULE_PATH)
translate_pdf = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(translate_pdf)


class MathFontTraceDecoderTest(unittest.TestCase):
    def setUp(self):
        self.old_dec = translate_pdf._CUR_DEC
        self.old_trace = translate_pdf._CUR_TRACE_DEC
        translate_pdf._CUR_DEC = {"MTMI": {ord("Σ"): "α", ord("υ"): "λ"}}
        translate_pdf._CUR_TRACE_DEC = {"MTMI": []}

    def tearDown(self):
        translate_pdf._CUR_DEC = self.old_dec
        translate_pdf._CUR_TRACE_DEC = self.old_trace

    @staticmethod
    def span(text, *, x0, x1, baseline):
        return {
            "text": text,
            "font": "MTMI",
            "origin": (x0, baseline),
            "bbox": (x0, baseline - 8, x1, baseline + 3),
        }

    def test_same_raw_parenthesis_resolves_as_parenthesis_and_delta(self):
        # Visual source: (α,δ).  Damaged text layer: (Σ,().  Both the real
        # opening parenthesis and delta are exposed as U+0028, but their CFF
        # glyph ids identify parenleft and delta at distinct x origins.
        baseline = 174.633789
        translate_pdf._CUR_TRACE_DEC["MTMI"] = [
            (baseline, 207.025, ord("("), "("),
            (baseline, 221.097, ord("("), "δ"),
        ]
        span = self.span(" (Σ,()", x0=204.383, x1=229.491, baseline=baseline)
        self.assertEqual(
            translate_pdf._fix_span_text("MTMI", span["text"], span=span),
            " (α,δ)",
        )

    def test_same_raw_comma_resolves_as_comma_and_beta(self):
        # Visual source: (λ,β).  Damaged text layer: (υ,,).
        baseline = 397.618011
        translate_pdf._CUR_TRACE_DEC["MTMI"] = [
            (baseline, 384.139, ord(","), ","),
            (baseline, 388.119, ord(","), "β"),
        ]
        span = self.span(" (υ,,)", x0=373.685, x1=396.639, baseline=baseline)
        self.assertEqual(
            translate_pdf._fix_span_text("MTMI", span["text"], span=span),
            " (λ,β)",
        )

    def test_bbox_selects_comma_or_beta_without_page_specific_rules(self):
        baseline = 588.273987
        translate_pdf._CUR_TRACE_DEC["MTMI"] = [
            (baseline, 420.953, ord(","), ","),
            (baseline, 454.000, ord(","), "β"),
        ]
        comma = self.span(",", x0=420.953, x1=424.251, baseline=baseline)
        beta = self.span(",", x0=454.000, x1=459.500, baseline=baseline)
        self.assertEqual(
            translate_pdf._fix_span_text("MTMI", comma["text"], span=comma),
            ",",
        )
        self.assertEqual(
            translate_pdf._fix_span_text("MTMI", beta["text"], span=beta),
            "β",
        )

    def test_ambiguous_raw_code_without_span_evidence_is_not_guessed(self):
        translate_pdf._CUR_DEC = {"MTMI": {}}
        translate_pdf._CUR_TRACE_DEC["MTMI"] = [
            (100.0, 10.0, ord(","), ","),
            (100.0, 20.0, ord(","), "β"),
        ]
        self.assertEqual(translate_pdf._fix_span_text("MTMI", ","), ",")

    def test_mtsyn_page_decoder_precedes_minus_fallback(self):
        translate_pdf._CUR_DEC = {"MTSYN": {ord("!"): "∝"}}
        self.assertEqual(translate_pdf._fix_span_text("MTSYN", "!"), "∝")

        translate_pdf._CUR_DEC = {"MTSYN": {}}
        self.assertEqual(translate_pdf._fix_span_text("MTSYN", "!"), "−")

    def test_superscript_stays_before_following_prose_span(self):
        translate_pdf._CUR_DEC = {"MTSYN": {ord("!"): "∝"}}
        translate_pdf._CUR_TRACE_DEC = {}
        block = {
            "lines": [{
                "bbox": (51.0, 560.4, 130.8, 577.4),
                "spans": [
                    {"bbox": (51.0, 561.7, 53.9, 571.1), "font": "Times", "size": 8.47, "text": "("},
                    {"bbox": (54.0, 562.8, 60.2, 571.3), "font": "MTMI", "size": 8.47, "text": "A"},
                    {"bbox": (60.2, 561.6, 68.4, 577.3), "font": "MTSYN", "size": 8.47, "text": " !"},
                    {"bbox": (68.4, 562.8, 73.4, 571.3), "font": "MTMI", "size": 8.47, "text": " r"},
                    {"bbox": (74.1, 560.4, 77.3, 567.6), "font": "Times", "size": 6.44, "text": "2"},
                    {"bbox": (77.9, 561.7, 130.8, 571.1), "font": "Times", "size": 8.47, "text": "). Therefore"},
                ],
            }],
        }
        self.assertEqual(
            translate_pdf.block_text(block, tag=True),
            "(A ∝ r<sup>2</sup>). Therefore",
        )


if __name__ == "__main__":
    unittest.main()
