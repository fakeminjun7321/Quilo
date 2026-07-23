#!/usr/bin/env python3
"""Mixed text/image PDF routing regressions for strict OCR coverage."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import fitz


ROOT = Path(__file__).resolve().parents[2]
TRANSLATOR = ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"


def analyze(path: Path) -> dict:
    proc = subprocess.run(
        [sys.executable, str(TRANSLATOR), "analyze", str(path)],
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(proc.stdout)


def insert_scan_page(page: fitz.Page) -> None:
    pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 480, 640), False)
    pixmap.clear_with(220)
    page.insert_image(page.rect, pixmap=pixmap)


class MixedScanRoutingTest(unittest.TestCase):
    def test_one_image_only_page_cannot_hide_behind_many_text_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mixed-60.pdf"
            doc = fitz.open()
            for index in range(60):
                page = doc.new_page(width=595, height=842)
                if index == 41:
                    insert_scan_page(page)
                else:
                    page.insert_text(
                        (50, 80),
                        f"Digitally generated text page {index + 1}. " * 8,
                        fontsize=11,
                    )
            doc.save(path)
            doc.close()

            result = analyze(path)
            self.assertEqual(result["page_count"], 60)
            self.assertTrue(result["scanned"])
            self.assertEqual(result["scan_page_count"], 1)
            self.assertEqual(result["scan_pages"], [42])

    def test_true_blank_page_does_not_force_scan_routing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "text-plus-blank.pdf"
            doc = fitz.open()
            page = doc.new_page(width=595, height=842)
            page.insert_text((50, 80), "Born digital paragraph. " * 20, fontsize=11)
            doc.new_page(width=595, height=842)
            doc.save(path)
            doc.close()

            result = analyze(path)
            self.assertFalse(result["scanned"])
            self.assertEqual(result["scan_page_count"], 0)
            self.assertEqual(result["scan_pages"], [])

    def test_one_hidden_ocr_scan_page_cannot_hide_among_digital_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mixed-hidden-ocr-60.pdf"
            doc = fitz.open()
            for index in range(60):
                page = doc.new_page(width=595, height=842)
                if index == 41:
                    insert_scan_page(page)
                    page.insert_text(
                        (50, 80),
                        "Invisible OCR measurement 84.20 mL at 101.3 kPa " * 4,
                        fontsize=11,
                        render_mode=3,
                    )
                else:
                    page.insert_text(
                        (50, 80),
                        f"Digitally generated text page {index + 1}. " * 8,
                        fontsize=11,
                    )
            doc.save(path)
            doc.close()

            result = analyze(path)
            self.assertTrue(result["scanned"])
            self.assertTrue(result["ocr_layer"])
            self.assertEqual(result["scan_page_count"], 1)
            self.assertEqual(result["scan_pages"], [42])

    def test_short_digital_title_page_does_not_force_scan_routing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "short-title.pdf"
            doc = fitz.open()
            title = doc.new_page(width=595, height=842)
            title.insert_text((72, 120), "Short title", fontsize=24)
            body = doc.new_page(width=595, height=842)
            body.insert_text((50, 80), "Born digital paragraph. " * 30, fontsize=11)
            doc.save(path)
            doc.close()

            result = analyze(path)
            self.assertFalse(result["scanned"])
            self.assertEqual(result["scan_pages"], [])


if __name__ == "__main__":
    unittest.main()
