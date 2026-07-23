#!/usr/bin/env python3
"""XMP/Info translation binding and provenance regressions."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import fitz
from lxml import etree


ROOT = Path(__file__).resolve().parents[2]
TRANSLATOR = ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"
FONT = ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"
VERIFY_SPEC = importlib.util.spec_from_file_location(
    "verify_translation_for_xmp_test", ROOT / "scripts" / "verify_translation.py"
)
VERIFY = importlib.util.module_from_spec(VERIFY_SPEC)
assert VERIFY_SPEC.loader is not None
VERIFY_SPEC.loader.exec_module(VERIFY)

RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
DC = "http://purl.org/dc/elements/1.1/"
PDF = "http://ns.adobe.com/pdf/1.3/"
XML = "http://www.w3.org/XML/1998/namespace"
NS = {"rdf": RDF, "dc": DC, "pdf": PDF, "custom": "urn:quilo:custom"}


def xmp_packet(body: str) -> str:
    return (
        '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        f'<rdf:RDF xmlns:rdf="{RDF}" xmlns:dc="{DC}" '
        f'xmlns:pdf="{PDF}" xmlns:custom="urn:quilo:custom">'
        f"{body}</rdf:RDF></x:xmpmeta>"
        '<?xpacket end="w"?>'
    )


def run_translator(command: str, *args, payload=None, check=True):
    process = subprocess.run(
        [sys.executable, str(TRANSLATOR), command, *(str(arg) for arg in args)],
        input=json.dumps(payload, ensure_ascii=False) if payload is not None else None,
        text=True,
        capture_output=True,
        check=False,
    )
    if not check:
        return process
    if process.returncode:
        raise AssertionError(
            f"translate_pdf.py {command} failed ({process.returncode})\n"
            f"stdout: {process.stdout}\nstderr: {process.stderr}"
        )
    return json.loads(process.stdout)


def make_pdf(path: Path, *, metadata=None, xmp=None, pages=1, encrypted=False):
    document = fitz.open()
    for _ in range(pages):
        document.new_page(width=320, height=240)
    if metadata is not None:
        document.set_metadata(metadata)
    if xmp is not None:
        document.set_xml_metadata(xmp)
    save_options = {"garbage": 3, "deflate": True}
    if encrypted:
        save_options.update(
            {
                "encryption": fitz.PDF_ENCRYPT_AES_256,
                "owner_pw": "owner-secret",
                "user_pw": "user-secret",
            }
        )
    document.save(path, **save_options)
    document.close()


def blocks_by_kind(extracted, kind):
    return [block for block in extracted["blocks"] if block.get("kind") == kind]


def translations(extracted, replacements):
    values = {str(block["id"]): str(block["text"]) for block in extracted["blocks"]}
    values.update(replacements)
    return values


def parse_xmp(path: Path):
    with fitz.open(path) as document:
        raw = document.xref_stream(document.xref_xml_metadata())
    return etree.fromstring(raw)


def xpath_text(root, expression):
    return [str(item) for item in root.xpath(expression, namespaces=NS)]


class XmpMetadataTranslationTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="quilo-pdf-xmp-")
        self.root = Path(self.tempdir.name)

    def tearDown(self):
        self.tempdir.cleanup()

    def test_equal_info_and_xmp_values_share_one_translation_decision(self):
        source = self.root / "same.pdf"
        output = self.root / "same-ko.pdf"
        packet = xmp_packet(
            """<rdf:Description rdf:about="">
              <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Shared document title</rdf:li></rdf:Alt></dc:title>
              <dc:description><rdf:Alt><rdf:li xml:lang="x-default">Shared document subject</rdf:li></rdf:Alt></dc:description>
              <pdf:Keywords>translation regression keywords</pdf:Keywords>
              <custom:tracking custom:state="keep">opaque-42</custom:tracking>
            </rdf:Description>"""
        )
        make_pdf(
            source,
            metadata={
                "title": "Shared document title",
                "subject": "Shared document subject",
                "keywords": "translation regression keywords",
                "author": "Exact Author",
                "creator": "Exact Creator",
                "producer": "Exact Producer",
                "creationDate": "D:20260102030405+09'00'",
                "modDate": "D:20260710112233+09'00'",
            },
            xmp=packet,
        )
        extracted = run_translator("extract", source)
        metadata_blocks = blocks_by_kind(extracted, "metadata")
        self.assertEqual(
            [block["id"] for block in metadata_blocks],
            [
                "__pdf_metadata__:title",
                "__pdf_metadata__:subject",
                "__pdf_metadata__:keywords",
            ],
        )
        self.assertTrue(
            all(block["metadata_sources"] == ["info", "xmp"] for block in metadata_blocks)
        )
        replacements = {
            "__pdf_metadata__:title": "공유 문서 제목",
            "__pdf_metadata__:subject": "공유 문서 주제",
            "__pdf_metadata__:keywords": "번역 회귀 키워드",
        }
        stats = run_translator(
            "render",
            source,
            output,
            FONT,
            payload={"translations": translations(extracted, replacements)},
        )
        self.assertEqual(stats["metadata_replaced"], 3)
        root = parse_xmp(output)
        self.assertEqual(
            xpath_text(root, "//dc:title/rdf:Alt/rdf:li[@xml:lang='x-default']/text()"),
            ["공유 문서 제목"],
        )
        self.assertEqual(
            xpath_text(root, "//dc:title/rdf:Alt/rdf:li[@xml:lang='ko-KR']/text()"),
            ["공유 문서 제목"],
        )
        self.assertEqual(xpath_text(root, "//custom:tracking/text()"), ["opaque-42"])
        with fitz.open(source) as original, fitz.open(output) as translated:
            for field in ("author", "creator", "producer", "creationDate", "modDate"):
                self.assertEqual(translated.metadata[field], original.metadata[field])
            analysis = VERIFY._metadata_translation_analysis(
                original, translated, "translate", "inplace"
            )
        self.assertTrue(analysis["matched"], analysis)
        self.assertFalse(analysis["xmp"]["non_target_changed"])

    def test_different_info_and_xmp_values_get_deterministic_separate_blocks(self):
        source = self.root / "different.pdf"
        output = self.root / "different-ko.pdf"
        make_pdf(
            source,
            metadata={
                "title": "Info title words",
                "subject": "Info subject words",
                "keywords": "Info keyword words",
            },
            xmp=xmp_packet(
                """<rdf:Description rdf:about="">
                  <dc:title>XMP title words</dc:title>
                  <dc:description>XMP subject words</dc:description>
                  <pdf:Keywords>XMP keyword words</pdf:Keywords>
                </rdf:Description>"""
            ),
        )
        extracted = run_translator("extract", source)
        metadata_blocks = blocks_by_kind(extracted, "metadata")
        self.assertEqual(
            [block["id"] for block in metadata_blocks],
            [
                "__pdf_metadata__:title",
                "__pdf_metadata__:subject",
                "__pdf_metadata__:keywords",
                "__pdf_metadata__:title:xmp:0001",
                "__pdf_metadata__:subject:xmp:0001",
                "__pdf_metadata__:keywords:xmp:0001",
            ],
        )
        replacements = {
            block["id"]: f"번역-{index}"
            for index, block in enumerate(metadata_blocks, start=1)
        }
        run_translator(
            "render",
            source,
            output,
            FONT,
            payload={"translations": translations(extracted, replacements)},
        )
        with fitz.open(output) as document:
            self.assertEqual(document.metadata["title"], "번역-1")
            self.assertEqual(document.metadata["subject"], "번역-2")
            self.assertEqual(document.metadata["keywords"], "번역-3")
        root = parse_xmp(output)
        self.assertEqual(xpath_text(root, "//dc:title/text()"), ["번역-4"])
        self.assertEqual(xpath_text(root, "//dc:description/text()"), ["번역-5"])
        self.assertEqual(xpath_text(root, "//pdf:Keywords/text()"), ["번역-6"])

    def test_xmp_only_multilingual_alt_adds_or_replaces_korean_and_preserves_others(self):
        source = self.root / "multilingual.pdf"
        output = self.root / "multilingual-ko.pdf"
        make_pdf(
            source,
            xmp=xmp_packet(
                """<rdf:Description rdf:about="custom-id">
                  <dc:title><rdf:Alt>
                    <rdf:li xml:lang="x-default" custom:rank="primary">Reader priority title</rdf:li>
                    <rdf:li xml:lang="en-US">Reader priority title</rdf:li>
                    <rdf:li xml:lang="fr-FR">Titre français exact</rdf:li>
                    <rdf:li xml:lang="ko">오래된 제목</rdf:li>
                  </rdf:Alt></dc:title>
                  <dc:description><rdf:Alt>
                    <rdf:li xml:lang="en-US">English-only reader summary</rdf:li>
                  </rdf:Alt></dc:description>
                  <custom:rights custom:license="CC0">Preserve exactly</custom:rights>
                  <custom:identifier>urn:fixture:123</custom:identifier>
                </rdf:Description>"""
            ),
        )
        extracted = run_translator("extract", source)
        metadata_blocks = blocks_by_kind(extracted, "metadata")
        self.assertEqual(
            [block["id"] for block in metadata_blocks],
            ["__pdf_metadata__:title", "__pdf_metadata__:subject"],
        )
        run_translator(
            "render",
            source,
            output,
            FONT,
            payload={
                "translations": translations(
                    extracted,
                    {
                        "__pdf_metadata__:title": "리더 우선 제목",
                        "__pdf_metadata__:subject": "영어 전용 리더 요약",
                    },
                )
            },
        )
        root = parse_xmp(output)
        self.assertEqual(
            xpath_text(root, "//dc:title/rdf:Alt/rdf:li[@xml:lang='x-default']/text()"),
            ["리더 우선 제목"],
        )
        self.assertEqual(
            xpath_text(root, "//dc:title/rdf:Alt/rdf:li[@xml:lang='ko']/text()"),
            ["리더 우선 제목"],
        )
        self.assertEqual(
            xpath_text(root, "//dc:title/rdf:Alt/rdf:li[@xml:lang='en-US']/text()"),
            ["Reader priority title"],
        )
        self.assertEqual(
            xpath_text(root, "//dc:title/rdf:Alt/rdf:li[@xml:lang='fr-FR']/text()"),
            ["Titre français exact"],
        )
        self.assertEqual(
            xpath_text(
                root,
                "//dc:description/rdf:Alt/rdf:li[@xml:lang='x-default']/text()",
            ),
            ["영어 전용 리더 요약"],
        )
        self.assertEqual(
            xpath_text(
                root, "//dc:description/rdf:Alt/rdf:li[@xml:lang='ko-KR']/text()"
            ),
            ["영어 전용 리더 요약"],
        )
        self.assertEqual(
            xpath_text(
                root, "//dc:description/rdf:Alt/rdf:li[@xml:lang='en-US']/text()"
            ),
            ["English-only reader summary"],
        )
        self.assertEqual(
            xpath_text(root, "//dc:title/rdf:Alt/rdf:li[@xml:lang='x-default']/@custom:rank"),
            ["primary"],
        )
        self.assertEqual(xpath_text(root, "//custom:rights/@custom:license"), ["CC0"])
        self.assertEqual(xpath_text(root, "//custom:identifier/text()"), ["urn:fixture:123"])

    def test_xmp_keyword_bag_items_are_independent_stable_bindings(self):
        source = self.root / "bag.pdf"
        output = self.root / "bag-ko.pdf"
        make_pdf(
            source,
            xmp=xmp_packet(
                """<rdf:Description rdf:about="">
                  <dc:subject><rdf:Bag>
                    <rdf:li custom:rank="1">measurement ledger</rdf:li>
                    <rdf:li custom:rank="2">internal document link</rdf:li>
                    <rdf:li>PDF</rdf:li>
                  </rdf:Bag></dc:subject>
                </rdf:Description>"""
            ),
        )
        extracted = run_translator("extract", source)
        blocks = blocks_by_kind(extracted, "metadata")
        self.assertEqual(
            [block["id"] for block in blocks],
            ["__pdf_metadata__:keywords", "__pdf_metadata__:keywords:xmp:0001"],
        )
        run_translator(
            "render",
            source,
            output,
            FONT,
            payload={
                "translations": translations(
                    extracted,
                    {
                        blocks[0]["id"]: "측정 기록부",
                        blocks[1]["id"]: "내부 문서 링크",
                    },
                )
            },
        )
        root = parse_xmp(output)
        self.assertEqual(
            xpath_text(root, "//dc:subject/rdf:Bag/rdf:li/text()"),
            ["측정 기록부", "내부 문서 링크", "PDF"],
        )
        self.assertEqual(
            xpath_text(root, "//dc:subject/rdf:Bag/rdf:li/@custom:rank"), ["1", "2"]
        )
        with fitz.open(source) as original, fitz.open(output) as translated:
            analysis = VERIFY._metadata_translation_analysis(
                original, translated, "translate", "inplace"
            )
        self.assertTrue(analysis["matched"], analysis)

        tampered = self.root / "bag-tampered.pdf"
        with fitz.open(output) as document:
            document.set_xml_metadata(
                document.get_xml_metadata().replace(">PDF<", ">DOCX<")
            )
            document.save(tampered, garbage=3, deflate=True)
        with fitz.open(source) as original, fitz.open(tampered) as translated:
            analysis = VERIFY._metadata_translation_analysis(
                original, translated, "translate", "inplace"
            )
        self.assertFalse(analysis["matched"])
        self.assertEqual(len(analysis["xmp"]["preserved_target_changes"]), 1)

    def test_malformed_dtd_oversize_and_encrypted_xmp_fail_closed(self):
        cases = {
            "malformed": "<x:xmpmeta xmlns:x='adobe:ns:meta/'><broken>",
            "dtd": (
                '<!DOCTYPE x:xmpmeta [<!ENTITY injected "unsafe">]>'
                '<x:xmpmeta xmlns:x="adobe:ns:meta/"><value>&injected;</value></x:xmpmeta>'
            ),
            "oversize": xmp_packet(
                "<rdf:Description><custom:blob>"
                + ("x" * (4 * 1024 * 1024 + 64))
                + "</custom:blob></rdf:Description>"
            ),
        }
        for name, packet in cases.items():
            with self.subTest(name=name):
                source = self.root / f"{name}.pdf"
                make_pdf(source, xmp=packet)
                result = run_translator("extract", source, check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertRegex(
                    result.stderr,
                    r"malformed PDF XMP|forbidden DTD/entity|exceeds .* safety limit",
                )

        encrypted = self.root / "encrypted.pdf"
        make_pdf(
            encrypted,
            xmp=xmp_packet("<rdf:Description><dc:title>Encrypted title</dc:title></rdf:Description>"),
            encrypted=True,
        )
        result = run_translator("extract", encrypted, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(result.stdout.strip())

    def test_verifier_hard_fails_untranslated_reader_xmp_and_custom_node_drift(self):
        source = self.root / "verify-source.pdf"
        translated = self.root / "verify-ko.pdf"
        mutated = self.root / "verify-mutated.pdf"
        make_pdf(
            source,
            xmp=xmp_packet(
                """<rdf:Description rdf:about="">
                  <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Visible XMP title</rdf:li></rdf:Alt></dc:title>
                  <custom:tracking custom:state="stable">custom provenance</custom:tracking>
                </rdf:Description>"""
            ),
        )
        extracted = run_translator("extract", source)
        run_translator(
            "render",
            source,
            translated,
            FONT,
            payload={
                "translations": translations(
                    extracted, {"__pdf_metadata__:title": "표시되는 XMP 제목"}
                )
            },
        )
        with fitz.open(source) as original, fitz.open(translated) as output:
            good = VERIFY._metadata_translation_analysis(
                original, output, "translate", "inplace"
            )
        self.assertTrue(good["matched"], good)

        with fitz.open(translated) as document:
            xml = document.get_xml_metadata().replace(
                "custom provenance", "tampered provenance"
            )
            document.set_xml_metadata(xml)
            document.save(mutated, garbage=3, deflate=True)
        with fitz.open(source) as original, fitz.open(mutated) as output:
            bad = VERIFY._metadata_translation_analysis(
                original, output, "translate", "inplace"
            )
        self.assertFalse(bad["matched"])
        self.assertTrue(bad["xmp"]["non_target_changed"])
        report = VERIFY.verify(
            str(mutated), str(source), mode="inplace", intent="translate"
        )
        self.assertEqual(report["gates"]["page_correspondence"]["status"], "fail")
        self.assertIn("page_correspondence", report["hard_failures"])

        untranslated = self.root / "verify-untranslated.pdf"
        with fitz.open(source) as document:
            document.save(untranslated, garbage=3, deflate=True)
        with fitz.open(source) as original, fitz.open(untranslated) as output:
            bad = VERIFY._metadata_translation_analysis(
                original, output, "translate", "inplace"
            )
        self.assertFalse(bad["matched"])
        self.assertEqual(len(bad["xmp"]["untranslated_fields"]), 1)
        report = VERIFY.verify(
            str(untranslated), str(source), mode="inplace", intent="translate"
        )
        self.assertEqual(report["gates"]["page_correspondence"]["status"], "fail")
        metadata = report["gates"]["page_correspondence"]["details"]["metadata"]
        self.assertEqual(len(metadata["xmp"]["untranslated_fields"]), 1)

    def test_split_merge_applies_xmp_once_and_preserves_custom_nodes(self):
        source = self.root / "chunk-source.pdf"
        output = self.root / "chunk-output.pdf"
        chunks = self.root / "chunks"
        make_pdf(
            source,
            pages=3,
            xmp=xmp_packet(
                """<rdf:Description rdf:about="">
                  <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Chunk XMP title</rdf:li></rdf:Alt></dc:title>
                  <custom:identifier custom:scheme="urn">chunk-identity-7</custom:identifier>
                </rdf:Description>"""
            ),
        )
        split = run_translator("split", source, chunks, 2)
        self.assertEqual(
            [block["id"] for block in split["virtual_blocks"]],
            ["__pdf_metadata__:title"],
        )
        result = run_translator(
            "merge",
            output,
            *(item["path"] for item in split["chunks"]),
            payload={
                "source_pdf": str(source),
                "translations": {"__pdf_metadata__:title": "구간 XMP 제목"},
                "part_manifest": split["part_manifest"],
            },
        )
        self.assertEqual(result["metadata_replaced"], 1)
        self.assertEqual(result["virtual_replaced"], 1)
        root = parse_xmp(output)
        self.assertEqual(
            xpath_text(root, "//dc:title/rdf:Alt/rdf:li[@xml:lang='x-default']/text()"),
            ["구간 XMP 제목"],
        )
        self.assertEqual(
            xpath_text(root, "//custom:identifier/text()"), ["chunk-identity-7"]
        )
        self.assertEqual(
            xpath_text(root, "//custom:identifier/@custom:scheme"), ["urn"]
        )


if __name__ == "__main__":
    unittest.main()
