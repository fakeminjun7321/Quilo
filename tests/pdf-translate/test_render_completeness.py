#!/usr/bin/env python3
"""API-free regression tests for the low-level PDF text draw completeness contract."""

import importlib.util
import copy
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import fitz


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"
SPEC = importlib.util.spec_from_file_location("quilo_translate_pdf", MODULE_PATH)
translate_pdf = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(translate_pdf)


class DrawCompletenessTest(unittest.TestCase):
    def setUp(self):
        self.doc = fitz.open()
        self.page = self.doc.new_page(width=120, height=120)
        self.font = fitz.Font("helv")

    def tearDown(self):
        self.doc.close()

    def test_draw_fit_reports_complete_normal_text(self):
        state = translate_pdf._draw_fit(
            self.page,
            fitz.Rect(5, 5, 115, 35),
            "Short complete text",
            (0, 0, 0),
            self.font,
            10,
            fitz.TEXT_ALIGN_LEFT,
            max_x=115,
            max_y=35,
        )
        self.assertTrue(state["drawn"])
        self.assertTrue(state["complete"])
        self.assertFalse(state["shrunk"])
        self.assertEqual(state["min_font"], 10.0)

    def test_draw_fit_reports_minimum_font_overflow(self):
        state = translate_pdf._draw_fit(
            self.page,
            fitz.Rect(5, 5, 28, 11),
            "overflow " * 200,
            (0, 0, 0),
            self.font,
            12,
            fitz.TEXT_ALIGN_LEFT,
            min_size=4,
            max_x=28,
            max_y=11,
        )
        self.assertTrue(state["drawn"])
        self.assertFalse(state["complete"])
        self.assertTrue(state["shrunk"])
        self.assertEqual(state["min_font"], 4.0)

    def test_redrawn_latin_presentation_ligatures_expand_narrowly(self):
        self.assertEqual(
            translate_pdf._normalize_redrawn_latin_ligatures(
                "\ufb00 \ufb01 \ufb02 \ufb03 \ufb04 \ufb05 \ufb06"
            ),
            "ff fi fl ffi ffl st st",
        )
        # Scientific compatibility characters outside U+FB00..U+FB06 are not
        # subject to a broad NFKC rewrite at the rendering boundary.
        scientific = "\u212b 10\u00b2 \u03bb = 500 nm"
        self.assertEqual(
            translate_pdf._normalize_redrawn_latin_ligatures(scientific),
            scientific,
        )

    def test_render_expands_model_copied_fi_ligature_before_font_subsetting(self):
        with tempfile.TemporaryDirectory(prefix="quilo-pdf-ligature-render-") as tmp:
            source = Path(tmp) / "source.pdf"
            output = Path(tmp) / "output.pdf"
            doc = fitz.open()
            page = doc.new_page(width=320, height=140)
            page.insert_textbox(
                fitz.Rect(24, 30, 296, 86),
                "This source credit is ordinary prose requiring translation.",
                fontsize=10,
                fontname="helv",
            )
            doc.save(source)
            doc.close()

            extracted = subprocess.run(
                [sys.executable, str(MODULE_PATH), "extract", str(source)],
                check=True,
                capture_output=True,
                text=True,
            )
            meta = json.loads(extracted.stdout)
            self.assertEqual(len(meta["blocks"]), 1, meta)
            block_id = str(meta["blocks"][0]["id"])
            target = "사진: Spetsialnaya Astro\ufb01zitsheskaya Observatorya"
            rendered = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "render",
                    str(source),
                    str(output),
                    str(ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"),
                ],
                input=json.dumps(
                    {"translations": {block_id: target}}, ensure_ascii=False
                ),
                check=True,
                capture_output=True,
                text=True,
            )
            stats = json.loads(rendered.stdout)
            self.assertTrue(stats["ok"], stats)
            with fitz.open(output) as rendered_doc:
                output_text = rendered_doc[0].get_text()
            self.assertNotIn("\ufb01", output_text)
            self.assertIn("Astrofizit", output_text.replace("\n", ""))

    def test_sparse_source_column_still_caps_prose_at_observed_right_edge(self):
        items = [
            (
                fitz.Rect(62, 24, 110, 55),
                "첫 번째 오른쪽 열의 일반 본문 문장으로 충분한 길이를 가진다.",
                9,
                0,
                False,
                False,
                1,
            ),
            (
                fitz.Rect(62, 62, 110, 108),
                "두 번째 오른쪽 열의 일반 본문 문장으로 열 너비를 증명한다.",
                9,
                0,
                False,
                False,
                2,
            ),
        ]

        caps = translate_pdf._infer_column_right_caps(items, self.page)

        self.assertEqual(set(caps), {1, 2})
        self.assertGreaterEqual(caps[2], 110)
        self.assertLessEqual(caps[2], 112.01)

    def test_render_does_not_expand_sparse_right_column_into_outer_margin(self):
        with tempfile.TemporaryDirectory(prefix="quilo-pdf-sparse-column-") as tmp:
            source = Path(tmp) / "source.pdf"
            output = Path(tmp) / "output.pdf"
            doc = fitz.open()
            page = doc.new_page(width=504, height=720)
            page.insert_textbox(
                fitz.Rect(258, 70, 454, 170),
                (
                    "The first right column paragraph establishes the source "
                    "column edge. It contains ordinary prose and ends here."
                ),
                fontsize=10,
                fontname="helv",
            )
            page.insert_textbox(
                fitz.Rect(258, 210, 454, 520),
                (
                    "The second right column paragraph is deliberately tall. "
                    "It provides sufficient source layout space for a longer "
                    "translated paragraph without consuming the outer margin. "
                )
                * 3,
                fontsize=10,
                fontname="helv",
            )
            doc.save(source)
            doc.close()

            extracted = subprocess.run(
                [sys.executable, str(MODULE_PATH), "extract", str(source)],
                check=True,
                capture_output=True,
                text=True,
            )
            meta = json.loads(extracted.stdout)
            self.assertEqual(len(meta["blocks"]), 2, meta)

            source_doc = fitz.open(source)
            try:
                translate_pdf.build_decoders(source_doc)
                source_rects = {
                    str(block_id): fitz.Rect(block["bbox"])
                    for block_id, _page_number, block in translate_pdf.iter_text_blocks(
                        source_doc
                    )
                }
            finally:
                source_doc.close()
            source_right = max(rect.x1 for rect in source_rects.values())

            translations = {
                str(meta["blocks"][0]["id"]):
                    "첫 번째 오른쪽 열 문단은 원래 열의 오른쪽 경계를 유지한다.",
                str(meta["blocks"][1]["id"]): (
                    "두 번째 오른쪽 열의 번역문은 충분히 길지만 원래 열 안에서 줄을 "
                    "바꾸거나 글자 크기를 조절해야 하며 페이지 바깥 여백으로 확장되면 안 된다. "
                )
                * 4,
            }
            rendered = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "render",
                    str(source),
                    str(output),
                    str(ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"),
                ],
                input=json.dumps({"translations": translations}, ensure_ascii=False),
                check=True,
                capture_output=True,
                text=True,
            )
            stats = json.loads(rendered.stdout)
            self.assertTrue(stats["ok"], stats)

            output_doc = fitz.open(output)
            try:
                korean_rects = []
                for block in output_doc[0].get_text("dict").get("blocks", []):
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            if any("가" <= char <= "힣" for char in span.get("text", "")):
                                korean_rects.append(fitz.Rect(span["bbox"]))
            finally:
                output_doc.close()
            self.assertTrue(korean_rects)
            self.assertLessEqual(
                max(rect.x1 for rect in korean_rects),
                source_right + 2.5,
            )

    def test_rotated_caption_chain_merges_and_renders_at_source_size(self):
        with tempfile.TemporaryDirectory(prefix="quilo-pdf-rotated-caption-") as tmp:
            source = Path(tmp) / "source.pdf"
            output = Path(tmp) / "output.pdf"
            doc = fitz.open()
            page = doc.new_page(width=504, height=720)
            map_rect = fitz.Rect(52, 184, 377, 650)
            page.draw_rect(map_rect, color=(0, 0, 0), fill=(0.92, 0.92, 0.92))
            for x in range(82, 377, 30):
                page.draw_line(
                    fitz.Point(x, map_rect.y0),
                    fitz.Point(x, map_rect.y1),
                    color=(0.2, 0.2, 0.2),
                    width=0.5,
                )
            for y in range(214, 650, 32):
                page.draw_line(
                    fitz.Point(map_rect.x0, y),
                    fitz.Point(map_rect.x1, y),
                    color=(0.2, 0.2, 0.2),
                    width=0.5,
                )
            source_lines = [
                (
                    fitz.Point(408, 664),
                    "Fig. 9.4 The map caption continues to the",
                ),
                (
                    fitz.Point(419, 664),
                    "next line and describes a long journey",
                ),
                (
                    fitz.Point(430, 664),
                    "from Honolulu to Tokyo without seeing a night",
                ),
                (
                    fitz.Point(441, 664),
                    "en route, which completes the caption.",
                ),
            ]
            for point, value in source_lines:
                page.insert_text(
                    point,
                    value,
                    fontname="helv",
                    fontsize=8.5,
                    rotate=90,
                )
            doc.save(source)
            doc.close()

            with fitz.open(source) as source_doc:
                raw_blocks = [
                    block
                    for block in source_doc[0].get_text("dict")["blocks"]
                    if block.get("type") == 0
                ]
            self.assertEqual(len(raw_blocks), 4)

            extracted = subprocess.run(
                [sys.executable, str(MODULE_PATH), "extract", str(source)],
                check=True,
                capture_output=True,
                text=True,
            )
            meta = json.loads(extracted.stdout)
            self.assertEqual(len(meta["blocks"]), 1, meta)
            source_text = meta["blocks"][0]["text"]
            self.assertIn("to the next line", source_text)
            self.assertIn("journey from Honolulu", source_text)
            self.assertIn("night en route", source_text)

            block_id = str(meta["blocks"][0]["id"])
            target = (
                "그림 9.4 시간대 지도는 지역 표준시와 날짜변경선을 보여 준다. "
                "Honolulu에서 Tokyo로 이동하는 예는 날짜가 바뀌는 과정을 설명한다. "
                "하나의 연속된 그림 설명이다."
            )
            rendered = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "render",
                    str(source),
                    str(output),
                    str(ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"),
                ],
                input=json.dumps(
                    {"translations": {block_id: target}}, ensure_ascii=False
                ),
                check=True,
                capture_output=True,
                text=True,
            )
            stats = json.loads(rendered.stdout)
            self.assertTrue(stats["ok"], stats)
            self.assertEqual(stats["font_sizes"][0]["source"], 8.5)
            self.assertEqual(stats["font_sizes"][0]["rendered"], 8.5)

            with fitz.open(source) as source_doc, fitz.open(output) as output_doc:
                source_map = source_doc[0].get_pixmap(
                    matrix=fitz.Matrix(2, 2), clip=map_rect, alpha=False
                )
                output_map = output_doc[0].get_pixmap(
                    matrix=fitz.Matrix(2, 2), clip=map_rect, alpha=False
                )
                self.assertEqual(source_map.samples, output_map.samples)
                korean_lines = []
                for block in output_doc[0].get_text("dict")["blocks"]:
                    for line in block.get("lines", []):
                        value = "".join(
                            span.get("text", "") for span in line.get("spans", [])
                        )
                        if any("가" <= char <= "힣" for char in value):
                            korean_lines.append(line)
                self.assertTrue(korean_lines)
                self.assertEqual(
                    {tuple(round(value, 2) for value in line["dir"])
                     for line in korean_lines},
                    {(0.0, -1.0)},
                )
                rendered_text = " ".join(
                    "".join(span.get("text", "") for span in line.get("spans", []))
                    for line in korean_lines
                )
                self.assertLess(
                    rendered_text.find("날짜변경선"),
                    rendered_text.find("Honolulu"),
                )
                self.assertLess(
                    rendered_text.find("Honolulu"),
                    rendered_text.find("하나의 연속된"),
                )

    def test_formula_transition_uses_column_left_alignment_without_moving_header(self):
        with tempfile.TemporaryDirectory(prefix="quilo-pdf-formula-transition-") as tmp:
            source = Path(tmp) / "source.pdf"
            output = Path(tmp) / "output.pdf"
            doc = fitz.open()
            page = doc.new_page(width=504, height=720)
            page.insert_textbox(
                fitz.Rect(258, 420, 454, 510),
                (
                    "This ordinary right column paragraph establishes the column "
                    "left edge and its usable width. It ends before the equation."
                ),
                fontsize=10,
                fontname="helv",
            )
            page.insert_text(fitz.Point(258, 580), "Hence", fontsize=10, fontname="helv")
            page.insert_textbox(
                fitz.Rect(400, 520, 454, 542),
                "Thus",
                fontsize=9,
                fontname="helv",
                align=fitz.TEXT_ALIGN_RIGHT,
            )
            page.insert_text(
                fitz.Point(410, 566),
                "z = x / y",
                fontsize=10,
                fontname="helv",
            )
            page.insert_text(
                fitz.Point(300, 620),
                "tan x = y / x",
                fontsize=10,
                fontname="helv",
            )
            page.insert_textbox(
                fitz.Rect(400, 24, 454, 46),
                "Appendix",
                fontsize=9,
                fontname="helv",
                align=fitz.TEXT_ALIGN_RIGHT,
            )
            doc.save(source)
            doc.close()

            extracted = subprocess.run(
                [sys.executable, str(MODULE_PATH), "extract", str(source)],
                check=True,
                capture_output=True,
                text=True,
            )
            meta = json.loads(extracted.stdout)
            ids = {block["text"]: str(block["id"]) for block in meta["blocks"]}
            self.assertIn("Hence", ids)
            self.assertIn("Thus", ids)
            self.assertIn("Appendix", ids)
            body_source = next(
                text for text in ids if text.startswith("This ordinary right column")
            )
            self.assertNotIn("tan x = y / x", ids)

            source_doc = fitz.open(source)
            try:
                translate_pdf.build_decoders(source_doc)
                source_rects = {
                    str(block_id): fitz.Rect(block["bbox"])
                    for block_id, _page_number, block in translate_pdf.iter_text_blocks(
                        source_doc
                    )
                }
                header_right = source_rects[ids["Appendix"]].x1
                right_transition_edge = source_rects[ids["Thus"]].x1
            finally:
                source_doc.close()

            translations = {
                ids[body_source]:
                    "오른쪽 열의 긴 본문 문장은 원래 열 경계와 사용할 수 있는 폭을 증명한다.",
                ids["Hence"]: "그러므로",
                ids["Thus"]: "따라서",
                ids["Appendix"]: "부록",
            }
            rendered = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "render",
                    str(source),
                    str(output),
                    str(ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"),
                ],
                input=json.dumps({"translations": translations}, ensure_ascii=False),
                check=True,
                capture_output=True,
                text=True,
            )
            stats = json.loads(rendered.stdout)
            self.assertTrue(stats["ok"], stats)
            rendered_sizes = {
                str(item["id"]): item["rendered"] for item in stats["font_sizes"]
            }
            self.assertEqual(rendered_sizes[ids["Hence"]], 10.0)

            with fitz.open(source) as source_doc, fitz.open(output) as output_doc:
                formula_rect = fitz.Rect(294, 604, 374, 626)
                source_formula = source_doc[0].get_pixmap(
                    matrix=fitz.Matrix(2, 2), clip=formula_rect, alpha=False
                )
                output_formula = output_doc[0].get_pixmap(
                    matrix=fitz.Matrix(2, 2), clip=formula_rect, alpha=False
                )
                self.assertEqual(source_formula.samples, output_formula.samples)
                target_spans = {}
                for block in output_doc[0].get_text("dict")["blocks"]:
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            if span.get("text") in {"그러므로", "따라서", "부록"}:
                                target_spans[span["text"]] = fitz.Rect(span["bbox"])
                self.assertEqual(set(target_spans), {"그러므로", "따라서", "부록"})
                self.assertLessEqual(target_spans["그러므로"].height, 13.0)
                self.assertAlmostEqual(
                    target_spans["따라서"].x1,
                    right_transition_edge,
                    delta=2.5,
                )
                self.assertAlmostEqual(
                    target_spans["부록"].x1,
                    header_right,
                    delta=2.5,
                )

    def test_standalone_gives_uses_proven_column_width_before_formula(self):
        with tempfile.TemporaryDirectory(prefix="quilo-pdf-gives-transition-") as tmp:
            source = Path(tmp) / "source.pdf"
            output = Path(tmp) / "output.pdf"
            doc = fitz.open()
            page = doc.new_page(width=504, height=720)
            page.insert_textbox(
                fitz.Rect(258, 470, 454, 530),
                (
                    "This ordinary right column paragraph proves the usable "
                    "column width before a short equation transition."
                ),
                fontsize=10,
                fontname="helv",
            )
            page.insert_text(
                fitz.Point(258, 580), "gives", fontsize=10, fontname="helv"
            )
            page.insert_text(
                fitz.Point(310, 610),
                "M = 6 - 5 log 100 / 10 = 1.",
                fontsize=10,
                fontname="helv",
            )
            doc.save(source)
            doc.close()

            extracted = subprocess.run(
                [sys.executable, str(MODULE_PATH), "extract", str(source)],
                check=True,
                capture_output=True,
                text=True,
            )
            meta = json.loads(extracted.stdout)
            ids = {block["text"]: str(block["id"]) for block in meta["blocks"]}
            self.assertIn("gives", ids)
            body_source = next(
                text for text in ids if text.startswith("This ordinary right column")
            )
            self.assertFalse(
                any(block["text"].startswith("M = 6") for block in meta["blocks"])
            )

            rendered = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "render",
                    str(source),
                    str(output),
                    str(ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"),
                ],
                input=json.dumps(
                    {
                        "translations": {
                            ids[body_source]: "오른쪽 열의 일반 본문은 사용할 수 있는 열 폭을 증명한다.",
                            ids["gives"]: "다음을 얻는다.",
                        }
                    },
                    ensure_ascii=False,
                ),
                check=True,
                capture_output=True,
                text=True,
            )
            stats = json.loads(rendered.stdout)
            self.assertTrue(stats["ok"], stats)
            gives_size = next(
                item["rendered"]
                for item in stats["font_sizes"]
                if str(item["id"]) == ids["gives"]
            )
            self.assertEqual(gives_size, 10.0)

            with fitz.open(source) as source_doc, fitz.open(output) as output_doc:
                formula_rect = fitz.Rect(306, 594, 454, 616)
                source_formula = source_doc[0].get_pixmap(
                    matrix=fitz.Matrix(3, 3), clip=formula_rect, alpha=False
                )
                output_formula = output_doc[0].get_pixmap(
                    matrix=fitz.Matrix(3, 3), clip=formula_rect, alpha=False
                )
                self.assertEqual(source_formula.samples, output_formula.samples)
                gives_span = next(
                    span
                    for block in output_doc[0].get_text("dict")["blocks"]
                    for line in block.get("lines", [])
                    for span in line.get("spans", [])
                    if span.get("text") == "다음을 얻는다."
                )
                self.assertEqual(round(gives_span["size"], 1), 10.0)
                self.assertLessEqual(gives_span["bbox"][2], 454.0)

    def test_standalone_and_uses_proven_column_width_before_formula(self):
        with tempfile.TemporaryDirectory(prefix="quilo-pdf-and-transition-") as tmp:
            source = Path(tmp) / "source.pdf"
            output = Path(tmp) / "output.pdf"
            doc = fitz.open()
            page = doc.new_page(width=504, height=720)
            page.insert_textbox(
                fitz.Rect(258, 470, 454, 530),
                (
                    "This ordinary right column paragraph proves the usable "
                    "column width before a conjunction and equation."
                ),
                fontsize=10,
                fontname="helv",
            )
            page.insert_text(
                fitz.Point(258, 580), "and", fontsize=10, fontname="helv"
            )
            page.insert_text(
                fitz.Point(310, 610),
                "q = x + y",
                fontsize=10,
                fontname="helv",
            )
            doc.save(source)
            doc.close()

            extracted = subprocess.run(
                [sys.executable, str(MODULE_PATH), "extract", str(source)],
                check=True,
                capture_output=True,
                text=True,
            )
            meta = json.loads(extracted.stdout)
            ids = {block["text"]: str(block["id"]) for block in meta["blocks"]}
            self.assertIn("and", ids)
            body_source = next(
                text for text in ids if text.startswith("This ordinary right column")
            )
            self.assertNotIn("q = x + y", ids)

            rendered = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "render",
                    str(source),
                    str(output),
                    str(ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"),
                ],
                input=json.dumps(
                    {
                        "translations": {
                            ids[body_source]: "오른쪽 열의 본문은 사용할 수 있는 열 폭을 증명한다.",
                            ids["and"]: "그리고 다음 식을 얻는다.",
                        }
                    },
                    ensure_ascii=False,
                ),
                check=True,
                capture_output=True,
                text=True,
            )
            stats = json.loads(rendered.stdout)
            self.assertTrue(stats["ok"], stats)
            and_size = next(
                item["rendered"]
                for item in stats["font_sizes"]
                if str(item["id"]) == ids["and"]
            )
            self.assertEqual(and_size, 10.0)

            with fitz.open(source) as source_doc, fitz.open(output) as output_doc:
                formula_rect = fitz.Rect(306, 594, 374, 616)
                source_formula = source_doc[0].get_pixmap(
                    matrix=fitz.Matrix(3, 3), clip=formula_rect, alpha=False
                )
                output_formula = output_doc[0].get_pixmap(
                    matrix=fitz.Matrix(3, 3), clip=formula_rect, alpha=False
                )
                self.assertEqual(source_formula.samples, output_formula.samples)

    def test_tall_preserved_formula_bbox_does_not_shrink_nearby_prose(self):
        with tempfile.TemporaryDirectory(prefix="quilo-pdf-tight-formula-obstacle-") as tmp:
            source = Path(tmp) / "source.pdf"
            output = Path(tmp) / "output.pdf"
            doc = fitz.open()
            page = doc.new_page(width=504, height=720)
            page.insert_textbox(
                fitz.Rect(274, 300, 454, 350),
                "A preceding right-column paragraph proves the full column width.",
                fontsize=10,
                fontname="helv",
            )
            page.insert_text(
                fitz.Point(368, 383), "s = 2", fontsize=10, fontname="helv"
            )
            page.insert_text(
                fitz.Point(274, 406), "which gives s:", fontsize=10, fontname="helv"
            )
            doc.save(source)
            doc.close()

            extracted = subprocess.run(
                [sys.executable, str(MODULE_PATH), "extract", str(source)],
                check=True,
                capture_output=True,
                text=True,
            )
            meta = json.loads(extracted.stdout)
            ids = {block["text"]: str(block["id"]) for block in meta["blocks"]}
            intro_source = next(text for text in ids if text.startswith("which gives"))
            body_source = next(
                text for text in ids if text.startswith("A preceding right-column")
            )
            self.assertFalse(any("s = 2" in text for text in ids))

            real_iter_text_blocks = translate_pdf.iter_text_blocks

            def iter_with_tall_formula_bbox(*args, **kwargs):
                for bid, pno, original in real_iter_text_blocks(*args, **kwargs):
                    candidate = copy.deepcopy(original)
                    text = translate_pdf.block_text(candidate, tag=True)
                    if text == "s = 2":
                        inflated = fitz.Rect(368.0, 368.0, 389.0, 407.0)
                        candidate["bbox"] = tuple(inflated)
                        for text_line in candidate.get("lines", []):
                            text_line["bbox"] = tuple(inflated)
                            for item in text_line.get("spans", []):
                                source_span = fitz.Rect(item["bbox"])
                                item["bbox"] = (
                                    source_span.x0,
                                    inflated.y0,
                                    source_span.x1,
                                    inflated.y1,
                                )
                    elif text.startswith("which gives"):
                        prose_rect = fitz.Rect(
                            274.004, 395.585, 435.751, 406.908
                        )
                        candidate["bbox"] = tuple(prose_rect)
                        for text_line in candidate.get("lines", []):
                            text_line["bbox"] = tuple(prose_rect)
                    yield bid, pno, candidate

            payload = {
                "translations": {
                    ids[body_source]: "앞 문단은 오른쪽 열 전체의 사용 가능한 폭을 증명한다.",
                    ids[intro_source]: "이로부터 s에 대한 미분방정식이 얻어진다.",
                }
            }
            rendered_response = []
            with (
                mock.patch.object(
                    translate_pdf, "iter_text_blocks", iter_with_tall_formula_bbox
                ),
                mock.patch.object(
                    sys,
                    "stdin",
                    io.StringIO(json.dumps(payload, ensure_ascii=False)),
                ),
                mock.patch.object(
                    translate_pdf,
                    "write_json_response",
                    side_effect=rendered_response.append,
                ),
            ):
                translate_pdf.cmd_render(
                    str(source),
                    str(output),
                    str(ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"),
                )
            self.assertEqual(len(rendered_response), 1)
            stats = rendered_response[0]
            self.assertTrue(stats["ok"], stats)
            intro_size = next(
                item["rendered"]
                for item in stats["font_sizes"]
                if str(item["id"]) == ids[intro_source]
            )
            self.assertEqual(intro_size, 10.0)

            with fitz.open(source) as source_doc, fitz.open(output) as output_doc:
                formula_rect = fitz.Rect(364, 369, 393, 387)
                source_formula = source_doc[0].get_pixmap(
                    matrix=fitz.Matrix(3, 3), clip=formula_rect, alpha=False
                )
                output_formula = output_doc[0].get_pixmap(
                    matrix=fitz.Matrix(3, 3), clip=formula_rect, alpha=False
                )
                self.assertEqual(source_formula.samples, output_formula.samples)

    def test_lowercase_page_tail_uses_blank_gap_above_preserved_formula(self):
        with tempfile.TemporaryDirectory(prefix="quilo-pdf-page-tail-") as tmp:
            source = Path(tmp) / "source.pdf"
            output = Path(tmp) / "output.pdf"
            doc = fitz.open()
            page = doc.new_page(width=504, height=720)
            figure_rect = fitz.Rect(52, 142, 246, 394)
            page.draw_rect(
                figure_rect,
                color=(0, 0, 0),
                fill=(0.91, 0.91, 0.91),
            )
            for offset in range(20, 190, 24):
                page.draw_line(
                    fitz.Point(figure_rect.x0 + offset, figure_rect.y0),
                    fitz.Point(figure_rect.x0 + offset, figure_rect.y1),
                    color=(0.3, 0.3, 0.3),
                    width=0.5,
                )
            page.insert_textbox(
                fitz.Rect(51, 404, 247, 434),
                "Fig. 1.1 A caption occupying the band directly above the prose tail.",
                fontsize=8.5,
                fontname="helv",
            )
            tail_source = (
                "horizon to the zenith. The parallax of the Moon, for example, "
                "is about 57', and that of the Sun"
            )
            page.insert_textbox(
                fitz.Rect(51, 452, 247, 484),
                tail_source,
                fontsize=10,
                fontname="tiro",
            )
            page.insert_text(
                fitz.Point(51, 488),
                'p = 8.79"',
                fontsize=10,
                fontname="helv",
            )
            doc.save(source)
            doc.close()

            extracted = subprocess.run(
                [sys.executable, str(MODULE_PATH), "extract", str(source)],
                check=True,
                capture_output=True,
                text=True,
            )
            meta = json.loads(extracted.stdout)
            tail = next(
                block for block in meta["blocks"]
                if block["text"].startswith("horizon to the zenith")
            )
            self.assertFalse(
                any(block["text"].startswith("p = 8.79") for block in meta["blocks"])
            )
            target = (
                "지평선에서 천정까지 움직이는 것을 관측할 때 배경별에 대해 보이는 "
                "물체의 겉보기 이동량과 같다. 예를 들어 달의 시차는 약 57′이고, "
                "태양의 시차는"
            )
            rendered = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "render",
                    str(source),
                    str(output),
                    str(ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"),
                ],
                input=json.dumps(
                    {"translations": {str(tail["id"]): target}}, ensure_ascii=False
                ),
                check=True,
                capture_output=True,
                text=True,
            )
            stats = json.loads(rendered.stdout)
            self.assertTrue(stats["ok"], stats)
            size = next(
                item["rendered"]
                for item in stats["font_sizes"]
                if str(item["id"]) == str(tail["id"])
            )
            self.assertGreaterEqual(size, 8.0)

            with fitz.open(source) as source_doc, fitz.open(output) as output_doc:
                source_figure = source_doc[0].get_pixmap(
                    matrix=fitz.Matrix(2, 2), clip=figure_rect, alpha=False
                )
                output_figure = output_doc[0].get_pixmap(
                    matrix=fitz.Matrix(2, 2), clip=figure_rect, alpha=False
                )
                self.assertEqual(source_figure.samples, output_figure.samples)
                source_formula_rect = source_doc[0].search_for("8.79")[0]
                output_formula_rect = output_doc[0].search_for("8.79")[0]
                for actual, expected in zip(output_formula_rect, source_formula_rect):
                    self.assertAlmostEqual(actual, expected, places=3)
                korean_rects = []
                for block in output_doc[0].get_text("dict")["blocks"]:
                    for line in block.get("lines", []):
                        value = "".join(
                            span.get("text", "") for span in line.get("spans", [])
                        )
                        if any("가" <= char <= "힣" for char in value):
                            korean_rects.append(fitz.Rect(line["bbox"]))
                self.assertTrue(korean_rects)
                formula_top = output_formula_rect.y0
                self.assertLess(max(rect.y1 for rect in korean_rects), formula_top)

    def test_complete_or_uppercase_text_is_not_treated_as_page_tail(self):
        items = [
            (
                fitz.Rect(51, 452, 247, 477),
                "번역문은 충분히 길지만 위로 옮겨서는 안 된다.",
                10,
                0,
                False,
                False,
                7,
            )
        ]
        formula = [fitz.Rect(51, 475, 95, 490)]
        unchanged = translate_pdf._expand_lowercase_formula_tails_upward(
            items,
            [],
            [],
            formula,
            {7: "Horizon to zenith is a complete standalone sentence."},
            fitz.Rect(0, 0, 504, 720),
            self.font,
        )
        self.assertEqual(unchanged[0][0], items[0][0])

    def test_complete_lowercase_tail_after_nearby_hyphen_uses_safe_gap(self):
        original = fitz.Rect(258, 371.5, 454, 397.0)
        items = [
            (
                original,
                (
                    "전치 증폭기에서 전류가 더욱 증폭된다. 광전자증배관을 "
                    "구동하려면 1000–1500 volts의 전압이 필요하다."
                ),
                10,
                0,
                False,
                False,
                421,
            )
        ]
        source = {
            419: "The outcoming current is intensified fur-",
            420: "Fig. 3.24 The principle of a photoelectric photometer.",
            421: (
                "ther in a preamplifier. The photomultiplier needs a voltage "
                "of 1000–1500 volts."
            ),
        }

        expanded = translate_pdf._expand_lowercase_formula_tails_upward(
            items,
            [fitz.Rect(258, 330, 454, 352)],
            [],
            [],
            source,
            fitz.Rect(0, 0, 504, 720),
            self.font,
        )

        self.assertLess(expanded[0][0].y0, original.y0)
        self.assertEqual(expanded[0][0].y1, original.y1)

    def test_complete_lowercase_tail_without_hyphen_predecessor_stays_put(self):
        items = [
            (
                fitz.Rect(258, 371.5, 454, 397.0),
                "완결된 일반 문단은 위쪽 빈 공간으로 이동하지 않는다.",
                10,
                0,
                False,
                False,
                421,
            )
        ]
        unchanged = translate_pdf._expand_lowercase_formula_tails_upward(
            items,
            [],
            [],
            [fitz.Rect(258, 395.0, 360, 410.0)],
            {419: "A complete preceding paragraph.", 421: "this is complete."},
            fitz.Rect(0, 0, 504, 720),
            self.font,
        )

        self.assertEqual(unchanged[0][0], items[0][0])

    def test_run_in_at_formula_extracts_as_one_block_and_renders_at_ten_points(self):
        with tempfile.TemporaryDirectory(prefix="quilo-pdf-run-in-at-") as directory:
            source = Path(directory) / "source.pdf"
            output = Path(directory) / "output.pdf"
            document = fitz.open()
            page = document.new_page(width=360, height=180)
            source_font = ROOT / "lib" / "fonts" / "STIXTwoMath.otf"
            page.insert_font(fontname="source", fontfile=str(source_font))
            page.insert_textbox(
                fitz.Rect(35, 45, 325, 105),
                "at r=R⊙/2)\nUsing the preceding equation, the result follows.",
                fontsize=10,
                fontname="source",
            )
            document.save(source)
            document.close()

            extracted = subprocess.run(
                [sys.executable, str(MODULE_PATH), "extract", str(source)],
                check=True,
                capture_output=True,
                text=True,
            )
            meta = json.loads(extracted.stdout)
            self.assertEqual(len(meta["blocks"]), 1, meta)
            extracted_text = meta["blocks"][0]["text"].replace("\xa0", " ")
            self.assertIn("at r=R⊙/2)", extracted_text)
            self.assertIn("Using the preceding equation", extracted_text)
            block_id = str(meta["blocks"][0]["id"])

            rendered = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "render",
                    str(source),
                    str(output),
                    str(ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"),
                ],
                input=json.dumps(
                    {
                        "translations": {
                            block_id: "r=R⊙/2에서 앞의 방정식을 사용하면 다음 결과를 얻는다."
                        }
                    },
                    ensure_ascii=False,
                ),
                check=True,
                capture_output=True,
                text=True,
            )
            stats = json.loads(rendered.stdout)
            self.assertTrue(stats["ok"], stats)
            rendered_size = next(
                item["rendered"]
                for item in stats["font_sizes"]
                if str(item["id"]) == block_id
            )
            self.assertEqual(rendered_size, 10.0)
            with fitz.open(output) as rendered_doc:
                output_text = rendered_doc[0].get_text()
            self.assertNotIn("Using", output_text)
            self.assertNotIn("preceding equation", output_text)

    def test_real_short_prose_fragments_translate_without_english_replay(self):
        with tempfile.TemporaryDirectory(prefix="quilo-pdf-short-prose-fragments-") as directory:
            source = Path(directory) / "source.pdf"
            output = Path(directory) / "output.pdf"
            source_font = ROOT / "lib" / "fonts" / "STIXTwoMath.otf"
            fixtures = (
                ("by Sν:", "스펙트럼 세기로부터:"),
                ("0.577. Us-", "0.577이며 다음 문장으로 이어진다."),
                ("in 1054. (c) -7.4.", "1054년에 다 항목의 값은 -7.4였다."),
                ("be m=0.577 + as.", "질량은 주어진 관계를 만족해야 한다."),
            )
            document = fitz.open()
            for source_text, _target in fixtures:
                page = document.new_page(width=320, height=160)
                page.insert_font(fontname="source", fontfile=str(source_font))
                page.insert_text(
                    fitz.Point(35, 75),
                    source_text,
                    fontsize=10,
                    fontname="source",
                )
            document.save(source)
            document.close()

            extracted = subprocess.run(
                [sys.executable, str(MODULE_PATH), "extract", str(source)],
                check=True,
                capture_output=True,
                text=True,
            )
            meta = json.loads(extracted.stdout)
            self.assertEqual(len(meta["blocks"]), 4, meta)
            by_page = {int(item["page"]): item for item in meta["blocks"]}
            self.assertEqual(set(by_page), set(range(4)))
            translations = {
                str(by_page[page_number]["id"]): target
                for page_number, (_source_text, target) in enumerate(fixtures)
            }

            rendered = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "render",
                    str(source),
                    str(output),
                    str(ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"),
                ],
                input=json.dumps(
                    {"translations": translations}, ensure_ascii=False
                ),
                check=True,
                capture_output=True,
                text=True,
            )
            stats = json.loads(rendered.stdout)
            self.assertTrue(stats["ok"], stats)
            self.assertEqual(stats["expected"], 4)
            self.assertEqual(stats["completed"], 4)
            self.assertEqual(stats["preserved_original"], 0)

            with fitz.open(output) as rendered_doc:
                rendered_pages = [page.get_text() for page in rendered_doc]
            replay_tokens = (
                ("by", "Sν"),
                ("Us",),
                ("in 1054", "(c)"),
                ("be", "as"),
            )
            for page_number, tokens in enumerate(replay_tokens):
                with self.subTest(page=page_number + 1):
                    for token in tokens:
                        self.assertNotIn(token, rendered_pages[page_number])

    def test_uppercase_variable_function_formula_keeps_original_pixels(self):
        with tempfile.TemporaryDirectory(prefix="quilo-pdf-uppercase-formula-") as directory:
            source = Path(directory) / "source.pdf"
            output = Path(directory) / "output.pdf"
            document = fitz.open()
            page = document.new_page(width=300, height=160)
            page.insert_text(
                fitz.Point(35, 75),
                "Asin x + Xcos y + Dcosh z = 0",
                fontsize=11,
                fontname="helv",
            )
            document.save(source)
            document.close()

            extracted = subprocess.run(
                [sys.executable, str(MODULE_PATH), "extract", str(source)],
                check=True,
                capture_output=True,
                text=True,
            )
            meta = json.loads(extracted.stdout)
            self.assertEqual(meta["blocks"], [], meta)
            rendered = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "render",
                    str(source),
                    str(output),
                    str(ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"),
                ],
                input=json.dumps({"translations": {}}, ensure_ascii=False),
                check=True,
                capture_output=True,
                text=True,
            )
            stats = json.loads(rendered.stdout)
            self.assertTrue(stats["ok"], stats)
            with fitz.open(source) as source_doc, fitz.open(output) as output_doc:
                self.assertEqual(
                    source_doc[0].get_pixmap(alpha=False).samples,
                    output_doc[0].get_pixmap(alpha=False).samples,
                )

    def test_formula_only_block_is_excluded_and_keeps_original_glyph_stream(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "formula-source.pdf"
            output = Path(directory) / "formula-output.pdf"
            document = fitz.open()
            page = document.new_page(width=300, height=160)
            page.insert_text(
                fitz.Point(35, 75),
                "sinB sina = sinAsinb",
                fontsize=11,
                fontname="helv",
            )
            document.save(source)
            document.close()

            extracted = subprocess.run(
                [sys.executable, str(MODULE_PATH), "extract", str(source)],
                check=True,
                capture_output=True,
                text=True,
            )
            meta = json.loads(extracted.stdout)
            self.assertEqual(meta["blocks"], [], meta)
            payload = json.dumps({"translations": {}}, ensure_ascii=False)
            rendered = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "render",
                    str(source),
                    str(output),
                    str(ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"),
                ],
                input=payload,
                check=True,
                capture_output=True,
                text=True,
            )
            stats = json.loads(rendered.stdout)

            self.assertTrue(stats["ok"], stats)
            self.assertEqual(stats["expected"], 0)
            self.assertEqual(stats["completed"], 0)
            self.assertEqual(stats["replaced"], 0)
            self.assertEqual(stats["drawn"], 0)
            self.assertEqual(stats["page_expected"], 0)
            self.assertEqual(stats["page_drawn"], 0)
            self.assertEqual(stats["font_expected"], 0)
            self.assertEqual(stats["preserved_original"], 0)
            self.assertEqual(stats["preserved_original_ids"], [])
            with fitz.open(source) as source_doc, fitz.open(output) as output_doc:
                source_pixels = source_doc[0].get_pixmap(alpha=False).samples
                output_pixels = output_doc[0].get_pixmap(alpha=False).samples
                self.assertEqual(source_pixels, output_pixels)

    def test_mixed_prose_and_display_formula_lines_are_split_all_or_nothing(self):
        def line(text, y0, y1, font="Helvetica"):
            return {
                "bbox": (30, y0, 250, y1),
                "spans": [
                    {
                        "text": text,
                        "font": font,
                        "size": 10,
                        "bbox": (30, y0, 250, y1),
                    },
                ],
            }

        block = {
            "type": 0,
            "bbox": (30, 20, 250, 90),
            "lines": [
                line("Substitution gives", 20, 32),
                line("sin a / sin A = sin b / sin B", 42, 54, "MathTime"),
                line("(2.8)", 43, 55),
                line("The following limit is useful.", 70, 82),
            ],
        }

        segments = translate_pdf._split_mixed_display_formula_lines(block)
        self.assertEqual(len(segments), 3)
        self.assertFalse(segments[0].get("_preserve_formula", False))
        self.assertTrue(segments[1].get("_preserve_formula", False))
        self.assertFalse(segments[2].get("_preserve_formula", False))
        self.assertEqual(len(segments[1]["lines"]), 2)
        self.assertTrue(translate_pdf._keep_original_block(segments[1]))

    def test_formula_only_caption_tail_stays_with_caption(self):
        def line(text, y0, y1, font="Helvetica"):
            return {
                "bbox": (258, y0, 454, y1),
                "spans": [
                    {
                        "text": text,
                        "font": font,
                        "size": 8.5,
                        "bbox": (258, y0, 454, y1),
                    },
                ],
            }

        block = {
            "type": 0,
            "bbox": (258, 208, 454, 239),
            "lines": [
                line("Fig. 2.5 The coordinates of point P in the rotated", 208, 219),
                line("frame are x' = x, y' = y cos x + z sin x, z' = z cos x -", 219, 230),
                line("y sin x", 229, 239, "MathTime"),
            ],
        }

        segments = translate_pdf._split_mixed_display_formula_lines(block)

        self.assertEqual(len(segments), 1)
        self.assertFalse(segments[0].get("_preserve_formula", False))
        self.assertIn("y sin x", translate_pdf.block_text(segments[0]))

    def test_ocr_raster_planner_downscales_readable_wide_pages(self):
        plan = translate_pdf._plan_raster_page_tiles(4_000, 1_000, 1_400)

        self.assertAlmostEqual(plan["zoom"], 0.35, places=6)
        self.assertLessEqual(plan["width"], 1_400)
        self.assertLess(plan["predicted_pixels"], 1_000_000)

    def test_ocr_raster_planner_keeps_supported_long_page_tiling(self):
        plan = translate_pdf._plan_raster_page_tiles(958, 11_833, 1_400)

        self.assertGreater(len(plan["tiles"]), 1)
        self.assertEqual(plan["tiles"][0]["y0"], 0.0)
        self.assertEqual(plan["tiles"][-1]["y1"], 11_833)
        for previous, current in zip(plan["tiles"], plan["tiles"][1:]):
            self.assertEqual(previous["y1"], current["y0"])
        self.assertLessEqual(
            plan["predicted_pixels"],
            translate_pdf.RASTER_MAX_PAGE_PIXEL_AREA,
        )

    def test_ocr_rasterizer_emits_sealed_geometry_inputs_in_exact_order(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf_path = Path(directory) / "source.pdf"
            output_dir = Path(directory) / "tiles"
            document = fitz.open()
            document.new_page(width=600, height=3_000)
            rotated = document.new_page(width=200, height=100)
            rotated.set_rotation(90)
            document.save(pdf_path)
            document.close()

            stream = io.StringIO()
            with mock.patch.object(translate_pdf, "_JSON_STDOUT_FD", None):
                with redirect_stdout(stream):
                    translate_pdf.cmd_rasterize(
                        str(pdf_path),
                        str(output_dir),
                        target_width_px=600,
                        max_pages=2,
                    )
            result = json.loads(stream.getvalue())

            self.assertEqual(result["page_count"], 2)
            self.assertEqual(result["rendered_pages"], 2)
            self.assertEqual([page["index"] for page in result["pages"]], [0, 1])
            self.assertEqual(result["pages"][1]["rotation"], 90)
            self.assertEqual(result["pages"][1]["width"], 100.0)
            self.assertEqual(result["pages"][1]["height"], 200.0)
            flattened = []
            for page in result["pages"]:
                self.assertGreater(len(page["tiles"]), 0)
                covered_to = 0.0
                for position, tile in enumerate(page["tiles"]):
                    self.assertEqual(tile["index"], position)
                    self.assertEqual(tile["bbox"][0], 0.0)
                    self.assertEqual(tile["bbox"][1], covered_to)
                    self.assertEqual(tile["bbox"][2], page["width"])
                    covered_to = tile["bbox"][3]
                    self.assertTrue(Path(tile["file"]).is_file())
                    flattened.append(tile["file"])
                self.assertEqual(covered_to, page["height"])
            self.assertEqual(flattened, result["files"])

    def test_ocr_raster_planner_rejects_unsafe_geometry_before_pixmap(self):
        class FakeRect:
            width = 100_000
            height = 1_000
            x0 = 0
            y0 = 0
            x1 = 100_000
            y1 = 1_000

        class FakePage:
            rect = FakeRect()

            def __init__(self):
                self.get_pixmap_calls = 0

            def get_pixmap(self, **_kwargs):
                self.get_pixmap_calls += 1
                raise AssertionError("get_pixmap must not run for rejected geometry")

        class FakeDocument:
            def __init__(self, page):
                self.page = page
                self.closed = False

            def __len__(self):
                return 1

            def __getitem__(self, index):
                if index != 0:
                    raise IndexError(index)
                return self.page

            def close(self):
                self.closed = True

        page = FakePage()
        document = FakeDocument(page)
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(translate_pdf.fitz, "open", return_value=document):
                with self.assertRaisesRegex(ValueError, "unsafe OCR raster zoom"):
                    translate_pdf.cmd_rasterize(
                        "untrusted.pdf",
                        directory,
                        target_width_px=1_400,
                        max_pages=1,
                    )

        self.assertEqual(page.get_pixmap_calls, 0)
        self.assertTrue(document.closed)

    def test_background_sampler_rejects_unsafe_geometry_before_pixmap(self):
        class UnsafePage:
            rect = fitz.Rect(0, 0, 100_000, 1_000)

            def __init__(self):
                self.get_pixmap_calls = 0

            def get_pixmap(self, **_kwargs):
                self.get_pixmap_calls += 1
                raise AssertionError("unsafe full-page pixmap allocation")

        page = UnsafePage()
        with self.assertRaisesRegex(ValueError, "background sample"):
            translate_pdf._sample_pixmap(page)
        self.assertEqual(page.get_pixmap_calls, 0)

    def test_draw_rich_keeps_base_and_glyph_font_sizes_separate(self):
        state = translate_pdf._draw_rich(
            self.page,
            fitz.Rect(5, 5, 115, 35),
            "H<sub>2</sub>O",
            (0, 0, 0),
            self.font,
            10,
            fitz.TEXT_ALIGN_LEFT,
            max_x=115,
            max_y=35,
        )
        self.assertTrue(state["drawn"])
        self.assertTrue(state["complete"])
        self.assertEqual(state["min_font"], 10.0)
        self.assertEqual(state["min_glyph_font"], 6.6)

    def test_draw_rich_reports_layout_overflow(self):
        state = translate_pdf._draw_rich(
            self.page,
            fitz.Rect(5, 5, 25, 11),
            "H<sub>2</sub> overflow " * 100,
            (0, 0, 0),
            self.font,
            12,
            fitz.TEXT_ALIGN_LEFT,
            min_size=5,
            max_x=25,
            max_y=11,
        )
        self.assertTrue(state["drawn"])
        self.assertFalse(state["complete"])
        self.assertTrue(state["shrunk"])
        self.assertEqual(state["min_font"], 5.0)

    def test_draw_rich_reports_append_failure(self):
        class AppendFailWriter:
            def __init__(self, *_args, **_kwargs):
                pass

            def append(self, *_args, **_kwargs):
                raise RuntimeError("append failed")

            def write_text(self, *_args, **_kwargs):
                return None

        with mock.patch.object(translate_pdf.fitz, "TextWriter", AppendFailWriter):
            state = translate_pdf._draw_rich(
                self.page,
                fitz.Rect(5, 5, 115, 35),
                "H<sub>2</sub>O",
                (0, 0, 0),
                self.font,
                10,
                fitz.TEXT_ALIGN_LEFT,
            )
        self.assertFalse(state["drawn"])
        self.assertFalse(state["complete"])

    def test_draw_rich_reports_write_failure(self):
        class WriteFailWriter:
            def __init__(self, *_args, **_kwargs):
                pass

            def append(self, *_args, **_kwargs):
                return None

            def write_text(self, *_args, **_kwargs):
                raise RuntimeError("write failed")

        with mock.patch.object(translate_pdf.fitz, "TextWriter", WriteFailWriter):
            state = translate_pdf._draw_rich(
                self.page,
                fitz.Rect(5, 5, 115, 35),
                "H<sub>2</sub>O",
                (0, 0, 0),
                self.font,
                10,
                fitz.TEXT_ALIGN_LEFT,
            )
        self.assertFalse(state["drawn"])
        self.assertFalse(state["complete"])

    def test_render_command_reports_overflow_block_ids(self):
        with tempfile.TemporaryDirectory(prefix="quilo-pdf-render-test-") as tmp:
            source = Path(tmp) / "source.pdf"
            output = Path(tmp) / "output.pdf"
            doc = fitz.open()
            page = doc.new_page(width=200, height=120)
            page.insert_textbox(
                fitz.Rect(10, 10, 190, 50),
                "English paragraph for translation completeness testing.",
                fontsize=10,
                fontname="helv",
            )
            doc.save(source)
            doc.close()

            extracted = subprocess.run(
                [sys.executable, str(MODULE_PATH), "extract", str(source)],
                check=True,
                capture_output=True,
                text=True,
            )
            meta = json.loads(extracted.stdout)
            self.assertEqual(len(meta["blocks"]), 1)
            block_id = str(meta["blocks"][0]["id"])
            payload = json.dumps(
                {"translations": {block_id: "아주 긴 번역문 " * 200}},
                ensure_ascii=False,
            )
            rendered = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "render",
                    str(source),
                    str(output),
                    str(ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"),
                ],
                input=payload,
                check=True,
                capture_output=True,
                text=True,
            )
            stats = json.loads(rendered.stdout)
            self.assertFalse(stats["ok"])
            self.assertEqual(stats["overflow"], 1)
            self.assertEqual([str(v) for v in stats["overflow_ids"]], [block_id])
            self.assertEqual(stats["failed"], 0)
            self.assertEqual(stats["min_font"], 4.0)
            self.assertEqual(len(stats["font_sizes"]), 1)
            self.assertEqual(str(stats["font_sizes"][0]["id"]), block_id)
            self.assertEqual(stats["font_sizes"][0]["source"], 10.0)
            self.assertEqual(stats["font_sizes"][0]["rendered"], 4.0)
            self.assertTrue(output.exists())

            complete_output = Path(tmp) / "complete-output.pdf"
            complete_payload = json.dumps(
                {"translations": {block_id: "완전한 번역 문장입니다."}},
                ensure_ascii=False,
            )
            complete_render = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "render",
                    str(source),
                    str(complete_output),
                    str(ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"),
                ],
                input=complete_payload,
                check=True,
                capture_output=True,
                text=True,
            )
            complete_stats = json.loads(complete_render.stdout)
            self.assertTrue(complete_stats["ok"])
            self.assertEqual(complete_stats["replaced"], 1)
            self.assertEqual(complete_stats["overflow"], 0)
            self.assertEqual(complete_stats["failed"], 0)
            self.assertGreaterEqual(complete_stats["min_font"], 6.0)
            self.assertEqual(len(complete_stats["font_sizes"]), 1)
            self.assertEqual(str(complete_stats["font_sizes"][0]["id"]), block_id)


class ParagraphCoalescingTest(unittest.TestCase):
    @staticmethod
    def block(text, y0):
        bbox = (40, y0, 240, y0 + 10)
        return {
            "type": 0,
            "bbox": bbox,
            "lines": [
                {
                    "bbox": bbox,
                    "spans": [
                        {
                            "text": text,
                            "bbox": bbox,
                            "size": 9,
                            "font": "Times-Roman",
                            "flags": 0,
                            "color": 0,
                        }
                    ],
                }
            ],
        }

    def test_numbered_running_heading_does_not_absorb_lowercase_body_prose(self):
        heading = self.block("2.5The Equatorial System", 10)
        prose = self.block(
            "are the poles corresponding to the horizon and continue the prior sentence.",
            23,
        )

        merged = translate_pdf._coalesce_paragraphs([heading, prose])

        self.assertEqual(len(merged), 2)
        self.assertEqual(translate_pdf._block_raw_text(merged[0]), "2.5The Equatorial System")
        self.assertTrue(translate_pdf._block_raw_text(merged[1]).startswith("are the poles"))

    def test_ordinary_short_midsentence_prose_still_coalesces(self):
        first = self.block("The two points", 10)
        second = self.block(
            "are the poles corresponding to the horizon and complete the sentence.",
            23,
        )

        merged = translate_pdf._coalesce_paragraphs([first, second])

        self.assertEqual(len(merged), 1)
        self.assertEqual(len(merged[0]["lines"]), 2)


if __name__ == "__main__":
    unittest.main()
