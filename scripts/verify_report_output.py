#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Deterministic report-output verifier for Quilo report pipelines.

Usage:
    .venv/bin/python3 scripts/verify_report_output.py <out.hwpx|out.docx|out.zip>
        --type <chem-pre|chem-result|phys-result|free|reading-log|form-maker|problem-set>
        [--content content.json] [--source-data canonical.json ...]
        [--template template.hwpx] [--json verdict.json]

Exit codes:
    0  no hard failures
    1  at least one hard failure
    2  verifier internal error (verdict JSON is still written when --json given)

Rule ids (fixed; shared with the downstream defect ledger — do not rename):
    Z1 Z2 Z3            zip container
    X1 X2 X3 X4         XML integrity / ID reference resolution
    B1 B2 B3            BinData manifest / binary sanity
    M1 M2 M3 M4 M5      body text scans (raw markers, markdown, dashes, mojibake, LaTeX)
    C1 C2               chart declaration vs embedded images (requires --content)
    T1 T2               table numbers vs canonical source data (requires --source-data)
    P1                  hwpx Preview/PrvText.txt sanity
    D1                  docx rels <-> media consistency
    ZB1                 problem-set zip bundle (PDF presence/validity)
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import sys
import zipfile

try:
    from lxml import etree
except ImportError:  # pragma: no cover - environment contract says lxml exists
    etree = None

try:
    from PIL import Image, ImageStat
except ImportError:  # pragma: no cover
    Image = None
    ImageStat = None

try:
    import fitz  # pymupdf
except ImportError:  # pragma: no cover
    fitz = None


EXIT_OK = 0
EXIT_HARD_FAIL = 1
EXIT_INTERNAL_ERROR = 2

SAMPLE_MAX = 160

# ---------------------------------------------------------------------------
# Per-type configuration
# ---------------------------------------------------------------------------
# chart_paths: list of tuples describing where charts live inside the content
# JSON. Each path is a sequence of steps; "*" means "iterate list elements".
# The final step names either a list of chart dicts or a single chart dict.
TYPE_CONFIG = {
    "chem-pre": {
        "formats": {"hwpx", "docx"},
        "charts": True,
        "chart_paths": [],  # chem-pre declares no charts; deep-scan fallback only
    },
    "chem-result": {
        "formats": {"hwpx", "docx"},
        "charts": True,
        # chem-result/docx-gen.js: content.data.charts[] (list of chart objects)
        "chart_paths": [("data", "charts")],
    },
    "phys-result": {
        "formats": {"hwpx", "docx"},
        "charts": True,
        # phys-result/docx-gen.js: content.experiments[].chart (one per part)
        "chart_paths": [("experiments", "*", "chart")],
    },
    "free": {
        "formats": {"hwpx", "docx"},
        "charts": True,
        # free-report/docx-gen.js: content.sections[].blocks[].chart
        "chart_paths": [("sections", "*", "blocks", "*", "chart")],
    },
    "reading-log": {
        "formats": {"hwpx"},  # hwpx only
        "charts": False,
        "chart_paths": [],
    },
    "form-maker": {
        "formats": {"hwpx", "docx"},
        "charts": True,
        "chart_paths": [],  # blocks schema; rely on deep scan
    },
    "problem-set": {
        "formats": {"zip"},
        "charts": False,
        "chart_paths": [],
    },
}

# ---------------------------------------------------------------------------
# Text-scan patterns (M rules)
# ---------------------------------------------------------------------------
M1_RAW_MARKERS = [
    (re.compile(r"\{\{EQ:"), "raw 수식 마커 {{EQ:"),
    (re.compile(r"\{\{EQ-LATEX:"), "raw 수식 마커 {{EQ-LATEX:"),
    (re.compile(r"\{\{MATH:"), "raw 수식 마커 {{MATH:"),
    (re.compile(r"\{\{FORMULA:"), "raw 수식 마커 {{FORMULA:"),
    (re.compile(r"\[\[수식\]\]"), "raw 수식 마커 [[수식]]"),
    (re.compile(r"\{\{IMG"), "raw 이미지 마커 {{IMG"),
    (re.compile(r"\{\{CHART"), "raw 차트 마커 {{CHART"),
]

M2_PIPE_SEPARATOR = re.compile(r"\|\s*:?-{2,}:?\s*\|")
M2_BOLD = re.compile(r"\*\*[^*\n]{1,200}\*\*")
M2_HEADER = re.compile(r"^\s{0,3}#{1,6}\s+\S")
M2_CODE_FENCE = re.compile(r"```")

M4_MOJIBAKE = re.compile(r"(?:Ã.|Â.|â..){2,}")
M4_BOXES = re.compile(r"(?:□\s*){3,}")

M5_LATEX = re.compile(
    r"\\(?:frac|sqrt|pi\b|text\b|times\b|cdot\b|alpha\b|beta\b|gamma\b|theta\b|"
    r"omega\b|Delta\b|left\b|right\b|sum\b|int\b|approx\b|partial\b|infty\b|"
    r"mathrm\b|dfrac|overline\b|vec\b)"
)

CONTROL_CHARS = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F]")

NUMBER_RE = re.compile(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?")

HWPX_REQUIRED = ["version.xml", "Contents/header.xml", "Contents/section0.xml", "Contents/content.hpf"]
DOCX_REQUIRED = ["[Content_Types].xml", "word/document.xml"]

IMAGE_MAGIC = {
    ".png": b"\x89PNG",
    ".jpg": b"\xff\xd8",
    ".jpeg": b"\xff\xd8",
    ".gif": b"GIF8",
    ".bmp": b"BM",
}
IMAGE_EXTS = set(IMAGE_MAGIC.keys())


def clip(text, limit=SAMPLE_MAX):
    text = str(text)
    return text if len(text) <= limit else text[: limit - 1] + "…"


class Verdict:
    def __init__(self, file_path, type_key, fmt):
        self.data = {
            "schema_version": 1,
            "file": file_path,
            "type": type_key,
            "format": fmt,
            "passed": True,
            "hard_failures": [],
            "warnings": [],
            "metrics": {},
        }
        self.verifier_errors = []

    def hard(self, rule, detail, sample=""):
        self.data["hard_failures"].append({"rule": rule, "detail": detail, "sample": clip(sample)})
        self.data["passed"] = False

    def warn(self, rule, detail, sample=""):
        self.data["warnings"].append({"rule": rule, "detail": detail, "sample": clip(sample)})

    def metric(self, key, value):
        self.data["metrics"][key] = value

    def verr(self, where, exc):
        self.verifier_errors.append(f"{where}: {type(exc).__name__}: {exc}")


def localname(tag):
    if isinstance(tag, str) and tag.startswith("{"):
        return tag.rsplit("}", 1)[1]
    return str(tag)


# ---------------------------------------------------------------------------
# Container rules (Z1/Z2/Z3)
# ---------------------------------------------------------------------------
def check_container(path, fmt, verdict):
    try:
        zf = zipfile.ZipFile(path)
    except Exception as exc:
        verdict.hard("Z1", f"zip으로 열 수 없음: {type(exc).__name__}: {exc}")
        return None

    try:
        bad = zf.testzip()
        if bad is not None:
            verdict.hard("Z1", "zip 엔트리 CRC 손상", sample=bad)
    except Exception as exc:
        verdict.hard("Z1", f"zip CRC 검사 실패: {type(exc).__name__}: {exc}")

    names = zf.namelist()
    verdict.metric("zip_entries", len(names))

    if fmt == "hwpx":
        # Z2: mimetype must be the first entry, stored (no compression),
        # value "application/hwp+zip". Confirmed against real generator
        # outputs (tmp/out/*.hwpx all satisfy this), so it stays hard.
        infos = zf.infolist()
        if not infos or infos[0].filename != "mimetype":
            verdict.hard("Z2", "mimetype이 zip 첫 엔트리가 아님",
                         sample=infos[0].filename if infos else "(빈 zip)")
        else:
            info = infos[0]
            if info.compress_type != zipfile.ZIP_STORED:
                verdict.hard("Z2", "mimetype 엔트리가 무압축(stored)이 아님")
            try:
                value = zf.read("mimetype").decode("utf-8", "replace").strip()
                if value != "application/hwp+zip":
                    verdict.hard("Z2", "mimetype 값이 application/hwp+zip이 아님", sample=value)
            except Exception as exc:
                verdict.hard("Z2", f"mimetype 읽기 실패: {exc}")
        required = HWPX_REQUIRED
    elif fmt == "docx":
        required = DOCX_REQUIRED
    else:
        required = []

    nameset = set(names)
    for req in required:
        if req not in nameset:
            verdict.hard("Z3", "필수 엔트리 누락", sample=req)

    return zf


# ---------------------------------------------------------------------------
# XML rules (X1/X2/X3/X4)
# ---------------------------------------------------------------------------
def parse_xml_entries(zf, verdict):
    """Parse every *.xml (plus .hpf/.rels which are XML documents) strictly."""
    trees = {}
    for name in zf.namelist():
        low = name.lower()
        if not (low.endswith(".xml") or low.endswith(".hpf") or low.endswith(".rels")):
            continue
        try:
            raw = zf.read(name)
        except Exception as exc:
            verdict.hard("X1", f"엔트리 읽기 실패: {exc}", sample=name)
            continue
        if not raw.strip():
            # empty XML part is a parse failure for strict lxml
            verdict.hard("X1", "XML 엔트리가 비어 있음", sample=name)
            continue
        try:
            tree = etree.fromstring(raw)
            trees[name] = tree
        except etree.XMLSyntaxError as exc:
            verdict.hard("X1", f"XML strict 파스 실패: {exc}", sample=name)
    return trees


def check_control_chars(trees, verdict):
    hits = 0
    first = ""
    for name, tree in trees.items():
        for el in tree.iter():
            for text in (el.text, el.tail):
                if text and CONTROL_CHARS.search(text):
                    hits += 1
                    if not first:
                        bad = CONTROL_CHARS.search(text).group(0)
                        first = f"{name} <{localname(el.tag)}> U+{ord(bad):04X}"
        if hits:
            break
    if hits:
        verdict.hard("X2", "XML 텍스트 노드에 제어문자 존재", sample=first)


def hwpx_section_names(zf):
    return sorted(
        n for n in zf.namelist()
        if re.match(r"^Contents/section\d+\.xml$", n)
    )


def check_hwpx_id_refs(zf, trees, verdict):
    header = trees.get("Contents/header.xml")
    if header is None:
        return  # Z3/X1 already flagged
    defined = {"charPr": set(), "paraPr": set(), "borderFill": set()}
    for el in header.iter():
        ln = localname(el.tag)
        if ln in defined and el.get("id") is not None:
            defined[ln].add(el.get("id"))

    ref_map = {
        "charPrIDRef": "charPr",
        "paraPrIDRef": "paraPr",
        "borderFillIDRef": "borderFill",
    }
    missing = []
    for sec_name in hwpx_section_names(zf):
        tree = trees.get(sec_name)
        if tree is None:
            continue
        for el in tree.iter():
            for attr, kind in ref_map.items():
                val = el.get(attr)
                if val is None or val == "":
                    continue
                if val not in defined[kind]:
                    missing.append(f"{sec_name}: {attr}={val}")
    if missing:
        uniq = sorted(set(missing))
        verdict.hard(
            "X3",
            f"header.xml에 정의되지 않은 스타일 ID 참조 {len(uniq)}종",
            sample="; ".join(uniq[:5]),
        )


def hwpx_manifest_items(trees):
    """Return {item_id: href} from Contents/content.hpf manifest."""
    hpf = trees.get("Contents/content.hpf")
    items = {}
    if hpf is None:
        return items
    for el in hpf.iter():
        if localname(el.tag) == "item":
            iid = el.get("id")
            href = el.get("href") or ""
            if iid:
                items[iid] = href
    return items


def check_hwpx_binary_refs(zf, trees, verdict):
    items = hwpx_manifest_items(trees)
    item_ids = set(items.keys())
    scan_names = hwpx_section_names(zf) + ["Contents/header.xml"]
    missing = []
    for name in scan_names:
        tree = trees.get(name)
        if tree is None:
            continue
        for el in tree.iter():
            ref = el.get("binaryItemIDRef")
            if ref and ref not in item_ids:
                missing.append(f"{name}: binaryItemIDRef={ref}")
    if missing:
        uniq = sorted(set(missing))
        verdict.hard(
            "X4",
            f"content.hpf manifest에서 해석되지 않는 binaryItemIDRef {len(uniq)}종",
            sample="; ".join(uniq[:5]),
        )
    return items


def check_hwpx_bindata(zf, trees, manifest_items, verdict):
    nameset = set(zf.namelist())

    # B1 forward: every BinData href in the manifest must exist in the zip.
    hrefs = [h for h in manifest_items.values() if h.startswith("BinData/")]
    for href in hrefs:
        if href not in nameset:
            verdict.hard("B1", "manifest BinData href가 zip에 없음", sample=href)

    # B1 reverse (warn): orphan BinData entries not referenced by manifest.
    href_set = set(hrefs)
    bindata_entries = [n for n in nameset if n.startswith("BinData/") and not n.endswith("/")]
    orphans = [n for n in bindata_entries if n not in href_set]
    if orphans:
        verdict.warn("B1", f"manifest에 등록되지 않은 고아 BinData {len(orphans)}개",
                     sample="; ".join(orphans[:5]))

    # B2 (warn): image manifest items should carry isEmbeded="1"
    # (the invariant ensure_embedded_bindata_items() in chem-pre/hwpx-gen.py enforces).
    hpf = trees.get("Contents/content.hpf")
    if hpf is not None:
        not_embedded = []
        for el in hpf.iter():
            if localname(el.tag) != "item":
                continue
            href = el.get("href") or ""
            media = el.get("media-type") or ""
            if href.startswith("BinData/") and media.startswith("image/"):
                if el.get("isEmbeded") != "1":
                    not_embedded.append(href)
        if not_embedded:
            verdict.warn("B2", f'이미지 manifest item에 isEmbeded="1" 누락 {len(not_embedded)}개',
                         sample="; ".join(not_embedded[:5]))

    # B3: no zero-byte BinData; magic bytes must match the extension.
    image_count = 0
    for name in bindata_entries:
        try:
            data = zf.read(name)
        except Exception as exc:
            verdict.hard("B3", f"BinData 읽기 실패: {exc}", sample=name)
            continue
        if len(data) == 0:
            verdict.hard("B3", "BinData 파일이 0바이트", sample=name)
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext in IMAGE_MAGIC:
            image_count += 1
            if not data.startswith(IMAGE_MAGIC[ext]):
                verdict.hard(
                    "B3",
                    f"매직바이트가 확장자({ext})와 불일치",
                    sample=f"{name}: {data[:4].hex()}",
                )
    verdict.metric("bindata_files", len(bindata_entries))
    verdict.metric("bindata_images", image_count)
    return bindata_entries


# ---------------------------------------------------------------------------
# Body text extraction
# ---------------------------------------------------------------------------
def _lines_from_paragraphs(tree, para_local, text_local):
    """Group text-node contents into lines by nearest ancestor paragraph.

    Avoids double-counting nested table paragraphs (hwpx tables nest hp:p
    inside outer hp:p/run/tbl): each text node is attributed to its NEAREST
    paragraph ancestor only, in document order.
    """
    parent = {c: p for p in tree.iter() for c in p}
    lines = []
    current_para = object()  # sentinel
    buf = []
    for el in tree.iter():
        if localname(el.tag) != text_local:
            continue
        # nearest ancestor paragraph
        node = el
        para = None
        while node is not None:
            node = parent.get(node)
            if node is not None and localname(node.tag) == para_local:
                para = node
                break
        text = "".join(el.itertext())
        if para is not current_para:
            if buf:
                lines.append("".join(buf))
            buf = []
            current_para = para
        buf.append(text)
    if buf:
        lines.append("".join(buf))
    return lines


def _cell_text(cell_el, text_local):
    """Cell text with paragraphs separated by spaces.

    Runs inside one paragraph stay concatenated (a number split across runs
    like "1.4"+"7" must rejoin), but adjacent paragraphs must NOT fuse
    (otherwise numbers from stacked lines merge into a bogus value)."""
    paras = []
    for p_el in cell_el.iter():
        if localname(p_el.tag) != "p":
            continue
        text = "".join(
            "".join(t.itertext())
            for t in p_el.iter()
            if localname(t.tag) == text_local
        )
        if text.strip():
            paras.append(text)
    return " ".join(paras)


def extract_body_lines(zf, trees, fmt, verdict):
    """Return (lines, table_count, table_cell_texts) for M/T rules.

    hwpx: <hp:t> nodes of Contents/section*.xml (equation scripts live in
    <hp:script>, so they are naturally excluded).
    docx: <w:t> nodes of word/document.xml (OMML math uses <m:t>, excluded).
    """
    lines = []
    table_count = 0
    table_cell_texts = []

    if fmt == "hwpx":
        doc_trees = [trees.get(n) for n in hwpx_section_names(zf)]
        text_local = "t"
    elif fmt == "docx":
        doc_trees = [trees.get("word/document.xml")]
        text_local = "t"
    else:
        return lines, table_count, table_cell_texts

    for tree in doc_trees:
        if tree is None:
            continue
        lines.extend(_lines_from_paragraphs(tree, "p", text_local))
        for el in tree.iter():
            ln = localname(el.tag)
            if ln == "tbl":
                table_count += 1
            elif ln == "tc":
                cell = _cell_text(el, text_local)
                if cell.strip():
                    table_cell_texts.append(cell)

    return lines, table_count, table_cell_texts


def check_body_text(lines, verdict):
    text = "\n".join(lines)
    verdict.metric("text_chars", len(text))

    # M1: raw markers
    for pattern, label in M1_RAW_MARKERS:
        m = pattern.search(text)
        if m:
            start = max(0, m.start() - 30)
            verdict.hard("M1", f"본문에 {label} 잔존", sample=text[start:m.end() + 40])

    # M2: markdown residue (line-based)
    # pipe 판정 주의: |ΔH| 같은 절댓값 표기가 한 줄에 4개 이상 나올 수 있어
    # 단순 개수로 잡으면 오탐(R4 실측). markdown 표는 줄이 |로 시작·끝나는
    # 구조이므로 (a) 구분자 행(|---|) 또는 (b) |로 시작하고 |로 끝나며
    # 내부 파이프가 2개 이상인 행만 표 잔재로 본다.
    def _is_pipe_table_line(line):
        if M2_PIPE_SEPARATOR.search(line):
            return True
        stripped = line.strip()
        return (
            len(stripped) >= 5
            and stripped.startswith("|")
            and stripped.endswith("|")
            and stripped.count("|") >= 4
        )

    m2_hits = {"pipe": None, "bold": None, "header": None, "fence": None}
    for line in lines:
        if m2_hits["pipe"] is None and _is_pipe_table_line(line):
            m2_hits["pipe"] = line
        if m2_hits["bold"] is None and M2_BOLD.search(line):
            m2_hits["bold"] = line
        if m2_hits["header"] is None and M2_HEADER.search(line):
            m2_hits["header"] = line
        if m2_hits["fence"] is None and M2_CODE_FENCE.search(line):
            m2_hits["fence"] = line
    labels = {
        "pipe": "Markdown 파이프 표 잔재",
        "bold": "Markdown **볼드** 잔재",
        "header": "Markdown # 헤더 잔재",
        "fence": "코드펜스(```) 잔재",
    }
    for key, sample in m2_hits.items():
        if sample is not None:
            verdict.hard("M2", labels[key], sample=sample)

    # M3: em dash hard, en dash warn
    if "—" in text:
        idx = text.index("—")
        verdict.hard("M3", "U+2014(—) 긴 하이픈 존재",
                     sample=text[max(0, idx - 30): idx + 30])
    if "–" in text:
        idx = text.index("–")
        verdict.warn("M3", "U+2013(–) 존재",
                     sample=text[max(0, idx - 30): idx + 30])

    # M4: replacement char / NUL / missing glyph runs / mojibake
    if "�" in text:
        idx = text.index("�")
        verdict.hard("M4", "U+FFFD replacement character 존재",
                     sample=text[max(0, idx - 30): idx + 30])
    if "\x00" in text:
        verdict.hard("M4", "NUL 문자 존재")
    m = M4_BOXES.search(text)
    if m:
        verdict.hard("M4", "연속 누락 글리프(□) 3개 이상",
                     sample=text[max(0, m.start() - 30): m.end() + 30])
    m = M4_MOJIBAKE.search(text)
    if m:
        verdict.hard("M4", "UTF-8 mojibake 패턴(Ã/Â/â 연쇄)",
                     sample=text[max(0, m.start() - 30): m.end() + 30])

    # M5 (warn): LaTeX commands leaked into plain body text
    # (equation objects are excluded from extraction, so any hit is plain text)
    m = M5_LATEX.search(text)
    if m:
        count = len(M5_LATEX.findall(text))
        verdict.warn("M5", f"수식 객체 밖 평문에 LaTeX 명령 {count}건 노출",
                     sample=text[max(0, m.start() - 30): m.end() + 40])


# ---------------------------------------------------------------------------
# Chart rules (C1/C2)
# ---------------------------------------------------------------------------
def _is_chartish(node):
    return isinstance(node, dict) and len(node) > 0


def count_charts_by_path(content, path):
    """Walk one chart path; '*' iterates list elements."""
    nodes = [content]
    for step in path:
        nxt = []
        for node in nodes:
            if step == "*":
                if isinstance(node, list):
                    nxt.extend(node)
            elif isinstance(node, dict) and step in node:
                nxt.append(node[step])
        nodes = nxt
    count = 0
    for node in nodes:
        if isinstance(node, list):
            count += sum(1 for c in node if _is_chartish(c))
        elif _is_chartish(node):
            count += 1
    return count


def deep_scan_charts(node, depth=0):
    if depth > 12:
        return 0
    count = 0
    if isinstance(node, dict):
        for key, val in node.items():
            if key == "charts" and isinstance(val, list):
                count += sum(1 for c in val if _is_chartish(c))
            elif key == "chart" and _is_chartish(val):
                count += 1
            else:
                count += deep_scan_charts(val, depth + 1)
    elif isinstance(node, list):
        for item in node:
            count += deep_scan_charts(item, depth + 1)
    return count


def list_embedded_images(zf, fmt):
    """(all image entry names, png entry names) inside the container."""
    names = []
    if fmt == "hwpx":
        prefix = "BinData/"
    elif fmt == "docx":
        prefix = "word/media/"
    else:
        return [], []
    for n in zf.namelist():
        if n.startswith(prefix) and not n.endswith("/"):
            ext = os.path.splitext(n)[1].lower()
            if ext in IMAGE_EXTS:
                names.append(n)
    pngs = [n for n in names if n.lower().endswith(".png")]
    return names, pngs


def check_charts(zf, fmt, content, cfg, verdict):
    declared = 0
    path_hits = 0
    for path in cfg.get("chart_paths", []):
        path_hits += count_charts_by_path(content, path)
    if path_hits > 0:
        declared = path_hits
    else:
        declared = deep_scan_charts(content)

    images, pngs = list_embedded_images(zf, fmt)
    verdict.metric("charts_declared", declared)
    verdict.metric("charts_embedded", len(pngs))
    verdict.metric("images_embedded_total", len(images))

    if declared == 0:
        return

    # C1: chart PNGs can be indistinguishable from photos inside the package,
    # so only fail hard when the TOTAL image count is below the declared chart
    # count (guaranteed at least one chart is missing; avoids false positives).
    if len(images) < declared:
        verdict.hard(
            "C1",
            f"선언 차트 {declared}개 > 삽입 이미지 총수 {len(images)}개",
            sample="; ".join(images[:5]) or "(이미지 없음)",
        )

    # C2: embedded PNGs must be real, non-trivial, non-solid images.
    if Image is None:
        verdict.warn("C2", "Pillow 미설치로 PNG 픽셀 검사 생략")
        return
    for name in pngs:
        try:
            data = zf.read(name)
        except Exception as exc:
            verdict.hard("C2", f"PNG 읽기 실패: {exc}", sample=name)
            continue
        if len(data) <= 1024:
            verdict.hard("C2", f"PNG가 1KB 이하({len(data)}B)", sample=name)
            continue
        try:
            img = Image.open(io.BytesIO(data))
            img.load()
        except Exception as exc:
            verdict.hard("C2", f"Pillow로 열 수 없는 PNG: {exc}", sample=name)
            continue
        w, h = img.size
        if w <= 100 or h <= 100:
            verdict.hard("C2", f"PNG 크기 {w}x{h} (100x100 이하)", sample=name)
            continue
        try:
            probe = img.convert("RGB")
            probe.thumbnail((256, 256))
            stat = ImageStat.Stat(probe)
            max_std = max(stat.stddev) if stat.stddev else 0.0
            if max_std < 2.0:
                verdict.hard("C2", f"PNG가 사실상 단색(stddev={max_std:.2f})", sample=name)
        except Exception as exc:
            verdict.warn("C2", f"픽셀 통계 실패: {exc}", sample=name)


# ---------------------------------------------------------------------------
# Table-vs-source rules (T1/T2)
# ---------------------------------------------------------------------------
def _norm_float(s):
    try:
        return float(s.replace(",", ""))
    except (ValueError, AttributeError):
        return None


def _sig(x, n=4):
    if x == 0 or not math.isfinite(x):
        return 0.0
    return round(x, n - 1 - int(math.floor(math.log10(abs(x)))))


def _decimals(s):
    s = s.replace(",", "")
    if "e" in s.lower():
        return 0
    if "." in s:
        return len(s.split(".", 1)[1])
    return 0


def extract_numbers(text):
    out = []
    for m in NUMBER_RE.finditer(text):
        raw = m.group(0)
        val = _norm_float(raw)
        if val is not None and math.isfinite(val):
            out.append((val, raw))
    return out


def load_canonical_numbers(paths, verdict):
    """canonical.json = lib/excel-parser.js parseToTables output:
    {tables:[{sheetName, headers, rows, ...}], ...} — also accepts a bare
    table dict {headers, rows} or a list of either."""
    numbers = []

    def eat_table(tbl):
        if not isinstance(tbl, dict):
            return
        for header in tbl.get("headers") or []:
            numbers.extend(extract_numbers(str(header)))
        for row in tbl.get("rows") or []:
            if isinstance(row, list):
                for cell in row:
                    numbers.extend(extract_numbers(str(cell)))

    def eat(node):
        if isinstance(node, dict):
            if "tables" in node and isinstance(node["tables"], list):
                for tbl in node["tables"]:
                    eat_table(tbl)
            elif "rows" in node or "headers" in node:
                eat_table(node)
        elif isinstance(node, list):
            for item in node:
                eat(item)

    for path in paths:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                eat(json.load(handle))
        except Exception as exc:
            verdict.warn("T1", f"canonical 데이터 로드 실패: {exc}", sample=path)
    return numbers


def check_table_numbers(cell_texts, canonical_numbers, verdict, type_key=None):
    report_numbers = []
    for cell in cell_texts:
        report_numbers.extend(extract_numbers(cell))
    total_canonical = len(canonical_numbers)
    verdict.metric("source_numbers", total_canonical)
    verdict.metric("report_table_numbers", len(report_numbers))

    if not canonical_numbers:
        verdict.warn("T1", "canonical 데이터에서 숫자를 추출하지 못함")
        return

    # Membership set over the FULL canonical list (cheap), so numbers from
    # every sheet (raw data + calc sheets) count as grounded even after the
    # recall sample is capped below.
    canon_sig_full = {_sig(v) for v, _ in canonical_numbers}

    # Cap by spread-sampling (not head-truncation) so multi-sheet sources
    # (e.g. raw-data sheet + calc sheet) all contribute to the reference set.
    if total_canonical > 2000:
        step = total_canonical / 2000.0
        canonical_numbers = [canonical_numbers[int(i * step)] for i in range(2000)]
    report_numbers = report_numbers[:5000]
    report_vals = [v for v, _ in report_numbers]
    report_sig = {_sig(v) for v in report_vals}
    # precision map: report value -> its printed decimal places
    report_prec = [(v, _decimals(raw)) for v, raw in report_numbers]

    def matched(v):
        if _sig(v) in report_sig:
            return True
        # rounding tolerance: v matches r if r is v rounded at r's precision
        for r, d in report_prec:
            if abs(v - r) <= 0.5 * (10 ** -d) * 1.0000001:
                return True
        return False

    total = len(canonical_numbers)
    hit = sum(1 for v, _ in canonical_numbers if matched(v))
    recall = hit / total if total else 1.0
    verdict.metric("table_number_recall", round(recall, 4))

    # T1 gating mode. Recall("report reproduces the source") is only a fair
    # hard gate when the report table could plausibly hold the source data
    # (small, hand-curated sheets). A raw-logger source (e.g. a 2000-row
    # time series) can never be transcribed into a report table; a correct
    # report excerpts key points and derives summary values (mean, ΔT, ΔH),
    # which structurally caps recall near 0. In that case the fabrication
    # check must run in the opposite direction: every report table number
    # should be *grounded* in the source (exact/rounded match or simple
    # arithmetic on source values).
    hard_recall, warn_recall = 0.30, 0.60
    summary_mode = len(report_numbers) < hard_recall * total_canonical
    verdict.metric("table_number_mode", "summary" if summary_mode else "full")

    def t1_fail(detail, sample):
        # free-type reports have optional/free-form data tables; keep T1
        # advisory there instead of a hard gate.
        if type_key == "free":
            verdict.warn("T1", detail + " [free 타입: hard→warn 완화]", sample=sample)
        else:
            verdict.hard("T1", detail, sample=sample)

    if not report_numbers:
        # numeric source but zero numbers anywhere in report tables:
        # data was dropped outright (old rule: recall 0 -> hard).
        t1_fail(
            f"보고서 표에 숫자가 하나도 없음 (원본 숫자 {total_canonical}개)",
            "",
        )
        return

    missing_samples = [raw for v, raw in canonical_numbers if not matched(v)][:10]
    if not summary_mode:
        if recall < hard_recall:
            t1_fail(
                f"원본 숫자 재현율 {recall:.2f} < {hard_recall:.2f} ({hit}/{total})",
                ", ".join(missing_samples),
            )
        elif recall < warn_recall:
            verdict.warn(
                "T1",
                f"원본 숫자 재현율 {recall:.2f} ({hard_recall:.2f}~{warn_recall:.2f}) ({hit}/{total})",
                sample=", ".join(missing_samples),
            )

    # Groundedness: report table numbers unexplained by source values or by
    # simple arithmetic on source pairs. Drives the summary-mode T1 hard gate
    # and the T2 warn. With a tiny canonical set the ratio is meaningless
    # (almost everything is "unexplained"), so require a minimum source size
    # before evaluating.
    if len(canonical_numbers) < 10:
        return
    canon_vals = [v for v, _ in canonical_numbers]
    # 4-significant-digit matching only: a 3-sig-digit net over pairwise
    # arithmetic is so dense it "explains" most fabricated numbers too.
    op_sig = set()
    base = canon_vals[:150]
    for i, a in enumerate(base):
        for b in base[i:]:
            for res in (a + b, a - b, b - a, a * b):
                if math.isfinite(res):
                    op_sig.add(_sig(res))
            if b != 0 and math.isfinite(a / b):
                op_sig.add(_sig(a / b))
            if a != 0 and math.isfinite(b / a):
                op_sig.add(_sig(b / a))

    considered = []
    unexplained = []
    for v, raw in report_numbers:
        # skip small integers (row indices, part numbers, list labels)
        if v == int(v) and abs(v) <= 20:
            continue
        considered.append((v, raw))
        if _sig(v) in canon_sig_full or _sig(v) in op_sig:
            continue
        unexplained.append(raw)
    if considered:
        ratio = len(unexplained) / len(considered)
        verdict.metric("table_number_unexplained_ratio", round(ratio, 4))
        if summary_mode:
            # Summary-mode T1: the report is a legitimate excerpt/derivation
            # of a large raw source, so fabrication shows up as table numbers
            # that trace back to nothing in the source.
            if ratio > 0.5 and len(unexplained) >= 8:
                t1_fail(
                    f"요약형 보고서: 원본·파생값으로 설명 안 되는 표 숫자 비율 "
                    f"{ratio:.2f} ({len(unexplained)}/{len(considered)})",
                    ", ".join(unexplained[:10]),
                )
            elif ratio > 0.25 and len(unexplained) >= 5:
                verdict.warn(
                    "T1",
                    f"요약형 보고서: 원본·파생값으로 설명 안 되는 표 숫자 비율 "
                    f"{ratio:.2f} ({len(unexplained)}/{len(considered)})",
                    sample=", ".join(unexplained[:10]),
                )
        if ratio > 0.5 and len(unexplained) >= 8:
            verdict.warn(
                "T2",
                f"원본·사칙연산으로 설명 안 되는 표 숫자 비율 {ratio:.2f} ({len(unexplained)}/{len(considered)})",
                sample=", ".join(unexplained[:10]),
            )


# ---------------------------------------------------------------------------
# Preview rule (P1, hwpx only, warn-only)
# ---------------------------------------------------------------------------
def _read_prvtext(zf):
    try:
        raw = zf.read("Preview/PrvText.txt")
    except KeyError:
        return None
    for enc in ("utf-8", "utf-16", "utf-16-le"):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return raw.decode("utf-8", "replace")


def _find_title(content):
    """Shallow search for a title string in the content JSON (depth <= 3)."""
    queue = [(content, 0)]
    while queue:
        node, depth = queue.pop(0)
        if isinstance(node, dict):
            for key in ("title", "report_title", "subject"):
                val = node.get(key)
                if isinstance(val, str) and val.strip():
                    return val.strip()
            if depth < 3:
                for val in node.values():
                    if isinstance(val, (dict, list)):
                        queue.append((val, depth + 1))
        elif isinstance(node, list) and depth < 3:
            for val in node[:5]:
                queue.append((val, depth + 1))
    return None


def check_preview(zf, content, template_path, verdict):
    prv = _read_prvtext(zf)
    if prv is None:
        verdict.warn("P1", "Preview/PrvText.txt 없음")
        return
    if not prv.strip():
        verdict.warn("P1", "Preview/PrvText.txt가 비어 있음")
        return
    norm = re.sub(r"\s+", "", prv)

    if content is not None:
        title = _find_title(content)
        if title:
            probe = re.sub(r"\s+", "", title)[:8]
            if probe and probe not in norm:
                verdict.warn("P1", "PrvText에 content title 미포함", sample=title)

    if template_path:
        try:
            with zipfile.ZipFile(template_path) as tz:
                tpl = _read_prvtext(tz)
            if tpl is not None and re.sub(r"\s+", "", tpl) == norm:
                verdict.warn("P1", "PrvText가 템플릿 미리보기와 동일(갱신 안 됨)")
        except Exception as exc:
            verdict.warn("P1", f"템플릿 PrvText 비교 실패: {exc}", sample=template_path)


# ---------------------------------------------------------------------------
# docx rule (D1)
# ---------------------------------------------------------------------------
def check_docx_media(zf, trees, verdict):
    nameset = set(zf.namelist())
    referenced = set()
    missing = []

    for rels_name in [n for n in nameset if n.startswith("word/_rels/") and n.endswith(".rels")]:
        tree = trees.get(rels_name)
        if tree is None:
            continue
        base_dir = "word/"
        for el in tree.iter():
            if localname(el.tag) != "Relationship":
                continue
            rtype = el.get("Type") or ""
            target = el.get("Target") or ""
            if not rtype.endswith("/image"):
                continue
            if el.get("TargetMode") == "External":
                continue
            resolved = os.path.normpath(os.path.join(base_dir, target)).replace("\\", "/")
            referenced.add(resolved)
            if resolved not in nameset:
                missing.append(f"{rels_name} -> {target}")

    if missing:
        verdict.hard("D1", f"이미지 rel target이 zip에 없음 {len(missing)}건",
                     sample="; ".join(missing[:5]))

    media_files = [n for n in nameset if n.startswith("word/media/") and not n.endswith("/")]
    orphans = [n for n in media_files if n not in referenced]
    if orphans:
        verdict.hard("D1", f"어떤 rel에서도 참조되지 않는 media 파일 {len(orphans)}개",
                     sample="; ".join(orphans[:5]))
    verdict.metric("docx_media_files", len(media_files))

    # [Content_Types].xml must declare extensions used by media files.
    ct = trees.get("[Content_Types].xml")
    if ct is not None and media_files:
        declared_ext = set()
        overrides = set()
        for el in ct.iter():
            ln = localname(el.tag)
            if ln == "Default" and el.get("Extension"):
                declared_ext.add(el.get("Extension").lower())
            elif ln == "Override" and el.get("PartName"):
                overrides.add(el.get("PartName").lstrip("/"))
        for n in media_files:
            ext = os.path.splitext(n)[1].lstrip(".").lower()
            if ext and ext not in declared_ext and n not in overrides:
                verdict.hard("D1", f"[Content_Types].xml에 확장자 {ext} 미선언", sample=n)

    # B3 analogue for docx media (zero-byte / magic mismatch) — reported as B3.
    for n in media_files:
        try:
            data = zf.read(n)
        except Exception as exc:
            verdict.hard("B3", f"media 읽기 실패: {exc}", sample=n)
            continue
        if len(data) == 0:
            verdict.hard("B3", "media 파일이 0바이트", sample=n)
            continue
        ext = os.path.splitext(n)[1].lower()
        if ext in IMAGE_MAGIC and not data.startswith(IMAGE_MAGIC[ext]):
            verdict.hard("B3", f"매직바이트가 확장자({ext})와 불일치",
                         sample=f"{n}: {data[:4].hex()}")


# ---------------------------------------------------------------------------
# problem-set zip bundle (ZB1)
# ---------------------------------------------------------------------------
def check_zip_bundle(zf, verdict):
    names = [n for n in zf.namelist() if not n.endswith("/")]
    verdict.metric("bundle_files", names)
    pdfs = [n for n in names if n.lower().endswith(".pdf")]
    verdict.metric("bundle_pdfs", len(pdfs))
    if not pdfs:
        verdict.hard("ZB1", "zip 번들에 PDF가 하나도 없음",
                     sample="; ".join(names[:8]))
        return
    for name in pdfs:
        try:
            data = zf.read(name)
        except Exception as exc:
            verdict.hard("ZB1", f"PDF 읽기 실패: {exc}", sample=name)
            continue
        if not data.startswith(b"%PDF"):
            verdict.hard("ZB1", "%PDF 매직바이트 없음", sample=f"{name}: {data[:8]!r}")
            continue
        if fitz is None:
            verdict.warn("ZB1", "pymupdf 미설치로 페이지 검사 생략", sample=name)
            continue
        try:
            doc = fitz.open(stream=data, filetype="pdf")
            if doc.page_count < 1:
                verdict.hard("ZB1", "PDF 페이지 수 0", sample=name)
            doc.close()
        except Exception as exc:
            verdict.hard("ZB1", f"pymupdf로 열 수 없는 PDF: {exc}", sample=name)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def detect_format(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".hwpx":
        return "hwpx"
    if ext == ".docx":
        return "docx"
    if ext == ".zip":
        return "zip"
    return ext.lstrip(".") or "unknown"


def run_checks(args, verdict):
    fmt = verdict.data["format"]
    type_key = args.type
    cfg = TYPE_CONFIG.get(type_key)
    if cfg is None:
        raise ValueError(f"알 수 없는 --type: {type_key} (허용: {', '.join(sorted(TYPE_CONFIG))})")

    if fmt not in cfg["formats"]:
        verdict.warn(
            "W-FORMAT",
            f"type={type_key}의 허용 포맷 {sorted(cfg['formats'])}에 없는 포맷 {fmt}",
        )

    content = None
    if args.content:
        with open(args.content, "r", encoding="utf-8") as handle:
            content = json.load(handle)

    zf = check_container(args.output, fmt, verdict)
    if zf is None:
        return  # cannot proceed without a readable container

    with zf:
        if fmt == "zip":
            if type_key == "problem-set":
                check_zip_bundle(zf, verdict)
            else:
                verdict.warn("W-FORMAT", "problem-set 외 타입의 zip은 컨테이너(Z1) 검사만 수행")
            return

        if fmt not in ("hwpx", "docx"):
            verdict.warn("W-FORMAT", f"검사 규칙이 정의되지 않은 포맷: {fmt}")
            return

        trees = parse_xml_entries(zf, verdict)
        check_control_chars(trees, verdict)

        if fmt == "hwpx":
            check_hwpx_id_refs(zf, trees, verdict)
            manifest_items = check_hwpx_binary_refs(zf, trees, verdict)
            check_hwpx_bindata(zf, trees, manifest_items, verdict)
        else:
            check_docx_media(zf, trees, verdict)

        lines, table_count, cell_texts = extract_body_lines(zf, trees, fmt, verdict)
        verdict.metric("tables", table_count)
        check_body_text(lines, verdict)

        if content is not None and cfg.get("charts"):
            check_charts(zf, fmt, content, cfg, verdict)

        if args.source_data:
            canonical = load_canonical_numbers(args.source_data, verdict)
            check_table_numbers(cell_texts, canonical, verdict, type_key)

        if fmt == "hwpx":
            check_preview(zf, content, args.template, verdict)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Quilo 보고서 산출물 결정론적 검증기")
    parser.add_argument("output", help="검증할 산출물 (.hwpx / .docx / .zip)")
    parser.add_argument("--type", required=True, dest="type",
                        help="파이프라인 타입 (chem-pre/chem-result/phys-result/free/reading-log/form-maker/problem-set)")
    parser.add_argument("--content", default=None, help="파이프라인 content JSON (차트/제목 대조용)")
    parser.add_argument("--source-data", action="append", default=[],
                        help="parseToTables 형식 canonical JSON (반복 지정 가능)")
    parser.add_argument("--template", default=None, help="기준 템플릿 hwpx (PrvText 대조용)")
    parser.add_argument("--json", dest="json_path", default=None, help="verdict JSON 저장 경로")
    args = parser.parse_args(argv)

    fmt = detect_format(args.output)
    verdict = Verdict(os.path.abspath(args.output), args.type, fmt)
    exit_code = EXIT_OK

    if etree is None:
        verdict.verr("import", RuntimeError("lxml이 설치되어 있지 않음"))
    elif not os.path.isfile(args.output):
        verdict.verr("input", FileNotFoundError(args.output))
    else:
        try:
            run_checks(args, verdict)
        except Exception as exc:
            verdict.verr("run_checks", exc)

    if verdict.verifier_errors:
        verdict.data["passed"] = False
        verdict.data["verifier_errors"] = verdict.verifier_errors
        exit_code = EXIT_INTERNAL_ERROR
    elif verdict.data["hard_failures"]:
        exit_code = EXIT_HARD_FAIL

    # --json must always be written before exiting.
    if args.json_path:
        try:
            with open(args.json_path, "w", encoding="utf-8") as handle:
                json.dump(verdict.data, handle, ensure_ascii=False, indent=2)
        except Exception as exc:
            print(f"verdict JSON 저장 실패: {exc}", file=sys.stderr)
            exit_code = EXIT_INTERNAL_ERROR

    hard_n = len(verdict.data["hard_failures"])
    warn_n = len(verdict.data["warnings"])
    if exit_code == EXIT_INTERNAL_ERROR:
        status = "ERROR"
    elif hard_n:
        status = "FAIL"
    else:
        status = "PASS"
    rules = ",".join(sorted({f["rule"] for f in verdict.data["hard_failures"]})) or "-"
    print(
        f"[verify_report_output] {status} {os.path.basename(args.output)} "
        f"type={args.type} format={fmt} hard={hard_n}({rules}) warn={warn_n}",
        file=sys.stderr,
    )
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
