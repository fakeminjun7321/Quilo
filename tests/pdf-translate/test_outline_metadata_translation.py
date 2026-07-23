#!/usr/bin/env python3
"""Regression tests for reader-visible outline and document-info translation."""

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
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[2]
TRANSLATOR = ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"
FONT = ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"
GENERATOR_SPEC = importlib.util.spec_from_file_location(
    "generate_pdf_fixtures_for_outline_test",
    Path(__file__).with_name("generate_fixtures.py"),
)
GENERATOR = importlib.util.module_from_spec(GENERATOR_SPEC)
assert GENERATOR_SPEC.loader is not None
GENERATOR_SPEC.loader.exec_module(GENERATOR)
VERIFY_SPEC = importlib.util.spec_from_file_location(
    "verify_translation_for_outline_gap_test",
    ROOT / "scripts" / "verify_translation.py",
)
VERIFY = importlib.util.module_from_spec(VERIFY_SPEC)
assert VERIFY_SPEC.loader is not None
VERIFY_SPEC.loader.exec_module(VERIFY)


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
    if not check:
        return proc
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
    with fitz.open(path) as doc:
        result = []
        for item in doc.get_toc(simple=False) or []:
            level, title, page = item[:3]
            destination = item[3] if len(item) > 3 else {}
            result.append((int(level), str(title), int(page), canonical(destination)))
        return tuple(result)


def navigation_signature(path: Path):
    return tuple((item[0], item[2], item[3]) for item in outline_signature(path))


def full_translation_map(extracted: dict) -> dict[str, str]:
    return {str(block["id"]): block["text"] for block in extracted["blocks"]}


class OutlineMetadataTranslationTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="quilo-pdf-outline-")
        self.root = Path(self.tempdir.name)
        GENERATOR.register_fonts()

    def tearDown(self):
        self.tempdir.cleanup()

    def make_fixture01(self) -> Path:
        path = self.root / "01_text_numbers_links.pdf"
        GENERATOR.generate_text_links(path)
        return path

    def make_nested_document(self) -> Path:
        base = self.root / "nested-base.pdf"
        styled = self.root / "nested.pdf"
        c = canvas.Canvas(str(base), pagesize=A4, invariant=True)
        c.setTitle("Nested outline translation fixture")
        c.setSubject("Reader visible document information")
        c.setKeywords("translation, regression, PDF")
        c.setAuthor("Preserved Test Author")
        c.setCreator("Preserved Test Creator")

        c.bookmarkPage("overview", fit="Fit")
        c.addOutlineEntry("Overview", "overview", level=0, closed=True)
        c.setFont("Helvetica", 12)
        c.drawString(72, 740, "Overview page with ordinary translated prose")
        c.showPage()

        c.bookmarkPage("repeat-one", fit="XYZ", left=91, top=702, zoom=1.35)
        c.addOutlineEntry("Repeated section", "repeat-one", level=1, closed=False)
        c.setFont("Helvetica", 12)
        c.drawString(72, 700, "First repeated section with a measured destination")
        c.showPage()

        c.bookmarkPage("repeat-two", fit="Fit")
        c.addOutlineEntry("Repeated section", "repeat-two", level=1, closed=False)
        c.bookmarkPage("opaque-rfc", fit="Fit")
        c.addOutlineEntry("RFC", "opaque-rfc", level=0, closed=False)
        c.bookmarkPage("opaque-url", fit="Fit")
        c.addOutlineEntry("https://example.com/spec", "opaque-url", level=0, closed=False)
        c.bookmarkPage("uppercase-prose", fit="Fit")
        c.addOutlineEntry("INTRODUCTION", "uppercase-prose", level=0, closed=False)
        c.setFont("Helvetica", 12)
        c.drawString(72, 680, "Second repeated section and opaque outline labels")
        c.showPage()
        c.save()

        # Add presentation attributes to the parent.  Translation must not rebuild
        # this TOC item or lose its closed state, color, bold or italic styling.
        with fitz.open(base) as doc:
            parent_xref = int(doc.get_toc(simple=False)[0][3]["xref"])
            # PDF outline /F bit 1 = italic, bit 2 = bold; /C is RGB.
            doc.xref_set_key(parent_xref, "F", "3")
            doc.xref_set_key(parent_xref, "C", "[0.1 0.2 0.7]")
            doc.save(styled, garbage=3, deflate=True)
        return styled

    def test_fixture01_translates_fit_outline_and_metadata_without_semantic_loss(self):
        source = self.make_fixture01()
        output = self.root / "translated.pdf"
        extracted = run_translator("extract", source)
        self.assertEqual(extracted["virtual_block_count"], 3)
        self.assertTrue(
            all(
                block.get("kind") not in {"outline", "metadata"}
                for block in extracted["blocks"][: extracted["page_block_count"]]
            )
        )
        self.assertEqual(
            [block["id"] for block in extracted["blocks"][-3:]],
            [
                "__pdf_outline__:000000",
                "__pdf_metadata__:title",
                "__pdf_metadata__:subject",
            ],
        )

        translations = full_translation_map(extracted)
        translations["__pdf_outline__:000000"] = "픽스처 시작"
        translations["__pdf_metadata__:title"] = "텍스트, 숫자 및 링크 픽스처"
        translations["__pdf_metadata__:subject"] = "합성 CC0 픽스처 콘텐츠"
        stats = run_translator(
            "render", source, output, FONT, payload={"translations": translations}
        )
        self.assertTrue(stats["ok"], stats)
        self.assertEqual(stats["expected"], len(extracted["blocks"]))
        self.assertEqual(stats["replaced"], len(extracted["blocks"]))
        self.assertEqual(stats["drawn"], len(extracted["blocks"]))
        self.assertEqual(stats["font_expected"], extracted["page_block_count"])
        self.assertEqual(len(stats["font_sizes"]), extracted["page_block_count"])
        self.assertEqual(stats["virtual_replaced"], 3)
        self.assertEqual(stats["outline_replaced"], 1)
        self.assertEqual(stats["metadata_replaced"], 2)

        self.assertEqual(navigation_signature(output), navigation_signature(source))
        output_outline = outline_signature(output)
        self.assertEqual(output_outline[0][1], "픽스처 시작")
        self.assertIn(("view", "Fit"), output_outline[0][3])

        with fitz.open(source) as source_doc, fitz.open(output) as output_doc:
            self.assertEqual(output_doc.metadata["title"], "텍스트, 숫자 및 링크 픽스처")
            self.assertEqual(output_doc.metadata["subject"], "합성 CC0 픽스처 콘텐츠")
            for field in (
                "author",
                "creator",
                "producer",
                "creationDate",
                "modDate",
            ):
                self.assertEqual(output_doc.metadata[field], source_doc.metadata[field])

        reader = PdfReader(str(output), strict=True)
        self.assertEqual(str(reader.outline[0].title), "픽스처 시작")
        self.assertEqual(reader.get_destination_page_number(reader.outline[0]), 0)

    def test_nested_duplicate_fit_xyz_and_styles_keep_navigation_exact(self):
        source = self.make_nested_document()
        output = self.root / "nested-translated.pdf"
        source_signature = outline_signature(source)
        self.assertEqual([item[1] for item in source_signature], [
            "Overview",
            "Repeated section",
            "Repeated section",
            "RFC",
            "https://example.com/spec",
            "INTRODUCTION",
        ])
        destination_text = repr([item[3] for item in source_signature])
        self.assertIn("Fit", destination_text)
        self.assertIn("('kind', 1)", destination_text)
        self.assertIn("('zoom', 1.35)", destination_text)
        self.assertIn("collapse", destination_text)
        self.assertIn("color", destination_text)

        extracted = run_translator("extract", source)
        outline_blocks = [
            block for block in extracted["blocks"] if block.get("kind") == "outline"
        ]
        self.assertEqual([block["index"] for block in outline_blocks], [0, 1, 2, 5])
        self.assertEqual([block["text"] for block in outline_blocks], [
            "Overview",
            "Repeated section",
            "Repeated section",
            "INTRODUCTION",
        ])
        metadata_blocks = [
            block for block in extracted["blocks"] if block.get("kind") == "metadata"
        ]
        self.assertEqual(
            [block["field"] for block in metadata_blocks],
            ["title", "subject", "keywords"],
        )

        translations = full_translation_map(extracted)
        translations[outline_blocks[0]["id"]] = "개요"
        translations[outline_blocks[1]["id"]] = "반복 절 첫 번째"
        translations[outline_blocks[2]["id"]] = "반복 절 두 번째"
        translations[outline_blocks[3]["id"]] = "소개"
        for block, target in zip(
            metadata_blocks,
            ("중첩 목차 번역 픽스처", "리더에 표시되는 문서 정보", "번역, 회귀, PDF"),
        ):
            translations[block["id"]] = target

        stats = run_translator(
            "render", source, output, FONT, payload={"translations": translations}
        )
        self.assertTrue(stats["ok"], stats)
        self.assertEqual(stats["outline_expected"], 4)
        self.assertEqual(stats["metadata_expected"], 3)
        self.assertEqual(navigation_signature(output), navigation_signature(source))
        output_titles = [item[1] for item in outline_signature(output)]
        self.assertEqual(
            output_titles,
            [
                "개요",
                "반복 절 첫 번째",
                "반복 절 두 번째",
                "RFC",
                "https://example.com/spec",
                "소개",
            ],
        )

        with fitz.open(source) as source_doc, fitz.open(output) as output_doc:
            self.assertEqual(output_doc.metadata["keywords"], "번역, 회귀, PDF")
            self.assertEqual(output_doc.metadata["author"], source_doc.metadata["author"])
            self.assertEqual(output_doc.metadata["creator"], source_doc.metadata["creator"])
            self.assertEqual(output_doc.metadata["producer"], source_doc.metadata["producer"])
        # Both independent parsers must reopen and resolve every destination.
        reader = PdfReader(str(output), strict=True)
        destinations = []
        destination_views = []
        stack = list(reader.outline)
        while stack:
            item = stack.pop(0)
            if isinstance(item, list):
                stack[0:0] = item
            else:
                destinations.append(reader.get_destination_page_number(item))
                destination_views.append(str(item.typ))
        self.assertEqual(len(destinations), 6)
        self.assertTrue(all(page >= 0 for page in destinations))
        self.assertIn("/Fit", destination_views)
        self.assertIn("/XYZ", destination_views)

    def test_missing_or_empty_virtual_translation_fails_before_output(self):
        source = self.make_fixture01()
        extracted = run_translator("extract", source)
        translations = full_translation_map(extracted)

        translations.pop("__pdf_outline__:000000")
        missing_output = self.root / "missing.pdf"
        missing = run_translator(
            "render",
            source,
            missing_output,
            FONT,
            payload={"translations": translations},
            check=False,
        )
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("missing or empty required PDF outline/metadata", missing.stderr)
        self.assertIn("__pdf_outline__:000000", missing.stderr)
        self.assertFalse(missing_output.exists())

        translations = full_translation_map(extracted)
        translations["__pdf_metadata__:subject"] = "   "
        empty_output = self.root / "empty.pdf"
        empty = run_translator(
            "render",
            source,
            empty_output,
            FONT,
            payload={"translations": translations},
            check=False,
        )
        self.assertNotEqual(empty.returncode, 0)
        self.assertIn("__pdf_metadata__:subject", empty.stderr)
        self.assertFalse(empty_output.exists())

    def test_no_outline_and_default_metadata_add_no_virtual_blocks(self):
        source = self.root / "plain.pdf"
        output = self.root / "plain-output.pdf"
        c = canvas.Canvas(str(source), pagesize=A4, invariant=True)
        c.setFont("Helvetica", 12)
        c.drawString(72, 740, "Ordinary page text without any bookmarks")
        c.showPage()
        c.save()
        extracted = run_translator("extract", source)
        self.assertEqual(extracted["virtual_block_count"], 0)
        self.assertEqual(extracted["page_block_count"], len(extracted["blocks"]))
        with fitz.open(source) as source_doc:
            source_metadata = dict(source_doc.metadata)
        stats = run_translator(
            "render",
            source,
            output,
            FONT,
            payload={"translations": full_translation_map(extracted)},
        )
        self.assertTrue(stats["ok"], stats)
        self.assertEqual(stats["virtual_replaced"], 0)
        self.assertEqual(stats["font_expected"], stats["expected"])
        with fitz.open(output) as output_doc:
            self.assertEqual(output_doc.get_toc(simple=False), [])
            self.assertEqual(output_doc.metadata, source_metadata)
        PdfReader(str(output), strict=True)

    def test_verifier_untranslated_gate_outline_gap_is_explicitly_documented(self):
        """TODO: the independent verifier still scans page text, not TOC strings."""
        source = self.root / "verifier-outline-source.pdf"
        output = self.root / "verifier-outline-output.pdf"
        with fitz.open() as doc:
            page = doc.new_page(width=400, height=300)
            page.insert_text((40, 60), "이미 번역된 한국어 페이지 본문입니다.")
            doc.set_toc([[1, "English outline remains", 1]])
            doc.save(source, garbage=3, deflate=True)
        with fitz.open(source) as doc:
            doc.save(output, garbage=3, deflate=True)

        report = VERIFY.verify(
            str(output), str(source), mode="inplace", intent="translate"
        )
        # This passing status is a documented verifier limitation, not desired
        # product behavior.  The renderer's virtual-block coverage closes the
        # production path today; a future verifier gate should inspect TOC and
        # metadata independently as defense in depth.
        self.assertEqual(
            report["gates"]["untranslated_text"]["status"],
            "pass",
            report["gates"]["untranslated_text"],
        )


if __name__ == "__main__":
    unittest.main()
