#!/usr/bin/env python3
"""In-place renderer regressions for spatial anchors and page backgrounds."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import fitz


ROOT = Path(__file__).resolve().parents[2]
TRANSLATOR = ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"
FONT = ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"
GENERATOR_PATH = Path(__file__).with_name("generate_fixtures.py")
GENERATOR_SPEC = importlib.util.spec_from_file_location(
    "quilo_pdf_fixture_generator_for_layout_test", GENERATOR_PATH
)
fixture_generator = importlib.util.module_from_spec(GENERATOR_SPEC)
assert GENERATOR_SPEC.loader is not None
GENERATOR_SPEC.loader.exec_module(fixture_generator)


def run_translator(command: str, *args: Path, payload: dict | None = None) -> dict:
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


def render_with_replacements(
    source: Path, output: Path, replacements: dict[str, str]
) -> tuple[dict, dict]:
    extracted = run_translator("extract", source)
    translations = {
        str(block["id"]): replacements.get(block["text"], block["text"])
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


def rect_on_page(page: fitz.Page, text: str, *, top: bool | None = None) -> fitz.Rect:
    rects = page.search_for(text)
    if top is True:
        rects = [rect for rect in rects if rect.y0 < 100]
    elif top is False:
        rects = [rect for rect in rects if rect.y0 > 700]
    if len(rects) != 1:
        raise AssertionError(f"expected one {text!r} rect, got {rects!r}")
    return rects[0]


def background_fraction(page: fitz.Page, expected: tuple[int, int, int], tolerance=3) -> float:
    pix = page.get_pixmap(colorspace=fitz.csRGB, alpha=False)
    samples = pix.samples
    matched = 0
    for offset in range(0, len(samples), 3):
        if all(abs(samples[offset + channel] - expected[channel]) <= tolerance for channel in range(3)):
            matched += 1
    return matched / max(1, pix.width * pix.height)


class RenderLayoutPreservationTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="quilo-pdf-layout-test-")
        self.root = Path(self.tempdir.name)
        fixture_generator.register_fonts()

    def tearDown(self):
        self.tempdir.cleanup()

    def make_fixture01(self) -> Path:
        source = self.root / "01_text_numbers_links.pdf"
        fixture_generator.generate_text_links(source)
        return source

    def test_fixture01_extract_splits_distant_header_and_footer_runs(self):
        extracted = run_translator("extract", self.make_fixture01())
        texts = [block["text"] for block in extracted["blocks"]]
        self.assertIn("Measurement transfer note", texts)
        self.assertIn("FIXTURE-TEXT-001", texts)
        self.assertIn("Synthetic CC0 regression fixture", texts)
        self.assertIn("FIXTURE-TEXT-001 | page 1", texts)
        self.assertFalse(
            any("noteFIXTURE-TEXT-001" in text for text in texts), texts
        )
        self.assertFalse(
            any("fixtureFIXTURE-TEXT-001" in text for text in texts), texts
        )

    def test_fixture01_identity_and_korean_render_keep_page_anchors(self):
        source = self.make_fixture01()
        identity = self.root / "identity.pdf"
        _meta, identity_stats = render_with_replacements(source, identity, {})
        self.assertTrue(identity_stats["ok"], identity_stats)

        with fitz.open(source) as source_doc, fitz.open(identity) as output_doc:
            source_page = source_doc[0]
            output_page = output_doc[0]
            source_header = rect_on_page(source_page, "Measurement transfer note")
            output_header = rect_on_page(output_page, "Measurement transfer note")
            source_marker = rect_on_page(source_page, "FIXTURE-TEXT-001", top=True)
            output_marker = rect_on_page(output_page, "FIXTURE-TEXT-001", top=True)
            source_footer = rect_on_page(source_page, "Synthetic CC0 regression fixture")
            output_footer = rect_on_page(output_page, "Synthetic CC0 regression fixture")
            source_page_id = rect_on_page(
                source_page, "FIXTURE-TEXT-001 | page 1"
            )
            output_page_id = rect_on_page(
                output_page, "FIXTURE-TEXT-001 | page 1"
            )
            self.assertAlmostEqual(output_header.x0, source_header.x0, delta=4.0)
            self.assertAlmostEqual(output_marker.x1, source_marker.x1, delta=1.0)
            self.assertGreater(output_marker.x0 - output_header.x1, 150.0)
            self.assertAlmostEqual(output_footer.x0, source_footer.x0, delta=4.0)
            self.assertAlmostEqual(output_page_id.x1, source_page_id.x1, delta=1.0)
            for label in (
                "Invariant measurement ledger",
                "External references",
                "Jump to the fixture heading",
            ):
                self.assertAlmostEqual(
                    rect_on_page(output_page, label).x0,
                    rect_on_page(source_page, label).x0,
                    delta=4.0,
                )

        korean = self.root / "korean.pdf"
        replacements = {
            "Measurement transfer note": "측정 전송 노트",
            "Invariant measurement ledger": "불변 측정 원장",
            "External references": "외부 참조",
            "Jump to the fixture heading": "피스처 제목으로 이동",
            "Synthetic CC0 regression fixture": "합성 CC0 회귀 피스처",
        }
        _meta, korean_stats = render_with_replacements(source, korean, replacements)
        self.assertTrue(korean_stats["ok"], korean_stats)
        with fitz.open(source) as source_doc, fitz.open(korean) as output_doc:
            source_page = source_doc[0]
            output_page = output_doc[0]
            for source_text, translated_text in replacements.items():
                self.assertAlmostEqual(
                    rect_on_page(output_page, translated_text).x0,
                    rect_on_page(source_page, source_text).x0,
                    delta=4.0,
                )
            self.assertAlmostEqual(
                rect_on_page(output_page, "FIXTURE-TEXT-001", top=True).x1,
                rect_on_page(source_page, "FIXTURE-TEXT-001", top=True).x1,
                delta=1.0,
            )
            self.assertAlmostEqual(
                rect_on_page(output_page, "FIXTURE-TEXT-001 | page 1").x1,
                rect_on_page(source_page, "FIXTURE-TEXT-001 | page 1").x1,
                delta=1.0,
            )

    def test_white_colored_and_black_page_backgrounds_survive_redaction(self):
        source = self.root / "backgrounds.pdf"
        output = self.root / "backgrounds-translated.pdf"
        backgrounds = ((255, 255, 255), (38, 89, 140), (0, 0, 0))
        foregrounds = ((0, 0, 0), (0, 0, 0), (255, 255, 255))
        source_texts = (
            "White background source text",
            "Colored background source text",
            "Black background source text",
        )
        translations = ("흰 배경 시험", "유색 배경 시험", "검은 배경 시험")
        document = fitz.open()
        for background, foreground, text in zip(
            backgrounds, foregrounds, source_texts
        ):
            page = document.new_page(width=300, height=200)
            bg = tuple(channel / 255 for channel in background)
            fg = tuple(channel / 255 for channel in foreground)
            page.draw_rect(page.rect, color=bg, fill=bg, overlay=False)
            page.insert_textbox(
                fitz.Rect(35, 70, 265, 115),
                text,
                fontsize=14,
                fontname="helv",
                color=fg,
            )
        document.save(source)
        document.close()

        replacements = dict(zip(source_texts, translations))
        _meta, stats = render_with_replacements(source, output, replacements)
        self.assertTrue(stats["ok"], stats)
        with fitz.open(source) as source_doc, fitz.open(output) as output_doc:
            self.assertEqual(len(source_doc), 3)
            self.assertEqual(len(output_doc), 3)
            for index, expected in enumerate(backgrounds):
                self.assertGreater(
                    background_fraction(source_doc[index], expected), 0.90
                )
                self.assertGreater(
                    background_fraction(output_doc[index], expected), 0.90
                )
                self.assertEqual(len(output_doc[index].search_for(translations[index])), 1)


if __name__ == "__main__":
    unittest.main()
