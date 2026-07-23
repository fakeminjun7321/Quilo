#!/usr/bin/env python3
"""phys-result HWPX generator.

Builds the same two-section physics result report used by docx-gen.js:

1. 실험 결과
2. 결론

The visual structure follows the supplied HWPX physics-result template: compact
A4 margins, the first-page "실험 주제" title box, and the general-physics footer. Tables,
charts, and uploaded photos are embedded directly into the HWPX package.
"""
import base64
from copy import deepcopy
import importlib.util
import json
import re
import shutil
import struct
import sys
import tempfile
import zipfile
from pathlib import Path
from lxml import etree

HERE = Path(__file__).resolve().parent
PRE_HWPX = HERE.parent / "chem-pre" / "hwpx-gen.py"
TEMPLATE_HWPX = HERE / "templates" / "result-report-template.hwpx"
spec = importlib.util.spec_from_file_location("chem_pre_hwpx_gen", PRE_HWPX)
pre = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pre)

from hwpx import HwpxDocument


PAGE_WIDTH = 59528
PAGE_HEIGHT = 84188
PAGE_MARGIN_LR = 4252
PAGE_MARGIN_TOP = 2835
PAGE_MARGIN_BOTTOM = 2835
PAGE_HEADER = 3402
PAGE_FOOTER = 3969
PHYS_TABLE_WIDTH = 30300

MAX_IMAGE_WIDTH = 19800
MAX_IMAGE_HEIGHT = 13800
MAX_CHART_WIDTH = 21600
MAX_CHART_HEIGHT = 13800
PX_TO_HWPUNIT = 75


def as_list(value):
    return value if isinstance(value, list) else []


def decode_base64(value):
    if not value:
        return b""
    try:
        return base64.b64decode(value)
    except Exception:
        return b""


def clean_label(text):
    return re.sub(r"^\s*\[(?:그림|그래프)\s*\d+\]\s*", "", str(text or "")).strip()


def image_format(name="", mimetype="", data=b""):
    name_ext = Path(str(name or "")).suffix.lower().lstrip(".")
    if name_ext in ("jpg", "jpeg", "png", "gif", "bmp"):
        return "jpg" if name_ext == "jpeg" else name_ext
    mt = str(mimetype or "").lower()
    if "jpeg" in mt:
        return "jpg"
    if "png" in mt:
        return "png"
    if "gif" in mt:
        return "gif"
    if "bmp" in mt:
        return "bmp"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8"):
        return "jpg"
    if data.startswith(b"GIF8"):
        return "gif"
    if data.startswith(b"BM"):
        return "bmp"
    return "png"


def image_size(data):
    try:
        if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
            return struct.unpack(">II", data[16:24])
        if data.startswith(b"GIF8") and len(data) >= 10:
            return struct.unpack("<HH", data[6:10])
        if data.startswith(b"BM") and len(data) >= 26:
            w = struct.unpack("<I", data[18:22])[0]
            h = abs(struct.unpack("<i", data[22:26])[0])
            return w, h
        if data.startswith(b"\xff\xd8"):
            i = 2
            while i + 9 < len(data):
                while i < len(data) and data[i] == 0xFF:
                    i += 1
                marker = data[i]
                i += 1
                if marker in (0xD8, 0xD9):
                    continue
                if i + 2 > len(data):
                    break
                size = struct.unpack(">H", data[i:i + 2])[0]
                if marker in range(0xC0, 0xC4) and i + 7 < len(data):
                    h, w = struct.unpack(">HH", data[i + 3:i + 7])
                    return w, h
                i += size
    except Exception:
        pass
    return 800, 500


def fit_size(width_px, height_px, max_width, max_height):
    width = max(int(width_px * PX_TO_HWPUNIT), 1)
    height = max(int(height_px * PX_TO_HWPUNIT), 1)
    scale = min(max_width / width, max_height / height, 1)
    return max(int(width * scale), 1), max(int(height * scale), 1), width, height


def load_template_doc():
    if TEMPLATE_HWPX.exists():
        return HwpxDocument.open(TEMPLATE_HWPX)
    return None


def clear_template_body(doc):
    """Keep the template's section/header/footer paragraph and remove only
    the instructional body placeholders.
    """
    paragraphs = list(doc.paragraphs)
    for paragraph in reversed(paragraphs[1:]):
        doc.remove_paragraph(paragraph)


def clear_cell(cell):
    parent = cell.element
    for p in parent.findall(f"{pre.NS_HP}subList/{pre.NS_HP}p"):
        p.getparent().remove(p)
    for p in parent.findall(f"{pre.NS_HP}p"):
        p.getparent().remove(p)


def find_template_body_cells(doc):
    result_cell = None
    conclusion_cell = None
    for idx, paragraph in enumerate(getattr(doc, "paragraphs", [])):
        text = getattr(paragraph, "text", "") or ""
        tables = getattr(paragraph, "tables", []) or []
        if tables:
            continue
        next_tables = []
        if idx + 1 < len(doc.paragraphs):
            next_tables = getattr(doc.paragraphs[idx + 1], "tables", []) or []
        if "1. 실험 결과" in text and next_tables:
            result_cell = next_tables[0].cell(0, 0)
        if "2. 결론" in text and next_tables:
            conclusion_cell = next_tables[0].cell(0, 0)
    return result_cell, conclusion_cell


def fill_template_title(doc, content):
    title = content.get("title") or content.get("title_en") or content.get("title_kr") or "물리 결과보고서"
    # (DEF-019) 템플릿 첫 페이지에 학번·날짜 기입 - 제목 채우기 경로를 그대로
    # 재사용해, 채운 제목 run '바로 뒤'에 같은 서식의 run 하나만 덧붙인다.
    # 값이 없으면 아무것도 안 한다. 제목 박스는 고정 크기(hp:sz) 한 줄 사각형
    # 이라 문단을 추가하면 잘릴 수 있고, header→body 이동은 macOS/Windows
    # 한컴 미오픈 회귀 전력이 있어(CLAUDE.md HWPX 규칙) 구조 변경은 하지
    # 않는다 - 기존 문단 안 run 추가는 텍스트 채우기와 동급의 안전 변경이다.
    student_id = str(content.get("student_id") or "").strip()
    date = str(content.get("date") or "").strip()
    id_date_suffix = ", ".join(v for v in (student_id, date) if v)
    changed = False
    for sec in getattr(doc.oxml, "sections", []):
        element = getattr(sec, "element", None)
        if element is None:
            continue
        for paragraph in element.iter(f"{pre.NS_HP}p"):
            text_nodes = list(paragraph.iter(f"{pre.NS_HP}t"))
            for idx, node in enumerate(text_nodes):
                if not node.text or "(반드시 기재)" not in node.text:
                    continue
                node.text = node.text.replace("(반드시 기재)", title)
                run = node.getparent()
                if idx > 0:
                    prev = text_nodes[idx - 1]
                    if prev.text and "실험 주제" in prev.text:
                        prev.text = re.sub(r"(실험\s*주제\s*:).*", r" \1 ", prev.text)
                        prev_run = prev.getparent()
                        if run is not None and prev_run is not None and prev_run.get("charPrIDRef"):
                            run.set("charPrIDRef", prev_run.get("charPrIDRef"))
                if id_date_suffix and run is not None:
                    tail_run = etree.Element(f"{pre.NS_HP}run")
                    if run.get("charPrIDRef"):
                        tail_run.set("charPrIDRef", run.get("charPrIDRef"))
                    tail_t = etree.SubElement(tail_run, f"{pre.NS_HP}t")
                    tail_t.text = f"  ({id_date_suffix})"
                    # 제목 run 바로 다음 형제로 삽입 - linesegarray 등 뒤따르는
                    # 요소 순서(스키마: run들 뒤 linesegarray)를 깨지 않는다.
                    run.addnext(tail_run)
                changed = True
        if changed and hasattr(sec, "mark_dirty"):
            sec.mark_dirty()


def make_template_title_header_first_page_only(doc):
    """The supplied template stores the title box as an ODD-page header.

    If left as-is, Hancom repeats "실험 주제" on pages 1, 3, 5... . The HWPX
    FIRST page type keeps the same template object but restricts it to page 1.
    """
    changed = False
    for sec in getattr(doc.oxml, "sections", []):
        element = getattr(sec, "element", None)
        if element is None:
            continue
        for header in element.iter(f"{pre.NS_HP}header"):
            text = "".join(t.text or "" for t in header.iter(f"{pre.NS_HP}t"))
            if "실험 주제" in text and header.get("applyPageType") != "FIRST":
                header.set("applyPageType", "FIRST")
                changed = True
        if changed and hasattr(sec, "mark_dirty"):
            sec.mark_dirty()


def move_template_title_header_to_first_body_anchor(doc):
    """⚠️ 사용 금지(DEAD CODE) — 호출하지 말 것.
    이 함수는 제목 박스를 header 에서 body 로 옮긴다. CLAUDE.md "HWPX 생성 규칙"과
    docs/phys-result-pipeline.md §19.3 가 명시적으로 금지한 동작이며, 과거 macOS/
    Windows 한컴에서 파일이 열리지 않는 회귀를 일으켰다. 제목 반복 문제는
    make_template_title_header_first_page_only() 로 해결한다. 참고용으로만 남겨 둔다.

    Render the template title box only once by anchoring it in body text.

    HWPX headers support odd/even/both page types, but not a reliable
    first-page-only header. Hancom may therefore repeat the template title box
    on later pages even if the XML is patched to a nonstandard FIRST value.
    Keep the exact template rectangle, but attach a cloned copy to the first
    body paragraph and remove the original title header control.
    """
    changed = False
    for sec in getattr(doc.oxml, "sections", []):
        element = getattr(sec, "element", None)
        if element is None:
            continue

        top_paragraphs = element.findall(f"{pre.NS_HP}p")
        if not top_paragraphs:
            continue
        anchor_para = next(
            (p for p in top_paragraphs if p.find(f".//{pre.NS_HP}secPr") is not None),
            top_paragraphs[0],
        )

        title_shapes = []
        for header in list(element.iter(f"{pre.NS_HP}header")):
            text = "".join(t.text or "" for t in header.iter(f"{pre.NS_HP}t"))
            if "실험 주제" not in text:
                continue

            for shape in header.findall(f".//{pre.NS_HP}rect"):
                parent_run = shape.getparent()
                title_shapes.append((deepcopy(shape), parent_run.get("charPrIDRef") if parent_run is not None else None))

            ctrl = header.getparent()
            run = ctrl.getparent() if ctrl is not None else None
            if ctrl is not None and run is not None:
                run.remove(ctrl)
                if len(run) == 0:
                    run_parent = run.getparent()
                    if run_parent is not None:
                        run_parent.remove(run)
            elif ctrl is not None:
                parent = ctrl.getparent()
                if parent is not None:
                    parent.remove(ctrl)
            changed = True

        if not title_shapes:
            continue

        children = list(anchor_para)
        line_seg = anchor_para.find(f"{pre.NS_HP}linesegarray")
        insert_at = children.index(line_seg) if line_seg is not None and line_seg in children else len(children)
        for shape, char_pr in title_shapes:
            _assign_fresh_ids(element, shape)
            run = etree.Element(f"{pre.NS_HP}run")
            if char_pr:
                run.set("charPrIDRef", char_pr)
            run.append(shape)
            etree.SubElement(run, f"{pre.NS_HP}t").text = ""
            anchor_para.insert(insert_at, run)
            insert_at += 1
            changed = True

        if changed and hasattr(sec, "mark_dirty"):
            sec.mark_dirty()


def _next_xml_id(root):
    used = []
    for elem in root.iter():
        value = elem.get("id")
        if value and value.lstrip("-").isdigit():
            used.append(int(value))
    counter = max(used) + 1 if used else 1

    def next_id():
        nonlocal counter
        value = str(counter)
        counter += 1
        return value

    return next_id


def _assign_fresh_ids(root, subtree):
    next_id = _next_xml_id(root)
    for elem in subtree.iter():
        value = elem.get("id")
        if value and value.lstrip("-").isdigit():
            elem.set("id", next_id())


def move_template_title_header_to_body(doc):
    """⚠️ 사용 금지(DEAD CODE) — 호출하지 말 것.
    header subList 를 top-level body 로 옮기는 동작은 CLAUDE.md "HWPX 생성 규칙"과
    docs/phys-result-pipeline.md §19.3 가 금지한다(한컴 열림 실패 회귀). 제목 반복은
    make_template_title_header_first_page_only() 로 처리한다.

    Keep the template title box on page 1 without repeating it as a header."""
    moved = False
    for sec in getattr(doc.oxml, "sections", []):
        element = getattr(sec, "element", None)
        if element is None:
            continue

        title_headers = []
        for header in list(element.iter(f"{pre.NS_HP}header")):
            text = "".join(t.text or "" for t in header.iter(f"{pre.NS_HP}t"))
            if "실험 주제" in text:
                title_headers.append(header)

        if not title_headers:
            continue

        top_level = list(element)
        insert_at = (
            1
            if top_level and top_level[0].find(f".//{pre.NS_HP}secPr") is not None
            else 0
        )
        for header in title_headers:
            sublist = header.find(f"{pre.NS_HP}subList")
            if sublist is not None:
                for para in sublist.findall(f"{pre.NS_HP}p"):
                    clone = deepcopy(para)
                    _assign_fresh_ids(element, clone)
                    element.insert(insert_at, clone)
                    insert_at += 1
                    moved = True
            parent = header.getparent()
            if parent is not None:
                parent.remove(header)

        if moved and hasattr(sec, "mark_dirty"):
            sec.mark_dirty()


def add_paragraph_to(target, text="", *, para_pr_id_ref=None):
    if hasattr(target, "add_paragraph"):
        try:
            return target.add_paragraph(
                text,
                para_pr_id_ref=para_pr_id_ref,
                inherit_style=False,
                include_run=False,
            )
        except TypeError:
            return target.add_paragraph(text, para_pr_id_ref=para_pr_id_ref)
    raise TypeError("target does not support add_paragraph")


GREEK_TO_LATEX = {
    "α": r"\alpha",
    "β": r"\beta",
    "γ": r"\gamma",
    "δ": r"\delta",
    "ε": r"\epsilon",
    "ϵ": r"\epsilon",
    "ζ": r"\zeta",
    "η": r"\eta",
    "θ": r"\theta",
    "ϑ": r"\theta",
    "ι": r"\iota",
    "κ": r"\kappa",
    "λ": r"\lambda",
    "μ": r"\mu",
    "ν": r"\nu",
    "ξ": r"\xi",
    "π": r"\pi",
    "ρ": r"\rho",
    "σ": r"\sigma",
    "τ": r"\tau",
    "υ": r"\upsilon",
    "φ": r"\phi",
    "ϕ": r"\phi",
    "χ": r"\chi",
    "ψ": r"\psi",
    "ω": r"\omega",
    "Γ": r"\Gamma",
    "Δ": r"\Delta",
    "Θ": r"\Theta",
    "Λ": r"\Lambda",
    "Ξ": r"\Xi",
    "Π": r"\Pi",
    "Σ": r"\Sigma",
    "Φ": r"\Phi",
    "Ψ": r"\Psi",
    "Ω": r"\Omega",
}

SUPERSCRIPT_TO_LATEX = str.maketrans({
    "⁰": "0",
    "¹": "1",
    "²": "2",
    "³": "3",
    "⁴": "4",
    "⁵": "5",
    "⁶": "6",
    "⁷": "7",
    "⁸": "8",
    "⁹": "9",
    "⁺": "+",
    "⁻": "-",
})
SUBSCRIPT_TO_LATEX = str.maketrans({
    "₀": "0",
    "₁": "1",
    "₂": "2",
    "₃": "3",
    "₄": "4",
    "₅": "5",
    "₆": "6",
    "₇": "7",
    "₈": "8",
    "₉": "9",
    "₊": "+",
    "₋": "-",
})
# '|' 는 절댓값(|I_pivot - I_cm|), '%' 는 %Diff(Capstone 계산 column) 표기 —
# 빠지면 '%Diff = |…|/…' 식이 'Diff =' 까지만 잡혀 파편 수식 + raw 파이프
# 산문으로 갈라진다. 시작 문자에도 두 글자를 허용해 식 전체를 한 덩어리로
# 잡는다(홀수 파이프 가드는 is_probable_physics_formula 쪽).
# 그리스 글자(소·대문자 전체)와 벡터 미적분 연산자(∇▽∂∫∬∭∮∯∰∑∏ 등)를 포함해야
# '▽·E = ρ/ε₀', '∭_V (▽·F) dV = ∯_∂V F·dA' 같은 식이 앞뒤 잘림 없이 한 덩어리로
# 잡힌다. 빠지면 연산자/그리스 경계에서 식이 토막나 산문에 raw 기호가 남는다.
_FORMULA_GREEK = "αβγδεϵζηθϑικλμνξπρστυφϕχψωΓΔΘΛΞΠΣΦΨΩ"
_FORMULA_OPERATORS = "∇▽∂∫∬∭∮∯∰∑∏≡≅∝∞∈∉⟨⟩∓∘∠"
# 수식 문자 '본체' - 공백과 마침표는 뺀 나머지. 이 둘은 아래에서 문맥 제한을
# 걸어 붙인다. 예전처럼 \s(줄바꿈 포함)와 '.'를 클래스 통짜로 넣으면 인라인
# 수식 범위가 문장 마침표/줄바꿈을 넘어 '…/g). (2' 처럼 닫는 괄호, 마침표,
# 다음 항목 번호까지 삼키고, JSON에서 줄바꿈으로 분리돼 있던 (1)/(2) 항목이
# 한 문단으로 병합된다(R0 phys-atwood 실측, DEF-018 D-1).
_FORMULA_CHAR_BODY = (
    r"A-Za-z0-9"
    + _FORMULA_GREEK
    + _FORMULA_OPERATORS
    + r"_\{\}\^\*\+\-=−–—≈≃≅≡≤≥≠<>/\\\(\)\[\],\|"
    r"·×√½°%′'⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻₀₁₂₃₄₅₆₇₈₉₊₋\u0302\u0303\u0304\u0307\u0308"
)
# 하위 호환 공개 이름 - 본체 + 마침표 + 공백. 공백은 스페이스/탭만 넣고
# 줄바꿈(\n)은 제외한다(인라인 수식은 한 줄 안에서만 성립).
FORMULA_CHAR_CLASS = _FORMULA_CHAR_BODY + r"\. \t"
# 인라인 수식 본문 1글자: 수식 문자(스페이스/탭 포함, 줄바꿈 제외) 또는 '숫자
# 사이' 마침표(소수점 9.8, 0.0933)만 허용한다. 문장 종결 마침표('…한다.',
# '…). (2')는 숫자 사이가 아니라서 수식 범위가 거기서 끊긴다. 마침표 뒤
# 내용은 re.sub 스캔이 이어서 보므로 별도 수식으로 다시 판정된다. (DEF-018 D-1)
_FORMULA_BODY_ATOM = rf"(?:[{_FORMULA_CHAR_BODY} \t]|(?<=\d)\.(?=\d))"
# 식의 '첫 글자'로도 연산자/그리스가 올 수 있어야 '▽·E=...', '∭_V ...=...',
# '∠ABC = 90°', '∞ = ...' 가 통째로 승격된다(연산자 prefix 가 산문에 떨어지는
# 토막 현상 방지). 미적분 연산자(∇▽∂∫∬∭∮∯∰∑∏)에 더해 식 시작이 자연스러운
# 관계·집합·각도 연산자(∠≡≅∝∞∈∉⟨∓∘)도 포함한다. ⟩ 같은 '닫는' 기호는 식
# 시작으로 부적합하므로 제외한다. 오탐은 is_probable_physics_formula 가드가 막는다.
FORMULA_START_CLASS = (
    r"A-Za-z0-9" + _FORMULA_GREEK + "∇▽∂∫∬∭∮∯∰∑∏∠≡≅∝∞∈∉⟨∓∘" + r"\*\(\{%\|"
)
# 본문 반복을 _FORMULA_BODY_ATOM 으로 구성해 마침표는 소수점 문맥에서만,
# 공백은 스페이스/탭만 허용한다(문장 마침표/줄바꿈에서 수식 범위 종료). (D-1)
INLINE_FORMULA_RE = re.compile(
    rf"(?<![A-Za-z0-9_])([{FORMULA_START_CLASS}]{_FORMULA_BODY_ATOM}{{0,120}}?"
    rf"(?:=|≈|≃|≅|≡|≤|≥|≠|∝)"
    rf"{_FORMULA_BODY_ATOM}{{1,160}})"
)


# ── 키보드로 못 치는 기호 = 한글 수식 객체 트리거 (사용자 규칙 2026-06-15) ──────
# 수식 한 덩어리 전체가 키보드(영문·숫자·= + - * ( ) . , 등)로만 되면 텍스트로 두고,
# 키보드로 못 치는 기호가 하나라도 있으면 그 수식 '전체'를 한글 수식 객체로 만든다.
# STRONG 트리거: 그리스, 미적분/관계/집합/기하 연산자, 유니코드 위·아래첨자, 특수문자
# (ℏℓÅ°∞½ 등), 그리고 키보드로 치지만 텍스트로 위첨자·아래첨자·분수로 안 보이는 ^ _ /.
# WEAK(· × → ← 등)는 단독 트리거에서 제외 — 영문 나열 'divergence·curl' 이 수식으로
# 오인되지 않게(강한 트리거가 같이 있을 때만 수식에 포함). a + b = 0 처럼 키보드로만
# 되는 식은 트리거가 없어 텍스트로 남는다.
_EQ_TRIGGER_SYMBOLS = (
    _FORMULA_GREEK
    + "\u2207\u25bd\u2202\u222b\u222c\u222d\u222e\u222f\u2230\u2211\u220f\u221a"
    + "\u2248\u2243\u2245\u2261\u2264\u2265\u2260\u226a\u226b\u221d\u221e"
    + "\u2208\u2209\u2282\u2283\u2286\u2287\u222a\u2229\u2200\u2203\u2205"
    + "\u22a5\u2225\u2220\u2234\u2235\u27e8\u27e9\u00b1\u2213\u00f7"
    + "\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079\u207a\u207b\u207f\u2071"
    + "\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089\u208a\u208b"
    + "\u210f\u2113\u00c5\u00b5\u00b0\u00bd\u00bc\u00be\u2153\u2154\u215b\u2032\u2033"
    + "\u2090\u2091\u2092\u2093\u2094\u2095\u2096\u2097\u2098\u2099"
    + "\u0302\u0303\u0304\u0307\u0308"
)
_EQ_TRIGGER_RE = re.compile("[" + _EQ_TRIGGER_SYMBOLS + r"\^_/]")

# '/'·'_' 만 빼고 본 '진짜' 강한 트리거(그리스·연산자·유니코드 첨자·특수문자·^·{}스크립트).
# '/'·'_' 는 날짜(2026/06/15)·경로(data/run1.csv)·약어(TCP/IP)·인용키(Lee_2020) 등
# 비수식 산문에 흔해서 단독으로는 수식 근거가 못 된다. 이 정규식이 한 번이라도
# 잡히면(=ε·^·{} 등이 같이 있으면) 그 토큰은 '/'·'_' 와 무관하게 진짜 수식이다.
_STRONG_TRIGGER_RE = re.compile("[" + _EQ_TRIGGER_SYMBOLS + r"\^{}]")


def _needs_equation(expr):
    """수식 한 덩어리가 키보드로만 안 되면(기호/^/_// 포함) True — 수식 객체로."""
    return bool(_EQ_TRIGGER_RE.search(str(expr or "")))


# ── '/'·'_' 단독 트리거 오탐 가드 (사용자 규칙 2026-06-15) ─────────────────────
# '/'·'_' 외에 강한 트리거(_STRONG_TRIGGER_RE)가 같이 있으면 진짜 수식이므로
# 통과(q/ε₀, x^2, I_{pivot}=mgdT^{2}/(4π²) 등). 강한 트리거가 전혀 없고 '/'·'_'
# 만으로 후보가 됐다면, 아래 산문 패턴(날짜·경로·버전·약어·단위·비율·인용키·
# 한글 사이 나열 슬래시 등)은 수식이 아니라 텍스트로 본다.
_DATEISH_RE = re.compile(r"^\d{1,4}/\d{1,4}(?:/\d{1,4})*$")           # 2026/06/15, 3/14, 9/10, 24/7
_PATHISH_RE = re.compile(r"[A-Za-z0-9_.\-]+/[A-Za-z0-9_./\-]")        # data/run1.csv, /api/x, a/b/c
_VERSIONISH_RE = re.compile(r"[A-Za-z]?\d+\.\d")                       # v2.0, 1.5  (점 찍힌 버전/소수)
# '_' 가 분수/첨자가 아니라 식별자(파일명·인용키·이메일 로컬파트)의 구분자인 경우:
# '두 글자 이상' 단어 뒤의 '_' 는 식별자 구분자로 본다(Lee_2020, my_file_name,
# first_last). 물리 아래첨자는 base 가 보통 한 글자라서(I_pivot, v_cm, x_max,
# T_0) 여기 안 걸리고 정상 승격된다.
_IDENT_UNDERSCORE_RE = re.compile(r"[A-Za-z]{2,}_[A-Za-z0-9]")


def _slash_underscore_is_prose(core):
    """'/'·'_' 만으로 수식 후보가 된 산문(날짜·경로·약어·비율·인용키)인지 판정.

    강한 트리거(_STRONG_TRIGGER_RE: 그리스·연산자·유니코드첨자·^·{} 등)가 하나라도
    있으면 진짜 수식이므로 False(가드 통과). '/'·'_' 가 유일한 트리거일 때만
    아래 비수식 패턴을 텍스트로 돌린다(True).
    """
    s = str(core or "")
    if _STRONG_TRIGGER_RE.search(s):
        return False  # ε·^·{} 등 진짜 수식 신호가 있으면 가드하지 않는다.
    has_slash = "/" in s
    has_underscore = "_" in s
    if not has_slash and not has_underscore:
        return False  # '/'·'_' 가 없으면 이 가드 대상 아님(다른 트리거가 처리).

    if has_slash:
        # 슬래시 양쪽에 피연산자(영문/숫자/그리스/괄호군)가 모두 있어야 분수
        # 후보. 괄호도 피연산자다 — 'g/(m1+m2)' 의 우변이 '(' 라고 산문으로
        # 돌리면 이론식 a_theory=(m2-m1)g/(m1+m2) 전체가 미승격된다(DEF-040
        # 리허설 실측). 한글 사이 슬래시(속도/시간)는 여전히 피연산자 없음.
        if not re.search(r"[A-Za-z0-9)\]]/[(\[A-Za-z0-9]", s):
            return True
        if _DATEISH_RE.match(s):
            return True  # 날짜·정수 비율·24/7 류
        if _PATHISH_RE.search(s) and (s.count("/") >= 2 or "." in s or s.startswith("/")):
            return True  # 경로·라우트·URL 조각(data/run1.csv, /api/x, a/b/c.pdf)
        if _VERSIONISH_RE.search(s):
            return True  # 버전 문자열(v2.0/beta)
        # 단일 슬래시 약어/단위/영문 나열(TCP/IP, m/s, input/output, w/o, N/A …):
        # 양쪽이 순수 영숫자(첨자·연산자 없음)이고 슬래시가 하나뿐이면 산문.
        # 괄호 '한 겹'으로 감싼 표 헤더 단위 '(kJ/mol)'/'(mol/L)' 도 알맹이
        # 기준으로 같은 판정을 한다 - 괄호가 fullmatch 가드를 무력화해 단위
        # 표기가 수식 승격 후 'k {J} over {m} o l' 로 분수화되던 실측 결함
        # (R0 free-1 표 헤더, DEF-018 D-3). 강한 트리거가 있는 '(m/s²)' 는
        # 이 함수 첫 가드에서 이미 수식으로 통과했으므로 영향이 없다.
        bare = s
        m_paren = re.fullmatch(r"\(([^()]+)\)", bare)
        if m_paren:
            bare = m_paren.group(1).strip()
        if bare.count("/") == 1 and re.fullmatch(r"[A-Za-z0-9]+/[A-Za-z0-9]+", bare):
            return True

    if has_underscore and _IDENT_UNDERSCORE_RE.search(s):
        return True  # Lee_2020, my_file_name, first_last (식별자·인용키)

    return False


def _is_real_math(core):
    """수식 후보가 한국어 산문·영문 나열이 아닌 진짜 수식 조각인지(트리거 무관)."""
    core = str(core or "").strip()
    if not core or "{{EQ" in core:
        return False
    if re.search(r"[가-힣]", core):
        return False
    if pre.count_english_prose_stopwords(core) >= 2:
        return False
    if core.count("|") % 2:
        return False
    # 중괄호가 안 맞으면(스트레이 '}}' 등) 수식이 아니다 — 정상 첨자 x^{2}·I_{cm} 은
    # 항상 짝이 맞는다. 짝 안 맞는 '}}' 조각을 승격하면 마커 경계가 어긋나 2차 통과가
    # 다르게 재분리(비멱등)된다. 마커 토막을 또 승격하는 경로를 원천 차단한다.
    if core.count("{") != core.count("}"):
        return False
    # 피연산자 없는 퇴화 조각(단독 '^','²','√','/','_','=' 등)은 수식이 아니다.
    # 진짜 식 조각은 base 글자(ASCII 영문/숫자·그리스)가 하나라도 있어야 한다.
    # 이게 없으면 마커 재분리(2차 통과)가 만든 토막을 또 승격해 비멱등이 된다.
    if not re.search(r"[A-Za-z0-9" + _FORMULA_GREEK + r"]", core):
        return False
    # '/'·'_' 만으로 후보가 된 날짜·경로·버전·약어·비율·인용키 산문은 텍스트로 둔다.
    if _slash_underscore_is_prose(core):
        return False
    return True


# 공백 없는 한 덩어리 토큰(= 없이도) — 강한 트리거가 있으면 통째 수식화한다.
# 토큰은 공백에서 끊기므로 문장 마침표 삼킴 문제가 없다 - 마침표는 토큰
# 내부용(9.8, 'Effect.' 뒤 strip 처리)으로 남긴다. (D-1 리팩터 동치 유지)
_SYMBOL_TOKEN_RE = re.compile("[" + _FORMULA_CHAR_BODY + r"\." + "]+")



PLAIN_SUBSCRIPTS = str.maketrans({
    "0": "₀",
    "1": "₁",
    "2": "₂",
    "3": "₃",
    "4": "₄",
    "5": "₅",
    "6": "₆",
    "7": "₇",
    "8": "₈",
    "9": "₉",
})


def _subscript_digit_notation(text):
    """x_2 → x₂ (유니코드 아래첨자) — 산문·수식 승격 양쪽에서 안전한 표기.

    base 글자는 단독 변수여야 한다 — 앞에 다른 글자가 붙은 단어 중간('Le|e_2020'의
    e)이나 뒤에 숫자가 더 이어지는 연도/식별자('_2020')는 아래첨자가 아니므로 둔다.
    그래야 인용키 Lee_2020 이 Lee₂020 으로 둔갑해 수식 트리거로 오인되지 않는다.
    """
    return re.sub(
        r"(?<![A-Za-z])([A-Za-zαβγδθλμπρστφωΩΔΣ])_([0-9])(?![0-9])",
        lambda m: f"{m.group(1)}{m.group(2).translate(PLAIN_SUBSCRIPTS)}",
        str(text or ""),
    )


# ── AI식 줄표(삽입구 dash) 후처리 안전망 (사용자 규칙 2026-06-15) ──────────────
# 모델이 프롬프트를 어기고 ' — '/' – '/' -- ' 를 삽입구로 쓰면, 최종 산문에서
# 쉼표로 바꾼다(AI 문체 제거). 수식 마커/객체 안과 수학 마이너스(-, U+2212),
# 붙은 범위 en-dash('10–20')는 절대 건드리지 않는다.
#   ⚠ 이 함수는 normalize_physics_equation_markers 가 마커 구간을 분리한 뒤
#     '평문 구간'에만 적용한다. 마커 내부(hp:equation 변환 대상)에는 닿지 않는다.
_AI_DASH_INLINE_RE = re.compile(r"\s+(?:—|–|--)\s+")
# 문장 끝/줄 끝에 매달린 단독 줄표(앞 공백 + em/en/이중하이픈 + 공백 없음) 제거.
_AI_DASH_TRAILING_RE = re.compile(r"\s+(?:—|--)(?=\s*$)", re.MULTILINE)
# 어절 사이에 공백 없이 붙은 em-dash / 이중하이픈(범위가 아닌 삽입구) → 쉼표.
# en-dash(–)는 '10–20' 같은 숫자 범위 보존을 위해 여기서 제외한다.
_AI_DASH_TIGHT_RE = re.compile(r"(?<=[가-힣A-Za-z])(?:—|--)(?=[가-힣A-Za-z])")


def _strip_ai_dashes(segment):
    """평문 구간에서 AI식 삽입구 줄표를 쉼표로 정리한다(마커 밖 산문 전용).

    - ' — '/' – '/' -- '(공백 둘러싼 줄표) → ', '
    - 문장 끝 ' —'/' --'(단독, 뒤 공백 없음) → 제거
    - '단어—단어'/'단어--단어'(공백 없이 붙은 삽입구 줄표) → ', '
    보존: 수학 '-'(U+002D)·'−'(U+2212), '10–20' 같은 붙은 en-dash 숫자 범위.
    (마커 {{EQ...}} / hp:equation 내부는 호출부에서 이미 분리되어 들어오지 않는다.)
    """
    s = str(segment or "")
    if not s:
        return s
    s = _AI_DASH_INLINE_RE.sub(", ", s)
    s = _AI_DASH_TRAILING_RE.sub("", s)
    s = _AI_DASH_TIGHT_RE.sub(", ", s)
    return s


def _flatten_label_subscripts(text):
    """수식으로 승격되지 '않은' 산문 속 _max/_cm/_pivot 라벨 평탄화.

    수식 승격 경로에서는 호출하면 안 된다 — 평탄화된 'Icm' 은 승격 시
    아래첨자 의도를 잃는다(I_{"cm"} 복원 불가). _promote_plain_physics_segment
    가 승격을 끝낸 뒤 마커 밖 산문에만 적용한다.
    """
    s = str(text or "")
    # 마커 밖 산문에 남은 ▽(U+25BD 흰 삼각형)은 모델이 나블라 대신 잘못 쓴 것 —
    # 올바른 ∇(U+2207)로 글리프 교정한다. '=' 가 없어 수식 승격 안 된 단독
    # 연산자(gradient ▽f, divergence ▽·F)가 흰 삼각형으로 노출되던 문제(실측).
    s = s.replace("▽", "∇")
    s = re.sub(r"\|([A-Za-zαβγδθλμπρστφωΩΔΣ]+)\|_max", r"|\1|max", s)
    s = re.sub(r"\b([A-Za-zαβγδθλμπρστφωΩΔΣ]+)_max\b", r"\1max", s)
    s = re.sub(r"\b([A-Za-zαβγδθλμπρστφωΩΔΣ]+)_cm\b", r"\1cm", s)
    s = re.sub(r"\b([A-Za-zαβγδθλμπρστφωΩΔΣ]+)_pivot\b", r"\1pivot", s)
    return s


def _flatten_labels_outside_markers(text):
    """{{EQ*:...}} 마커 밖 산문에만 _flatten_label_subscripts 를 적용한다."""
    s = str(text or "")
    if "{{EQ" not in s:
        return _flatten_label_subscripts(s)
    spans = pre.find_equation_spans(s)
    if not spans:
        # 파손 마커 추정 — 안전하게 그대로 둔다.
        return s
    out = []
    pos = 0
    for start, end, _kind, _body in spans:
        out.append(_flatten_label_subscripts(s[pos:start]))
        out.append(s[start:end])
        pos = end
    out.append(_flatten_label_subscripts(s[pos:]))
    return "".join(out)


def normalize_plain_physics_notation(text):
    # 하위 호환 별칭 — 승격 파이프라인은 두 단계를 분리해 쓴다(위 docstring).
    return _flatten_label_subscripts(_subscript_digit_notation(text))


def convert_radicals(expr):
    r"""Turn radicals into proper LaTeX ``\sqrt{...}`` so they render as a real
    radical sign instead of literal text like ``sqrt(F/μ)``.

    Handles the spelled-out name (``sqrt(...)``), the unicode symbol
    (``√(...)``, ``√{...}``), a degree root (``sqrt[3]{x}`` -> ``\sqrt[3]{x}``)
    and a bracketless single argument (``√2``, ``√g``). An existing LaTeX
    ``\sqrt`` is left untouched, a radical glued to a preceding atom gets a
    separating space (``a√b`` -> ``a \sqrt{b}``), and an unterminated radical is
    left as a literal symbol rather than emitting a body-less ``\sqrt`` command.
    """
    # Normalise the spelled-out name to the symbol so there is one code path.
    # ``(?<!\\)`` keeps an existing ``\sqrt`` command intact.
    expr = re.sub(r"(?<!\\)\bsqrt\b", "√", expr, flags=re.IGNORECASE)
    if "√" not in expr:
        return expr
    n = len(expr)
    brackets = {"(": ")", "{": "}", "[": "]"}

    def read_bracketed(start):
        """``start`` indexes an opener; return (inner, index_after_close) or None
        when the bracket is unbalanced."""
        opener = expr[start]
        closer = brackets[opener]
        depth = 0
        k = start
        while k < n:
            if expr[k] == opener:
                depth += 1
            elif expr[k] == closer:
                depth -= 1
                if depth == 0:
                    return expr[start + 1:k], k + 1
            k += 1
        return None

    out = []
    i = 0
    while i < n:
        if expr[i] != "√":
            out.append(expr[i])
            i += 1
            continue
        # Keep the radical keyword from fusing with a preceding atom in the
        # converter's tokenizer (``a\sqrt`` would render as ``asqrt``).
        prefix = " " if out and (out[-1].isalnum() or out[-1] in ")]}") else ""
        j = i + 1
        while j < n and expr[j].isspace():
            j += 1
        degree = None
        if j < n and expr[j] == "[":
            deg = read_bracketed(j)
            if deg is not None:
                degree, j = deg
                while j < n and expr[j].isspace():
                    j += 1
        # Bracketed body: √(...), √{...}
        if j < n and expr[j] in "({":
            res = read_bracketed(j)
            if res is not None:
                body = rich_formula_to_latex(res[0])
                root = f"[{degree.strip()}]" if degree is not None else ""
                out.append(f"{prefix}\\sqrt{root}{{{body}}}")
                i = res[1]
                continue
            # Unbalanced — fail safe: keep the literal symbol, never emit a
            # body-less command that would leak into the document.
            out.append("√")
            i += 1
            continue
        # Bracketless single atom: √2, √g, √x^{2}
        atom = re.match(
            r"([A-Za-zαβγδθλμπρστφωΩΔΣ0-9.]+(?:\^\{[^{}]*\}|\^[A-Za-z0-9])?)",
            expr[j:],
        )
        if atom:
            root = f"[{degree.strip()}]" if degree is not None else ""
            out.append(f"{prefix}\\sqrt{root}{{{atom.group(1)}}}")
            i = j + atom.end()
            continue
        # Nothing usable after the symbol — keep it literal (fail safe).
        out.append("√")
        i += 1
    return "".join(out)


def unicode_scripts_to_latex(expr):
    # 그리스 글자 뒤 유니코드 첨자도 잡아야 'ε₀'(ε + ₀)가 그리스 치환 전에
    # 'ε_{0}' 로 묶여 최종 'epsilon_{0}' 가 된다. 빠지면 'epsilon "₀"' 누출.
    # 미적분 연산자 글리프(∇▽∂)도 밑으로 허용해야 라플라시안 ∇²·∂² 가 글리프
    # 치환(∇→\nabla) 전에 ∇^{2} 로 묶인다 — 빠지면 '\nabla ²'(공백 고립) →
    # 'nabla "²"' 누출(인라인 promotion 경로 한정 버그였다).
    expr = re.sub(
        rf"([A-Za-z{_FORMULA_GREEK}∇▽∂])([⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+)",
        lambda m: f"{m.group(1)}^{{{m.group(2).translate(SUPERSCRIPT_TO_LATEX)}}}",
        expr,
    )
    expr = re.sub(
        rf"([A-Za-z{_FORMULA_GREEK}∇▽∂])([₀₁₂₃₄₅₆₇₈₉₊₋]+)",
        lambda m: f"{m.group(1)}_{{{m.group(2).translate(SUBSCRIPT_TO_LATEX)}}}",
        expr,
    )
    return expr


def rich_formula_to_latex(expr):
    expr = str(expr or "").strip()
    expr = re.sub(r"\*\*([^*]+)\*\*", r"\1", expr)
    expr = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"\1", expr)
    expr = expr.replace("−", "-").replace("–", "-").replace("—", "-")
    expr = expr.replace("θ̈", r"\ddot{\theta}").replace("θ̇", r"\dot{\theta}")
    expr = expr.replace("×", r" \times ").replace("·", r" \cdot ")
    expr = expr.replace("∙", r" \cdot ").replace("⋅", r" \cdot ")
    expr = expr.replace("≃", r" \approx ").replace("≈", r" \approx ")
    expr = expr.replace("≅", r" \cong ")
    expr = expr.replace("≤", r" \leq ").replace("≥", r" \geq ")
    expr = expr.replace("½", r"\frac{1}{2}")
    # ∂-경계 첨자(∮_∂S, ∯_∂V 등 맥스웰 적분형)를 글리프 치환 '전에' 한 덩어리로
    # 묶는다. ∂ 가 ' \partial ' 로 풀리면 _∂V 가 '_ \partial V' 로 흩어져 다글자
    # 첨자 braceing 정규식(아래)이 못 잡고, V 가 첨자 밖으로 떨어져 우변과 융합한다
    # (블록 '\oint_{\partial V}' 는 정상이나 인라인 promotion 산출물만 버그였다).
    # '_∂V', '_{∂V}', '_\partial V', '_{\partial V}' 모두 '_{\partial V}' 로.
    # 단일 글자 첨자(_V)는 건드리지 않는다.
    expr = re.sub(r"_\{\s*∂\s*([A-Za-z])\s*\}", r"_{\\partial \1}", expr)
    expr = re.sub(r"_\{\s*\\partial\s+([A-Za-z])\s*\}", r"_{\\partial \1}", expr)
    expr = re.sub(r"_∂([A-Za-z])", r"_{\\partial \1}", expr)
    expr = re.sub(r"_\\partial\s+([A-Za-z])", r"_{\\partial \1}", expr)
    # 유니코드 위/아래첨자(∇²·∂²·ε₀·x²)를 연산자 글리프 치환 '전에' ^{}/_{} 로
    # 묶는다. ∇→\nabla 가 먼저 일어나면 ∇² 가 '\nabla ²'(공백 고립)로 흩어져
    # '²' 가 누출된다. 밑(∇▽∂ 포함)에 첨자가 붙어 있을 때 여기서 미리 묶는다.
    expr = unicode_scripts_to_latex(expr)
    # 벡터 미적분 연산자 유니코드 → 정식 LaTeX 명령. 다중적분(∭∬)·면적분(∯∰)을
    # 단일 ∫·∮ 보다 먼저 치환해야 글리프가 쪼개지지 않는다. ∇·▽ 는 둘 다 nabla.
    # 이 LaTeX 명령은 stage-1 preprocess_latex_body 가 다시 받아도 그대로 통과한다
    # (preprocess 의 유니코드 치환은 raw 글리프 대상이라 idempotent).
    for glyph, command in (
        ("∇", r" \nabla "), ("▽", r" \nabla "),
        ("∂", r" \partial "),
        ("∭", r" \iiint "), ("∬", r" \iint "),
        ("∯", r" \oint "), ("∰", r" \oint "), ("∮", r" \oint "),
        ("∫", r" \int "),
        ("∑", r" \sum "), ("∏", r" \prod "),
        ("≡", r" \equiv "), ("∝", r" \propto "), ("∞", r" \infty "),
        ("∓", r" \mp "), ("∈", r" \in "), ("∉", r" \notin "),
        ("⟨", r" \langle "), ("⟩", r" \rangle "), ("∘", r" \circ "),
    ):
        expr = expr.replace(glyph, command)
    # 중괄호 없는 다글자 아래첨자(ω_max, I_cm, I_pivot)를 LaTeX 정식 표기로 —
    # 이렇게 해야 변환 엔진의 quote_textual_subscripts 경로(I_{"cm"})를 타서
    # 아래첨자 의도가 보존된다. 이미 braced(_{…})면 그대로 둔다.
    expr = re.sub(r"_([A-Za-z]{2,})\b", r"_{\1}", expr)
    expr = convert_radicals(expr)
    for greek, latex in GREEK_TO_LATEX.items():
        expr = expr.replace(greek, f" {latex} ")
    expr = re.sub(r"\s+", " ", expr).strip()
    return expr


# A single "quantity = number unit" statement (e.g. ``v = 5 m/s``, ``T = 1.2 s``,
# ``θ = 30°``) is a plain measurement, not an equation worth promoting to a
# centered equation object. Requiring whitespace before a multi-letter unit keeps
# real formulas like ``2gh`` (number glued to variables) out of this guard.
_UNIT_TOKEN = (
    r"[A-Za-zμΩ°Åℓ%]+"
    r"(?:\s*/\s*[A-Za-zμΩ°Åℓ]+)?"
    r"(?:\^?-?\d+|[²³¹⁰⁴⁵⁶⁷⁸⁹]+)?"
)
_TRIVIAL_MEASUREMENT_RE = re.compile(
    r"^\s*[A-Za-zαβγδθλμπρστφωΩΔΣ]"
    r"(?:_\{[A-Za-z0-9]+\}|_[A-Za-z0-9]|[₀₁₂₃₄₅₆₇₈₉])?"
    r"\s*=\s*"
    r"[-+]?\d+(?:\.\d+)?"
    r"(?:\s*[-–~]\s*[-+]?\d+(?:\.\d+)?)?"
    rf"(?:[°%]|\s+{_UNIT_TOKEN})?"
    r"\s*$"
)


def is_trivial_measurement(expr):
    """True for a bare ``symbol = number [unit]`` reading that should stay as
    inline prose rather than become an equation object."""
    s = re.sub(r"\*\*?([^*]+)\*\*?", r"\1", str(expr or "")).strip()
    if s.count("=") != 1:
        return False
    return bool(_TRIVIAL_MEASUREMENT_RE.match(s))


def is_probable_physics_formula(expr):
    clean = re.sub(r"\*\*?([^*]+)\*\*?", r"\1", str(expr or "")).strip()
    if not clean or "{{EQ" in clean:
        return False
    if re.search(r"[가-힣]", clean):
        return False
    # 영어 산문 가드 — 'where R = 8.314 J/mol K is the gas constant' 같은
    # 영문 법칙 인용 문장이 '=' 를 포함한다는 이유로 통째로 수식 승격되는
    # 것을 막는다(chem-pre looks_like_standalone_equation 과 같은 기준).
    if pre.count_english_prose_stopwords(clean) >= 2:
        return False
    if not re.search(rf"[A-Za-z{_FORMULA_GREEK}]", clean):
        return False
    if not re.search(r"=|≈|≃|≤|≥", clean):
        return False
    # 관계연산자 뒤에 실질 우변(글자/숫자/연산자)이 없는 'A =', 'x ≈' 꼴은
    # 한국어 정의문('A = 면적')에서 INLINE_FORMULA_RE 가 뒤 공백까지 삼킨
    # 토막일 뿐이다 — 승격하면 'A `=`' 처럼 우변 없는 식이 된다. 우변이
    # 비면(공백·구두점만) 산문으로 남긴다.
    rhs = re.split(r"=|≈|≃|≤|≥", clean)[-1]
    if not re.search(rf"[A-Za-z0-9{_FORMULA_GREEK}]", rhs):
        return False
    # 절댓값 막대는 항상 짝수로 나온다 — 홀수 '|' 는 표/구분자 파편이 식에
    # 섞인 신호이므로 산문으로 남긴다(파이프가 수식 글자로 승격되는 오탐 방지).
    if clean.count("|") % 2:
        return False
    if is_trivial_measurement(clean):
        return False
    return True


def _strip_degenerate_tail(core, trailing):
    """토큰 절단으로 연산자가 꼬리에 남은 퇴화 후보를 정리한다.

    'A/√((ω²−ω₀²)² + …' 처럼 공백에서 토큰이 끊기고 괄호 트림까지 거치면
    'A/√' 같은 꼬리 연산자 조각이 남는데, 이대로 승격하면 빈 근호가 그려진
    쓰레기 수식 객체가 된다(DEF-040 리허설 실측). 꼬리 연산자는 산문으로
    돌려보내고 남은 알맹이로만 승격 여부를 판정한다.
    """
    core = str(core or "")
    m = re.search(r"[√/·×+\-−^_]+$", core)
    if m:
        trailing = core[m.start():] + trailing
        core = core[: m.start()].rstrip()
    return core, trailing


def trim_formula_edges(core, trailing):
    """Keep regex-matched inline formulas from swallowing nearby prose."""
    core = str(core or "").strip()
    trailing = str(trailing or "")

    # 괄호 '짝(구조)' 경계 - 개수는 맞아도 구조가 어긋난 '…/g) . (2' 꼴은
    # 수식이 인접 산문(문장 닫는 괄호, 마침표, 다음 항목 번호)을 삼킨
    # 신호다(R0 phys-atwood 실측, DEF-018 D-1). 아래 count 기반 while 은
    # 개수가 같으면 통과시키므로 여기서 구조를 본다: 식 안에서 열린 적 없는
    # ')' 를 만나면 그 직전까지만 수식으로 보고 나머지는 산문으로 돌려보낸다.
    depth = 0
    for i, ch in enumerate(core):
        if ch == "(":
            depth += 1
        elif ch == ")":
            if depth == 0:
                trailing = core[i:] + trailing
                core = core[:i].rstrip()
                # 잘린 끝에 드러난 문장 구두점도 산문으로 돌린다.
                while core and core[-1] in ".,;:":
                    trailing = core[-1] + trailing
                    core = core[:-1].rstrip()
                break
            depth -= 1

    while core and core.count("(") > core.count(")"):
        idx = core.rfind("(")
        if idx < 0:
            break
        trailing = core[idx:] + trailing
        core = core[:idx].rstrip()

    while core and core.count(")") > core.count("(") and core.endswith(")"):
        trailing = core[-1] + trailing
        core = core[:-1].rstrip()

    if core.count("(") != core.count(")"):
        return "", trailing
    return core, trailing


# 평문에 흘러나온 한컴 수식 스크립트 조각 구조(rescue) — 구현은 공통 베이스
# (chem-pre/hwpx-gen.py)로 이동했다. 화학 산문 경로에서도 같은 구조가 필요해
# 공유 모듈에 두고, 여기는 하위 호환용 얇은 별칭만 남긴다.
_UNI_SUP_MAP = pre._UNI_SUP_MAP
_UNI_SUB_MAP = pre._UNI_SUB_MAP
_RESCUE_BRACED = pre._RESCUE_BRACED
_RESCUE_WORD = pre._RESCUE_WORD
_HWP_SCRIPT_CORE_RE = pre._HWP_SCRIPT_CORE_RE
_convert_unicode_scripts_to_hwp = pre._convert_unicode_scripts_to_hwp
rescue_inline_hwp_script = pre.rescue_inline_hwp_script


def _promote_plain_physics_segment(segment):
    """마커가 없는 평문 구간 하나에 물리 수식 승격 처리를 적용한다.

    normalize_physics_equation_markers 가 마커 구간을 보호한 뒤 그 사이의
    평문 구간만 이 함수로 넘긴다(마커 내부 재가공 방지).
    """
    s = str(segment or "")
    # AI식 삽입구 줄표(' — '/' – '/' -- ')를 쉼표로 정리한다. 이 구간은 호출부에서
    # 이미 마커 밖 평문만 떼어 넘기므로 수식 객체/마이너스에는 닿지 않는다.
    s = _strip_ai_dashes(s)
    # 모델이 흘린 마크다운 강조(*a*·**F_net**)는 수식 후보를 오염시켜 식
    # 전체의 승격을 막는다('*a* = *F_net*' 미변환 노출 — R4 phys-atwood
    # 실측, DEF-040). 마커 밖 평문 구간 전용이며, 곱셈 별표(a*b*c)는 여닫는
    # 별표가 영숫자에 붙어 있어 경계 가드에 걸리지 않아 보존된다.
    s = re.sub(r"(?<![A-Za-z0-9])\*\*([^\s*][^*]{0,80}?)\*\*(?![A-Za-z0-9])", r"\1", s)
    s = re.sub(r"(?<![A-Za-z0-9])\*([^\s*][^*]{0,80}?)\*(?![A-Za-z0-9])", r"\1", s)
    # 파손/비정형 마커 잔재("{{EQ:" 미폐쇄 등)가 섞인 구간은 건드리지 않는다(방어).
    if "{{EQ" in s:
        return s
    # 라벨 평탄화(_max→max)는 승격 '뒤' 마커 밖 산문에만 — 먼저 평탄화하면
    # ω_max 가 'ωmax' 로 붙은 채 수식이 되어 아래첨자 의도를 잃는다.
    s = _subscript_digit_notation(s)
    # 모델이 평문에 흘린 한컴 스크립트 조각({1} over {2} …)을 먼저 구조한다.
    # 구조됐으면 이 구간의 마커 처리는 끝(마커 내부 재가공 방지).
    s = rescue_inline_hwp_script(s)
    if "{{EQ" in s:
        return _flatten_labels_outside_markers(s)

    # URL 안의 "watch?v=Q10..." 같은 쿼리스트링이 수식으로 오인돼 잘리는 사고 방지.
    url_spans = [m.span() for m in re.finditer(r"https?://\S+|www\.\S+", s)]

    def repl(match):
        if any(a <= match.start() < b for a, b in url_spans):
            return match.group(0)
        raw = match.group(1)
        leading = re.match(r"^\s*", raw).group(0)
        trailing = re.search(r"\s*$", raw).group(0)
        core = raw.strip()
        while core and core[0] in ".,;:":
            leading += core[0]
            core = core[1:].lstrip()
        # 여는 괄호 비대칭 보정 — '(m₁+…' 처럼 산문 괄호가 토큰 앞에 붙으면
        # 괄호 불균형으로 식 전체가 승격 탈락한다(닫는 괄호는 아래 trim 이
        # 떼지만 여는 쪽은 없었다 — m₁ 평문/m₂ 객체 혼재의 원인, DEF-040).
        while core.startswith("(") and core.count("(") > core.count(")"):
            leading += core[0]
            core = core[1:].lstrip()
        while core and core[-1] in ".,;:":
            trailing = core[-1] + trailing
            core = core[:-1].rstrip()
        core, trailing = trim_formula_edges(core, trailing)
        if not _is_real_math(core):
            return raw
        # 키보드로만 되는 식(a + b = 0)은 수식 객체로 안 만들고 텍스트로 둔다.
        if not _needs_equation(core):
            return raw
        # 관계식 우변이 비면(A = , 한국어 정의문 'A = 면적' 토막)은 산문으로 남긴다.
        rhs = re.split(r"=|≈|≃|≅|≡|≤|≥|≠|∝", core)[-1]
        if not re.search(rf"[A-Za-z0-9{_FORMULA_GREEK}]", rhs):
            return raw
        latex = rich_formula_to_latex(core)
        if not latex:
            return raw
        return f"{leading}{{{{EQ-LATEX:{latex}}}}}{trailing}"

    promoted = INLINE_FORMULA_RE.sub(repl, s)
    # = 가 없는 기호 토큰(∇·F, δ³(r), q/ε₀, x^2 …)도 통째로 수식화한다. 위 관계식
    # 승격이 만든 마커 안은 건드리지 않는다(이중 처리 방지).
    promoted = _promote_symbol_tokens_outside_markers(promoted)
    return _flatten_labels_outside_markers(promoted)


# URL/DOI/도메인/이메일/파일경로 — '/' 트리거가 분수로 오인하지 않게 토큰 단위로 제외.
_URLISH_RE = re.compile(
    r"https?://|www\.|@\w|^10\.\d|\.(?:com|org|net|edu|gov|io|dev|kr|co|html|pdf|jpg|png)\b",
    re.IGNORECASE,
)


def _promote_symbol_tokens(segment):
    """공백 없는 한 덩어리 토큰에 강한 수식 기호가 있으면 통째로 수식화한다."""
    def repl(m):
        tok = m.group(0)
        if _URLISH_RE.search(tok):
            return tok
        leading = ""
        trailing = ""
        core = tok
        while core and core[0] in ".,;:":
            leading += core[0]
            core = core[1:]
        # 여는 괄호 비대칭 보정 — INLINE 경로와 동일(DEF-040). '(m₁,' 의
        # 여는 괄호를 산문으로 돌려보내야 m₁ 이 m₂ 와 같이 승격된다.
        while core.startswith("(") and core.count("(") > core.count(")"):
            leading += core[0]
            core = core[1:]
        while core and core[-1] in ".,;:":
            trailing = core[-1] + trailing
            core = core[:-1]
        core, trail2 = trim_formula_edges(core, "")
        trailing = trail2 + trailing
        core, trailing = _strip_degenerate_tail(core, trailing)
        if not core or not _needs_equation(core):
            return tok
        if not _is_real_math(core):
            return tok
        latex = rich_formula_to_latex(core)
        if not latex:
            return tok
        return f"{leading}{{{{EQ-LATEX:{latex}}}}}{trailing}"

    return _SYMBOL_TOKEN_RE.sub(repl, segment)


def _promote_symbol_tokens_outside_markers(s):
    """{{EQ*:...}} 마커 밖 평문에만 기호 토큰 승격을 적용한다."""
    s = str(s or "")
    if "{{EQ" not in s:
        return _promote_symbol_tokens(s)
    spans = pre.find_equation_spans(s)
    if not spans:
        return s  # 파손 마커 추정 — 안전하게 그대로 둔다.
    out = []
    pos = 0
    for start, end, _kind, _body in spans:
        out.append(_promote_symbol_tokens(s[pos:start]))
        out.append(s[start:end])
        pos = end
    out.append(_promote_symbol_tokens(s[pos:]))
    return "".join(out)


def normalize_physics_equation_markers(text):
    """Promote inline physics formulas to native Hancom equation placeholders.

    The shared chemistry HWPX generator already converts explicit
    {{EQ:...}} markers and standalone formula lines. Physics result prose often
    contains inline equations such as `I_{pivot} = mgdT^{2}/(4π^{2})`, so we
    wrap only the formula span and leave the surrounding Korean prose intact.

    정상 마커가 이미 있는 단락도 통째로 건너뛰지 않는다 — 마커 구간은
    pre.find_equation_spans 로 보호하고, 그 사이 평문 구간에 남은 raw 스크립트
    조각/인라인 수식만 따로 승격한다(마커와 조각 혼재 단락 잔존 방지).
    """
    s = str(text or "")
    if "{{EQ" not in s:
        return _promote_plain_physics_segment(s)

    spans = pre.find_equation_spans(s)
    if not spans:
        # "{{EQ"는 있으나 정상 마커 형태가 아님(파손 마커 등) — 안전하게 그대로 둔다.
        return s

    out = []
    pos = 0
    for start, end, _kind, _body in spans:
        if start > pos:
            out.append(_promote_plain_physics_segment(s[pos:start]))
        out.append(s[start:end])
        pos = end
    if pos < len(s):
        out.append(_promote_plain_physics_segment(s[pos:]))
    return "".join(out)


def add_para_to(doc, target, text, *, base_size=pre.SIZE_BODY, bold=False,
                align="LEFT", indent_left=0, keep_with_next=False,
                color=None, space_after=None, space_before=0):
    text = normalize_physics_equation_markers(str(text or ""))
    text = pre.normalize_equation_markers(text)
    if pre._is_equation_only(text):
        align = "CENTER"
        indent_left = 0
    effective_space_after = pre.SPACE_BODY if space_after is None else space_after
    para_pr = pre.make_para_pr(
        doc,
        align=align,
        indent_left=indent_left,
        line_spacing=pre.LINE_SPACING_PERCENT,
        keep_with_next=keep_with_next,
        space_after=effective_space_after,
        space_before=space_before,
    )
    p = add_paragraph_to(target, "", para_pr_id_ref=para_pr)
    tokens = pre.tokenize(text)
    if not tokens:
        cp = pre.make_char_pr(doc, size=base_size, bold=bold, color=color)
        p.add_run("", char_pr_id_ref=cp)
        return p
    for plain, b, i, sub, sup, highlight in tokens:
        cp = pre.make_char_pr(
            doc,
            size=base_size,
            bold=bold or b,
            italic=i,
            sub=sub,
            sup=sup,
            color=color,
            highlight=highlight and getattr(doc, "_v5_allow_highlights", True),
        )
        p.add_run(plain, char_pr_id_ref=cp)
    return p


def add_heading_to(doc, target, text, *, size=pre.SIZE_TITLE, align="LEFT",
                   indent_left=0, space_before=0, space_after=0):
    return add_para_to(
        doc,
        target,
        text,
        base_size=size,
        bold=True,
        align=align,
        indent_left=indent_left,
        keep_with_next=True,
        space_before=space_before,
        space_after=space_after,
    )


def apply_phys_page_layout(doc):
    changed = False
    for sec in getattr(doc.oxml, "sections", []):
        for page_pr in sec.element.iter(f"{pre.NS_HP}pagePr"):
            page_pr.set("width", str(PAGE_WIDTH))
            page_pr.set("height", str(PAGE_HEIGHT))
            margin = page_pr.find(f"{pre.NS_HP}margin")
            if margin is not None:
                margin.set("left", str(PAGE_MARGIN_LR))
                margin.set("right", str(PAGE_MARGIN_LR))
                margin.set("top", str(PAGE_MARGIN_TOP))
                margin.set("bottom", str(PAGE_MARGIN_BOTTOM))
                margin.set("header", str(PAGE_HEADER))
                margin.set("footer", str(PAGE_FOOTER))
                margin.set("gutter", "0")
                changed = True
    if changed:
        for sec in getattr(doc.oxml, "sections", []):
            if hasattr(sec, "mark_dirty"):
                sec.mark_dirty()


def add_phys_page_number_to_footer(doc):
    try:
        doc.set_footer_text("고 2,3 일반물리학실험  - ")
        sec = doc.oxml.sections[0]
    except Exception:
        return
    sec_elem = getattr(sec, "element", None)
    if sec_elem is None:
        return
    for footer in sec_elem.iter(f"{pre.NS_HP}footer"):
        for run in footer.iter(f"{pre.NS_HP}run"):
            t = run.find(f"{pre.NS_HP}t")
            if t is None or t.text is None:
                continue
            if "일반물리학실험" not in t.text:
                continue
            t.text = "고 2,3 일반물리학실험  - "
            etree.SubElement(
                run,
                f"{pre.NS_HP}pageNum",
                attrib={"pageStartsOn": "BOTH", "pageNumberFormat": "DIGIT"},
            )
            tail = etree.SubElement(run, f"{pre.NS_HP}t")
            tail.text = " -"
            if hasattr(sec, "mark_dirty"):
                sec.mark_dirty()
            return


_PIC_SEQ = 0


def append_picture_to_paragraph(doc, para, data, *, fmt="png", caption="",
                                max_width=MAX_IMAGE_WIDTH,
                                max_height=MAX_IMAGE_HEIGHT):
    if not data:
        return False
    # 그림 식별자를 id(data)로 만들면 동일 프로세스에서 버퍼가 GC·재사용될 때
    # 값이 충돌해 다중 이미지 HWPX가 깨질 수 있다. 단조 증가 카운터로 고유 보장. (코드 리뷰 ⑨)
    global _PIC_SEQ
    _PIC_SEQ += 1
    _pic_id = 1900000000 + _PIC_SEQ
    width_px, height_px = image_size(data)
    width, height, org_width, org_height = fit_size(
        width_px, height_px, max_width, max_height,
    )
    item_id = doc.add_image(data, fmt)
    pic = para.add_shape(
        "pic",
        attributes={
            "id": str(_pic_id),
            "zOrder": "1",
            "numberingType": "PICTURE",
            "textWrap": "TOP_AND_BOTTOM",
            "textFlow": "BOTH_SIDES",
            "lock": "0",
            "dropcapstyle": "None",
            "href": "",
            "groupLevel": "0",
            "instid": str(_pic_id + 100000000),
            "reverse": "0",
        },
    ).element

    etree.SubElement(pic, f"{pre.NS_HP}offset", x="0", y="0")
    etree.SubElement(pic, f"{pre.NS_HP}orgSz", width=str(org_width), height=str(org_height))
    etree.SubElement(pic, f"{pre.NS_HP}curSz", width=str(width), height=str(height))
    etree.SubElement(pic, f"{pre.NS_HP}flip", horizontal="0", vertical="0")
    etree.SubElement(
        pic,
        f"{pre.NS_HP}rotationInfo",
        angle="0",
        centerX=str(width // 2),
        centerY=str(height // 2),
        rotateimage="1",
    )
    rendering = etree.SubElement(pic, f"{pre.NS_HP}renderingInfo")
    etree.SubElement(rendering, f"{pre.NS_HC}transMatrix", e1="1", e2="0", e3="0", e4="0", e5="1", e6="0")
    etree.SubElement(rendering, f"{pre.NS_HC}scaMatrix", e1="1", e2="0", e3="0", e4="0", e5="1", e6="0")
    etree.SubElement(rendering, f"{pre.NS_HC}rotMatrix", e1="1", e2="0", e3="0", e4="0", e5="1", e6="0")
    etree.SubElement(
        pic,
        f"{pre.NS_HC}img",
        binaryItemIDRef=item_id,
        bright="0",
        contrast="0",
        effect="REAL_PIC",
        alpha="0",
    )
    rect = etree.SubElement(pic, f"{pre.NS_HP}imgRect")
    for name, x, y in (
        ("pt0", 0, 0),
        ("pt1", org_width, 0),
        ("pt2", org_width, org_height),
        ("pt3", 0, org_height),
    ):
        etree.SubElement(rect, f"{pre.NS_HC}{name}", x=str(x), y=str(y))
    etree.SubElement(pic, f"{pre.NS_HP}imgClip", left="0", right=str(org_width), top="0", bottom=str(org_height))
    etree.SubElement(pic, f"{pre.NS_HP}inMargin", left="0", right="0", top="0", bottom="0")
    etree.SubElement(pic, f"{pre.NS_HP}imgDim", dimwidth=str(org_width), dimheight=str(org_height))
    etree.SubElement(pic, f"{pre.NS_HP}effects")
    etree.SubElement(
        pic,
        f"{pre.NS_HP}sz",
        width=str(width),
        widthRelTo="ABSOLUTE",
        height=str(height),
        heightRelTo="ABSOLUTE",
        protect="0",
    )
    etree.SubElement(
        pic,
        f"{pre.NS_HP}pos",
        treatAsChar="1",
        affectLSpacing="0",
        flowWithText="1",
        allowOverlap="0",
        holdAnchorAndSO="0",
        vertRelTo="PARA",
        horzRelTo="COLUMN",
        vertAlign="TOP",
        horzAlign="CENTER",
        vertOffset="0",
        horzOffset="0",
    )
    etree.SubElement(pic, f"{pre.NS_HP}outMargin", left="0", right="0", top="0", bottom="0")
    etree.SubElement(pic, f"{pre.NS_HP}shapeComment").text = "image"
    return True


def add_picture(doc, data, *, fmt="png", caption="", max_width=MAX_IMAGE_WIDTH,
                max_height=MAX_IMAGE_HEIGHT, target=None):
    target = target or doc
    para_pr = pre.make_para_pr(
        doc,
        align="CENTER",
        line_spacing=pre.LINE_SPACING_PERCENT,
        space_after=180,
    )
    para = add_paragraph_to(target, "", para_pr_id_ref=para_pr)
    if not append_picture_to_paragraph(
        doc,
        para,
        data,
        fmt=fmt,
        caption=caption,
        max_width=max_width,
        max_height=max_height,
    ):
        return False

    if caption:
        add_para_to(
            doc,
            target,
            caption,
            base_size=pre.SIZE_CAPTION,
            align="CENTER",
            space_after=pre.SPACE_BODY,
        )
    return True


def add_table(doc, headers, rows, caption=None, target=None):
    target = target or doc
    headers = [normalize_physics_equation_markers(str(h or "")) for h in headers]
    rows = [
        [normalize_physics_equation_markers(str(c or "")) for c in row]
        for row in rows or []
    ]
    if not headers:
        return

    solid_id = pre.make_solid_border_fill(doc)
    shaded_id = pre.make_shaded_border_fill(doc)
    table = target.add_table(
        rows=len(rows) + 1,
        cols=len(headers),
        width=PHYS_TABLE_WIDTH,
        border_fill_id_ref=solid_id,
    )
    col_count = max(len(headers), max([len(r) for r in rows] + [len(headers)]), 1)
    col_width = max(int(PHYS_TABLE_WIDTH / col_count), 1320)

    for c in range(len(headers)):
        for r in range(len(rows) + 1):
            try:
                table.cell(r, c).set_size(width=col_width, height=2160)
            except Exception:
                pass

    for c, text in enumerate(headers):
        cell = table.cell(0, c)
        cell.element.set("borderFillIDRef", str(shaded_id))
        pre._replace_cell_with_styled(
            doc,
            cell,
            text,
            size=900,
            bold=True,
            align="CENTER",
            line_spacing=pre.TABLE_LINE_SPACING_PERCENT,
        )

    for r_idx, row in enumerate(rows, 1):
        for c_idx in range(len(headers)):
            cell = table.cell(r_idx, c_idx)
            cell.element.set("borderFillIDRef", str(solid_id))
            pre._replace_cell_with_styled(
                doc,
                cell,
                row[c_idx] if c_idx < len(row) else "",
                size=850,
                align="CENTER",
                line_spacing=pre.TABLE_LINE_SPACING_PERCENT,
            )

    if caption:
        add_para_to(
            doc,
            target,
            caption,
            base_size=pre.SIZE_CAPTION,
            align="CENTER",
            space_after=pre.SPACE_BODY,
        )


def build_header(doc, content):
    title = content.get("title") or content.get("title_en") or content.get("title_kr") or "물리 결과보고서"
    pre.add_para(
        doc,
        f"실험 주제 : {title}",
        base_size=pre.SIZE_TITLE,
        bold=True,
        space_after=pre.SPACE_HEADING_LV1,
    )


def add_photo_blocks(doc, photo_indices, photos, fig_counter, caption_prefix, target=None, photo_captions=None):
    target = target or doc
    caps = photo_captions if isinstance(photo_captions, list) else []
    selected = []
    for pos, idx in enumerate(as_list(photo_indices)):
        try:
            photo = photos[int(idx)]
        except Exception:
            continue
        blob = decode_base64(photo.get("data_base64"))
        if blob:
            per = caps[pos].strip() if pos < len(caps) and isinstance(caps[pos], str) else ""
            selected.append((photo, blob, per))
    multiple = len(selected) > 1
    gpos = -1
    for start in range(0, len(selected), 3):
        group = selected[start:start + 3]
        if not group:
            continue
        solid_id = pre.make_solid_border_fill(doc)
        table = target.add_table(
            rows=2,
            cols=len(group),
            width=PHYS_TABLE_WIDTH,
            border_fill_id_ref=solid_id,
        )
        col_width = max(int(PHYS_TABLE_WIDTH / len(group)), 3000)
        image_max_width = max(col_width - 540, 3000)
        image_max_height = 7500 if len(group) >= 3 else 9900
        captions = []
        for col, (photo, blob, per) in enumerate(group):
            gpos += 1
            fmt = image_format(photo.get("name"), photo.get("mimetype"), blob)
            fig_counter["value"] += 1
            # 사진별 캡션 우선. 없으면 여러 장일 땐 라벨을 첫 사진에만 달아 중복 방지.
            if per:
                desc = per
            elif multiple:
                desc = (caption_prefix or "실험 사진") if gpos == 0 else ""
            else:
                desc = caption_prefix or "실험 사진"
            d = (desc or "").strip()
            if re.match(r"^\s*(\[\s*)?(그림|그래프)\b", d):
                caption = d
            else:
                caption = f"[그림 {fig_counter['value']}] {d}".rstrip()
            captions.append(caption)

            img_cell = table.cell(0, col)
            cap_cell = table.cell(1, col)
            for cell in (img_cell, cap_cell):
                cell.element.set("borderFillIDRef", str(solid_id))
                try:
                    cell.set_size(width=col_width)
                except Exception:
                    pass
            para_pr = pre.make_para_pr(
                doc,
                align="CENTER",
                line_spacing=pre.TABLE_LINE_SPACING_PERCENT,
                space_after=0,
            )
            para = img_cell.add_paragraph("", para_pr_id_ref=para_pr)
            append_picture_to_paragraph(
                doc,
                para,
                blob,
                fmt=fmt,
                caption=caption,
                max_width=image_max_width,
                max_height=image_max_height,
            )
        for col, caption in enumerate(captions):
            pre._replace_cell_with_styled(
                doc,
                table.cell(1, col),
                caption,
                size=pre.SIZE_CAPTION,
                align="CENTER",
                line_spacing=pre.TABLE_LINE_SPACING_PERCENT,
            )


def build_chart(doc, chart, fig_counter, target=None):
    target = target or doc
    if not chart:
        return
    blob = decode_base64(chart.get("png_base64"))
    title = clean_label(chart.get("title") or "그래프")
    caption_text = clean_label(chart.get("caption") or "")
    if not blob:
        add_para_to(doc, target, f"[그래프] {title} - 렌더 실패", base_size=pre.SIZE_CAPTION)
        return

    fig_counter["value"] += 1
    caption = f"[그림 {fig_counter['value']}] {title}"
    if caption_text:
        caption += f" - {caption_text}"
    add_picture(
        doc,
        blob,
        fmt="png",
        caption=caption,
        max_width=MAX_CHART_WIDTH,
        max_height=MAX_CHART_HEIGHT,
        target=target,
    )


def build_results(doc, content, target=None, include_heading=True):
    target = target or doc
    photos = as_list(content.get("__photos"))
    fig_counter = {"value": 0}
    table_counter = {"value": 0}

    if include_heading:
        add_heading_to(
            doc,
            target,
            "1. 실험 결과",
            size=pre.SIZE_TITLE,
            space_before=pre.SPACE_HEADING_LV1,
            space_after=pre.SPACE_HEADING_LV2,
        )

    setup = content.get("experiment_setup") or {}
    add_heading_to(doc, target, "1.1 실험 장치 및 세팅", size=pre.SIZE_HEADING, space_after=pre.SPACE_BODY)
    if setup.get("description"):
        add_para_to(doc, target, setup.get("description"), indent_left=pre.INDENT_5MM)
    add_photo_blocks(doc, setup.get("photo_indices"), photos, fig_counter, "실험 장치", target=target, photo_captions=setup.get("photo_captions"))

    for idx, exp in enumerate(as_list(content.get("experiments")), 1):
        subnum = f"1.{idx + 1}"
        title = exp.get("name") or f"실험 {idx}"
        add_heading_to(
            doc,
            target,
            f"{subnum} {title}",
            size=pre.SIZE_HEADING,
            space_before=pre.SPACE_HEADING_LV2,
            space_after=pre.SPACE_BODY,
        )
        if exp.get("method_summary"):
            add_para_to(doc, target, exp.get("method_summary"), indent_left=pre.INDENT_5MM)

        table = exp.get("data_table") or {}
        if table.get("headers") and isinstance(table.get("rows"), list):
            table_counter["value"] += 1
            add_table(
                doc,
                table.get("headers"),
                table.get("rows"),
                caption=f"[표 {table_counter['value']}] 측정 데이터",
                target=target,
            )

        build_chart(doc, exp.get("chart"), fig_counter, target=target)

        if exp.get("analysis"):
            add_para_to(doc, target, exp.get("analysis"), indent_left=pre.INDENT_5MM)

        add_photo_blocks(doc, exp.get("photo_indices"), photos, fig_counter, title, target=target, photo_captions=exp.get("photo_captions"))


def add_conclusion_block(doc, target, label, value):
    if not value:
        return
    add_para_to(doc, target, label, base_size=pre.SIZE_HEADING, bold=True, space_after=240)
    if isinstance(value, list):
        for item in value:
            add_para_to(doc, target, str(item), space_after=360)
    else:
        add_para_to(doc, target, str(value), space_after=360)


def build_conclusion(doc, content, target=None, include_heading=True):
    target = target or doc
    if include_heading:
        add_heading_to(
            doc,
            target,
            "2. 결론",
            size=pre.SIZE_TITLE,
            space_before=pre.SPACE_HEADING_LV1,
            space_after=pre.SPACE_HEADING_LV2,
        )
    conclusion = content.get("conclusion") or {}
    if conclusion.get("objective_recap"):
        add_para_to(doc, target, conclusion.get("objective_recap"), space_after=pre.SPACE_BODY)

    add_conclusion_block(doc, target, "▶ 결과 요약", conclusion.get("result_summary"))
    add_conclusion_block(doc, target, "▶ 오차 분석", conclusion.get("error_analysis"))
    add_conclusion_block(doc, target, "▶ 문제 인식 및 해결", conclusion.get("problem_solving"))
    add_conclusion_block(
        doc,
        target,
        "▶ 물리적 고찰",
        conclusion.get("physical_meaning") or conclusion.get("theory_connection"),
    )


def build_additional_investigations(doc, content, target=None):
    """선택적 '추가 실험 및 의문점 해결' 섹션 (additional_investigations[])."""
    target = target or doc
    items = [
        it
        for it in as_list(content.get("additional_investigations"))
        if isinstance(it, dict) and (it.get("title") or it.get("body"))
    ]
    if not items:
        return
    add_para_to(doc, target, "▶ 추가 실험 및 의문점 해결", base_size=pre.SIZE_HEADING, bold=True, space_after=240)
    markers = ["가", "나", "다", "라", "마"]
    for i, it in enumerate(items):
        if it.get("title"):
            label = markers[i] if i < len(markers) else str(i + 1)
            add_para_to(doc, target, f"{label}. {it.get('title')}", bold=True, space_after=120)
        if it.get("body"):
            add_para_to(doc, target, str(it.get("body")), space_after=360, indent_left=pre.INDENT_5MM)


def collect_preview_text(content):
    lines = [f"실험 주제 : {content.get('title') or '물리 결과보고서'}", "", "1. 실험 결과"]
    setup = content.get("experiment_setup") or {}
    if setup.get("description"):
        lines.append(setup.get("description"))
    for idx, exp in enumerate(as_list(content.get("experiments")), 1):
        lines.append(f"1.{idx + 1} {exp.get('name') or f'실험 {idx}'}")
        if exp.get("method_summary"):
            lines.append(str(exp.get("method_summary")))
        table = exp.get("data_table") or {}
        if table.get("headers"):
            lines.append("[표] " + " / ".join(str(x) for x in table.get("headers", [])))
        if exp.get("analysis"):
            lines.append(str(exp.get("analysis")))
    lines.extend(["", "2. 결론"])
    conclusion = content.get("conclusion") or {}
    for key in ("objective_recap", "result_summary", "error_analysis", "problem_solving", "physical_meaning", "theory_connection"):
        value = conclusion.get(key)
        if isinstance(value, list):
            lines.extend(str(x) for x in value if x)
        elif value:
            lines.append(str(value))
    return "\r\n".join(lines).strip()[:8000] + "\r\n"


def update_preview_text(hwpx_path, text):
    src = Path(hwpx_path)
    with tempfile.NamedTemporaryFile(suffix=".hwpx", dir=src.parent, delete=False) as tf:
        tmp = Path(tf.name)
    try:
        with zipfile.ZipFile(src, "r") as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
            replaced = False
            for item in zin.infolist():
                if item.filename == "Preview/PrvText.txt":
                    zout.writestr(item, text.encode("utf-8"))
                    replaced = True
                else:
                    zout.writestr(item, zin.read(item.filename))
            if not replaced:
                zout.writestr("Preview/PrvText.txt", text.encode("utf-8"))
        shutil.move(str(tmp), str(src))
    except Exception:
        if tmp.exists():
            tmp.unlink()
        raise


def generate_hwpx(content):
    doc = load_template_doc()
    if doc is not None:
        doc._v5_allow_highlights = bool(content.get("__allowHighlights", True))
    using_template = doc is not None
    if using_template:
        result_cell, conclusion_cell = find_template_body_cells(doc)
        fill_template_title(doc, content)
        make_template_title_header_first_page_only(doc)
        # The school form template ships with 굴림 as font id 0; generated body
        # content (build_results/build_conclusion) references font id 0 via
        # _get_or_create_charpr. Rewrite only id 0 to the user's chosen font so
        # the report body honors the selection while the form's title/label
        # fonts are preserved.
        pre.apply_body_font(
            doc,
            pre.resolve_font_face(content),
        )
        if result_cell is not None and conclusion_cell is not None:
            clear_cell(result_cell)
            clear_cell(conclusion_cell)
            build_results(doc, content, target=result_cell, include_heading=False)
            build_additional_investigations(doc, content, target=result_cell)
            build_conclusion(doc, content, target=conclusion_cell, include_heading=False)
            return doc
        clear_template_body(doc)
    else:
        doc = HwpxDocument.new()
        doc._v5_allow_highlights = bool(content.get("__allowHighlights", True))
        apply_phys_page_layout(doc)
        pre.apply_default_font(
            doc,
            pre.resolve_font_face(content),
        )
        build_header(doc, content)
    build_results(doc, content)
    build_additional_investigations(doc, content)
    build_conclusion(doc, content)
    if not using_template:
        add_phys_page_number_to_footer(doc)
    return doc


def main():
    if len(sys.argv) >= 2 and sys.argv[1] != "-":
        content = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    else:
        content = json.loads(sys.stdin.read())

    content = pre._deep_clean_xml(content)  # XML 비허용 제어문자 제거 (코드 리뷰 ⑧)
    doc = generate_hwpx(content)

    if len(sys.argv) >= 3:
        target = Path(sys.argv[2])
        doc.save_to_path(str(target))
        pre._postprocess_equations(target)
        pre.ensure_embedded_bindata_items(target)
        update_preview_text(target, collect_preview_text(content))
    else:
        import os
        with tempfile.NamedTemporaryFile(suffix=".hwpx", delete=False) as tf:
            tmp_path = Path(tf.name)
        try:
            doc.save_to_path(str(tmp_path))
            pre._postprocess_equations(tmp_path)
            pre.ensure_embedded_bindata_items(tmp_path)
            update_preview_text(tmp_path, collect_preview_text(content))
            sys.stdout.buffer.write(tmp_path.read_bytes())
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    main()
