"""Focused integration checks for the one-run mixed formula/prose repair helper."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import fitz


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "patch_pdf_translation_mixed_spans.py"
PYTHON = ROOT / ".venv" / "bin" / "python3"
FONT = ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def spans(page):
    return [
        span
        for block in page.get_text("dict").get("blocks", [])
        if block.get("type") == 0
        for line in block.get("lines", [])
        for span in line.get("spans", [])
        if span.get("text")
    ]


class ManualMixedSpanPatchTest(unittest.TestCase):
    def make_fixture(self, root: Path):
        source = root / "source.pdf"
        translated = root / "translated.pdf"
        output = root / "patched.pdf"
        doc = fitz.open()
        page = doc.new_page(width=300, height=180)
        page.insert_text((50, 70), "z", fontsize=10, fontname="Times-Italic")
        page.insert_text((58, 70), ">", fontsize=10, fontname="Times-Roman")
        page.insert_text((67, 70), ", and thus", fontsize=10, fontname="Helvetica")
        doc.save(source)
        doc.close()
        translated.write_bytes(source.read_bytes())

        source_doc = fitz.open(source)
        page = source_doc[0]
        by_text = {span["text"]: span for span in spans(page)}
        formula = [by_text["z"], by_text[">"]]
        prose = by_text[", and thus"]
        full = fitz.Rect(formula[0]["bbox"])
        for span in [*formula[1:], prose]:
            full |= fitz.Rect(span["bbox"])
        payload = {
            "schema_version": 1,
            "source_pdf_sha256": sha256(source.read_bytes()),
            "translated_pdf_sha256": sha256(translated.read_bytes()),
            "repairs": [{
                "id": "fixture",
                "page": 0,
                "full_bbox": list(full),
                "prose_bbox": list(fitz.Rect(prose["bbox"])),
                "prose_source": "and thus",
                "render_target": "ok",
                "final_prose": ", ok",
                "minimum_font_pt": 8,
                "formula_spans": [{
                    "text": span["text"],
                    "font": span["font"],
                    "bbox": list(fitz.Rect(span["bbox"])),
                    "text_sha256": sha256(span["text"].encode("utf-8")),
                } for span in formula],
            }],
        }
        source_doc.close()
        return source, translated, output, payload

    def test_replays_exact_source_formula_pixels_and_writes_prose_at_source_size(self):
        with tempfile.TemporaryDirectory(prefix="manual-mixed-span-") as raw:
            source, translated, output, payload = self.make_fixture(Path(raw))
            proc = subprocess.run(
                [str(PYTHON), str(SCRIPT), str(source), str(translated), str(output), str(FONT)],
                input=json.dumps(payload).encode("utf-8"),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8"))
            result = json.loads(proc.stdout)
            self.assertTrue(result["ok"])
            self.assertTrue(result["pixel_exact"])
            self.assertEqual(result["repairs"], 1)
            self.assertGreaterEqual(result["items"][0]["font_size"], 8)
            self.assertEqual(result["output_sha256"], sha256(output.read_bytes()))
            patched = fitz.open(output)
            try:
                text = "".join(page.get_text() for page in patched)
                self.assertIn("z", text)
                self.assertIn(">", text)
                self.assertNotIn("and thus", text)
            finally:
                patched.close()

    def test_rejects_source_hash_drift_without_writing_output(self):
        with tempfile.TemporaryDirectory(prefix="manual-mixed-span-drift-") as raw:
            source, translated, output, payload = self.make_fixture(Path(raw))
            payload["source_pdf_sha256"] = "0" * 64
            proc = subprocess.run(
                [str(PYTHON), str(SCRIPT), str(source), str(translated), str(output), str(FONT)],
                input=json.dumps(payload).encode("utf-8"),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            self.assertNotEqual(proc.returncode, 0)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
