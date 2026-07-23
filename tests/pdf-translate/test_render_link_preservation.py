#!/usr/bin/env python3
"""Integration regressions for links, outlines, and geometry in inplace rendering."""

from __future__ import annotations

from collections import Counter
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import fitz
from pypdf import PdfReader
from reportlab.lib.pagesizes import A4, landscape, letter
from reportlab.pdfgen import canvas


REPO_ROOT = Path(__file__).resolve().parents[2]
TRANSLATOR = REPO_ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"
FONT = REPO_ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"
VERIFY_SPEC = importlib.util.spec_from_file_location(
    "verify_translation_for_link_render_test",
    REPO_ROOT / "scripts" / "verify_translation.py",
)
VERIFY_MODULE = importlib.util.module_from_spec(VERIFY_SPEC)
assert VERIFY_SPEC.loader is not None
VERIFY_SPEC.loader.exec_module(VERIFY_MODULE)


def run_translator(command: str, *args: Path, payload: dict | None = None) -> dict:
    proc = subprocess.run(
        [sys.executable, str(TRANSLATOR), command, *(str(arg) for arg in args)],
        input=json.dumps(payload, ensure_ascii=False) if payload is not None else None,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode:
        raise AssertionError(
            f"translate_pdf.py {command} failed ({proc.returncode})\n"
            f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"invalid translator JSON: {proc.stdout!r}") from exc


def identity_render(source: Path, output: Path) -> dict:
    extracted = run_translator("extract", source)
    translations = {
        str(block["id"]): block["text"] for block in extracted.get("blocks", [])
    }
    return run_translator(
        "render",
        source,
        output,
        FONT,
        payload={"translations": translations},
    )


def page_geometry(reader: PdfReader) -> list[tuple[tuple[float, ...], tuple[float, ...], int]]:
    result = []
    for page in reader.pages:
        media = tuple(float(value) for value in page.mediabox)
        crop = tuple(float(value) for value in page.cropbox)
        result.append((media, crop, int(page.rotation or 0) % 360))
    return result


def flatten_outline(reader: PdfReader, items=None) -> list[tuple[str, int]]:
    result = []
    for item in reader.outline if items is None else items:
        if isinstance(item, list):
            result.extend(flatten_outline(reader, item))
        else:
            result.append((str(item.title), reader.get_destination_page_number(item)))
    return result


def target_page_number(reader: PdfReader, destination) -> int:
    target = destination[0]
    target_id = getattr(target, "idnum", None)
    for index, page in enumerate(reader.pages):
        page_ref = page.indirect_reference
        if target is page or (target_id is not None and page_ref.idnum == target_id):
            return index
    raise AssertionError(f"could not resolve internal destination {destination!r}")


def local_destination_details(reader: PdfReader, destination) -> dict:
    arguments = []
    for value in destination[2:]:
        if value is None or value.__class__.__name__ == "NullObject":
            arguments.append(None)
        else:
            arguments.append(float(value))
    return {
        "target_page": target_page_number(reader, destination),
        "view": str(destination[1]),
        "destination_arguments": tuple(arguments),
    }


def collect_links(reader: PdfReader) -> list[dict]:
    links = []
    for source_page, page in enumerate(reader.pages):
        for ref in page.get("/Annots") or []:
            annotation = ref.get_object()
            if annotation.get("/Subtype") != "/Link":
                continue
            action = annotation.get("/A")
            if not hasattr(action, "get"):
                action = None
            action_kind = str(action.get("/S")) if action else ""
            item = {
                "source_page": source_page,
                "rect": tuple(float(value) for value in annotation.get("/Rect")),
                "action": action_kind,
            }
            if action_kind == "/URI":
                item["uri"] = str(action.get("/URI"))
            elif action_kind == "/GoTo":
                item.update(local_destination_details(reader, action.get("/D")))
            elif annotation.get("/Dest") is not None:
                item["action"] = "/Dest"
                item.update(
                    local_destination_details(reader, annotation.get("/Dest"))
                )
            elif action is not None:
                item["file"] = str(action.get("/F") or "")
            links.append(item)
    return links


def assert_rect_close(test: unittest.TestCase, actual, expected, places=2) -> None:
    test.assertEqual(len(actual), len(expected))
    for left, right in zip(actual, expected):
        test.assertAlmostEqual(left, right, places=places)


class RenderLinkPreservationTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)

    def tearDown(self):
        self.tempdir.cleanup()

    def make_reportlab_document(self, path: Path) -> None:
        c = canvas.Canvas(str(path), pagesize=A4, invariant=True)
        width, height = A4
        c.bookmarkPage("overview")
        c.addOutlineEntry("Overview", "overview", level=0, closed=False)
        c.setFont("Helvetica", 12)
        c.drawString(72, height - 72, "Open secure reference")
        c.linkURL(
            "https://example.com/restored",
            (70, height - 78, 230, height - 58),
            relative=0,
            thickness=0,
        )
        # This link has no overlapping text and must survive without being duplicated.
        c.linkURL(
            "https://example.com/survives",
            (380, 45, 520, 65),
            relative=0,
            thickness=0,
        )
        c.showPage()

        c.setPageSize(landscape(letter))
        width, height = landscape(letter)
        c.bookmarkPage("details")
        c.addOutlineEntry("Details", "details", level=0, closed=False)
        c.setFont("Helvetica", 12)
        c.drawString(72, height - 72, "Jump back to overview")
        c.linkRect(
            "",
            "overview",
            (70, height - 78, 230, height - 58),
            relative=0,
            thickness=0,
        )
        c.showPage()
        c.save()

    def test_render_restores_named_internal_and_uri_links_once(self):
        source = self.root / "source.pdf"
        output = self.root / "translated.pdf"
        self.make_reportlab_document(source)
        source_reader = PdfReader(str(source), strict=True)
        source_links = collect_links(source_reader)
        source_internal = [item for item in source_links if "target_page" in item]
        self.assertEqual(len(source_internal), 1)
        self.assertEqual(source_internal[0]["action"], "/Dest")
        self.assertEqual(source_internal[0]["target_page"], 0)
        self.assertEqual(source_internal[0]["view"], "/Fit")
        self.assertEqual(source_internal[0]["destination_arguments"], ())

        stats = identity_render(source, output)
        self.assertTrue(stats["ok"], stats)
        self.assertEqual(stats["restored_links"], 2, stats)

        output_reader = PdfReader(str(output), strict=True)
        output_links = collect_links(output_reader)
        self.assertEqual(
            Counter(item.get("uri") for item in output_links if item.get("uri")),
            Counter(
                {
                    "https://example.com/restored": 1,
                    "https://example.com/survives": 1,
                }
            ),
        )
        output_internal = [item for item in output_links if "target_page" in item]
        self.assertEqual(len(output_internal), 1, output_links)
        self.assertEqual(output_internal[0]["action"], "/Dest")
        self.assertEqual(output_internal[0]["target_page"], 0)
        self.assertEqual(output_internal[0]["view"], "/Fit")
        self.assertEqual(output_internal[0]["destination_arguments"], ())
        assert_rect_close(
            self,
            output_internal[0]["rect"],
            source_internal[0]["rect"],
        )
        self.assertEqual(
            flatten_outline(output_reader),
            flatten_outline(source_reader),
        )
        verification = VERIFY_MODULE.verify(
            str(output), str(source), mode="inplace", intent="restore"
        )
        self.assertEqual(
            verification["gates"]["link_preservation"]["status"],
            "pass",
            verification["gates"]["link_preservation"],
        )
        self.assertTrue(verification["passed"], verification["hard_failures"])
        source_geometry = page_geometry(source_reader)
        output_geometry = page_geometry(output_reader)
        self.assertEqual(len(output_geometry), len(source_geometry))
        for output_page, source_page in zip(output_geometry, source_geometry):
            for output_box, source_box in zip(output_page[:2], source_page[:2]):
                assert_rect_close(self, output_box, source_box, places=3)
            self.assertEqual(output_page[2], source_page[2])

    def test_render_preserves_explicit_xyz_point_and_zoom(self):
        source = self.root / "xyz-source.pdf"
        output = self.root / "xyz-translated.pdf"
        with fitz.open() as doc:
            doc.new_page(width=612, height=792)
            doc.new_page(width=612, height=842)
            page = doc[0]
            page.insert_text((72, 72), "Jump to the measured destination")
            page.insert_link(
                {
                    "kind": fitz.LINK_GOTO,
                    "from": fitz.Rect(68, 55, 280, 82),
                    "page": 1,
                    "to": fitz.Point(123, 234),
                    "zoom": 1.25,
                }
            )
            doc.save(source, garbage=3, deflate=True)

        source_reader = PdfReader(str(source), strict=True)
        source_internal = [
            item for item in collect_links(source_reader) if "target_page" in item
        ]
        self.assertEqual(len(source_internal), 1)
        self.assertEqual(source_internal[0]["action"], "/GoTo")
        self.assertEqual(source_internal[0]["view"], "/XYZ")
        self.assertEqual(source_internal[0]["target_page"], 1)
        self.assertAlmostEqual(
            source_internal[0]["destination_arguments"][2], 1.25, places=6
        )

        stats = identity_render(source, output)
        self.assertTrue(stats["ok"], stats)
        self.assertEqual(stats["restored_links"], 1, stats)
        output_reader = PdfReader(str(output), strict=True)
        output_internal = [
            item for item in collect_links(output_reader) if "target_page" in item
        ]
        self.assertEqual(len(output_internal), 1)
        self.assertEqual(output_internal[0]["action"], "/GoTo")
        self.assertEqual(output_internal[0]["view"], "/XYZ")
        self.assertEqual(output_internal[0]["target_page"], 1)
        assert_rect_close(
            self, output_internal[0]["rect"], source_internal[0]["rect"]
        )
        self.assertEqual(
            len(output_internal[0]["destination_arguments"]),
            len(source_internal[0]["destination_arguments"]),
        )
        for actual, expected in zip(
            output_internal[0]["destination_arguments"],
            source_internal[0]["destination_arguments"],
        ):
            self.assertAlmostEqual(actual, expected, places=6)
        verification = VERIFY_MODULE.verify(
            str(output), str(source), mode="inplace", intent="restore"
        )
        self.assertEqual(
            verification["gates"]["link_preservation"]["status"],
            "pass",
            verification["gates"]["link_preservation"],
        )
        self.assertTrue(verification["passed"], verification["hard_failures"])
        self.assertEqual(page_geometry(output_reader), page_geometry(source_reader))

    def test_redaction_does_not_reactivate_launch_or_file_uri(self):
        source_base = self.root / "source-base.pdf"
        source = self.root / "source.pdf"
        output = self.root / "translated.pdf"
        width, height = A4
        c = canvas.Canvas(str(source_base), pagesize=A4, invariant=True)
        c.setFont("Helvetica", 12)
        c.drawString(72, height - 72, "Linked text must be translated safely")
        c.showPage()
        c.save()

        with fitz.open(source_base) as doc:
            page = doc[0]
            link_rect = fitz.Rect(68, 55, 330, 82)
            unsafe_rect = fitz.Rect(390, 390, 560, 430)
            page.insert_link(
                {
                    "kind": fitz.LINK_URI,
                    "from": link_rect,
                    "uri": "https://example.com/allowed",
                }
            )
            page.insert_link(
                {
                    "kind": fitz.LINK_URI,
                    "from": unsafe_rect,
                    "uri": "file:///tmp/should-not-reactivate",
                }
            )
            page.insert_link(
                {
                    "kind": fitz.LINK_LAUNCH,
                    "from": unsafe_rect,
                    "file": "/tmp/should-not-launch",
                }
            )
            page.insert_link(
                {
                    "kind": fitz.LINK_URI,
                    "from": unsafe_rect,
                    "uri": "ms-msdt:/id/PCWDiagnostic",
                }
            )
            doc.save(source, garbage=3, deflate=True)

        source_links = collect_links(PdfReader(str(source), strict=True))
        self.assertEqual(len(source_links), 4, source_links)
        self.assertIn("/Launch", {item["action"] for item in source_links})
        self.assertIn(
            "file:///tmp/should-not-reactivate",
            {item.get("uri") for item in source_links},
        )
        self.assertIn(
            "ms-msdt:/id/PCWDiagnostic",
            {item.get("uri") for item in source_links},
        )

        stats = identity_render(source, output)
        self.assertTrue(stats["ok"], stats)
        self.assertEqual(stats["restored_links"], 1, stats)
        self.assertEqual(stats["unsafe_links_removed"], 3, stats)
        output_links = collect_links(PdfReader(str(output), strict=True))
        self.assertEqual(
            output_links,
            [
                {
                    "source_page": 0,
                    "rect": output_links[0]["rect"],
                    "action": "/URI",
                    "uri": "https://example.com/allowed",
                }
            ],
        )
        self.assertTrue(all(math.isfinite(value) for value in output_links[0]["rect"]))
        verification = VERIFY_MODULE.verify(
            str(output), str(source), mode="inplace", intent="restore"
        )
        self.assertEqual(
            verification["gates"]["link_preservation"]["status"],
            "pass",
            verification["gates"]["link_preservation"],
        )
        self.assertEqual(
            len(
                verification["gates"]["link_preservation"]["details"][
                    "unsafe_source_removed_by_policy"
                ]
            ),
            3,
        )


if __name__ == "__main__":
    unittest.main()
