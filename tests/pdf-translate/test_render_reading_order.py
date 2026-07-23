#!/usr/bin/env python3
"""In-place PDF reading-order, formula-anchor, and column-bound regressions."""

from __future__ import annotations

from collections import Counter
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

import fitz
import pdfplumber
from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[2]
TRANSLATOR = ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"
VERIFIER = ROOT / "scripts" / "verify_translation.py"
FONT = ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"

FIXTURE_SPEC = importlib.util.spec_from_file_location(
    "quilo_pdf_fixture_generator_for_order_test",
    Path(__file__).with_name("generate_fixtures.py"),
)
FIXTURES = importlib.util.module_from_spec(FIXTURE_SPEC)
assert FIXTURE_SPEC.loader is not None
FIXTURE_SPEC.loader.exec_module(FIXTURES)

TRANSLATOR_SPEC = importlib.util.spec_from_file_location(
    "quilo_pdf_translator_for_order_test", TRANSLATOR
)
TRANSLATOR_MODULE = importlib.util.module_from_spec(TRANSLATOR_SPEC)
assert TRANSLATOR_SPEC.loader is not None
TRANSLATOR_SPEC.loader.exec_module(TRANSLATOR_MODULE)


def run_translator(command: str, *args: Path, payload=None) -> dict:
    proc = subprocess.run(
        [sys.executable, str(TRANSLATOR), command, *(str(arg) for arg in args)],
        input=json.dumps(payload, ensure_ascii=False) if payload is not None else None,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode:
        raise AssertionError(
            f"translate_pdf.py {command} failed ({proc.returncode})\n"
            f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
        )
    return json.loads(proc.stdout)


def render_fixture(
    source: Path,
    output: Path,
    replacement,
) -> tuple[dict, dict]:
    extracted = run_translator("extract", source)
    translations = {
        str(block["id"]): replacement(block)
        for block in extracted["blocks"]
    }
    stats = run_translator(
        "render",
        source,
        output,
        FONT,
        payload={"translations": translations},
    )
    return extracted, stats


def run_verifier(
    source: Path,
    output: Path,
    report_path: Path,
    *,
    intent: str,
) -> tuple[subprocess.CompletedProcess, dict]:
    proc = subprocess.run(
        [
            sys.executable,
            str(VERIFIER),
            str(output),
            "--original",
            str(source),
            "--mode",
            "inplace",
            "--intent",
            intent,
            "--json",
            str(report_path),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    if not report_path.is_file():
        raise AssertionError(
            f"strict verifier did not produce JSON ({proc.returncode})\n"
            f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
        )
    return proc, json.loads(report_path.read_text(encoding="utf-8"))


def normalized(text: str) -> str:
    return " ".join(str(text or "").split())


def assert_order(test: unittest.TestCase, text: str, values: list[str]) -> None:
    text = normalized(text)
    cursor = -1
    for value in values:
        location = text.find(normalized(value), cursor + 1)
        test.assertGreater(
            location,
            cursor,
            f"{value!r} is absent or out of order in {text!r}",
        )
        cursor = location


def pypdf_text(path: Path) -> tuple[str, str]:
    warnings = io.StringIO()
    with contextlib.redirect_stderr(warnings):
        reader = PdfReader(str(path), strict=True)
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    return text, warnings.getvalue()


def link_summary(path: Path) -> Counter:
    reader = PdfReader(str(path), strict=True)
    rows = []
    for page_number, page in enumerate(reader.pages):
        for reference in page.get("/Annots") or []:
            annotation = reference.get_object()
            if str(annotation.get("/Subtype")) != "/Link":
                continue
            action = annotation.get("/A")
            action = action if hasattr(action, "get") else None
            destination = annotation.get("/Dest")
            rows.append(
                (
                    page_number,
                    tuple(round(float(value), 3) for value in annotation.get("/Rect")),
                    str(action.get("/S")) if action else "/Dest",
                    str(action.get("/URI")) if action and action.get("/URI") else "",
                    str(destination[1]) if destination is not None else "",
                )
            )
    return Counter(rows)


def text_block(page: fitz.Page, needle: str) -> fitz.Rect:
    matches = [
        fitz.Rect(*block[:4])
        for block in page.get_text("blocks", sort=True)
        if needle in str(block[4])
    ]
    if len(matches) != 1:
        raise AssertionError(f"expected one block containing {needle!r}: {matches!r}")
    return matches[0]


class RenderReadingOrderTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="quilo-pdf-order-test-")
        self.root = Path(self.tempdir.name)
        FIXTURES.register_fonts()

    def tearDown(self):
        self.tempdir.cleanup()

    def test_fixture01_extractors_follow_visual_order_and_links_remain_once(self):
        source = self.root / "fixture01.pdf"
        output = self.root / "fixture01-translated.pdf"
        FIXTURES.generate_text_links(source)
        first_source = (
            "This born-digital page exercises ordinary paragraph translation while "
            "exact values, units, identifiers, and links remain invariant."
        )
        second_source = (
            "The translation may reflow prose inside its text box, but it must not "
            "drop a sentence, merge unrelated numbers, or alter a target URI. The "
            "internal jump below must also survive document reconstruction when that "
            "feature is declared supported."
        )
        replacements = {
            "Measurement transfer note": "측정값 전달 노트",
            first_source: "이 디지털 원본 페이지는 일반 문단 번역과 불변값 보존을 검사합니다.",
            "Invariant measurement ledger": "불변 측정값 기록부",
            "External references": "외부 참조",
            second_source: "번역문은 상자 안에서 재배치할 수 있지만 문장과 링크를 보존해야 합니다.",
            "Jump to the fixture heading": "픽스처 제목으로 이동",
        }
        _extracted, stats = render_fixture(
            source, output, lambda block: replacements.get(block["text"], block["text"])
        )
        self.assertTrue(stats["ok"], stats)

        expected = [
            replacements["Measurement transfer note"],
            replacements[first_source],
            "https://example.com/quilo/pdf-fixture?case=text-001",
            "https://doi.org/10.0000/quilo.fixture.001",
            replacements[second_source],
        ]
        extracted, warnings = pypdf_text(output)
        self.assertEqual(warnings, "")
        assert_order(self, extracted, expected)

        pdftotext = shutil.which("pdftotext")
        if pdftotext:
            poppler = subprocess.run(
                [pdftotext, "-raw", str(output), "-"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout
            assert_order(self, poppler, expected)

        with pdfplumber.open(output) as document:
            assert_order(
                self,
                document.pages[0].extract_text(use_text_flow=True) or "",
                expected,
            )

        self.assertEqual(link_summary(output), link_summary(source))
        self.assertEqual(normalized(extracted).count(expected[2]), 1)
        self.assertEqual(normalized(extracted).count(expected[3]), 1)
        with fitz.open(source) as source_doc, fitz.open(output) as output_doc:
            source_rect = text_block(source_doc[0], first_source[:35])
            output_rect = text_block(output_doc[0], replacements[first_source])
            self.assertAlmostEqual(output_rect.x0, source_rect.x0, delta=4.0)
            self.assertLessEqual(output_rect.x1, source_rect.x1 + 8.1)

    def test_fixture03_identity_and_translated_rows_preserve_formula_contract(self):
        source = self.root / "fixture03.pdf"
        identity = self.root / "fixture03-identity.pdf"
        translated = self.root / "fixture03-translated.pdf"
        FIXTURES.generate_math_chem(source)

        extracted, identity_stats = render_fixture(
            source, identity, lambda block: block["text"]
        )
        equation_prefixes = (
            "Energy:",
            "Gravity:",
            "Combustion:",
            "Acid and ion:",
            "Equilibrium:",
        )
        equation_blocks = [
            block
            for block in extracted["blocks"]
            if any(block["text"].startswith(prefix) for prefix in equation_prefixes)
        ]
        self.assertEqual(len(equation_blocks), 5, equation_blocks)
        self.assertEqual(len({block["id"] for block in equation_blocks}), 5)
        self.assertIn("SO<sub>4</sub> <sup>2-</sup>", equation_blocks[3]["text"])
        self.assertTrue(identity_stats["ok"], identity_stats)
        diagnostic = identity_stats["reading_order"]["1"]
        self.assertEqual(diagnostic["reason"], "pixel_exact", diagnostic)
        self.assertTrue(diagnostic["applied"], diagnostic)
        self.assertFalse(diagnostic["restored"], diagnostic)
        self.assertGreaterEqual(identity_stats["validated_subset_fonts"], 1)

        proc, report = run_verifier(
            source,
            identity,
            self.root / "fixture03-identity-report.json",
            intent="restore",
        )
        self.assertEqual(proc.returncode, 0, report)
        self.assertTrue(report["passed"], report)
        for gate in (
            "page_render",
            "nontext_visual_preservation",
            "vector_provenance",
            "page_order",
            "text_preservation",
            "number_preservation",
            "chemical_formula_preservation",
        ):
            self.assertEqual(report["gates"][gate]["status"], "pass", gate)

        with fitz.open(source) as source_doc, fitz.open(identity) as output_doc:
            output_text = normalized(output_doc[0].get_text())
            self.assertIn("SO4 2-", output_text)
            for label in equation_prefixes:
                self.assertAlmostEqual(
                    output_doc[0].search_for(label)[0].y0,
                    source_doc[0].search_for(label)[0].y0,
                    # Font metric replacement may move the glyph bbox within its
                    # unchanged source row by a few points; cross-row drift is what
                    # this regression forbids.
                    delta=5.0,
                )

        translated_prefix = {
            "Energy:": "에너지:",
            "Gravity:": "중력:",
            "Combustion:": "연소:",
            "Acid and ion:": "산과 이온:",
            "Equilibrium:": "평형:",
        }

        def translate_formula_row(block):
            text = block["text"]
            for source_prefix, target_prefix in translated_prefix.items():
                if text.startswith(source_prefix):
                    return target_prefix + text[len(source_prefix) :]
            fixed = {
                "Equations and chemical notation": "수식과 화학 표기",
                "ASCII invariants: H2SO4 | CO2 | 6.022e23 | E = mc2":
                    "ASCII 불변값: H2SO4 | CO2 | 6.022e23 | E = mc2",
                "Do not translate variable names, coefficients, charges, or equation numbers.":
                    "변수명, 계수, 전하 및 수식 번호는 번역하지 마십시오.",
                "Synthetic CC0 regression fixture": "합성 CC0 회귀 테스트 픽스처",
                "Math, chemistry, and scripts fixture": "수학, 화학 및 첨자 테스트 픽스처",
                "Synthetic CC0 fixture content": "합성 CC0 테스트 콘텐츠",
            }
            if text in fixed:
                return fixed[text]
            if "FIXTURE-MATH-CHEM-003 | page " in text:
                return text.replace(" | page ", " | 페이지 ")
            return text

        _translated_extract, translated_stats = render_fixture(
            source, translated, translate_formula_row
        )
        self.assertTrue(translated_stats["ok"], translated_stats)
        self.assertEqual(
            translated_stats["reading_order"]["1"]["reason"], "pixel_exact"
        )
        translated_proc, translated_report = run_verifier(
            source,
            translated,
            self.root / "fixture03-translated-report.json",
            intent="translate",
        )
        self.assertEqual(translated_proc.returncode, 0, translated_report)
        self.assertTrue(translated_report["passed"], translated_report)
        for gate in (
            "page_correspondence",
            "page_order",
            "untranslated_text",
            "number_preservation",
            "chemical_formula_preservation",
            "nontext_visual_preservation",
            "vector_provenance",
        ):
            self.assertEqual(
                translated_report["gates"][gate]["status"], "pass", gate
            )
        with fitz.open(translated) as document:
            text = normalized(document[0].get_text())
            self.assertIn("산과 이온: H2SO4, SO4 2-", text)

    def test_fixture02_columns_retain_gutter_outer_margin_and_left_prose_anchor(self):
        source = self.root / "fixture02.pdf"
        output = self.root / "fixture02-translated.pdf"
        FIXTURES.generate_two_column(source)

        def replace_column(block):
            return re.sub(
                r"concise source sentence\.$",
                "간결한 원본 문장입니다.",
                block["text"],
            )

        _extracted, stats = render_fixture(source, output, replace_column)
        self.assertTrue(stats["ok"], stats)
        self.assertEqual(stats["reading_order"]["1"]["reason"], "pixel_exact")

        with fitz.open(source) as source_doc, fitz.open(output) as output_doc:
            for page_number in range(2):
                width = source_doc[page_number].cropbox.width
                for side in ("L", "R"):
                    source_rects = []
                    output_rects = []
                    for row in range(1, 17):
                        marker = f"COLUMN-{side}-P{page_number + 1}-{row:02d}"
                        source_rects.append(text_block(source_doc[page_number], marker))
                        output_rects.append(text_block(output_doc[page_number], marker))
                    for source_rect, output_rect in zip(source_rects, output_rects):
                        self.assertAlmostEqual(output_rect.x0, source_rect.x0, delta=4.0)
                    source_right = max(rect.x1 for rect in source_rects)
                    self.assertLessEqual(
                        max(rect.x1 for rect in output_rects), source_right + 8.1
                    )
                    if side == "L":
                        self.assertLess(max(rect.x1 for rect in output_rects), width / 2 - 8)
                    else:
                        self.assertGreater(min(rect.x0 for rect in output_rects), width / 2 + 8)
            # Interleaved vector-grid rules beside the table must not truncate the
            # detected table region and turn its final row into one translated text
            # run (the historical ``C3.750.375`` corruption).
            for token in ("C", "3.75", "0.375"):
                source_hits = [
                    fitz.Rect(*word[:4])
                    for word in source_doc[0].get_text("words")
                    if word[4] == token and 450 < word[1] < 485
                ]
                output_hits = [
                    fitz.Rect(*word[:4])
                    for word in output_doc[0].get_text("words")
                    if word[4] == token and 450 < word[1] < 485
                ]
                self.assertEqual(len(output_hits), len(source_hits), token)
                for actual, expected in zip(output_hits, source_hits):
                    self.assertAlmostEqual(actual.x0, expected.x0, delta=0.1)
                    self.assertAlmostEqual(actual.y0, expected.y0, delta=0.1)
            self.assertNotIn("C3.750.375", normalized(output_doc[0].get_text()))

        _proc, report = run_verifier(
            source,
            output,
            self.root / "fixture02-report.json",
            intent="translate",
        )
        self.assertEqual(report["gates"]["page_order"]["status"], "pass", report)
        self.assertEqual(
            report["gates"]["number_preservation"]["status"], "pass", report
        )
        self.assertEqual(
            report["gates"]["nontext_visual_preservation"]["status"], "pass"
        )

    def test_fixture04_rotated_cropbox_geometry_is_preserved_and_bounded(self):
        source = self.root / "fixture04.pdf"
        output = self.root / "fixture04-identity.pdf"
        FIXTURES.generate_mixed_geometry(source)
        _extracted, stats = render_fixture(source, output, lambda block: block["text"])
        self.assertTrue(stats["ok"], stats)
        rotated = stats["reading_order"]["3"]
        self.assertEqual(rotated["reason"], "unsupported_page_geometry", rotated)
        self.assertFalse(rotated["applied"], rotated)
        self.assertGreater(rotated["original_streams"], 0)

        source_reader = PdfReader(str(source), strict=True)
        output_reader = PdfReader(str(output), strict=True)
        source_geometry = [
            (
                tuple(float(value) for value in page.mediabox),
                tuple(float(value) for value in page.cropbox),
                int(page.rotation or 0) % 360,
            )
            for page in source_reader.pages
        ]
        output_geometry = [
            (
                tuple(float(value) for value in page.mediabox),
                tuple(float(value) for value in page.cropbox),
                int(page.rotation or 0) % 360,
            )
            for page in output_reader.pages
        ]
        self.assertEqual(output_geometry, source_geometry)
        self.assertEqual(output_geometry[2][2], 90)

        with fitz.open(output) as document:
            page = document[2]
            self.assertEqual((page.cropbox.width, page.cropbox.height), (612.0, 792.0))
            for block in page.get_text("blocks"):
                if len(block) > 6 and block[6] != 0:
                    continue
                rect = fitz.Rect(*block[:4])
                self.assertGreaterEqual(rect.x0, -0.1)
                self.assertGreaterEqual(rect.y0, -0.1)
                self.assertLessEqual(rect.x1, page.cropbox.width + 0.1)
                self.assertLessEqual(rect.y1, page.cropbox.height + 0.1)

    def test_safe_splitter_carries_inherited_font_without_leaking_across_q_scope(self):
        data = (
            b"q 0 g "
            b"BT /F1 9 Tf 90 625 TD (S1) Tj ET "
            b"BT 230 625 TD (298.15) Tj ET "
            b"BT 370 625 TD (PASS) Tj ET Q"
        )
        split = TRANSLATOR_MODULE._split_safe_residual_text_stream(data)
        self.assertIsNotNone(split)
        _graphics, chunks = split
        self.assertEqual(len(chunks), 3)
        for chunk in chunks[1:]:
            self.assertIn(b"/F1 9 Tf", chunk["data"])

        # Q restores the pre-q text state.  A font selected only inside q must not
        # authorize a following font-less text object.
        leaked = (
            b"q BT /F1 9 Tf 20 80 Td (inside) Tj ET Q "
            b"BT 20 60 Td (outside) Tj ET"
        )
        self.assertIsNone(
            TRANSLATOR_MODULE._split_safe_residual_text_stream(leaked)
        )

    def test_table_cell_classifier_translates_statuses_but_preserves_invariants(self):
        for text in ("PASS", "FAIL", "OK", "HOLD"):
            self.assertTrue(
                TRANSLATOR_MODULE._table_cell_requires_translation(text), text
            )
        for text in (
            "A", "B", "C", "ID", "s", "kPa", "S1", "B204",
            "H2SO4", "CO2", "NaCl",
        ):
            self.assertFalse(
                TRANSLATOR_MODULE._table_cell_requires_translation(text), text
            )

        # Table clipping must not give a source glyph stream a second owner.  The
        # raw block predicate retains font / rise / subscript geometry which the
        # flattened cell string cannot carry, so every proven KEEP block bypasses
        # the synthetic cell overlay even when its text alone looks translatable.
        kept_formula = {"_preserve_formula": True, "lines": []}
        self.assertTrue(TRANSLATOR_MODULE._keep_original_block(kept_formula))
        for text in (
            "Te [K]", "Tc [10^6 K]", "Mci [M]", "Mce [M]",
            "Te", "Tc", "Mbol", "100 K (H I), 10^4 K (H II), 50 K (H2)",
            "(CH3)2O", "z [pc]", "= 299792458 m s-1", "me", "mp", "mn",
            "mH", "mHe", "RH",
        ):
            self.assertFalse(
                TRANSLATOR_MODULE._table_cell_requires_translation(
                    text, kept_formula
                ),
                text,
            )

        ordinary_label = {
            "bbox": (0, 0, 80, 12),
            "lines": [
                {
                    "bbox": (0, 0, 80, 12),
                    "spans": [
                        {
                            "text": "Temperature K",
                            "font": "Helvetica",
                            "size": 10.0,
                            "bbox": (0, 0, 80, 12),
                        }
                    ],
                }
            ],
        }
        self.assertFalse(TRANSLATOR_MODULE._keep_original_block(ordinary_label))
        self.assertTrue(
            TRANSLATOR_MODULE._table_cell_requires_translation(
                "Temperature K", ordinary_label
            )
        )

    def test_unsupported_content_state_rolls_back_and_strict_verifier_rejects_inversion(self):
        for data in (
            b"q /X0 Do Q BT /F1 10 Tf 1 0 0 1 20 80 Tm (x) Tj ET",
            b"q 0 0 100 100 re W n BT /F1 10 Tf 20 80 Td (x) Tj ET Q",
            b"q /GS1 gs BT /F1 10 Tf 20 80 Td (x) Tj ET Q",
            b"q 1 0 0 1 3 0 cm BT /F1 10 Tf 20 80 Td (x) Tj ET Q",
        ):
            self.assertIsNone(
                TRANSLATOR_MODULE._split_safe_residual_text_stream(data)
            )

        source = self.root / "order-source.pdf"
        output = self.root / "order-output.pdf"
        source_doc = fitz.open()
        page = source_doc.new_page(width=400, height=500)
        page.insert_text((50, 80), "UPPER logical reading order paragraph", fontsize=12)
        page.insert_text((50, 400), "LOWER logical reading order paragraph", fontsize=12)
        source_doc.save(source)
        source_doc.close()

        output_doc = fitz.open()
        page = output_doc.new_page(width=400, height=500)
        page.insert_text((50, 400), "LOWER logical reading order paragraph", fontsize=12)
        page.insert_text((50, 80), "UPPER logical reading order paragraph", fontsize=12)
        contents = list(page.get_contents())
        first = int(contents[0])
        original_data = bytes(output_doc.xref_stream(first) or b"")
        output_doc.update_stream(
            first,
            b"q\n1 0 0 1 0.01 0 cm\n" + original_data + b"\nQ\n",
        )
        before_contents = list(page.get_contents())
        before_pixels = bytes(
            page.get_pixmap(colorspace=fitz.csRGB, alpha=False).samples
        )
        page, diagnostic = TRANSLATOR_MODULE._interleave_safe_page_text_streams(
            output_doc,
            page,
            before_contents,
            {},
            [
                (0, fitz.Rect(50, 65, 300, 90)),
                (1, fitz.Rect(50, 385, 300, 410)),
            ],
        )
        self.assertFalse(diagnostic["applied"], diagnostic)
        self.assertEqual(diagnostic["reason"], "unsupported_residual_stream")
        self.assertEqual(page.get_contents(), before_contents)
        self.assertEqual(
            bytes(page.get_pixmap(colorspace=fitz.csRGB, alpha=False).samples),
            before_pixels,
        )
        output_doc.save(output)
        output_doc.close()

        _proc, report = run_verifier(
            source,
            output,
            self.root / "unsupported-order-report.json",
            intent="restore",
        )
        self.assertEqual(report["gates"]["page_order"]["status"], "fail", report)
        logical = report["gates"]["page_order"]["details"][
            "logical_reading_order"
        ]
        self.assertFalse(logical["matched"], logical)


if __name__ == "__main__":
    unittest.main()
