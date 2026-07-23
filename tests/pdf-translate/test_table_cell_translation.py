#!/usr/bin/env python3
"""Table-cell extraction and cell-bounded in-place rendering regressions."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

import fitz
from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[2]
TRANSLATOR = ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"
VERIFIER = ROOT / "scripts" / "verify_translation.py"
FONT = ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"

FIXTURE_SPEC = importlib.util.spec_from_file_location(
    "quilo_pdf_fixture_generator_for_table_test",
    Path(__file__).with_name("generate_fixtures.py"),
)
FIXTURES = importlib.util.module_from_spec(FIXTURE_SPEC)
assert FIXTURE_SPEC.loader is not None
FIXTURE_SPEC.loader.exec_module(FIXTURES)


def run_translator(command: str, *args: Path, payload=None) -> dict:
    completed = subprocess.run(
        [sys.executable, str(TRANSLATOR), command, *(str(arg) for arg in args)],
        input=json.dumps(payload, ensure_ascii=False) if payload is not None else None,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode:
        raise AssertionError(
            f"translate_pdf.py {command} failed ({completed.returncode})\n"
            f"stdout: {completed.stdout}\nstderr: {completed.stderr}"
        )
    return json.loads(completed.stdout)


def table_blocks(extracted: dict) -> list[dict]:
    return [
        block
        for block in extracted["blocks"]
        if str(block["id"]).startswith("__pdf_table_cell__:")
    ]


def word_rects(path: Path, token: str) -> list[fitz.Rect]:
    with fitz.open(path) as document:
        return [
            fitz.Rect(*word[:4])
            for page in document
            for word in page.get_text("words")
            if word[4] == token
        ]


def rendered_clip(path: Path, page_number: int, rect: fitz.Rect) -> tuple:
    with fitz.open(path) as document:
        pixmap = document[page_number].get_pixmap(
            matrix=fitz.Matrix(2, 2),
            clip=rect,
            colorspace=fitz.csRGB,
            alpha=False,
        )
        return pixmap.width, pixmap.height, bytes(pixmap.samples)


def make_structural_table_pdf(path: Path) -> None:
    """Merged/full-grid, booktabs, borderless, multiline and narrow cells."""
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setTitle("Synthetic table layout fixture")
    c.setSubject("Cell-bounded translation regression")

    # Page 1: one merged heading, a multiline/narrow header and an adjacent chart.
    x = [50, 120, 185, 285]
    y_top = 680
    row_heights = [28, 34, 24, 24, 24]
    y = [y_top]
    for height in row_heights:
        y.append(y[-1] - height)
    c.setStrokeColor(colors.HexColor("#334155"))
    c.setLineWidth(0.8)
    for yy in y:
        c.line(x[0], yy, x[-1], yy)
    c.line(x[0], y[-1], x[0], y[0])
    c.line(x[-1], y[-1], x[-1], y[0])
    # The first row is a real merged cell: internal rules begin below it.
    for xx in x[1:-1]:
        c.line(xx, y[-1], xx, y[1])
    c.setFont("Helvetica-Bold", 8.5)
    c.drawCentredString((x[0] + x[-1]) / 2, y[0] - 19, "Measurement summary")
    c.drawCentredString((x[0] + x[1]) / 2, y[1] - 21, "Trial")
    c.drawCentredString((x[1] + x[2]) / 2, y[1] - 14, "Average")
    c.drawCentredString((x[1] + x[2]) / 2, y[1] - 25, "time s")
    c.drawRightString(x[3] - 5, y[1] - 21, "Distance m")
    rows = (("A", "1.25", "0.125"), ("B", "2.50", "0.250"), ("C", "3.75", "0.375"))
    c.setFont("Helvetica", 8.5)
    for row_number, row in enumerate(rows, start=2):
        for column, value in enumerate(row):
            c.drawCentredString(
                (x[column] + x[column + 1]) / 2,
                y[row_number] - 16,
                value,
            )

    # Adjacent vector chart / label must remain untouched.
    c.setStrokeColor(colors.HexColor("#475569"))
    c.rect(340, 500, 220, 160, stroke=1, fill=0)
    for index in range(1, 5):
        c.line(340 + index * 42, 500, 340 + index * 42, 660)
        c.line(340, 500 + index * 30, 560, 500 + index * 30)
    c.setStrokeColor(colors.HexColor("#dc2626"))
    c.setLineWidth(2)
    c.line(350, 515, 545, 640)
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(350, 643, "AXIS-LABEL-V1")
    c.showPage()

    # Page 2: booktabs (horizontal rules only).
    c.setStrokeColor(colors.HexColor("#334155"))
    c.setLineWidth(0.8)
    for yy in (680, 648, 554):
        c.line(70, yy, 470, yy)
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 9)
    for xx, value in zip((90, 230, 370), ("Sample", "Temperature K", "Result label")):
        c.drawString(xx, 658, value)
    c.setFont("Helvetica", 9)
    for yy, row in zip(
        (625, 596, 567),
        (("S1", "298.15", "PASS"), ("S2", "301.20", "PASS"), ("S3", "305.50", "FAIL")),
    ):
        for xx, value in zip((90, 230, 370), row):
            c.drawString(xx, yy, value)
    c.showPage()

    # Page 3: compact borderless table.  The strict text-strategy guard must
    # accept this, but it must reject ordinary sentence columns.
    c.setFont("Helvetica-Bold", 9)
    for xx, value in zip((90, 230, 370), ("Batch", "Pressure kPa", "Operator note")):
        c.drawString(xx, 670, value)
    c.setFont("Helvetica", 9)
    for yy, row in zip(
        (640, 610, 580),
        (("B1", "101.3", "OK"), ("B2", "99.8", "OK"), ("B3", "102.4", "HOLD")),
    ):
        for xx, value in zip((90, 230, 370), row):
            c.drawString(xx, yy, value)
    c.showPage()
    c.save()


def make_formula_header_collision_table_pdf(path: Path) -> None:
    """Booktabs table whose adjacent formula headers share one source block.

    This mirrors scientific publishers which paint the two visual headings as one
    display-math stream.  MuPDF's whitespace table inference may still expose a
    narrower synthetic cell ending before the source block, so repainting that cell
    would leave the source block's trailing glyphs over the generated overlay.
    """
    c = canvas.Canvas(str(path), pagesize=letter, invariant=1)
    c.setTitle("Formula header ownership fixture")
    c.setSubject("Natural table labels translate while formula headings stay original")
    c.setStrokeColor(colors.HexColor("#334155"))
    c.setLineWidth(0.8)
    for yy in (680, 650, 520):
        c.line(50, yy, 300, yy)

    c.setFillColor(colors.black)
    c.setFont(FIXTURES.FONT_REGULAR, 10)
    c.drawString(60, 660, "Date range")
    # These calls intentionally share the same baseline / font so ReportLab emits
    # one logical source block even though the visible table has two formula cells.
    c.drawString(149, 660, "E = mc2")
    c.drawString(220, 660, "TT − UTC")
    for yy, date, atomic, terrestrial in (
        (630, "1972-01-01", "10 s", "42.184 s"),
        (605, "1972-07-01", "11 s", "43.184 s"),
        (580, "1973-01-01", "12 s", "44.184 s"),
        (555, "1974-01-01", "13 s", "45.184 s"),
    ):
        c.drawString(60, yy, date)
        c.drawString(149, yy, atomic)
        c.drawString(220, yy, terrestrial)
    c.showPage()
    c.save()


def make_long_definition_table_pdf(path: Path) -> None:
    """Strong grid whose ordinary source rows contain long natural-language cells."""
    c = canvas.Canvas(str(path), pagesize=letter, invariant=1)
    c.setTitle("Long definition table ownership fixture")
    x = (50, 145, 215, 560)
    y = (680, 650, 620, 590)
    c.setStrokeColor(colors.HexColor("#334155"))
    c.setLineWidth(0.8)
    for yy in y:
        c.line(x[0], yy, x[-1], yy)
    for xx in x:
        c.line(xx, y[-1], xx, y[0])
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 8.5)
    for xx, value in zip(x, ("Quantity", "Unit", "Definition")):
        c.drawString(xx + 4, 660, value)
    c.setFont("Helvetica", 8.0)
    rows = (
        (
            "Mass",
            "Kilogram",
            "Equal to the mass of the international prototype of the kilogram.",
        ),
        (
            "Time",
            "Second",
            "The duration of radiation periods corresponding to a caesium transition.",
        ),
    )
    for baseline, row in zip((630, 600), rows):
        for xx, value in zip(x, row):
            c.drawString(xx + 4, baseline, value)
    c.showPage()
    c.save()


def make_running_rule_and_figure_frame_prose_pdf(path: Path) -> None:
    """Book prose between a running rule and a nearby illustration frame.

    The two long horizontal edges are intentionally close enough to satisfy the
    coarse booktabs grouping heuristic.  Justified-looking word starts must not
    turn the intervening prose into a synthetic text-strategy table.
    """
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setTitle("Running rule and figure frame prose regression")
    c.setStrokeColor(colors.HexColor("#475569"))
    c.setLineWidth(0.8)
    c.line(50, 732, 560, 732)
    # Three sides mirror a clipped textbook illustration frame.  Its upper edge
    # is 132 points below the running rule in PDF top-origin coordinates.
    c.line(150, 600, 500, 600)
    c.line(150, 600, 150, 320)
    c.line(500, 600, 500, 320)

    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(150, 710, "Preface to the Test Edition")
    text = c.beginText(150, 686)
    text.setFont("Helvetica", 9)
    text.setLeading(13)
    for line in (
        "As the title suggests this book explains fundamental ideas for readers",
        "who need accurate but approachable mathematical descriptions of space.",
        "The chapter on the solar system is divided into several useful sections.",
        "Individual objects are discussed carefully as new observations accumulate.",
        "These revisions preserve the original figures and improve the explanations.",
        "Several other chapters contain smaller corrections for advanced students.",
    ):
        text.textLine(line)
    c.drawText(text)
    c.showPage()

    # Page 2 has no rules at all.  Compact, evenly aligned prose must still stay
    # prose instead of becoming a borderless table via the text strategy.
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(72, 720, "A Ruleless Prose Section")
    text = c.beginText(72, 694)
    text.setFont("Helvetica", 9)
    text.setLeading(13)
    for line in (
        "Astronomical observations often require patient calibration and review.",
        "Careful readers compare each measurement with the surrounding evidence.",
        "A consistent explanation remains more important than visual coincidence.",
        "Ordinary sentences can share word positions without forming table columns.",
        "The translation engine must preserve these paragraphs as coherent prose.",
    ):
        text.textLine(line)
    c.drawText(text)
    c.showPage()
    c.save()


class TableCellTranslationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="quilo-pdf-table-test-")
        self.root = Path(self.tempdir.name)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_fixture02_translates_only_headers_and_preserves_data_geometry(self):
        source = self.root / "fixture02.pdf"
        output = self.root / "fixture02-ko.pdf"
        FIXTURES.register_fonts()
        FIXTURES.generate_two_column(source)

        extracted = run_translator("extract", source)
        headers = table_blocks(extracted)
        self.assertEqual(
            [(block["id"], block["text"]) for block in headers],
            [
                ("__pdf_table_cell__:p0001:t000:r000:c000", "Trial"),
                ("__pdf_table_cell__:p0001:t000:r000:c001", "Time s"),
                ("__pdf_table_cell__:p0001:t000:r000:c002", "Distance m"),
            ],
        )
        self.assertFalse(
            any(block["text"] in {"A", "B", "C", "1.25", "3.75", "0.375"} for block in headers)
        )

        replacements = {
            "Trial": "시도",
            "Time s": "시간 s",
            "Distance m": "거리 m",
            "Two-column field record": "두 열 현장 기록",
            "Synthetic CC0 regression fixture": "합성 CC0 회귀 테스트 픽스처",
            "Two-column, table, and vector fixture": "두 열 표와 벡터 테스트 픽스처",
            "Synthetic CC0 fixture content": "합성 CC0 테스트 내용",
        }

        def translated(block: dict) -> str:
            text = replacements.get(block["text"], block["text"])
            text = re.sub(
                r"concise source sentence\.$",
                "간결한 원본 문장입니다.",
                text,
            )
            text = text.replace(" | page ", " | 페이지 ")
            return text

        translations = {str(block["id"]): translated(block) for block in extracted["blocks"]}
        stats = run_translator(
            "render", source, output, FONT, payload={"translations": translations}
        )
        self.assertTrue(stats["ok"], stats)
        self.assertEqual(stats["failed"], 0)
        self.assertEqual(stats["overflow"], 0)

        # Numeric measurements and one-letter row IDs are not redrawn: their exact
        # source coordinates (including the historical last-row C) are immutable.
        for token in ("A", "B", "C", "1.25", "2.50", "3.75", "0.125", "0.250", "0.375"):
            before = word_rects(source, token)
            after = word_rects(output, token)
            self.assertEqual(len(after), len(before), token)
            for actual, expected in zip(after, before):
                self.assertEqual(tuple(actual), tuple(expected), token)

        reader_text = "\n".join(page.extract_text() or "" for page in PdfReader(output).pages)
        self.assertNotRegex(reader_text, r"\b(?:Trial|Time|Distance)\b")
        self.assertIn("시도", reader_text)
        self.assertIn("시간", reader_text)
        self.assertIn("거리", reader_text)
        self.assertNotIn("C3.750.375", " ".join(reader_text.split()))

        # Table rules and the neighbouring vector chart are pixel-identical.
        for y in (389.89, 411.89, 433.89, 455.89, 477.89):
            strip = fitz.Rect(48, y - 0.65, 272, y + 0.65)
            self.assertEqual(rendered_clip(output, 0, strip), rendered_clip(source, 0, strip))
        chart = fitz.Rect(310, 385, 550, 570)
        self.assertEqual(rendered_clip(output, 0, chart), rendered_clip(source, 0, chart))

        report_path = self.root / "fixture02-report.json"
        verified = subprocess.run(
            [
                sys.executable,
                str(VERIFIER),
                str(output),
                "--original",
                str(source),
                "--mode",
                "inplace",
                "--intent",
                "translate",
                "--json",
                str(report_path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertTrue(report_path.is_file(), verified.stdout + verified.stderr)
        report = json.loads(report_path.read_text(encoding="utf-8"))
        for gate in (
            "untranslated_text",
            "number_preservation",
            "nontext_visual_preservation",
            "vector_provenance",
        ):
            self.assertEqual(report["gates"][gate]["status"], "pass", (gate, report))

    def test_single_column_ruled_panel_is_not_hidden_as_an_ambiguous_table(self):
        """A top/bottom rule around prose is an info panel, not a booktabs table."""
        source = self.root / "math-panel.pdf"
        FIXTURES.register_fonts()
        FIXTURES.generate_math_chem(source)

        extracted = run_translator("extract", source)
        texts = [block["text"] for block in extracted["blocks"]]
        self.assertIn(
            "ASCII invariants: H2SO4 | CO2 | 6.022e23 | E = mc2",
            texts,
        )
        self.assertIn(
            "Do not translate variable names, coefficients, charges, or equation numbers.",
            texts,
        )
        self.assertFalse(table_blocks(extracted))

    def test_running_rule_and_figure_frame_do_not_turn_book_prose_into_cells(self):
        source = self.root / "running-rule-figure-frame.pdf"
        make_running_rule_and_figure_frame_prose_pdf(source)

        extracted = run_translator("extract", source)
        self.assertFalse(table_blocks(extracted))
        prose = " ".join(block["text"] for block in extracted["blocks"])
        self.assertIn("Preface to the Test Edition", prose)
        self.assertIn("The chapter on the solar system", prose)
        self.assertIn("Individual objects are discussed carefully", prose)
        self.assertIn("A Ruleless Prose Section", prose)
        self.assertIn("Ordinary sentences can share word positions", prose)

    def test_table_page_with_unprovable_interleave_fails_closed(self):
        source = self.root / "fixture02.pdf"
        unsafe = self.root / "fixture02-unsafe-stream.pdf"
        output = self.root / "fixture02-unsafe-output.pdf"
        FIXTURES.register_fonts()
        FIXTURES.generate_two_column(source)

        with fitz.open(source) as document:
            page = document[0]
            content_xref = int(page.get_contents()[0])
            original = bytes(document.xref_stream(content_xref) or b"")
            # A non-identity CTM is deliberately outside the proven reorder subset.
            document.update_stream(
                content_xref,
                b"q 1 0 0 1 0.01 0 cm\n" + original + b"\nQ\n",
            )
            document.save(unsafe)

        extracted = run_translator("extract", unsafe)
        self.assertTrue(table_blocks(extracted))
        translations = {
            str(block["id"]): block["text"] for block in extracted["blocks"]
        }
        completed = subprocess.run(
            [
                sys.executable,
                str(TRANSLATOR),
                "render",
                str(unsafe),
                str(output),
                str(FONT),
            ],
            input=json.dumps({"translations": translations}, ensure_ascii=False),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(completed.returncode, 0, completed.stdout)
        self.assertIn("table translation reading-order interleave", completed.stderr)
        self.assertFalse(output.exists())

    def test_formula_only_table_header_has_one_source_owner(self):
        source = self.root / "formula-header-ownership.pdf"
        output = self.root / "formula-header-ownership-ko.pdf"
        FIXTURES.register_fonts()
        make_formula_header_collision_table_pdf(source)

        extracted = run_translator("extract", source)
        cells = table_blocks(extracted)
        self.assertEqual(
            [(block["id"], block["text"]) for block in cells],
            [("__pdf_table_cell__:p0001:t000:r000:c000", "Date range")],
        )
        self.assertFalse(
            any("TT" in block["text"] or "UTC" in block["text"] for block in cells)
        )

        translations = {
            str(block["id"]): (
                "날짜 범위" if block["text"] == "Date range" else block["text"]
            )
            for block in extracted["blocks"]
        }
        stats = run_translator(
            "render", source, output, FONT, payload={"translations": translations}
        )
        self.assertTrue(stats["ok"], stats)
        self.assertEqual(stats["failed"], 0)
        self.assertEqual(stats["overflow"], 0)

        output_text = "\n".join(
            page.extract_text() or "" for page in PdfReader(output).pages
        )
        self.assertIn("날짜 범위", output_text)
        self.assertNotIn("Date range", output_text)
        self.assertIn("E = mc2", output_text)
        self.assertIn("TT − UTC", output_text)

        # The complete shared formula stream is byte-for-byte visually identical;
        # only the independently owned natural-language cell is repainted.
        formula_band = fitz.Rect(145, 118, 300, 139)
        self.assertEqual(
            rendered_clip(output, 0, formula_band),
            rendered_clip(source, 0, formula_band),
        )
        for token in ("1972-01-01", "10", "42.184", "1974-01-01", "45.184"):
            self.assertEqual(word_rects(output, token), word_rects(source, token), token)
        for y in (112.0, 142.0, 272.0):
            strip = fitz.Rect(49, y - 0.6, 301, y + 0.6)
            self.assertEqual(
                rendered_clip(output, 0, strip), rendered_clip(source, 0, strip)
            )

    def test_long_definition_grid_uses_only_synthetic_cell_owners(self):
        source = self.root / "long-definition-table.pdf"
        make_long_definition_table_pdf(source)

        extracted = run_translator("extract", source)
        cells = table_blocks(extracted)
        cell_texts = {block["text"] for block in cells}
        self.assertIn("Kilogram", cell_texts)
        self.assertIn(
            "Equal to the mass of the international prototype of the kilogram.",
            cell_texts,
        )
        ordinary_texts = [
            block["text"]
            for block in extracted["blocks"]
            if not str(block["id"]).startswith("__pdf_table_cell__:")
        ]
        self.assertFalse(
            any("international prototype" in text for text in ordinary_texts),
            ordinary_texts,
        )
        self.assertFalse(
            any("caesium transition" in text for text in ordinary_texts),
            ordinary_texts,
        )

    def test_merged_multiline_booktabs_borderless_and_narrow_cells(self):
        source = self.root / "structural-tables.pdf"
        output = self.root / "structural-tables-ko.pdf"
        make_structural_table_pdf(source)

        first = run_translator("extract", source)
        second = run_translator("extract", source)
        first_cells = table_blocks(first)
        self.assertEqual(
            [(block["id"], block["text"]) for block in first_cells],
            [(block["id"], block["text"]) for block in table_blocks(second)],
        )
        texts = [block["text"] for block in first_cells]
        self.assertNotIn("AXIS-LABEL-V1", texts)
        for expected in (
            "Measurement summary",
            "Trial",
            "Average time s",
            "Distance m",
            "Sample",
            "Temperature K",
            "Result label",
            "Batch",
            "Pressure kPa",
            "Operator note",
            "PASS",
            "FAIL",
            "OK",
            "HOLD",
        ):
            self.assertIn(expected, texts)
        for literal in ("A", "B", "C", "1.25", "0.375", "S1", "298.15", "B1", "101.3"):
            self.assertNotIn(literal, texts)

        replacements = {
            "Measurement summary": "측정 요약",
            "Trial": "시도",
            "Average time s": "평균 시간 s",
            "Distance m": "거리 m",
            "Sample": "시료",
            "Temperature K": "온도 K",
            "Result label": "결과 분류",
            "Batch": "배치",
            "Pressure kPa": "압력 kPa",
            "Operator note": "작업자 메모",
            "PASS": "통과",
            "FAIL": "실패",
            "OK": "정상",
            "HOLD": "보류",
            "Synthetic table layout fixture": "합성 표 레이아웃 픽스처",
            "Cell-bounded translation regression": "셀 경계 번역 회귀 검사",
        }
        translations = {
            str(block["id"]): replacements.get(block["text"], block["text"])
            for block in first["blocks"]
        }
        stats = run_translator(
            "render", source, output, FONT, payload={"translations": translations}
        )
        self.assertTrue(stats["ok"], stats)
        self.assertEqual(stats["failed"], 0)
        self.assertEqual(stats["overflow"], 0)
        table_fonts = [
            item
            for item in stats["font_sizes"]
            if str(item["id"]).startswith("__pdf_table_cell__:")
        ]
        self.assertEqual(len(table_fonts), len(first_cells))
        self.assertGreaterEqual(min(item["rendered"] for item in table_fonts), 5.0)

        output_text = "\n".join(page.extract_text() or "" for page in PdfReader(output).pages)
        for expected in (
            "측정 요약", "평균 시간", "결과 분류", "압력", "작업자 메모",
            "통과", "실패", "정상", "보류",
        ):
            self.assertIn(expected, output_text)
        self.assertNotRegex(
            output_text,
            r"\b(?:Measurement|Trial|Average|Distance|Sample|Temperature|Result|Pressure|Operator)\b",
        )
        self.assertNotRegex(output_text, r"\b(?:PASS|FAIL|OK|HOLD)\b")
        for token in ("A", "B", "C", "1.25", "3.75", "0.375", "S1", "298.15", "B1", "101.3"):
            self.assertEqual(word_rects(output, token), word_rects(source, token), token)

        # The merged title remains one centred text block inside the full-width
        # first cell; all Korean table text stays within detected table bounds.
        with fitz.open(output) as document:
            title_hits = document[0].search_for("측정 요약")
            self.assertEqual(len(title_hits), 1)
            title = title_hits[0]
            self.assertGreaterEqual(title.x0, 50)
            self.assertLessEqual(title.x1, 285)
            self.assertGreaterEqual(title.y0, 112)
            self.assertLessEqual(title.y1, 140)
            translated_right = document[0].search_for("거리 m")
            self.assertEqual(len(translated_right), 1)
        with fitz.open(source) as document:
            source_right = document[0].search_for("Distance m")
            self.assertEqual(len(source_right), 1)
        self.assertAlmostEqual(
            translated_right[0].x1, source_right[0].x1, delta=1.0
        )

        chart = fitz.Rect(335, 125, 565, 298)
        self.assertEqual(rendered_clip(output, 0, chart), rendered_clip(source, 0, chart))

        for page, diagnostic in stats["reading_order"].items():
            self.assertEqual(diagnostic["reason"], "pixel_exact", (page, diagnostic))
        report_path = self.root / "structural-tables-report.json"
        verified = subprocess.run(
            [
                sys.executable,
                str(VERIFIER),
                str(output),
                "--original",
                str(source),
                "--mode",
                "inplace",
                "--intent",
                "translate",
                "--json",
                str(report_path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(verified.returncode, 0, verified.stdout + verified.stderr)
        report = json.loads(report_path.read_text(encoding="utf-8"))
        self.assertTrue(report["passed"], report)
        for gate in ("page_order", "untranslated_text", "number_preservation"):
            self.assertEqual(report["gates"][gate]["status"], "pass", gate)


if __name__ == "__main__":
    unittest.main()
