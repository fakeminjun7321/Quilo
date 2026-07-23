import importlib.util
from pathlib import Path
import tempfile
import unittest

import fitz


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "verify_translation.py"
SPEC = importlib.util.spec_from_file_location("verify_translation_structure", SCRIPT_PATH)
VERIFY_MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(VERIFY_MODULE)


SOURCE_METADATA = {
    "title": "Text translation fixture",
    "subject": "Synthetic regression document",
    "keywords": "translation, fixture",
    "author": "Fixed Author",
    "creator": "Fixed Creator",
    "producer": "Fixed Producer",
    "creationDate": "D:20000101000000+00'00'",
    "modDate": "D:20000102000000+00'00'",
}

TRANSLATED_METADATA = {
    **SOURCE_METADATA,
    "title": "텍스트 번역 픽스처",
    "subject": "합성 회귀 테스트 문서",
    "keywords": "번역, 픽스처",
}

SOURCE_TOC = [
    [1, "Fixture start", 1],
    [2, "Detailed results", 2],
]

TRANSLATED_TOC = [
    [1, "픽스처 시작", 1],
    [2, "상세 결과", 2],
]


def write_pdf(path, *, toc=None, metadata=None, page_placements=None, outline_styles=None):
    document = fitz.open()
    placements = page_placements or [
        [((72, 100), "Source page")],
        [((72, 100), "Second page")],
    ]
    for page_items in placements:
        page = document.new_page(width=612, height=792)
        for point, text in page_items:
            page.insert_text(point, text, fontsize=11, fontname="helv")
    if toc:
        document.set_toc(toc)
        for index, changes in (outline_styles or {}).items():
            destination = dict(document.get_toc(simple=False)[index][3])
            destination.update(changes)
            document.set_toc_item(index, dest_dict=destination)
    if metadata is not None:
        document.set_metadata(metadata)
    document.save(path, garbage=4, deflate=True)
    document.close()


class VerifyDocumentStructureTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)

    def tearDown(self):
        self.tempdir.cleanup()

    def paths(self, stem="case"):
        return self.root / f"{stem}-source.pdf", self.root / f"{stem}-output.pdf"

    def assert_gate(self, report, name, status):
        self.assertEqual(report["gates"][name]["status"], status, report["gates"][name])

    def make_structured_pair(self, *, source_toc=SOURCE_TOC, output_toc=TRANSLATED_TOC,
                             source_metadata=SOURCE_METADATA,
                             output_metadata=TRANSLATED_METADATA,
                             source_outline_styles=None,
                             output_outline_styles=None,
                             stem="case"):
        source, output = self.paths(stem)
        write_pdf(
            source,
            toc=source_toc,
            metadata=source_metadata,
            outline_styles=source_outline_styles,
        )
        write_pdf(
            output,
            toc=output_toc,
            metadata=output_metadata,
            outline_styles=output_outline_styles,
        )
        return source, output

    def test_translated_outline_and_metadata_with_preserved_structure_pass(self):
        source, output = self.make_structured_pair()

        report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")

        self.assert_gate(report, "page_correspondence", "pass")
        self.assert_gate(report, "link_preservation", "pass")
        self.assertTrue(
            report["gates"]["page_correspondence"]["details"]["metadata"]["matched"]
        )
        self.assertTrue(
            report["gates"]["link_preservation"]["details"]["outlines"]["matched"]
        )

    def test_unchanged_translatable_outline_title_fails(self):
        output_toc = [
            [1, "Fixture start", 1],
            [2, "상세 결과", 2],
        ]
        source, output = self.make_structured_pair(output_toc=output_toc)

        report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")

        self.assert_gate(report, "link_preservation", "fail")
        outlines = report["gates"]["link_preservation"]["details"]["outlines"]
        self.assertIn("untranslated_title", {item["kind"] for item in outlines["mismatches"]})

    def test_outline_count_hierarchy_and_destination_changes_fail(self):
        cases = {
            "count": [[1, "픽스처 시작", 1]],
            "hierarchy": [[1, "픽스처 시작", 1], [1, "상세 결과", 2]],
            "destination": [[1, "픽스처 시작", 1], [2, "상세 결과", 1]],
        }
        expected_kinds = {
            "count": "count",
            "hierarchy": "hierarchy",
            "destination": "destination",
        }
        for name, output_toc in cases.items():
            with self.subTest(name=name):
                source, output = self.make_structured_pair(
                    output_toc=output_toc, stem=name
                )
                report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")
                self.assert_gate(report, "link_preservation", "fail")
                outlines = report["gates"]["link_preservation"]["details"]["outlines"]
                self.assertIn(
                    expected_kinds[name],
                    {item["kind"] for item in outlines["mismatches"]},
                )

    def test_outline_collapse_color_bold_and_italic_are_preserved(self):
        source_style = {
            0: {
                "collapse": False,
                "color": (1.0, 0.25, 0.0),
                "bold": True,
                "italic": True,
            }
        }
        source, output = self.make_structured_pair(
            source_outline_styles=source_style,
            output_outline_styles=source_style,
            stem="style-pass",
        )
        passing = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")
        self.assert_gate(passing, "link_preservation", "pass")

        cases = {
            "collapse": {"collapse": True, "color": (1.0, 0.25, 0.0), "bold": True, "italic": True},
            "color": {"collapse": False, "color": (0.0, 0.25, 1.0), "bold": True, "italic": True},
            "bold": {"collapse": False, "color": (1.0, 0.25, 0.0), "bold": False, "italic": True},
            "italic": {"collapse": False, "color": (1.0, 0.25, 0.0), "bold": True, "italic": False},
        }
        for name, output_style in cases.items():
            with self.subTest(name=name):
                source, output = self.make_structured_pair(
                    source_outline_styles=source_style,
                    output_outline_styles={0: output_style},
                    stem=f"style-{name}",
                )
                report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")
                self.assert_gate(report, "link_preservation", "fail")
                outlines = report["gates"]["link_preservation"]["details"]["outlines"]
                presentation = next(
                    item for item in outlines["mismatches"] if item["kind"] == "presentation"
                )
                self.assertIn(f"{name}_changed", presentation["reasons"])

    def test_unchanged_translatable_metadata_field_fails(self):
        output_metadata = {**TRANSLATED_METADATA, "title": SOURCE_METADATA["title"]}
        source, output = self.make_structured_pair(output_metadata=output_metadata)

        report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")

        self.assert_gate(report, "page_correspondence", "fail")
        metadata = report["gates"]["page_correspondence"]["details"]["metadata"]
        self.assertEqual(
            [item["field"] for item in metadata["untranslated_fields"]],
            ["title"],
        )

    def test_preserved_metadata_author_creator_producer_and_dates_must_not_change(self):
        for field in ("author", "creator", "producer", "creationDate", "modDate"):
            with self.subTest(field=field):
                output_metadata = {**TRANSLATED_METADATA, field: f"changed-{field}"}
                source, output = self.make_structured_pair(
                    output_metadata=output_metadata, stem=field
                )
                report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")
                self.assert_gate(report, "page_correspondence", "fail")
                metadata = report["gates"]["page_correspondence"]["details"]["metadata"]
                self.assertEqual(
                    [item["field"] for item in metadata["preserved_field_changes"]],
                    [field],
                )

        source, output = self.make_structured_pair(
            output_metadata={**TRANSLATED_METADATA, "author": SOURCE_METADATA["author"] + " "},
            stem="author-whitespace",
        )
        whitespace_report = VERIFY_MODULE.verify(
            str(output), str(source), mode="inplace"
        )
        self.assert_gate(whitespace_report, "page_correspondence", "fail")

    def test_restore_allows_unchanged_english_outline_and_target_metadata(self):
        source, output = self.make_structured_pair(
            output_toc=SOURCE_TOC,
            output_metadata=SOURCE_METADATA,
        )

        report = VERIFY_MODULE.verify(
            str(output), str(source), mode="inplace", intent="restore"
        )

        self.assert_gate(report, "page_correspondence", "pass")
        self.assert_gate(report, "link_preservation", "pass")

    def test_missing_outline_and_empty_metadata_do_not_create_false_positive(self):
        source, output = self.paths("empty")
        write_pdf(source, toc=None, metadata=None)
        write_pdf(output, toc=None, metadata=None)

        report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")

        self.assert_gate(report, "page_correspondence", "pass")
        self.assert_gate(report, "link_preservation", "pass")

    def test_new_strong_same_column_extraction_inversion_fails(self):
        source, output = self.paths("inverted")
        source_items = [[
            ((72, 100), "Source heading"),
            ((72, 240), "Middle source"),
            ((72, 430), "Lower source"),
        ]]
        output_items = [[
            ((72, 430), "Result lower"),
            ((72, 100), "Result heading"),
            ((72, 240), "Middle result"),
        ]]
        write_pdf(source, page_placements=source_items)
        write_pdf(output, page_placements=output_items)

        report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")

        self.assert_gate(report, "page_order", "fail")
        logical = report["gates"]["page_order"]["details"]["logical_reading_order"]
        self.assertFalse(logical["matched"])
        self.assertEqual(logical["mismatches"][0]["reason"], "new_same_column_inversion")

    def test_column_by_column_extraction_does_not_false_positive(self):
        source, output = self.paths("columns")
        source_items = [[
            ((72, 100), "Left source"),
            ((72, 430), "Left lower"),
            ((360, 100), "Right source"),
            ((360, 430), "Right lower"),
        ]]
        output_items = [[
            ((72, 100), "Left result"),
            ((72, 430), "Left ending"),
            ((360, 100), "Right result"),
            ((360, 430), "Right ending"),
        ]]
        write_pdf(source, page_placements=source_items)
        write_pdf(output, page_placements=output_items)

        report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")

        self.assert_gate(report, "page_order", "pass")
        logical = report["gates"]["page_order"]["details"]["logical_reading_order"]
        self.assertTrue(logical["matched"])

    def test_preexisting_source_inversion_is_not_reported_as_new(self):
        source, output = self.paths("baseline-inversion")
        source_items = [[
            ((72, 430), "Source lower"),
            ((72, 100), "Source heading"),
        ]]
        output_items = [[
            ((72, 430), "Result lower"),
            ((72, 100), "Result heading"),
        ]]
        write_pdf(source, page_placements=source_items)
        write_pdf(output, page_placements=output_items)

        report = VERIFY_MODULE.verify(str(output), str(source), mode="inplace")

        self.assert_gate(report, "page_order", "pass")


if __name__ == "__main__":
    unittest.main()
