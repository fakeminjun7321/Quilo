#!/usr/bin/env python3
"""hwpx-gen.py — chem-pre report HWPX generator (v5).

reads JSON content from stdin (or first arg as path) and writes HWPX bytes
to stdout (or second arg as path).

usage:
    python3 hwpx-gen.py < content.json > output.hwpx
    python3 hwpx-gen.py content.json output.hwpx

v5 brings the hwpx output to feature-parity with docx-gen.js:
- explicit Malgun Gothic font + per-heading point sizes (20/16/13/11/10/9 pt)
- 1.3 line spacing across the document
- 5 mm / 10 mm left indent on (1)..(N) items and notes
- right-aligned date / temperature / pressure on the title page
- dashed gray border on figure placeholder boxes; caption centered & italic
- Google image-search hyperlink rendered as blue underlined link
- light-blue shaded + bold + centered header row in the chemicals summary
- real OWPML sub/super script runs for _{x} / ^{x} markers (Unicode fallback
  removed — Hangul renders true subscripts/superscripts)
- inline **highlight** / *italic* mixed at run level
"""
import sys
import json
import re
from copy import deepcopy
from lxml import etree

from hwpx import HwpxDocument


KR_NUM = ["가", "나", "다", "라", "마", "바", "사", "아",
          "자", "차", "카", "타", "파", "하"]

# 사용자 양식과 일치하는 검은 동그라미 안 흰색 숫자 (Unicode dingbat).
# (1)~(20) 형태의 일반 괄호 숫자 대신 본문 항목 카운터로 사용한다.
CIRCLED_NUM = [
    "❶", "❷", "❸", "❹", "❺", "❻", "❼", "❽", "❾", "❿",
    "⓫", "⓬", "⓭", "⓮", "⓯", "⓰", "⓱", "⓲", "⓳", "⓴",
]


def numbered_marker(idx):
    """1-based index → ❶❷❸... (사용자 보고서 양식). 20 초과는 (N) 폴백."""
    if 1 <= idx <= len(CIRCLED_NUM):
        return CIRCLED_NUM[idx - 1]
    return f"({idx})"


# A4 page is 59528 HWPUNIT wide. The skeleton template used 30 mm left/right
# margins, which made generated reports feel cramped. Use 20 mm margins and
# size tables to the wider usable line length.
PAGE_WIDTH = 59528
PAGE_MARGIN_LR = 5668       # 20 mm
PAGE_MARGIN_TOP = 5668      # 20 mm
PAGE_MARGIN_BOTTOM = 5668   # 20 mm
PAGE_HEADER_FOOTER = 4252   # 15 mm
TABLE_WIDTH = 47600

NS_HH = "{http://www.hancom.co.kr/hwpml/2011/head}"
NS_HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
# `hc` is the HWPML "core" namespace at .../2011/core (NOT the .../2010/charDefault
# guess we used earlier; that mismatch caused lxml to emit ns2:fillBrush, which
# Hangul ignored). Verified against the user's Energy Conservation.hwpx.
NS_HC = "{http://www.hancom.co.kr/hwpml/2011/core}"

# OWPML char height is in 1/100 pt (so 1100 == 11 pt).
SIZE_TITLE_BIG = 1800     # 실험 보고서 (18 pt) — 사용자 양식과 일치
SIZE_TITLE = 1500         # 영문 (한글) 제목 (15 pt) — 한 줄에 들어가게
                          # 1./2./3./4. 헤딩에도 같은 크기 사용
SIZE_HEADING = 1300       # 가./나. 한글 단계 헤딩 (13 pt)
SIZE_BODY = 1100          # 본문 (11 pt)
SIZE_TABLE_HEADER = 1000  # 표 머리글 (10 pt)
SIZE_TABLE_BODY = 950     # 표 본문 (9.5 pt) — 11 pt는 좁은 셀에서 답답함
SIZE_CAPTION = 1000       # 그림 캡션 (10 pt)
SIZE_LINK = 900           # Google 검색 링크 (9 pt)

# margin units: 1 mm ≈ 283.46 HWPUNIT
INDENT_5MM = 1417
INDENT_10MM = 2835

# 1.6 line spacing — Hangul default. 130 (docx 1.3) was too tight and made
# adjacent lines look cramped (user reported "자간이 이상함").
LINE_SPACING_PERCENT = 160
TABLE_LINE_SPACING_PERCENT = 130
TABLE_CELL_MARGIN_X = 180
TABLE_CELL_MARGIN_Y = 100

# Figure box border color (gray, matches docx generator)
FIGURE_BORDER_COLOR = "#888888"
TABLE_HEADER_FILL = "#D9E2F3"
HIGHLIGHT_FILL = "#CDF2E4"
LINK_COLOR = "#0563C1"

# Match docx-gen.js FONT constant. Hangul auto-substitutes if Malgun Gothic
# isn't installed (the user's actual font might be 함초롬바탕 etc.).
DEFAULT_FONT_FACE = "Malgun Gothic"
ALLOWED_FONT_FACES = {
    "함초롬바탕",
    "함초롱바탕",
    "Malgun Gothic",
    "Nanum Gothic",
    "Nanum Myeongjo",
}


def normalize_font_face(face):
    face = str(face or "").strip()
    aliases = {
        "함초롱바탕": "함초롬바탕",
        "hamchorom-batang": "함초롬바탕",
        "malgun-gothic": "Malgun Gothic",
        "nanum-gothic": "Nanum Gothic",
        "nanum-myeongjo": "Nanum Myeongjo",
    }
    if face in aliases:
        return aliases[face]
    if face in ALLOWED_FONT_FACES:
        return face
    return DEFAULT_FONT_FACE


# ── Unicode super/subscript ────────────────────────────────────────────────
# Digits/signs render cleanly as Unicode glyphs. Alphabetic subscripts such as
# m_{exp} use real charPr offset+relSz runs instead; Unicode letter subscripts
# have uneven metrics in Hangul/PDF exports.
SUPERSCRIPT_MAP = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼",
    "(": "⁽", ")": "⁾",
    "a": "ᵃ", "b": "ᵇ", "c": "ᶜ", "d": "ᵈ", "e": "ᵉ", "f": "ᶠ",
    "g": "ᵍ", "h": "ʰ", "i": "ⁱ", "j": "ʲ", "k": "ᵏ", "l": "ˡ",
    "m": "ᵐ", "n": "ⁿ", "o": "ᵒ", "p": "ᵖ", "r": "ʳ", "s": "ˢ",
    "t": "ᵗ", "u": "ᵘ", "v": "ᵛ", "w": "ʷ", "x": "ˣ", "y": "ʸ", "z": "ᶻ",
}
SUBSCRIPT_MAP = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
    "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
    "+": "₊", "-": "₋", "−": "₋", "=": "₌",
    "(": "₍", ")": "₎",
    "a": "ₐ", "e": "ₑ", "h": "ₕ", "i": "ᵢ", "j": "ⱼ", "k": "ₖ",
    "l": "ₗ", "m": "ₘ", "n": "ₙ", "o": "ₒ", "p": "ₚ", "r": "ᵣ",
    "s": "ₛ", "t": "ₜ", "u": "ᵤ", "v": "ᵥ", "x": "ₓ",
}


def _try_unicode_map(s, table):
    if re.search(r"[A-Za-z]", s):
        return None
    out = []
    for ch in s:
        if ch in table:
            out.append(table[ch])
        else:
            return None
    return "".join(out)


# ── Element helpers ─────────────────────────────────────────────────────────


def _para_props(doc):
    hdr = doc.oxml.headers[0]
    for ch in hdr.element.iter(f"{NS_HH}paraProperties"):
        return hdr, ch
    return hdr, None


def _border_fills(doc):
    hdr = doc.oxml.headers[0]
    for ch in hdr.element.iter(f"{NS_HH}borderFills"):
        return hdr, ch
    return hdr, None


def _char_props(doc):
    hdr = doc.oxml.headers[0]
    for ch in hdr.element.iter(f"{NS_HH}charProperties"):
        return hdr, ch
    return hdr, None


def apply_default_font(doc, face=DEFAULT_FONT_FACE):
    """rewrite the face attribute of every <hh:font> in every <hh:fontface>
    so the document's primary text font matches docx output (Malgun Gothic
    in our case). Hangul falls back gracefully if the face is missing on
    the user's machine.
    """
    hdr = doc.oxml.headers[0]
    changed = False
    for font in hdr.element.iter(f"{NS_HH}font"):
        if font.get("face") != face:
            font.set("face", face)
            changed = True
    if changed:
        hdr.mark_dirty()


def apply_page_layout(doc):
    """Widen the writing area and normalize page margins.

    The blank HWPX template ships with 30 mm side margins. That leaves only
    ~15 cm of text width on A4 and makes Korean report paragraphs feel boxed in.
    """
    changed = False
    for sec in getattr(doc.oxml, "sections", []):
        for page_pr in sec.element.iter(f"{NS_HP}pagePr"):
            page_pr.set("width", str(PAGE_WIDTH))
            page_pr.set("height", "84186")
            margin = page_pr.find(f"{NS_HP}margin")
            if margin is not None:
                margin.set("left", str(PAGE_MARGIN_LR))
                margin.set("right", str(PAGE_MARGIN_LR))
                margin.set("top", str(PAGE_MARGIN_TOP))
                margin.set("bottom", str(PAGE_MARGIN_BOTTOM))
                margin.set("header", str(PAGE_HEADER_FOOTER))
                margin.set("footer", str(PAGE_HEADER_FOOTER))
                margin.set("gutter", "0")
                changed = True
    if changed:
        for sec in getattr(doc.oxml, "sections", []):
            if hasattr(sec, "mark_dirty"):
                sec.mark_dirty()


def _next_id(container):
    used = [
        int(c.get("id"))
        for c in container
        if c.get("id") is not None and c.get("id").lstrip("-").isdigit()
    ]
    return str(max(used) + 1) if used else "1"


# ── char property factory ──────────────────────────────────────────────────

_CHAR_CACHE_KEY = "_v5_char_cache"


def make_char_pr(doc, *, size=SIZE_BODY, bold=False, italic=False,
                 sub=False, sup=False, color=None, highlight=False):
    """create (or reuse) a charPr with the given style and return its id.
    cached via doc._v5_char_cache so repeated style requests don't bloat
    header.xml.
    """
    cache = getattr(doc, _CHAR_CACHE_KEY, None)
    if cache is None:
        cache = {}
        setattr(doc, _CHAR_CACHE_KEY, cache)
    key = (size, bold, italic, sub, sup, color, highlight)
    if key in cache:
        return cache[key]

    hdr, char_props = _char_props(doc)
    if char_props is None:
        return None

    template = list(char_props)[0]
    new_cp = deepcopy(template)
    new_id = _next_id(char_props)
    new_cp.set("id", new_id)
    new_cp.set("height", str(size))
    if color:
        new_cp.set("textColor", color)
    if highlight:
        new_cp.set("borderFillIDRef", str(make_highlight_border_fill(doc)))

    # set every fontRef language to "0" so the document's first font face
    # (Malgun Gothic if we registered it; otherwise Hangul default) is used
    fr = new_cp.find(f"{NS_HH}fontRef")
    if fr is not None:
        for lang in ("hangul", "latin", "hanja", "japanese",
                     "other", "symbol", "user"):
            fr.set(lang, "0")

    # remove any existing emphasis tags from the deep-copied template, then
    # add only the ones we want
    for tag in ("bold", "italic", "subscript", "superscript", "subScript",
                "supScript", "superScript"):
        for el in new_cp.findall(f"{NS_HH}{tag}"):
            new_cp.remove(el)
    if bold:
        etree.SubElement(new_cp, f"{NS_HH}bold")
    if italic:
        etree.SubElement(new_cp, f"{NS_HH}italic")

    # OWPML renders sub/superscript by adjusting the run's relative size
    # (relSz) + vertical offset, NOT a dedicated element. Hangul ignores
    # <hh:subScript/>; it honors relSz=60 + offset instead.
    #
    # Hancom Office HWP for macOS renders negative offsets above the baseline
    # and positive offsets below it. Keep signs explicit so plain-text markers
    # such as I_{cm} and T^{2} land on the expected side of the baseline.
    if sub or sup:
        rel_sz = new_cp.find(f"{NS_HH}relSz")
        offset = new_cp.find(f"{NS_HH}offset")
        if rel_sz is not None:
            for lang in ("hangul", "latin", "hanja", "japanese",
                         "other", "symbol", "user"):
                rel_sz.set(lang, "70")
        if offset is not None:
            value = "-35" if sup else "35"
            for lang in ("hangul", "latin", "hanja", "japanese",
                         "other", "symbol", "user"):
                offset.set(lang, value)

    char_props.append(new_cp)
    char_props.set("itemCnt", str(int(char_props.get("itemCnt") or 0) + 1))
    hdr.mark_dirty()

    cache[key] = new_id
    return new_id


# ── paragraph property factory ─────────────────────────────────────────────

_PARA_CACHE_KEY = "_v5_para_cache"


def make_para_pr(doc, *, align="LEFT", indent_left=0, line_spacing=None,
                 keep_with_next=False, space_after=0, space_before=0):
    cache = getattr(doc, _PARA_CACHE_KEY, None)
    if cache is None:
        cache = {}
        setattr(doc, _PARA_CACHE_KEY, cache)
    key = (align, indent_left, line_spacing, keep_with_next,
           space_after, space_before)
    if key in cache:
        return cache[key]

    hdr, para_props = _para_props(doc)
    if para_props is None:
        return None

    template = list(para_props)[0]
    new_pp = deepcopy(template)
    new_id = _next_id(para_props)
    new_pp.set("id", new_id)

    al = new_pp.find(f"{NS_HH}align")
    if al is not None:
        al.set("horizontal", align)

    if keep_with_next:
        bs = new_pp.find(f"{NS_HH}breakSetting")
        if bs is not None:
            bs.set("keepWithNext", "1")

    # margin and lineSpacing live inside hp:switch > (hp:case | hp:default)
    sw = new_pp.find(f"{NS_HP}switch")
    if sw is not None:
        for branch in sw:  # hp:case and hp:default both
            margin = branch.find(f"{NS_HH}margin")
            if margin is not None:
                if indent_left:
                    left = margin.find(f"{NS_HC}left")
                    if left is not None:
                        left.set("value", str(indent_left))
                if space_before:
                    prev = margin.find(f"{NS_HC}prev")
                    if prev is not None:
                        prev.set("value", str(space_before))
                if space_after:
                    nxt = margin.find(f"{NS_HC}next")
                    if nxt is not None:
                        nxt.set("value", str(space_after))
            ls = branch.find(f"{NS_HH}lineSpacing")
            if ls is not None and line_spacing is not None:
                ls.set("value", str(line_spacing))

    para_props.append(new_pp)
    para_props.set("itemCnt", str(int(para_props.get("itemCnt") or 0) + 1))
    hdr.mark_dirty()
    cache[key] = new_id
    return new_id


# ── borderFill factories ───────────────────────────────────────────────────


def _new_border_fill(doc, mutator):
    hdr, border_fills = _border_fills(doc)
    if border_fills is None:
        return None
    template = list(border_fills)[0]
    new_bf = deepcopy(template)
    new_id = _next_id(border_fills)
    new_bf.set("id", new_id)
    mutator(new_bf)
    border_fills.append(new_bf)
    border_fills.set("itemCnt", str(int(border_fills.get("itemCnt") or 0) + 1))
    hdr.mark_dirty()
    return new_id


def make_solid_border_fill(doc):
    """plain 4-side SOLID border without fill — for table data cells."""
    cache = getattr(doc, "_v5_solid_bf", None)
    if cache:
        return cache

    def mutate(bf):
        for side in ("leftBorder", "rightBorder", "topBorder", "bottomBorder"):
            el = bf.find(f"{NS_HH}{side}")
            if el is not None:
                el.set("type", "SOLID")
        for old in bf.findall(f"{NS_HH}fillBrush"):
            bf.remove(old)

    new_id = _new_border_fill(doc, mutate)
    doc._v5_solid_bf = new_id
    return new_id


def make_shaded_border_fill(doc, fill_color=TABLE_HEADER_FILL):
    """4-side SOLID border + light fill for table header cells."""
    cache_key = f"_v5_shaded_{fill_color}"
    cache = getattr(doc, cache_key, None)
    if cache:
        return cache

    def mutate(bf):
        for side in ("leftBorder", "rightBorder", "topBorder", "bottomBorder"):
            el = bf.find(f"{NS_HH}{side}")
            if el is not None:
                el.set("type", "SOLID")
        # remove inherited brushes from BOTH possible namespaces
        for ns in (NS_HH, NS_HC):
            for old in bf.findall(f"{ns}fillBrush"):
                bf.remove(old)
        # Hangul writes fillBrush/winBrush in the `hc` (charDefault)
        # namespace, NOT `hh` (head). Using the wrong namespace meant
        # earlier attempts were silently ignored.
        brush = etree.SubElement(bf, f"{NS_HC}fillBrush")
        # Verbatim form taken from a Hangul-shaded cell in the user's
        # 2402홍길동_Energy Conservation.hwpx — Hangul ignored every other
        # variant we tried.
        etree.SubElement(
            brush,
            f"{NS_HC}winBrush",
            attrib={
                "faceColor": fill_color,
                "hatchColor": "#000000",
                "alpha": "0",
            },
        )

    new_id = _new_border_fill(doc, mutate)
    setattr(doc, cache_key, new_id)
    return new_id


def make_highlight_border_fill(doc, fill_color=HIGHLIGHT_FILL):
    """No border + mint fill for inline highlighted text runs."""
    cache_key = f"_v5_highlight_{fill_color}"
    cache = getattr(doc, cache_key, None)
    if cache:
        return cache

    def mutate(bf):
        for side in ("leftBorder", "rightBorder", "topBorder", "bottomBorder"):
            el = bf.find(f"{NS_HH}{side}")
            if el is not None:
                el.set("type", "NONE")
        for ns in (NS_HH, NS_HC):
            for old in bf.findall(f"{ns}fillBrush"):
                bf.remove(old)
        brush = etree.SubElement(bf, f"{NS_HC}fillBrush")
        etree.SubElement(
            brush,
            f"{NS_HC}winBrush",
            attrib={
                "faceColor": fill_color,
                "hatchColor": "#FF000000",
                "alpha": "0",
            },
        )

    new_id = _new_border_fill(doc, mutate)
    setattr(doc, cache_key, new_id)
    return new_id


def make_dashed_border_fill(doc, color=FIGURE_BORDER_COLOR):
    """gray dashed 4-side border for figure placeholder boxes."""
    cache = getattr(doc, "_v5_dashed_bf", None)
    if cache:
        return cache

    def mutate(bf):
        for side in ("leftBorder", "rightBorder", "topBorder", "bottomBorder"):
            el = bf.find(f"{NS_HH}{side}")
            if el is not None:
                el.set("type", "DASH")
                el.set("color", color)
        for old in bf.findall(f"{NS_HH}fillBrush"):
            bf.remove(old)

    new_id = _new_border_fill(doc, mutate)
    doc._v5_dashed_bf = new_id
    return new_id


# ── Marker tokenizer ───────────────────────────────────────────────────────


_MARKER_RE = re.compile(
    r"(\*\*[^*]+\*\*|"          # **bold**
    r"(?<!\*)\*[^*]+\*(?!\*)|"   # *italic*
    r"_\{[^}]+\}|"               # _{sub}
    r"\^\{[^}]+\})"              # ^{sup}
)

EQ_PREFIXES = ("{{EQN-LATEX:", "{{EQ-LATEX:", "{{EQN:", "{{EQ:")
MANUAL_NUMBER_RE = re.compile(
    r"^\s*(?:(?:\(\s*\d{1,2}\s*\)|[①-⑳❶-❿]|\d{1,2}[.)])[\s:：-]+)+"
)


def find_equation_spans(text):
    """Return (start, end, kind, body) spans for approved equation markers.

    This mirrors lib/equation/hwpx_equation_tool.py enough for generation-time
    tokenization. It is intentionally local so HWPX text styling does not parse
    `_{} / ^{}` markers inside equation scripts before the post-processor runs.
    """
    spans = []
    pos = 0
    while True:
        starts = [
            (text.find(prefix, pos), prefix)
            for prefix in EQ_PREFIXES
            if text.find(prefix, pos) >= 0
        ]
        if not starts:
            return spans

        start, prefix = min(starts, key=lambda item: item[0])
        body_start = start + len(prefix)
        kind = prefix[2:-1]
        depth = 0
        i = body_start
        while i < len(text):
            char = text[i]
            if char == "\\":
                i += 2
                continue
            if char == "{":
                depth += 1
                i += 1
                continue
            if char == "}":
                if depth == 0 and i + 1 < len(text) and text[i + 1] == "}":
                    spans.append((start, i + 2, kind, text[body_start:i]))
                    pos = i + 2
                    break
                if depth > 0:
                    depth -= 1
                i += 1
                continue
            i += 1
        else:
            return spans


def has_equation_placeholder(text):
    return bool(find_equation_spans(text or ""))


def is_equation_placeholder_only(text):
    s = (text or "").strip()
    spans = find_equation_spans(s)
    return len(spans) == 1 and spans[0][0] == 0 and spans[0][1] == len(s)


def strip_manual_numbering(text):
    return MANUAL_NUMBER_RE.sub("", str(text or "")).strip()


def strip_manual_bullet(text):
    return re.sub(r"^\s*[-•]\s+", "", str(text or "")).strip()


def brace_unbraced_scripts(script):
    s = str(script or "")
    s = re.sub(r"([_^])(?!\{)([+\-])", r"\1{\2}", s)
    s = re.sub(r"([_^])(?!\{)(\d+(?:\.\d+)?)", r"\1{\2}", s)
    s = re.sub(r"([_^])(?!\{)([A-Za-z]+)", r"\1{\2}", s)
    return s


def compact_chemical_spacing(script):
    token = r"(?:[A-Z][a-z]?|\)(?:_\{[^}]+\})?)(?:_\{[^}]+\})?"
    command = r"(?:BUILDREL|TIMES|DIV|APPROX|INF|DELTA|SIGMA|GAMMA|THETA|LAMBDA|XI|PI|OMEGA|PHI|PSI)\b"
    return re.sub(
        rf"({token})\s+(?!{command})(?=[A-Z][a-z]?|\()",
        r"\1",
        str(script or ""),
    )


def lift_functional_group_subscripts(script):
    """Correct common LLM chemistry-script mistakes around substituent groups."""
    s = str(script or "")
    group = (
        r"(?:OH|COOH|CHO|NH(?:_\{?2\}?)|NO(?:_\{?2\}?)|"
        r"SO(?:_\{?3\}?H)|OCOCH(?:_\{?3\}?))"
    )
    s = re.sub(rf"_\s*\{{?\s*\(\s*({group})\s*\)\s*\}}?", r"(\1)", s)
    s = re.sub(rf"_\s*\{{\s*({group})\s*\}}", r"(\1)", s)
    return s


def normalize_equation_script(script):
    s = str(script or "").strip()
    s = (
        s.replace("→", "->")
        .replace("⟶", "->")
        .replace("⇒", "=>")
        .replace("←", "<-")
        .replace("⇌", "<->")
        .replace("↔", "<->")
        .replace("⇄", "<->")
    )
    s = re.sub(
        r"--\s*\[\s*([^\]]+?)\s*\]\s*(<->|<=>|->|<-|=>)",
        r"BUILDREL \2 {\1}",
        s,
    )
    s = re.sub(
        r"(<->|<=>|->|<-|=>)\s*\[\s*([^\]]+?)\s*\]",
        r"BUILDREL \1 {\2}",
        s,
    )
    s = s.replace("<=>", "<->")
    s = s.replace("×", " times ").replace("·", " cdot ")
    s = re.sub(r"\s+([_^])\s*", r"\1", s)
    s = brace_unbraced_scripts(s)
    s = lift_functional_group_subscripts(s)
    s = compact_chemical_spacing(s)
    s = re.sub(r"\s{2,}", " ", s)
    return s.strip()


def looks_like_standalone_equation(text):
    s = normalize_equation_script(strip_manual_numbering(text))
    if not s or has_equation_placeholder(s):
        return False
    outside_braces = re.sub(r"\{[^{}]*\}", "", s)
    # If Korean prose exists outside numerator/denominator labels, keep it as a
    # normal paragraph. Formula-only lines may still contain Korean inside {...}.
    if re.search(r"[가-힣]", outside_braces):
        return False
    has_operator = bool(
        re.search(
            r"\s(over|sqrt|sum|int|times)\s|->|<->|=|≈|~|\+",
            s,
            re.I,
        )
    )
    has_formula_bits = bool(
        re.search(r"[A-Za-z][A-Za-z0-9]*[_^]\{?[-+A-Za-z0-9]+", s)
        or re.search(r"\{[^{}]+\}\s+over\s+\{[^{}]+\}", s, re.I)
        or re.search(r"[A-Za-z%][A-Za-z0-9_{}% ]*\s*=\s*[-+A-Za-z0-9{(%]", s)
        or re.search(r"\d", s)
    )
    return has_operator and has_formula_bits


def should_skip_auto_equation(text):
    s = str(text or "").strip()
    if not s:
        return True

    if re.search(r"https?://|www\.|doi\s*:|@", s, re.I):
        return True
    if re.match(r"^\s*\[\d+\]", s):
        return True
    if re.match(
        r"^\s*(?:참고문헌|references?|출처|source|pubchem|nist|chemspider|doi|url)\b",
        s,
        re.I,
    ):
        return True

    # Keep label/value prose and references as plain text. Labelled equations
    # with known math keywords are handled before this guard.
    if re.match(r"^.{1,80}[:：]\s*\S+", s):
        return True

    # Long Korean prose can contain numbers and '=' signs, but should not be
    # promoted wholesale into a centered equation object.
    if len(s) > 80 and re.search(r"[가-힣]", s):
        return True

    return False


def normalize_equation_markers(text):
    """Promote raw equation-script lines to approved HWPX equation markers."""
    s = str(text or "")
    if has_equation_placeholder(s):
        return s

    stripped = strip_manual_numbering(s)
    if should_skip_auto_equation(stripped) and not re.search(
        r"(?:반응식|수득률|계산식|공식|formula|equation|yield)",
        stripped,
        re.I,
    ):
        return s

    labeled = re.match(
        r"^(.{0,60}?(?:반응식|수득률|계산식|공식|formula|equation|yield)[^:：=]*[:：=]\s*)(.+)$",
        stripped,
        re.I,
    )
    if labeled and looks_like_standalone_equation(labeled.group(2)):
        return f"{labeled.group(1)}{{{{EQ:{normalize_equation_script(labeled.group(2))}}}}}"

    if should_skip_auto_equation(stripped):
        return s

    if looks_like_standalone_equation(stripped):
        return f"{{{{EQ:{normalize_equation_script(stripped)}}}}}"

    return s


def is_equation_only_text(text):
    return is_equation_placeholder_only(normalize_equation_markers(text))


def tokenize_marker_text(text):
    """convert text into [(plain, bold, italic, sub, sup, highlight), ...] tokens.

    sub/sup precedence:
    1. Try Unicode subscript/superscript chars — Hangul renders them
       natively as proper subscripts (no styling needed).
    2. If any char in the run isn't in the Unicode map, fall back to a
       charPr offset+relSz run (sub/sup True flag).
    """
    if not text:
        return []
    out = []
    pos = 0
    for m in _MARKER_RE.finditer(text):
        if m.start() > pos:
            out.append((text[pos:m.start()], False, False, False, False, False))
        token = m.group(0)
        if token.startswith("**"):
            inner = tokenize_marker_text(token[2:-2])
            if inner:
                for plain, b, i, sub, sup, highlight in inner:
                    out.append((plain, True or b, i, sub, sup, True or highlight))
            else:
                out.append((token[2:-2], True, False, False, False, True))
        elif token.startswith("_{"):
            body = token[2:-1]
            mapped = _try_unicode_map(body, SUBSCRIPT_MAP)
            if mapped is not None:
                out.append((mapped, False, False, False, False, False))
            else:
                out.append((body, False, False, True, False, False))
        elif token.startswith("^{"):
            body = token[2:-1]
            mapped = _try_unicode_map(body, SUPERSCRIPT_MAP)
            if mapped is not None:
                out.append((mapped, False, False, False, False, False))
            else:
                out.append((body, False, False, False, True, False))
        else:
            inner = tokenize_marker_text(token[1:-1])
            if inner:
                for plain, b, i, sub, sup, highlight in inner:
                    out.append((plain, b, True or i, sub, sup, highlight))
            else:
                out.append((token[1:-1], False, True, False, False, False))
        pos = m.end()
    if pos < len(text):
        out.append((text[pos:], False, False, False, False, False))
    return [t for t in out if t[0]]


def tokenize(text):
    """Tokenize rich text while preserving HWPX equation placeholders intact."""
    if not text:
        return []

    spans = find_equation_spans(text)
    if not spans:
        return tokenize_marker_text(text)

    out = []
    pos = 0
    for start, end, _kind, _body in spans:
        if start > pos:
            out.extend(tokenize_marker_text(text[pos:start]))
        out.append((text[start:end], False, False, False, False, False))
        pos = end
    if pos < len(text):
        out.extend(tokenize_marker_text(text[pos:]))
    return [t for t in out if t[0]]


def tokens_plain(text):
    """fully strip every marker — for table cells / footers / captions that
    can't carry inline runs.
    """
    return "".join(tok[0] for tok in tokenize(text))


# ── Paragraph builder ──────────────────────────────────────────────────────


def _is_equation_only(text):
    """text 전체가 단일 {{EQ:...}}, {{EQN:...}}, {{EQ-LATEX:...}}, 또는
    {{EQN-LATEX:...}} placeholder로만 구성되어 있는지 (앞뒤 공백 제외).
    그 경우 사용자 보고서 양식(가운데 정렬된 단독 식 줄)을 따라가도록
    automatic CENTER 정렬을 적용한다.
    """
    return is_equation_placeholder_only(text)


def add_para(doc, text, *, base_size=SIZE_BODY, bold=False, align="LEFT",
             indent_left=0, keep_with_next=False, color=None,
             space_after=None, space_before=0):
    """add a paragraph with mixed runs honoring **bold**, *italic*, _{sub},
    ^{sup}. The paragraph itself takes alignment + indent + line spacing
    + optional vertical breathing room (space_after / space_before in
    HWPUNIT — 283 ≈ 1mm ≈ 2.83pt).

    단독 수식 placeholder(`{{EQ:...}}` 등)만 담은 단락은 자동으로 가운데
    정렬 + 들여쓰기 0으로 보정하여 사용자 보고서 양식(검은 박스 안 식)에
    가깝게 표시한다.
    """
    text = normalize_equation_markers(text)
    if _is_equation_only(text):
        align = "CENTER"
        indent_left = 0
    effective_space_after = SPACE_BODY if space_after is None else space_after

    para_pr = make_para_pr(
        doc,
        align=align,
        indent_left=indent_left,
        line_spacing=LINE_SPACING_PERCENT,
        keep_with_next=keep_with_next,
        space_after=effective_space_after,
        space_before=space_before,
    )
    p = doc.add_paragraph(
        "", para_pr_id_ref=para_pr, inherit_style=False
    )

    tokens = tokenize(text)
    if not tokens:
        cp = make_char_pr(doc, size=base_size, bold=bold, color=color)
        p.add_run("", char_pr_id_ref=cp)
        return p

    for plain, b, i, sub, sup, highlight in tokens:
        cp = make_char_pr(
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


# spacing constants (HWPUNIT, 283 ≈ 1 mm). HWPX looked too dense after
# converting to PDF, so body paragraphs now get visible breathing room by default.
SPACE_BODY = 700          # paragraph separation after numbered/body paragraphs
SPACE_HEADING_LV1 = 1100  # 1./2. headings: clear gap before major sections
SPACE_HEADING_LV2 = 650   # 가./나. headings


def add_heading(doc, text, *, size=SIZE_TITLE, align="LEFT", indent_left=0,
                space_before=0, space_after=0):
    return add_para(
        doc,
        text,
        base_size=size,
        bold=True,
        align=align,
        indent_left=indent_left,
        keep_with_next=True,
        space_before=space_before,
        space_after=space_after,
    )


def add_numbered_item(doc, idx, text, *, indent_left=INDENT_5MM,
                      base_size=SIZE_BODY, space_after=None):
    """Add a numbered prose item, but keep formula-only rows unnumbered.

    Claude sometimes emits a reaction or formula as its own list item. Numbering
    those rows creates the awkward `② C_6 ...` / `⑥ {m over n}` look. For HWPX,
    formula-only rows are promoted to centered equation objects and do not
    consume a paragraph number.
    """
    clean = normalize_equation_markers(strip_manual_numbering(text))
    if is_equation_placeholder_only(clean):
        add_para(
            doc,
            clean,
            base_size=base_size,
            space_after=SPACE_BODY if space_after is None else space_after,
        )
        return False

    add_para(
        doc,
        f"{numbered_marker(idx)} {clean}",
        base_size=base_size,
        indent_left=indent_left,
        space_after=space_after,
    )
    return True


def add_blank(doc):
    doc.add_paragraph("")


# ── Section builders ──────────────────────────────────────────────────────


def build_title_page(doc, content):
    title_kr = content.get("title_kr", "")
    title_en = content.get("title_en", "")
    date = content.get("date", "")
    student_id = (content.get("student_id") or "").strip()
    student_name = (content.get("student_name") or "").strip()

    add_heading(
        doc, "실험 보고서", size=SIZE_TITLE_BIG, align="CENTER",
        space_after=SPACE_HEADING_LV1,
    )
    add_heading(
        doc, f"{title_en} ({title_kr})", size=SIZE_TITLE, align="CENTER",
        space_after=SPACE_HEADING_LV1,
    )

    if student_id or student_name:
        identity = " ".join(x for x in [student_id, student_name] if x)
        add_para(doc, identity, align="RIGHT")

    add_para(doc, f"날짜 : {date}", align="RIGHT", space_after=SPACE_HEADING_LV1)


def build_purpose(doc, items):
    add_heading(doc, "1. 실험목표", size=SIZE_TITLE,
                space_before=SPACE_HEADING_LV1, space_after=SPACE_HEADING_LV2)
    add_heading(doc, "가. 실험목표", size=SIZE_HEADING,
                space_after=SPACE_BODY)
    text_counter = 0
    for item in items:
        text_counter += 1
        if not add_numbered_item(doc, text_counter, item):
            text_counter -= 1


def build_theory(doc, theory, figures_needed):
    add_heading(doc, "2. 이론적 배경과 원리", size=SIZE_TITLE,
                space_before=SPACE_HEADING_LV1, space_after=SPACE_HEADING_LV2)
    fig_map = {f.get("number"): f for f in (figures_needed or [])}

    for s_idx, section in enumerate(theory):
        kr = KR_NUM[s_idx] if s_idx < len(KR_NUM) else str(s_idx + 1)
        add_heading(
            doc,
            f"{kr}. {strip_manual_numbering(section.get('topic', ''))}",
            size=SIZE_HEADING,
            space_after=SPACE_BODY,
        )

        items = section.get("items") or section.get("paragraphs") or []
        text_counter = 0
        for item in items:
            if isinstance(item, dict) and "figure" in item:
                fig_num = item["figure"]
                fig = fig_map.get(fig_num)
                if fig:
                    add_figure_placeholder(doc, fig)
                else:
                    add_para(doc, f"[그림 {fig_num}] (메타데이터 없음)")
            elif isinstance(item, str):
                text_counter += 1
                if not add_numbered_item(doc, text_counter, item):
                    text_counter -= 1

        for fig_ref in section.get("figures", []):
            full = fig_map.get(fig_ref.get("number")) or fig_ref
            add_figure_placeholder(doc, full)


def add_figure_placeholder(doc, fig):
    """dashed-border 2x1 box: caption (centered, italic) + image area."""
    caption = fig.get("caption", "")
    description = fig.get("description", "")
    search_query = fig.get("search_query") or caption
    number = fig.get("number", "")

    head = f"[그림 {number}] {tokens_plain(caption)}"
    if description:
        head += f" — {tokens_plain(description)}"

    dashed_id = make_dashed_border_fill(doc)

    # 사용자 보고서 양식: 그림이 위, 캡션이 아래.
    table = doc.add_table(rows=2, cols=1, width=TABLE_WIDTH,
                          border_fill_id_ref=dashed_id)
    for r in range(2):
        cell = table.cell(r, 0)
        cell.element.set("borderFillIDRef", str(dashed_id))

    # row 0: 이미지 자리 + Google 검색 링크 (사용자가 채워넣음)
    img_cell = table.cell(0, 0)
    _replace_cell_with_styled(
        doc, img_cell,
        "  ↓ 여기에 이미지를 붙여넣으세요",
        size=SIZE_LINK, align="CENTER",
    )
    img_cell.set_size(height=18000)
    link_para_pr = make_para_pr(
        doc, align="CENTER", line_spacing=LINE_SPACING_PERCENT
    )
    link_p = img_cell.add_paragraph("", para_pr_id_ref=link_para_pr)
    cp_prefix = make_char_pr(doc, size=SIZE_LINK)
    link_p.add_run("🔎 Google 이미지 검색: ", char_pr_id_ref=cp_prefix)
    cp_link = make_char_pr(doc, size=SIZE_LINK, color=LINK_COLOR)
    link_url = (
        "https://www.google.com/search?tbm=isch&q="
        + _url_encode(search_query)
    )
    try:
        link_p.add_hyperlink(link_url, f'"{search_query}"', char_pr_id_ref=cp_link)
    except Exception:
        link_p.add_run(f'"{search_query}"', char_pr_id_ref=cp_link)

    # row 1: 캡션 (가운데 + 이탤릭) — 그림 아래
    cap_cell = table.cell(1, 0)
    _replace_cell_with_styled(
        doc, cap_cell, head,
        size=SIZE_CAPTION, italic=True, align="CENTER",
    )


def _url_encode(s):
    from urllib.parse import quote
    return quote(s, safe="")


def set_cell_margins(cell, left=TABLE_CELL_MARGIN_X, right=TABLE_CELL_MARGIN_X,
                     top=TABLE_CELL_MARGIN_Y, bottom=TABLE_CELL_MARGIN_Y):
    cell.element.set("hasMargin", "1")
    margin = cell.element.find(f"{NS_HP}cellMargin")
    if margin is None:
        margin = etree.SubElement(cell.element, f"{NS_HP}cellMargin")
    margin.set("left", str(left))
    margin.set("right", str(right))
    margin.set("top", str(top))
    margin.set("bottom", str(bottom))
    try:
        cell.table.mark_dirty()
    except Exception:
        pass


def _replace_cell_with_styled(doc, cell, text, *, size=SIZE_BODY, bold=False,
                              italic=False, align="LEFT", color=None,
                              line_spacing=LINE_SPACING_PERCENT,
                              cell_margin=True):
    """erase any existing paragraphs in `cell` and add a single styled one."""
    if cell_margin:
        set_cell_margins(cell)
    # remove pre-existing paragraphs (set_cell_text leaves an empty one)
    parent = cell.element
    for p in parent.findall(f"{NS_HP}subList/{NS_HP}p"):
        p.getparent().remove(p)
    # cells may also have raw <hp:p> children
    for p in parent.findall(f"{NS_HP}p"):
        p.getparent().remove(p)

    para_pr = make_para_pr(
        doc, align=align, line_spacing=line_spacing
    )
    p = cell.add_paragraph("", para_pr_id_ref=para_pr)
    tokens = tokenize(text)
    if not tokens:
        cp = make_char_pr(doc, size=size, bold=bold, italic=italic, color=color)
        p.add_run("", char_pr_id_ref=cp)
        return
    for plain, b, i, sub, sup, highlight in tokens:
        cp = make_char_pr(
            doc,
            size=size,
            bold=bold or b,
            italic=italic or i,
            sub=sub,
            sup=sup,
            color=color,
            highlight=highlight and getattr(doc, "_v5_allow_highlights", True),
        )
        p.add_run(plain, char_pr_id_ref=cp)


# ── Tables ─────────────────────────────────────────────────────────────────


def build_chemicals_summary_table(doc, rows):
    if not rows:
        return
    headers = ["시약", "화학식", "몰질량 (g/mol)", "녹는점/끓는점", "주요 특성"]
    solid_id = make_solid_border_fill(doc)
    shaded_id = make_shaded_border_fill(doc)

    table = doc.add_table(
        rows=len(rows) + 1,
        cols=len(headers),
        width=TABLE_WIDTH,
        border_fill_id_ref=solid_id,
    )

    # 합 = TABLE_WIDTH. 표 전용 작은 글자와 함께 헤더가 어색하게 쪼개지지
    # 않도록 몰질량/녹는점 열을 조금 넓히고, 셀 안쪽 여백을 둔다.
    col_widths = [9400, 7900, 8200, 8600, 13500]
    for c, w in enumerate(col_widths):
        for r in range(len(rows) + 1):
            try:
                table.cell(r, c).set_size(width=w)
            except Exception:
                pass

    # header row: shaded + bold + center
    for c, h in enumerate(headers):
        cell = table.cell(0, c)
        cell.element.set("borderFillIDRef", str(shaded_id))
        _replace_cell_with_styled(
            doc,
            cell,
            h,
            size=SIZE_TABLE_HEADER,
            bold=True,
            align="CENTER",
            line_spacing=TABLE_LINE_SPACING_PERCENT,
        )

    # data rows
    for r_idx, row in enumerate(rows, 1):
        cells = [
            row.get("name", ""),
            row.get("formula", ""),
            row.get("molar_mass", ""),
            row.get("mp_bp", ""),
            row.get("properties", ""),
        ]
        for c_idx, val in enumerate(cells):
            cell = table.cell(r_idx, c_idx)
            cell.element.set("borderFillIDRef", str(solid_id))
            _replace_cell_with_styled(
                doc,
                cell,
                val,
                size=SIZE_TABLE_BODY,
                align="CENTER",
                line_spacing=TABLE_LINE_SPACING_PERCENT,
            )


def build_apparatus_and_chemicals(doc, content):
    add_heading(doc, "3. 실험 기구 및 시약", size=SIZE_TITLE,
                space_before=SPACE_HEADING_LV1, space_after=SPACE_HEADING_LV2)
    add_heading(doc, "가. 실험 기구", size=SIZE_HEADING,
                space_after=SPACE_BODY)
    for idx, ap in enumerate(content.get("apparatus", []), 1):
        en = f" ({ap.get('name_en')})" if ap.get("name_en") else ""
        name = strip_manual_numbering(ap.get("name", ""))
        line = (
            f"{numbered_marker(idx)} **{name}**{en}: "
            f"{ap.get('description', '')}"
        )
        add_para(doc, line, indent_left=INDENT_5MM)

    add_heading(doc, "나. 시약", size=SIZE_HEADING, space_after=SPACE_BODY)
    # build URL→[N] index so duplicate sources share the same number
    ref_index = _ref_url_index(content)
    for idx, ch in enumerate(content.get("chemicals", []), 1):
        ref_marker = ""
        src = (ch.get("source_url") or "").strip()
        if src and src in ref_index:
            ref_marker = f" [{ref_index[src]}]"
        name = strip_manual_numbering(ch.get("name", ""))
        head = (
            f"{numbered_marker(idx)} **{name}** "
            f"({ch.get('iupac', '')}, {ch.get('formula', '')}){ref_marker}"
        )
        add_para(doc, head, indent_left=INDENT_5MM)

        details = []
        if ch.get("molar_mass"):
            details.append(f"· 몰질량: {ch['molar_mass']}")
        if ch.get("mp_bp"):
            details.append(f"· 녹는점/끓는점: {ch['mp_bp']}")
        if ch.get("density"):
            details.append(f"· 밀도: {ch['density']}")
        if ch.get("properties"):
            details.append(f"· 주요 특성: {ch['properties']}")
        if ch.get("toxicity"):
            details.append(f"· 독성/취급: {ch['toxicity']}")
        for i, line in enumerate(details):
            add_para(
                doc,
                line,
                indent_left=INDENT_10MM,
                space_after=SPACE_BODY if i == len(details) - 1 else 120,
            )

    summary = content.get("chemicals_summary_table") or []
    if summary:
        add_heading(doc, "[표 1] 시약 요약", size=SIZE_BODY)
        build_chemicals_summary_table(doc, summary)


def build_table_of_contents(doc, content):
    """short TOC after the title page. Built from content (theory topics,
    procedure titles), not from headings already in the doc, since hwpx
    doesn't expose page numbers from Python.
    """
    has_refs = bool(_ref_url_index(content))
    has_chemicals = bool(content.get("chemicals_summary_table"))

    add_heading(doc, "목차", size=SIZE_TITLE,
                space_before=SPACE_HEADING_LV1, space_after=SPACE_HEADING_LV2)

    def lv1(text):
        add_para(doc, text, base_size=SIZE_BODY, bold=True,
                 indent_left=INDENT_5MM)

    def lv2(text):
        add_para(doc, text, base_size=SIZE_BODY, indent_left=INDENT_10MM)

    lv1("1. 실험목표")
    lv2("가. 실험목표")

    lv1("2. 이론적 배경과 원리")
    for s_idx, section in enumerate(content.get("theory", [])):
        kr = KR_NUM[s_idx] if s_idx < len(KR_NUM) else str(s_idx + 1)
        topic = section.get("topic", "")
        lv2(f"{kr}. {strip_manual_numbering(topic)}")

    lv1("3. 실험 기구 및 시약")
    lv2("가. 실험 기구")
    lv2("나. 시약")
    if has_chemicals:
        lv2("[표 1] 시약 요약")

    lv1("4. 실험 과정")
    for sec_idx, sec in enumerate(content.get("procedure", [])):
        kr = KR_NUM[sec_idx] if sec_idx < len(KR_NUM) else str(sec_idx + 1)
        lv2(f"{kr}. {strip_manual_numbering(sec.get('title', ''))}")

    if has_refs:
        lv1("참고문헌")


def _ref_url_index(content):
    """build a dict mapping each URL to its 1-based reference index.
    Sources are gathered from chemicals[].source_url and references[].url
    (deduped, in first-seen order). Returns {} when there are no sources.
    """
    out = {}
    n = 0
    for ch in content.get("chemicals", []) or []:
        url = (ch.get("source_url") or "").strip()
        if url and url not in out:
            n += 1
            out[url] = n
    for ref in content.get("references", []) or []:
        if not isinstance(ref, dict):
            continue
        url = (ref.get("url") or "").strip()
        if url and url not in out:
            n += 1
            out[url] = n
    return out


def _ref_label_for(url, content):
    """find a human label for a URL (from references[] or chemicals[])."""
    for ref in content.get("references", []) or []:
        if not isinstance(ref, dict):
            continue
        if (ref.get("url") or "").strip() == url:
            return (ref.get("label") or url).strip()
    for ch in content.get("chemicals", []) or []:
        if (ch.get("source_url") or "").strip() == url:
            return (ch.get("name") or url).strip()
    return url


def ref_to_string(ref):
    if isinstance(ref, str):
        return ref
    if isinstance(ref, dict):
        parts = [
            ref.get("author") or ref.get("authors"),
            ref.get("year") or ref.get("date"),
            ref.get("title"),
            ref.get("journal"),
            ref.get("publisher"),
            ref.get("url"),
        ]
        values = [str(p).strip() for p in parts if str(p or "").strip()]
        if values:
            return ", ".join(values)
        return json.dumps(ref, ensure_ascii=False)
    return str(ref or "")


def build_references(doc, content):
    """append a "참고문헌" heading + numbered list of clickable URLs at the
    end of the document. Skips entirely if there are no sources.
    """
    ref_index = _ref_url_index(content)
    if not ref_index:
        return

    add_heading(doc, "참고문헌", size=SIZE_TITLE,
                space_before=SPACE_HEADING_LV1, space_after=SPACE_HEADING_LV2)

    # ordered by index
    for url in sorted(ref_index.keys(), key=lambda u: ref_index[u]):
        idx = ref_index[url]
        label = _ref_label_for(url, content)

        # Render as: "[1] PubChem — Water (CID 962): https://..."
        para_pr = make_para_pr(
            doc, indent_left=INDENT_5MM, line_spacing=LINE_SPACING_PERCENT
        )
        p = doc.add_paragraph(
            "", para_pr_id_ref=para_pr, inherit_style=False
        )
        cp = make_char_pr(doc, size=SIZE_BODY)
        p.add_run(f"[{idx}] {label}: ", char_pr_id_ref=cp)

        cp_link = make_char_pr(doc, size=SIZE_BODY, color=LINK_COLOR)
        try:
            p.add_hyperlink(url, url, char_pr_id_ref=cp_link)
        except Exception:
            p.add_run(url, char_pr_id_ref=cp_link)


def is_minimal_style(content):
    return str(content.get("__style") or content.get("style") or "").strip() == "minimal"


def build_minimal_header(doc, content):
    title_kr = content.get("title_kr", "")
    title_en = content.get("title_en", "")
    date = content.get("date", "")
    student_id = (content.get("student_id") or "").strip()
    student_name = (content.get("student_name") or "").strip()
    title_line = title_en if title_en else title_kr
    if title_en and title_kr:
        title_line = f"{title_en} ({title_kr})"
    if title_line:
        add_heading(
            doc, title_line, size=SIZE_TITLE, align="CENTER",
            space_after=SPACE_HEADING_LV2,
        )
    header_bits = []
    identity = " ".join(x for x in [student_id, student_name] if x)
    if identity:
        header_bits.append(identity)
    if date:
        header_bits.append(date)
    if header_bits:
        add_para(
            doc, " | ".join(header_bits), align="RIGHT",
            space_after=SPACE_HEADING_LV1,
        )


def build_minimal_purpose(doc, items):
    add_heading(doc, "1. 실험 목표", size=SIZE_TITLE,
                space_before=SPACE_HEADING_LV2, space_after=SPACE_HEADING_LV2)
    values = [str(x).strip() for x in (items or []) if str(x or "").strip()]
    if values:
        add_para(doc, " ".join(values), indent_left=0)
    else:
        add_para(doc, "(데이터 부족)")


def build_minimal_theory(doc, theory):
    add_heading(doc, "2. 이론적 배경", size=SIZE_TITLE,
                space_before=SPACE_HEADING_LV1, space_after=SPACE_HEADING_LV2)
    if not theory:
        add_para(doc, "(이론 데이터 부족)")
        return
    for idx, section in enumerate(theory, 1):
        add_heading(
            doc,
            f"({idx}) {strip_manual_numbering(section.get('topic', ''))}",
            size=SIZE_HEADING, space_after=SPACE_BODY,
        )
        items = section.get("items") or section.get("paragraphs") or []
        for item in items:
            if isinstance(item, str):
                add_para(doc, item, indent_left=INDENT_5MM)
            elif isinstance(item, dict) and item.get("text"):
                add_para(doc, item.get("text", ""), indent_left=INDENT_5MM)


def build_minimal_apparatus_and_chemicals(doc, content):
    add_heading(doc, "3. 실험 기구 및 시약", size=SIZE_TITLE,
                space_before=SPACE_HEADING_LV1, space_after=SPACE_HEADING_LV2)

    add_heading(doc, "(1) 실험 기구", size=SIZE_HEADING, space_after=SPACE_BODY)
    apps = content.get("apparatus") or []
    if not apps:
        add_para(doc, "(기구 데이터 부족)")
    for ap in apps:
        description = ap.get("description", "")
        detail = f": {description}" if description else ""
        name = strip_manual_numbering(ap.get("name", ""))
        add_para(doc, f"{name}{detail}", indent_left=INDENT_5MM)

    add_heading(doc, "(2) 시약", size=SIZE_HEADING,
                space_before=SPACE_HEADING_LV2, space_after=SPACE_BODY)
    chems = content.get("chemicals") or []
    if not chems:
        add_para(doc, "(시약 데이터 부족)")
    for ch in chems:
        head_parts = [ch.get("formula"), ch.get("molar_mass")]
        head_parts = [str(x).strip() for x in head_parts if str(x or "").strip()]
        name = strip_manual_numbering(ch.get("name") or ch.get("iupac") or "")
        head = f"{name} ({', '.join(head_parts)})" if head_parts else name
        details = []
        if ch.get("mp_bp"):
            details.append(f"녹는점/끓는점: {ch['mp_bp']}")
        if ch.get("density"):
            details.append(f"밀도: {ch['density']}")
        if ch.get("properties"):
            details.append(f"주요 특성: {ch['properties']}")
        if ch.get("toxicity"):
            details.append(f"독성/취급: {ch['toxicity']}")
        add_para(doc, head, indent_left=INDENT_5MM, bold=True)
        for detail in details:
            add_para(doc, f"- {detail}", indent_left=INDENT_10MM)


def build_minimal_procedure(doc, procedure):
    add_heading(doc, "4. 실험 과정", size=SIZE_TITLE,
                space_before=SPACE_HEADING_LV1, space_after=SPACE_HEADING_LV2)
    if not procedure:
        add_para(doc, "(실험 과정 데이터 부족)")
        return
    for sec_idx, sec in enumerate(procedure, 1):
        if len(procedure) > 1:
            add_heading(
                doc,
                f"({sec_idx}) {strip_manual_numbering(sec.get('title', ''))}",
                size=SIZE_HEADING, space_after=SPACE_BODY,
            )
        for step_idx, step in enumerate(sec.get("steps", []) or [], 1):
            if isinstance(step, str):
                text = step
                notes = []
            else:
                text = step.get("text", "")
                notes = step.get("notes", []) or []
            add_para(
                doc,
                f"{numbered_marker(step_idx)} {strip_manual_numbering(text)}",
                indent_left=INDENT_5MM,
            )
            for note in notes:
                add_para(
                    doc,
                    f"- {strip_manual_numbering(strip_manual_bullet(note))}",
                    indent_left=INDENT_10MM,
                )


def build_minimal_references(doc, refs):
    if not refs:
        return
    add_heading(doc, "5. 참고 문헌", size=SIZE_TITLE,
                space_before=SPACE_HEADING_LV1, space_after=SPACE_HEADING_LV2)
    for ref in refs:
        text = ref_to_string(ref)
        if text:
            add_para(doc, text, indent_left=INDENT_5MM)


def build_procedure(doc, procedure):
    add_heading(doc, "4. 실험 과정", size=SIZE_TITLE,
                space_before=SPACE_HEADING_LV1, space_after=SPACE_HEADING_LV2)
    for sec_idx, sec in enumerate(procedure):
        kr = KR_NUM[sec_idx] if sec_idx < len(KR_NUM) else str(sec_idx + 1)
        add_heading(
            doc,
            f"{kr}. {strip_manual_numbering(sec.get('title', ''))}",
            size=SIZE_HEADING,
            space_after=SPACE_BODY,
        )
        step_counter = 0
        for step in sec.get("steps", []):
            if isinstance(step, str):
                step_counter += 1
                if not add_numbered_item(doc, step_counter, step):
                    step_counter -= 1
            elif isinstance(step, dict):
                step_counter += 1
                if not add_numbered_item(doc, step_counter, step.get("text", "")):
                    step_counter -= 1
                for note in step.get("notes", []):
                    add_para(
                        doc,
                        f"- {strip_manual_numbering(strip_manual_bullet(note))}",
                        indent_left=INDENT_10MM,
                    )


# ── Footer with auto page number ───────────────────────────────────────────


def add_page_number_to_footer(doc):
    try:
        sec = doc.oxml.sections[0]
    except (IndexError, AttributeError):
        return
    sec_elem = getattr(sec, "element", None)
    if sec_elem is None:
        return
    for footer in sec_elem.iter(f"{NS_HP}footer"):
        for run in footer.iter(f"{NS_HP}run"):
            t = run.find(f"{NS_HP}t")
            if t is None or t.text is None:
                continue
            if "사전보고서" not in t.text:
                continue
            t.text = "- "
            etree.SubElement(
                run,
                f"{NS_HP}pageNum",
                attrib={"pageStartsOn": "BOTH", "pageNumberFormat": "DIGIT"},
            )
            tail = etree.SubElement(run, f"{NS_HP}t")
            tail.text = " -"
            if hasattr(sec, "mark_dirty"):
                sec.mark_dirty()
            return


# ── Top-level ─────────────────────────────────────────────────────────────


def generate_hwpx(content):
    doc = HwpxDocument.new()
    doc._v5_allow_highlights = bool(content.get("__allowHighlights", True))
    apply_page_layout(doc)
    apply_default_font(
        doc,
        normalize_font_face(content.get("font_face") or content.get("__fontFace")),
    )

    if is_minimal_style(content):
        build_minimal_header(doc, content)
        build_minimal_purpose(doc, content.get("purpose", []))
        build_minimal_theory(doc, content.get("theory", []))
        build_minimal_apparatus_and_chemicals(doc, content)
        build_minimal_procedure(doc, content.get("procedure", []))
        build_minimal_references(doc, content.get("references", []))
    else:
        build_title_page(doc, content)
        build_purpose(doc, content.get("purpose", []))
        build_theory(doc, content.get("theory", []), content.get("figures_needed", []))
        build_apparatus_and_chemicals(doc, content)
        build_procedure(doc, content.get("procedure", []))
        build_references(doc, content)

        try:
            doc.set_footer_text("- 사전보고서 -")
            add_page_number_to_footer(doc)
        except Exception:
            pass

    return doc


def _postprocess_equations(hwpx_path):
    """Run hwpx_equation_tool.replace_equation_placeholders so every
    {{EQ:...}} / {{EQN:...}} marker becomes a real <hp:equation> object that
    Hangul renders with its native equation engine.

    The tool can't write to the same path it reads from (its
    write_zip_with_updates opens the output in "w" mode which truncates the
    input on the first call). So we write to a sibling temp file, then
    atomically replace the original.

    Failures are fatal for HWPX output. Otherwise users can receive a document
    with raw `{{EQ:...}}` placeholders or equation scripts exposed as text.
    """
    try:
        from pathlib import Path
        import shutil, tempfile

        equation_dir = (
            Path(__file__).resolve().parents[2] / "equation"
        )
        if str(equation_dir) not in sys.path:
            sys.path.insert(0, str(equation_dir))
        import hwpx_equation_tool

        src = Path(hwpx_path)
        with tempfile.NamedTemporaryFile(
            suffix=".hwpx", dir=src.parent, delete=False
        ) as tf:
            tmp_out = Path(tf.name)
        try:
            count = hwpx_equation_tool.replace_equation_placeholders(src, tmp_out)
            if count > 0:
                shutil.move(str(tmp_out), str(src))
            else:
                tmp_out.unlink()

            issues = hwpx_equation_tool.validate_hwpx_equations(src)
            if issues:
                joined = "; ".join(issues[:5])
                raise RuntimeError(f"equation validation failed: {joined}")
            if count > 0:
                print(
                    f"[hwpx-gen] equation conversion OK ({count} equations, no validation issues)",
                    file=sys.stderr,
                )
        except Exception:
            if tmp_out.exists():
                tmp_out.unlink()
            raise
    except Exception as e:
        raise RuntimeError(f"HWPX equation post-process failed: {e}") from e


def ensure_embedded_bindata_items(hwpx_path):
    """Mark every BinData manifest item as embedded.

    python-hwpx registers newly added images in Contents/content.hpf, but it
    omits Hancom's `isEmbeded="1"` attribute. Some Hangul viewers tolerate
    that; Hancom Office can treat the image file as present in the zip but not
    embedded in the document. Normalize the manifest after saving so generated
    pictures behave like the original template assets.
    """
    from pathlib import Path
    import shutil
    import tempfile
    import zipfile

    src = Path(hwpx_path)
    with zipfile.ZipFile(src, "r") as zin:
        try:
            manifest_bytes = zin.read("Contents/content.hpf")
        except KeyError:
            return

    root = etree.fromstring(manifest_bytes)
    changed = False
    for item in root.iter():
        if not item.tag.endswith("}item"):
            continue
        href = item.get("href") or ""
        if not href.startswith("BinData/"):
            continue
        if item.get("isEmbeded") != "1":
            item.set("isEmbeded", "1")
            changed = True

    if not changed:
        return

    updated = etree.tostring(root, encoding="utf-8", xml_declaration=True)
    with tempfile.NamedTemporaryFile(suffix=".hwpx", dir=src.parent, delete=False) as tf:
        tmp = Path(tf.name)
    try:
        with zipfile.ZipFile(src, "r") as zin, zipfile.ZipFile(tmp, "w") as zout:
            for entry in zin.infolist():
                if entry.filename == "Contents/content.hpf":
                    zout.writestr(entry, updated)
                else:
                    zout.writestr(entry, zin.read(entry.filename))
        shutil.move(str(tmp), str(src))
    except Exception:
        if tmp.exists():
            tmp.unlink()
        raise


def main():
    if len(sys.argv) >= 2 and sys.argv[1] != "-":
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            content = json.load(f)
    else:
        content = json.load(sys.stdin)

    doc = generate_hwpx(content)

    if len(sys.argv) >= 3:
        target = sys.argv[2]
        doc.save_to_path(target)
        _postprocess_equations(target)
        ensure_embedded_bindata_items(target)
    else:
        # stdin/stdout mode: write to a temp file so the equation tool can
        # operate on a real path, then stream the result back out.
        import tempfile, os
        with tempfile.NamedTemporaryFile(suffix=".hwpx", delete=False) as tf:
            tmp_path = tf.name
        try:
            doc.save_to_path(tmp_path)
            _postprocess_equations(tmp_path)
            ensure_embedded_bindata_items(tmp_path)
            with open(tmp_path, "rb") as f:
                sys.stdout.buffer.write(f.read())
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    main()
