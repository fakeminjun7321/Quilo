#!/usr/bin/env python3
"""Strict, deterministic verifier for translated PDF output.

The verifier deliberately fails closed for defects that must never be shipped:
an unreadable PDF, broken page correspondence, visually blank pages, leaked
markers / garbled text / untranslated prose, changed numbers, units or URLs,
new duplicate image placements, and changed URI link annotations.

Two comparison policies are available:

``inplace`` (the safe default)
    Page count, media-box size, and rotation must match the source page by page.
    Source image occurrence count must also be retained.

``retypeset``
    Pagination and paper size may move slightly because content is reflowed.
    Small documents must keep their page count; larger documents may drift by
    at most 20 percent. Effective paper size may differ by at most 12 percent.
    Content invariants are compared document-wide instead of page by page.

Existing command lines remain valid::

    python3 verify_translation.py translated.pdf \
        [--original source.pdf] [--json report.json]

For a retypeset output, add ``--mode retypeset``.  The JSON contract always
contains ``passed``, ``hard_failures`` and ``exit_code``.  Validation failures
are written to ``--json`` before the process exits with status 1.
"""

from __future__ import annotations

import argparse
from collections import Counter
import copy
import hashlib
import io
import json
import math
import os
import re
import sys
import unicodedata
from typing import Callable, Iterable

import fitz  # PyMuPDF
from lxml import etree


SCHEMA_VERSION = 2
EXIT_OK = 0
EXIT_VALIDATION_FAILED = 1
EXIT_INTERNAL_ERROR = 2
MAX_DETAIL_ITEMS = 100

# Render-based catastrophic-change thresholds.  Text substitutions are masked
# for the fine-grained in-place comparison below, but the full-page safeguard
# deliberately ignores that mask: otherwise a malicious / malformed large text
# block can hide a black or coloured overlay inside its bounding rectangle.
RENDER_DARK_LUMA = 64
MOSTLY_BLACK_RATIO = 0.70
SEVERE_DARK_RATIO_DELTA = 0.25
SEVERE_MEAN_GRAY_DROP = 50.0
GLOBAL_BRIGHT_DARK_CHANGE_RATIO = 0.10
GLOBAL_LARGE_CHANGE_RATIO = 0.20
GLOBAL_MEAN_CHANNEL_DELTA = 40.0

RAW_MARKERS = [
    (r"%%FIG:?\d*%%", "raw 그림 마커(%%FIG%%)"),
    (r"\\includegraphics", r"raw \\includegraphics"),
    (r"\\begin\{|\\end\{", "raw LaTeX 환경"),
    (r"```", "코드펜스 ```"),
    (r"\{\{EQ(?:-LATEX)?[:}]|\{\{MATH:|\{\{FORMULA:", "raw 수식 마커 {{EQ}}"),
    (r"\bTable\s+\d+:", "표 자동라벨 'Table N:'"),
    (r"\bFigure\s+\d+:", "그림 자동라벨 'Figure N:'"),
]

# Signatures which are unlikely to be legitimate prose or flattened math.
GARBLED_TEXT = [
    (r"\b3[A-Za-z]\d?\s*,\s*[A-Za-z0-9+\-\s]{1,14}\d4\b", "구간 괄호 깨짐([a,b]->3a, b4)"),
    (r"\bft>sec\b|\bft>s\b", "단위 슬래시 깨짐(ft>sec = ft/sec)"),
    (r"[A-Za-z]\s+S\s+\d(?![.)])", "화살표 깨짐(x S 1 = x arrow 1)"),
    (r"[0-9A-Za-z]\s?Ú\b", "부등호 깨짐(U-accent = >=)"),
    (r"\ufffd", "Unicode replacement character(U+FFFD)"),
    (r"(?:Ã.|Â.|â..){2,}", "UTF-8 mojibake"),
    (r"(?:□\s*){3,}", "연속 누락 글리프(□)"),
    (r"\x00", "NUL 문자"),
]

ENGLISH_RUN = re.compile(
    r"(?:\b[A-Za-z][A-Za-z'’\-]+\b[\s,;:]+){5,}\b[A-Za-z][A-Za-z'’\-]+\b"
)
LOWER_ENGLISH_WORD = r"[a-z][a-z'’]{1,}"
MIXED_KOREAN_ENGLISH_PROSE = re.compile(
    rf"\b{LOWER_ENGLISH_WORD}(?:-{LOWER_ENGLISH_WORD})+\b"
    rf"|\b{LOWER_ENGLISH_WORD}\b(?:[ \t]+\b{LOWER_ENGLISH_WORD}\b)+"
)
HANGUL = re.compile(r"[가-힣]")
ENGLISH_ALLOW = re.compile(
    r"https?://|www\.|goo\.gl|CC BY(?:-[A-Z]+)*|creativecommons"
    r"|Copyright\s*(?:©|\(c\))?\s*\d{4}|ISBN(?:-1[03])?\s*[: ]?\s*[\dXx-]+",
    re.I,
)
PRESERVED_CODE_COMMAND = re.compile(
    r"\b(?:git\s+(?:checkout|switch|clone|pull|push|commit|merge|rebase|status|diff)"
    r"|npm\s+(?:install|run|test|publish|ci)|npx\s+|yarn\s+|pnpm\s+"
    r"|pip(?:3)?\s+install|python(?:3)?\s+[\w./-]+\.py\b|node\s+[\w./-]+\.js\b"
    r"|docker\s+(?:build|run|compose)|kubectl\s+|cargo\s+(?:build|run|test))",
    re.I,
)
INLINE_CODE = re.compile(r"`[^`\r\n]{1,200}`")
SHORT_PARENTHETICAL_GLOSS = re.compile(
    r"\((?:[A-Za-z][A-Za-z'’-]*)(?:[ \t]+[A-Za-z][A-Za-z'’-]*){0,3}\)"
)
CODE_FONT_RE = re.compile(
    r"(?:Courier|Mono|Monospace|Typewriter|LMMono|Inconsolata|Consolas|Menlo|"
    r"Monaco|SourceCode|JetBrainsMono|DejaVuSansMono)",
    re.I,
)

NUMBER_CORE = r"[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?"
NUMBER_RE = re.compile(rf"(?<![A-Za-z0-9_]){NUMBER_CORE}%?(?=$|[^0-9_])")

# Longest / most specific units come first.  Unit comparison is intentionally
# case-sensitive: 12 mA changing to 12 MA is not a harmless translation edit.
UNIT_ATOM = (
    r"(?:°C|°F|kHz|MHz|GHz|kPa|MPa|GPa|kJ|kW|mV|mA|kΩ|MΩ|mmol|µmol|μmol|"
    r"mL|µL|μL|kg|mg|µg|μg|cm|mm|km|ms|µs|μs|min|mol|rpm|rad|dpi|psi|"
    r"Hz|Pa|J|W|V|A|Ω|N|K|L|M|g|m|s|h|ft|sec|in|lb|px|pt)"
)
UNIT_EXPR = rf"{UNIT_ATOM}(?:\s*[·*/]\s*{UNIT_ATOM})?(?:\s*(?:\^?[23]|[²³]))?"
NUMBER_UNIT_RE = re.compile(
    rf"(?<![A-Za-z0-9_])({NUMBER_CORE})\s*({UNIT_EXPR})(?![A-Za-z])"
)

URL_RE = re.compile(r"(?i)\b(?:https?://|www\.)[^\s<>{}\[\]\"']+")
URL_TRAILING = ".,;:!?)]}>'\""

# Element symbols are whitelisted so ordinary capitalized prose and acronyms
# do not become chemical invariants.  Formulae with a single element must also
# carry a numeric suffix (O2, Fe3+); multi-element formulae such as NaCl are
# retained without requiring a digit.
CHEMICAL_ELEMENTS = {
    "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar",
    "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr",
    "Rb", "Sr", "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn", "Sb", "Te", "I", "Xe",
    "Cs", "Ba", "La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu",
    "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg", "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra",
    "Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm", "Md", "No", "Lr", "Rf", "Db",
    "Sg", "Bh", "Hs", "Mt", "Ds", "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
}
CHEMICAL_ACRONYMS = {
    "AI", "API", "CPU", "DOI", "GPU", "GPT", "HTML", "HTTP", "HTTPS", "ID", "ISBN", "JSON", "OK", "PDF", "SI", "URL", "XML",
}
CHEMICAL_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:[A-Z][a-z]?\d*|\((?:[A-Z][a-z]?\d*)+\)\d*)+"
    r"(?:\^?\d*[+-])?(?![A-Za-z0-9])"
)
CONTENT_CHAR_RE = re.compile(r"[A-Za-z0-9가-힣]")
ORDER_TOKEN_RE = re.compile(r"[A-Za-z가-힣][A-Za-z0-9가-힣_-]{1,}")

# The verifier must not mistake a multi-column transition for a broken text
# stream.  Page-internal reading order is therefore assessed only between
# vertically separated blocks that substantially overlap on the x axis.  Very
# dense pages are left to the independent accessibility review instead of
# running a quadratic comparison with a weak signal.
READING_ORDER_MAX_BLOCKS = 400
READING_ORDER_X_OVERLAP_RATIO = 0.55
READING_ORDER_MIN_VERTICAL_GAP_PT = 36.0
READING_ORDER_MIN_VERTICAL_GAP_RATIO = 0.04
READING_ORDER_SEVERITY_MARGIN_PT = 24.0
READING_ORDER_SEVERITY_MARGIN_RATIO = 0.03

METADATA_TRANSLATABLE_FIELDS = ("title", "subject", "keywords")
XMP_MAX_BYTES = 4 * 1024 * 1024
XMP_RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
XMP_DC_NS = "http://purl.org/dc/elements/1.1/"
XMP_PDF_NS = "http://ns.adobe.com/pdf/1.3/"
XMP_XML_NS = "http://www.w3.org/XML/1998/namespace"
XMP_DESCRIPTION = f"{{{XMP_RDF_NS}}}Description"
XMP_ALT = f"{{{XMP_RDF_NS}}}Alt"
XMP_BAG = f"{{{XMP_RDF_NS}}}Bag"
XMP_SEQ = f"{{{XMP_RDF_NS}}}Seq"
XMP_LI = f"{{{XMP_RDF_NS}}}li"
XMP_LANG = f"{{{XMP_XML_NS}}}lang"
XMP_TARGET_PROPERTIES = {
    f"{{{XMP_DC_NS}}}title": "title",
    f"{{{XMP_DC_NS}}}description": "subject",
    f"{{{XMP_PDF_NS}}}Keywords": "keywords",
    f"{{{XMP_DC_NS}}}subject": "keywords",
}
METADATA_PRESERVED_FIELDS = (
    "author",
    "creator",
    "producer",
    "creationDate",
    "modDate",
)
SINGLE_WORD_TRANSLATABLE_LABELS = {
    "abstract",
    "acknowledgements",
    "appendix",
    "background",
    "bibliography",
    "conclusion",
    "contents",
    "discussion",
    "introduction",
    "methods",
    "notes",
    "overview",
    "preface",
    "references",
    "results",
    "summary",
}

# Exact-preserve text is allowed to reflow locally, but it must not migrate to
# a different header/footer/column region.  This catches a class of in-place
# renderer bugs that text-count and page-geometry checks cannot see.
STABLE_ANCHOR_MAX_DRIFT_PT = 50.0
STABLE_ANCHOR_BASELINE_TOLERANCE_PT = 4.0
STABLE_ANCHOR_SAME_LINE_WIDTH_RATIO = 0.25
STABLE_ANCHOR_SAME_LINE_MAX_PT = 150.0
STABLE_ANCHOR_LINE_WRAP_MIN_Y_PT = 6.0
STABLE_ANCHOR_LINE_WRAP_MAX_Y_PT = 30.0
# PyMuPDF returns one search rectangle per baseline fragment when a preserved
# formula uses real sub/superscript glyphs.  A translated prefix can move the
# whole formula horizontally while the base and script rectangles acquire
# different font-metric centres.  Treat that as one visual row only when the
# rectangles still overlap vertically (or nearly touch).  This is deliberately
# separate from the ordinary same-baseline rule and is enabled only for exact
# chemical/code formula anchors.
STABLE_ANCHOR_GLYPH_STACK_MAX_EDGE_GAP_PT = 2.0
OCR_SOURCE_BUNDLE_MAX_BYTES = 64 * 1024 * 1024
SHA256_HEX_RE = re.compile(r"^[a-f0-9]{64}$")
IDENTIFIER_ANCHOR_RE = re.compile(
    r"(?<![A-Za-z0-9])(?=[A-Za-z0-9_-]{3,}(?![A-Za-z0-9_-]))"
    r"(?=[A-Za-z0-9_-]*\d)[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+"
    r"(?![A-Za-z0-9])"
)
CODE_FORMULA_ANCHOR_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:[A-Za-z][A-Za-z0-9_.]*)"
    r"(?:[/^*=:+][A-Za-z0-9_.+\-]+)+(?![A-Za-z0-9])"
)


def _ctx(value: str, match: re.Match[str], span: int = 28) -> str:
    start = max(0, match.start() - span)
    end = min(len(value), match.end() + span)
    return value[start:end].replace("\n", " ")


def _normalise_text(value: str) -> str:
    return (
        unicodedata.normalize("NFKC", value or "")
        .replace("\u2212", "-")
        .replace("\u2013", "-")
        .replace("\u2014", "-")
        .replace("\u00a0", " ")
    )


def _normalise_ocr_review_text(value: str) -> str:
    """Canonical target text shared with the Node OCR review boundary."""

    return "\n".join(
        line.rstrip(" \t")
        for line in unicodedata.normalize("NFC", value or "")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .split("\n")
    ).strip()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _assert_exact_json_keys(value, expected: set[str], path: str) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError(f"{path} has missing or unexpected fields")


def _provider_family(value: str) -> str:
    provider = str(value or "").strip().lower()
    return {
        "claude": "anthropic",
        "anthropic": "anthropic",
        "chatgpt": "openai",
        "openai": "openai",
        "gemini": "google",
        "google": "google",
    }.get(provider, provider)


def _load_ocr_source_bundle(path: str, original_path: str, mode: str) -> dict:
    if mode != "retypeset":
        raise ValueError("OCR source truth is valid only in retypeset mode")
    if not original_path:
        raise ValueError("OCR source truth requires the original PDF")
    size = os.path.getsize(path)
    if size <= 0 or size > OCR_SOURCE_BUNDLE_MAX_BYTES:
        raise ValueError("OCR source bundle size is invalid")
    with open(path, "r", encoding="utf-8") as handle:
        bundle = json.load(handle)
    bundle_keys = {
        "schema_version",
        "task",
        "source_pdf_sha256",
        "ocr_evidence_sha256",
        "pages",
        "semantic_review",
    }
    if isinstance(bundle, dict) and "visual_review" in bundle:
        bundle_keys.add("visual_review")
    _assert_exact_json_keys(bundle, bundle_keys, "ocr_source")
    if bundle["schema_version"] != 1 or bundle["task"] != "ocr-postflight-source":
        raise ValueError("unsupported OCR source bundle schema or task")
    source_pdf_sha256 = _sha256_file(original_path)
    if bundle["source_pdf_sha256"] != source_pdf_sha256:
        raise ValueError("OCR source bundle is bound to a different source PDF")
    if not SHA256_HEX_RE.fullmatch(str(bundle["ocr_evidence_sha256"] or "")):
        raise ValueError("OCR evidence hash is invalid")
    if not isinstance(bundle["pages"], list) or not bundle["pages"]:
        raise ValueError("OCR source bundle has no pages")
    expected_pages = list(range(1, len(bundle["pages"]) + 1))
    actual_pages = []
    for index, page in enumerate(bundle["pages"]):
        _assert_exact_json_keys(
            page,
            {
                "page",
                "segment_id",
                "text",
                "text_sha256",
                "source_sha256",
                "requires_korean_translation",
                "translatable_text",
                "translatable_text_sha256",
            },
            f"ocr_source.pages[{index}]",
        )
        actual_pages.append(page["page"])
        if not isinstance(page["text"], str) or not page["text"].strip():
            raise ValueError("OCR source page text must not be empty")
        if not isinstance(page["requires_korean_translation"], bool):
            raise ValueError("OCR source page target-language policy is invalid")
        if not isinstance(page["translatable_text"], str):
            raise ValueError("OCR source page translatable text is invalid")
        if page["requires_korean_translation"] and not page["translatable_text"].strip():
            raise ValueError("OCR source page translatable text is unexpectedly empty")
        if (
            _sha256_bytes(
                unicodedata.normalize("NFC", page["translatable_text"]).encode("utf-8")
            )
            != page["translatable_text_sha256"]
        ):
            raise ValueError("OCR source translatable text hash mismatch")
        if _sha256_bytes(unicodedata.normalize("NFC", page["text"]).encode("utf-8")) != page["text_sha256"]:
            raise ValueError("OCR source page text hash mismatch")
        expected_id = (
            f"seg-{source_pdf_sha256[:12]}-p{page['page']:04d}-o0001"
            if isinstance(page["page"], int)
            else ""
        )
        if page["segment_id"] != expected_id:
            raise ValueError("OCR source segment ID mismatch")
        if not SHA256_HEX_RE.fullmatch(str(page["source_sha256"] or "")):
            raise ValueError("OCR source provenance hash is invalid")
    if actual_pages != expected_pages:
        raise ValueError("OCR source page coverage must be contiguous and ordered")

    review = bundle["semantic_review"]
    if review is not None:
        _assert_exact_json_keys(
            review,
            {
                "schema_version",
                "task",
                "evidence_sha256",
                "review_binding_sha256",
                "output_pdf_sha256",
                "judge_input_digest",
                "translation_provider",
                "judge_provider",
                "judge_request_id",
                "visual_review_sha256",
                "bindings",
            },
            "ocr_source.semantic_review",
        )
        if review["schema_version"] != 1 or review["task"] != "ocr-retypeset-semantic-review":
            raise ValueError("unsupported OCR semantic review schema or task")
        for field in (
            "evidence_sha256",
            "review_binding_sha256",
            "output_pdf_sha256",
            "judge_input_digest",
            "visual_review_sha256",
        ):
            if not SHA256_HEX_RE.fullmatch(str(review[field] or "")):
                raise ValueError(f"OCR semantic review {field} is invalid")
        if (
            not str(review["translation_provider"] or "").strip()
            or not str(review["judge_provider"] or "").strip()
            or not str(review["judge_request_id"] or "").strip()
            or _provider_family(review["translation_provider"])
            == _provider_family(review["judge_provider"])
        ):
            raise ValueError("OCR semantic review providers are invalid or not independent")
        if not isinstance(review["bindings"], list) or len(review["bindings"]) != len(bundle["pages"]):
            raise ValueError("OCR semantic review page binding coverage is invalid")
        for index, binding in enumerate(review["bindings"]):
            _assert_exact_json_keys(
                binding,
                {
                    "page",
                    "segment_id",
                    "source_sha256",
                    "target_sha256",
                    "binding_sha256",
                },
                f"ocr_source.semantic_review.bindings[{index}]",
            )
            page = bundle["pages"][index]
            if (
                binding["page"] != page["page"]
                or binding["segment_id"] != page["segment_id"]
                or binding["source_sha256"] != page["source_sha256"]
            ):
                raise ValueError("OCR semantic review binding differs from its OCR page")
            for field in ("source_sha256", "target_sha256", "binding_sha256"):
                if not SHA256_HEX_RE.fullmatch(str(binding[field] or "")):
                    raise ValueError("OCR semantic review segment hash is invalid")

    visual_review = bundle.get("visual_review")
    if visual_review is not None:
        _assert_exact_json_keys(
            visual_review,
            {
                "schema_version",
                "task",
                "intent",
                "provider",
                "model",
                "request_id",
                "generation_provider",
                "source_pdf_sha256",
                "output_pdf_sha256",
                "ocr_evidence_sha256",
                "ocr_render_manifest_sha256",
                "input_digest",
                "review_sha256",
            },
            "ocr_source.visual_review",
        )
        if (
            visual_review["schema_version"] != 1
            or visual_review["task"] != "ocr-retypeset-nontext-visual-review"
            or visual_review["intent"] not in {"translate", "restore"}
        ):
            raise ValueError("unsupported OCR visual review schema or task")
        for field in (
            "source_pdf_sha256",
            "output_pdf_sha256",
            "ocr_evidence_sha256",
            "ocr_render_manifest_sha256",
            "input_digest",
            "review_sha256",
        ):
            if not SHA256_HEX_RE.fullmatch(str(visual_review[field] or "")):
                raise ValueError(f"OCR visual review {field} is invalid")
        if (
            visual_review["source_pdf_sha256"] != source_pdf_sha256
            or visual_review["ocr_evidence_sha256"]
            != bundle["ocr_evidence_sha256"]
            or not str(visual_review["provider"] or "").strip()
            or not str(visual_review["model"] or "").strip()
            or not str(visual_review["request_id"] or "").strip()
            or not str(visual_review["generation_provider"] or "").strip()
            or _provider_family(visual_review["provider"])
            == _provider_family(visual_review["generation_provider"])
        ):
            raise ValueError("OCR visual review binding or provider independence is invalid")
    return bundle


def _ocr_semantic_review_analysis(
    bundle: dict,
    output_texts: list[str],
    translated_path: str,
) -> dict:
    review = bundle.get("semantic_review")
    if review is None:
        return {
            "matched": False,
            "needs_semantic_review": True,
            "reason": "independent_review_missing",
            "ocr_evidence_sha256": bundle["ocr_evidence_sha256"],
            "mismatches": [],
        }
    mismatches = []
    if review["output_pdf_sha256"] != _sha256_file(translated_path):
        mismatches.append({"kind": "output_pdf_hash"})
    if len(output_texts) != len(review["bindings"]):
        mismatches.append(
            {
                "kind": "page_count",
                "review_pages": len(review["bindings"]),
                "output_pages": len(output_texts),
            }
        )
    for index in range(min(len(output_texts), len(review["bindings"]))):
        actual = _sha256_bytes(
            _normalise_ocr_review_text(output_texts[index]).encode("utf-8")
        )
        expected = review["bindings"][index]["target_sha256"]
        if actual != expected:
            mismatches.append(
                {
                    "kind": "output_text_hash",
                    "page": index + 1,
                    "segment_id": review["bindings"][index]["segment_id"],
                    "expected_target_sha256": expected,
                    "actual_target_sha256": actual,
                }
            )
    return {
        "matched": not mismatches,
        "needs_semantic_review": bool(mismatches),
        "reason": None if not mismatches else "review_output_binding_mismatch",
        "ocr_evidence_sha256": bundle["ocr_evidence_sha256"],
        "evidence_sha256": review["evidence_sha256"],
        "review_binding_sha256": review["review_binding_sha256"],
        "judge_input_digest": review["judge_input_digest"],
        "segment_count": len(review["bindings"]),
        "segment_ids": [item["segment_id"] for item in review["bindings"]],
        "mismatches": mismatches[:MAX_DETAIL_ITEMS],
        "truncated": len(mismatches) > MAX_DETAIL_ITEMS,
        "policy": (
            "independent provider review bound to source OCR hash, output PDF hash, "
            "canonical output page text hashes, and exact page/segment IDs"
        ),
    }


def _is_preserved_literal_segment(segment: str) -> bool:
    words = re.findall(r"[A-Za-z][A-Za-z'’\-]*", segment)
    if ENGLISH_ALLOW.search(segment) and len(words) <= 10:
        return True
    command_count = len(list(PRESERVED_CODE_COMMAND.finditer(segment)))
    # A short command-like line may be intentionally preserved.  A command
    # embedded in a long English explanation does not exempt that explanation.
    return (command_count >= 1 and len(words) <= 10) or (
        command_count >= 2 and len(words) <= 16
    )


def _mask_spans(value: str, spans: Iterable[tuple[int, int]]) -> str:
    """Replace allowlisted spans with spaces while retaining all offsets."""

    characters = list(value)
    for start, end in spans:
        for index in range(max(0, start), min(len(characters), end)):
            if characters[index] not in "\r\n":
                characters[index] = " "
    return "".join(characters)


def _mixed_korean_untranslated_hits(value: str) -> list[str]:
    """Find short lowercase English prose embedded in otherwise Korean text.

    Six-word English runs are caught by :data:`ENGLISH_RUN`.  This narrower
    detector closes the mixed-language gap for a single lowercase hyphenated
    word (``born-digital``) or two-or-more lowercase prose words.  URLs,
    short parenthetical terminology glosses and compact command/code literals
    are masked first to keep the policy conservative.
    """

    normalised = _normalise_text(value)
    if not HANGUL.search(normalised):
        return []

    spans: list[tuple[int, int]] = []
    for pattern in (URL_RE, INLINE_CODE, SHORT_PARENTHETICAL_GLOSS):
        spans.extend((match.start(), match.end()) for match in pattern.finditer(normalised))

    # Match the existing command policy at line granularity.  This retains
    # legitimate arguments such as ``git checkout feature/anchor`` without
    # letting one command token exempt a long untranslated explanation.
    offset = 0
    for line in normalised.splitlines(keepends=True):
        if PRESERVED_CODE_COMMAND.search(line) and _is_preserved_literal_segment(line):
            spans.append((offset, offset + len(line)))
        offset += len(line)

    masked = _mask_spans(normalised, spans)
    hits = []
    for match in MIXED_KOREAN_ENGLISH_PROSE.finditer(masked):
        segment = normalised[match.start() : match.end()]
        if segment not in hits:
            hits.append(segment)
    return hits


def _page_text_without_code_spans(page: fitz.Page) -> str:
    """Return readable page text while excluding visually marked code spans."""

    lines: list[str] = []
    for block in page.get_text("dict", sort=True).get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            pieces = []
            for span in line.get("spans", []):
                font = str(span.get("font") or "")
                flags = int(span.get("flags") or 0)
                if flags & 8 or CODE_FONT_RE.search(font):
                    continue
                pieces.append(str(span.get("text") or ""))
            if pieces:
                lines.append("".join(pieces))
    return "\n".join(lines)


def scan_page_text(
    text: str,
    *,
    untranslated_text: str | None = None,
) -> list[tuple[str, str]]:
    """Return hard text-integrity defects found on one output page."""

    issues: list[tuple[str, str]] = []
    normalised = _normalise_text(text)
    oneline = " ".join(normalised.split())

    for pattern, label in RAW_MARKERS:
        match = re.search(pattern, normalised)
        if match:
            issues.append(("raw_marker", f"{label}: ...{_ctx(normalised, match)}..."))

    for pattern, label in GARBLED_TEXT:
        match = re.search(pattern, oneline)
        if match:
            issues.append(("garbled", f"{label}: ...{_ctx(oneline, match)}..."))

    untranslated_normalised = _normalise_text(
        text if untranslated_text is None else untranslated_text
    )
    untranslated_oneline = " ".join(untranslated_normalised.split())
    hangul_count = len(HANGUL.findall(untranslated_normalised))
    english_count = len(re.findall(r"[A-Za-z]", untranslated_normalised))
    hits = []
    for match in ENGLISH_RUN.finditer(untranslated_oneline):
        segment = match.group(0)
        # Shell / package-manager commands are intentional preserved literals,
        # not prose requiring Korean translation.  Long prose inside
        # parentheses is still prose and must not be blanket-exempted.
        if _is_preserved_literal_segment(segment):
            continue
        hits.append(segment)
    for segment in _mixed_korean_untranslated_hits(untranslated_normalised):
        if segment not in hits and not any(segment in existing for existing in hits):
            hits.append(segment)
    if hits:
        issues.append(
            (
                "untranslated",
                f"영어 산문 {len(hits)}개 잔존(한글 {hangul_count}/영문자 {english_count}): "
                f"[{hits[0][:100]}]",
            )
        )
    return issues


def _strip_short_korean_glosses(value: str) -> str:
    """Remove only short foreign glossary terms after a Korean term.

    This mirrors the OCR review boundary: ``어텐션(Attention)`` is allowed,
    while a whole untranslated sentence wrapped in parentheses is not.
    """

    pattern = re.compile(r"([가-힣]{2,})[ \t]*\(([^()\r\n]{1,80})\)")

    def replace(match: re.Match[str]) -> str:
        gloss = match.group(2)
        words = [
            token
            for token in re.findall(r"[^\W\d_]+", gloss, flags=re.UNICODE)
            if not HANGUL.search(token) and sum(char.isalpha() for char in token) >= 2
        ]
        if 1 <= len(words) <= 4 and not re.search(r"[.!?。！？]", gloss):
            return match.group(1)
        return match.group(0)

    return pattern.sub(replace, value)


def _target_language_stats(value: str) -> dict:
    masked = URL_RE.sub(" ", _normalise_text(value))
    letters = [character for character in masked if character.isalpha()]
    hangul_count = len(HANGUL.findall(masked))
    foreign_letter_count = sum(
        1 for character in letters if not HANGUL.fullmatch(character)
    )
    foreign_words = [
        token.casefold()
        for token in re.findall(r"[^\W\d_]+", masked, flags=re.UNICODE)
        if not HANGUL.search(token) and sum(character.isalpha() for character in token) >= 2
    ]
    return {
        "hangul_count": hangul_count,
        "foreign_letter_count": foreign_letter_count,
        "foreign_words": foreign_words,
    }


def _retained_foreign_word_ratio(source_words: list[str], target_words: list[str]) -> float:
    if not source_words:
        return 0.0
    target_counts = Counter(target_words)
    retained = 0
    for word in source_words:
        if target_counts[word] > 0:
            retained += 1
            target_counts[word] -= 1
    return retained / len(source_words)


def _canonical_number(token: str) -> str:
    token = _normalise_text(token).replace(",", "")
    if "e" in token.lower():
        mantissa, exponent = re.split(r"[eE]", token, maxsplit=1)
        token = f"{mantissa}e{exponent.lstrip('+')}"
    return token


def extract_numbers(text: str) -> list[str]:
    return [_canonical_number(match.group(0)) for match in NUMBER_RE.finditer(_normalise_text(text))]


def _canonical_unit(unit: str) -> str:
    return (
        _normalise_text(unit)
        .replace("μ", "µ")
        .replace(" ", "")
        .replace("·", "*")
        .replace("²", "^2")
        .replace("³", "^3")
    )


def extract_number_units(text: str) -> list[str]:
    result = []
    for match in NUMBER_UNIT_RE.finditer(_normalise_text(text)):
        result.append(f"{_canonical_number(match.group(1))} {_canonical_unit(match.group(2))}")
    return result


def extract_chemical_formulas(text: str) -> list[str]:
    formulas = []
    for match in CHEMICAL_RE.finditer(_normalise_text(text)):
        formula = re.sub(r"\s+", "", match.group(0))
        if formula.upper() in CHEMICAL_ACRONYMS:
            continue
        elements = re.findall(r"[A-Z][a-z]?", formula)
        if not elements or any(element not in CHEMICAL_ELEMENTS for element in elements):
            continue
        if len(elements) < 2 and not re.search(r"\d", formula):
            continue
        formulas.append(formula)
    return formulas


def _stable_anchor_candidates(text: str) -> dict[str, list[str]]:
    """Return exact-preserve literals whose page position is meaningful."""

    normalised = _normalise_text(text)
    candidates: dict[str, set[str]] = {}
    url_spans: list[tuple[int, int]] = []

    def add(value: str, kind: str) -> None:
        value = value.strip().rstrip(URL_TRAILING)
        if 2 <= len(value) <= 240:
            candidates.setdefault(value, set()).add(kind)

    for match in URL_RE.finditer(normalised):
        value = match.group(0).rstrip(URL_TRAILING)
        url_spans.append((match.start(), match.start() + len(value)))
        add(value, "url")

    def overlaps_url(match: re.Match[str]) -> bool:
        return any(match.start() < end and start < match.end() for start, end in url_spans)

    for match in NUMBER_UNIT_RE.finditer(normalised):
        if not overlaps_url(match):
            add(match.group(0), "number_unit")

    for match in IDENTIFIER_ANCHOR_RE.finditer(normalised):
        if not overlaps_url(match):
            add(match.group(0), "identifier")

    for match in CODE_FORMULA_ANCHOR_RE.finditer(normalised):
        if not overlaps_url(match):
            add(match.group(0).rstrip(".,;:"), "code_formula")

    for formula in extract_chemical_formulas(normalised):
        add(formula, "chemical_formula")

    return {value: sorted(kinds) for value, kinds in candidates.items()}


def _anchor_pair_metrics(
    source_rect: fitz.Rect,
    output_rect: fitz.Rect,
    page_width: float,
    *,
    allow_glyph_stack_reflow: bool = False,
) -> dict:
    source_center = ((source_rect.x0 + source_rect.x1) / 2, (source_rect.y0 + source_rect.y1) / 2)
    output_center = ((output_rect.x0 + output_rect.x1) / 2, (output_rect.y0 + output_rect.y1) / 2)
    dx = abs(source_center[0] - output_center[0])
    dy = abs(source_center[1] - output_center[1])
    distance = math.hypot(dx, dy)

    local_reflow = distance <= STABLE_ANCHOR_MAX_DRIFT_PT
    same_line_limit = min(
        STABLE_ANCHOR_SAME_LINE_MAX_PT,
        max(1.0, page_width) * STABLE_ANCHOR_SAME_LINE_WIDTH_RATIO,
    )
    same_line_reflow = (
        dy <= STABLE_ANCHOR_BASELINE_TOLERANCE_PT
        and dx <= same_line_limit
    )
    vertical_edge_gap = max(
        0.0,
        max(float(source_rect.y0), float(output_rect.y0))
        - min(float(source_rect.y1), float(output_rect.y1)),
    )
    # The centre-distance bound prevents a very tall rectangle from claiming
    # an unrelated row merely because its bbox happens to overlap it.  Real
    # base/sub/superscript fragments are at most one participating glyph-box
    # height apart, as in O2, H2O, and SO4^2-.
    glyph_stack_center_limit = max(
        float(source_rect.height),
        float(output_rect.height),
    ) + STABLE_ANCHOR_GLYPH_STACK_MAX_EDGE_GAP_PT
    glyph_stack_reflow = (
        allow_glyph_stack_reflow
        and dx <= same_line_limit
        and vertical_edge_gap <= STABLE_ANCHOR_GLYPH_STACK_MAX_EDGE_GAP_PT
        and dy <= glyph_stack_center_limit
    )
    source_fraction = source_center[0] / max(1.0, page_width)
    output_fraction = output_center[0] / max(1.0, page_width)
    crosses_line_edge = (
        (source_fraction >= 0.55 and output_fraction <= 0.45)
        or (output_fraction >= 0.55 and source_fraction <= 0.45)
    )
    line_wrap = (
        STABLE_ANCHOR_LINE_WRAP_MIN_Y_PT <= dy <= STABLE_ANCHOR_LINE_WRAP_MAX_Y_PT
        and crosses_line_edge
    )
    return {
        "matched": local_reflow or same_line_reflow or glyph_stack_reflow or line_wrap,
        "reason": (
            "local_reflow"
            if local_reflow
            else "same_line_reflow"
            if same_line_reflow
            else "glyph_stack_reflow"
            if glyph_stack_reflow
            else "line_wrap"
            if line_wrap
            else "large_drift"
        ),
        "dx": round(dx, 3),
        "dy": round(dy, 3),
        "distance": round(distance, 3),
        "same_line_limit": round(same_line_limit, 3),
        "vertical_edge_gap": round(vertical_edge_gap, 3),
        "glyph_stack_center_limit": round(glyph_stack_center_limit, 3),
        "source_rect": [round(float(value), 3) for value in source_rect],
        "output_rect": [round(float(value), 3) for value in output_rect],
    }


def _minimum_cost_assignment(costs: list[list[float]]) -> list[tuple[int, int]]:
    """Hungarian assignment for a square cost matrix."""

    count = len(costs)
    if count == 0:
        return []
    if any(len(row) != count for row in costs):
        raise ValueError("assignment matrix must be square")

    u = [0.0] * (count + 1)
    v = [0.0] * (count + 1)
    p = [0] * (count + 1)
    way = [0] * (count + 1)
    for source_index in range(1, count + 1):
        p[0] = source_index
        column = 0
        min_value = [math.inf] * (count + 1)
        used = [False] * (count + 1)
        while True:
            used[column] = True
            row = p[column]
            delta = math.inf
            next_column = 0
            for candidate in range(1, count + 1):
                if used[candidate]:
                    continue
                current = costs[row - 1][candidate - 1] - u[row] - v[candidate]
                if current < min_value[candidate]:
                    min_value[candidate] = current
                    way[candidate] = column
                if min_value[candidate] < delta:
                    delta = min_value[candidate]
                    next_column = candidate
            for candidate in range(count + 1):
                if used[candidate]:
                    u[p[candidate]] += delta
                    v[candidate] -= delta
                else:
                    min_value[candidate] -= delta
            column = next_column
            if p[column] == 0:
                break
        while True:
            previous = way[column]
            p[column] = p[previous]
            column = previous
            if column == 0:
                break

    assignment = []
    for output_index in range(1, count + 1):
        if p[output_index]:
            assignment.append((p[output_index] - 1, output_index - 1))
    return sorted(assignment)


def _glyph_stack_members(rects: list[fitz.Rect]) -> list[bool]:
    """Identify search fragments that visibly form one stacked token row.

    PyMuPDF splits a hit at font / baseline changes.  Genuine formula
    fragments touch horizontally and overlap vertically, while duplicate
    occurrences elsewhere on the page do not.  Requiring unequal vertical
    geometry also prevents adjacent same-baseline repeats (for example O2O2)
    from manufacturing glyph-stack evidence.
    """

    members = [False] * len(rects)
    for left_index, left in enumerate(rects):
        for right_index in range(left_index + 1, len(rects)):
            right = rects[right_index]
            horizontal_edge_gap = max(
                0.0,
                max(float(left.x0), float(right.x0))
                - min(float(left.x1), float(right.x1)),
            )
            vertical_edge_gap = max(
                0.0,
                max(float(left.y0), float(right.y0))
                - min(float(left.y1), float(right.y1)),
            )
            center_dy = abs(
                (float(left.y0) + float(left.y1)) / 2
                - (float(right.y0) + float(right.y1)) / 2
            )
            vertical_geometry_differs = (
                abs(float(left.y0) - float(right.y0)) > 0.5
                or abs(float(left.height) - float(right.height)) > 0.5
            )
            if (
                horizontal_edge_gap <= 1.5
                and vertical_edge_gap <= STABLE_ANCHOR_GLYPH_STACK_MAX_EDGE_GAP_PT
                and center_dy
                <= max(float(left.height), float(right.height))
                + STABLE_ANCHOR_GLYPH_STACK_MAX_EDGE_GAP_PT
                and vertical_geometry_differs
            ):
                members[left_index] = True
                members[right_index] = True
    return members


def _match_anchor_occurrences(
    source_rects: list[fitz.Rect],
    output_rects: list[fitz.Rect],
    page_width: float,
    *,
    anchor_kinds: Iterable[str] = (),
) -> dict:
    """Optimally pair duplicate anchor occurrences and assess each movement."""

    if len(source_rects) != len(output_rects):
        return {
            "matched": False,
            "reason": "occurrence_count",
            "source_count": len(source_rects),
            "output_count": len(output_rects),
            "pairs": [],
        }
    kinds = set(anchor_kinds)
    formula_anchor = bool(
        kinds.intersection({"chemical_formula", "code_formula"})
    )
    source_stack_members = (
        _glyph_stack_members(source_rects)
        if formula_anchor
        else [False] * len(source_rects)
    )
    output_stack_members = (
        _glyph_stack_members(output_rects)
        if formula_anchor
        else [False] * len(output_rects)
    )
    metrics = [
        [
            _anchor_pair_metrics(
                source,
                output,
                page_width,
                allow_glyph_stack_reflow=(
                    source_stack_members[source_index]
                    and output_stack_members[output_index]
                ),
            )
            for output_index, output in enumerate(output_rects)
        ]
        for source_index, source in enumerate(source_rects)
    ]
    # Maximise the number of policy-valid pairs before minimising geometric
    # movement.  This is important when duplicate IDs occur in both a header
    # and footer and extraction order differs between source and output.
    costs = [
        [item["distance"] + (0.0 if item["matched"] else 1_000_000.0) for item in row]
        for row in metrics
    ]
    assignment = _minimum_cost_assignment(costs)
    pairs = []
    for source_index, output_index in assignment:
        pairs.append(
            {
                "source_occurrence": source_index + 1,
                "output_occurrence": output_index + 1,
                **metrics[source_index][output_index],
            }
        )
    # Repeated scientific literals often sit inside full-width prose blocks.
    # Korean translation can make the first occurrence much shorter while a
    # later occurrence remains locally aligned. Treat that as same-row text
    # reflow, not column migration. Singletons, identifiers/code, count
    # changes and vertical moves keep the stricter policy above.
    repeat_literal_reflow = (
        len(pairs) > 1
        and bool(kinds)
        and kinds.issubset({"chemical_formula", "number_unit"})
        and any(pair["matched"] for pair in pairs)
        and all(
            pair["matched"]
            or (
                pair["dy"] <= STABLE_ANCHOR_BASELINE_TOLERANCE_PT
                and pair["dx"]
                <= min(max(1.0, page_width) * 0.50, 300.0)
            )
            for pair in pairs
        )
    )
    return {
        "matched": all(pair["matched"] for pair in pairs) or repeat_literal_reflow,
        "reason": "repeated_literal_same_row_reflow" if repeat_literal_reflow else "movement",
        "source_count": len(source_rects),
        "output_count": len(output_rects),
        "pairs": pairs,
    }


def _stable_anchor_correspondence(
    source_doc: fitz.Document,
    output_doc: fitz.Document,
) -> dict:
    mismatches = []
    checked_occurrences = 0
    checked_literals = 0

    for page_index in range(min(len(source_doc), len(output_doc))):
        source_page = source_doc[page_index]
        output_page = output_doc[page_index]
        source_text = source_page.get_text("text") or ""
        for token, kinds in _stable_anchor_candidates(source_text).items():
            source_rects = [fitz.Rect(rect) for rect in source_page.search_for(token)]
            output_rects = [fitz.Rect(rect) for rect in output_page.search_for(token)]
            checked_literals += 1
            checked_occurrences += len(source_rects)
            comparison = _match_anchor_occurrences(
                source_rects,
                output_rects,
                max(float(source_page.rect.width), float(output_page.rect.width)),
                anchor_kinds=kinds,
            )
            if not comparison["matched"]:
                mismatches.append(
                    {
                        "page": page_index + 1,
                        "token": token,
                        "types": kinds,
                        **comparison,
                    }
                )

    return {
        "matched": not mismatches,
        "policy": (
            "same-page 1:1 optimal matching; <=50pt local center drift; "
            "same-baseline horizontal drift <=min(25% page width, 150pt); "
            "exact formula glyph-stack horizontal reflow within the same visual row "
            "<=min(25% page width, 150pt); "
            "6-30pt vertical edge-to-edge line wrap allowed"
        ),
        "max_local_drift_points": STABLE_ANCHOR_MAX_DRIFT_PT,
        "same_line": {
            "baseline_tolerance_points": STABLE_ANCHOR_BASELINE_TOLERANCE_PT,
            "page_width_ratio": STABLE_ANCHOR_SAME_LINE_WIDTH_RATIO,
            "maximum_points": STABLE_ANCHOR_SAME_LINE_MAX_PT,
        },
        "formula_glyph_stack": {
            "types": ["chemical_formula", "code_formula"],
            "maximum_vertical_edge_gap_points": (
                STABLE_ANCHOR_GLYPH_STACK_MAX_EDGE_GAP_PT
            ),
            "maximum_horizontal_points": STABLE_ANCHOR_SAME_LINE_MAX_PT,
        },
        "line_wrap_vertical_points": [
            STABLE_ANCHOR_LINE_WRAP_MIN_Y_PT,
            STABLE_ANCHOR_LINE_WRAP_MAX_Y_PT,
        ],
        "checked_literals": checked_literals,
        "checked_occurrences": checked_occurrences,
        "mismatches": mismatches[:MAX_DETAIL_ITEMS],
        "truncated": len(mismatches) > MAX_DETAIL_ITEMS,
    }


def _content_character_count(text: str) -> int:
    return len(CONTENT_CHAR_RE.findall(_normalise_text(text)))


def _content_coverage(source_pages: list[str], output_pages: list[str], mode: str) -> dict:
    mismatches = []

    def assess(source: str, output: str, scope) -> None:
        source_count = _content_character_count(source)
        output_count = _content_character_count(output)
        if source_count < 40:
            return
        required = max(12, math.ceil(source_count * 0.30))
        if output_count < required:
            mismatches.append(
                {
                    **scope,
                    "source_characters": source_count,
                    "output_characters": output_count,
                    "minimum_required": required,
                    "ratio": round(output_count / source_count, 4),
                }
            )

    if mode == "inplace":
        for index in range(max(len(source_pages), len(output_pages))):
            source = source_pages[index] if index < len(source_pages) else ""
            output = output_pages[index] if index < len(output_pages) else ""
            assess(source, output, {"page": index + 1})
    else:
        assess("\n".join(source_pages), "\n".join(output_pages), {"scope": "document"})

    return {
        "matched": not mismatches,
        "minimum_output_ratio": 0.30,
        "minimum_source_characters": 40,
        "mismatches": mismatches[:MAX_DETAIL_ITEMS],
        "truncated": len(mismatches) > MAX_DETAIL_ITEMS,
    }


def _page_token_counter(text: str) -> Counter[str]:
    return Counter(token.casefold() for token in ORDER_TOKEN_RE.findall(_normalise_text(text)))


def _counter_jaccard(left: Counter[str], right: Counter[str]) -> float:
    keys = set(left) | set(right)
    if not keys:
        return 0.0
    intersection = sum(min(left[key], right[key]) for key in keys)
    union = sum(max(left[key], right[key]) for key in keys)
    return intersection / union if union else 0.0


def _page_order_analysis(source_pages: list[str], output_pages: list[str]) -> dict:
    if len(source_pages) != len(output_pages) or len(source_pages) < 2:
        return {
            "matched": True,
            "assessable_pages": 0,
            "mismatches": [],
            "note": "page counts differ or fewer than two pages; page correspondence handles this case",
        }

    source_tokens = [_page_token_counter(text) for text in source_pages]
    output_tokens = [_page_token_counter(text) for text in output_pages]
    assessed = 0
    mismatches = []
    for output_index, output_counter in enumerate(output_tokens):
        scores = [_counter_jaccard(source_counter, output_counter) for source_counter in source_tokens]
        if not scores:
            continue
        best_index = max(range(len(scores)), key=scores.__getitem__)
        best_score = scores[best_index]
        expected_score = scores[output_index]
        # Only act on strong lexical evidence.  Normal translation generally
        # has low source-language overlap and is therefore not guessed at.
        if best_score >= 0.60:
            assessed += 1
        if best_index != output_index and best_score >= 0.60 and best_score - expected_score >= 0.20:
            mismatches.append(
                {
                    "output_page": output_index + 1,
                    "best_source_page": best_index + 1,
                    "best_similarity": round(best_score, 4),
                    "expected_page_similarity": round(expected_score, 4),
                }
            )
    return {
        "matched": not mismatches,
        "assessable_pages": assessed,
        "mismatches": mismatches[:MAX_DETAIL_ITEMS],
        "truncated": len(mismatches) > MAX_DETAIL_ITEMS,
        "policy": "hard-fail only when a different source page has >=0.60 token similarity and >=0.20 margin",
    }


def _reading_order_blocks(page: fitz.Page) -> tuple[list[dict], str | None]:
    """Return text blocks in PDF content-stream extraction order.

    ``sort=False`` is intentional.  Sorting by coordinates would conceal the
    accessibility defect this gate is designed to detect.
    """

    blocks = []
    try:
        raw_blocks = page.get_text("blocks", sort=False)
    except Exception as exc:
        return [], f"{type(exc).__name__}: {exc}"
    for extraction_index, raw in enumerate(raw_blocks):
        if len(raw) < 5:
            continue
        block_type = raw[6] if len(raw) > 6 else 0
        if block_type != 0:
            continue
        text = _normalise_text(str(raw[4] or ""))
        if _content_character_count(text) < 2:
            continue
        rect = fitz.Rect(*raw[:4])
        if rect.is_empty or rect.width <= 0 or rect.height <= 0:
            continue
        blocks.append(
            {
                "extraction_index": extraction_index,
                "rect": rect,
                "text": " ".join(text.split())[:120],
            }
        )
    return blocks, None


def _horizontal_overlap_ratio(left: fitz.Rect, right: fitz.Rect) -> float:
    overlap = max(0.0, min(left.x1, right.x1) - max(left.x0, right.x0))
    denominator = min(float(left.width), float(right.width))
    return overlap / denominator if denominator > 0 else 0.0


def _reading_order_profile(page: fitz.Page) -> dict:
    blocks, error = _reading_order_blocks(page)
    page_height = float(page.rect.height)
    minimum_gap = max(
        READING_ORDER_MIN_VERTICAL_GAP_PT,
        page_height * READING_ORDER_MIN_VERTICAL_GAP_RATIO,
    )
    if error:
        return {
            "assessable": False,
            "reason": "text_block_extraction_error",
            "error": error,
            "block_count": 0,
            "minimum_vertical_gap_points": round(minimum_gap, 3),
            "inversion_count": 0,
            "maximum_vertical_gap_points": 0.0,
            "examples": [],
        }
    if len(blocks) > READING_ORDER_MAX_BLOCKS:
        return {
            "assessable": False,
            "reason": "too_many_blocks_for_conservative_pairwise_analysis",
            "block_count": len(blocks),
            "maximum_blocks": READING_ORDER_MAX_BLOCKS,
            "minimum_vertical_gap_points": round(minimum_gap, 3),
            "inversion_count": 0,
            "maximum_vertical_gap_points": 0.0,
            "examples": [],
        }

    inversions = []
    for left_index in range(len(blocks)):
        for right_index in range(left_index + 1, len(blocks)):
            first = blocks[left_index]
            second = blocks[right_index]
            first_rect = first["rect"]
            second_rect = second["rect"]
            if first_rect.y1 + minimum_gap <= second_rect.y0:
                upper, lower = first, second
            elif second_rect.y1 + minimum_gap <= first_rect.y0:
                upper, lower = second, first
            else:
                continue
            overlap_ratio = _horizontal_overlap_ratio(upper["rect"], lower["rect"])
            if overlap_ratio < READING_ORDER_X_OVERLAP_RATIO:
                continue
            if upper["extraction_index"] < lower["extraction_index"]:
                continue
            gap = float(lower["rect"].y0 - upper["rect"].y1)
            inversions.append(
                {
                    "vertical_gap_points": round(gap, 3),
                    "horizontal_overlap_ratio": round(overlap_ratio, 4),
                    "upper": {
                        "extraction_index": upper["extraction_index"],
                        "rect": [round(float(value), 3) for value in upper["rect"]],
                        "text": upper["text"],
                    },
                    "lower": {
                        "extraction_index": lower["extraction_index"],
                        "rect": [round(float(value), 3) for value in lower["rect"]],
                        "text": lower["text"],
                    },
                }
            )
    inversions.sort(key=lambda item: item["vertical_gap_points"], reverse=True)
    return {
        "assessable": True,
        "block_count": len(blocks),
        "minimum_vertical_gap_points": round(minimum_gap, 3),
        "x_overlap_ratio": READING_ORDER_X_OVERLAP_RATIO,
        "inversion_count": len(inversions),
        "maximum_vertical_gap_points": (
            inversions[0]["vertical_gap_points"] if inversions else 0.0
        ),
        "examples": inversions[:10],
        "truncated": len(inversions) > 10,
    }


def _logical_reading_order_analysis(
    source_doc: fitz.Document,
    output_doc: fitz.Document,
    mode: str,
) -> dict:
    """Detect newly introduced, strong same-column extraction inversions.

    The source profile is the baseline because many real-world PDFs already
    have imperfect content-stream order.  Cross-column transitions are not
    assessed, so ordinary left/right column reading does not produce a false
    failure.
    """

    if mode != "inplace":
        return {
            "matched": True,
            "assessed_pages": 0,
            "mismatches": [],
            "skipped_pages": [],
            "note": "retypeset mode requires an independent tagged-PDF/accessibility review",
        }
    if len(source_doc) != len(output_doc):
        return {
            "matched": True,
            "assessed_pages": 0,
            "mismatches": [],
            "skipped_pages": [],
            "note": "page count mismatch is handled by page_correspondence",
        }

    assessed_pages = 0
    mismatches = []
    skipped_pages = []
    for page_index in range(len(source_doc)):
        source = _reading_order_profile(source_doc[page_index])
        output = _reading_order_profile(output_doc[page_index])
        if not source["assessable"] or not output["assessable"]:
            skipped_pages.append(
                {
                    "page": page_index + 1,
                    "source": source,
                    "output": output,
                }
            )
            continue
        assessed_pages += 1
        source_count = int(source["inversion_count"])
        output_count = int(output["inversion_count"])
        source_gap = float(source["maximum_vertical_gap_points"])
        output_gap = float(output["maximum_vertical_gap_points"])
        page_height = float(output_doc[page_index].rect.height)
        severity_margin = max(
            READING_ORDER_SEVERITY_MARGIN_PT,
            page_height * READING_ORDER_SEVERITY_MARGIN_RATIO,
        )
        newly_inverted = output_count > 0 and source_count == 0
        materially_worse = (
            output_count > source_count
            and output_gap > source_gap + severity_margin
        )
        # A large multiplication of inversions can be decisive even when one
        # pre-existing source inversion already has a similar vertical span.
        count_explosion = (
            output_count > max(source_count + 2, math.ceil(source_count * 1.5))
            and output_gap >= max(72.0, page_height * 0.08)
        )
        if newly_inverted or materially_worse or count_explosion:
            mismatches.append(
                {
                    "page": page_index + 1,
                    "reason": (
                        "new_same_column_inversion"
                        if newly_inverted
                        else "materially_worse_inversion"
                        if materially_worse
                        else "inversion_count_explosion"
                    ),
                    "severity_margin_points": round(severity_margin, 3),
                    "source": source,
                    "output": output,
                }
            )

    return {
        "matched": not mismatches,
        "assessed_pages": assessed_pages,
        "mismatches": mismatches[:MAX_DETAIL_ITEMS],
        "skipped_pages": skipped_pages[:MAX_DETAIL_ITEMS],
        "truncated": (
            len(mismatches) > MAX_DETAIL_ITEMS
            or len(skipped_pages) > MAX_DETAIL_ITEMS
        ),
        "policy": (
            "compare source/output unsorted text-block order; only same-column "
            "pairs with >=0.55 horizontal overlap and >=max(36pt,4% page height) "
            "vertical separation; fail only newly introduced/materially worse inversions"
        ),
    }


def _normalise_label(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = "".join(character for character in text if unicodedata.category(character) != "Cf")
    return " ".join(text.split()).strip()


def _label_comparison_key(value: object) -> str:
    return _normalise_label(value).casefold()


def _is_translatable_english_label(value: object) -> bool:
    """Conservatively identify human-facing English labels, not code/URLs."""

    text = _normalise_label(value)
    if not text or HANGUL.search(text) or _is_preserved_literal_segment(text):
        return False
    masked = URL_RE.sub(" ", text)
    masked = INLINE_CODE.sub(" ", masked)
    words = re.findall(r"[A-Za-z][A-Za-z'’-]*", masked)
    lexical = [
        word
        for word in words
        if len(word) >= 2 and not (word.isupper() and len(word) <= 8)
    ]
    if len(lexical) >= 2:
        return True
    return bool(
        len(lexical) == 1
        and lexical[0].casefold() in SINGLE_WORD_TRANSLATABLE_LABELS
    )


def _is_xmp_natural_language_label(value: object, *, field: str | None = None) -> bool:
    """Mirror the renderer's conservative XMP/Info virtual-block eligibility."""
    text = _normalise_label(value)
    if not text or len(text) > 4096:
        return False
    if field == "title" and text.casefold() == "untitled":
        return False
    if field == "subject" and text.casefold() == "unspecified":
        return False
    if re.fullmatch(r"(?i)(?:https?|ftp|mailto|tel|file):\S+", text):
        return False
    if re.fullmatch(r"(?i)www\.\S+", text) or re.fullmatch(
        r"[^\s@]+@[^\s@]+\.[^\s@]+", text
    ):
        return False
    if not re.search(r"\s", text) and (
        re.search(r"[/\\_]", text)
        or re.fullmatch(r"[A-Za-z]:.*", text)
        or re.fullmatch(r"[A-Za-z0-9-]+\.[A-Za-z0-9]{1,8}", text)
    ):
        return False
    words = re.findall(r"[A-Za-z]+(?:['’][A-Za-z]+)?", text)
    lexical = [
        word
        for word in words
        if len(re.sub(r"[^A-Za-z]", "", word)) >= 3
        and not re.fullmatch(r"[A-Z]{2,4}", word)
    ]
    return bool(lexical)


def _xmp_encryption_applies(doc: fitz.Document) -> bool:
    try:
        if bool(getattr(doc, "needs_pass", False)):
            return True
        value_type, value = doc.xref_get_key(-1, "Encrypt")
    except Exception as exc:
        raise RuntimeError("cannot inspect XMP encryption state") from exc
    if value_type in {"null", "none"} or str(value).strip() in {"", "null"}:
        return False
    match = re.fullmatch(r"\s*(\d+)\s+\d+\s+R\s*", str(value))
    if value_type != "xref" or match is None:
        raise RuntimeError("unsupported PDF encryption dictionary reference")
    try:
        flag_type, flag_value = doc.xref_get_key(
            int(match.group(1)), "EncryptMetadata"
        )
    except Exception as exc:
        raise RuntimeError("cannot inspect EncryptMetadata policy") from exc
    return not (
        flag_type == "bool" and str(flag_value).strip().lower() == "false"
    )


def _parse_xmp_for_verification(doc: fitz.Document) -> dict | None:
    try:
        xref = int(doc.xref_xml_metadata() or 0)
    except Exception as exc:
        raise RuntimeError("cannot locate XMP metadata stream") from exc
    if xref <= 0:
        return None
    if _xmp_encryption_applies(doc):
        raise RuntimeError("encrypted XMP metadata stream")
    try:
        if not doc.xref_is_stream(xref):
            raise RuntimeError("XMP metadata object is not a stream")
        raw = bytes(doc.xref_stream(xref) or b"")
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError("cannot read XMP metadata stream") from exc
    if not raw:
        raise RuntimeError("empty XMP metadata stream")
    if len(raw) > XMP_MAX_BYTES:
        raise RuntimeError("oversized XMP metadata stream")
    if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", raw, flags=re.IGNORECASE):
        raise RuntimeError("forbidden XMP DTD/entity markup")
    parser = etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        load_dtd=False,
        huge_tree=False,
        recover=False,
        remove_blank_text=False,
        strip_cdata=False,
    )
    try:
        tree = etree.parse(io.BytesIO(raw), parser)
    except (etree.XMLSyntaxError, ValueError, OSError) as exc:
        raise RuntimeError("malformed XMP metadata") from exc
    if tree.docinfo.doctype:
        raise RuntimeError("forbidden XMP DTD")
    return {"raw": raw, "tree": tree}


def _xmp_language(element) -> str:
    return str(element.get(XMP_LANG) or "").strip().lower()


def _xmp_leaf_text(element) -> str:
    if len(element):
        return ""
    return _normalise_label(element.text)


def _xmp_reader_inventory(state: dict | None) -> list[dict]:
    """Return values a normal PDF reader prioritizes for semantic XMP fields."""
    if state is None:
        return []
    values = []
    occurrence = Counter()

    def append(field, text, *, language="", representation="text"):
        text = _normalise_label(text)
        if not text:
            return
        index = occurrence[field]
        occurrence[field] += 1
        values.append(
            {
                "field": field,
                "index": index,
                "text": text,
                "language": language,
                "representation": representation,
            }
        )

    root = state["tree"].getroot()
    for description in root.iter(XMP_DESCRIPTION):
        for qname, field in XMP_TARGET_PROPERTIES.items():
            if qname in description.attrib:
                append(field, description.get(qname), representation="attribute")
        for prop in description:
            field = XMP_TARGET_PROPERTIES.get(prop.tag)
            if field is None:
                continue
            container = prop[0] if len(prop) == 1 else None
            if container is not None and container.tag == XMP_ALT:
                alternatives = [child for child in container if child.tag == XMP_LI]
                selected = next(
                    (child for child in alternatives if _xmp_language(child) == "x-default"),
                    None,
                )
                if selected is None:
                    selected = next(
                        (child for child in alternatives if _xmp_language(child).startswith("ko")),
                        None,
                    )
                if selected is None and alternatives:
                    selected = alternatives[0]
                if selected is not None:
                    append(
                        field,
                        _xmp_leaf_text(selected),
                        language=_xmp_language(selected),
                        representation="alt",
                    )
                continue
            if container is not None and container.tag in {XMP_BAG, XMP_SEQ}:
                for child in container:
                    if child.tag == XMP_LI:
                        append(
                            field,
                            _xmp_leaf_text(child),
                            language=_xmp_language(child),
                            representation="list",
                        )
                continue
            append(field, _xmp_leaf_text(prop), representation="text")
    return values


def _xmp_target_value_inventory(state: dict | None) -> dict[tuple, dict]:
    """Inventory every semantic XMP value with stable, language-aware locators.

    ``mutable`` is derived only from the source packet and mirrors the renderer:
    natural direct/list values may change; an Alt's natural x-default and existing
    Korean alternatives may change, while en/fr and opaque identifiers stay exact.
    """
    if state is None:
        return {}
    result = {}
    descriptions = list(state["tree"].getroot().iter(XMP_DESCRIPTION))
    for description_index, description in enumerate(descriptions):
        for qname, field in XMP_TARGET_PROPERTIES.items():
            if qname not in description.attrib:
                continue
            text = str(description.get(qname) or "")
            key = ("attribute", description_index, qname)
            result[key] = {
                "field": field,
                "text": text,
                "language": "",
                "mutable": _is_xmp_natural_language_label(text, field=field),
            }

        for property_index, prop in enumerate(description):
            field = XMP_TARGET_PROPERTIES.get(prop.tag)
            if field is None:
                continue
            container = prop[0] if len(prop) == 1 else None
            if container is not None and container.tag == XMP_ALT:
                alternatives = [child for child in container if child.tag == XMP_LI]
                x_default = next(
                    (
                        child
                        for child in alternatives
                        if _xmp_language(child) == "x-default"
                    ),
                    None,
                )
                natural_default = bool(
                    x_default is not None
                    and _is_xmp_natural_language_label(
                        _xmp_leaf_text(x_default), field=field
                    )
                )
                has_candidate = natural_default or any(
                    not _xmp_language(child).startswith("ko")
                    and _is_xmp_natural_language_label(
                        _xmp_leaf_text(child), field=field
                    )
                    for child in alternatives
                )
                language_occurrence = Counter()
                for child in alternatives:
                    language = _xmp_language(child)
                    occurrence = language_occurrence[language]
                    language_occurrence[language] += 1
                    key = (
                        "alt",
                        description_index,
                        property_index,
                        language,
                        occurrence,
                    )
                    result[key] = {
                        "field": field,
                        "text": _xmp_leaf_text(child),
                        "language": language,
                        "mutable": (
                            (language == "x-default" and natural_default)
                            or (language.startswith("ko") and has_candidate)
                        ),
                    }
                continue
            if container is not None and container.tag in {XMP_BAG, XMP_SEQ}:
                item_index = 0
                for child in container:
                    if child.tag != XMP_LI:
                        continue
                    text = _xmp_leaf_text(child)
                    key = ("list", description_index, property_index, item_index)
                    item_index += 1
                    result[key] = {
                        "field": field,
                        "text": text,
                        "language": _xmp_language(child),
                        "mutable": _is_xmp_natural_language_label(text, field=field),
                    }
                continue
            text = _xmp_leaf_text(prop)
            key = ("text", description_index, property_index)
            result[key] = {
                "field": field,
                "text": text,
                "language": "",
                "mutable": _is_xmp_natural_language_label(text, field=field),
            }
    return result


def _xmp_non_target_signature(state: dict | None) -> tuple:
    if state is None:
        return ("absent",)
    tree = copy.deepcopy(state["tree"])
    marker = "__QUILO_TRANSLATED_XMP_VALUE__"
    for description in tree.getroot().iter(XMP_DESCRIPTION):
        for qname in XMP_TARGET_PROPERTIES:
            if qname in description.attrib:
                description.set(qname, marker)
        for prop in description:
            if prop.tag not in XMP_TARGET_PROPERTIES:
                continue
            container = prop[0] if len(prop) == 1 else None
            if container is not None and container.tag == XMP_ALT:
                for child in list(container):
                    if child.tag != XMP_LI:
                        continue
                    language = _xmp_language(child)
                    if language == "x-default" or language.startswith("ko"):
                        extras = {
                            key: value
                            for key, value in child.attrib.items()
                            if key != XMP_LANG
                        }
                        if not extras and len(child) == 0:
                            container.remove(child)
                        else:
                            child.set(XMP_LANG, "__target__")
                            child.text = marker
                continue
            if container is not None and container.tag in {XMP_BAG, XMP_SEQ}:
                for child in container:
                    if child.tag == XMP_LI and len(child) == 0:
                        child.text = marker
                continue
            prop.text = marker
    try:
        canonical = etree.tostring(tree, method="c14n", with_comments=True)
    except (etree.C14NError, ValueError) as exc:
        raise RuntimeError("cannot canonicalize XMP metadata") from exc
    return (hashlib.sha256(canonical).hexdigest(), len(canonical))


def _xmp_translation_analysis(
    source_doc: fitz.Document, output_doc: fitz.Document, intent: str
) -> dict:
    errors = []
    source_state = None
    output_state = None
    for label, document in (("source", source_doc), ("output", output_doc)):
        try:
            state = _parse_xmp_for_verification(document)
        except RuntimeError as exc:
            errors.append({"document": label, "error": str(exc)})
            state = None
        if label == "source":
            source_state = state
        else:
            output_state = state
    if errors:
        return {
            "matched": False,
            "errors": errors,
            "untranslated_fields": [],
            "missing_translations": [],
            "preserved_target_changes": [],
            "non_target_changed": True,
        }

    source_values = _xmp_reader_inventory(source_state)
    output_values = _xmp_reader_inventory(output_state)
    source_target_values = _xmp_target_value_inventory(source_state)
    output_target_values = _xmp_target_value_inventory(output_state)
    output_by_key = {
        (item["field"], item["index"]): item for item in output_values
    }
    untranslated = []
    missing = []
    if intent == "translate":
        for source in source_values:
            if not _is_xmp_natural_language_label(
                source["text"], field=source["field"]
            ):
                continue
            output = output_by_key.get((source["field"], source["index"]))
            if output is None or not output["text"]:
                missing.append({"source": source, "output": output})
            elif (
                _label_comparison_key(source["text"])
                == _label_comparison_key(output["text"])
                or _is_xmp_natural_language_label(
                    output["text"], field=output["field"]
                )
            ):
                untranslated.append({"source": source, "output": output})

    preserved_target_changes = []
    for key, source in source_target_values.items():
        if source["mutable"]:
            continue
        output = output_target_values.get(key)
        if output is None or str(output["text"]) != str(source["text"]):
            preserved_target_changes.append(
                {
                    "locator": repr(key),
                    "field": source["field"],
                    "source": source["text"],
                    "output": None if output is None else output["text"],
                }
            )

    source_non_target = _xmp_non_target_signature(source_state)
    output_non_target = _xmp_non_target_signature(output_state)
    non_target_changed = source_non_target != output_non_target
    return {
        "matched": (
            not untranslated
            and not missing
            and not preserved_target_changes
            and not non_target_changed
        ),
        "errors": [],
        "source_reader_values": source_values,
        "output_reader_values": output_values,
        "untranslated_fields": untranslated,
        "missing_translations": missing,
        "preserved_target_changes": preserved_target_changes,
        "non_target_changed": non_target_changed,
        "source_non_target_signature": source_non_target,
        "output_non_target_signature": output_non_target,
        "policy": (
            "dc:title/dc:description RDF Alt uses x-default, then ko, then first alt; "
            "pdf:Keywords and dc:subject list values are checked in document order"
        ),
    }


def _metadata_translation_analysis(
    source_doc: fitz.Document,
    output_doc: fitz.Document,
    intent: str,
    mode: str,
) -> dict:
    if mode != "inplace":
        xmp = _xmp_translation_analysis(source_doc, output_doc, intent)
        return {
            "matched": xmp["matched"],
            "checked": True,
            "note": "Info mapping is mode-specific; XMP safety is always enforced",
            "xmp": xmp,
        }
    source = source_doc.metadata or {}
    output = output_doc.metadata or {}
    untranslated_fields = []
    missing_translations = []
    preserved_field_changes = []

    if intent == "translate":
        for field in METADATA_TRANSLATABLE_FIELDS:
            source_value = _normalise_label(source.get(field))
            output_value = _normalise_label(output.get(field))
            if not _is_translatable_english_label(source_value):
                continue
            if not output_value:
                missing_translations.append(
                    {"field": field, "source": source_value, "output": output_value}
                )
            elif _label_comparison_key(source_value) == _label_comparison_key(output_value):
                untranslated_fields.append(
                    {"field": field, "source": source_value, "output": output_value}
                )

    for field in METADATA_PRESERVED_FIELDS:
        # These fields are outside the translation surface.  Compare the
        # parsed raw strings exactly: whitespace, date offsets and producer
        # punctuation are provenance, not prose formatting.
        source_value = str(source.get(field) or "")
        output_value = str(output.get(field) or "")
        if source_value != output_value:
            preserved_field_changes.append(
                {"field": field, "source": source_value, "output": output_value}
            )

    xmp = _xmp_translation_analysis(source_doc, output_doc, intent)
    matched = (
        not untranslated_fields
        and not missing_translations
        and not preserved_field_changes
        and xmp["matched"]
    )
    return {
        "matched": matched,
        "checked": True,
        "translatable_fields": list(METADATA_TRANSLATABLE_FIELDS),
        "preserved_fields": list(METADATA_PRESERVED_FIELDS),
        "untranslated_fields": untranslated_fields,
        "missing_translations": missing_translations,
        "preserved_field_changes": preserved_field_changes,
        "xmp": xmp,
    }


def _outline_action_family(kind: object, target_page: int) -> str:
    try:
        numeric_kind = int(kind)
    except (TypeError, ValueError):
        numeric_kind = None
    if target_page >= 1 and numeric_kind in {None, fitz.LINK_GOTO, fitz.LINK_NAMED}:
        return "internal"
    return {
        fitz.LINK_GOTO: "internal",
        fitz.LINK_URI: "uri",
        fitz.LINK_LAUNCH: "launch",
        fitz.LINK_NAMED: "named",
        fitz.LINK_GOTOR: "remote_goto",
    }.get(numeric_kind, f"kind:{numeric_kind}")


def _normalise_destination_point(value: object) -> list[float] | None:
    if value is None:
        return None
    try:
        if hasattr(value, "x") and hasattr(value, "y"):
            return [round(float(value.x), 6), round(float(value.y), 6)]
        if isinstance(value, (list, tuple)) and len(value) >= 2:
            return [round(float(value[0]), 6), round(float(value[1]), 6)]
    except (TypeError, ValueError):
        return None
    return None


def _normalise_outline_color(value: object) -> list[float]:
    # PDF outline text defaults to black when /C is absent.  Treating an
    # omitted color and an explicitly encoded black color as equivalent avoids
    # a representation-only false positive while still preserving appearance.
    if value is None:
        return [0.0, 0.0, 0.0]
    try:
        if isinstance(value, (list, tuple)) and len(value) >= 3:
            return [round(float(value[index]), 6) for index in range(3)]
    except (TypeError, ValueError):
        pass
    return [0.0, 0.0, 0.0]


def _outline_inventory(doc: fitz.Document) -> tuple[list[dict], list[str]]:
    inventory = []
    errors = []
    try:
        rows = doc.get_toc(simple=False)
    except Exception as exc:
        return [], [f"{type(exc).__name__}: {exc}"]
    for index, row in enumerate(rows):
        try:
            level = int(row[0])
            title = _normalise_label(row[1])
            target_page = int(row[2])
            destination = row[3] if len(row) > 3 and isinstance(row[3], dict) else {}
            view = destination.get("view")
            if view is not None:
                view = str(view).lstrip("/")
            zoom = destination.get("zoom")
            try:
                zoom = round(float(zoom), 6) if zoom is not None else None
            except (TypeError, ValueError):
                zoom = None
            inventory.append(
                {
                    "index": index + 1,
                    "level": level,
                    "title": title,
                    "destination": {
                        "family": _outline_action_family(destination.get("kind"), target_page),
                        "target_page": target_page,
                        "view": view,
                        "point": _normalise_destination_point(destination.get("to")),
                        "zoom": zoom,
                        "uri": _normalise_label(destination.get("uri")),
                        "file": _normalise_label(destination.get("file")),
                        "name": _normalise_label(destination.get("name")),
                    },
                    "presentation": {
                        "collapse": bool(destination.get("collapse", False)),
                        "color": _normalise_outline_color(destination.get("color")),
                        "bold": bool(destination.get("bold", False)),
                        "italic": bool(destination.get("italic", False)),
                    },
                }
            )
        except Exception as exc:
            errors.append(f"outline item {index + 1}: {type(exc).__name__}: {exc}")
    return inventory, errors


def _outline_destinations_match(source: dict, output: dict) -> tuple[bool, list[str]]:
    reasons = []
    for field in ("family", "target_page", "view", "uri", "file", "name"):
        if source.get(field) != output.get(field):
            reasons.append(f"{field}_changed")
    for field in ("point",):
        left = source.get(field)
        right = output.get(field)
        if left is None or right is None:
            if left is not None or right is not None:
                reasons.append(f"{field}_changed")
        elif len(left) != len(right) or any(
            abs(float(a) - float(b)) > 0.01 for a, b in zip(left, right)
        ):
            reasons.append(f"{field}_changed")
    left_zoom = source.get("zoom")
    right_zoom = output.get("zoom")
    if left_zoom is None or right_zoom is None:
        if left_zoom is not None or right_zoom is not None:
            reasons.append("zoom_changed")
    elif abs(float(left_zoom) - float(right_zoom)) > 1e-6:
        reasons.append("zoom_changed")
    return not reasons, reasons


def _outline_translation_analysis(
    source_doc: fitz.Document,
    output_doc: fitz.Document,
    intent: str,
    mode: str,
) -> dict:
    if mode != "inplace":
        return {
            "matched": True,
            "checked": False,
            "note": "outline hierarchy/destination equivalence is enforced for inplace output",
        }
    source, source_errors = _outline_inventory(source_doc)
    output, output_errors = _outline_inventory(output_doc)
    mismatches = []
    if len(source) != len(output):
        mismatches.append(
            {"kind": "count", "source_count": len(source), "output_count": len(output)}
        )
    for index in range(min(len(source), len(output))):
        source_item = source[index]
        output_item = output[index]
        if source_item["level"] != output_item["level"]:
            mismatches.append(
                {
                    "kind": "hierarchy",
                    "index": index + 1,
                    "source_level": source_item["level"],
                    "output_level": output_item["level"],
                }
            )
        destination_matches, reasons = _outline_destinations_match(
            source_item["destination"], output_item["destination"]
        )
        if not destination_matches:
            mismatches.append(
                {
                    "kind": "destination",
                    "index": index + 1,
                    "reasons": reasons,
                    "source": source_item["destination"],
                    "output": output_item["destination"],
                }
            )
        presentation_reasons = []
        source_presentation = source_item["presentation"]
        output_presentation = output_item["presentation"]
        for field in ("collapse", "bold", "italic"):
            if source_presentation[field] != output_presentation[field]:
                presentation_reasons.append(f"{field}_changed")
        if any(
            abs(float(left) - float(right)) > 1e-6
            for left, right in zip(
                source_presentation["color"], output_presentation["color"]
            )
        ):
            presentation_reasons.append("color_changed")
        if presentation_reasons:
            mismatches.append(
                {
                    "kind": "presentation",
                    "index": index + 1,
                    "reasons": presentation_reasons,
                    "source": source_presentation,
                    "output": output_presentation,
                }
            )
        source_title = source_item["title"]
        output_title = output_item["title"]
        if not output_title and source_title:
            mismatches.append(
                {"kind": "missing_title", "index": index + 1, "source": source_title}
            )
        elif intent == "restore" and source_title != output_title:
            mismatches.append(
                {
                    "kind": "restore_title_changed",
                    "index": index + 1,
                    "source": source_title,
                    "output": output_title,
                }
            )
        elif (
            intent == "translate"
            and _is_translatable_english_label(source_title)
            and _label_comparison_key(source_title) == _label_comparison_key(output_title)
        ):
            mismatches.append(
                {
                    "kind": "untranslated_title",
                    "index": index + 1,
                    "source": source_title,
                    "output": output_title,
                }
            )
    matched = not mismatches and not source_errors and not output_errors
    return {
        "matched": matched,
        "checked": True,
        "source_count": len(source),
        "output_count": len(output),
        "mismatches": mismatches[:MAX_DETAIL_ITEMS],
        "source_errors": source_errors[:MAX_DETAIL_ITEMS],
        "output_errors": output_errors[:MAX_DETAIL_ITEMS],
        "truncated": (
            len(mismatches) > MAX_DETAIL_ITEMS
            or len(source_errors) > MAX_DETAIL_ITEMS
            or len(output_errors) > MAX_DETAIL_ITEMS
        ),
        "policy": (
            "exact item count/order/hierarchy; equivalent destination action, page, view, "
            "coordinates and zoom; exact collapse/color/bold/italic appearance; "
            "translatable English titles must not remain unchanged"
        ),
    }


def _semantic_correspondence_analysis(source_pages: list[str], output_pages: list[str]) -> dict:
    """Return whether retypeset output has deterministic lexical evidence.

    A translated retypeset document commonly has no source-language lexical
    overlap.  That is not proof of a defect, but it also means a deterministic
    verifier cannot prove semantic completeness or page order.  The caller
    therefore fails closed and requests an independent semantic review.
    """

    source_text = "\n".join(source_pages)
    output_text = "\n".join(output_pages)
    source_characters = _content_character_count(source_text)
    output_characters = _content_character_count(output_text)
    source_tokens = _page_token_counter(source_text)
    output_tokens = _page_token_counter(output_text)
    shared_occurrences = sum(
        min(source_tokens[token], output_tokens[token])
        for token in set(source_tokens) & set(output_tokens)
    )
    source_occurrences = sum(source_tokens.values())
    lexical_overlap = shared_occurrences / source_occurrences if source_occurrences else 0.0
    meaningful_source = source_characters >= 40 and source_occurrences >= 4
    needs_review = meaningful_source and output_characters > 0 and shared_occurrences == 0
    return {
        "matched": not needs_review,
        "needs_semantic_review": needs_review,
        "source_characters": source_characters,
        "output_characters": output_characters,
        "source_token_occurrences": source_occurrences,
        "shared_token_occurrences": shared_occurrences,
        "lexical_overlap": round(lexical_overlap, 6),
        "policy": "retypeset source >=40 chars with zero lexical overlap requires independent semantic review",
    }


def extract_urls(text: str) -> list[str]:
    # PDF extraction may wrap after URL punctuation.  Join only those highly
    # likely continuation points before matching.
    compact = re.sub(r"(?<=[/?=&_%#\-])(?:\r?\n)+(?=[A-Za-z0-9])", "", _normalise_text(text))
    compact = re.sub(
        r"(?<=\.)(?:\r?\n)+(?=(?:com|org|net|edu|gov|io|co|kr)(?:\b|/))",
        "",
        compact,
        flags=re.I,
    )
    return [match.group(0).rstrip(URL_TRAILING) for match in URL_RE.finditer(compact)]


def _counter_delta(source: Counter[str], output: Counter[str]) -> tuple[Counter[str], Counter[str]]:
    return source - output, output - source


def _compare_extracted(
    source_pages: list[str],
    output_pages: list[str],
    extractor: Callable[[str], Iterable[str]],
    mode: str,
) -> dict:
    mismatches = []
    total_missing: Counter[str] = Counter()
    total_unexpected: Counter[str] = Counter()

    if mode == "inplace":
        count = max(len(source_pages), len(output_pages))
        for index in range(count):
            source = Counter(extractor(source_pages[index])) if index < len(source_pages) else Counter()
            output = Counter(extractor(output_pages[index])) if index < len(output_pages) else Counter()
            missing, unexpected = _counter_delta(source, output)
            if missing or unexpected:
                total_missing.update(missing)
                total_unexpected.update(unexpected)
                mismatches.append(
                    {
                        "page": index + 1,
                        "missing": dict(missing.most_common(MAX_DETAIL_ITEMS)),
                        "unexpected": dict(unexpected.most_common(MAX_DETAIL_ITEMS)),
                    }
                )
    else:
        source = Counter(item for page in source_pages for item in extractor(page))
        output = Counter(item for page in output_pages for item in extractor(page))
        total_missing, total_unexpected = _counter_delta(source, output)
        if total_missing or total_unexpected:
            mismatches.append(
                {
                    "scope": "document",
                    "missing": dict(total_missing.most_common(MAX_DETAIL_ITEMS)),
                    "unexpected": dict(total_unexpected.most_common(MAX_DETAIL_ITEMS)),
                }
            )

    return {
        "matched": not total_missing and not total_unexpected,
        "missing_count": sum(total_missing.values()),
        "unexpected_count": sum(total_unexpected.values()),
        "missing": dict(total_missing.most_common(MAX_DETAIL_ITEMS)),
        "unexpected": dict(total_unexpected.most_common(MAX_DETAIL_ITEMS)),
        "mismatches": mismatches[:MAX_DETAIL_ITEMS],
        "truncated": len(mismatches) > MAX_DETAIL_ITEMS,
    }


def _compare_ordered_tokens(
    source_pages: list[str], output_pages: list[str], mode: str
) -> dict:
    """Compare normalized restore tokens without discarding their order."""

    def tokens(text: str) -> list[str]:
        return [
            token.casefold()
            for token in ORDER_TOKEN_RE.findall(_normalise_text(text))
        ]

    mismatches = []
    if mode == "inplace":
        scopes = [
            (
                {"page": index + 1},
                tokens(source_pages[index]) if index < len(source_pages) else [],
                tokens(output_pages[index]) if index < len(output_pages) else [],
            )
            for index in range(max(len(source_pages), len(output_pages)))
        ]
    else:
        scopes = [
            (
                {"scope": "document"},
                tokens("\n".join(source_pages)),
                tokens("\n".join(output_pages)),
            )
        ]

    for scope, source, output in scopes:
        if source == output:
            continue
        first_difference = next(
            (
                index
                for index in range(min(len(source), len(output)))
                if source[index] != output[index]
            ),
            min(len(source), len(output)),
        )
        mismatches.append(
            {
                **scope,
                "source_token_count": len(source),
                "output_token_count": len(output),
                "first_difference": first_difference,
                "source_context": source[first_difference : first_difference + 8],
                "output_context": output[first_difference : first_difference + 8],
            }
        )
    return {
        "matched": not mismatches,
        "ordered": True,
        "mismatches": mismatches[:MAX_DETAIL_ITEMS],
        "truncated": len(mismatches) > MAX_DETAIL_ITEMS,
    }


def _new_report(translated_path: str, original_path: str | None, mode: str, intent: str) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "file": os.path.basename(translated_path),
        "path": os.path.abspath(translated_path),
        "original_file": os.path.basename(original_path) if original_path else None,
        "mode": mode,
        "intent": intent,
        "pages": 0,
        "passed": False,
        "hard_failures": [],
        "exit_code": EXIT_VALIDATION_FAILED,
        "gates": {},
        "page_issues": [],
        "figures": {},
        "numbers": {},
        "formulas": {},
        "links": {},
        "summary": {},
    }


def _set_gate(
    report: dict,
    name: str,
    status: str,
    summary: str,
    *,
    details=None,
    hard: bool = True,
) -> None:
    if status not in {"pass", "fail", "skip"}:
        raise ValueError(f"invalid gate status: {status}")
    report["gates"][name] = {
        "status": status,
        "passed": status == "pass" if status != "skip" else None,
        "hard": hard,
        "summary": summary,
        "details": details if details is not None else {},
    }


def _finalise(report: dict) -> dict:
    failures = [
        name
        for name, gate in report["gates"].items()
        if gate.get("hard", True) and gate.get("status") == "fail"
    ]
    report["hard_failures"] = failures
    report["passed"] = not failures
    report["exit_code"] = EXIT_OK if report["passed"] else EXIT_VALIDATION_FAILED
    return report


def _open_pdf(path: str) -> tuple[fitz.Document | None, str | None]:
    try:
        if not os.path.isfile(path):
            return None, "file does not exist"
        doc = fitz.open(path)
        if not doc.is_pdf:
            doc.close()
            return None, "input is not a PDF"
        if doc.needs_pass:
            doc.close()
            return None, "PDF is encrypted and requires a password"
        if len(doc) == 0:
            doc.close()
            return None, "PDF contains zero pages"
        # Force every page object to parse now; fitz.open alone can be lazy.
        for page_number in range(len(doc)):
            doc.load_page(page_number)
        return doc, None
    except Exception as exc:  # malformed / truncated / unsupported PDF
        return None, f"{type(exc).__name__}: {exc}"


def _page_geometry(doc: fitz.Document) -> list[dict]:
    result = []
    for index, page in enumerate(doc):
        media = page.mediabox
        crop = page.cropbox
        rect = page.rect
        result.append(
            {
                "page": index + 1,
                "width": round(media.width, 3),
                "height": round(media.height, 3),
                "crop_width": round(crop.width, 3),
                "crop_height": round(crop.height, 3),
                "effective_width": round(rect.width, 3),
                "effective_height": round(rect.height, 3),
                "rotation": int(page.rotation),
            }
        )
    return result


def _close_size(left: float, right: float, relative_tolerance: float, absolute_tolerance: float = 1.0) -> bool:
    return abs(left - right) <= max(absolute_tolerance, abs(left) * relative_tolerance)


def _page_correspondence(source: list[dict], output: list[dict], mode: str) -> dict:
    issues = []
    source_count = len(source)
    output_count = len(output)

    if mode == "inplace":
        if source_count != output_count:
            issues.append(
                {"kind": "page_count", "source": source_count, "output": output_count, "allowed_delta": 0}
            )
        for index in range(min(source_count, output_count)):
            src = source[index]
            out = output[index]
            if not (
                _close_size(src["width"], out["width"], 0.005)
                and _close_size(src["height"], out["height"], 0.005)
            ):
                issues.append(
                    {
                        "kind": "page_size",
                        "page": index + 1,
                        "source": [src["width"], src["height"]],
                        "output": [out["width"], out["height"]],
                        "relative_tolerance": 0.005,
                    }
                )
            if not (
                _close_size(src["crop_width"], out["crop_width"], 0.005)
                and _close_size(src["crop_height"], out["crop_height"], 0.005)
            ):
                issues.append(
                    {
                        "kind": "visible_page_size",
                        "page": index + 1,
                        "source": [src["crop_width"], src["crop_height"]],
                        "output": [out["crop_width"], out["crop_height"]],
                        "relative_tolerance": 0.005,
                    }
                )
            if src["rotation"] != out["rotation"]:
                issues.append(
                    {
                        "kind": "rotation",
                        "page": index + 1,
                        "source": src["rotation"],
                        "output": out["rotation"],
                    }
                )
        policy = "exact page count; page-by-page media size within 0.5%; exact rotation"
    else:
        # Retypesetting can reflow long documents, but a one-page source turning
        # into two pages is too large a drift to approve silently.
        allowed_delta = math.floor(source_count * 0.20)
        if abs(source_count - output_count) > allowed_delta:
            issues.append(
                {
                    "kind": "page_count",
                    "source": source_count,
                    "output": output_count,
                    "allowed_delta": allowed_delta,
                }
            )
        for index in range(min(source_count, output_count)):
            src = source[index]
            out = output[index]
            if not (
                _close_size(src["effective_width"], out["effective_width"], 0.12)
                and _close_size(src["effective_height"], out["effective_height"], 0.12)
            ):
                issues.append(
                    {
                        "kind": "effective_page_size",
                        "page": index + 1,
                        "source": [src["effective_width"], src["effective_height"]],
                        "output": [out["effective_width"], out["effective_height"]],
                        "relative_tolerance": 0.12,
                    }
                )
        policy = "page-count drift <=20%; effective page size within 12%; rotation may be normalised"

    return {
        "matched": not issues,
        "policy": policy,
        "source_pages": source_count,
        "output_pages": output_count,
        "issues": issues[:MAX_DETAIL_ITEMS],
        "truncated": len(issues) > MAX_DETAIL_ITEMS,
    }


def _render_page_stats(page: fitz.Page) -> dict:
    zoom = _bounded_render_zoom(
        float(page.rect.width),
        float(page.rect.height),
        preferred_zoom=0.5,
        target_long_edge=512,
    )
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY, alpha=False, annots=True)
    samples = memoryview(pix.samples)
    non_white = sum(1 for value in samples if value < 245)
    # A corrupt page is not always literal RGB(0, 0, 0).  Dark navy / charcoal
    # overlays are equally unreadable, so use a conservative near-black luma
    # bound and compare it with the source page later.
    very_dark = sum(1 for value in samples if value < RENDER_DARK_LUMA)
    gray_total = sum(int(value) for value in samples)
    pixels = max(1, pix.width * pix.height)
    ink_ratio = non_white / pixels
    dark_ratio = very_dark / pixels
    text_characters = len(re.sub(r"\s+", "", page.get_text("text") or ""))
    image_placements = len(page.get_image_info())
    drawing_objects = len(page.get_drawings())
    visually_blank = non_white <= max(4, int(pixels * 0.00002))
    object_nonempty = bool(text_characters or image_placements or drawing_objects)
    return {
        "text_characters": text_characters,
        "image_placements": image_placements,
        "drawing_objects": drawing_objects,
        "ink_ratio": round(ink_ratio, 8),
        "dark_ratio": round(dark_ratio, 8),
        "mean_gray": round(gray_total / pixels, 3),
        "render_width": pix.width,
        "render_height": pix.height,
        "visually_blank": visually_blank,
        # Tiny but real PDF text / vector objects must not be mistaken for an
        # empty page merely because the low-resolution raster rounds to white.
        "object_nonempty": object_nonempty,
        "blank": visually_blank and not object_nonempty,
        "black": dark_ratio >= MOSTLY_BLACK_RATIO and gray_total / pixels <= 96.0,
    }


def _bounded_render_zoom(
    width: float,
    height: float,
    *,
    preferred_zoom: float,
    target_long_edge: int,
) -> float:
    """Choose a render zoom before pixmap allocation with hard pixel bounds."""

    if (
        not math.isfinite(width)
        or not math.isfinite(height)
        or width <= 0
        or height <= 0
    ):
        raise ValueError("invalid PDF page/region geometry for bounded render")
    zoom = min(float(preferred_zoom), float(target_long_edge) / max(width, height))
    if not math.isfinite(zoom) or zoom < 0.00001:
        raise ValueError("PDF page/region geometry requires an unsafe render zoom")
    predicted_width = max(1, math.ceil(width * zoom))
    predicted_height = max(1, math.ceil(height * zoom))
    if (
        predicted_width > target_long_edge + 1
        or predicted_height > target_long_edge + 1
        or predicted_width * predicted_height > target_long_edge * target_long_edge + target_long_edge * 2
    ):
        raise ValueError("bounded PDF render exceeds its predicted pixel budget")
    return zoom


def _scan_renderability(doc: fitz.Document) -> tuple[list[dict], list[dict]]:
    stats = []
    errors = []
    for index, page in enumerate(doc):
        try:
            item = _render_page_stats(page)
            item["page"] = index + 1
            stats.append(item)
        except Exception as exc:
            errors.append({"page": index + 1, "error": f"{type(exc).__name__}: {exc}"})
    return stats, errors


def _page_text_mask_rects(page: fitz.Page, padding: float = 4.0) -> list[fitz.Rect]:
    rects = []
    try:
        blocks = page.get_text("dict").get("blocks", [])
    except Exception:
        blocks = []
    for block in blocks:
        if block.get("type") != 0:
            continue
        bbox = block.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        try:
            rect = fitz.Rect(*bbox)
            if page.rotation:
                rect = rect * page.rotation_matrix
            rect = fitz.Rect(
                rect.x0 - padding,
                rect.y0 - padding,
                rect.x1 + padding,
                rect.y1 + padding,
            ) & page.rect
            if not rect.is_empty:
                rects.append(rect)
        except Exception:
            continue
    return rects


def _mark_pixel_mask(
    mask: bytearray,
    width: int,
    height: int,
    rects: list[fitz.Rect],
    zoom: float,
    pix_x: int,
    pix_y: int,
) -> None:
    for rect in rects:
        x0 = max(0, min(width, math.floor(rect.x0 * zoom - pix_x)))
        y0 = max(0, min(height, math.floor(rect.y0 * zoom - pix_y)))
        x1 = max(0, min(width, math.ceil(rect.x1 * zoom - pix_x)))
        y1 = max(0, min(height, math.ceil(rect.y1 * zoom - pix_y)))
        if x1 <= x0 or y1 <= y0:
            continue
        fill = b"\x01" * (x1 - x0)
        for y in range(y0, y1):
            start = y * width + x0
            mask[start : start + (x1 - x0)] = fill


def _compare_nontext_page(source: fitz.Page, output: fitz.Page, page_number: int) -> dict:
    """Compare same-DPI pixels outside source/output text bounding boxes."""

    # Use one equal scale on both sides, capped before allocation.  Normal
    # pages remain at 36 DPI; pathological page geometry is downscaled or
    # rejected before PyMuPDF can allocate an oversized pixmap.
    zoom = _bounded_render_zoom(
        max(float(source.rect.width), float(output.rect.width)),
        max(float(source.rect.height), float(output.rect.height)),
        preferred_zoom=0.5,
        target_long_edge=1024,
    )
    source_pix = source.get_pixmap(
        matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csRGB, alpha=False, annots=True
    )
    output_pix = output.get_pixmap(
        matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csRGB, alpha=False, annots=True
    )
    if source_pix.width != output_pix.width or source_pix.height != output_pix.height:
        return {
            "page": page_number,
            "matched": False,
            "reason": "render_dimensions_changed",
            "source_size": [source_pix.width, source_pix.height],
            "output_size": [output_pix.width, output_pix.height],
        }

    width = source_pix.width
    height = source_pix.height
    mask = bytearray(width * height)
    rects = _page_text_mask_rects(source) + _page_text_mask_rects(output)
    _mark_pixel_mask(mask, width, height, rects, zoom, source_pix.x, source_pix.y)

    source_samples = memoryview(source_pix.samples)
    output_samples = memoryview(output_pix.samples)
    unmasked = 0
    changed = 0
    large_changed = 0
    ink_state_changed = 0
    total_delta = 0
    full_large_changed = 0
    full_bright_to_dark = 0
    full_dark_to_bright = 0
    full_total_delta = 0
    for y in range(height):
        source_row = y * source_pix.stride
        output_row = y * output_pix.stride
        mask_row = y * width
        for x in range(width):
            source_offset = source_row + x * source_pix.n
            output_offset = output_row + x * output_pix.n
            deltas = [
                abs(int(source_samples[source_offset + channel]) - int(output_samples[output_offset + channel]))
                for channel in range(3)
            ]
            maximum = max(deltas)
            source_luma = (
                299 * int(source_samples[source_offset])
                + 587 * int(source_samples[source_offset + 1])
                + 114 * int(source_samples[source_offset + 2])
            ) // 1000
            output_luma = (
                299 * int(output_samples[output_offset])
                + 587 * int(output_samples[output_offset + 1])
                + 114 * int(output_samples[output_offset + 2])
            ) // 1000

            # Full-page catastrophic-change accounting is intentionally done
            # before consulting the text mask.  It catches a large overlay
            # even when a broad text-block bbox would otherwise hide it.
            full_total_delta += sum(deltas)
            if maximum >= 96:
                full_large_changed += 1
            if source_luma >= 224 and output_luma < RENDER_DARK_LUMA:
                full_bright_to_dark += 1
            if source_luma < RENDER_DARK_LUMA and output_luma >= 224:
                full_dark_to_bright += 1

            if mask[mask_row + x]:
                continue
            total_delta += sum(deltas)
            unmasked += 1
            if maximum >= 32:
                changed += 1
            if maximum >= 96:
                large_changed += 1
            if (source_luma < 245) != (output_luma < 245):
                ink_state_changed += 1

    denominator = max(1, unmasked)
    changed_ratio = changed / denominator
    large_changed_ratio = large_changed / denominator
    ink_state_ratio = ink_state_changed / denominator
    mean_channel_delta = total_delta / (denominator * 3)
    full_pixels = max(1, width * height)
    full_large_changed_ratio = full_large_changed / full_pixels
    full_bright_to_dark_ratio = full_bright_to_dark / full_pixels
    full_dark_to_bright_ratio = full_dark_to_bright / full_pixels
    full_mean_channel_delta = full_total_delta / (full_pixels * 3)
    catastrophic_change = (
        full_bright_to_dark_ratio > GLOBAL_BRIGHT_DARK_CHANGE_RATIO
        or full_dark_to_bright_ratio > GLOBAL_BRIGHT_DARK_CHANGE_RATIO
        or full_large_changed_ratio > GLOBAL_LARGE_CHANGE_RATIO
        or full_mean_channel_delta > GLOBAL_MEAN_CHANNEL_DELTA
    )
    masked_regions_matched = not (
        changed_ratio > 0.002
        and (
            large_changed_ratio > 0.0005
            or ink_state_ratio > 0.001
            or mean_channel_delta > 0.5
        )
    )
    matched = masked_regions_matched and not catastrophic_change
    return {
        "page": page_number,
        "matched": matched,
        "render_dpi": round(72 * zoom, 3),
        "unmasked_pixels": unmasked,
        "text_mask_ratio": round(1.0 - unmasked / max(1, width * height), 6),
        "changed_pixel_ratio": round(changed_ratio, 6),
        "large_change_ratio": round(large_changed_ratio, 6),
        "ink_state_change_ratio": round(ink_state_ratio, 6),
        "mean_channel_delta": round(mean_channel_delta, 4),
        "global_large_change_ratio": round(full_large_changed_ratio, 6),
        "global_bright_to_dark_ratio": round(full_bright_to_dark_ratio, 6),
        "global_dark_to_bright_ratio": round(full_dark_to_bright_ratio, 6),
        "global_mean_channel_delta": round(full_mean_channel_delta, 4),
        "catastrophic_global_change": catastrophic_change,
    }


def _inplace_nontext_visual_comparison(
    source: fitz.Document, output: fitz.Document
) -> dict:
    pages = []
    errors = []
    count = min(len(source), len(output))
    for index in range(count):
        try:
            pages.append(_compare_nontext_page(source[index], output[index], index + 1))
        except Exception as exc:
            errors.append({"page": index + 1, "error": f"{type(exc).__name__}: {exc}"})
    if len(source) != len(output):
        errors.append({"error": "page_count_changed", "source": len(source), "output": len(output)})
    mismatches = [item for item in pages if not item.get("matched")]
    return {
        "matched": not mismatches and not errors,
        "policy": (
            "same bounded-DPI RGB comparison outside padded source/output text masks; "
            "mask-independent full-page catastrophic-change guard"
        ),
        "mismatches": mismatches[:MAX_DETAIL_ITEMS],
        "errors": errors[:MAX_DETAIL_ITEMS],
        "pages_compared": len(pages),
        "truncated": len(mismatches) > MAX_DETAIL_ITEMS or len(errors) > MAX_DETAIL_ITEMS,
    }


def _meaningful_vector_pages(doc: fitz.Document) -> dict:
    pages = []
    for page_number, page in enumerate(doc, 1):
        try:
            drawings = page.get_drawings()
        except Exception as exc:
            pages.append(
                {
                    "page": page_number,
                    "meaningful": True,
                    "needs_visual_review": True,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
            continue
        rects = []
        individual = 0
        page_area = max(1.0, float(page.rect.width) * float(page.rect.height))
        for drawing in drawings:
            try:
                rect = fitz.Rect(drawing.get("rect")) & page.rect
            except Exception:
                continue
            if rect.is_empty:
                continue
            rects.append(rect)
            if rect.width >= 12 and rect.height >= 12 and abs(rect) / page_area >= 0.002:
                individual += 1
        union = None
        for rect in rects:
            union = fitz.Rect(rect) if union is None else union | rect
        union_coverage = abs(union) / page_area if union is not None else 0.0
        meaningful = individual > 0 or (len(rects) >= 2 and union_coverage >= 0.005)
        if meaningful:
            pages.append(
                {
                    "page": page_number,
                    "meaningful": True,
                    "drawing_objects": len(drawings),
                    "meaningful_individual_objects": individual,
                    "union_page_coverage": round(union_coverage, 6),
                }
            )
    return {
        "meaningful": bool(pages),
        "needs_visual_review": bool(pages),
        "pages": pages[:MAX_DETAIL_ITEMS],
        "truncated": len(pages) > MAX_DETAIL_ITEMS,
    }


def _pixmap_visual_signature(pix: fitz.Pixmap) -> dict:
    """Return a small deterministic perceptual signature for a rendered region."""

    if pix.colorspace != fitz.csRGB or pix.n not in (3, 4):
        pix = fitz.Pixmap(fitz.csRGB, pix)
    samples = memoryview(pix.samples)
    channels = pix.n
    width = max(1, pix.width)
    height = max(1, pix.height)

    def rgb_at(grid_x: int, grid_y: int, columns: int, rows: int) -> tuple[int, int, int]:
        x = min(width - 1, max(0, int((grid_x + 0.5) * width / columns)))
        y = min(height - 1, max(0, int((grid_y + 0.5) * height / rows)))
        offset = y * pix.stride + x * channels
        return int(samples[offset]), int(samples[offset + 1]), int(samples[offset + 2])

    # 64-bit dHash: robust to encoding and moderate resizing while preserving
    # enough region structure to reject unrelated figures.
    bits = 0
    bit_index = 0
    for y in range(8):
        row = []
        for x in range(9):
            red, green, blue = rgb_at(x, y, 9, 8)
            row.append((299 * red + 587 * green + 114 * blue) // 1000)
        for x in range(8):
            if row[x] > row[x + 1]:
                bits |= 1 << bit_index
            bit_index += 1

    totals = [0, 0, 0]
    sample_count = 0
    for y in range(16):
        for x in range(16):
            pixel = rgb_at(x, y, 16, 16)
            for channel in range(3):
                totals[channel] += pixel[channel]
            sample_count += 1
    mean_rgb = [round(total / sample_count, 2) for total in totals]
    return {
        "method": "dhash-8x8+mean-rgb",
        "perceptual_hash": f"{bits:016x}",
        "mean_rgb": mean_rgb,
        "aspect_ratio": round(width / height, 6),
    }


def _render_region_signature(page: fitz.Page, bbox: list[float]) -> dict:
    rect = fitz.Rect(*bbox) & page.rect
    if rect.is_empty or rect.width <= 0 or rect.height <= 0:
        raise ValueError("image bbox is empty")
    zoom = _bounded_render_zoom(
        float(rect.width),
        float(rect.height),
        preferred_zoom=2.0,
        target_long_edge=160,
    )
    pix = page.get_pixmap(
        matrix=fitz.Matrix(zoom, zoom),
        clip=rect,
        colorspace=fitz.csRGB,
        alpha=False,
        annots=False,
    )
    return _pixmap_visual_signature(pix)


def _perceptual_distance(left: dict, right: dict) -> dict:
    hash_distance = (
        int(left["perceptual_hash"], 16) ^ int(right["perceptual_hash"], 16)
    ).bit_count()
    color_distance = math.sqrt(
        sum((float(a) - float(b)) ** 2 for a, b in zip(left["mean_rgb"], right["mean_rgb"]))
    )
    left_aspect = max(0.0001, float(left["aspect_ratio"]))
    right_aspect = max(0.0001, float(right["aspect_ratio"]))
    aspect_ratio_factor = max(left_aspect, right_aspect) / min(left_aspect, right_aspect)
    return {
        "hash_distance": hash_distance,
        "color_distance": round(color_distance, 3),
        "aspect_ratio_factor": round(aspect_ratio_factor, 4),
        "matched": hash_distance <= 16 and color_distance <= 80 and aspect_ratio_factor <= 1.5,
    }


def _image_occurrences(doc: fitz.Document) -> tuple[dict[str, list[dict]], list[dict]]:
    groups: dict[str, list[dict]] = {}
    errors = []
    for page_number, page in enumerate(doc, 1):
        try:
            infos = page.get_image_info(hashes=True, xrefs=True)
            for info in infos:
                digest = info.get("digest")
                if isinstance(digest, bytes):
                    digest = digest.hex()
                if not digest:
                    xref = int(info.get("xref") or 0)
                    if xref:
                        pix = fitz.Pixmap(doc, xref)
                        digest = hashlib.sha256(pix.samples).hexdigest()
                    else:
                        errors.append({"page": page_number, "error": "image placement has no digest or xref"})
                        continue
                key = f"{info.get('width', '?')}x{info.get('height', '?')}:{digest}"
                bbox = [round(float(value), 2) for value in info.get("bbox", ())]
                page_area = max(1.0, float(page.rect.width) * float(page.rect.height))
                bbox_area = 0.0
                if len(bbox) == 4:
                    bbox_area = max(0.0, bbox[2] - bbox[0]) * max(0.0, bbox[3] - bbox[1])
                occurrence = {
                    "page": page_number,
                    "xref": int(info.get("xref") or 0),
                    "digest_key": key,
                    "bbox": bbox,
                    "page_coverage": round(min(1.0, bbox_area / page_area), 6),
                }
                try:
                    occurrence["visual_signature"] = _render_region_signature(page, bbox)
                except Exception as exc:
                    occurrence["visual_signature"] = None
                    errors.append(
                        {
                            "page": page_number,
                            "error": f"image visual signature failed: {type(exc).__name__}: {exc}",
                        }
                    )
                groups.setdefault(key, []).append(occurrence)
        except Exception as exc:
            errors.append({"page": page_number, "error": f"{type(exc).__name__}: {exc}"})
    return groups, errors


def image_hashes(page: fitz.Page) -> list[tuple[int, str | None]]:
    """Backward-compatible helper retained for callers of the old script."""

    result = []
    try:
        for info in page.get_image_info(hashes=True, xrefs=True):
            digest = info.get("digest")
            if isinstance(digest, bytes):
                digest = digest.hex()
            result.append((int(info.get("xref") or 0), digest))
    except Exception:
        pass
    return result


def _duplicate_analysis(output: dict[str, list[dict]], source: dict[str, list[dict]] | None) -> dict:
    duplicate_groups = []
    suspicious = []
    for digest, occurrences in output.items():
        if len(occurrences) < 2:
            continue
        source_count = len(source.get(digest, [])) if source is not None else 0
        item = {
            "digest": digest,
            "pages": [occurrence["page"] for occurrence in occurrences],
            "count": len(occurrences),
            "source_count": source_count,
        }
        duplicate_groups.append(item)
        # One occurrence is not a duplicate.  Repetition beyond the exact
        # decoded-image count in the source is a newly introduced duplicate.
        allowed = max(1, source_count)
        if len(occurrences) > allowed:
            suspicious.append(item)
    return {
        "duplicate_groups": duplicate_groups,
        "suspicious_duplicate_groups": suspicious,
    }


def _retypeset_image_preservation(
    source: dict[str, list[dict]], output: dict[str, list[dict]]
) -> dict:
    source_all = [occurrence for occurrences in source.values() for occurrence in occurrences]
    output_all = [occurrence for occurrences in output.values() for occurrence in occurrences]
    source_full_page = [item for item in source_all if item.get("page_coverage", 0) >= 0.80]
    source_content = [item for item in source_all if item.get("page_coverage", 0) < 0.80]
    output_full_page = [item for item in output_all if item.get("page_coverage", 0) >= 0.80]
    output_content = [item for item in output_all if item.get("page_coverage", 0) < 0.80]

    if any(item.get("visual_signature") is None for item in source_all + output_all):
        return {
            "matched": False,
            "needs_visual_review": True,
            "reason": "one or more image regions have no reliable visual signature",
            "source_full_page_rasters": len(source_full_page),
            "output_full_page_rasters": len(output_full_page),
            "source_content_occurrences": len(source_content),
            "output_content_occurrences": len(output_content),
            "required_preservation_ratio": 1.0,
            "matches": [],
            "unmatched": [],
            "unexpected_output": [],
        }

    # Full-page scans may only auto-pass when the decoded raster is exactly the
    # same.  A vector/OCR replacement needs independent semantic review and is
    # therefore rejected by this deterministic gate.
    available_full = set(range(len(output_full_page)))
    matches = []
    unmatched = []
    for source_item in source_full_page:
        candidate = next(
            (
                index
                for index in available_full
                if output_full_page[index].get("digest_key") == source_item.get("digest_key")
                and output_full_page[index].get("page") == source_item.get("page")
            ),
            None,
        )
        if candidate is None:
            unmatched.append(
                {
                    "kind": "full_page_raster",
                    "source_page": source_item["page"],
                    "source_bbox": source_item["bbox"],
                    "reason": "exact_full_page_raster_not_found",
                }
            )
        else:
            available_full.remove(candidate)
            matches.append(
                {
                    "kind": "full_page_raster_exact",
                    "source_page": source_item["page"],
                    "output_page": output_full_page[candidate]["page"],
                }
            )

    available = set(range(len(output_content)))
    for source_item in source_content:
        candidates = []
        for output_index in available:
            output_item = output_content[output_index]
            distance = _perceptual_distance(
                source_item["visual_signature"], output_item["visual_signature"]
            )
            score = (
                distance["hash_distance"]
                + distance["color_distance"] / 10
                + (distance["aspect_ratio_factor"] - 1) * 10
            )
            candidates.append((score, output_index, output_item, distance))
        candidates.sort(key=lambda item: item[0])
        best = candidates[0] if candidates else None
        if best and best[3]["matched"]:
            _score, output_index, output_item, distance = best
            available.remove(output_index)
            matches.append(
                {
                    "kind": "content_image_perceptual",
                    "source_page": source_item["page"],
                    "output_page": output_item["page"],
                    **distance,
                }
            )
        else:
            unmatched.append(
                {
                    "source_page": source_item["page"],
                    "source_bbox": source_item["bbox"],
                    "best_distance": best[3] if best else None,
                }
            )

    unexpected_output = [
        {
            "kind": "full_page_raster",
            "output_page": output_full_page[index]["page"],
            "output_bbox": output_full_page[index]["bbox"],
        }
        for index in sorted(available_full)
    ] + [
        {
            "kind": "content_image",
            "output_page": output_content[index]["page"],
            "output_bbox": output_content[index]["bbox"],
        }
        for index in sorted(available)
    ]
    needs_review = bool(unmatched or unexpected_output)

    return {
        "matched": not needs_review,
        "needs_visual_review": needs_review,
        "reason": (
            None
            if not needs_review
            else "source images are missing/changed or output contains images without source provenance"
        ),
        "source_full_page_rasters": len(source_full_page),
        "output_full_page_rasters": len(output_full_page),
        "source_content_occurrences": len(source_content),
        "output_content_occurrences": len(output_content),
        "required_preservation_ratio": 1.0,
        "matches": matches[:MAX_DETAIL_ITEMS],
        "unmatched": unmatched[:MAX_DETAIL_ITEMS],
        "unexpected_output": unexpected_output[:MAX_DETAIL_ITEMS],
        "truncated": (
            len(matches) > MAX_DETAIL_ITEMS
            or len(unmatched) > MAX_DETAIL_ITEMS
            or len(unexpected_output) > MAX_DETAIL_ITEMS
        ),
    }


def _inplace_image_preservation(
    source: dict[str, list[dict]], output: dict[str, list[dict]]
) -> dict:
    source_all = [occurrence for occurrences in source.values() for occurrence in occurrences]
    output_all = [occurrence for occurrences in output.values() for occurrence in occurrences]
    source_full_page = [item for item in source_all if item.get("page_coverage", 0) >= 0.80]

    unmatched_source = []
    unmatched_output = []
    for digest in set(source) | set(output):
        source_items = source.get(digest, [])
        output_items = output.get(digest, [])
        available = set(range(len(output_items)))
        for source_item in source_items:
            candidates = []
            for output_index in available:
                output_item = output_items[output_index]
                if source_item["page"] != output_item["page"]:
                    continue
                left = source_item.get("bbox", [])
                right = output_item.get("bbox", [])
                if len(left) != 4 or len(right) != 4:
                    continue
                delta = max(abs(float(a) - float(b)) for a, b in zip(left, right))
                candidates.append((delta, output_index))
            candidates.sort()
            if candidates and candidates[0][0] <= 2.0:
                available.remove(candidates[0][1])
            else:
                unmatched_source.append(
                    {"digest": digest, "page": source_item["page"], "bbox": source_item.get("bbox")}
                )
        for output_index in available:
            output_item = output_items[output_index]
            unmatched_output.append(
                {"digest": digest, "page": output_item["page"], "bbox": output_item.get("bbox")}
            )
    return {
        "matched": not unmatched_source and not unmatched_output,
        "needs_visual_review": False,
        "reason": None if not unmatched_source and not unmatched_output else "image pixels, page, placement, or count changed",
        "source_full_page_rasters": len(source_full_page),
        "bbox_tolerance_points": 2.0,
        "unmatched_source": unmatched_source[:MAX_DETAIL_ITEMS],
        "unmatched_output": unmatched_output[:MAX_DETAIL_ITEMS],
        "truncated": len(unmatched_source) > MAX_DETAIL_ITEMS or len(unmatched_output) > MAX_DETAIL_ITEMS,
    }


SAFE_ACTIVE_URI_SCHEMES = {"http", "https", "mailto"}
ACTIVE_URI_SCHEME_RE = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*):")
LOCAL_DESTINATION_ARITY = {
    "Fit": 0,
    "FitB": 0,
    "FitH": 1,
    "FitBH": 1,
    "FitV": 1,
    "FitBV": 1,
    "FitR": 4,
    "XYZ": 3,
}
PDF_DESTINATION_ARGUMENT_RE = re.compile(
    r"(?:null|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?)$"
)


def _link_rect(link: dict) -> list[float] | None:
    try:
        rect = fitz.Rect(link.get("from"))
    except Exception:
        return None
    values = [float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1)]
    if not all(math.isfinite(value) for value in values) or rect.is_empty:
        return None
    return [round(value, 3) for value in values]


def _safe_external_uri(uri: str) -> bool:
    """Mirror the renderer's allowlist for URI actions safe to preserve."""

    if not isinstance(uri, str) or not uri or uri != uri.strip():
        return False
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in uri):
        return False
    match = ACTIVE_URI_SCHEME_RE.match(uri)
    return bool(match and match.group(1).lower() in SAFE_ACTIVE_URI_SCHEMES)


def _raw_local_destination(doc: fitz.Document, annotation_xref: int) -> dict | None:
    if annotation_xref <= 0:
        return None
    try:
        dest_type, dest_value = doc.xref_get_key(annotation_xref, "Dest")
        if dest_type != "null":
            return {"container": "Dest", "type": dest_type, "value": dest_value}
        action_type, action_name = doc.xref_get_key(annotation_xref, "A/S")
        if action_type == "name" and action_name == "/GoTo":
            dest_type, dest_value = doc.xref_get_key(annotation_xref, "A/D")
            if dest_type != "null":
                return {"container": "A/D", "type": dest_type, "value": dest_value}
    except Exception:
        return None
    return None


def _parse_explicit_local_destination(raw: dict | None, page_by_xref: dict[int, int]) -> dict | None:
    if not raw or raw.get("type") != "array":
        return None
    match = re.fullmatch(
        r"\[\s*(\d+)\s+(\d+)\s+R\s*/([A-Za-z]+)(.*?)\s*\]",
        str(raw.get("value", "")),
        flags=re.DOTALL,
    )
    if not match:
        return None
    target_page = page_by_xref.get(int(match.group(1)))
    view = match.group(3)
    if target_page is None or view not in LOCAL_DESTINATION_ARITY:
        return None
    argument_text = match.group(4).strip()
    raw_arguments = tuple(argument_text.split()) if argument_text else ()
    if len(raw_arguments) != LOCAL_DESTINATION_ARITY[view]:
        return None
    if any(not PDF_DESTINATION_ARGUMENT_RE.fullmatch(value) for value in raw_arguments):
        return None
    arguments = []
    for value in raw_arguments:
        if value == "null":
            arguments.append(None)
            continue
        number = float(value)
        if not math.isfinite(number):
            return None
        arguments.append(number)
    return {
        "container": raw["container"],
        "target_page": target_page,
        "view": view,
        "arguments": arguments,
    }


def _resolve_internal_target(
    doc: fitz.Document, link: dict, resolved_names: dict
) -> int | None:
    """Return a zero-based target page for safe GoTo / named destinations."""

    kind = int(link.get("kind", fitz.LINK_NONE) or fitz.LINK_NONE)
    raw_page = link.get("page")
    if kind == fitz.LINK_GOTO:
        try:
            page = int(raw_page)
        except (TypeError, ValueError):
            return None
        return page if 0 <= page < len(doc) else None
    if kind != fitz.LINK_NAMED:
        return None

    # PyMuPDF exposes direct /Dest arrays produced by ReportLab as LINK_NAMED
    # with a one-based numeric string (e.g. "1").  A reconstructed link is a
    # regular zero-based LINK_GOTO; both normalize to the same target page.
    if isinstance(raw_page, str) and raw_page.strip().isdigit():
        page = int(raw_page.strip()) - 1
        return page if 0 <= page < len(doc) else None
    if isinstance(raw_page, int):
        return raw_page if 0 <= raw_page < len(doc) else None

    name = str(
        link.get("name")
        or link.get("nameddest")
        or (raw_page if isinstance(raw_page, str) else "")
    ).strip()
    if not name:
        return None
    candidates = (name, name.lstrip("/"), f"/{name.lstrip('/')}")
    for candidate in candidates:
        destination = resolved_names.get(candidate)
        if not isinstance(destination, dict):
            continue
        try:
            page = int(destination.get("page"))
        except (TypeError, ValueError):
            continue
        if 0 <= page < len(doc):
            return page
    try:
        resolved_page, _x, _y = doc.resolve_link(name)
        page = int(resolved_page)
        if 0 <= page < len(doc):
            return page
    except Exception:
        pass
    return None


_RAW_INDIRECT_REFERENCE_RE = re.compile(r"(?<!\d)(\d+)\s+(\d+)\s+R(?!\w)")


def _raw_page_annotation_xrefs(doc: fitz.Document, page: fitz.Page) -> list[int]:
    value_type, raw_value = doc.xref_get_key(int(page.xref), "Annots")
    if value_type == "null":
        return []
    if value_type == "xref":
        array_xref = int(str(raw_value).split()[0])
        raw_value = doc.xref_object(array_xref, compressed=False)
    elif value_type != "array":
        raise ValueError("unsupported raw annotation array representation")
    text = str(raw_value or "").strip()
    if not text.startswith("[") or not text.endswith("]"):
        raise ValueError("malformed raw annotation array")
    matches = list(_RAW_INDIRECT_REFERENCE_RE.finditer(text))
    if any(match.group(2) != "0" for match in matches):
        raise ValueError("raw annotation array uses an unsupported generation")
    refs = [int(match.group(1)) for match in matches]
    remainder = _RAW_INDIRECT_REFERENCE_RE.sub("", text)
    remainder = re.sub(r"%[^\r\n]*", "", remainder)
    if re.sub(r"[\[\]\s]", "", remainder):
        raise ValueError("raw annotation array contains a non-reference item")
    if len(refs) != len(set(refs)):
        raise ValueError("raw annotation array contains duplicate references")
    if any(xref <= 0 or xref >= doc.xref_length() for xref in refs):
        raise ValueError("raw annotation array contains an invalid reference")
    return refs


def _raw_annotation_action_name(doc: fitz.Document, xref: int) -> str:
    action_type, action_name = doc.xref_get_key(xref, "A/S")
    if action_type == "name":
        return str(action_name)
    dest_type, _dest_value = doc.xref_get_key(xref, "Dest")
    if dest_type != "null":
        return "/Dest"
    return "unknown"


def _raw_annotation_rect(doc: fitz.Document, page: fitz.Page, xref: int) -> list[float] | None:
    value_type, raw_value = doc.xref_get_key(xref, "Rect")
    if value_type != "array":
        return None
    values = re.findall(
        r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?", str(raw_value)
    )
    if len(values) != 4:
        return None
    try:
        rect = fitz.Rect(*(float(value) for value in values)) * page.transformation_matrix
        rect.normalize()
        return [round(float(value), 3) for value in rect]
    except Exception:
        return None


def _extract_link_inventory(doc: fitz.Document) -> tuple[dict, list[dict]]:
    safe_uri_pages: list[list[str]] = []
    internal = []
    unsafe = []
    errors = []
    try:
        resolved_names = doc.resolve_names() or {}
    except Exception as exc:
        resolved_names = {}
        errors.append({"error": f"named destination resolution failed: {type(exc).__name__}: {exc}"})
    page_by_xref = {doc.page_xref(page): page for page in range(len(doc))}

    for source_page, page in enumerate(doc, 1):
        safe_uris = []
        page_aa_type, _page_aa_value = doc.xref_get_key(page.xref, "AA")
        if page_aa_type != "null":
            unsafe.append(
                {
                    "source_page": source_page,
                    "kind": "page_additional_action",
                    "action_kind": "page_AA",
                    "xref": int(page.xref),
                    "rect": None,
                }
            )
        try:
            raw_annotation_xrefs = _raw_page_annotation_xrefs(doc, page)
        except Exception as exc:
            errors.append(
                {
                    "page": source_page,
                    "error": f"raw annotation scan failed: {type(exc).__name__}: {exc}",
                }
            )
            raw_annotation_xrefs = []
        for annotation_xref in raw_annotation_xrefs:
            subtype_type, subtype = doc.xref_get_key(annotation_xref, "Subtype")
            action_type, _action_value = doc.xref_get_key(annotation_xref, "A")
            aa_type, _aa_value = doc.xref_get_key(annotation_xref, "AA")
            rect = _raw_annotation_rect(doc, page, annotation_xref)
            if aa_type != "null":
                unsafe.append(
                    {
                        "source_page": source_page,
                        "kind": "additional_action",
                        "action_kind": _raw_annotation_action_name(
                            doc, annotation_xref
                        ),
                        "xref": annotation_xref,
                        "rect": rect,
                    }
                )
                continue
            if subtype_type == "name" and subtype == "/Link":
                action_name = _raw_annotation_action_name(doc, annotation_xref)
                if action_name == "/URI":
                    uri_type, uri_value = doc.xref_get_key(annotation_xref, "A/URI")
                    uri = str(uri_value) if uri_type == "string" else ""
                    if not _safe_external_uri(uri):
                        unsafe.append(
                            {
                                "source_page": source_page,
                                "kind": "unsafe_uri",
                                "uri": uri,
                                "rect": rect,
                            }
                        )
                    else:
                        safe_uris.append(uri)
                    continue

                raw_destination = _raw_local_destination(doc, annotation_xref)
                if action_name in {"/GoTo", "/Dest"} and raw_destination:
                    explicit_destination = _parse_explicit_local_destination(
                        raw_destination, page_by_xref
                    )
                    target_page = None
                    named_resolved = False
                    if explicit_destination is not None:
                        target_page = explicit_destination["target_page"]
                        destination = explicit_destination
                    elif raw_destination.get("type") in {"name", "string"}:
                        name = str(raw_destination.get("value") or "")
                        candidates = (name, name.lstrip("/"), f"/{name.lstrip('/')}")
                        for candidate in candidates:
                            item = resolved_names.get(candidate)
                            if isinstance(item, dict) and isinstance(item.get("page"), int):
                                target_page = int(item["page"])
                                break
                        if target_page is None:
                            try:
                                resolved_page, _x, _y = doc.resolve_link(name)
                                target_page = int(resolved_page)
                            except Exception:
                                target_page = None
                        named_resolved = target_page is not None
                        destination = {
                            "container": "named",
                            "view": "named",
                            "arguments": [],
                        }
                    else:
                        destination = None
                    if (
                        destination is not None
                        and target_page is not None
                        and 0 <= target_page < len(doc)
                        and rect is not None
                    ):
                        internal.append(
                            {
                                "source_page": source_page,
                                "target_page": target_page + 1,
                                "rect": rect,
                                "destination_container": destination["container"],
                                "destination_view": destination["view"],
                                "destination_arguments": destination["arguments"],
                                "named_resolved": named_resolved,
                            }
                        )
                        continue
                    unsafe.append(
                        {
                            "source_page": source_page,
                            "kind": "opaque_or_unresolved_internal_destination",
                            "name": str(raw_destination.get("value") or ""),
                            "raw_destination_type": raw_destination.get("type"),
                            "rect": rect,
                        }
                    )
                    continue

                unsafe.append(
                    {
                        "source_page": source_page,
                        "kind": {
                            "/GoToR": "remote_goto",
                            "/Launch": "launch",
                        }.get(action_name, "unsupported_action"),
                        "action_kind": action_name,
                        "xref": annotation_xref,
                        "rect": rect,
                    }
                )
            elif action_type != "null":
                unsafe.append(
                    {
                        "source_page": source_page,
                        "kind": "active_non_link_annotation",
                        "action_kind": _raw_annotation_action_name(
                            doc, annotation_xref
                        ),
                        "xref": annotation_xref,
                        "rect": None,
                    }
                )
        safe_uri_pages.append(safe_uris)
    return {
        "safe_uri_pages": safe_uri_pages,
        "internal": internal,
        "unsafe": unsafe,
    }, errors


def _destination_arguments_equal(source: list, output: list, tolerance: float = 1e-6) -> bool:
    if len(source) != len(output):
        return False
    for left, right in zip(source, output):
        if left is None or right is None:
            if left is not None or right is not None:
                return False
            continue
        try:
            if abs(float(left) - float(right)) > tolerance:
                return False
        except (TypeError, ValueError):
            return False
    return True


def _destination_semantics_match(source: dict, output: dict) -> tuple[bool, str]:
    # A genuinely named source destination may be resolved to an explicit local
    # target by a safe renderer.  Explicit source arrays, however, must retain
    # their storage container, view mode, arity, nulls, and numeric arguments.
    if source.get("named_resolved"):
        return True, "named_source_resolved_to_safe_target"
    if output.get("named_resolved"):
        return False, "explicit_source_became_named_destination"
    if source.get("destination_container") != output.get("destination_container"):
        return False, "destination_container_changed"
    if source.get("destination_view") != output.get("destination_view"):
        return False, "destination_view_changed"
    if not _destination_arguments_equal(
        source.get("destination_arguments", []),
        output.get("destination_arguments", []),
    ):
        return False, "destination_arguments_changed"
    return True, "exact_explicit_destination"


def _compare_internal_links(
    source: list[dict], output: list[dict], rect_tolerance: float = 2.0
) -> dict:
    available = set(range(len(output)))
    matches = []
    unmatched_source = []
    for source_item in source:
        candidates = []
        for output_index in available:
            output_item = output[output_index]
            if (
                source_item["source_page"] != output_item["source_page"]
                or source_item["target_page"] != output_item["target_page"]
            ):
                continue
            semantics_match, semantics_reason = _destination_semantics_match(
                source_item, output_item
            )
            delta = max(
                abs(float(left) - float(right))
                for left, right in zip(source_item["rect"], output_item["rect"])
            )
            candidates.append(
                (not semantics_match, delta, output_index, output_item, semantics_reason)
            )
        candidates.sort(key=lambda item: (item[0], item[1]))
        best = candidates[0] if candidates else None
        if best and not best[0] and best[1] <= rect_tolerance:
            available.remove(best[2])
            matches.append(
                {
                    "source_page": source_item["source_page"],
                    "target_page": source_item["target_page"],
                    "rect_delta": round(best[1], 3),
                    "destination_container": source_item.get("destination_container"),
                    "destination_view": source_item.get("destination_view"),
                    "destination_arguments": source_item.get("destination_arguments", []),
                    "semantic_equivalence": best[4],
                }
            )
        else:
            unmatched_source.append(
                {
                    **source_item,
                    "best_rect_delta": round(best[1], 3) if best else None,
                    "best_semantics": best[4] if best else None,
                }
            )
    unexpected_output = [output[index] for index in sorted(available)]
    return {
        "matched": not unmatched_source and not unexpected_output,
        "rect_tolerance_points": rect_tolerance,
        "destination_argument_tolerance": 1e-6,
        "source_count": len(source),
        "output_count": len(output),
        "matches": matches[:MAX_DETAIL_ITEMS],
        "unmatched_source": unmatched_source[:MAX_DETAIL_ITEMS],
        "unexpected_output": unexpected_output[:MAX_DETAIL_ITEMS],
        "truncated": (
            len(matches) > MAX_DETAIL_ITEMS
            or len(unmatched_source) > MAX_DETAIL_ITEMS
            or len(unexpected_output) > MAX_DETAIL_ITEMS
        ),
    }


def _compare_page_items(source_pages: list[list[str]], output_pages: list[list[str]], mode: str) -> dict:
    return _compare_extracted(source_pages, output_pages, lambda values: values, mode)


def verify(
    translated_path: str,
    original_path: str | None = None,
    mode: str = "inplace",
    intent: str = "translate",
    ocr_source_path: str | None = None,
) -> dict:
    """Verify one output PDF and return a stable, JSON-serialisable report."""

    if mode not in {"inplace", "retypeset"}:
        raise ValueError("mode must be 'inplace' or 'retypeset'")
    if intent not in {"translate", "restore"}:
        raise ValueError("intent must be 'translate' or 'restore'")
    ocr_source_bundle = (
        _load_ocr_source_bundle(ocr_source_path, original_path, mode)
        if ocr_source_path
        else None
    )

    report = _new_report(translated_path, original_path, mode, intent)
    output_doc, output_error = _open_pdf(translated_path)
    source_doc = None
    source_error = None
    if original_path:
        source_doc, source_error = _open_pdf(original_path)

    try:
        if output_doc is None:
            _set_gate(report, "pdf_open", "fail", "출력 PDF를 열고 파싱할 수 없음", details={"error": output_error})
        else:
            report["pages"] = len(output_doc)
            _set_gate(report, "pdf_open", "pass", f"출력 PDF {len(output_doc)}쪽을 모두 파싱함")

        if not original_path:
            _set_gate(report, "source_pdf_open", "skip", "원문 PDF가 제공되지 않음")
        elif source_doc is None:
            _set_gate(
                report,
                "source_pdf_open",
                "fail",
                "원문 PDF를 열고 파싱할 수 없음",
                details={"error": source_error},
            )
        else:
            _set_gate(report, "source_pdf_open", "pass", f"원문 PDF {len(source_doc)}쪽을 모두 파싱함")

        # Keep the schema complete even when opening failed.
        if output_doc is None:
            for name in (
                "page_correspondence",
                "page_render",
                "blank_pages",
                "black_pages",
                "nontext_visual_preservation",
                "vector_provenance",
                "content_coverage",
                "page_order",
                "semantic_correspondence",
                "text_preservation",
                "raw_markers",
                "garbling",
                "untranslated_text",
                "number_preservation",
                "unit_preservation",
                "chemical_formula_preservation",
                "url_preservation",
                "image_duplicates",
                "image_preservation",
                "link_preservation",
            ):
                _set_gate(report, name, "skip", "출력 PDF를 열 수 없어 검사하지 못함")
            report["summary"] = {
                "pages_with_issues": 0,
                "raw_marker_pages": 0,
                "garbled_pages": 0,
                "untranslated_pages": 0,
                "black_pages": 0,
                "duplicate_image_groups": 0,
            }
            return _finalise(report)

        output_geometry = _page_geometry(output_doc)
        if source_doc is None:
            _set_gate(report, "page_correspondence", "skip", "원문 PDF가 없어 페이지 대응을 비교하지 못함")
        else:
            correspondence = _page_correspondence(_page_geometry(source_doc), output_geometry, mode)
            if mode == "inplace":
                stable_anchors = _stable_anchor_correspondence(source_doc, output_doc)
                correspondence["stable_anchors"] = stable_anchors
                if not stable_anchors["matched"]:
                    correspondence["matched"] = False
                    correspondence["issues"].append(
                        {
                            "kind": "stable_anchor_drift",
                            "mismatch_count": len(stable_anchors["mismatches"]),
                            "truncated": stable_anchors["truncated"],
                        }
                    )
                metadata_comparison = _metadata_translation_analysis(
                    source_doc, output_doc, intent, mode
                )
                correspondence["metadata"] = metadata_comparison
                if not metadata_comparison["matched"]:
                    correspondence["matched"] = False
                    correspondence["issues"].append(
                        {
                            "kind": "metadata_translation_or_preservation",
                            "untranslated_fields": len(
                                metadata_comparison["untranslated_fields"]
                            ),
                            "missing_translations": len(
                                metadata_comparison["missing_translations"]
                            ),
                            "preserved_field_changes": len(
                                metadata_comparison["preserved_field_changes"]
                            ),
                            "xmp_errors": len(
                                metadata_comparison["xmp"].get("errors", [])
                            ),
                            "xmp_untranslated_fields": len(
                                metadata_comparison["xmp"].get(
                                    "untranslated_fields", []
                                )
                            ),
                            "xmp_missing_translations": len(
                                metadata_comparison["xmp"].get(
                                    "missing_translations", []
                                )
                            ),
                            "xmp_preserved_target_changes": len(
                                metadata_comparison["xmp"].get(
                                    "preserved_target_changes", []
                                )
                            ),
                            "xmp_non_target_changed": bool(
                                metadata_comparison["xmp"].get(
                                    "non_target_changed", False
                                )
                            ),
                        }
                    )
            else:
                correspondence["stable_anchors"] = {
                    "matched": None,
                    "policy": "retypeset mode permits document-wide anchor reflow",
                    "mismatches": [],
                }
                correspondence["metadata"] = _metadata_translation_analysis(
                    source_doc, output_doc, intent, mode
                )
            _set_gate(
                report,
                "page_correspondence",
                "pass" if correspondence["matched"] else "fail",
                "페이지 구조·고정 앵커 대응"
                if correspondence["matched"]
                else "페이지 구조·고정 앵커 대응 불일치",
                details=correspondence,
            )

        output_render, output_render_errors = _scan_renderability(output_doc)
        source_render: list[dict] = []
        source_render_errors: list[dict] = []
        if source_doc is not None:
            source_render, source_render_errors = _scan_renderability(source_doc)
        render_errors = {
            "output": output_render_errors,
            "source": source_render_errors,
        }
        _set_gate(
            report,
            "page_render",
            "fail" if output_render_errors or source_render_errors else "pass",
            "모든 페이지 저해상도 렌더링 성공"
            if not output_render_errors and not source_render_errors
            else "렌더링하지 못한 페이지가 있음",
            details=render_errors,
        )

        source_blank = {item["page"] for item in source_render if item["blank"]}
        unexpected_blank = []
        preserved_blank = []
        for item in output_render:
            if not item["blank"]:
                continue
            if mode == "inplace" and source_doc is not None and item["page"] in source_blank:
                preserved_blank.append(item)
            else:
                unexpected_blank.append(item)
        _set_gate(
            report,
            "blank_pages",
            "fail" if unexpected_blank else "pass",
            "예기치 않은 빈 페이지 없음" if not unexpected_blank else f"예기치 않은 빈 페이지 {len(unexpected_blank)}쪽",
            details={
                "unexpected": unexpected_blank[:MAX_DETAIL_ITEMS],
                "source_blank_preserved": preserved_blank[:MAX_DETAIL_ITEMS],
            },
        )

        source_render_by_page = {item["page"]: item for item in source_render}
        source_black = {item["page"] for item in source_render if item.get("black")}
        unexpected_black = []
        for item in output_render:
            source_item = source_render_by_page.get(item["page"])
            newly_mostly_black = item.get("black") and (
                source_item is None or not source_item.get("black")
            )
            severe_darkening = False
            if source_item is not None:
                severe_darkening = (
                    item["dark_ratio"] - source_item["dark_ratio"]
                    >= SEVERE_DARK_RATIO_DELTA
                    and source_item["mean_gray"] - item["mean_gray"]
                    >= SEVERE_MEAN_GRAY_DROP
                )
            if newly_mostly_black or severe_darkening:
                unexpected_black.append(
                    {
                        **item,
                        "reason": (
                            "newly_mostly_black" if newly_mostly_black else "severe_darkening"
                        ),
                        "source_dark_ratio": (
                            source_item.get("dark_ratio") if source_item is not None else None
                        ),
                        "source_mean_gray": (
                            source_item.get("mean_gray") if source_item is not None else None
                        ),
                    }
                )
        _set_gate(
            report,
            "black_pages",
            "fail" if unexpected_black else "pass",
            "예기치 않은 검정·암전 페이지 없음"
            if not unexpected_black
            else f"원문에는 없는 검정·암전 페이지 {len(unexpected_black)}쪽",
            details={
                "unexpected": unexpected_black[:MAX_DETAIL_ITEMS],
                "source_black_pages": sorted(source_black),
            },
        )

        if source_doc is None:
            _set_gate(
                report,
                "nontext_visual_preservation",
                "skip",
                "원문 PDF가 없어 비텍스트 시각 보존을 비교하지 못함",
            )
        elif mode == "retypeset":
            _set_gate(
                report,
                "nontext_visual_preservation",
                "skip",
                "재조판은 레이아웃이 바뀌므로 동일 좌표 픽셀 비교를 적용하지 않음",
            )
        else:
            visual_comparison = _inplace_nontext_visual_comparison(source_doc, output_doc)
            _set_gate(
                report,
                "nontext_visual_preservation",
                "pass" if visual_comparison["matched"] else "fail",
                "텍스트 영역 밖 픽셀·색상·구조 보존"
                if visual_comparison["matched"]
                else "텍스트 영역 밖 픽셀·색상·구조 변경",
                details=visual_comparison,
            )

        if source_doc is None:
            _set_gate(
                report,
                "vector_provenance",
                "skip",
                "원문 PDF가 없어 벡터 도형 provenance를 비교하지 못함",
            )
        elif mode == "inplace":
            _set_gate(
                report,
                "vector_provenance",
                "pass",
                "in-place 비텍스트 픽셀 비교로 벡터 도형을 검증함",
                details={"checked_by": "nontext_visual_preservation"},
            )
        else:
            source_vectors = _meaningful_vector_pages(source_doc)
            output_vectors = _meaningful_vector_pages(output_doc)
            needs_vector_review = source_vectors["meaningful"] or output_vectors["meaningful"]
            _set_gate(
                report,
                "vector_provenance",
                "fail" if needs_vector_review else "pass",
                "의미 있는 벡터 도형 없음"
                if not needs_vector_review
                else "재조판 벡터 도형의 원문 대응을 자동 증명할 수 없음",
                details={
                    "needs_visual_review": needs_vector_review,
                    "source": source_vectors,
                    "output": output_vectors,
                },
            )

        output_texts = [page.get_text("text") or "" for page in output_doc]
        output_untranslated_scan_texts = (
            [_page_text_without_code_spans(page) for page in output_doc]
            if ocr_source_bundle is not None
            else output_texts
        )
        if ocr_source_bundle is not None:
            if source_doc is None or len(source_doc) != len(ocr_source_bundle["pages"]):
                raise ValueError("OCR source page count differs from the original PDF")
            source_texts = [page["text"] for page in ocr_source_bundle["pages"]]
            ocr_semantic_review = _ocr_semantic_review_analysis(
                ocr_source_bundle,
                output_texts,
                translated_path,
            )
        else:
            source_texts = [page.get_text("text") or "" for page in source_doc] if source_doc is not None else []
            ocr_semantic_review = None
        if source_doc is None:
            _set_gate(report, "content_coverage", "skip", "원문 PDF가 없어 내용 커버리지를 비교하지 못함")
            _set_gate(report, "page_order", "skip", "원문 PDF가 없어 페이지 순서를 비교하지 못함")
            _set_gate(report, "semantic_correspondence", "skip", "원문 PDF가 없어 의미 대응을 검토하지 못함")
            _set_gate(report, "text_preservation", "skip", "원문 PDF가 없어 텍스트 보존을 비교하지 못함")
        else:
            coverage = _content_coverage(source_texts, output_texts, mode)
            if ocr_source_bundle is not None:
                coverage["source_text_basis"] = "canonical_ocr"
                coverage["ocr_evidence_sha256"] = ocr_source_bundle[
                    "ocr_evidence_sha256"
                ]
            _set_gate(
                report,
                "content_coverage",
                "pass" if coverage["matched"] else "fail",
                "결정적 내용 전량·대량 누락 없음" if coverage["matched"] else "원문 대비 출력 내용이 비정상적으로 짧음",
                details=coverage,
            )
            order = _page_order_analysis(source_texts, output_texts)
            logical_order = (
                {
                    "matched": (
                        bool(ocr_semantic_review["matched"])
                        if intent == "translate"
                        else True
                    ),
                    "policy": (
                        "canonical OCR translation pages use exact independently "
                        "reviewed page/segment output bindings; restore pages are "
                        "checked by ordered text preservation"
                    ),
                    "review_binding_sha256": ocr_semantic_review.get(
                        "review_binding_sha256"
                    ),
                    "mismatches": ocr_semantic_review.get("mismatches", []),
                }
                if ocr_source_bundle is not None
                else _logical_reading_order_analysis(source_doc, output_doc, mode)
            )
            order["logical_reading_order"] = logical_order
            if not logical_order["matched"]:
                order["matched"] = False
            _set_gate(
                report,
                "page_order",
                "pass" if order["matched"] else "fail",
                "페이지·페이지 내부 읽기 순서 변경 증거 없음"
                if order["matched"]
                else "페이지 또는 페이지 내부 읽기 순서 역전이 결정적으로 감지됨",
                details=order,
            )
            if intent == "translate" and mode == "retypeset":
                if ocr_source_bundle is not None:
                    semantic = {
                        **_semantic_correspondence_analysis(
                            source_texts, output_texts
                        ),
                        **ocr_semantic_review,
                        "source_text_basis": "canonical_ocr",
                    }
                else:
                    semantic = _semantic_correspondence_analysis(
                        source_texts, output_texts
                    )
                _set_gate(
                    report,
                    "semantic_correspondence",
                    "pass" if semantic["matched"] else "fail",
                    "재조판 의미 대응의 결정적 증거 있음"
                    if semantic["matched"]
                    else "재조판 의미·순서를 자동 증명할 수 없어 독립 검토 필요",
                    details=semantic,
                )
            else:
                _set_gate(
                    report,
                    "semantic_correspondence",
                    "skip",
                    "현재 정책에서는 재조판 번역에만 독립 의미 검토를 요구함",
                    details={"needs_semantic_review": False},
                )
            if intent == "restore":
                text_preservation = _compare_ordered_tokens(source_texts, output_texts, mode)
                _set_gate(
                    report,
                    "text_preservation",
                    "pass" if text_preservation["matched"] else "fail",
                    "복원 원문 토큰 순서 보존"
                    if text_preservation["matched"]
                    else "복원 결과에서 원문 토큰의 값·순서가 바뀜",
                    details=text_preservation,
                )
            else:
                _set_gate(report, "text_preservation", "skip", "번역 intent에는 원문과 동일한 어휘를 요구하지 않음")
        counts = {"raw_marker": 0, "garbled": 0, "untranslated": 0}
        issue_pages = {"raw_marker": [], "garbled": [], "untranslated": []}
        issue_findings = {"raw_marker": [], "garbled": [], "untranslated": []}
        for page_number, text in enumerate(output_texts, 1):
            issues = scan_page_text(
                text,
                untranslated_text=output_untranslated_scan_texts[page_number - 1],
            )
            if intent == "restore":
                issues = [issue for issue in issues if issue[0] != "untranslated"]
            seen_on_page = set()
            for kind, _detail in issues:
                issue_findings[kind].append({"page": page_number, "detail": _detail})
                if kind not in seen_on_page:
                    counts[kind] += 1
                    issue_pages[kind].append(page_number)
                    seen_on_page.add(kind)
            if issues:
                report["page_issues"].append({"page": page_number, "issues": issues})

        if ocr_source_bundle is not None and intent == "translate":
            for index, source_page in enumerate(ocr_source_bundle["pages"]):
                if not source_page["requires_korean_translation"]:
                    continue
                output_text = output_texts[index] if index < len(output_texts) else ""
                compact_source = " ".join(
                    _normalise_text(source_page["translatable_text"]).split()
                )
                policy_output_text = (
                    output_untranslated_scan_texts[index]
                    if index < len(output_untranslated_scan_texts)
                    else output_text
                )
                compact_output = " ".join(_normalise_text(policy_output_text).split())
                policy_output = _strip_short_korean_glosses(compact_output)
                source_stats = _target_language_stats(compact_source)
                output_stats = _target_language_stats(policy_output)
                minimum_hangul = max(
                    4,
                    min(32, math.ceil(source_stats["foreign_letter_count"] * 0.2)),
                )
                retained_ratio = _retained_foreign_word_ratio(
                    source_stats["foreign_words"],
                    output_stats["foreign_words"],
                )
                foreign_letter_ratio = (
                    output_stats["foreign_letter_count"]
                    / source_stats["foreign_letter_count"]
                    if source_stats["foreign_letter_count"]
                    else 0.0
                )
                source_compact_no_space = re.sub(r"\s+", "", compact_source).casefold()
                output_compact_no_space = re.sub(r"\s+", "", policy_output).casefold()
                source_still_embedded = (
                    len(source_compact_no_space) >= 6
                    and source_compact_no_space in output_compact_no_space
                )
                mostly_retained_words = (
                    len(source_stats["foreign_words"]) >= 2
                    and retained_ratio >= 0.65
                )
                if not (
                    output_stats["hangul_count"] < minimum_hangul
                    or source_still_embedded
                    or mostly_retained_words
                ):
                    continue
                detail = (
                    "canonical OCR source contains translatable non-Korean prose but "
                    f"the output has {output_stats['hangul_count']} Hangul characters "
                    f"(minimum {minimum_hangul}), retained-word ratio "
                    f"{retained_ratio:.3f}, foreign-letter ratio {foreign_letter_ratio:.3f}"
                )
                issue_findings["untranslated"].append(
                    {"page": index + 1, "detail": detail}
                )
                if index + 1 not in issue_pages["untranslated"]:
                    counts["untranslated"] += 1
                    issue_pages["untranslated"].append(index + 1)
                existing = next(
                    (
                        item
                        for item in report["page_issues"]
                        if item["page"] == index + 1
                    ),
                    None,
                )
                if existing is None:
                    report["page_issues"].append(
                        {"page": index + 1, "issues": [("untranslated", detail)]}
                    )
                else:
                    existing["issues"].append(("untranslated", detail))

        for kind, gate_name, clean_summary, fail_label in (
            ("raw_marker", "raw_markers", "raw 마커 없음", "raw 마커 잔존"),
            ("garbled", "garbling", "깨진 글리프·인코딩 서명 없음", "깨진 글리프·인코딩 서명 감지"),
            ("untranslated", "untranslated_text", "미번역 영어 산문 없음", "미번역 영어 산문 감지"),
        ):
            pages = issue_pages[kind]
            if kind == "untranslated" and intent == "restore":
                _set_gate(
                    report,
                    gate_name,
                    "skip",
                    "복원 intent에서는 영어 원문 유지가 정상임",
                    details={"pages": []},
                )
                continue
            _set_gate(
                report,
                gate_name,
                "fail" if pages else "pass",
                clean_summary if not pages else f"{fail_label}: {len(pages)}쪽",
                details={
                    "pages": pages,
                    "findings": issue_findings[kind][:MAX_DETAIL_ITEMS],
                    "truncated": len(issue_findings[kind]) > MAX_DETAIL_ITEMS,
                },
            )

        for name, extractor, target in (
            ("number_preservation", extract_numbers, "numbers"),
            ("unit_preservation", extract_number_units, None),
            ("chemical_formula_preservation", extract_chemical_formulas, "formulas"),
            ("url_preservation", extract_urls, None),
        ):
            if source_doc is None:
                _set_gate(report, name, "skip", "원문 PDF가 없어 보존 여부를 비교하지 못함")
                continue
            comparison = _compare_extracted(source_texts, output_texts, extractor, mode)
            if ocr_source_bundle is not None:
                comparison["source_text_basis"] = "canonical_ocr"
                comparison["ocr_evidence_sha256"] = ocr_source_bundle[
                    "ocr_evidence_sha256"
                ]
            label = {
                "number_preservation": "숫자",
                "unit_preservation": "숫자-단위 쌍",
                "chemical_formula_preservation": "화학식",
                "url_preservation": "텍스트 URL",
            }[name]
            _set_gate(
                report,
                name,
                "pass" if comparison["matched"] else "fail",
                f"{label} 보존" if comparison["matched"] else f"{label} 누락 또는 추가",
                details=comparison,
            )
            if target:
                report[target] = comparison

        output_images, output_image_errors = _image_occurrences(output_doc)
        source_images = None
        source_image_errors = []
        if source_doc is not None:
            source_images, source_image_errors = _image_occurrences(source_doc)
        duplicates = _duplicate_analysis(output_images, source_images)
        suspicious_duplicates = duplicates["suspicious_duplicate_groups"]
        _set_gate(
            report,
            "image_duplicates",
            "fail" if suspicious_duplicates or output_image_errors or source_image_errors else "pass",
            "새 이미지 중복 없음"
            if not suspicious_duplicates and not output_image_errors and not source_image_errors
            else "원문보다 많이 반복된 이미지 또는 이미지 검사 오류가 있음",
            details={
                **duplicates,
                "output_errors": output_image_errors,
                "source_errors": source_image_errors,
            },
        )

        output_image_count = sum(len(items) for items in output_images.values())
        source_image_count = sum(len(items) for items in source_images.values()) if source_images is not None else None
        if source_images is None:
            _set_gate(report, "image_preservation", "skip", "원문 PDF가 없어 이미지 수를 비교하지 못함")
        elif mode == "retypeset" and ocr_source_bundle is not None:
            source_content_images = {
                digest: [
                    item
                    for item in items
                    if item.get("page_coverage", 0) < 0.80
                ]
                for digest, items in source_images.items()
            }
            source_content_images = {
                digest: items
                for digest, items in source_content_images.items()
                if items
            }
            content_comparison = _retypeset_image_preservation(
                source_content_images,
                output_images,
            )
            visual_review_summary = ocr_source_bundle.get("visual_review")
            if visual_review_summary is not None:
                visual_review_sha256 = visual_review_summary.get("review_sha256")
                visual_review_bound = bool(
                    SHA256_HEX_RE.fullmatch(str(visual_review_sha256 or ""))
                    and visual_review_summary.get("output_pdf_sha256")
                    == _sha256_file(translated_path)
                    and visual_review_summary.get("ocr_evidence_sha256")
                    == ocr_source_bundle["ocr_evidence_sha256"]
                    and visual_review_summary.get("intent") == intent
                )
            else:
                # Backward-compatible translation bundles carried the visual
                # seal inside semantic_review.  Restore never accepts this
                # fallback because it intentionally has no translation judge.
                visual_review_sha256 = (
                    ocr_source_bundle.get("semantic_review") or {}
                ).get("visual_review_sha256")
                visual_review_bound = bool(
                    intent == "translate"
                    and SHA256_HEX_RE.fullmatch(str(visual_review_sha256 or ""))
                )
            image_comparison = {
                **content_comparison,
                "matched": bool(
                    content_comparison["matched"] and visual_review_bound
                ),
                "needs_visual_review": not visual_review_bound or bool(
                    content_comparison.get("needs_visual_review")
                ),
                "policy": (
                    "full-page scan rasters alone are OCR source carriers and are "
                    "validated by strict OCR render provenance plus an independent "
                    "source/output visual review; every separate content image still "
                    "requires perceptual provenance"
                ),
                "source_full_page_rasters": sum(
                    1
                    for items in source_images.values()
                    for item in items
                    if item.get("page_coverage", 0) >= 0.80
                ),
                "output_occurrences": output_image_count,
                "ocr_evidence_sha256": ocr_source_bundle[
                    "ocr_evidence_sha256"
                ],
                "visual_review_sha256": visual_review_sha256,
            }
            _set_gate(
                report,
                "image_preservation",
                "pass" if image_comparison["matched"] else "fail",
                "OCR 원본 페이지 래스터·콘텐츠 이미지 provenance 검증"
                if image_comparison["matched"]
                else "OCR 원본의 별도 콘텐츠 이미지 대응을 확인할 수 없음",
                details={
                    "source_occurrences": source_image_count,
                    "output_occurrences": output_image_count,
                    **image_comparison,
                },
            )
        elif mode == "retypeset":
            image_comparison = _retypeset_image_preservation(source_images, output_images)
            images_preserved = image_comparison["matched"]
            _set_gate(
                report,
                "image_preservation",
                "pass" if images_preserved else "fail",
                "재조판 이미지 100% 지각적 대응" if images_preserved else "재조판 이미지 대응을 자동 승인할 수 없음",
                details={"source_occurrences": source_image_count, "output_occurrences": output_image_count, **image_comparison},
            )
        else:
            image_comparison = _inplace_image_preservation(source_images, output_images)
            images_preserved = image_comparison["matched"]
            _set_gate(
                report,
                "image_preservation",
                "pass" if images_preserved else "fail",
                "원문 이미지 픽셀·위치·배치 보존" if images_preserved else "원문 이미지 자동 보존을 확인할 수 없음",
                details={
                    "source_occurrences": source_image_count,
                    "output_occurrences": output_image_count,
                    **image_comparison,
                },
            )

        report["figures"] = {
            "embedded_unique_images": len(output_images),
            "embedded_image_occurrences": output_image_count,
            "duplicate_images": duplicates["duplicate_groups"],
            "suspicious_duplicate_images": suspicious_duplicates,
        }
        if source_images is not None:
            report["figures"]["original_raw_image_count"] = source_image_count

        output_links, output_link_errors = _extract_link_inventory(output_doc)
        source_links = {"safe_uri_pages": [], "internal": [], "unsafe": []}
        source_link_errors: list[dict] = []
        if source_doc is not None:
            source_links, source_link_errors = _extract_link_inventory(source_doc)
        if source_doc is None:
            unsafe_without_source = output_links["unsafe"] or output_link_errors
            _set_gate(
                report,
                "link_preservation",
                "fail" if unsafe_without_source else "skip",
                "원문 PDF가 없어 보존 여부를 비교하지 못함"
                if not unsafe_without_source
                else "출력 PDF에 위험하거나 해석할 수 없는 링크 action이 남음",
                details={
                    "unsafe_output": output_links["unsafe"][:MAX_DETAIL_ITEMS],
                    "output_errors": output_link_errors,
                },
            )
            link_comparison = None
        else:
            uri_comparison = _compare_page_items(
                source_links["safe_uri_pages"], output_links["safe_uri_pages"], mode
            )
            internal_comparison = _compare_internal_links(
                source_links["internal"], output_links["internal"]
            )
            outline_comparison = _outline_translation_analysis(
                source_doc, output_doc, intent, mode
            )
            links_ok = (
                uri_comparison["matched"]
                and internal_comparison["matched"]
                and outline_comparison["matched"]
                and not output_links["unsafe"]
                and not output_link_errors
                and not source_link_errors
            )
            link_comparison = {
                "matched": links_ok,
                "uri": uri_comparison,
                "internal": internal_comparison,
                "outlines": outline_comparison,
                "unsafe_output": output_links["unsafe"][:MAX_DETAIL_ITEMS],
                "unsafe_source_removed_by_policy": source_links["unsafe"][:MAX_DETAIL_ITEMS],
                "output_errors": output_link_errors,
                "source_errors": source_link_errors,
            }
            _set_gate(
                report,
                "link_preservation",
                "pass" if links_ok else "fail",
                "안전한 URI·내부 이동 링크·북마크 보존 및 위험 action 제거"
                if links_ok
                else "URI·내부 이동 링크·북마크 불일치 또는 위험 action 잔존",
                details=link_comparison,
            )
        source_safe_uri_count = sum(map(len, source_links["safe_uri_pages"])) if source_doc is not None else None
        output_safe_uri_count = sum(map(len, output_links["safe_uri_pages"]))
        report["links"] = {
            "source_count": (
                source_safe_uri_count + len(source_links["internal"])
                if source_safe_uri_count is not None
                else None
            ),
            "output_count": output_safe_uri_count + len(output_links["internal"]),
            "source_safe_uri_count": source_safe_uri_count,
            "output_safe_uri_count": output_safe_uri_count,
            "source_internal_count": len(source_links["internal"]) if source_doc is not None else None,
            "output_internal_count": len(output_links["internal"]),
            "unsafe_output_count": len(output_links["unsafe"]),
            "comparison": link_comparison,
        }

        duplicate_count = len(duplicates["duplicate_groups"])
        report["summary"] = {
            "pages_with_issues": len(report["page_issues"]),
            "raw_marker_pages": counts["raw_marker"],
            "garbled_pages": counts["garbled"],
            "untranslated_pages": counts["untranslated"],
            "blank_pages": len(unexpected_blank),
            "black_pages": len(unexpected_black),
            "duplicate_image_groups": duplicate_count,
            "suspicious_duplicate_image_groups": len(suspicious_duplicates),
        }
        return _finalise(report)
    finally:
        if output_doc is not None:
            output_doc.close()
        if source_doc is not None:
            source_doc.close()


def print_report(report: dict) -> None:
    summary = report.get("summary", {})
    state = "PASS" if report.get("passed") else "FAIL"
    print(
        f"\n=== 검증 {state}: {report['file']} "
        f"({report.get('pages', 0)}쪽, {report['mode']}, {report.get('intent', 'translate')}) ==="
    )
    print(
        f"  이슈 페이지: {summary.get('pages_with_issues', 0)} "
        f"(raw마커 {summary.get('raw_marker_pages', 0)} / 깨짐 {summary.get('garbled_pages', 0)} / "
        f"미번역 {summary.get('untranslated_pages', 0)} / 빈 페이지 {summary.get('blank_pages', 0)})"
    )
    figures = report.get("figures", {})
    line = f"  이미지: 임베드 고유 {figures.get('embedded_unique_images', 0)}개"
    if "original_raw_image_count" in figures:
        line += f" / 원문 배치 {figures['original_raw_image_count']}개"
    line += f" / 의심 중복 {summary.get('suspicious_duplicate_image_groups', 0)}그룹"
    print(line)

    if report.get("hard_failures"):
        print(f"  하드 게이트 실패: {', '.join(report['hard_failures'])}")
        for name in report["hard_failures"]:
            gate = report["gates"].get(name, {})
            print(f"    - {name}: {gate.get('summary', '')}")

    for page_issue in report.get("page_issues", [])[:60]:
        print(f"  - p{page_issue['page']}:")
        for kind, detail in page_issue["issues"]:
            print(f"      [{kind}] {detail}")
    if len(report.get("page_issues", [])) > 60:
        print(f"  ... 외 {len(report['page_issues']) - 60}개 페이지 더")

    flagged = {item["page"] for item in report.get("page_issues", [])}
    blank_gate = report.get("gates", {}).get("blank_pages", {})
    for item in blank_gate.get("details", {}).get("unexpected", []):
        flagged.add(item["page"])
    print(f"  * 비전 재검 후보 페이지: {sorted(flagged) if flagged else '없음(깨끗)'}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("translated")
    parser.add_argument("--original", default=None)
    parser.add_argument("--json", default=None)
    parser.add_argument(
        "--ocr-source-json",
        default=None,
        help="private canonical OCR source/review bundle supplied by strict postflight",
    )
    parser.add_argument(
        "--mode",
        choices=("inplace", "retypeset"),
        default="inplace",
        help="comparison policy (default: inplace, the strict layout-preserving policy)",
    )
    parser.add_argument(
        "--intent",
        choices=("translate", "restore"),
        default="translate",
        help="translation intent; restore preserves source language and skips untranslated-prose rejection",
    )
    args = parser.parse_args(argv)

    try:
        report = verify(
            args.translated,
            args.original,
            mode=args.mode,
            intent=args.intent,
            ocr_source_path=args.ocr_source_json,
        )
    except Exception as exc:
        report = _new_report(args.translated, args.original, args.mode, args.intent)
        _set_gate(
            report,
            "internal_error",
            "fail",
            "검증기 내부 오류",
            details={"error": f"{type(exc).__name__}: {exc}"},
        )
        _finalise(report)
        report["exit_code"] = EXIT_INTERNAL_ERROR

    print_report(report)
    if args.json:
        try:
            with open(args.json, "w", encoding="utf-8") as handle:
                json.dump(report, handle, ensure_ascii=False, indent=2)
            print(f"\nJSON 저장: {args.json}")
        except Exception as exc:
            print(f"\nJSON 저장 실패: {type(exc).__name__}: {exc}", file=sys.stderr)
            return EXIT_INTERNAL_ERROR
    return int(report["exit_code"])


if __name__ == "__main__":
    sys.exit(main())
