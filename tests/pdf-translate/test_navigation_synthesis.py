#!/usr/bin/env python3
"""Regressions for opt-in, source-evidenced PDF navigation synthesis."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import fitz


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "lib" / "pipelines" / "pdf-translate" / "synthesize_navigation.py"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def content_signature(path: Path):
    with fitz.open(path) as doc:
        result = []
        for page in doc:
            streams = tuple(
                hashlib.sha256(doc.xref_stream_raw(int(xref))).hexdigest()
                for xref in page.get_contents() or []
            )
            result.append(
                (
                    tuple(round(float(value), 6) for value in page.mediabox),
                    tuple(round(float(value), 6) for value in page.cropbox),
                    int(page.rotation) % 360,
                    streams,
                )
            )
        return tuple(result)


def run_apply(source: Path, output: Path, manifest: dict, check=True):
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), "apply", str(source), str(output)],
        input=json.dumps(manifest, ensure_ascii=False).encode("utf-8"),
        capture_output=True,
        check=False,
    )
    if check and proc.returncode:
        raise AssertionError(
            f"navigation synthesis failed ({proc.returncode})\n"
            f"stdout={proc.stdout!r}\nstderr={proc.stderr!r}"
        )
    return json.loads(proc.stdout) if check else proc


class NavigationSynthesisTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="quilo-navigation-")
        self.root = Path(self.tempdir.name)
        self.source = self.root / "source.pdf"
        self.output = self.root / "translated.pdf"
        doc = fitz.open()
        page = doc.new_page(width=420, height=560)
        page.insert_text((72, 72), "Numerical Analysis root evidence")
        page = doc.new_page(width=420, height=560)
        # Simulate one visually continuous URL whose hidden OCR layer inserted
        # word boundaries.  The allow-listed URI is only accepted by exact
        # concatenation of consecutive words from this one line.
        page.insert_text((72, 72), "https://example.com/ 1 path")
        page.insert_text((72, 110), "Review of Calculus evidence")
        page = doc.new_page(width=420, height=560)
        page.insert_text((72, 72), "Appendix evidence")
        doc.save(self.source)
        doc.close()
        shutil.copyfile(self.source, self.output)

    def tearDown(self):
        self.tempdir.cleanup()

    def manifest(self):
        return {
            "schema_version": 1,
            "source_sha256": sha256(self.source),
            "bookmarks": [
                {
                    "level": 1,
                    "title": "수치해석학",
                    "page": 1,
                    "evidence": {"page": 1, "text": "Numerical Analysis"},
                },
                {
                    "level": 2,
                    "title": "미적분학 복습",
                    "page": 2,
                    "evidence": {"page": 2, "text": "Review of Calculus"},
                },
            ],
            "visible_urls": [
                {"page": 2, "uri": "https://example.com/1path"},
            ],
        }

    def test_adds_exact_bookmarks_and_evidence_bound_uri_without_touching_page_streams(self):
        before = content_signature(self.output)
        manifest = self.manifest()
        expected_manifest_hash = hashlib.sha256(
            json.dumps(manifest, ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        stats = run_apply(self.source, self.output, manifest)
        self.assertTrue(stats["ok"], stats)
        self.assertEqual(stats["bookmarks"], 2)
        self.assertEqual(stats["toc_internal_links"], 1)
        self.assertEqual(stats["visible_url_allowlist_entries"], 1)
        self.assertEqual(stats["visible_url_links"], 1)
        self.assertEqual(stats["manifest_sha256"], expected_manifest_hash)
        self.assertEqual(content_signature(self.output), before)

        with fitz.open(self.output) as doc:
            self.assertEqual(
                [item[:3] for item in doc.get_toc()],
                [[1, "수치해석학", 1], [2, "미적분학 복습", 2]],
            )
            links = doc[1].get_links()
            uri_links = [link for link in links if link["kind"] == fitz.LINK_URI]
            goto_links = [link for link in links if link["kind"] == fitz.LINK_GOTO]
            self.assertEqual(len(uri_links), 1)
            self.assertEqual(uri_links[0]["uri"], "https://example.com/1path")
            self.assertEqual(len(goto_links), 1)
            self.assertEqual(goto_links[0]["page"], 1)

    def test_rejects_hash_mismatch_missing_evidence_and_unsafe_uri(self):
        cases = []
        wrong_hash = self.manifest()
        wrong_hash["source_sha256"] = "0" * 64
        cases.append((wrong_hash, b"source_sha256 does not match"))

        missing = self.manifest()
        missing["bookmarks"][1]["evidence"]["text"] = "Not on this page"
        cases.append((missing, b"evidence.text is not present"))

        unsafe = self.manifest()
        unsafe["visible_urls"][0]["uri"] = "file:///etc/passwd"
        cases.append((unsafe, b"must use http or https"))

        for index, (manifest, message) in enumerate(cases):
            output = self.root / f"failure-{index}.pdf"
            shutil.copyfile(self.source, output)
            proc = run_apply(self.source, output, manifest, check=False)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn(message, proc.stderr)
            self.assertEqual(content_signature(output), content_signature(self.source))

    def test_rejects_documents_that_already_have_navigation(self):
        source = self.root / "outlined-source.pdf"
        with fitz.open(self.source) as doc:
            doc.set_toc([[1, "Existing", 1]])
            doc.save(source)
        output = self.root / "outlined-output.pdf"
        shutil.copyfile(source, output)
        manifest = self.manifest()
        manifest["source_sha256"] = sha256(source)
        proc = run_apply(source, output, manifest, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"source has no outline or links", proc.stderr)

    def test_rejects_a_symlink_output(self):
        target = self.root / "target.pdf"
        shutil.copyfile(self.source, target)
        linked = self.root / "linked.pdf"
        try:
            linked.symlink_to(target)
        except OSError as exc:  # pragma: no cover - platform policy fallback
            self.skipTest(f"symlink creation is unavailable: {exc}")
        proc = run_apply(self.source, linked, self.manifest(), check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(b"must not be a symlink", proc.stderr)


if __name__ == "__main__":
    unittest.main()
