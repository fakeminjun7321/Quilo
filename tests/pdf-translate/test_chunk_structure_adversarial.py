#!/usr/bin/env python3
"""Adversarial split / merge and active-annotation regressions."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import fitz
from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[2]
TRANSLATOR = ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"
VERIFY_PATH = ROOT / "scripts" / "verify_translation.py"
VERIFY_SPEC = importlib.util.spec_from_file_location(
    "verify_translation_chunk_adversarial", VERIFY_PATH
)
VERIFY_MODULE = importlib.util.module_from_spec(VERIFY_SPEC)
assert VERIFY_SPEC.loader is not None
VERIFY_SPEC.loader.exec_module(VERIFY_MODULE)


def run_translator(command: str, *args: Path, payload=None, check=True):
    proc = subprocess.run(
        [sys.executable, str(TRANSLATOR), command, *(str(arg) for arg in args)],
        input=json.dumps(payload, ensure_ascii=False) if payload is not None else None,
        text=True,
        capture_output=True,
        check=False,
    )
    if check and proc.returncode:
        raise AssertionError(
            f"translate_pdf.py {command} failed ({proc.returncode})\n"
            f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
        )
    return json.loads(proc.stdout) if check else proc


def make_plain_document(path: Path, pages=4):
    with fitz.open() as document:
        for index in range(pages):
            page = document.new_page(width=612, height=792)
            page.insert_text((54, 72), f"Static source page {index + 1}")
        document.save(path, garbage=3, deflate=True)


class ChunkStructureAdversarialTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="quilo-pdf-chunk-adversarial-")
        self.root = Path(self.tempdir.name)

    def tearDown(self):
        self.tempdir.cleanup()

    def merge_payload(self, source: Path, split: dict, translations=None):
        return {
            "source_pdf": str(source),
            "translations": translations or {},
            "part_manifest": split["part_manifest"],
        }

    def test_equal_size_reverse_duplicate_and_tampered_parts_fail_atomically(self):
        source = self.root / "source.pdf"
        make_plain_document(source, pages=4)
        split = run_translator("split", source, self.root / "chunks", Path("2"))
        parts = [Path(item["path"]) for item in split["chunks"]]
        self.assertEqual([len(item["page_tokens"]) for item in split["chunks"]], [2, 2])

        correct = self.root / "correct.pdf"
        stats = run_translator(
            "merge",
            correct,
            *parts,
            payload=self.merge_payload(source, split),
        )
        self.assertTrue(stats["ok"], stats)
        with fitz.open(correct) as document:
            self.assertEqual(
                [document[index].get_text().strip() for index in range(4)],
                [f"Static source page {index}" for index in range(1, 5)],
            )

        cases = {
            "reverse": [parts[1], parts[0]],
            "duplicate": [parts[0], parts[0]],
        }
        tampered = self.root / "tampered-part.pdf"
        with fitz.open(parts[0]) as document:
            document.xref_set_key(
                document[0].xref,
                "QuiloPageToken",
                fitz.get_pdf_str("0" * 32),
            )
            document.save(tampered, garbage=3, deflate=True)
        cases["tampered"] = [tampered, parts[1]]

        for label, candidate_parts in cases.items():
            with self.subTest(label=label):
                output = self.root / f"{label}.pdf"
                output.write_bytes(b"PREEXISTING-OUTPUT")
                before = output.read_bytes()
                proc = run_translator(
                    "merge",
                    output,
                    *candidate_parts,
                    payload=self.merge_payload(source, split),
                    check=False,
                )
                self.assertNotEqual(proc.returncode, 0, proc.stdout)
                self.assertIn("provenance", proc.stderr)
                self.assertEqual(output.read_bytes(), before)
                self.assertEqual(list(self.root.glob(f"{label}.pdf.partial-*")), [])

        missing_manifest = self.root / "missing-manifest.pdf"
        proc = run_translator(
            "merge",
            missing_manifest,
            *parts,
            payload={"source_pdf": str(source), "translations": {}},
            check=False,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("manifest is required", proc.stderr)
        self.assertFalse(missing_manifest.exists())

    def test_merge_replaces_only_contents_resources_and_preserves_page_keys(self):
        source = self.root / "page-keys-source.pdf"
        with fitz.open() as document:
            page = document.new_page(width=612, height=792)
            page.insert_text((54, 72), "Original page content")
            document.xref_set_key(page.xref, "Tabs", "/S")
            document.xref_set_key(page.xref, "Dur", "5")
            document.xref_set_key(page.xref, "Trans", "<</S/Dissolve>>")
            document.xref_set_key(page.xref, "StructParents", "7")
            document.xref_set_key(page.xref, "MyPageKey", "(preserve-me)")
            note = page.add_text_annot((220, 120), "Preserved review note")
            note.update()
            document.new_page(width=612, height=792).insert_text(
                (54, 72), "Second page content"
            )
            document.save(source, garbage=3, deflate=True)

        split = run_translator("split", source, self.root / "key-chunks", Path("1"))
        parts = [Path(item["path"]) for item in split["chunks"]]
        translated_first = self.root / "translated-first.pdf"
        with fitz.open(parts[0]) as document:
            document[0].insert_text(
                (54, 110), "TRANSLATED-CONTENT-MARKER", fontsize=10, fontname="cour"
            )
            document.save(translated_first, garbage=3, deflate=True)

        output = self.root / "page-keys-output.pdf"
        run_translator(
            "merge",
            output,
            translated_first,
            parts[1],
            payload=self.merge_payload(source, split),
        )

        with fitz.open(source) as source_doc, fitz.open(output) as output_doc:
            for key in ("Tabs", "Dur", "Trans", "StructParents", "MyPageKey"):
                self.assertEqual(
                    output_doc.xref_get_key(output_doc[0].xref, key),
                    source_doc.xref_get_key(source_doc[0].xref, key),
                    key,
                )
            self.assertIn("TRANSLATED-CONTENT-MARKER", output_doc[0].get_text())
            self.assertNotEqual(
                output_doc.xref_get_key(output_doc[0].xref, "Contents"),
                source_doc.xref_get_key(source_doc[0].xref, "Contents"),
            )
            for key in ("QuiloSplitDocument", "QuiloSourcePage", "QuiloPageToken"):
                self.assertEqual(
                    output_doc.xref_get_key(output_doc[0].xref, key)[0], "null"
                )

        reader = PdfReader(str(output), strict=True)
        annotations = reader.pages[0].get("/Annots") or []
        notes = [ref.get_object() for ref in annotations if ref.get_object().get("/Subtype") == "/Text"]
        self.assertEqual(len(notes), 1)
        parent_ref = notes[0].raw_get("/P")
        self.assertEqual(parent_ref.idnum, reader.pages[0].indirect_reference.idnum)

    def test_raw_javascript_submit_unknown_and_additional_actions_are_removed(self):
        source = self.root / "unsafe-source.pdf"
        with fitz.open() as document:
            page = document.new_page(width=612, height=792)
            document.new_page(width=612, height=792)
            page = document[0]
            page.insert_text((54, 72), "12345")

            # Two allow-listed controls: safe URI and explicit local XYZ.
            page.insert_link(
                {
                    "kind": fitz.LINK_URI,
                    "from": fitz.Rect(40, 90, 150, 108),
                    "uri": "https://example.com/safe",
                }
            )
            page.insert_link(
                {
                    "kind": fitz.LINK_GOTO,
                    "from": fitz.Rect(40, 115, 150, 133),
                    "page": 1,
                    "to": fitz.Point(54, 740),
                    "zoom": 1.25,
                }
            )
            # Start as ordinary URI links, then mutate their raw actions to types
            # that PyMuPDF omits from get_links()/first_link.
            for offset in range(4):
                page.insert_link(
                    {
                        "kind": fitz.LINK_URI,
                        "from": fitz.Rect(200, 90 + offset * 25, 360, 108 + offset * 25),
                        "uri": f"https://example.com/mutate-{offset}",
                    }
                )
            page = document.reload_page(page)
            links = page.get_links()
            self.assertEqual(len(links), 6)
            dangerous = [int(item["xref"]) for item in links[2:]]
            document.xref_set_key(
                dangerous[0], "A", "<</S/JavaScript/JS(app.alert\\(1\\))>>"
            )
            document.xref_set_key(
                dangerous[1], "A", "<</S/SubmitForm/F(https://example.com/post)>>"
            )
            document.xref_set_key(dangerous[2], "A", "<</S/UnknownAction>>")
            document.xref_set_key(
                dangerous[3],
                "AA",
                "<</E<</S/JavaScript/JS(app.alert\\(2\\))>>>>",
            )
            note = page.add_text_annot((400, 200), "Keep annotation, strip action")
            note.update()
            document.xref_set_key(
                note.xref, "AA", "<</E<</S/JavaScript/JS(app.alert\\(3\\))>>>>"
            )
            document.xref_set_key(
                page.xref, "AA", "<</O<</S/JavaScript/JS(app.alert\\(4\\))>>>>"
            )
            document.save(source, garbage=3, deflate=True)

        split = run_translator("split", source, self.root / "unsafe-chunks", Path("1"))
        parts = [Path(item["path"]) for item in split["chunks"]]
        output = self.root / "unsafe-output.pdf"
        stats = run_translator(
            "merge",
            output,
            *parts,
            payload=self.merge_payload(source, split),
        )
        self.assertGreaterEqual(stats["unsafe_links_removed"], 6, stats)

        reader = PdfReader(str(output), strict=True)
        annotations = [
            ref.get_object() for ref in (reader.pages[0].get("/Annots") or [])
        ]
        links = [item for item in annotations if item.get("/Subtype") == "/Link"]
        notes = [item for item in annotations if item.get("/Subtype") == "/Text"]
        self.assertEqual(len(links), 2, annotations)
        self.assertEqual(
            {str((item.get("/A") or {}).get("/S")) for item in links},
            {"/URI", "/GoTo"},
        )
        self.assertTrue(all(item.get("/AA") is None for item in links))
        self.assertEqual(len(notes), 1)
        for key in ("/A", "/AA"):
            value = notes[0].get(key)
            self.assertTrue(
                value is None or value.__class__.__name__ == "NullObject",
                (key, value),
            )

        with fitz.open(output) as document:
            self.assertEqual(document.xref_get_key(document[0].xref, "AA")[0], "null")

        report = VERIFY_MODULE.verify(
            str(output), str(source), mode="inplace", intent="restore"
        )
        link_gate = report["gates"]["link_preservation"]
        self.assertEqual(link_gate["status"], "pass", link_gate)
        self.assertGreaterEqual(
            len(link_gate["details"]["unsafe_source_removed_by_policy"]), 6
        )
        self.assertEqual(link_gate["details"]["unsafe_output"], [])

    def test_encrypted_and_invalid_parts_fail_without_partial_output(self):
        source = self.root / "part-source.pdf"
        make_plain_document(source, pages=1)
        split = run_translator("split", source, self.root / "part-chunks", Path("1"))
        plain_part = Path(split["chunks"][0]["path"])
        encrypted = self.root / "encrypted.pdf"
        with fitz.open(plain_part) as document:
            document.save(
                encrypted,
                encryption=fitz.PDF_ENCRYPT_AES_256,
                owner_pw="owner",
                user_pw="user",
            )
        invalid = self.root / "invalid.pdf"
        invalid.write_bytes(b"%PDF-1.7\nnot a valid PDF")

        for label, part in (("encrypted", encrypted), ("invalid", invalid)):
            with self.subTest(label=label):
                output = self.root / f"{label}-output.pdf"
                proc = run_translator(
                    "merge",
                    output,
                    part,
                    payload=self.merge_payload(source, split),
                    check=False,
                )
                self.assertNotEqual(proc.returncode, 0)
                self.assertFalse(output.exists())
                self.assertEqual(list(self.root.glob(f"{label}-output.pdf.partial-*")), [])


if __name__ == "__main__":
    unittest.main()
