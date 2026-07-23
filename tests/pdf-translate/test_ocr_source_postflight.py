"""Canonical OCR source-of-truth regressions for strict PDF postflight."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import unicodedata

import fitz
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[2]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


VERIFY = load_module("verify_translation_ocr_source", ROOT / "scripts" / "verify_translation.py")
FIXTURES = load_module(
    "generate_pdf_translation_fixtures_ocr_source",
    ROOT / "tests" / "pdf-translate" / "generate_fixtures.py",
)
FIXTURES.register_fonts()

OCR_TEXT = (
    "This calibration record explains the measured mass 12.50 kg at 298.15 K. "
    "Formula H2O. Reference https://example.test/run/7."
)
GOOD_TARGET = (
    "이 교정 기록은 측정 질량 12.50 kg과 온도 298.15 K를 설명합니다. "
    "화학식 H2O. 참조 https://example.test/run/7."
)
UNRELATED_TARGET = (
    "이 문서는 전혀 다른 행사 일정과 참석 방법을 안내합니다. "
    "12.50 kg, 298.15 K, H2O, https://example.test/run/7."
)


def sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_review_text(value: str) -> str:
    return "\n".join(
        line.rstrip(" \t")
        for line in unicodedata.normalize("NFC", value)
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .split("\n")
    ).strip()


class OcrSourcePostflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "scan.pdf"
        FIXTURES.generate_scan_only(self.source)

    def tearDown(self):
        self.temp.cleanup()

    def make_output(self, name: str, text: str) -> Path:
        path = self.root / name
        c = canvas.Canvas(str(path), pagesize=A4, pageCompression=1, invariant=1)
        c.setTitle("검증된 OCR 번역")
        c.setFont(FIXTURES.FONT_REGULAR, 11)
        y = A4[1] - 90
        for line in text.split("\n"):
            c.drawString(54, y, line)
            y -= 22
        c.showPage()
        c.save()
        return path

    def make_output_with_code(self, name: str, prose: str, code: str) -> Path:
        path = self.root / name
        c = canvas.Canvas(str(path), pagesize=A4, pageCompression=1, invariant=1)
        c.setTitle("검증된 OCR 번역")
        c.setFont(FIXTURES.FONT_REGULAR, 11)
        c.drawString(54, A4[1] - 90, prose)
        c.setFont("Courier", 9)
        c.drawString(54, A4[1] - 120, code)
        c.showPage()
        c.save()
        return path

    def output_text(self, path: Path) -> str:
        with fitz.open(path) as document:
            return canonical_review_text(document[0].get_text("text") or "")

    def bundle(
        self,
        output: Path,
        *,
        review: bool,
        visual_review: bool = False,
    ) -> Path:
        source_digest = sha_bytes(self.source.read_bytes())
        segment_id = f"seg-{source_digest[:12]}-p0001-o0001"
        source_sha = hashlib.sha256(b"canonical provenance source").hexdigest()
        target_sha = sha_bytes(self.output_text(output).encode("utf-8"))
        payload = {
            "schema_version": 1,
            "task": "ocr-postflight-source",
            "source_pdf_sha256": source_digest,
            "ocr_evidence_sha256": hashlib.sha256(b"strict OCR evidence").hexdigest(),
            "pages": [
                {
                    "page": 1,
                    "segment_id": segment_id,
                    "text": OCR_TEXT,
                    "text_sha256": sha_bytes(OCR_TEXT.encode("utf-8")),
                    "source_sha256": source_sha,
                    "requires_korean_translation": True,
                    "translatable_text": OCR_TEXT,
                    "translatable_text_sha256": sha_bytes(OCR_TEXT.encode("utf-8")),
                }
            ],
            "semantic_review": None,
        }
        if review:
            payload["semantic_review"] = {
                "schema_version": 1,
                "task": "ocr-retypeset-semantic-review",
                "evidence_sha256": hashlib.sha256(b"sealed evidence").hexdigest(),
                "review_binding_sha256": hashlib.sha256(b"review binding").hexdigest(),
                "output_pdf_sha256": sha_bytes(output.read_bytes()),
                "judge_input_digest": hashlib.sha256(b"exact judge request").hexdigest(),
                "translation_provider": "anthropic",
                "judge_provider": "openai",
                "judge_request_id": "independent-judge-request-1",
                "visual_review_sha256": hashlib.sha256(b"visual review").hexdigest(),
                "bindings": [
                    {
                        "page": 1,
                        "segment_id": segment_id,
                        "source_sha256": source_sha,
                        "target_sha256": target_sha,
                        "binding_sha256": hashlib.sha256(b"segment binding").hexdigest(),
                    }
                ],
            }
        if visual_review:
            payload["visual_review"] = {
                "schema_version": 1,
                "task": "ocr-retypeset-nontext-visual-review",
                "intent": "restore",
                "provider": "mistral",
                "model": "mock-restore-visual-judge",
                "request_id": "restore-visual-request-1",
                "generation_provider": "anthropic",
                "source_pdf_sha256": source_digest,
                "output_pdf_sha256": sha_bytes(output.read_bytes()),
                "ocr_evidence_sha256": payload["ocr_evidence_sha256"],
                "ocr_render_manifest_sha256": hashlib.sha256(
                    b"strict render manifest"
                ).hexdigest(),
                "input_digest": hashlib.sha256(
                    b"exact restore visual request"
                ).hexdigest(),
                "review_sha256": hashlib.sha256(
                    b"sealed restore visual review"
                ).hexdigest(),
            }
        path = self.root / f"{output.stem}-ocr-source.json"
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path

    def verify(self, output: Path, bundle: Path):
        return VERIFY.verify(
            str(output),
            str(self.source),
            mode="retypeset",
            intent="translate",
            ocr_source_path=str(bundle),
        )

    def test_correct_korean_retypeset_with_bound_independent_review_passes(self):
        output = self.make_output("good.pdf", GOOD_TARGET)
        report = self.verify(output, self.bundle(output, review=True))

        self.assertTrue(report["passed"], report)
        self.assertEqual(report["hard_failures"], [])
        for gate in (
            "content_coverage",
            "page_order",
            "semantic_correspondence",
            "untranslated_text",
            "number_preservation",
            "unit_preservation",
            "chemical_formula_preservation",
            "url_preservation",
            "image_preservation",
        ):
            self.assertEqual(report["gates"][gate]["status"], "pass", gate)
        self.assertEqual(
            report["gates"]["number_preservation"]["details"]["source_text_basis"],
            "canonical_ocr",
        )

    def test_missing_review_rejects_unrelated_korean_even_when_invariants_match(self):
        output = self.make_output("unrelated.pdf", UNRELATED_TARGET)
        report = self.verify(output, self.bundle(output, review=False))

        self.assertFalse(report["passed"])
        self.assertEqual(report["gates"]["semantic_correspondence"]["status"], "fail")
        self.assertEqual(report["gates"]["page_order"]["status"], "fail")
        self.assertEqual(report["gates"]["number_preservation"]["status"], "pass")

    def test_unchanged_image_scan_is_not_accepted_as_translation(self):
        bundle = self.bundle(self.make_output("binding-target.pdf", GOOD_TARGET), review=False)
        report = self.verify(self.source, bundle)

        self.assertFalse(report["passed"])
        self.assertEqual(report["gates"]["content_coverage"]["status"], "fail")
        self.assertEqual(report["gates"]["semantic_correspondence"]["status"], "fail")
        self.assertEqual(report["gates"]["number_preservation"]["status"], "fail")

    def test_wrong_number_fails_against_ocr_even_with_output_bound_review(self):
        output = self.make_output("wrong-number.pdf", GOOD_TARGET.replace("12.50", "99.99"))
        report = self.verify(output, self.bundle(output, review=True))

        self.assertFalse(report["passed"])
        self.assertEqual(report["gates"]["semantic_correspondence"]["status"], "pass")
        self.assertEqual(report["gates"]["number_preservation"]["status"], "fail")
        self.assertIn("12.50", report["gates"]["number_preservation"]["details"]["missing"])
        self.assertIn("99.99", report["gates"]["number_preservation"]["details"]["unexpected"])

    def test_short_english_transcription_fails_ocr_target_language_policy(self):
        output = self.make_output(
            "english-transcription.pdf",
            "This source stays English. It has short sentences. Nothing is translated. "
            "Values: 12.50 kg, 298.15 K, H2O, https://example.test/run/7.",
        )
        report = self.verify(output, self.bundle(output, review=True))

        self.assertFalse(report["passed"])
        self.assertEqual(report["gates"]["semantic_correspondence"]["status"], "pass")
        self.assertEqual(report["gates"]["untranslated_text"]["status"], "fail")
        self.assertTrue(
            any(
                "canonical OCR source" in finding["detail"]
                for finding in report["gates"]["untranslated_text"]["details"]["findings"]
            )
        )

    def test_untranslated_source_plus_four_korean_characters_cannot_bypass_policy(self):
        output = self.make_output(
            "english-plus-korean-token.pdf",
            f"{OCR_TEXT} 번역완료",
        )
        report = self.verify(output, self.bundle(output, review=True))

        self.assertFalse(report["passed"])
        self.assertEqual(report["gates"]["semantic_correspondence"]["status"], "pass")
        self.assertEqual(report["gates"]["untranslated_text"]["status"], "fail")
        self.assertTrue(
            any(
                "retained-word ratio" in finding["detail"]
                for finding in report["gates"]["untranslated_text"]["details"]["findings"]
            )
        )

    def test_verbatim_monospace_code_does_not_count_as_untranslated_prose(self):
        output = self.make_output_with_code(
            "korean-with-code.pdf",
            GOOD_TARGET,
            "This calibration record explains the measured mass",
        )
        report = self.verify(output, self.bundle(output, review=True))

        self.assertTrue(report["passed"], report)
        self.assertEqual(report["gates"]["untranslated_text"]["status"], "pass")

    def test_four_word_parenthetical_gloss_is_allowed(self):
        issues = VERIFY.scan_page_text(
            "어텐션(scaled dot product attention)은 입력 표현을 계산한다."
        )
        self.assertFalse(any(kind == "untranslated" for kind, _ in issues), issues)

    def test_scan_restore_passes_with_output_bound_visual_review(self):
        restored = (
            "This calibration record explains the measured mass 12.50 kg at 298.15 K.\n"
            "Formula H2O. Reference https://example.test/run/7."
        )
        output = self.make_output("restore-good.pdf", restored)
        report = VERIFY.verify(
            str(output),
            str(self.source),
            mode="retypeset",
            intent="restore",
            ocr_source_path=str(
                self.bundle(output, review=False, visual_review=True)
            ),
        )

        self.assertTrue(report["passed"], report)
        self.assertEqual(report["gates"]["semantic_correspondence"]["status"], "skip")
        self.assertEqual(report["gates"]["text_preservation"]["status"], "pass")
        self.assertEqual(report["gates"]["image_preservation"]["status"], "pass")

    def test_scan_restore_visual_review_does_not_hide_missing_or_added_text(self):
        for name, text in (
            (
                "missing",
                "This calibration record explains the measured mass 12.50 kg at 298.15 K.",
            ),
            (
                "added",
                OCR_TEXT + " Unsupported additional paragraph with invented meaning.",
            ),
        ):
            with self.subTest(name=name):
                output = self.make_output(f"restore-{name}.pdf", text)
                report = VERIFY.verify(
                    str(output),
                    str(self.source),
                    mode="retypeset",
                    intent="restore",
                    ocr_source_path=str(
                        self.bundle(output, review=False, visual_review=True)
                    ),
                )
                self.assertFalse(report["passed"])
                self.assertEqual(
                    report["gates"]["text_preservation"]["status"],
                    "fail",
                )


if __name__ == "__main__":
    unittest.main()
