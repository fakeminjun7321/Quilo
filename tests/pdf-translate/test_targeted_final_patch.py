"""Focused integration tests for the fail-closed final PDF patch publisher."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import fitz


ROOT = Path(__file__).resolve().parents[2]
PYTHON = ROOT / ".venv/bin/python3"
SCRIPT = ROOT / "scripts/apply_pdf_targeted_corrections.py"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def text_sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class TargetedFinalPatchTest(unittest.TestCase):
    def make_fixture(self, root: Path):
        (root / "chunks").mkdir()
        (root / "parts").mkdir()
        final = root / "final.pdf"
        source = root / "source.pdf"
        chunk = root / "chunks/chunk-0.pdf"
        part = root / "parts/part-000.ko.pdf"
        doc = fitz.open()
        page = doc.new_page(width=300, height=180)
        page.insert_text((50, 70), "Current English 7", fontsize=10)
        page.insert_link({
            "kind": fitz.LINK_URI,
            "from": fitz.Rect(30, 120, 100, 135),
            "uri": "https://example.com/stable",
        })
        doc.set_toc([[1, "Stable outline", 1]])
        doc.save(final)
        doc.close()
        for destination in (source, chunk, part):
            shutil.copyfile(final, destination)

        current_doc = fitz.open(final)
        blocks = [
            block for block in current_doc[0].get_text("dict")["blocks"]
            if block.get("type") == 0
        ]
        current = blocks[0]
        bbox = [float(value) for value in current["bbox"]]
        current_doc.close()
        target = "검증된 교정 7"
        manifest = {
            "schema": "test.targeted.v1",
            "schema_version": 1,
            "batch": "fixture",
            "status": "ready_for_patcher",
            "binding": {
                "source_pdf": {"path": "source.pdf", "sha256": sha(source), "page_count": 1},
                "final_pdf": {"path": "final.pdf", "sha256": sha(final), "page_count": 1},
            },
            "corrections": [{
                "id": "fixture",
                "page": 1,
                "chunk_index": 0,
                "local_page": 1,
                "artifact_binding": {
                    "chunk_path": "chunks/chunk-0.pdf",
                    "chunk_sha256": sha(chunk),
                    "part_path": "parts/part-000.ko.pdf",
                    "part_sha256": sha(part),
                },
                "locator": {
                    "regions": [{
                        "bbox": bbox,
                        "text": "Current English 7",
                        "text_sha256": text_sha("Current English 7"),
                    }],
                    "current_joiner": r"\n",
                    "current_text_sha256": text_sha("Current English 7"),
                },
                "target": {
                    "apply_mode": "redraw_bound_region",
                    "fragments": [{
                        "bbox": [50, 55, 250, 88],
                        "text": target,
                        "text_sha256": text_sha(target),
                    }],
                    "target_joiner": r"\n",
                    "target_text_sha256": text_sha(target),
                },
                "invariants": {
                    "preserve_numbers": ["7"],
                    "preserve_units": [],
                    "preserve_formula_tokens": [],
                },
            }],
            # Proposed bookmark changes are deliberately ignored by the patcher.
            "outline_corrections": [{"index": 1, "target": {"text": "Do not apply"}}],
            "deferred": [{"pages": [477, 479, 481, 482, 487, 491, 492]}],
            "exclusions": [{"pages": [483, 484, 485]}],
        }
        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        visual_path = root / "visual.json"
        visual_path.write_text(json.dumps({
            "artifact": {"sha256": sha(final)},
            "unused_undefined_font_selections": [],
        }), encoding="utf-8")
        (root / "split.json").write_text(json.dumps({
            "chunks": [{"path": str(chunk.resolve()), "start": 1, "end": 1}],
        }), encoding="utf-8")
        (root / "metadata.json").write_text(json.dumps({
            "output_sha256": sha(final), "translation_fingerprint": "f" * 64,
        }), encoding="utf-8")
        return final, manifest_path, visual_path

    def run_patch(self, root: Path, manifest: Path, visual: Path):
        return subprocess.run(
            [
                str(PYTHON), str(SCRIPT),
                "--root", str(root),
                "--manifest", str(manifest),
                "--visual-manifest", str(visual),
                "--expected-goto-links", "0",
                "--expected-uri-links", "1",
                "--expected-images", "0",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_applies_bound_body_only_and_preserves_outline_and_link(self):
        with tempfile.TemporaryDirectory(prefix="targeted-final-") as raw:
            root = Path(raw)
            final, manifest, visual = self.make_fixture(root)
            before = sha(final)
            proc = self.run_patch(root, manifest, visual)
            self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8"))
            result = json.loads(proc.stdout)
            self.assertEqual(result["body_corrections"], 1)
            self.assertEqual(result["outline_title_corrections"], 0)
            self.assertGreaterEqual(result["min_font_pt"], 8)
            self.assertEqual(result["overflow"], 0)
            self.assertNotEqual(sha(final), before)
            output = fitz.open(final)
            try:
                self.assertIn("검증된 교정 7", " ".join(output[0].get_text().split()))
                self.assertNotIn("Current English", output[0].get_text())
                self.assertEqual(output.get_toc()[0][1], "Stable outline")
                self.assertEqual(len(output[0].get_links()), 1)
                self.assertEqual(output[0].get_links()[0]["uri"], "https://example.com/stable")
            finally:
                output.close()
            metadata = json.loads((root / "metadata.json").read_text("utf-8"))
            self.assertEqual(metadata["output_sha256"], sha(final))
            self.assertEqual(metadata["targeted_corrections"]["outline_title_corrections"], 0)

    def test_binding_drift_fails_before_publish(self):
        with tempfile.TemporaryDirectory(prefix="targeted-final-drift-") as raw:
            root = Path(raw)
            final, manifest_path, visual = self.make_fixture(root)
            before = sha(final)
            manifest = json.loads(manifest_path.read_text("utf-8"))
            manifest["corrections"][0]["locator"]["regions"][0]["text_sha256"] = "0" * 64
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            proc = self.run_patch(root, manifest_path, visual)
            self.assertNotEqual(proc.returncode, 0)
            self.assertEqual(sha(final), before)
            self.assertFalse(list(root.glob("*.before-targeted-corrections.*.pdf")))


if __name__ == "__main__":
    unittest.main()
