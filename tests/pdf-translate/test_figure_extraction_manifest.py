#!/usr/bin/env python3
"""API-free regression tests for text-PDF figure extraction completeness."""

import base64
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import fitz


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def make_two_figure_pdf(path):
    doc = fitz.open()
    page = doc.new_page(width=600, height=800)
    # Four separate stroked paths per cluster satisfy _figure_regions' deliberate
    # line-art threshold. The clusters are far apart so they remain occurrences.
    for x0, y0 in ((60, 120), (350, 430)):
        # Thin non-zero rectangles (instead of zero-height lines) also exercise
        # PyMuPDF's positive-area Rect.intersects behavior used by the clusterer.
        page.draw_rect(fitz.Rect(x0, y0, x0 + 110, y0 + 4), color=(0, 0, 0))
        page.draw_rect(fitz.Rect(x0 + 106, y0, x0 + 110, y0 + 100), color=(0, 0, 0))
        page.draw_rect(fitz.Rect(x0, y0 + 96, x0 + 110, y0 + 100), color=(0, 0, 0))
        page.draw_rect(fitz.Rect(x0, y0, x0 + 4, y0 + 100), color=(0, 0, 0))
    doc.save(path)
    doc.close()


def make_repeated_raster_pdf(path):
    doc = fitz.open()
    for _ in range(2):
        page = doc.new_page(width=400, height=500)
        page.insert_image(fitz.Rect(80, 120, 200, 240), stream=PNG_BYTES)
    doc.save(path)
    doc.close()


class FigureExtractionManifestTest(unittest.TestCase):
    def test_identical_raster_pixels_at_two_pages_are_two_occurrences(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source.pdf"
            out_dir = root / "figures"
            make_repeated_raster_pdf(source)
            proc = subprocess.run(
                [sys.executable, str(SCRIPT), "figures", str(source), str(out_dir), "2", "10"],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            manifest = payload["figure_manifest"]
            self.assertTrue(manifest["complete"])
            self.assertEqual(len(manifest["discovered_ids"]), 2)
            self.assertEqual(len(manifest["emitted_ids"]), 2)
            self.assertEqual(len(payload["figures"]), 2)
            first, second = payload["figures"]
            self.assertNotEqual(first["id"], second["id"])
            self.assertNotEqual(first["n"], second["n"])
            self.assertEqual(Path(first["file"]).read_bytes(), Path(second["file"]).read_bytes())

    def test_max_figure_limit_is_reported_as_truncation(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source.pdf"
            out_dir = root / "figures"
            make_two_figure_pdf(source)
            proc = subprocess.run(
                [sys.executable, str(SCRIPT), "figures", str(source), str(out_dir), "2", "1"],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            manifest = payload["figure_manifest"]
            self.assertGreaterEqual(len(manifest["candidate_ids"]), 2)
            self.assertGreaterEqual(len(manifest["discovered_ids"]), 2)
            self.assertEqual(len(manifest["emitted_ids"]), 1)
            self.assertGreaterEqual(len(manifest["truncated_ids"]), 1)
            self.assertEqual(manifest["failed_ids"], [])
            self.assertFalse(manifest["complete"])

    def test_individual_crop_exception_is_reported_by_occurrence_id(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source.pdf"
            out_dir = root / "figures"
            make_two_figure_pdf(source)
            helper = f"""
import importlib.util
import fitz
spec = importlib.util.spec_from_file_location('quilo_translate_pdf_crop_failure', {str(SCRIPT)!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def fail_pixmap(self, *args, **kwargs):
    raise RuntimeError('synthetic crop failure')
fitz.Page.get_pixmap = fail_pixmap
module.cmd_figures({str(source)!r}, {str(out_dir)!r}, 2, 10)
"""
            proc = subprocess.run(
                [sys.executable, "-c", helper],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            manifest = payload["figure_manifest"]
            self.assertEqual(manifest["emitted_ids"], [])
            self.assertGreaterEqual(len(manifest["failed_ids"]), 2)
            self.assertEqual(manifest["failed_ids"], manifest["discovered_ids"])
            self.assertTrue(
                all(item["reason"] == "pixmap_failed" for item in manifest["failures"])
            )
            self.assertFalse(manifest["complete"])


if __name__ == "__main__":
    unittest.main()
