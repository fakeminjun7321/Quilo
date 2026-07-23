#!/usr/bin/env python3
"""Text-layer, font subset, and reader interoperability regressions."""

from __future__ import annotations

import contextlib
from collections import Counter
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
from fontTools.ttLib import TTFont
from PIL import Image, ImageChops, ImageDraw, ImageOps
from pypdf import PdfReader
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[2]
TRANSLATOR = ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"
FONT = ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"
MATH_FONT = ROOT / "lib" / "fonts" / "STIXTwoMath.otf"

TRANSLATOR_SPEC = importlib.util.spec_from_file_location(
    "translate_pdf_for_text_layer_test", TRANSLATOR
)
TRANSLATOR_MODULE = importlib.util.module_from_spec(TRANSLATOR_SPEC)
assert TRANSLATOR_SPEC.loader is not None
TRANSLATOR_SPEC.loader.exec_module(TRANSLATOR_MODULE)

FIXTURE_SPEC = importlib.util.spec_from_file_location(
    "generate_pdf_fixtures_for_text_layer_test",
    Path(__file__).with_name("generate_fixtures.py"),
)
FIXTURE_MODULE = importlib.util.module_from_spec(FIXTURE_SPEC)
assert FIXTURE_SPEC.loader is not None
FIXTURE_SPEC.loader.exec_module(FIXTURE_MODULE)


def run_translator(command: str, *args: Path, payload=None, check=True):
    proc = subprocess.run(
        [sys.executable, str(TRANSLATOR), command, *(str(arg) for arg in args)],
        input=(json.dumps(payload, ensure_ascii=False) if payload is not None else None),
        text=True,
        capture_output=True,
        check=False,
    )
    if check and proc.returncode:
        raise AssertionError(
            f"translate_pdf.py {command} failed ({proc.returncode})\n"
            f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
        )
    return proc


def render_with_translations(source: Path, output: Path, translations: dict) -> dict:
    proc = run_translator(
        "render", source, output, FONT, payload={"translations": translations}
    )
    return json.loads(proc.stdout)


def extracted_blocks(source: Path) -> list[dict]:
    return json.loads(run_translator("extract", source).stdout)["blocks"]


def identity_render(source: Path, output: Path) -> dict:
    blocks = extracted_blocks(source)
    return render_with_translations(
        source, output, {str(block["id"]): block["text"] for block in blocks}
    )


def normalized(text: str) -> str:
    return " ".join(text.split())


def pypdf_text_without_warnings(path: Path) -> tuple[PdfReader, str, str]:
    warnings = io.StringIO()
    with contextlib.redirect_stderr(warnings):
        reader = PdfReader(str(path), strict=True)
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    return reader, text, warnings.getvalue()


def make_text_source(path: Path, *, bold_second=False) -> None:
    c = canvas.Canvas(str(path), pagesize=A4, invariant=True, pageCompression=1)
    width, height = A4
    c.setFont("Helvetica", 12)
    c.drawString(
        48,
        height - 82,
        "Long source paragraph used for translated text compatibility checks.",
    )
    if bold_second:
        c.setFont("Helvetica-Bold", 16)
        c.drawString(48, height - 180, "Bold source heading")
    else:
        c.setFont("Helvetica", 12)
        c.drawString(48, height - 180, "Rich chemistry source placeholder")
    c.showPage()
    c.save()


def font_xrefs(doc: fitz.Document) -> set[int]:
    return {
        int(font[0])
        for page in doc
        for font in page.get_fonts(full=True)
        if int(font[0]) > 0
    }


def cmap_streams(doc: fitz.Document) -> list[bytes]:
    streams = []
    for xref in font_xrefs(doc):
        key_type, value = doc.xref_get_key(xref, "ToUnicode")
        if key_type != "xref":
            continue
        streams.append(bytes(doc.xref_stream(int(value.split()[0])) or b""))
    return streams


def page_geometry(reader: PdfReader):
    return [
        (
            tuple(float(value) for value in page.mediabox),
            tuple(float(value) for value in page.cropbox),
            int(page.rotation or 0) % 360,
        )
        for page in reader.pages
    ]


def link_summary(reader: PdfReader):
    summary = []
    for page_number, page in enumerate(reader.pages):
        for reference in page.get("/Annots") or []:
            annot = reference.get_object()
            if str(annot.get("/Subtype")) != "/Link":
                continue
            action = annot.get("/A")
            action = action if hasattr(action, "get") else None
            destination = annot.get("/Dest")
            summary.append(
                (
                    page_number,
                    tuple(round(float(value), 3) for value in annot.get("/Rect")),
                    str(action.get("/S")) if action else "/Dest",
                    str(action.get("/URI")) if action and action.get("/URI") else "",
                    str(destination[1]) if destination is not None else "",
                )
            )
    return Counter(summary)


class TextLayerCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="quilo-pdf-text-layer-")
        self.root = Path(self.tempdir.name)

    def tearDown(self):
        self.tempdir.cleanup()

    def test_long_korean_spaces_search_and_cmap_are_extractor_safe(self):
        source = self.root / "source.pdf"
        output = self.root / "translated.pdf"
        make_text_source(source)
        blocks = extracted_blocks(source)
        self.assertEqual(len(blocks), 2)
        korean = (
            "번역은\u00a0텍스트 상자 안에서 산문을 재배치할 수 있지만 문장을 "
            "빠뜨리거나\u202f숫자를 합치면 안 된다. H₂O − 12.50 g 298.15 K 값은 "
            "검색과 복사 과정에서도 각각의 단어 및 단위와 정확히 연결되어야 한다."
        )
        stats = render_with_translations(
            source,
            output,
            {
                str(blocks[0]["id"]): korean,
                str(blocks[1]["id"]): "두 번째 한국어 문장도 공백을 보존한다.",
            },
        )
        self.assertTrue(stats["ok"], stats)
        self.assertGreaterEqual(stats["validated_subset_fonts"], 1)

        with fitz.open(output) as doc:
            fitz_text = "\n".join(page.get_text() for page in doc)
            self.assertTrue(doc[0].search_for("번역은 텍스트 상자 안에서"))
            streams = cmap_streams(doc)
            self.assertTrue(streams)
            for stream in streams:
                self.assertEqual(
                    TRANSLATOR_MODULE._tounicode_stream_anomalies(stream), ()
                )
        self.assertNotIn("\u00a0", fitz_text)
        self.assertNotIn("\u202f", fitz_text)
        self.assertIn("번역은 텍스트 상자 안에서", normalized(fitz_text))
        self.assertIn("H₂O − 12.50 g 298.15 K", normalized(fitz_text))

        _reader, pypdf_text, warnings = pypdf_text_without_warnings(output)
        self.assertEqual(warnings, "")
        self.assertNotIn("\u00a0", pypdf_text)
        self.assertNotIn("\u202f", pypdf_text)
        self.assertIn("번역은 텍스트 상자 안에서", normalized(pypdf_text))
        self.assertIn("H₂O − 12.50 g 298.15 K", normalized(pypdf_text))

    def test_mixed_fallback_and_rich_scripts_preserve_real_spaces(self):
        source = self.root / "mixed-source.pdf"
        output = self.root / "mixed-output.pdf"
        make_text_source(source)
        blocks = extracted_blocks(source)
        stats = render_with_translations(
            source,
            output,
            {
                str(blocks[0]["id"]): "집합 기호 ∈ H₂O − 12.50 g 는 함께 보존된다.",
                str(blocks[1]["id"]): (
                    "화학식 H<sub>2</sub> O 와 x<sup>2</sup> 값 사이 공백"
                ),
            },
        )
        self.assertTrue(stats["ok"], stats)
        self.assertGreaterEqual(stats["validated_subset_fonts"], 2)
        with fitz.open(output) as doc:
            text = normalized("\n".join(page.get_text() for page in doc))
            font_names = {font[3] for font in doc[0].get_fonts(full=True)}
            self.assertTrue(doc[0].search_for("H2 O"))
        self.assertIn("집합 기호 ∈ H₂O − 12.50 g", text)
        self.assertIn("화학식 H2 O 와 x2 값 사이 공백", text)
        self.assertIn("Pretendard Regular", font_names)
        self.assertIn("NanumGothic Regular", font_names)
        _reader, pypdf_text, warnings = pypdf_text_without_warnings(output)
        self.assertEqual(warnings, "")
        self.assertIn("집합 기호 ∈ H₂O − 12.50 g", normalized(pypdf_text))
        self.assertIn("화학식 H2 O 와 x2 값 사이 공백", normalized(pypdf_text))

    def test_source_math_symbols_inside_translated_prose_use_bundled_math_subset(self):
        source = self.root / "inline-math-source.pdf"
        output = self.root / "inline-math-output.pdf"
        document = fitz.open()
        page = document.new_page(width=595, height=240)
        source_font = fitz.Font(fontfile=str(MATH_FONT))
        writer = fitz.TextWriter(page.rect)
        writer.fill_textbox(
            fitz.Rect(42, 42, 553, 130),
            "The time average ⟨x⟩ and the solar mass M⊙ remain inline.",
            font=source_font,
            fontsize=12,
            align=fitz.TEXT_ALIGN_LEFT,
        )
        writer.write_text(page)
        document.save(source)
        document.close()

        blocks = extracted_blocks(source)
        self.assertEqual(len(blocks), 1, blocks)
        self.assertIn("⟨x⟩", blocks[0]["text"])
        self.assertIn("M⊙", blocks[0]["text"])
        target = (
            "시간 평균 ⟨x⟩와 태양질량 M<sub>⊙</sub>은 "
            "번역된 문장 안에서도 각각의 물리적 의미를 유지한다."
        )
        stats = render_with_translations(
            source,
            output,
            {str(blocks[0]["id"]): target},
        )
        self.assertTrue(stats["ok"], stats)
        self.assertGreaterEqual(stats["validated_subset_fonts"], 2)

        with fitz.open(output) as rendered:
            text = normalized("\n".join(page.get_text() for page in rendered))
            font_names = {font[3] for font in rendered[0].get_fonts(full=True)}
            for stream in cmap_streams(rendered):
                self.assertEqual(
                    TRANSLATOR_MODULE._tounicode_stream_anomalies(stream), ()
                )
        self.assertIn("⟨x⟩", text)
        self.assertIn("M⊙", text)
        self.assertIn("STIX Two Math Regular", font_names)

        _reader, pypdf_text, warnings = pypdf_text_without_warnings(output)
        self.assertEqual(warnings, "")
        self.assertIn("⟨x⟩", normalized(pypdf_text))
        self.assertIn("M⊙", normalized(pypdf_text))

    def test_bold_subset_retains_weight_names_and_layout_tables(self):
        source = self.root / "bold-source.pdf"
        output = self.root / "bold-output.pdf"
        make_text_source(source, bold_second=True)
        blocks = extracted_blocks(source)
        stats = render_with_translations(
            source,
            output,
            {
                str(blocks[0]["id"]): "일반 본문은 Regular 글꼴로 출력된다.",
                str(blocks[1]["id"]): "굵은 한국어 제목",
            },
        )
        self.assertTrue(stats["ok"], stats)
        found_bold = False
        with fitz.open(output) as doc:
            for xref in font_xrefs(doc):
                name, _ext, _type, embedded = doc.extract_font(xref)
                if "Bold" not in name:
                    continue
                found_bold = True
                font = TTFont(io.BytesIO(embedded), recalcTimestamp=False)
                self.assertEqual(font["OS/2"].usWeightClass, 700)
                self.assertTrue(font["head"].macStyle & 1)
                self.assertIn("GPOS", font)
                self.assertIn("GSUB", font)
                names = {
                    record.toUnicode()
                    for record in font["name"].names
                    if record.nameID in (1, 2, 4, 6, 16, 17)
                }
                self.assertTrue(any("Bold" in value for value in names), names)
                font.close()
        self.assertTrue(found_bold)

    def test_fixture01_size_links_outline_geometry_and_poppler_background(self):
        source = self.root / "01_text_numbers_links.pdf"
        output = self.root / "fixture01-identity.pdf"
        FIXTURE_MODULE.register_fonts()
        FIXTURE_MODULE.generate_text_links(source)
        stats = identity_render(source, output)
        self.assertTrue(stats["ok"], stats)
        self.assertLess(output.stat().st_size, 250 * 1024)

        source_reader = PdfReader(str(source), strict=True)
        output_reader = PdfReader(str(output), strict=True)
        self.assertEqual(page_geometry(output_reader), page_geometry(source_reader))
        self.assertEqual(link_summary(output_reader), link_summary(source_reader))
        self.assertEqual(len(output_reader.outline), len(source_reader.outline))
        self.assertEqual(str(output_reader.outline[0].title), str(source_reader.outline[0].title))

        pdftoppm = shutil.which("pdftoppm")
        if not pdftoppm:
            self.skipTest("Poppler pdftoppm is unavailable")
        for pdf, stem in ((source, "source"), (output, "output")):
            subprocess.run(
                [
                    pdftoppm,
                    "-f",
                    "1",
                    "-singlefile",
                    "-r",
                    "144",
                    "-png",
                    str(pdf),
                    str(self.root / stem),
                ],
                check=True,
                capture_output=True,
            )
        source_image = Image.open(self.root / "source.png").convert("RGB")
        output_image = Image.open(self.root / "output.png").convert("RGB")
        self.assertEqual(output_image.size, source_image.size)
        mask = Image.new("L", source_image.size, 0)
        draw = ImageDraw.Draw(mask)
        scale = 144 / 72
        for pdf in (source, output):
            with fitz.open(pdf) as doc:
                for block in doc[0].get_text("blocks"):
                    x0, y0, x1, y1 = block[:4]
                    draw.rectangle(
                        (
                            x0 * scale - 8,
                            y0 * scale - 8,
                            x1 * scale + 8,
                            y1 * scale + 8,
                        ),
                        fill=255,
                    )
        outside = ImageOps.invert(mask).convert("RGB")
        background_difference = ImageChops.multiply(
            ImageChops.difference(source_image, output_image), outside
        )
        self.assertIsNone(background_difference.getbbox())

    def test_unsupported_non_bmp_translation_fails_closed(self):
        source = self.root / "emoji-source.pdf"
        output = self.root / "emoji-output.pdf"
        make_text_source(source)
        block = extracted_blocks(source)[0]
        proc = run_translator(
            "render",
            source,
            output,
            FONT,
            payload={"translations": {str(block["id"]): "지원하지 않는 문자 😀"}},
            check=False,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("unsupported non-BMP translation character U+01F600", proc.stderr)
        self.assertFalse(output.exists())

    def test_existing_broken_source_cmap_does_not_trigger_false_positive(self):
        source = self.root / "legacy-broken-cmap.pdf"
        output = self.root / "legacy-restored.pdf"
        doc = fitz.open()
        page = doc.new_page(width=595, height=300)
        full_font = fitz.Font(fontfile=str(FONT))
        writer = fitz.TextWriter(page.rect)
        writer.fill_textbox(
            fitz.Rect(42, 42, 540, 150),
            "번역은 텍스트 상자 안에서 기존 문장을 안전하게 복원한다.",
            font=full_font,
            fontsize=12,
            align=fitz.TEXT_ALIGN_LEFT,
        )
        writer.write_text(page)
        doc.save(source, garbage=3, deflate=True)
        doc.close()

        with fitz.open(source) as legacy:
            baseline = TRANSLATOR_MODULE._cmap_anomaly_inventory(legacy)
        self.assertTrue(baseline, "fixture must contain the historical broken CMap")
        stats = identity_render(source, output)
        self.assertTrue(stats["ok"], stats)
        self.assertTrue(output.exists())
        _reader, _text, warnings = pypdf_text_without_warnings(output)
        self.assertEqual(warnings, "")

    def test_cmap_parser_rejects_odd_and_unpaired_surrogate_destinations(self):
        stream = (
            b"1 beginbfchar\n<0001> <1f150>\nendbfchar\n"
            b"1 beginbfrange\n<0002> <0002> <D800>\nendbfrange\n"
        )
        anomalies = dict(TRANSLATOR_MODULE._tounicode_stream_anomalies(stream))
        self.assertEqual(anomalies["odd_length_hex_destination"], 1)
        self.assertEqual(anomalies["invalid_utf16_destination"], 1)


if __name__ == "__main__":
    unittest.main()
