"""Pre-allocation resource limits for OCR visual page rendering."""

from __future__ import annotations

import json
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import fitz


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "lib" / "pipelines" / "pdf-translate" / "ocr-page-tool.py"
VERIFY_PATH = ROOT / "scripts" / "verify_translation.py"
VERIFY_SPEC = importlib.util.spec_from_file_location(
    "verify_translation_render_limits", VERIFY_PATH
)
VERIFY = importlib.util.module_from_spec(VERIFY_SPEC)
assert VERIFY_SPEC.loader is not None
VERIFY_SPEC.loader.exec_module(VERIFY)


class OcrPageToolLimitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def make_pdf(self, name: str, width: float, height: float) -> Path:
        path = self.root / name
        document = fitz.open()
        document.new_page(width=width, height=height)
        document.save(path)
        document.close()
        return path

    def run_render(self, pdf: Path):
        output = self.root / f"render-{pdf.stem}"
        process = subprocess.run(
            [sys.executable, str(TOOL), "render", str(pdf), str(output), "[0]", "1400"],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        return process, output

    def test_moderately_wide_page_stays_readable_and_bounded(self):
        process, _ = self.run_render(self.make_pdf("wide.pdf", 4000, 1000))
        self.assertEqual(process.returncode, 0, process.stderr)
        payload = json.loads(process.stdout)
        tile = payload["pages"][0]["tiles"][0]
        self.assertLessEqual(tile["width"], 4096)
        self.assertLessEqual(tile["width"] * tile["height"], 12_000_000)

    def test_ultra_wide_page_fails_before_writing_any_tile(self):
        process, output = self.run_render(
            self.make_pdf("ultra-wide.pdf", 100_000, 1000)
        )
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("unsafe", process.stderr)
        self.assertEqual(list(output.glob("*.png")) if output.exists() else [], [])

    def test_extreme_tall_page_fails_before_writing_any_tile(self):
        process, output = self.run_render(self.make_pdf("tall.pdf", 612, 100_000))
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("more than 30", process.stderr)
        self.assertEqual(list(output.glob("*.png")) if output.exists() else [], [])

    def test_cumulative_page_pixel_budget_fails_before_first_tile(self):
        process, output = self.run_render(self.make_pdf("pixel-budget.pdf", 612, 10_000))
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("cumulative", process.stderr)
        self.assertEqual(list(output.glob("*.png")) if output.exists() else [], [])

    def test_supported_long_page_example_remains_within_cumulative_budget(self):
        process, _ = self.run_render(
            self.make_pdf("supported-long.pdf", 958, 11_833)
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        payload = json.loads(process.stdout)
        self.assertEqual(len(payload["pages"][0]["tiles"]), 9)

    def test_postflight_render_helpers_bound_ultra_wide_page_pixels(self):
        pdf = self.make_pdf("verify-wide.pdf", 100_000, 1000)
        source = fitz.open(pdf)
        output = fitz.open(pdf)
        try:
            stats = VERIFY._render_page_stats(source[0])
            self.assertLessEqual(stats["render_width"], 513)
            self.assertLessEqual(stats["render_height"], 513)
            comparison = VERIFY._compare_nontext_page(source[0], output[0], 1)
            self.assertTrue(comparison["matched"], comparison)
            self.assertLessEqual(comparison["unmasked_pixels"], 1025 * 1025)
            signature = VERIFY._render_region_signature(
                source[0], [0, 0, 100_000, 1000]
            )
            self.assertEqual(signature["method"], "dhash-8x8+mean-rgb")
        finally:
            source.close()
            output.close()


if __name__ == "__main__":
    unittest.main()
