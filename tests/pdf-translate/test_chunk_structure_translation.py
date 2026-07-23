#!/usr/bin/env python3
"""51+ page split / merge regressions for whole-document PDF structure."""

from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

import fitz
from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[2]
TRANSLATOR = ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"


def run_translator(command: str, *args: Path, payload=None, check=True):
    proc = subprocess.run(
        [sys.executable, str(TRANSLATOR), command, *(str(arg) for arg in args)],
        input=json.dumps(payload, ensure_ascii=False) if payload is not None else None,
        text=True,
        capture_output=True,
        check=False,
    )
    if not check:
        return proc
    if proc.returncode:
        raise AssertionError(
            f"translate_pdf.py {command} failed ({proc.returncode})\n"
            f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
        )
    return json.loads(proc.stdout)


def canonical(value):
    if isinstance(value, dict):
        return tuple(
            (str(key), canonical(item))
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
            if str(key) != "xref"
        )
    if isinstance(value, (list, tuple)):
        return tuple(canonical(item) for item in value)
    if isinstance(value, (fitz.Point, fitz.Rect)):
        return tuple(round(float(item), 6) for item in value)
    if isinstance(value, float):
        return round(value, 6)
    return value


def outline_signature(path: Path):
    with fitz.open(path) as document:
        return tuple(
            (
                int(item[0]),
                str(item[1]),
                int(item[2]),
                canonical(item[3] if len(item) > 3 else {}),
            )
            for item in (document.get_toc(simple=False) or [])
        )


def outline_navigation(path: Path):
    return tuple((item[0], item[2], item[3]) for item in outline_signature(path))


def annotation_signature(path: Path, page_number: int):
    with fitz.open(path) as document:
        page = document[page_number]
        result = []
        annot = page.first_annot
        while annot is not None:
            parent_type, parent_value = document.xref_get_key(annot.xref, "P")
            result.append(
                (
                    annot.type[1],
                    canonical(annot.rect),
                    parent_type,
                    parent_value == f"{page.xref} 0 R",
                )
            )
            annot = annot.next
        return tuple(result)


def local_link_signature(path: Path, page_number: int):
    with fitz.open(path) as document:
        page = document[page_number]
        links = page.get_links()
        if len(links) != 1:
            raise AssertionError(f"expected one link on page {page_number}, got {links}")
        link = links[0]
        dest_type, dest_value = document.xref_get_key(int(link["xref"]), "Dest")
        match = re.fullmatch(
            r"\[\s*(\d+)\s+\d+\s+R\s*/([A-Za-z]+)(.*?)\s*\]",
            dest_value,
        )
        if match is None:
            raise AssertionError(f"unexpected local destination: {dest_value}")
        target_xref = int(match.group(1))
        page_by_xref = {
            int(document.page_xref(index)): index for index in range(len(document))
        }
        return (
            int(link["kind"]),
            canonical(link["from"]),
            page_by_xref[target_xref],
            dest_type,
            match.group(2),
            tuple(match.group(3).split()),
        )


class ChunkStructureTranslationTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="quilo-pdf-chunk-structure-")
        self.root = Path(self.tempdir.name)

    def tearDown(self):
        self.tempdir.cleanup()

    def make_document(self) -> Path:
        draft = self.root / "large-draft.pdf"
        source = self.root / "large-source.pdf"
        document = fitz.open()
        for index in range(51):
            page = document.new_page(width=612, height=792)
            page.insert_text(
                (54, 72),
                f"Chunk structure regression page {index + 1:02d}",
                fontsize=11,
                fontname="helv",
            )

        # Nested and duplicate titles span both 50-page chunks.  Direct destination
        # arrays make /Fit and /XYZ mode / arguments observable and exact.
        document.set_toc(
            [
                [1, "Main Section", 1],
                [2, "Repeated Detail", 2],
                [2, "Repeated Detail", 51],
                [1, "RFC", 25],
                [1, "Final Section", 51],
            ],
            collapse=1,
        )
        toc = document.get_toc(simple=False)
        outline_xrefs = [int(item[3]["xref"]) for item in toc]
        destinations = (
            f"[{document.page_xref(0)} 0 R /Fit]",
            f"[{document.page_xref(1)} 0 R /XYZ 91 702 1.35]",
            f"[{document.page_xref(50)} 0 R /Fit]",
            f"[{document.page_xref(24)} 0 R /Fit]",
            f"[{document.page_xref(50)} 0 R /XYZ 54 740 1.1]",
        )
        for xref, destination in zip(outline_xrefs, destinations):
            document.xref_set_key(xref, "Dest", "null")
            document.xref_set_key(
                xref,
                "A",
                f"<</S/GoTo/D{destination}>>",
            )
        document.xref_set_key(outline_xrefs[0], "F", "3")
        document.xref_set_key(outline_xrefs[0], "C", "[0.1 0.2 0.7]")

        # Cross-chunk /Fit link: preserving annotations from a translated chunk would
        # lose this destination because page 51 is absent from chunk 1.
        source_page = document[0]
        source_page.insert_link(
            {
                "kind": fitz.LINK_GOTO,
                "from": fitz.Rect(54, 90, 190, 108),
                "page": 50,
            }
        )
        source_page = document.reload_page(source_page)
        link_xref = int(source_page.get_links()[0]["xref"])
        document.xref_set_key(link_xref, "A", "null")
        document.xref_set_key(
            link_xref,
            "Dest",
            f"[{document.page_xref(50)} 0 R /Fit]",
        )

        # A non-link annotation exercises subtype/count and /P back-reference
        # preservation while page dictionaries are replaced in-place.
        note_page = document[24]
        note = note_page.add_text_annot((220, 120), "Preserved review note")
        note.update()

        document.set_metadata(
            {
                "title": "Large structure translation fixture",
                "subject": "Reader visible chunk merge information",
                "keywords": "translation, chunking, PDF",
                "author": "Preserved Test Author",
                "creator": "Preserved Test Creator",
                "producer": "Preserved Test Producer",
                "creationDate": "D:20260102030405+09'00'",
                "modDate": "D:20260710112233+09'00'",
            }
        )
        document.save(draft, garbage=3, deflate=True)
        document.close()

        # One reopen/save stabilizes xrefs before signatures are compared to the
        # post-merge garbage-collected file.
        with fitz.open(draft) as reopened:
            reopened.save(source, garbage=3, deflate=True)
        return source

    def make_sentence_boundary_document(self, texts, name="sentence-boundaries.pdf"):
        path = self.root / name
        document = fitz.open()
        for text in texts:
            page = document.new_page(width=612, height=792)
            page.insert_textbox(
                fitz.Rect(54, 72, 558, 220),
                text,
                fontsize=11,
                fontname="helv",
            )
        document.save(path, garbage=3, deflate=True)
        document.close()
        return path

    def test_split_moves_an_unsafe_nominal_cut_to_the_nearest_safe_page(self):
        source = self.make_sentence_boundary_document(
            [
                "Page one contains a complete source sentence for boundary planning.",
                "Page two also ends with a complete sentence and is a safe boundary.",
                "This long sentence starts on page three and deliberately continues",
                "across page four before it finally reaches a complete ending.",
                "Page five contains another complete sentence for a stable cut.",
                "Page six is a complete independent sentence for the final chunk.",
                "Page seven is also complete and closes the synthetic document.",
            ]
        )
        split = run_translator("split", source, self.root / "sentence-chunks", Path("3"))
        ranges = [(item["start"], item["end"]) for item in split["chunks"]]
        self.assertEqual(ranges, [(1, 2), (3, 5), (6, 7)])
        self.assertTrue(all(end - start + 1 <= 3 for start, end in ranges))
        self.assertEqual(
            split["split_policy"],
            {
                "name": "sentence-safe-backtrack-v1",
                "max_pages_per_chunk": 3,
                "search_scope": "entire_current_chunk",
                "adjusted_boundaries": [
                    {"nominal_end": 3, "selected_end": 2}
                ],
                "unresolved_boundaries": [],
            },
        )
        self.assertEqual(
            [(item["start"], item["end"]) for item in split["part_manifest"]["chunks"]],
            ranges,
        )

    def test_split_fails_closed_when_the_current_chunk_has_no_safe_cut(self):
        source = self.make_sentence_boundary_document(
            [
                "This continuous passage starts on the first page without finishing",
                "and keeps flowing through the second page without any sentence ending",
                "while the third page still does not provide a safe stopping point",
                "until the fourth page finally completes the one continuous sentence.",
            ],
            name="no-safe-boundary.pdf",
        )
        output_dir = self.root / "no-safe-chunks"
        result = run_translator(
            "split",
            source,
            output_dir,
            Path("3"),
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cannot find a sentence-safe PDF chunk boundary", result.stderr)
        self.assertEqual(list(output_dir.glob("*.pdf")), [])

    def test_51_page_split_merge_translates_structure_once_and_preserves_semantics(self):
        source = self.make_document()
        chunks_dir = self.root / "chunks"
        split = run_translator("split", source, chunks_dir, Path("50"))
        self.assertEqual(split["page_count"], 51)
        self.assertEqual(
            [(item["start"], item["end"]) for item in split["chunks"]],
            [(1, 50), (51, 51)],
        )
        self.assertEqual(split["structure"]["outline_items"], 5)

        virtual_blocks = split["virtual_blocks"]
        outline_blocks = [b for b in virtual_blocks if b["kind"] == "outline"]
        metadata_blocks = [b for b in virtual_blocks if b["kind"] == "metadata"]
        self.assertEqual(
            [block["text"] for block in outline_blocks],
            ["Main Section", "Repeated Detail", "Repeated Detail", "Final Section"],
        )
        self.assertEqual(
            [block["field"] for block in metadata_blocks],
            ["title", "subject", "keywords"],
        )
        self.assertEqual(len({block["id"] for block in virtual_blocks}), 7)

        # Page chunks contain no duplicate outline or metadata work: these seven
        # blocks are translated exactly once from split.virtual_blocks.
        part_paths = [Path(item["path"]) for item in split["chunks"]]
        for part in part_paths:
            extracted = run_translator("extract", part)
            self.assertEqual(extracted["virtual_block_count"], 0)
            self.assertTrue(
                all(block.get("kind") is None for block in extracted["blocks"])
            )

        # Make each would-be translated chunk observably different from the source.
        # The final marker assertion proves merge copied translated Contents/Resources
        # into the retained source page objects, not merely returned the source shell.
        translated_parts = []
        for index, part_path in enumerate(part_paths, start=1):
            translated_path = self.root / f"translated-part-{index}.pdf"
            with fitz.open(part_path) as part_doc:
                part_doc[0].insert_text(
                    (54, 110),
                    f"TRANSLATED-PART-MARKER-{index}",
                    fontsize=9,
                    fontname="helv",
                )
                part_doc.save(translated_path, garbage=3, deflate=True)
            translated_parts.append(translated_path)

        translations = {
            outline_blocks[0]["id"]: "주요 섹션",
            outline_blocks[1]["id"]: "첫 번째 반복 세부 항목",
            outline_blocks[2]["id"]: "두 번째 반복 세부 항목",
            outline_blocks[3]["id"]: "마지막 섹션",
            metadata_blocks[0]["id"]: "대용량 구조 번역 픽스처",
            metadata_blocks[1]["id"]: "리더에 표시되는 구간 병합 정보",
            metadata_blocks[2]["id"]: "번역, 구간 분할, PDF",
        }

        # Missing one structure translation fails before publishing any output.
        missing_output = self.root / "missing-output.pdf"
        missing_translations = dict(translations)
        missing_translations.pop(outline_blocks[2]["id"])
        missing = run_translator(
            "merge",
            missing_output,
            *translated_parts,
            payload={
                "source_pdf": str(source),
                "translations": missing_translations,
                "part_manifest": split["part_manifest"],
            },
            check=False,
        )
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("missing or empty required PDF outline/metadata", missing.stderr)
        self.assertFalse(missing_output.exists())

        output = self.root / "translated-output.pdf"
        stats = run_translator(
            "merge",
            output,
            *translated_parts,
            payload={
                "source_pdf": str(source),
                "translations": translations,
                "part_manifest": split["part_manifest"],
            },
        )
        self.assertTrue(stats["ok"], stats)
        self.assertTrue(stats["structure_restored"], stats)
        self.assertEqual(stats["page_count"], 51)
        self.assertEqual(stats["outline_items"], 5)
        self.assertEqual(stats["outline_replaced"], 4)
        self.assertEqual(stats["metadata_replaced"], 3)
        self.assertEqual(stats["virtual_replaced"], 7)
        self.assertEqual(stats["restored_links"], 1)

        self.assertEqual(outline_navigation(output), outline_navigation(source))
        output_outline = outline_signature(output)
        self.assertEqual(
            [item[1] for item in output_outline],
            [
                "주요 섹션",
                "첫 번째 반복 세부 항목",
                "두 번째 반복 세부 항목",
                "RFC",
                "마지막 섹션",
            ],
        )
        destination_dump = repr(output_outline)
        self.assertIn("Fit", destination_dump)
        self.assertIn("('zoom', 1.35)", destination_dump)
        self.assertIn("collapse", destination_dump)
        self.assertIn("color", destination_dump)
        self.assertIn("bold", destination_dump)
        self.assertIn("italic", destination_dump)

        with fitz.open(source) as source_doc, fitz.open(output) as output_doc:
            self.assertEqual(output_doc.metadata["title"], "대용량 구조 번역 픽스처")
            self.assertEqual(
                output_doc.metadata["subject"],
                "리더에 표시되는 구간 병합 정보",
            )
            self.assertEqual(output_doc.metadata["keywords"], "번역, 구간 분할, PDF")
            for field in (
                "author",
                "creator",
                "producer",
                "creationDate",
                "modDate",
            ):
                self.assertEqual(output_doc.metadata[field], source_doc.metadata[field])
            self.assertEqual(len(output_doc), len(source_doc))
            self.assertEqual(
                [canonical(page.rect) for page in output_doc],
                [canonical(page.rect) for page in source_doc],
            )
            self.assertNotIn("TRANSLATED-PART-MARKER", source_doc[0].get_text())
            self.assertNotIn("TRANSLATED-PART-MARKER", source_doc[50].get_text())
            self.assertIn("TRANSLATED-PART-MARKER-1", output_doc[0].get_text())
            self.assertIn("TRANSLATED-PART-MARKER-2", output_doc[50].get_text())

        self.assertEqual(local_link_signature(output, 0), local_link_signature(source, 0))
        self.assertEqual(local_link_signature(output, 0)[4:], ("Fit", ()))
        self.assertEqual(annotation_signature(output, 24), annotation_signature(source, 24))
        self.assertEqual(annotation_signature(output, 24)[0][0], "Text")
        self.assertTrue(annotation_signature(output, 24)[0][3])

        # Independent strict parser resolves every nested destination after the
        # atomic save/reopen validation performed by cmd_merge.
        reader = PdfReader(str(output), strict=True)
        destinations = []
        destination_types = []
        stack = list(reader.outline)
        while stack:
            item = stack.pop(0)
            if isinstance(item, list):
                stack[0:0] = item
            else:
                destinations.append(reader.get_destination_page_number(item))
                destination_types.append(str(item.typ))
        self.assertEqual(len(destinations), 5)
        self.assertTrue(all(0 <= page < 51 for page in destinations))
        self.assertIn("/Fit", destination_types)
        self.assertIn("/XYZ", destination_types)


if __name__ == "__main__":
    unittest.main()
