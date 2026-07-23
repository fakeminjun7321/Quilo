#!/usr/bin/env python3
"""form-maker HWPX generator — 한글 양식 생성 / 종이 문서 복원.

고정 양식이 아니라 모델이 정한 범용 문서 블록(blocks[])을 그대로 렌더한다.
블록 type: heading | paragraph | table | figure | summary_box | spacer | pagebreak

문단/제목/표/사진 임베드/한컴 수식 후처리는 phys-result/hwpx-gen.py(및 그것이
재사용하는 chem-pre/hwpx-gen.py = pre)의 공통 헬퍼를 import 해서 쓴다.
"""
import importlib.util
import json
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PHYS_HWPX = HERE.parent / "phys-result" / "hwpx-gen.py"

# phys-result 모듈을 통째로 로드 — 그 안에서 chem-pre(pre) 도 함께 로드된다.
_spec = importlib.util.spec_from_file_location("phys_result_hwpx_gen", PHYS_HWPX)
phys = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(phys)

pre = phys.pre  # chem-pre/hwpx-gen.py 공통 헬퍼
HwpxDocument = phys.HwpxDocument

TABLE_WIDTH = pre.TABLE_WIDTH  # 47600 — pre.apply_page_layout 의 본문 너비에 맞춤

# heading level → (글자크기, 굵게, 들여쓰기, 위여백, 아래여백)
HEADING_STYLE = {
    1: dict(size=pre.SIZE_TITLE, bold=True, indent=0,
            sb=pre.SPACE_HEADING_LV1, sa=pre.SPACE_HEADING_LV2),
    2: dict(size=pre.SIZE_HEADING, bold=True, indent=0, sb=400, sa=200),
    3: dict(size=pre.SIZE_BODY, bold=True, indent=pre.INDENT_5MM, sb=200, sa=150),
    4: dict(size=pre.SIZE_BODY, bold=False, indent=pre.INDENT_10MM, sb=120, sa=120),
}

_NUM_RE = re.compile(r"^\s*[-+]?[\d,]+(\.\d+)?\s*%?\s*$")


def as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _align(value, default="LEFT"):
    a = str(value or "").strip().upper()
    if a in ("LEFT", "CENTER", "RIGHT", "JUSTIFY", "DISTRIBUTE"):
        return a
    return default


def _is_number(text):
    return bool(_NUM_RE.match(str(text or "")))


def _clamp_int(value, lo, hi, default):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def _font_size(blk, default):
    try:
        return _clamp_int(round(float(blk.get("font_size_pt")) * 100), 800, 3200, default)
    except (TypeError, ValueError):
        return default


def _space_value(blk, key, default):
    try:
        return _clamp_int(round(float(blk.get(key)) * 100), 0, 4800, default)
    except (TypeError, ValueError):
        return default


def _blank(target):
    """빈 문단 한 줄 — doc 본문 또는 셀(target) 어디에든."""
    try:
        phys.add_paragraph_to(target, "")
    except Exception:
        pass


def _make_no_border_fill(doc):
    """4면 테두리 없는 borderFill(컬럼 레이아웃용). doc 에 캐시."""
    cached = getattr(doc, "_fm_no_border_bf", None)
    if cached is not None:
        return cached

    def mut(bf):
        for tag in ("leftBorder", "rightBorder", "topBorder", "bottomBorder"):
            el = bf.find(f"{pre.NS_HH}{tag}")
            if el is not None:
                el.set("type", "NONE")
                el.set("width", "0.1 mm")
    nb = pre._new_border_fill(doc, mut)
    setattr(doc, "_fm_no_border_bf", nb)
    return nb


# ── 블록 렌더 ──────────────────────────────────────────────────────────────────

def add_page_break(doc):
    """빈 문단을 추가하고 <hp:p pageBreak="1"> 로 쪽 나눔."""
    para = doc.add_paragraph("")
    try:
        para.element.set("pageBreak", "1")
    except Exception:
        pass


def render_heading(doc, blk, target, keep_with_next=True):
    text = str(blk.get("text") or "").strip()
    if not text:
        return
    level = _clamp_int(blk.get("level"), 1, 4, 1)
    st = HEADING_STYLE[level]
    phys.add_para_to(
        doc, target, text,
        base_size=_font_size(blk, st["size"]), bold=bool(blk.get("bold", st["bold"])), align="LEFT",
        indent_left=st["indent"], keep_with_next=keep_with_next,
        space_before=_space_value(blk, "space_before_pt", st["sb"]),
        space_after=_space_value(blk, "space_after_pt", st["sa"]),
    )


def render_equation(doc, blk, target):
    text = str(blk.get("text") or blk.get("latex") or "").strip()
    if not text:
        return
    phys.add_para_to(
        doc, target, text,
        base_size=_font_size(blk, pre.SIZE_BODY),
        align=_align(blk.get("align"), "CENTER"),
        space_before=_space_value(blk, "space_before_pt", 80),
        space_after=_space_value(blk, "space_after_pt", 80),
    )


_EQ_KEYWORD_RE = re.compile(
    r"\b(?:over|sqrt|times|cdot|propto|leq|geq|approx|neq|pm|mp|cdots|"
    r"ldots|infty|partial|nabla|alpha|beta|gamma|delta|theta|lambda|mu|"
    r"nu|pi|rho|sigma|tau|phi|psi|omega|Delta|Gamma|Theta|Lambda|Sigma|"
    r"Phi|Omega|sum|int|lim|sin|cos|tan|log|ln|exp|right|left|hat|vec|bar|dot|"
    r"because|therefore)\b"
)


def _eq_glyphs_line(s):
    """한 줄(줄바꿈 없는) 수식의 '렌더 글리프 수' 근사. 제어 토큰(\\frac, over,
    ^, _, {} 등)을 글리프 1개로 뭉뚱그려 폭에 비례하는(약간 큰) 추정치를 얻는다."""
    s = re.sub(r"\\[a-zA-Z]+", "#", s)          # LaTeX 명령(\frac,\sqrt,\times…)→1글리프
    s = _EQ_KEYWORD_RE.sub("#", s)              # 한컴 수식 키워드→1글리프
    s = re.sub(r"[{}`^\\]", "", s)
    s = s.replace("_", "")                        # 첨자는 작아서 폭에 거의 안 보탬
    s = re.sub(r"\s+", "", s)
    return len(s)


def _eq_render_glyphs(s):
    """수식의 폭 = 가장 넓은 '줄'의 글리프 수(한컴 줄바꿈 #, LaTeX 줄바꿈 \\\\ 기준).

    수식 객체는 한 줄이면 줄바꿈/축소가 안 되는 고정폭이라 좁은 열에서 잘린다.
    줄바꿈된 수식은 폭이 '가장 긴 줄'로 결정되므로 그 최대값을 폭 산정에 쓴다."""
    s = str(s or "")
    lines = re.split(r"\s*#\s*|\\\\", s)
    return max((_eq_glyphs_line(ln) for ln in lines), default=0)


# 마커 재구성용(접두 + 본문) — 너무 넓은 수식을 줄바꿈으로 다시 쓸 때 쓴다.
_EQ_MARKER_REBUILD_RE = re.compile(r"(\{\{EQN?(?:-LATEX)?:)\s*(.*?)\}\}", re.S)


def _split_top_level_at(s, ch):
    """괄호/중괄호/대괄호 깊이 0 에서만 문자 ch 로 분할(ch 는 버림).
    `<=`,`>=`,`!=`,`==` 같은 복합 연산자의 = 는 분할하지 않는다."""
    out, depth, last, i, n = [], 0, 0, 0, len(s)
    delta = {"(": 1, "[": 1, "{": 1, ")": -1, "]": -1, "}": -1}
    while i < n:
        c = s[i]
        if c in delta:
            depth += delta[c]
        elif depth == 0 and c == ch:
            prev = s[i - 1] if i > 0 else ""
            nxt = s[i + 1] if i + 1 < n else ""
            if prev not in "<>=!" and nxt != "=":
                out.append(s[last:i])
                last = i + 1
        i += 1
    out.append(s[last:])
    return out


def _wrap_equation_script(script, is_latex, target=19):
    """너무 넓은(>target 글리프) 수식을 top-level `=` 에서 여러 줄로 나눈다.
    한컴 수식 객체는 한 줄이면 셀 폭을 넘어 잘리므로, 다단계 식을 줄바꿈해
    각 줄이 열 폭 안에 들어오게 한다. (원문 채점표도 다단계 식을 줄로 쌓는다.)"""
    s = str(script or "")
    if _eq_glyphs_line(s) <= target:
        return s
    parts = _split_top_level_at(s, "=")
    if len(parts) <= 1:
        return s  # 분할 지점 없음 — 비례폭이 최대한 넓게 잡아줌
    lines = [parts[0].strip()] + ["= " + p.strip() for p in parts[1:] if p.strip()]
    # 짧은 줄은 합쳐 과분할 방지(각 줄 ≤ target)
    merged, cur = [], ""
    for ln in lines:
        cand = (cur + " " + ln).strip() if cur else ln
        if cur and _eq_glyphs_line(cand) > target:
            merged.append(cur)
            cur = ln
        else:
            cur = cand
    if cur:
        merged.append(cur)
    sep = " \\\\ " if is_latex else " # "
    return sep.join(merged)


def _wrap_cell_equations(text, target=19):
    """셀 텍스트 안의 모든 수식 마커를 target 글리프에 맞춰 줄바꿈해 다시 쓴다."""
    def repl(m):
        prefix, body = m.group(1), m.group(2)
        is_latex = "-LATEX" in prefix.upper()
        return prefix + _wrap_equation_script(body, is_latex, target) + "}}"
    return _EQ_MARKER_REBUILD_RE.sub(repl, str(text or ""))


def _grid_placements(norm_rows, n_cols):
    """JSON 행의 셀들을 실제 그리드 열에 배치한다(rowspan 가림 추적 + colspan 소비).
    채점표처럼 colspan/rowspan 이 있으면 JSON 행 배열 길이 ≠ 열 수라, 배열 인덱스를
    그리드 열로 그대로 쓰면(=옛 row[ci]) 셀이 엉뚱한 열에 가거나 통째로 누락된다.
    반환: 행별 [(grid_col, cell, colspan, rowspan), ...] (배열 순서)."""
    n_rows = len(norm_rows)
    covered = set()  # 위 행의 rowspan 이 가린 (row, col)
    out = []
    for ri, row in enumerate(norm_rows):
        placed = []
        ci = 0
        si = 0  # JSON 행 배열 커서
        while ci < n_cols and si < len(row):
            if (ri, ci) in covered:
                ci += 1
                continue
            cell = row[si]
            si += 1
            if isinstance(cell, dict):
                colspan = _clamp_int(cell.get("colspan"), 1, n_cols - ci, 1)
                rowspan = _clamp_int(cell.get("rowspan"), 1, n_rows - ri, 1)
            else:
                colspan, rowspan = 1, 1
            placed.append((ci, cell, colspan, rowspan))
            for dr in range(rowspan):
                for dc in range(colspan):
                    if dr or dc:
                        covered.add((ri + dr, ci + dc))
            ci += colspan
        out.append(placed)
    return out


def _estimate_col_widths(headers, norm_rows, n_cols, total):
    """내용 기반 비례 열폭. 수식 든 열은 최장 수식폭을 하드 최소로,
    줄바꿈되는 텍스트 열은 상한(TEXT_CAP)을 둬, 좁은 열에 수식이 몰려 잘리는
    문제를 막는다. (균등 분할 → 채점표 같은 다열표 수식 클리핑의 원인)
    colspan>1 스팬 셀은 여러 열에 걸치므로 단일 열 폭을 제약하지 않는다."""
    COL_FLOOR = 2400        # 열 최소폭 (~0.83cm)
    TEXT_CAP = 15000        # 텍스트 열은 이 이상 '요구'하지 않음(줄바꿈됨)
    HDR_CAP = 9000          # 머리글도 줄바꿈됨
    EQ_GLYPH_W = 720        # 수식 글리프당 폭(약간 넉넉)
    KO_W, OT_W = 460, 250   # 한글/그외 글자폭

    def _cell_text(cell):
        return str(cell.get("text", "")) if isinstance(cell, dict) else str(cell or "")

    def _text_w(t):
        t = _EQ_MARKER_RE.sub("", t)            # 수식 부분 제외한 순수 텍스트
        ko = len(re.findall(r"[가-힣]", t))
        return ko * KO_W + (len(t) - ko) * OT_W

    def _eq_w(t):
        mx = 0
        for m in _EQ_MARKER_RE.finditer(t):
            mx = max(mx, _eq_render_glyphs(m.group(1)) * EQ_GLYPH_W)
        return mx

    EQ_MARGIN = 600         # 수식 양옆 셀 여백(수식이 셀 경계에 닿아 잘리지 않게)
    want = [COL_FLOOR] * n_cols
    mins = [COL_FLOOR] * n_cols

    def _accum(ci, t, cap):
        e = _eq_w(t)
        e_pad = e + EQ_MARGIN if e else 0
        want[ci] = max(want[ci], e_pad, min(_text_w(t), cap))
        mins[ci] = max(mins[ci], e_pad, COL_FLOOR)   # 수식폭(+여백)은 하드 최소

    # 머리행: 스팬 없음 → 열 인덱스 직접
    for ci in range(n_cols):
        if ci < len(headers):
            _accum(ci, _cell_text(headers[ci]), HDR_CAP)
    # 본문: 그리드 배치로 셀↔열 정확히 귀속(colspan>1 스팬 셀은 단일 열 제약 안 함)
    for placed in _grid_placements(norm_rows, n_cols):
        for (ci, cell, colspan, rowspan) in placed:
            if colspan != 1:
                continue
            _accum(ci, _cell_text(cell), TEXT_CAP)

    sw = sum(want)
    if sw <= 0:
        return [max(900, total // n_cols)] * n_cols
    if sw <= total:                              # 여유 → 비례 확대해 폭 채움
        extra = total - sw
        out = [w + extra * w // sw for w in want]
    else:                                        # 초과 → 텍스트 여유분부터 축소(수식 최소 보호)
        over = sw - total
        slack = sum(w - m for w, m in zip(want, mins))
        if slack >= over and slack > 0:
            out = [w - over * (w - m) // slack for w, m in zip(want, mins)]
        else:                                    # 최소합도 초과(불가피) → 최소 비례
            sm = sum(mins) or 1
            out = [m * total // sm for m in mins]
    out = [max(900, x) for x in out]
    diff = total - sum(out)                       # 반올림 보정 → 합=total
    out[out.index(max(out))] += diff
    return out


def render_table(doc, blk, ctx, target=None, width=TABLE_WIDTH):
    target = target or doc
    headers = blk.get("headers") if isinstance(blk.get("headers"), list) else []
    rows = blk.get("rows") if isinstance(blk.get("rows"), list) else []
    caption = str(blk.get("caption") or "").strip()
    header_fill = str(blk.get("header_fill") or pre.TABLE_HEADER_FILL)
    col_aligns = blk.get("col_aligns") if isinstance(blk.get("col_aligns"), list) else []

    norm_rows = [r if isinstance(r, list) else ([] if r is None else [r]) for r in rows]
    has_header = bool(headers)
    def _logical_width(row):
        return sum(
            _clamp_int(cell.get("colspan"), 1, 100, 1)
            if isinstance(cell, dict) else 1
            for cell in row
        )

    n_cols = max([len(headers)] + [_logical_width(r) for r in norm_rows] + [1])
    n_rows = len(norm_rows) + (1 if has_header else 0)
    if n_rows == 0 or n_cols == 0:
        return

    # 너무 넓은 수식은 줄바꿈 — 한 줄짜리 수식 객체는 좁은 셀에서 잘린다.
    # 핵심: '렌더할 최종 열폭'에 맞춰 '마지막에' 줄바꿈하면 모든 줄 ≤ 열 inner
    # 가 보장돼 구조적으로 넘침이 없다. (균등 분할 + 안 잘리는 수식 = 잘림 원인)
    headers_raw = list(headers)
    rows_raw = norm_rows
    placements = _grid_placements(rows_raw, n_cols)  # 셀↔열 매핑(줄바꿈해도 구조 불변)

    def _glyph_target(w):
        # -3 글리프 안전여유: 줄바꿈 산정은 normalize 전 script 기준인데, 수식
        # 도구가 렌더 직전 간격/기호를 넣어 ~2~3 글리프 늘어나기 때문.
        return max(8, (w - 600) // 720 - 3)

    def _wrap_all(widths):
        col_t = [_glyph_target(widths[ci]) for ci in range(n_cols)]

        def _cell_tgt(ri, k):
            # k 번째 배열 셀이 놓인 grid 열(+colspan)의 합폭 기준 글리프 target.
            if ri < len(placements) and k < len(placements[ri]):
                gc, _cell, cs, _rs = placements[ri][k]
                return _glyph_target(sum(widths[gc:gc + cs]))
            return col_t[k] if k < n_cols else 19

        h = [_wrap_cell_equations(x, col_t[ci] if ci < n_cols else 19)
             for ci, x in enumerate(headers_raw)]
        r = []
        for ri, row in enumerate(rows_raw):
            nr = []
            for k, c in enumerate(row):
                t = _cell_tgt(ri, k)
                if isinstance(c, dict):
                    cc = dict(c)
                    cc["text"] = _wrap_cell_equations(cc.get("text", ""), t)
                    nr.append(cc)
                else:
                    nr.append(_wrap_cell_equations(c, t))
            r.append(nr)
        return h, r

    # ① 원본 기준 임시폭 → ② 줄바꿈본으로 최종폭 산정(텍스트 열에 여유 환원)
    col_widths = _estimate_col_widths(headers_raw, rows_raw, n_cols, width)
    _h, _r = _wrap_all(col_widths)
    col_widths = _estimate_col_widths(_h, _r, n_cols, width)
    # ③ 최종폭에 맞춰 마지막 줄바꿈 → 렌더 (줄 ≤ 열 inner 보장)
    headers, norm_rows = _wrap_all(col_widths)
    placements = _grid_placements(norm_rows, n_cols)  # 최종 렌더용(셀=줄바꿈본)

    # 캡션은 표 위(한국어 표 캡션 관례)
    if caption:
        phys.add_para_to(
            doc, target, caption,
            base_size=pre.SIZE_CAPTION, align="LEFT", space_after=80,
        )

    solid_id = pre.make_solid_border_fill(doc)
    table = target.add_table(
        rows=n_rows, cols=n_cols, width=width, border_fill_id_ref=solid_id,
    )
    # 머리행 있는 표는 페이지를 넘을 때 머리행을 반복(채점표가 다음 장으로 이어질 때 헤더 유지).
    if has_header:
        try:
            table.element.set("repeatHeader", "1")
        except Exception:
            pass
    # col_widths 는 위에서 줄바꿈과 함께 확정됨(내용 기반 비례 열폭).
    for c in range(n_cols):
        for r in range(n_rows):
            try:
                table.cell(r, c).set_size(width=col_widths[c], height=2000)
            except Exception:
                pass

    r0 = 0
    if has_header:
        shaded_id = pre.make_shaded_border_fill(doc, fill_color=header_fill)
        for c in range(n_cols):
            cell = table.cell(0, c)
            cell.element.set("borderFillIDRef", str(shaded_id))
            pre._replace_cell_with_styled(
                doc, cell, str(headers[c]) if c < len(headers) else "",
                size=pre.SIZE_TABLE_HEADER, bold=True, align="CENTER",
                line_spacing=pre.TABLE_LINE_SPACING_PERCENT,
            )
        r0 = 1

    covered = set()
    anchors = []  # (cell, colspan, rowspan) — span 은 모든 셀 배치 후 일괄 설정
    # placements: 그리드 배치(colspan/rowspan 인식) — 옛 row[ci] 의 셀 누락/오배치 해결.
    for ri, placed in enumerate(placements):
        rr = ri + r0
        for (ci, raw, colspan, rowspan) in placed:
            if isinstance(raw, dict):
                text = str(raw.get("text", ""))
                align = raw.get("align")
                bold = bool(raw.get("bold"))
                fill = raw.get("fill")
            else:
                text, align, bold, fill = str(raw), None, False, None

            colspan = min(colspan, n_cols - ci)
            rowspan = min(rowspan, n_rows - rr)
            # span 은 아직 설정하지 않는다(설정하면 다음 table.cell() 의 grid 빌드가
            # 겹침으로 실패). 앵커만 기록하고, 루프 종료 후 일괄 설정한다.
            cell = table.cell(rr, ci)
            if colspan > 1 or rowspan > 1:
                anchors.append((cell, colspan, rowspan))
                for dr in range(rowspan):
                    for dc in range(colspan):
                        if dr or dc:
                            covered.add((rr + dr, ci + dc))

            if not align:
                if ci < len(col_aligns) and col_aligns[ci]:
                    align = col_aligns[ci]
                elif _is_number(text):
                    align = "RIGHT"
                else:
                    align = "LEFT"

            border_id = solid_id
            if fill:
                border_id = pre.make_shaded_border_fill(doc, fill_color=str(fill))
            cell.element.set("borderFillIDRef", str(border_id))
            pre._replace_cell_with_styled(
                doc, cell, text,
                size=pre.SIZE_TABLE_BODY, bold=bold, align=_align(align),
                line_spacing=pre.TABLE_LINE_SPACING_PERCENT,
            )

    # 모든 셀 배치가 끝난 뒤: 앵커에 span 설정 → 가려진 <hp:tc> 제거.
    # (순서 중요: span 먼저 설정하면 위에서 table.cell() 이 겹침으로 실패한다.)
    for cell, colspan, rowspan in anchors:
        span = cell.element.find(f"{pre.NS_HP}cellSpan")
        if span is not None:
            span.set("colSpan", str(colspan))
            span.set("rowSpan", str(rowspan))
    if covered:
        covered_str = {(str(r), str(c)) for (r, c) in covered}
        for tr in table.element.findall(f"{pre.NS_HP}tr"):
            for tc in list(tr.findall(f"{pre.NS_HP}tc")):
                ca = tc.find(f"{pre.NS_HP}cellAddr")
                if ca is not None and (ca.get("rowAddr"), ca.get("colAddr")) in covered_str:
                    tr.remove(tc)

    _blank(target)


_FIG_PREFIXED_RE = re.compile(r"^\s*(?:\[\s*)?(?:그림|그래프|사진|fig)", re.IGNORECASE)


def _figure_caption(caption, n):
    """캡션에 '[그림 N]' 접두 — 이미 그림/그래프/사진 등으로 시작하면 중복으로 안 붙인다.
    (모델이 caption 에 '그림. ...' 처럼 써서 '[그림 1] 그림. ...' 중복되던 문제 방지.)"""
    c = str(caption or "").strip()
    if not c:
        return ""
    if _FIG_PREFIXED_RE.match(c):
        return c
    return f"[그림 {n}] {c}"


def render_figure(doc, blk, ctx, target=None, width=TABLE_WIDTH):
    target = target or doc
    photos = ctx["photos"]
    fig_counter = ctx["fig_counter"]
    caption = str(blk.get("caption") or "").strip()
    idxs = blk.get("photo_indices")

    if isinstance(idxs, list) and idxs and photos:
        # 사진을 본문/단 폭에 맞춰 한 장씩 임베드한다. 2단이면 단 폭(~21000),
        # 아니면 본문 전체폭(width)을 쓴다. (공유 add_photo_blocks 는 폭 30300 고정 +
        # 캡션 '[그림 N]' 무조건 접두 버그가 있어 form-maker 에선 직접 add_picture 로 처리.)
        full_page = blk.get("full_page") is True
        try:
            width_ratio = max(0.12, min(1.0, float(blk.get("width_ratio", 1))))
        except (TypeError, ValueError):
            width_ratio = 1.0
        available = min(width, 21000) if ctx.get("two_col") else width
        fig_w = width if full_page else max(5500, int(available * width_ratio))
        fig_h = 62000 if full_page else 12000
        placed = False
        for i in as_list(idxs):
            try:
                photo = photos[int(i)]
            except (IndexError, ValueError, TypeError):
                continue
            blob = phys.decode_base64(photo.get("data_base64"))
            if not blob:
                continue
            fig_counter["value"] += 1
            cap = _figure_caption(caption, fig_counter["value"])
            phys.add_picture(
                doc, blob,
                fmt=phys.image_format(photo.get("name"), photo.get("mimetype"), blob),
                caption=cap, max_width=fig_w, max_height=fig_h, target=target,
            )
            placed = True
        if placed:
            return
        # 디코드 실패 시 아래 placeholder 로 폴백

    # 사진 없음 → 점선 빈 상자(placeholder)
    dashed_id = pre.make_dashed_border_fill(doc)
    table = target.add_table(rows=1, cols=1, width=width, border_fill_id_ref=dashed_id)
    cell = table.cell(0, 0)
    cell.element.set("borderFillIDRef", str(dashed_id))
    try:
        cell.set_size(width=width, height=7000)
    except Exception:
        pass
    note = str(blk.get("note") or "").strip()
    pre._replace_cell_with_styled(
        doc, cell, note or "［ 그림 · 사진 넣는 자리 ］",
        size=pre.SIZE_BODY, align="CENTER",
        color="#FF0000" if note else None,
        line_spacing=pre.LINE_SPACING_PERCENT,
    )
    if caption:
        fig_counter["value"] += 1
        cap = _figure_caption(caption, fig_counter["value"])
        phys.add_para_to(
            doc, target, cap,
            base_size=pre.SIZE_CAPTION, align="CENTER", space_after=pre.SPACE_BODY,
        )


def render_summary_box(doc, blk, ctx, target=None, width=TABLE_WIDTH):
    target = target or doc
    solid_id = pre.make_solid_border_fill(doc)
    table = target.add_table(rows=1, cols=1, width=width, border_fill_id_ref=solid_id)
    cell = table.cell(0, 0)
    cell.element.set("borderFillIDRef", str(solid_id))
    phys.clear_cell(cell)
    pre.set_cell_margins(cell)
    # 답란 높이 — 원문 박스 크기 반영. `lines`(원문 답란이 차지하는 빈 줄 수, 사진에서 추정)가
    # 있으면 그만큼 셀 최소 높이를 확보해 큰 답란/작은 답란이 원본처럼 다르게 보이게 한다.
    body_lines = [x for x in as_list(blk.get("body")) if x is not None and str(x).strip()]
    answer_lines = _clamp_int(blk.get("lines"), 0, 30, 0)
    if answer_lines > 0 and len(body_lines) <= 1:
        # 한 줄 ~1900 HWPUNIT(11pt×160% 행간 ≈ 실제 필기 한 줄) + 라벨/여백 보정.
        # 단, 한 답란이 페이지를 다 먹지 않게 상한(≈본문 높이 절반)을 둔다.
        box_h = answer_lines * 1900 + (900 if str(blk.get("label") or "").strip() else 300)
        box_h = min(box_h, 30000)  # ~16줄(A4 본문높이의 약 45%) 상한
        try:
            cell.set_size(width=width, height=box_h)
        except Exception:
            pass
    label = str(blk.get("label") or "").strip()
    if label:
        phys.add_para_to(
            doc, cell, label,
            base_size=pre.SIZE_HEADING, bold=True, align="CENTER", space_after=120,
        )
    for line in as_list(blk.get("body")):
        if line is None or str(line).strip() == "":
            continue
        phys.add_para_to(
            doc, cell, str(line),
            base_size=pre.SIZE_BODY, align="LEFT", space_after=pre.SPACE_BODY,
        )
    _blank(target)


def render_columns(doc, blk, ctx, target=None, width=TABLE_WIDTH):
    """여러 단(컬럼) 레이아웃 — 무테두리 1행 N열 표의 각 칸에 하위 블록을 렌더.
    ⚠ 표의 한 행은 페이지를 넘어 쪼개지지 않으므로, 한 단의 내용이 한 페이지를
    넘으면 잘리거나 빈 페이지가 생긴다. 짧은 좌우 분할에만 쓴다(긴 내용은 linearize)."""
    target = target or doc
    cols = blk.get("columns")
    if not isinstance(cols, list) or not cols:
        return
    cols = [c if isinstance(c, list) else [] if c is None else [c] for c in cols]
    n = max(1, min(len(cols), 4))
    cols = cols[:n]
    nb = _make_no_border_fill(doc)
    tbl = target.add_table(rows=1, cols=n, width=width, border_fill_id_ref=nb)
    col_width = max(int(width / n), 1200)
    inner_width = max(col_width - 360, 800)  # 셀 좌우 여백만큼 줄여 안쪽 표/박스가 안 잘리게
    for c in range(n):
        cell = tbl.cell(0, c)
        cell.element.set("borderFillIDRef", str(nb))
        try:
            cell.set_size(width=col_width)
        except Exception:
            pass
        phys.clear_cell(cell)
        pre.set_cell_margins(cell, left=160, right=160)
        render_blocks(doc, cols[c], ctx, target=cell, width=inner_width)
    _blank(target)


def _block_type(blk):
    if not isinstance(blk, dict):
        return ""
    return re.sub(r"[{}*]", "", str(blk.get("type") or "")).strip().lower()


def render_blocks(doc, blocks, ctx, target=None, width=TABLE_WIDTH):
    target = target or doc
    blocks = as_list(blocks)
    for i, blk in enumerate(blocks):
        if isinstance(blk, str):
            if blk.strip():
                phys.add_para_to(doc, target, blk, align="LEFT", space_after=pre.SPACE_BODY)
            continue
        if not isinstance(blk, dict):
            continue
        # type 은 데이터 — 혹시 표기 정리로 `summary_{box}` 처럼 첨자 마커가 끼어도 무시.
        bt = re.sub(r"[{}*]", "", str(blk.get("type") or "")).strip().lower()
        if bt == "heading":
            # 다음 블록이 키 큰 객체(표/그림/컬럼)면 keep_with_next 를 끈다 —
            # 안 그러면 한 페이지 넘는 표를 통째로 끌고 다음 장으로 가버려
            # 제목만 덩그러니 남은 빈 페이지가 생긴다.
            nxt = _block_type(blocks[i + 1]) if i + 1 < len(blocks) else ""
            keep = nxt not in ("table", "figure", "columns")
            render_heading(doc, blk, target, keep_with_next=keep)
        elif bt == "paragraph":
            text = str(blk.get("text") or "")
            if text.strip():
                if blk.get("italic"):
                    text = f"*{text}*"
                phys.add_para_to(
                    doc, target, text,
                    base_size=_font_size(blk, pre.SIZE_BODY),
                    bold=bool(blk.get("bold", False)),
                    align=_align(blk.get("align"), "LEFT"),
                    indent_left=pre.INDENT_5MM if blk.get("hanging") else 0,
                    space_before=_space_value(blk, "space_before_pt", 0),
                    space_after=_space_value(blk, "space_after_pt", pre.SPACE_BODY),
                )
        elif bt == "table":
            render_table(doc, blk, ctx, target, width=width)
        elif bt == "figure":
            render_figure(doc, blk, ctx, target, width=width)
        elif bt == "equation":
            render_equation(doc, blk, target)
        elif bt == "summary_box":
            render_summary_box(doc, blk, ctx, target, width=width)
        elif bt == "columns":
            render_columns(doc, blk, ctx, target, width=width)
        elif bt == "spacer":
            for _ in range(_clamp_int(blk.get("lines"), 1, 6, 1)):
                _blank(target)
        elif bt == "pagebreak":
            add_page_break(doc)
        else:
            text = str(blk.get("text") or "")
            if text.strip():
                phys.add_para_to(doc, target, text, align="LEFT", space_after=pre.SPACE_BODY)


# ── 표지 / 머리말 ──────────────────────────────────────────────────────────────

def build_title(doc, content):
    # 원본에 큰 제목이 없으면 만들지 않는다 — 머리말을 가짜 표지 제목으로 승격하지 않기 위함(P8).
    title = str(content.get("title") or "").strip()
    if not title:
        return
    size = content.get("title_size")
    try:
        size_pt = _clamp_int(float(size) * 100, 800, 4000, pre.SIZE_TITLE_BIG) if size else pre.SIZE_TITLE_BIG
    except (TypeError, ValueError):
        size_pt = pre.SIZE_TITLE_BIG
    phys.add_para_to(
        doc, doc, title,
        base_size=size_pt, bold=True, align="CENTER",
        space_before=200, space_after=pre.SPACE_HEADING_LV1,
    )


def build_meta(doc, content):
    meta = content.get("meta")
    if not isinstance(meta, dict):
        return
    field = str(meta.get("field") or "").strip()
    if field:
        phys.add_para_to(doc, doc, field, base_size=pre.SIZE_BODY, align="RIGHT", space_after=80)
    for author in as_list(meta.get("authors")):
        if str(author).strip():
            phys.add_para_to(doc, doc, str(author), base_size=pre.SIZE_BODY, align="RIGHT", space_after=60)
    advisor = str(meta.get("advisor") or "").strip()
    if advisor:
        phys.add_para_to(doc, doc, advisor, base_size=pre.SIZE_BODY, align="RIGHT", space_after=pre.SPACE_HEADING_LV1)
    keywords = meta.get("keywords")
    if isinstance(keywords, list) and keywords:
        line = "연구 핵심 키워드: " + ", ".join(str(k) for k in keywords if str(k).strip())
        phys.add_para_to(doc, doc, line, base_size=pre.SIZE_BODY, align="LEFT", space_after=pre.SPACE_BODY)


# ── 문서 빌드 ─────────────────────────────────────────────────────────────────

def generate_hwpx(content):
    doc = HwpxDocument.new()
    doc._v5_allow_highlights = bool(content.get("__allowHighlights", True))
    pre.apply_page_layout(doc)
    pre.apply_default_font(doc, pre.resolve_font_face(content))
    ctx = {
        "photos": as_list(content.get("__photos")),
        "fig_counter": {"value": 0},
        "two_col": str(content.get("__layoutMode") or "").strip().lower() == "layout",
    }
    build_title(doc, content)
    build_meta(doc, content)
    render_blocks(doc, content.get("blocks"), ctx)
    return doc


# ── 미리보기 텍스트 ────────────────────────────────────────────────────────────

_EQ_MARKER_RE = re.compile(r"\{\{EQN?(?:-LATEX)?:\s*(.*?)\}\}", re.S)


def _clean_preview(text):
    s = str(text or "")
    s = _EQ_MARKER_RE.sub(lambda m: m.group(1), s)
    s = s.replace("_{", "").replace("^{", "").replace("{", "").replace("}", "")
    s = s.replace("**", "").replace("*", "")
    return s.strip()


def _preview_blocks(blocks, lines):
    for blk in as_list(blocks):
        if isinstance(blk, str):
            if blk.strip():
                lines.append(_clean_preview(blk))
        elif isinstance(blk, dict):
            bt = re.sub(r"[{}*]", "", str(blk.get("type") or "")).lower()
            if bt in ("heading", "paragraph", "equation"):
                if blk.get("text"):
                    lines.append(_clean_preview(blk["text"]))
            elif bt == "summary_box":
                if blk.get("label"):
                    lines.append(_clean_preview(blk["label"]))
                for b in as_list(blk.get("body")):
                    if str(b).strip():
                        lines.append(_clean_preview(b))
            elif bt in ("table", "figure"):
                if blk.get("caption"):
                    lines.append(_clean_preview(blk["caption"]))
            elif bt == "columns":
                for col in as_list(blk.get("columns")):
                    _preview_blocks(col, lines)


def collect_preview_text(content):
    lines = [] if content.get("__hideTitle") is True else [str(content.get("title") or "문서"), ""]
    meta = content.get("meta")
    if isinstance(meta, dict):
        if meta.get("field"):
            lines.append(_clean_preview(meta["field"]))
        for author in as_list(meta.get("authors")):
            if str(author).strip():
                lines.append(_clean_preview(author))
        if meta.get("advisor"):
            lines.append(_clean_preview(meta["advisor"]))
        lines.append("")
    _preview_blocks(content.get("blocks"), lines)
    return "\r\n".join(str(x) for x in lines).strip()[:8000] + "\r\n"


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


def set_two_column_layout(hwpx_path):
    """section 의 colPr colCount 를 2 로 패치 — 한글의 진짜 신문식 2단.
    원문 2단 시험지처럼 내용이 1단→2단→다음장으로 자연스럽게 흐르고 페이지 넘김도
    정상이라 빈 페이지가 생기지 않는다. 넓은 표(채점기준표 등)는 양단을 가로질러 전체폭으로
    스팬되고, 좁은 질문·답란은 단 안에 흐른다(한글 기본 동작)."""
    src = Path(hwpx_path)
    with tempfile.NamedTemporaryFile(suffix=".hwpx", dir=src.parent, delete=False) as tf:
        tmp = Path(tf.name)
    try:
        with zipfile.ZipFile(src, "r") as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                if re.match(r"Contents/section\d+\.xml$", item.filename):
                    text = data.decode("utf-8")
                    text = re.sub(
                        r'(<hp:colPr\b[^>]*?\bcolCount=")\d+(")',
                        r"\g<1>2\g<2>", text,
                    )
                    data = text.encode("utf-8")
                zout.writestr(item, data)
        shutil.move(str(tmp), str(src))
    except Exception:
        if tmp.exists():
            tmp.unlink()
        raise


def main():
    if len(sys.argv) >= 2 and sys.argv[1] != "-":
        content = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    else:
        content = json.loads(sys.stdin.read())

    content = pre._deep_clean_xml(content)
    doc = generate_hwpx(content)
    two_col = str(content.get("__layoutMode") or "").strip().lower() == "layout"

    if len(sys.argv) >= 3:
        target = Path(sys.argv[2])
        doc.save_to_path(str(target))
        pre._postprocess_equations(target)
        pre.ensure_embedded_bindata_items(target)
        update_preview_text(target, collect_preview_text(content))
        if two_col:
            set_two_column_layout(target)
    else:
        import os
        with tempfile.NamedTemporaryFile(suffix=".hwpx", delete=False) as tf:
            tmp_path = Path(tf.name)
        try:
            doc.save_to_path(str(tmp_path))
            pre._postprocess_equations(tmp_path)
            pre.ensure_embedded_bindata_items(tmp_path)
            update_preview_text(tmp_path, collect_preview_text(content))
            if two_col:
                set_two_column_layout(tmp_path)
            sys.stdout.buffer.write(tmp_path.read_bytes())
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    main()
