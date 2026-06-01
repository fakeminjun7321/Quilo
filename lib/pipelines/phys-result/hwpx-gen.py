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
    """Render the template title box only once by anchoring it in body text.

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
    """Keep the template title box on page 1 without repeating it as a header."""
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
    "θ": r"\theta",
    "λ": r"\lambda",
    "μ": r"\mu",
    "π": r"\pi",
    "ρ": r"\rho",
    "σ": r"\sigma",
    "τ": r"\tau",
    "φ": r"\phi",
    "ω": r"\omega",
    "Ω": r"\Omega",
    "Δ": r"\Delta",
    "Σ": r"\Sigma",
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
FORMULA_CHAR_CLASS = (
    r"A-Za-z0-9"
    r"αβγδθλμπρστφωΩΔΣ"
    r"_\{\}\^\*\s\+\-=−–—≈≃≤≥<>/\\\(\)\[\]\.,"
    r"·×√½°%′'⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻₀₁₂₃₄₅₆₇₈₉₊₋\u0307\u0308"
)
FORMULA_START_CLASS = r"A-Za-z0-9αβγδθλμπρστφωΩΔΣ\*\(\{"
INLINE_FORMULA_RE = re.compile(
    rf"(?<![A-Za-z0-9_])([{FORMULA_START_CLASS}][{FORMULA_CHAR_CLASS}]{{0,120}}?"
    rf"(?:=|≈|≃|≤|≥)"
    rf"[{FORMULA_CHAR_CLASS}]{{1,160}})"
)


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


def normalize_plain_physics_notation(text):
    s = str(text or "")
    s = re.sub(
        r"([A-Za-zαβγδθλμπρστφωΩΔΣ])_([0-9])",
        lambda m: f"{m.group(1)}{m.group(2).translate(PLAIN_SUBSCRIPTS)}",
        s,
    )
    s = re.sub(r"\|([A-Za-zαβγδθλμπρστφωΩΔΣ]+)\|_max", r"|\1|max", s)
    s = re.sub(r"\b([A-Za-zαβγδθλμπρστφωΩΔΣ]+)_max\b", r"\1max", s)
    s = re.sub(r"\b([A-Za-zαβγδθλμπρστφωΩΔΣ]+)_cm\b", r"\1cm", s)
    s = re.sub(r"\b([A-Za-zαβγδθλμπρστφωΩΔΣ]+)_pivot\b", r"\1pivot", s)
    return s


def convert_sqrt_parentheses(expr):
    out = []
    i = 0
    while i < len(expr):
        if expr[i] != "√":
            out.append(expr[i])
            i += 1
            continue
        j = i + 1
        while j < len(expr) and expr[j].isspace():
            j += 1
        if j >= len(expr) or expr[j] != "(":
            out.append(r"\sqrt")
            i += 1
            continue
        depth = 0
        k = j
        while k < len(expr):
            if expr[k] == "(":
                depth += 1
            elif expr[k] == ")":
                depth -= 1
                if depth == 0:
                    inner = expr[j + 1:k]
                    out.append(r"\sqrt{" + rich_formula_to_latex(inner) + "}")
                    i = k + 1
                    break
            k += 1
        else:
            out.append(r"\sqrt")
            i += 1
    return "".join(out)


def unicode_scripts_to_latex(expr):
    expr = re.sub(
        r"([A-Za-zαβγδθλμπρστφωΩΔΣ])([⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+)",
        lambda m: f"{m.group(1)}^{{{m.group(2).translate(SUPERSCRIPT_TO_LATEX)}}}",
        expr,
    )
    expr = re.sub(
        r"([A-Za-zαβγδθλμπρστφωΩΔΣ])([₀₁₂₃₄₅₆₇₈₉₊₋]+)",
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
    expr = expr.replace("≃", r" \approx ").replace("≈", r" \approx ")
    expr = expr.replace("≤", r" \leq ").replace("≥", r" \geq ")
    expr = expr.replace("½", r"\frac{1}{2}")
    expr = unicode_scripts_to_latex(expr)
    expr = convert_sqrt_parentheses(expr) if "√" in expr else expr
    for greek, latex in GREEK_TO_LATEX.items():
        expr = expr.replace(greek, f" {latex} ")
    expr = re.sub(r"\s+", " ", expr).strip()
    return expr


def is_probable_physics_formula(expr):
    clean = re.sub(r"\*\*?([^*]+)\*\*?", r"\1", str(expr or "")).strip()
    if not clean or "{{EQ" in clean:
        return False
    if re.search(r"[가-힣]", clean):
        return False
    if not re.search(r"[A-Za-zαβγδθλμπρστφωΩΔΣ]", clean):
        return False
    if not re.search(r"=|≈|≃|≤|≥", clean):
        return False
    return True


def trim_formula_edges(core, trailing):
    """Keep regex-matched inline formulas from swallowing nearby prose."""
    core = str(core or "").strip()
    trailing = str(trailing or "")

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


def normalize_physics_equation_markers(text):
    """Promote inline physics formulas to native Hancom equation placeholders.

    The shared chemistry HWPX generator already converts explicit
    {{EQ:...}} markers and standalone formula lines. Physics result prose often
    contains inline equations such as `I_{pivot} = mgdT^{2}/(4π^{2})`, so we
    wrap only the formula span and leave the surrounding Korean prose intact.
    """
    s = str(text or "")
    if "{{EQ" in s:
        return s
    s = normalize_plain_physics_notation(s)

    def repl(match):
        raw = match.group(1)
        leading = re.match(r"^\s*", raw).group(0)
        trailing = re.search(r"\s*$", raw).group(0)
        core = raw.strip()
        while core and core[0] in ".,;:":
            leading += core[0]
            core = core[1:].lstrip()
        while core and core[-1] in ".,;:":
            trailing = core[-1] + trailing
            core = core[:-1].rstrip()
        core, trailing = trim_formula_edges(core, trailing)
        if not is_probable_physics_formula(core):
            return raw
        latex = rich_formula_to_latex(core)
        if not latex:
            return raw
        return f"{leading}{{{{EQ-LATEX:{latex}}}}}{trailing}"

    return INLINE_FORMULA_RE.sub(repl, s)


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


def add_photo_blocks(doc, photo_indices, photos, fig_counter, caption_prefix, target=None):
    target = target or doc
    selected = []
    for idx in as_list(photo_indices):
        try:
            photo = photos[int(idx)]
        except Exception:
            continue
        blob = decode_base64(photo.get("data_base64"))
        if blob:
            selected.append((photo, blob))
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
        for col, (photo, blob) in enumerate(group):
            fmt = image_format(photo.get("name"), photo.get("mimetype"), blob)
            fig_counter["value"] += 1
            caption = f"[그림 {fig_counter['value']}] {caption_prefix or '실험 사진'}"
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
    add_photo_blocks(doc, setup.get("photo_indices"), photos, fig_counter, "실험 장치", target=target)

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

        add_photo_blocks(doc, exp.get("photo_indices"), photos, fig_counter, title, target=target)


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
            pre.normalize_font_face(content.get("font_face") or content.get("__fontFace")),
        )
        if result_cell is not None and conclusion_cell is not None:
            clear_cell(result_cell)
            clear_cell(conclusion_cell)
            build_results(doc, content, target=result_cell, include_heading=False)
            build_conclusion(doc, content, target=conclusion_cell, include_heading=False)
            return doc
        clear_template_body(doc)
    else:
        doc = HwpxDocument.new()
        doc._v5_allow_highlights = bool(content.get("__allowHighlights", True))
        apply_phys_page_layout(doc)
        pre.apply_default_font(
            doc,
            pre.normalize_font_face(content.get("font_face") or content.get("__fontFace")),
        )
        build_header(doc, content)
    build_results(doc, content)
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
