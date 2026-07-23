#!/usr/bin/env python3
"""OCR-layer scan regressions for the shared in-place textbook renderer."""

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


def load_translator():
    spec = importlib.util.spec_from_file_location("translate_pdf_hidden_ocr", TRANSLATOR)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


TP = load_translator()


def span(text: str, x0: float, x1: float, *, superscript: bool = False) -> dict:
    return {
        "text": text,
        "bbox": (x0, 72 if superscript else 76, x1, 82 if superscript else 88),
        "font": "Times-Roman",
        "size": 7 if superscript else 11,
        "flags": 5 if superscript else 4,
    }


def extract(path: Path) -> dict:
    proc = subprocess.run(
        [sys.executable, str(TRANSLATOR), "extract", str(path)],
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(proc.stdout)


def render(path: Path, output: Path, translations: dict[str, str]) -> dict:
    proc = subprocess.run(
        [sys.executable, str(TRANSLATOR), "render", str(path), str(output), str(FONT)],
        input=json.dumps({"translations": translations}),
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(proc.stdout)


def make_scan_fixture(path: Path) -> dict[str, fitz.Rect]:
    visible = fitz.open()
    page = visible.new_page(width=600, height=800)
    page.insert_text((50, 90), "Example 2 Show that", fontsize=12)
    page.insert_text((210, 90), "x^5 - 2x^3 + 3x^2 - 1 = 0", fontsize=12)
    page.insert_text((50, 125), "Solution This equation has a root.", fontsize=12)
    page.insert_text((50, 160), "Hence the theorem applies.", fontsize=12)
    page.insert_text((50, 280), "Table 2.12", fontsize=11)
    page.insert_text((50, 305), "i      p_i      f(p_i)", fontsize=11)
    page.insert_text((50, 330), "1      0.5      -0.25", fontsize=11)
    page.insert_text(
        (35, 785),
        "Copyright 2016 Cengage Learning. All Rights Reserved. May not be copied, scanned, or duplicated.",
        fontsize=7,
    )
    raster = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).tobytes("png")
    visible.close()

    scan = fitz.open()
    for _ in range(3):
        target = scan.new_page(width=600, height=800)
        target.insert_image(target.rect, stream=raster)
        target.insert_text((50, 90), "Example 2 Show that", fontsize=12, render_mode=3)
        target.insert_text((210, 90), "x^5 - 2x^3 + 3x^2 - 1 = 0", fontsize=12, render_mode=3)
        target.insert_text((50, 125), "Solution This equation has a root.", fontsize=12, render_mode=3)
        target.insert_text((50, 160), "Hence the theorem applies.", fontsize=12, render_mode=3)
        target.insert_text((50, 280), "Table 2.12", fontsize=11, render_mode=3)
        target.insert_text((50, 305), "i p_i f(p_i)", fontsize=11, render_mode=3)
        target.insert_text((50, 330), "1 0.5 -0.25", fontsize=11, render_mode=3)
        target.insert_text(
            (35, 785),
            "Copyright 2016 Cengage Learning. All Rights Reserved. May not be copied, scanned, or duplicated.",
            fontsize=7,
            render_mode=3,
        )
    scan.save(path)
    scan.close()
    return {
        "formula": fitz.Rect(205, 72, 410, 96),
        "table": fitz.Rect(40, 260, 330, 345),
        "footer": fitz.Rect(25, 765, 575, 798),
        "prose": fitz.Rect(45, 108, 360, 135),
    }


class HiddenOcrScanTranslationTest(unittest.TestCase):
    def test_mixed_example_solution_hence_and_proof_split_formula_pixels_from_prose(self):
        tokens = [
            ("Example", 50, 95, False), (" ", 95, 100, False),
            ("2", 100, 108, False), (" ", 108, 114, False),
            ("Show", 114, 145, False), (" ", 145, 150, False),
            ("that", 150, 175, False), (" ", 175, 180, False),
            ("x", 180, 188, False), ("5", 188, 194, True),
            (" - ", 194, 208, False), ("2x", 208, 222, False),
            ("3", 222, 228, True), (" = 0", 228, 252, False),
            (" ", 252, 257, False), ("has", 257, 278, False),
            (" a solution", 278, 340, False),
        ]
        line = {
            "bbox": (50, 72, 340, 88),
            "dir": (1, 0),
            "spans": [span(text, x0, x1, superscript=sup) for text, x0, x1, sup in tokens],
        }
        block = {"bbox": line["bbox"], "lines": [line]}
        parts = TP._split_hidden_ocr_inline_formula_runs(block)
        prose = [TP._raw_line_text(part["lines"][0]) for part in parts if not part.get("_preserve_formula")]
        formula = [TP._raw_line_text(part["lines"][0]) for part in parts if part.get("_preserve_formula")]
        self.assertIn("Example 2 Show that", prose)
        self.assertIn("has a solution", "".join(prose))
        self.assertEqual("".join(formula).strip(), "x5 - 2x3 = 0")

        for text in (
            "Solution Consider the function f(x) = x5 - 1.",
            "Hence, 0 < c < 1 implies the result.",
            "Proof If f(p) = 0 then the zero is simple.",
            "Example 1 Let f(x) = ex - x - 1.",
        ):
            self.assertFalse(TP._hidden_ocr_static_block(block, text))

    def test_extract_and_render_keep_formula_table_footer_pixels(self):
        with tempfile.TemporaryDirectory(prefix="quilo-hidden-ocr-") as tmp:
            source = Path(tmp) / "scan.pdf"
            output = Path(tmp) / "scan-ko.pdf"
            clips = make_scan_fixture(source)
            meta = extract(source)
            self.assertTrue(meta["scanned"])
            self.assertTrue(meta["ocr_layer"])
            self.assertEqual(meta["ocr_layer_pages"], [1, 2, 3])
            payload = "\n".join(str(block["text"]) for block in meta["blocks"])
            self.assertIn("Example 2 Show that", payload)
            self.assertIn("Solution This equation has a root.", payload)
            self.assertIn("Hence the theorem applies.", payload)
            self.assertNotIn("Table 2.12", payload)
            self.assertNotIn("Copyright 2016", payload)
            self.assertNotIn("x^5 - 2x^3", payload)

            translations = {
                str(block["id"]): (
                    "예제 2 다음을 보여라"
                    if "Example" in block["text"]
                    else "풀이 이 방정식은 근을 갖는다."
                    if "Solution" in block["text"]
                    else "따라서 이 정리를 적용할 수 있다."
                )
                for block in meta["blocks"]
            }
            stats = render(source, output, translations)
            self.assertTrue(stats["ok"])

            src = fitz.open(source)
            out = fitz.open(output)
            matrix = fitz.Matrix(2, 2)
            for name in ("formula", "table", "footer"):
                before = src[0].get_pixmap(matrix=matrix, clip=clips[name], alpha=False)
                after = out[0].get_pixmap(matrix=matrix, clip=clips[name], alpha=False)
                self.assertEqual(before.samples, after.samples, name)
            before = src[0].get_pixmap(matrix=matrix, clip=clips["prose"], alpha=False)
            after = out[0].get_pixmap(matrix=matrix, clip=clips["prose"], alpha=False)
            self.assertNotEqual(before.samples, after.samples)
            src.close()
            out.close()


if __name__ == "__main__":
    unittest.main()
