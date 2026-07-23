#!/usr/bin/env python3
"""PDF 통번역기 — 레이아웃/그림은 유지하고 텍스트만 교체한다.

DeepL 문서 번역과 같은 방식: 디지털 PDF(텍스트 레이어가 있는 PDF)에서 문단
단위로 텍스트를 추출하고, 같은 위치(bounding box)에 번역문을 다시 끼워넣는다.
그림·도표·벡터 그래픽은 손대지 않으므로 그대로 보존된다.

두 가지 모드로 동작한다 (Node가 두 번 spawn 한다):

  python translate_pdf.py extract <pdf_path>
      → stdout JSON: {"page_count": N, "scanned": bool,
                      "blocks": [{"id": int|str, "page": int|null,
                                  "text": str, "kind": str?}, ...]}
      번역이 필요한 문단과 reader UI(목차/문서정보) 문자열을 내보낸다.

  python translate_pdf.py render <pdf_path> <out_path> <font_path>
      ← stdin JSON: {"translations": {"<id>": "<korean text>", ...}}
      → out_path 에 번역된 PDF 저장
      → stdout JSON: {"ok": bool, "replaced": int,
                      "preserved_original": int,
                      "preserved_original_ids": [id, ...], "shrunk": int,
                      "overflow": int, "failed": int,
                      "overflow_ids": [id, ...], "failed_ids": [id, ...],
                      "min_font": float|null, "min_glyph_font": float|null}

페이지 블록 id는 두 모드에서 같은 get_text 순서로 매겨지고, 목차/문서정보는
충돌하지 않는 deterministic string id를 쓴다. render가 같은 id를 재계산해 매칭한다.
"""

import sys
import os
import re
import json
import math
import html
import copy
import hashlib
import io
from collections import Counter, defaultdict


def _isolate_stdout_for_json_protocol():
    """Keep fd 1 reserved for intentional JSON replies only.

    PyMuPDF/MuPDF can write diagnostics at the native fd level. Save the original
    stdout pipe for JSON responses, then redirect process stdout to stderr so any
    accidental/native stdout noise stays diagnostic and cannot corrupt the protocol.
    """
    saved_fd = None
    try:
        try:
            sys.stdout.flush()
        except Exception:
            pass
        saved_fd = os.dup(1)
        os.dup2(2, 1)
        return saved_fd
    except Exception:
        if saved_fd is not None:
            try:
                os.close(saved_fd)
            except Exception:
                pass
        return None


_JSON_STDOUT_FD = _isolate_stdout_for_json_protocol()

import fitz  # PyMuPDF
from lxml import etree


SAFE_PIXMAP_MAX_DIMENSION = 4096
SAFE_PIXMAP_MAX_AREA = 12_000_000


def _predicted_pixmap_geometry(rect, zoom=1.0):
    """Return bounded pre-allocation geometry for an untrusted page/clip."""

    rect = fitz.Rect(rect)
    width = abs(float(rect.width))
    height = abs(float(rect.height))
    zoom = float(zoom)
    if (
        not math.isfinite(width)
        or not math.isfinite(height)
        or not math.isfinite(zoom)
        or width <= 0
        or height <= 0
        or zoom <= 0
    ):
        raise ValueError("invalid pixmap geometry")
    pixel_width = max(1, math.ceil(width * zoom))
    pixel_height = max(1, math.ceil(height * zoom))
    pixel_area = pixel_width * pixel_height
    return pixel_width, pixel_height, pixel_area


def _pixmap_geometry_is_safe(rect, zoom=1.0):
    try:
        width, height, area = _predicted_pixmap_geometry(rect, zoom)
    except (TypeError, ValueError, OverflowError):
        return False
    return (
        width <= SAFE_PIXMAP_MAX_DIMENSION
        and height <= SAFE_PIXMAP_MAX_DIMENSION
        and area <= SAFE_PIXMAP_MAX_AREA
    )


def _assert_safe_pixmap_geometry(rect, zoom=1.0, context="pixmap"):
    if not _pixmap_geometry_is_safe(rect, zoom):
        raise ValueError(f"{context} exceeds the safe pixmap geometry budget")


def _page_text_rect(page):
    """Return the coordinate rectangle used by ``Page.get_text``.

    PyMuPDF exposes ``page.rect`` in the *rotated* display coordinate system, but
    text / drawing dictionaries use an unrotated CropBox-relative system.  On a
    90-degree page this means ``page.rect.width`` is the text-space height.  Layout
    bounds based on it can therefore cross a column or even the physical CropBox.
    CropBox width / height are stable for every rotation and text coordinates start
    at (0, 0), even when the PDF CropBox itself has a non-zero origin.
    """
    try:
        crop = fitz.Rect(page.cropbox)
        width = abs(float(crop.width))
        height = abs(float(crop.height))
        if width > 0 and height > 0:
            return fitz.Rect(0.0, 0.0, width, height)
    except Exception:
        pass
    rect = fitz.Rect(page.rect)
    if int(getattr(page, "rotation", 0) or 0) % 180:
        return fitz.Rect(0.0, 0.0, rect.height, rect.width)
    return fitz.Rect(0.0, 0.0, rect.width, rect.height)


def _disable_mupdf_diagnostics():
    tools = getattr(fitz, "TOOLS", None)
    if tools is None:
        return
    for name in ("mupdf_display_warnings", "mupdf_display_errors"):
        fn = getattr(tools, name, None)
        if not callable(fn):
            continue
        try:
            fn(False)
        except TypeError:
            try:
                fn(0)
            except Exception:
                pass
        except Exception:
            pass


_disable_mupdf_diagnostics()


def write_json_response(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    if _JSON_STDOUT_FD is None:
        sys.stdout.write(data.decode("utf-8"))
        sys.stdout.flush()
        return
    offset = 0
    while offset < len(data):
        offset += os.write(_JSON_STDOUT_FD, data[offset:])


def _clean_ko(s):
    """모델 번역 출력 정리 — HTML 엔티티 복원(&gt;→>, &lt;→<, &amp;→&, &#176;→°).
    모델이 분수/부등호를 '±h&gt;2π'처럼 엔티티로 내보내 raw 로 보이던 문제 수정."""
    s = str(s)
    if "&" in s:
        try:
            s = html.unescape(s)
        except Exception:
            pass
    # U+00A0 / U+202F를 그대로 넣으면 MuPDF가 U+0020 공백을 NBSP로 역매핑하는
    # ToUnicode CMap을 만들 수 있다. 검색·복사·pypdf 추출이 모두 같은 일반 공백을
    # 보도록 모델 출력의 no-break space를 렌더 전에 정규화한다.
    s = s.replace("\u00a0", " ").replace("\u202f", " ")
    return s


# Unicode's Alphabetic Presentation Forms are compatibility glyphs, not semantic
# spelling.  Translation models sometimes copy one from a source credit line
# (``Astro\ufb01zitsheskaya``), while our bundled Korean fonts intentionally do not
# expose those legacy cmap entries.  Apply this deliberately tiny mapping only to
# text which will be redrawn.  Do not use NFKC here: broad compatibility
# normalization would also rewrite scientific symbols, units and formula glyphs.
_LATIN_PRESENTATION_LIGATURES = str.maketrans(
    {
        "\ufb00": "ff",
        "\ufb01": "fi",
        "\ufb02": "fl",
        "\ufb03": "ffi",
        "\ufb04": "ffl",
        "\ufb05": "st",
        "\ufb06": "st",
    }
)


def _normalize_redrawn_latin_ligatures(value):
    """Expand only U+FB00..U+FB06 in translated text headed to the renderer."""
    return str(value).translate(_LATIN_PRESENTATION_LIGATURES)


def _first_span(block):
    for ln in block.get("lines", []):
        for sp in ln.get("spans", []):
            if sp.get("text", "").strip():
                return sp
    return None


def _block_raw_text(block):
    return "".join(
        sp.get("text", "")
        for ln in block.get("lines", [])
        for sp in ln.get("spans", [])
    )


def _absorb_tiny_fragments(blocks):
    """별도 블록으로 떨어진 작은 첨자 조각(이온의 아래첨자 '2', 전하 '+/−' 등)을,
    그 조각이 공간적으로 속한 host 블록의 해당 줄에 **x-위치 순서로 끼워넣는다**.

    예: 제목 'H₂⁺' 가 PyMuPDF 에서 'H'(+위첨자 ⁺) 와 별도의 '2'(아래첨자) 블록으로
    쪼개져 제목이 'H⁺' 로 나오던 것을, '2' 를 H 와 ⁺ 사이에 삽입해 'H2⁺' 로 복원."""
    frags, out = [], []
    for b in blocks:
        txt = _block_raw_text(b).strip()
        sp = _first_span(b)
        is_frag = bool(
            sp
            and 0 < len(txt) <= 3
            # Paragraph engines commonly render a 13pt formula's charge at 11pt.
            # The old absolute <9pt rule therefore dropped a separately encoded
            # SO4 charge even though it was a normal superscript.  The host-relative
            # size check below is the decisive guard; this ceiling only prevents a
            # large standalone page number from becoming a fragment candidate.
            and (sp.get("size", 99) or 99) < 14.0
            and all(c.isdigit() or c in "+-−" for c in txt)
        )
        (frags if is_frag else out).append(b)
    if not frags:
        return blocks
    for frag in frags:
        fr = fitz.Rect(frag["bbox"])
        fcx, fcy = (fr.x0 + fr.x1) / 2, (fr.y0 + fr.y1) / 2
        frag_size = float((_first_span(frag) or {}).get("size", 99) or 99)
        host_candidates = []
        for h in out:
            hr = fitz.Rect(h["bbox"])
            host_size = float(dominant_size_color(h)[0] or 0.0)
            if (
                host_size >= frag_size * 1.05
                and hr.y0 - 3 <= fcy <= hr.y1 + 3
                and hr.x0 - 8 <= fcx <= hr.x1 + 8
            ):
                horizontal_gap = max(0.0, hr.x0 - fcx, fcx - hr.x1)
                vertical_gap = max(0.0, hr.y0 - fcy, fcy - hr.y1)
                host_candidates.append((horizontal_gap + vertical_gap, hr.x1, h))
        host = (
            min(host_candidates, key=lambda item: (item[0], item[1]))[2]
            if host_candidates
            else None
        )
        if host is None:
            out.append(frag)  # 맞는 host 없으면 독립 블록으로 유지
            continue
        line = None
        for ln in host.get("lines", []):
            lr = fitz.Rect(ln["bbox"])
            if lr.y0 - 3 <= fcy <= lr.y1 + 3:
                line = ln
                break
        if line is None:
            out.append(frag)
            continue
        is_digit = all(c.isdigit() for c in _block_raw_text(frag).strip())
        for original_span in [
            s for fl in frag.get("lines", []) for s in fl.get("spans", [])
        ]:
            # Keep an explicit provenance bit so tag=True can preserve the rise even
            # when the fragment is only ~15% smaller than its 13pt host.
            fsp = copy.deepcopy(original_span)
            fsp["_absorbed_tiny_fragment"] = True
            fbox = fsp.get("bbox") or [fcx, fcy, fcx, fcy]
            fx, fy0 = fbox[0], fbox[1]
            spans = line.setdefault("spans", [])
            # 기본은 x-순서. 단 아래첨자 숫자(이온의 '2')는 거의 같은 x 에 겹쳐 쌓인
            # 위첨자(전하 '+', 더 작고 더 높은 span) '앞'에 와야 한다(H₂⁺ = H, 2, +).
            pos = len(spans)
            for k, s in enumerate(spans):
                sbox = s.get("bbox") or [1e9, 0, 0, 0]
                sx, sy0 = sbox[0], sbox[1]
                super_near = (
                    is_digit
                    and (s.get("size", 99) or 99) < 9
                    and sy0 < fy0 - 1
                    and abs(sx - fx) < 15
                )
                if super_near or sx > fx:
                    pos = k
                    break
            spans.insert(pos, fsp)
            # ``_nonfig_rect`` and the redaction pass intentionally derive their
            # geometry from line bboxes rather than the block union.  Extend the
            # host line as well, otherwise the absorbed charge is present in the
            # translation payload but remains just outside the redaction rectangle
            # and survives as a duplicated, content-order-first source glyph.
            line["bbox"] = list(fitz.Rect(line.get("bbox") or host["bbox"]) | fitz.Rect(fbox))
        host["bbox"] = list(fitz.Rect(host["bbox"]) | fr)
    return out


def _split_spatially_separated_runs(block, page_width):
    """Split a MuPDF text block when it actually contains distant columns.

    MuPDF can group independently positioned header / footer strings into one
    block when their baselines overlap.  Joining that block produces text such
    as ``left titleRIGHT ID`` and rendering it back into the union bbox moves
    both strings to the left.  The same symptom occurs when one PDF text line
    contains distant spans separated by a tab-like gap.

    This splitter is deliberately conservative:

    * it only considers a gap on vertically overlapping runs (the same visual
      row),
    * the gap must be large both absolutely and relative to the page width, and
    * the proposed vertical divider must not cut through any other run in the
      block.

    Consequently wrapped prose remains one block because its long lines cross
    any candidate divider, while genuinely independent left/right runs receive
    separate ids and bboxes in both extract and render.
    """
    lines = block.get("lines") or []
    if len(lines) < 2 and not any(len(line.get("spans") or []) > 1 for line in lines):
        return [block]

    min_gap = max(48.0, 0.12 * max(float(page_width or 0.0), 1.0))
    fragments = []
    for line_index, line in enumerate(lines):
        spans = sorted(
            (copy.deepcopy(span) for span in (line.get("spans") or [])),
            key=lambda span: (span.get("bbox") or (0, 0, 0, 0))[0],
        )
        if not spans:
            continue
        groups = [[spans[0]]]
        for span in spans[1:]:
            prev_box = groups[-1][-1].get("bbox") or (0, 0, 0, 0)
            box = span.get("bbox") or (0, 0, 0, 0)
            font_gap = 4.0 * max(
                float(groups[-1][-1].get("size", 0) or 0),
                float(span.get("size", 0) or 0),
                1.0,
            )
            if box[0] - prev_box[2] >= max(min_gap, font_gap):
                groups.append([span])
            else:
                groups[-1].append(span)
        for group_index, group in enumerate(groups):
            rect = None
            for span in group:
                sr = fitz.Rect(span.get("bbox") or line.get("bbox") or (0, 0, 0, 0))
                rect = sr if rect is None else (rect | sr)
            if rect is None or rect.is_empty:
                continue
            fragment_line = copy.deepcopy(line)
            fragment_line["spans"] = group
            fragment_line["bbox"] = tuple(rect)
            fragments.append(
                {
                    "line": fragment_line,
                    "rect": rect,
                    "order": (line_index, group_index),
                }
            )

    if len(fragments) < 2:
        return [block]

    def candidate_dividers(group):
        candidates = []
        for index, left_item in enumerate(group):
            left_rect = left_item["rect"]
            for right_item in group[index + 1 :]:
                right_rect = right_item["rect"]
                first, second = (
                    (left_rect, right_rect)
                    if left_rect.x0 <= right_rect.x0
                    else (right_rect, left_rect)
                )
                overlap_y = min(first.y1, second.y1) - max(first.y0, second.y0)
                min_height = max(1.0, min(first.height, second.height))
                gap = second.x0 - first.x1
                if overlap_y >= 0.45 * min_height and gap >= min_gap:
                    candidates.append((gap, (first.x1 + second.x0) / 2.0))
        return sorted(candidates, reverse=True)

    def split_group(group):
        for _gap, divider in candidate_dividers(group):
            left = [item for item in group if item["rect"].x1 <= divider]
            right = [item for item in group if item["rect"].x0 >= divider]
            crossing = [
                item
                for item in group
                if item not in left and item not in right
            ]
            if left and right and not crossing:
                return split_group(left) + split_group(right)
        return [group]

    groups = split_group(fragments)
    if len(groups) == 1:
        return [block]

    separated = []
    for group in groups:
        ordered = sorted(group, key=lambda item: item["order"])
        rect = ordered[0]["rect"]
        for item in ordered[1:]:
            rect = rect | item["rect"]
        new_block = copy.deepcopy(block)
        new_block["lines"] = [item["line"] for item in ordered]
        new_block["bbox"] = tuple(rect)
        separated.append((min(item["order"] for item in ordered), rect.x0, new_block))
    separated.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in separated]


def _has_word(block):
    """블록의 '본문 크기'(가장 큰 span 의 0.8배+) span 에 영문 3글자+ 단어 또는 한글이
    있는지 = 진짜 산문/문장 연속본문.

    핵심: 작은 위·아래첨자 라벨(ψ_g^bond 의 'bond', ψ_VB^cl 의 'VB'·'cl' 등)은 본문
    단어로 치지 않는다 → 라벨 달린 표시수식이 '단어 있음'으로 오인되어 번역·흩어지지
    않게 한다. 흩어진 수식 글자(R/V/V 각각 별도 span)도 단어가 아니다(span 내 연속만)."""
    sizes = [
        sp.get("size", 0) or 0
        for ln in block.get("lines", [])
        for sp in ln.get("spans", [])
        if sp.get("text", "").strip()
    ]
    if not sizes:
        return False
    body = 0.8 * max(sizes)
    for ln in block.get("lines", []):
        for sp in ln.get("spans", []):
            if (sp.get("size", 0) or 0) >= body:
                t = sp.get("text", "")
                if re.search(r"[A-Za-z]{3,}", t) or re.search(r"[가-힣]", t):
                    return True
    return False


def _merge_superscript_ions(blocks):
    """위/아래첨자(이온 전하 +/−, 반결합 *, 분자 첨자 2·A·B·e·n 등)가 별도 블록으로
    떨어져 나오면서 '뒤 문단/캡션 전체'를 끌고 가, 앞 블록과 세로로 겹치는 경우 병합한다.

    PyMuPDF 는 H₂⁺·rA·1σu* 같은 첨자에서 블록을 쪼개고, 그 조각 블록의 bbox 가 앞
    문단 중간(겹침)에서 시작한다. 번역하면 짧아진 한국어가 위에서 끝나고 조각 블록은
    원래 위치에서 그려져 **문단 사이 큰 세로 빈칸 + 문장 두 동강 + 뒷부분 영어 잔존**이
    생긴다. 두 블록을 합쳐 한 문단으로 번역·렌더하면 자연스럽게 흐른다.

    판정: 조각의 첫 span 이 작고(위/아래첨자) 앞과 세로 겹치며, 조각에 '단어'가 있어
    문단 연속본문일 때만 병합한다(단어 없는 짧은 수식 조각은 band 가 원본유지)."""
    out = []
    for blk in blocks:
        sp = _first_span(blk)
        if out and sp and _has_word(blk):
            # A caption below a neighbouring-column figure can overlap the full
            # height of the preceding body paragraph and its 8.5 pt font sits
            # exactly on this helper's host-relative superscript threshold.  It
            # is still an independent reading-order object: merging it into the
            # 10 pt paragraph makes every caption row look like a giant
            # sub/superscript and splices its formula spans across the body.  A
            # leading Fig./Figure/Table marker is stronger evidence than the
            # generic small-first-span geometry, so never absorb such a block.
            if _caption_head_text(blk):
                out.append(blk)
                continue
            prev_sz = dominant_size_color(out[-1])[0] or 10.0
            frag_sz = dominant_size_color(blk)[0] or 10.0
            small = (sp.get("size", 99) or 99) < 0.85 * prev_sz  # 첫 span=위/아래첨자
            # 조각 본문이 본문 크기여야(첫 글자만 작은 첨자) — 전체가 작은 각주/캡션
            # 블록(예: 6pt 각주)을 본문에 잘못 병합하지 않게 한다.
            body_frag = frag_sz >= 0.85 * prev_sz
            if small and body_frag:
                ra = fitz.Rect(out[-1]["bbox"])
                rb = fitz.Rect(blk["bbox"])
                oy = min(ra.y1, rb.y1) - max(ra.y0, rb.y0)  # 세로 겹침(첨자가 본문에 끼임)
                ox = min(ra.x1, rb.x1) - max(ra.x0, rb.x0)  # 같은 단(가로 겹침)
                # (1) 세로 겹침 병합: 첨자가 본문 중간으로 끌려 내려가 앞 문단과 세로로
                #     겹치는 경우(H₂⁺·rA 등).
                vert = oy > 2 and ox > 0.3 * min(ra.width, rb.width)
                # (2) 같은 줄 오른쪽 연속 병합: 인라인 수식(ψ_MO^cov_el 등)이 한 줄을
                #     쪼개, 그 뒤를 잇는 본문 조각이 '앞 블록과 같은 줄, 그 가로 범위
                #     안~바로 오른쪽'에서 시작하는 경우. 이걸 합치지 않으면 dedoverlap 이
                #     큰 문단 조각을 첫 줄로 잘라(redaction 축소) 뒷부분이 영어로 남는다.
                #     가드: 첫 span 이 작은 첨자(small) + 본문 단어/크기 + 같은 줄(세로
                #     거의 완전 겹침) + 새 단/먼 오른쪽이 아님 → 인라인수식 연속만 잡는다.
                line_h = min(ra.height, rb.height)
                same_line = line_h > 0 and oy > 0.55 * line_h
                right_cont = (ra.x0 - 2) <= rb.x0 <= (ra.x1 + 24)
                if vert or (same_line and right_cont):
                    out[-1]["lines"] = out[-1].get("lines", []) + blk.get("lines", [])
                    out[-1]["bbox"] = [
                        min(ra.x0, rb.x0), min(ra.y0, rb.y0),
                        max(ra.x1, rb.x1), max(ra.y1, rb.y1),
                    ]
                    continue
        out.append(blk)
    return out


# 종결부호 = 문장 끝(이걸로 끝나면 문단 경계로 보고 병합 안 함). ':' ';' 는 제외 —
# 제목 'X: Y' 가 두 줄(블록)로 쪼개졌을 때, 콜론 때문에 병합이 막혀 둘째 줄이 따로
# (가운데로) 떠 제목이 두 동강 나던 문제(6.5 '동핵 이원자 분자:' / '제2주기 원자') 수정.
_SENT_TERMINATORS = ".?!。．？！…"


def _ends_midsentence(txt):
    """블록 텍스트가 '문장 중간에서' 끊겼는지 = 종결부호로 끝나지 않았는지.
    종결부호(. ? ! : ; 및 전각형)로 끝나면 완결된 문단/문장 단위로 본다(병합 안 함)."""
    t = (txt or "").rstrip().rstrip(" ").rstrip()
    if not t:
        return False
    return t[-1] not in _SENT_TERMINATORS


def _formula_dense_block(block):
    """Return whether a visual block must retain its own equation-row anchor.

    Equation rows are often emitted as separate PDF paragraphs without terminal
    punctuation.  Treating them as wrapped prose collapses multiple equations into
    one translation box and changes both formula token boundaries and visual y
    anchors.  Operators plus baseline-shifted numeric spans are conservative signals
    that do not classify ordinary slash-containing prose as formula content.
    """
    raw = _block_raw_text(block)
    if re.search(r"(?:<=>|<->|->|<-|=>|<=|>=|=)", raw) or _MATH_SIGN.search(raw):
        return True
    spans = [
        span
        for line in block.get("lines", [])
        for span in line.get("spans", [])
        if str(span.get("text", "")).strip()
    ]
    if len(spans) < 2 or not re.search(r"\d", raw):
        return False
    sizes = [float(span.get("size", 0) or 0) for span in spans]
    largest = max(sizes, default=0.0)
    if largest <= 0:
        return False
    return any(
        size < 0.92 * largest
        and re.search(r"[0-9+\-−]", str(span.get("text", "")))
        for span, size in zip(spans, sizes)
    )


_GLUED_MATH_FUNCTIONS = (
    "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
    "sin", "cos", "tan", "cot", "sec", "csc", "log", "exp", "lim",
    "min", "max", "mod", "ln",
)
_FORMULA_LITERAL_WORDS = {
    "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos",
    "arctan", "sinh", "cosh", "tanh", "log", "ln", "exp", "lim",
    "min", "max", "mod", "rad", "sr", "hz", "khz", "mhz", "ghz",
    "cm", "mm", "km", "nm", "pm", "kg", "mg", "mol", "ml", "ms",
    "ns", "au", "ly", "pc", "kpc", "mpc",
}
_FORMULA_PROSE_STOPWORDS = {
    "and", "are", "at", "for", "from", "if", "is", "of", "or", "that", "the",
    "then", "this", "to", "when", "where", "which", "with",
}
_FORMULA_LEADING_PROSE_FRAGMENT_RE = re.compile(
    r"^\s*(?:be|by|in)(?=\s)"
)
_FORMULA_TRAILING_SPLIT_WORD_RE = re.compile(r"[A-Za-z]{2,}-$")


def _starts_with_math_function(value):
    return next((name for name in _GLUED_MATH_FUNCTIONS if value.startswith(name)), None)


def _looks_like_glued_math_identifier(token):
    raw = str(token or "")
    if not raw:
        return False
    # An uppercase prefix can be a one-letter variable glued directly to a
    # complete function name (``Asin``, ``Xcos``, ``Dcosh``).  Do not feed it
    # through the permissive lowercase suffix parser below: ordinary prose such
    # as ``Using``, ``Cost``, ``Sine`` and ``Aside`` otherwise looks like a
    # variable followed by ``sin`` / ``cos`` plus an allowed trailing variable.
    if raw[:1].isupper():
        return raw[1:].lower() in _GLUED_MATH_FUNCTIONS
    value = raw.lower()
    function_count = 0
    if not _starts_with_math_function(value):
        if (
            len(raw) > 4
            or len(value) < 2
            or not _starts_with_math_function(value[1:])
        ):
            return False
        value = value[1:]
    while value:
        function = _starts_with_math_function(value)
        if not function:
            return False
        function_count += 1
        value = value[len(function):]
        if not value:
            return True
        if _starts_with_math_function(value):
            continue
        if len(value) >= 2 and _starts_with_math_function(value[1:]):
            value = value[1:]
            continue
        maximum_variables = 2 if function_count >= 2 else 1
        return len(value) <= maximum_variables
    return function_count > 0


def _formula_only_visible_text(text):
    """Match the response layer's narrow formula-only direct-reuse contract."""
    value = str(text or "").strip()
    if (
        not value
        or _FORMULA_LEADING_PROSE_FRAGMENT_RE.search(value)
        or not re.search(
            r"[=+*/^<>±×÷√∞∫∑∏∂∇≤≥≈≠≡−→←↔⇌Α-Ωα-ωϑϕϱ϶ϰ′″°]|</?(?:sub|sup)>",
            value,
            re.I,
        )
    ):
        return False
    tokens = re.findall(r"[A-Za-z]+(?:-[A-Za-z]+)*", value)
    if not tokens:
        return True
    for raw in tokens:
        lowered = raw.lower()
        if (
            lowered in _FORMULA_LITERAL_WORDS
            or len(raw) == 1
            or raw == raw.upper()
            or _looks_like_glued_math_identifier(raw)
            or (
                raw == raw.lower()
                and len(raw) <= 3
                and lowered not in _FORMULA_PROSE_STOPWORDS
            )
        ):
            continue
        return False
    return True


def _raw_line_text(line):
    return "".join(
        str(span.get("text", ""))
        for span in line.get("spans", [])
    ).strip()


def _formula_word_is_literal(raw):
    value = str(raw or "")
    lowered = value.lower()
    # Reject prose words before the intentionally permissive one/two-letter
    # variable rule.  This keeps a run-in such as ``at r=R/2) Using ...`` in its
    # surrounding prose block instead of preserving its first physical row as a
    # display equation.
    if value == lowered and lowered in _FORMULA_PROSE_STOPWORDS:
        return False
    return bool(
        lowered in _FORMULA_LITERAL_WORDS
        or len(value) <= 2
        or value == value.upper()
        or _looks_like_glued_math_identifier(value)
    )


def _line_is_display_formula(line):
    """Conservatively identify a standalone equation row inside a mixed block.

    The decision deliberately uses raw span text and font names, not the active
    page decoder, so extract and render split the same physical rows even if the
    source PDF has a damaged ToUnicode map.  A row containing ordinary prose is
    never split; inline equations therefore stay with their sentence.
    """
    raw = _raw_line_text(line)
    if not raw:
        return False
    # Real textbook prose fragments can be typographically formula-dense because
    # a Greek symbol / equals sign follows a two-letter word.  Only reject the
    # unambiguous lowercase word at the beginning of a physical row; expressions
    # such as ``x=by`` (b*y), ``Be + He`` and ``In+x`` remain valid equations.
    if (
        _FORMULA_LEADING_PROSE_FRAGMENT_RE.search(raw)
        or _FORMULA_TRAILING_SPLIT_WORD_RE.search(raw)
    ):
        return False
    words = re.findall(r"[A-Za-z]+(?:-[A-Za-z]+)*", raw)
    if any(not _formula_word_is_literal(word) for word in words):
        return False
    math_font = any(
        any(key in str(span.get("font", "")) for key in _MATH_FONT_KEYS)
        for span in line.get("spans", [])
    )
    explicit_math = bool(
        re.search(r"[=+*/^<>±×÷√∞∫∑∏∂∇≤≥≈≠≡−→←↔⇌]", raw)
    )
    # A sentence-ending variable can make an otherwise ordinary prose line use a
    # math font.  ``is a:`` in Fundamental Astronomy is one such formula
    # introduction: preserving it as a display equation leaves visible English
    # immediately above the real equation.  A prose stopword drawn in an ordinary
    # font wins.  Rows containing prose stopwords were already rejected by the
    # lexical gate above; the operator exception here only applies to remaining
    # ordinary-font scientific tokens.
    ordinary_words = re.findall(
        r"[A-Za-z]+",
        " ".join(
            str(span.get("text", ""))
            for span in line.get("spans", [])
            if not any(
                key in str(span.get("font", "")) for key in _MATH_FONT_KEYS
            )
        ),
    )
    if (
        not explicit_math
        and any(word.lower() in _FORMULA_PROSE_STOPWORDS for word in ordinary_words)
    ):
        return False
    math_signal = bool(math_font or explicit_math)
    return math_signal and bool(words or re.search(r"\d", raw))


def _line_is_equation_number(line):
    return bool(re.fullmatch(r"\(?\s*\d+(?:\.\d+)+\s*\)?[.,]?", _raw_line_text(line)))


def _block_from_lines(block, lines, *, preserve_formula=False):
    new_block = copy.deepcopy(block)
    new_block["lines"] = [copy.deepcopy(line) for line in lines]
    rect = fitz.Rect(lines[0].get("bbox", block.get("bbox", (0, 0, 0, 0))))
    for line in lines[1:]:
        rect |= fitz.Rect(line.get("bbox", block.get("bbox", (0, 0, 0, 0))))
    new_block["bbox"] = tuple(rect)
    if preserve_formula:
        new_block["_preserve_formula"] = True
    else:
        new_block.pop("_preserve_formula", None)
    return new_block


def _split_mixed_display_formula_lines(block):
    """Split display-equation rows away from prose rows sharing a MuPDF block.

    This keeps the original 2-D glyph streams (fractions, stacked denominators,
    equation numbers) while allowing the adjacent prose to be translated in its
    own bbox.  Equation-number-only rows inherit the formula classification when
    they touch a formula row, as in ``sin C / sin C  (2.8)``.
    """
    lines = list(block.get("lines", []) or [])
    if not lines:
        return [block]
    formula = [_line_is_display_formula(line) for line in lines]
    # A wrapped caption can legitimately end with a short formula-only row.  For
    # example, Fundamental Astronomy's Fig. 2.5 ends ``z cos chi -`` on one row
    # and ``y sin chi`` on the next.  Treating that tail as a standalone display
    # equation splits one physical caption into a translated block plus a kept
    # source fragment.  The kept fragment then clips the translated rectangle,
    # leaving source words such as ``Fig. 2`` / ``frame`` visibly overlaid.  A
    # caption marker is stronger evidence than formula density, so every row in
    # its contiguous caption band remains one translatable unit.  Formula rows
    # outside that band are still preserved below.
    caption_band = _caption_band(block)
    if caption_band is not None:
        for index, line in enumerate(lines):
            line_rect = fitz.Rect(line.get("bbox", (0, 0, 0, 0)))
            if (
                caption_band[0] - 1.0
                <= float(line_rect.y0)
                <= caption_band[1] + 1.0
            ):
                formula[index] = False
    for index, line in enumerate(lines):
        if formula[index] or not _line_is_equation_number(line):
            continue
        rect = fitz.Rect(line.get("bbox", (0, 0, 0, 0)))
        for other_index in (index - 1, index + 1):
            if other_index < 0 or other_index >= len(lines) or not formula[other_index]:
                continue
            other = fitz.Rect(lines[other_index].get("bbox", (0, 0, 0, 0)))
            overlap = min(rect.y1, other.y1) - max(rect.y0, other.y0)
            gap = max(0.0, rect.y0 - other.y1, other.y0 - rect.y1)
            if overlap > 0 or gap <= 0.8 * max(1.0, min(rect.height, other.height)):
                formula[index] = True
                break
    if not any(formula):
        return [block]

    groups = []
    start = 0
    for index in range(1, len(lines)):
        if formula[index] != formula[index - 1]:
            groups.append((formula[start], lines[start:index]))
            start = index
    groups.append((formula[start], lines[start:]))
    return [
        _block_from_lines(block, group_lines, preserve_formula=is_formula)
        for is_formula, group_lines in groups
    ]


_OCR_INLINE_MATH_OPERATOR_RE = re.compile(
    r"[=+*/^<>\-\u2013\u2014\u00b1\u00d7\u00f7\u221a\u221e\u222b\u2211\u220f\u2202\u2207\u2264\u2265\u2248\u2260\u2261\u2212\u2192\u2190\u2194\u21cc]"
)
_OCR_INLINE_MATH_FUNCTIONS = {
    "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos",
    "arctan", "sinh", "cosh", "tanh", "log", "ln", "exp", "lim",
    "min", "max", "mod",
}


def _ocr_has_inline_math_operator(text):
    raw = str(text or "")
    # Ordinary hyphenated terminology is prose, not an equation operator.  Keep
    # one-letter variable expressions such as x-y untouched by requiring at
    # least two letters on both sides before suppressing the dash signal.
    raw = re.sub(r"([A-Za-z]{2,})[-\u2013\u2014]([A-Za-z]{2,})", r"\1\2", raw)
    return bool(_OCR_INLINE_MATH_OPERATOR_RE.search(raw))


def _ocr_inline_formula_token(text):
    """Return whether one OCR span can belong to an inline formula run.

    OCR-layer textbooks commonly expose one positioned span per word / symbol.
    This deliberately treats ordinary two-letter words as prose, while retaining
    variables, function names, bracketed values and mixed-case identifiers such
    as ``f(P_i)``.  It is used only after a stronger formula seed was found.
    """
    raw = str(text or "").strip()
    if not raw:
        return True
    if _ocr_has_inline_math_operator(raw):
        return True
    compact = re.sub(r"\s+", "", raw)
    if re.fullmatch(r"[\d.,:;()[\]{}|\\'\"`~_-]+", compact):
        return True
    letters = re.sub(r"[^A-Za-z]", "", compact)
    if not letters:
        return bool(re.search(r"\d", compact))
    lower = letters.lower()
    if lower in {
        "a", "an", "and", "as", "at", "be", "but", "by", "for", "from",
        "if", "in", "is", "it", "of", "on", "or", "so", "than", "that",
        "the", "then", "this", "to", "we", "where", "which", "with",
    }:
        return False
    if lower in _OCR_INLINE_MATH_FUNCTIONS:
        return True
    if len(letters) == 1:
        return True
    if len(letters) <= 6 and (
        re.search(r"\d", compact)
        or re.search(r"[()[\]{}]", compact)
        or (any(ch.isupper() for ch in letters) and any(ch.islower() for ch in letters))
    ):
        return True
    return False


def _ocr_inline_formula_seed(span):
    raw = str(span.get("text", "") or "").strip()
    if not raw:
        return False
    # PyMuPDF flag bit 0 marks superscript text.  A superscript is never ordinary
    # prose in the OCR layer and anchors its adjacent base / operator sequence.
    if (
        int(span.get("flags", 0) or 0) & 1
        and not re.search(r"[A-Za-z]{3,}", raw)
    ):
        return True
    if _ocr_has_inline_math_operator(raw):
        return True
    compact = re.sub(r"\s+", "", raw)
    if re.search(r"\d", compact) and re.search(r"[()[\]{}]", compact):
        return True
    if re.search(r"[()[\]{}]", compact) and _ocr_inline_formula_token(compact):
        return True
    if (
        re.search(r"[A-Za-z]", compact)
        and re.search(r"\d", compact)
        and not re.search(r"[A-Za-z]{3,}", compact)
    ):
        return True
    return False


def _line_from_spans(line, spans):
    new_line = copy.deepcopy(line)
    new_line["spans"] = [copy.deepcopy(span) for span in spans]
    rect = fitz.Rect(spans[0].get("bbox", line.get("bbox", (0, 0, 0, 0))))
    for span in spans[1:]:
        rect |= fitz.Rect(span.get("bbox", line.get("bbox", (0, 0, 0, 0))))
    new_line["bbox"] = tuple(rect)
    return new_line


def _split_hidden_ocr_inline_formula_runs(block):
    """Split OCR-layer prose and inline formula pixels into separate blocks.

    A page-sized scan image already contains the authoritative formula glyphs.
    Keeping a whole mixed line (``Example ... x^5 ...``) leaves visible English;
    redrawing the whole line destroys the equation pixels.  Span-level splitting
    lets prose rectangles be translated / painted while formula rectangles remain
    untouched in the underlying scan.  Born-digital PDFs never enter this path.
    """
    fragments = []
    changed = False
    for line in block.get("lines", []) or []:
        spans = list(line.get("spans", []) or [])
        if not spans:
            continue
        seeds = [index for index, span in enumerate(spans) if _ocr_inline_formula_seed(span)]
        formula = [False] * len(spans)
        for seed in seeds:
            formula[seed] = True
            left = seed - 1
            while left >= 0 and _ocr_inline_formula_token(spans[left].get("text", "")):
                formula[left] = True
                left -= 1
            right = seed + 1
            while right < len(spans) and _ocr_inline_formula_token(spans[right].get("text", "")):
                formula[right] = True
                right += 1
        if not any(formula) or all(formula):
            fragments.append((all(formula), _line_from_spans(line, spans)))
            changed = changed or all(formula)
            continue
        changed = True
        start = 0
        for index in range(1, len(spans)):
            if formula[index] != formula[index - 1]:
                fragments.append(
                    (formula[start], _line_from_spans(line, spans[start:index]))
                )
                start = index
        fragments.append((formula[start], _line_from_spans(line, spans[start:])))

    if not changed or not fragments:
        return [block]
    return [
        _block_from_lines(block, [line], preserve_formula=is_formula)
        for is_formula, line in fragments
        if _raw_line_text(line).strip()
    ]


def _is_short_numbered_section_heading(text):
    """Return whether *text* is a compact decimal-numbered section label.

    Running heads in older textbooks can be emitted immediately before body prose
    with the same font metrics (``2.5The Equatorial System``).  They are separate
    reading-order objects even though the heading has no terminal punctuation.
    Keep this deliberately narrow: a decimal section number, an uppercase title,
    no sentence punctuation, and at most 80 visible characters.
    """
    value = " ".join(str(text or "").split())
    return bool(
        value
        and len(value) <= 80
        and re.fullmatch(r"\d+(?:\.\d+)+\s*[A-Z][^.!?…]{1,70}", value)
    )


def _coalesce_paragraphs(blocks):
    """같은 단(column)에서 세로로 인접한 '본문 산문' 블록을, 앞 블록이 문장 중간에서
    끊겼을 때(종결부호 없이 끝남) 한 문단으로 합친다.

    PyMuPDF 는 걸개들여쓰기 번호목록·양끝맞춤 본문을 줄 경계에서 여러 띠(block)로
    쪼개는데, 그 띠가 '항목 꼬리 + 다음 항목 머리'처럼 논리 문단을 가로질러 끊긴다.
    그대로 두면 (1) 미완성 문장을 따로 번역해 모델이 임의로 완성·중복하고, (2) 1줄
    높이 박스에 긴 한국어가 욱여넣어져 글씨가 깨알같이 작아지며, (3) 조각 사이에 큰
    세로 빈칸이 생긴다. 문장이 안 끝난 인접 띠를 합쳐 문단 단위로 번역·배치한다.

    보존: 종결부호로 끝난 블록은 합치지 않는다(진짜 문단/문장 경계 유지). 다른
    단(가로 미겹침)·다른 크기/굵기(제목↔본문)·단어 없는 블록(수식·라벨)은 제외한다.
    extract/render 가 동일 결과를 내도록 디코더 비의존(원본 span 텍스트·크기·bbox)만 쓴다.
    """
    out = []
    for blk in blocks:
        if not out:
            out.append(blk)
            continue
        prev = out[-1]
        if prev.get("_preserve_formula") or blk.get("_preserve_formula"):
            out.append(blk)
            continue
        # 둘 다 본문 산문(본문 크기 단어 보유)이어야 — 수식·짧은 라벨은 병합 제외.
        if not (_has_word(prev) and _has_word(blk)):
            out.append(blk)
            continue
        # Consecutive linked URI lines are independent interactive objects, not a
        # wrapped paragraph.  Merging them moves the second label into the first
        # annotation rectangle even though link actions / geometry remain exact.
        raw_prev = _block_raw_text(prev).strip()
        raw_next = _block_raw_text(blk).strip()
        # A compact numbered running/section heading followed by lowercase prose
        # is not the first half of that prose sentence.  In Fundamental Astronomy,
        # merging ``2.5The Equatorial System`` with ``are the poles ...`` hid the
        # real p29→p30 continuation from the cross-page sentence annotator.
        if (
            _is_short_numbered_section_heading(raw_prev)
            and re.match(r"\s*[\"'‘“(]*[a-z]", raw_next)
        ):
            out.append(blk)
            continue
        if _formula_dense_block(prev) or _formula_dense_block(blk):
            out.append(blk)
            continue
        # A colon-ended prose introduction followed by a short narrow label is a
        # definition/data list, not a wrapped sentence (e.g. ``dimensions:`` then
        # ``equatorial radius`` beside an equation value).  Keep the label in its
        # own bbox; generic title wrapping remains available for ordinary wide
        # second lines.
        if raw_prev.endswith(":"):
            prev_rect = fitz.Rect(prev["bbox"])
            next_rect = fitz.Rect(blk["bbox"])
            if len(raw_next) <= 40 and next_rect.width < 0.65 * prev_rect.width:
                out.append(blk)
                continue
        if re.match(r"^(?:https?|mailto):", raw_prev, re.I) or re.match(
            r"^(?:https?|mailto):", raw_next, re.I
        ):
            out.append(blk)
            continue
        ra = fitz.Rect(prev["bbox"])
        rb = fitz.Rect(blk["bbox"])
        # 같은 단: 가로로 충분히 겹침(2단 레이아웃의 좌/우 단은 안 겹쳐 병합 안 됨).
        ox = min(ra.x1, rb.x1) - max(ra.x0, rb.x0)
        if ox <= 0.5 * min(ra.width, rb.width):
            out.append(blk)
            continue
        sa, _ca, ba, _ia = dominant_size_color(prev)
        sb, _cb, bb, _ib = dominant_size_color(blk)
        sa = sa or 10.0
        sb = sb or 10.0
        # 같은 글자 크기·굵기 (제목↔본문, 본문↔각주 혼합 방지).
        if abs(sa - sb) > 0.15 * max(sa, sb) or ba != bb:
            out.append(blk)
            continue
        # 아래로 인접(작은 간격~약간 겹침). 한 줄 높이의 0.9배 이내여야 같은 문단 흐름.
        lh = max(sa, sb) * 1.5
        gap = rb.y0 - ra.y1
        if gap > 0.9 * lh or gap < -0.6 * lh:
            out.append(blk)
            continue
        # 앞 블록이 문장 중간에서 끊겼을 때만 병합(종결부호로 끝나면 문단 경계 유지).
        if not _ends_midsentence(raw_prev):
            out.append(blk)
            continue
        # 새 블록이 '절 번호'(6.3, 6.13 등)나 챕터 목차 항목으로 시작하면 병합 안 함
        # — 목차(TOC) 항목들이 한 줄로 뭉쳐 'X.Y 제목 X.Z 제목 …'처럼 섞이는 것 방지.
        if re.match(r"\s*\d+\.\d+(\s|$)", raw_next):
            out.append(blk)
            continue
        # 병합: 줄 이어붙이고 bbox 합침(prev 는 out[-1] 과 동일 객체 → 제자리 갱신).
        prev["lines"] = prev.get("lines", []) + blk.get("lines", [])
        prev["bbox"] = [
            min(ra.x0, rb.x0), min(ra.y0, rb.y0),
            max(ra.x1, rb.x1), max(ra.y1, rb.y1),
        ]
    return out


_CAPTION_MARKER_RE = re.compile(r"^(?:fig(?:ure)?\.?|table)\s*\d", re.I)


def _block_primary_direction(block):
    """Return a cardinal source text direction weighted by visible characters."""
    weights = defaultdict(float)
    for line in block.get("lines", []):
        direction = line.get("dir") or (1.0, 0.0)
        try:
            dx, dy = float(direction[0]), float(direction[1])
        except (TypeError, ValueError, IndexError):
            continue
        if abs(dx) >= 0.9 and abs(dy) <= 0.15:
            cardinal = (1, 0) if dx >= 0 else (-1, 0)
        elif abs(dy) >= 0.9 and abs(dx) <= 0.15:
            cardinal = (0, 1) if dy >= 0 else (0, -1)
        else:
            continue
        visible = sum(
            len(str(span.get("text", "")).strip())
            for span in line.get("spans", [])
        )
        weights[cardinal] += max(1, visible)
    return max(weights, key=weights.get) if weights else (1, 0)


def _caption_head_text(block):
    """Return the marker-bearing first caption line, without decoding layout."""
    for line in (block.get("lines", []) or [])[:2]:
        value = "".join(
            str(span.get("text", "")) for span in line.get("spans", [])
        ).strip()
        if _CAPTION_MARKER_RE.match(value):
            return value
    return None


def _caption_continuation_geometry(head, previous, candidate, direction, size):
    """Conservatively prove that *candidate* is the next physical caption line.

    Some landscape textbook plates encode a rotated caption as one PDF block per
    visual line.  The continuation lines have the same cardinal direction, font
    metrics and terminal edge, and advance only across the narrow caption strip.
    Those signals are much stronger than ordinary paragraph proximity.
    """
    if _block_primary_direction(candidate) != direction:
        return False
    if _caption_head_text(candidate):
        return False
    raw = _block_raw_text(candidate).strip()
    if not raw or not re.match(r"^[\s\"'‘“(\[]*[A-Za-z]", raw):
        return False
    if len(re.findall(r"[A-Za-z]+", raw)) < 3:
        return False
    candidate_size, _color, candidate_bold, _italic = dominant_size_color(candidate)
    head_size, _head_color, head_bold, _head_italic = dominant_size_color(head)
    if (
        abs(candidate_size - size) > 0.15 * max(size, candidate_size, 1.0)
        or candidate_bold != head_bold
        or abs(head_size - size) > 0.15 * max(size, head_size, 1.0)
    ):
        return False

    hr = fitz.Rect(head["bbox"])
    pr = fitz.Rect(previous["bbox"])
    cr = fitz.Rect(candidate["bbox"])
    strip_limit = 10.0 * max(6.0, size)
    edge_tolerance = max(2.0, 0.4 * size)
    advance_limit = max(4.0, 1.6 * size)
    if direction == (0, -1):
        along = min(hr.y1, cr.y1) - max(hr.y0, cr.y0)
        return bool(
            cr.x0 >= pr.x0 - 0.8 * max(pr.width, cr.width)
            and cr.x0 - pr.x1 <= advance_limit
            and abs(cr.y1 - hr.y1) <= edge_tolerance
            and along >= 0.45 * min(hr.height, cr.height)
            and max(hr.x1, cr.x1) - min(hr.x0, cr.x0) <= strip_limit
        )
    if direction == (0, 1):
        along = min(hr.y1, cr.y1) - max(hr.y0, cr.y0)
        return bool(
            cr.x1 <= pr.x1 + 0.8 * max(pr.width, cr.width)
            and pr.x0 - cr.x1 <= advance_limit
            and abs(cr.y0 - hr.y0) <= edge_tolerance
            and along >= 0.45 * min(hr.height, cr.height)
            and max(hr.x1, cr.x1) - min(hr.x0, cr.x0) <= strip_limit
        )
    if direction == (1, 0):
        # Full-width plates often typeset one caption in two newspaper-style
        # columns.  MuPDF exposes the right half as a second block at the same y
        # coordinate, so the ordinary next-line geometry cannot join it.  The
        # caption marker, matching small font, tight column gutter and nearly
        # identical vertical band together are strong enough evidence to merge
        # the two halves without merging unrelated body columns.
        vertical_overlap = min(hr.y1, cr.y1) - max(hr.y0, cr.y0)
        horizontal_gap = cr.x0 - pr.x1
        side_by_side = bool(
            0 <= horizontal_gap <= max(24.0, 3.0 * size)
            and vertical_overlap >= 0.72 * min(hr.height, cr.height)
            and abs(cr.y0 - hr.y0) <= max(3.0, 0.65 * size)
            and abs(cr.y1 - hr.y1) <= max(14.0, 1.8 * size)
            and not re.search(r"[.!?][\"'’”)]*$", _block_raw_text(previous).strip())
        )
        if side_by_side:
            return "column"
        if not re.match(r"^[\s\"'‘“(\[]*[a-z]", raw):
            return False
        along = min(hr.x1, cr.x1) - max(hr.x0, cr.x0)
        return bool(
            cr.y0 >= pr.y0 - 0.8 * max(pr.height, cr.height)
            and cr.y0 - pr.y1 <= advance_limit
            and abs(cr.x0 - hr.x0) <= edge_tolerance
            and along >= 0.45 * min(hr.width, cr.width)
            and max(hr.y1, cr.y1) - min(hr.y0, cr.y0) <= strip_limit
        )
    return False


def _merge_caption_continuation_blocks(blocks):
    """Merge only geometrically proven continuation blocks of a marked caption."""
    out = []
    index = 0
    while index < len(blocks):
        block = blocks[index]
        if not _caption_head_text(block):
            out.append(block)
            index += 1
            continue
        direction = _block_primary_direction(block)
        size, _color, _bold, _italic = dominant_size_color(block)
        merged = copy.deepcopy(block)
        previous = block
        cursor = index + 1
        while cursor < len(blocks):
            continuation_kind = _caption_continuation_geometry(
                merged, previous, blocks[cursor], direction, size
            )
            if not continuation_kind:
                break
            candidate = blocks[cursor]
            candidate_lines = copy.deepcopy(candidate.get("lines", []))
            if candidate_lines:
                # Vertically rotated caption lines share one y-band and are
                # x-sorted into one logical row by ``block_text``.  Record their
                # semantic boundary so adjacent words do not become ``thegiven``.
                candidate_lines[0]["_caption_continuation"] = True
                if continuation_kind == "column":
                    for candidate_line in candidate_lines:
                        candidate_line["_caption_column_continuation"] = True
            merged["lines"].extend(candidate_lines)
            merged["bbox"] = tuple(
                fitz.Rect(merged["bbox"]) | fitz.Rect(candidate["bbox"])
            )
            previous = candidate
            cursor += 1
        if cursor > index + 1:
            merged["_caption_chain"] = True
            merged["_source_text_direction"] = direction
        out.append(merged)
        index = cursor
    return out


def iter_text_blocks(doc, hidden_ocr_pages=None):
    """type=0(텍스트) 블록을 두 모드에서 동일한 순서/id로 순회한다.

    span 이 없는 빈 블록과 이미지 블록(type=1)은 건너뛰되, id 카운터는
    '텍스트 블록'에 대해서만 증가시켜 extract/render 간 id 가 일치하게 한다.
    위첨자 전하 분리 블록은 병합하고(_merge_superscript_ions), 문장 중간에서 끊긴
    인접 본문 띠도 한 문단으로 합친다(_coalesce_paragraphs). 모두 extract/render
    동일 로직 → id 일치 유지.
    """
    bid = 0
    hidden_ocr_pages = set(hidden_ocr_pages or ())
    for pno in range(len(doc)):
        page = doc[pno]
        data = page.get_text("dict")
        text_blocks = [
            b
            for b in data.get("blocks", [])
            if b.get("type") == 0 and any(ln.get("spans") for ln in (b.get("lines") or []))
        ]
        spatial_blocks = []
        for block in text_blocks:
            spatial_blocks.extend(
                _split_spatially_separated_runs(block, page.rect.width)
            )
        merged = _absorb_tiny_fragments(_merge_superscript_ions(spatial_blocks))
        merged = _merge_caption_continuation_blocks(merged)
        segmented = []
        for block in merged:
            segmented.extend(_split_mixed_display_formula_lines(block))
        merged = segmented
        if pno in hidden_ocr_pages:
            segmented = []
            for block in merged:
                segmented.extend(_split_hidden_ocr_inline_formula_runs(block))
            merged = segmented
        merged = _coalesce_paragraphs(merged)
        for block in merged:
            yield bid, pno, block
            bid += 1


# 깨진 ToUnicode 복원 — 폰트 자체 인코딩(/Differences)을 읽어 정확히 되돌린다.
#
# 일부 PDF(교재·원서)는 본문 합자(fi·fl)나 수식 폰트(MathematicalPi/MathPi)의
# 그리스·기호가 /ToUnicode 손상으로 ASCII('#', '"', '!' …)로 추출된다. 깨진 추출은
# ord(글자)==폰트코드 이므로, 그 폰트의 /Encoding /Differences(코드→글리프명)를 읽어
# 글리프명→유니코드로 매핑하면 서브셋·PDF 와 무관하게 정확히 복원된다(정적 char 맵은
# 서브셋마다 인코딩이 달라 오작동했음 — 이 방식이 그걸 대체한다).

# 합자(ligature) — 본문 폰트에서 'fi','fl' 등이 한 글리프로 묶인 것.
_LIG = {
    "f_i": "fi", "f_l": "fl", "f_f": "ff", "f_f_i": "ffi", "f_f_l": "ffl",
    "fi": "fi", "fl": "fl", "ff": "ff", "ffi": "ffi", "ffl": "ffl",
}

# MathematicalPi / MathPi 의 Hxxxxx 글리프명 → 유니코드.
# Oxtoby 6장에서 임베드 폰트 렌더로 식별(서브셋 무관 고정값). 교차검증:
#   ℋ_el ψ_el = E_el ψ_el (슈뢰딩거식) · 1σg < 1σu* (에너지 순서) · 4πε₀ (쿨롱)
#   + chem-pre 정적맵(33→+,34→Δ,35→−)이 H11001/H9004/H11002 와 일치.
_HCODE = {
    "H9274": "ψ", "H9278": "φ", "H9272": "φ", "H9268": "σ", "H9266": "π",
    "H9280": "ε", "H9258": "θ", "H9004": "Δ", "H11001": "+", "H11002": "−",
    "H11005": "=", "H11006": "±", "H11021": "<", "H11022": ">", "H11009": "∞",
    "H5108": "ℋ", "H11545": "+", "H11546": "−", "H20919": "|",
    # 추가 식별(서브셋별 변형 글리프명; 같은 기호의 다른 인코딩 포함)
    "H9267": "ψ", "H9254": "θ", "H9251": "φ", "H9255": "±", "H5113": "ℋ",
    "H5133": "ℓ", "H11011": "≈",
}

# Adobe Glyph List 부분집합(자주 쓰는 그리스·수학 기호·연산자).
_AGL = {
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
    "zeta": "ζ", "eta": "η", "theta": "θ", "iota": "ι", "kappa": "κ",
    "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "omicron": "ο", "pi": "π",
    "rho": "ρ", "sigma": "σ", "tau": "τ", "upsilon": "υ", "phi": "φ", "chi": "χ",
    "psi": "ψ", "omega": "ω", "varphi": "φ", "varepsilon": "ε", "vartheta": "ϑ",
    "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ",
    "Pi": "Π", "Sigma": "Σ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
    "Upsilon": "Υ", "plus": "+", "minus": "−", "equal": "=", "plusminus": "±",
    "minusplus": "∓", "multiply": "×", "divide": "÷", "less": "<",
    "greater": ">", "lessequal": "≤", "greaterequal": "≥", "notequal": "≠",
    "approxequal": "≈", "equivalence": "≡", "proportional": "∝", "infinity": "∞",
    "partialdiff": "∂", "gradient": "∇", "integral": "∫", "summation": "∑",
    "product": "∏", "radical": "√", "element": "∈", "notelement": "∉",
    "arrowright": "→", "arrowleft": "←", "arrowboth": "↔", "arrowup": "↑",
    "arrowdown": "↓", "asteriskmath": "*", "bullet": "•", "periodcentered": "·",
    "dotmath": "·", "degree": "°", "minute": "′", "second": "″", "angle": "∠",
    "space": " ", "period": ".", "comma": ",", "colon": ":", "semicolon": ";",
    "slash": "/", "exclam": "!",
    "bracketleft": "[", "bracketright": "]", "parenleft": "(", "parenright": ")",
    "braceleft": "{", "braceright": "}",
}

# 폴백: Computer Modern / AMS 수식 폰트(LaTeX 논문)는 /Differences 글리프명이
# 비표준일 수 있어 디코더가 못 풀 때만 쓴다. 기호 전용이라 안전.
_CMSY_FIX = {"⇤": "*", "⇥": "×", "2": "∈", "p": "√"}
_CMEX_FIX = {"P": "Σ"}
_CMMI_FIX = {"↵": "α", "⇡": "π", "✏": "ε"}
# MathTechnical(기호 전용 폰트): 화학 결합선(—)이 ToUnicode 손상으로 'U'로 추출돼
# 'C—H'가 'CUH', 'H—C—H'가 'HUCUH'로 보이던 것 수정. 일반 글자 'U'는 본문폰트라 무관.
_MATHTECH_FIX = {"U": "–"}
# Some MathTime Symbol subsets expose the subtraction glyph as ASCII ``!`` through
# a damaged/missing Unicode map.  Other subsets explicitly map the same raw code to
# a different glyph (notably ``proportional``).  Therefore this is a fallback only;
# a page-local /Differences or CFF glyph-identity decoder must take precedence.
_MTSYN_FIX = {"!": "−"}

# 화학 교과서(OXTOBY/Cengage 계열)의 위첨자 기호 전용 서브셋 폰트.
# ToUnicode 손상으로 전하·반결합 기호가 숫자/글자로 추출돼, 'H₂⁺'→'H₂1', 'O₂⁻'→'O₂2',
# 'O₂²⁻'→'O₂²2', 'σ*'→'σp' 처럼 깨지던 것 수정. 글리프 크롭으로 실제 모양을 확인해 매핑.
#   WWDOC01: '1'=⁺(전하 플러스), '2'=⁻(전하 마이너스)
#   WWDOC06: 'p'=*(반결합 오비탈 별표 σ*)
# 이 폰트들은 본문 글자가 아니라 기호 전용 서브셋이라(해당 슬롯에 다른 글자가 없음)
# 폰트명 한정 매핑이 안전하다. 크기상 위첨자로 잡혀 <sup>+</sup>/<sup>-</sup> 로 렌더된다.
_WWDOC01_FIX = {"1": "+", "2": "-"}
_WWDOC06_FIX = {"p": "*"}

# 수식·기호 전용 폰트(이 폰트의 슬롯은 전부 기호 → /Differences 전부 적용 안전).
_MATH_FONT_KEYS = (
    "MathematicalPi", "MathPi", "Symbol", "Euclid", "MT-Extra",
    "CMSY", "CMEX", "CMMI", "MSAM", "MSBM",
    "MTMI", "MTSY", "MTSYN", "MTEX", "MTGU", "MTMS",
)

# 디코더는 페이지별로 만든다 — 같은 수식폰트도 서브셋마다 인코딩이 달라(코드 33이
# ψ/θ/σ …) 문서 전역 매핑은 오작동한다. 페이지의 폰트(서브셋)만으로 매핑하면 그 페이지
# 본문은 정확히 복원된다. 같은 페이지에 충돌 서브셋이 여럿이면 가장 풍부한(=본문) 것을
# 우선한다(span→서브셋 식별은 PyMuPDF API 로 불가능 — 그림 라벨 등은 한계가 남음).
_DECODERS_BY_PAGE = {}  # {pno: {정규화폰트명: {코드: 유니코드}}}
# Damaged ToUnicode maps can collapse different glyphs in the same font to the
# same plausible Unicode character.  Fundamental Astronomy, for example, exposes
# both MTMI ``comma`` and ``beta`` as U+002C, and both ``parenleft`` and ``delta``
# as U+0028.  A page/font-wide raw-code decoder cannot distinguish those cases,
# so retain the ambiguous occurrences with their texttrace geometry.
_TRACE_DECODERS_BY_PAGE = {}  # {pno: {font: [(baseline, x, raw_code, unicode), ...]}}
_CUR_DEC = {}  # 현재 페이지 디코더
_CUR_TRACE_DEC = {}  # 현재 페이지의 glyph-occurrence 디코더


def _norm_font(n):
    return (n or "").split("+")[-1]  # 서브셋 접두사(ABCDEF+) 제거


def _use_page(pno):
    """추출 시 현재 페이지의 디코더를 활성화(_fix_span_text 가 참조)."""
    global _CUR_DEC, _CUR_TRACE_DEC
    _CUR_DEC = _DECODERS_BY_PAGE.get(pno, {})
    _CUR_TRACE_DEC = _TRACE_DECODERS_BY_PAGE.get(pno, {})


def _glyph_to_unicode(gn):
    """글리프명 → 유니코드 문자(또는 None: 못 풀면 원본 유지)."""
    if not gn:
        return None
    if gn in _HCODE:
        return _HCODE[gn]
    if gn in _LIG:
        return _LIG[gn]
    if gn in _AGL:
        return _AGL[gn]
    # MathTime CFF charsets use variant suffixes such as psi1, theta1 and Delta1.
    # Their glyph shape may vary, but their mathematical character semantics do not.
    variant_base = re.sub(r"\d+$", "", gn)
    if variant_base != gn and variant_base in _AGL:
        return _AGL[variant_base]
    m = re.match(r"^uni([0-9A-Fa-f]{4,6})$", gn) or re.match(r"^u([0-9A-Fa-f]{4,6})$", gn)
    if m:
        try:
            return chr(int(m.group(1), 16))
        except Exception:
            return None
    for k, v in (("bracketleft", "["), ("bracketright", "]"), ("parenleft", "("),
                 ("parenright", ")"), ("braceleft", "{"), ("braceright", "}"),
                 ("arrowright", "→"), ("arrowleft", "←"), ("radical", "√")):
        if gn.startswith(k):
            return v
    base = gn.split(".")[0]  # .sc/.sup 등 접미사 제거 후 재시도
    if base != gn:
        return _glyph_to_unicode(base)
    return None


def _read_differences(doc, xref):
    """폰트 객체의 /Encoding /Differences 를 읽어 {코드: 글리프명} 반환."""
    try:
        obj = doc.xref_object(xref) or ""
    except Exception:
        return {}
    blob = obj
    m = re.search(r"/Encoding\s+(\d+)\s+0\s+R", obj)
    if m:
        try:
            blob = doc.xref_object(int(m.group(1))) or obj
        except Exception:
            pass
    dm = re.search(r"/Differences\s*\[(.*?)\]", blob, re.S)
    if not dm and blob != obj:
        dm = re.search(r"/Differences\s*\[(.*?)\]", obj, re.S)
    if not dm:
        return {}
    code = None
    mp = {}
    for t in dm.group(1).split():
        if t.isdigit():
            code = int(t)
        elif t.startswith("/") and code is not None:
            mp[code] = t[1:]
            code += 1
    return mp


def build_decoders(doc):
    """페이지별로 폰트 /Differences → code→유니코드 디코더를 만든다.
    - 수식 폰트(MathematicalPi/MathPi/Symbol/Euclid/CM…): /Differences 전부 적용(모두 기호).
    - 본문 폰트: 합자(다중 글자) 매핑만 적용 — 진짜 따옴표·문장부호 오염 방지.
    - 같은 페이지에 같은 base 폰트의 서브셋이 여럿이고 코드가 충돌하면, /Differences 가
      가장 큰(가장 풍부 = 본문) 서브셋을 우선하고 나머지는 비충돌 코드만 보충한다."""
    global _DECODERS_BY_PAGE, _TRACE_DECODERS_BY_PAGE
    _DECODERS_BY_PAGE = {}
    _TRACE_DECODERS_BY_PAGE = {}
    for pno in range(len(doc)):
        try:
            fonts = doc[pno].get_fonts(full=True)
        except Exception:
            _DECODERS_BY_PAGE[pno] = {}
            _TRACE_DECODERS_BY_PAGE[pno] = {}
            continue
        bysub = {}  # 정규화명 -> [cmap(code→글리프명), ...]
        font_xrefs = defaultdict(list)
        for f in fonts:
            name = _norm_font(f[3] if len(f) > 3 else "")
            if not name:
                continue
            font_xrefs[name].append(int(f[0]))
            cmap = _read_differences(doc, f[0])
            if cmap:
                bysub.setdefault(name, []).append(cmap)
        page_dec = {}
        for name, cmaps in bysub.items():
            is_math = any(k in name for k in _MATH_FONT_KEYS)
            # 가장 풍부한 서브셋(=본문) 우선. 단 충돌 코드에서 큰 서브셋의 글리프가
            # 해석 불가(매핑표에 없음)이고 다른 서브셋의 글리프가 해석되면 그쪽을 쓴다
            # — 큰 서브셋이 code 35/36 을 미지 글리프로 덮어 θ/π 가 raw '#'/'$' 로
            # 남던 잔여 깨짐을 줄인다(해석되는 글리프 우선).
            merged = {}
            for cmap in sorted(cmaps, key=lambda m: -len(m)):
                for code, gname in cmap.items():
                    cur = merged.get(code)
                    if cur is None:
                        merged[code] = gname
                    elif _glyph_to_unicode(cur) is None and _glyph_to_unicode(gname) is not None:
                        merged[code] = gname
            dec = {}
            for code, gname in merged.items():
                u = _glyph_to_unicode(gname)
                if u is None:
                    continue
                if is_math or len(u) > 1:  # 본문 폰트는 합자(다중 글자)만
                    dec[code] = u
            if dec:
                page_dec[name] = dec

        # Some MathTime subsets declare MacRomanEncoding with no /Differences or
        # usable ToUnicode map.  MuPDF then returns plausible but wrong Greek
        # Unicode (for example the visible ψ/θ/χ glyphs become ϕ/Ξ/Λ).  Recover the
        # semantics from the embedded CFF charset and texttrace glyph ids.  This is
        # page-local, so conflicting subset encodings on other pages cannot leak.
        gid_maps = {}
        for name, xrefs in font_xrefs.items():
            if not any(key in name for key in _MATH_FONT_KEYS):
                continue
            for xref in xrefs:
                try:
                    from fontTools.cffLib import CFFFontSet

                    _fname, extension, _ftype, buffer = doc.extract_font(xref)
                    if extension != "cff" or not buffer:
                        continue
                    cff = CFFFontSet()
                    cff.decompile(io.BytesIO(buffer), None)
                    top = cff[cff.fontNames[0]]
                    decoded = {
                        gid: value
                        for gid, glyph_name in enumerate(top.charset)
                        if (value := _glyph_to_unicode(glyph_name)) is not None
                    }
                    if decoded:
                        gid_maps[name] = decoded
                        break
                except Exception:
                    continue
        traced = defaultdict(lambda: defaultdict(set))
        trace_occurrences = defaultdict(list)
        if gid_maps:
            try:
                for span in doc[pno].get_texttrace():
                    name = _norm_font(span.get("font", ""))
                    gid_map = gid_maps.get(name)
                    if not gid_map:
                        continue
                    for char in span.get("chars") or ():
                        raw_code, glyph_id = int(char[0]), int(char[1])
                        intended = gid_map.get(glyph_id)
                        if intended is not None:
                            traced[name][raw_code].add(intended)
                            origin = char[2]
                            trace_occurrences[name].append(
                                (
                                    float(origin[1]),
                                    float(origin[0]),
                                    raw_code,
                                    intended,
                                )
                            )
            except Exception:
                traced = {}
                trace_occurrences = {}
        page_trace_decoders = {}
        for name, raw_map in traced.items():
            decoder = page_dec.setdefault(name, {})
            ambiguous_codes = set()
            for raw_code, intended_values in raw_map.items():
                if len(intended_values) == 1:
                    decoder[raw_code] = next(iter(intended_values))
                else:
                    # /Differences may already have installed one of the colliding
                    # meanings. Leaving it in place corrupts the other glyph, so
                    # fail closed unless the exact texttrace occurrence is known.
                    decoder.pop(raw_code, None)
                    ambiguous_codes.add(raw_code)
            if ambiguous_codes:
                page_trace_decoders[name] = sorted(
                    (
                        record
                        for record in trace_occurrences.get(name, [])
                        if record[2] in ambiguous_codes
                    ),
                    key=lambda record: (record[0], record[1]),
                )
        _DECODERS_BY_PAGE[pno] = page_dec
        _TRACE_DECODERS_BY_PAGE[pno] = page_trace_decoders
    return _DECODERS_BY_PAGE


def _trace_span_replacements(font, text, span):
    """Resolve raw-code collisions using CFF glyph identity and span geometry.

    MuPDF's normal text dictionary only exposes the damaged Unicode string, while
    ``get_texttrace`` also exposes the embedded-font glyph id and origin.  Only raw
    codes proven ambiguous on this page are recorded, so ordinary prose and
    unambiguous mathematical characters do not depend on geometry.
    """
    if not isinstance(span, dict) or not text:
        return {}
    records = _CUR_TRACE_DEC.get(_norm_font(font)) or ()
    origin = span.get("origin")
    bbox = span.get("bbox")
    if not records or not origin or not bbox or len(origin) < 2 or len(bbox) < 4:
        return {}
    try:
        baseline = float(origin[1])
        x0, x1 = float(bbox[0]), float(bbox[2])
    except (TypeError, ValueError, OverflowError):
        return {}
    candidates = [
        record
        for record in records
        if abs(record[0] - baseline) <= 0.25
        and (x0 - 0.25) <= record[1] <= (x1 + 0.25)
    ]
    if not candidates:
        return {}
    by_raw = defaultdict(list)
    for _y, x, raw_code, intended in sorted(candidates, key=lambda record: record[1]):
        by_raw[raw_code].append((x, intended))
    replacements = {}
    for index, char in enumerate(text):
        queue = by_raw.get(ord(char))
        if queue:
            _x, intended = queue.pop(0)
            replacements[index] = intended
    return replacements


def _fix_span_text(font, text, span=None):
    """깨진 글자를 실제 유니코드로 복원. 폰트 /Differences 디코더 우선,
    못 풀면 CM 정적맵 폴백. 일반 본문 폰트의 진짜 글자는 건드리지 않는다."""
    if not text:
        return text
    f = font or ""
    dec = _CUR_DEC.get(_norm_font(f))
    trace_replacements = _trace_span_replacements(f, text, span)
    # 폰트 판정(부분문자열 검색)은 호출당 1회만 — 글자 루프 밖으로 끌어낸다(추출 속도).
    # 기호 전용 서브셋 폰트(WWDOC…)는 디코더보다 우선해 강제 매핑(전하·별표).
    # 디코더가 'MacRomanEncoding' 항등으로 '1'→'1' 을 돌려주면 깨진 채 남기 때문.
    forced = (
        _WWDOC01_FIX if "WWDOC01" in f
        else (_WWDOC06_FIX if "WWDOC06" in f else None)
    )
    if "CMSY" in f:
        fallback = _CMSY_FIX
    elif "CMEX" in f:
        fallback = _CMEX_FIX
    elif "CMMI" in f:
        fallback = _CMMI_FIX
    elif "MathTechnical" in f:
        fallback = _MATHTECH_FIX
    elif "MTSYN" in f:
        fallback = _MTSYN_FIX
    else:
        fallback = None
    # 빠른 경로: 강제맵·디코더·폴백맵이 모두 없으면(대다수 본문 폰트) 원문 그대로 반환.
    if forced is None and dec is None and fallback is None and not trace_replacements:
        return text
    out = []
    for index, ch in enumerate(text):
        if index in trace_replacements:
            out.append(trace_replacements[index])
            continue
        if forced is not None and ch in forced:
            out.append(forced[ch])
            continue
        if dec is not None:
            u = dec.get(ord(ch))
            if u is not None:
                out.append(u)
                continue
        out.append(fallback.get(ch, ch) if fallback is not None else ch)
    return "".join(out)


def _line_in_figs(line_bbox, figs):
    """줄(line)의 중심이 그림 영역(±18pt) 안이면 True.

    그래프 Y축 라벨 'V(R_AB)' 처럼, PyMuPDF 가 그림 위 텍스트를 캡션과 같은
    블록으로 묶어버리는 경우가 있다. 그런 줄을 가려내 번역·덮기에서 빼면
    축 라벨은 영어 그대로 그래프에 남고, 캡션만 깔끔히 번역된다.
    """
    if not figs:
        return False
    # A plate beginning near the top text margin can sit 15--18 pt below a
    # running head.  The generic axis-label halo must not swallow that header when
    # the line is wholly above (and does not intersect) every figure.  This keeps
    # headings such as ``2.12 Star Catalogues and Maps`` translatable while still
    # protecting labels actually inside the plate.
    line_rect = fitz.Rect(line_bbox)
    if line_rect.y1 <= 50.0 and all(line_rect.y1 <= f.y0 for f in figs):
        return False
    cx = (line_bbox[0] + line_bbox[2]) / 2.0
    cy = (line_bbox[1] + line_bbox[3]) / 2.0
    return any(
        (f.x0 - 18) <= cx <= (f.x1 + 18) and (f.y0 - 18) <= cy <= (f.y1 + 18)
        for f in figs
    )


def _caption_band(block):
    """Return the contiguous caption y-band, or None.

    Captions are commonly only 6–12 pt below a figure.  The generic ±18 pt figure
    guard protects axis labels but can therefore hide the first caption line.  A
    caption marker is stronger semantic evidence than geometric proximity, so its
    complete block must stay translatable.
    """
    lines = block.get("lines", [])
    for marker_index, line in enumerate(lines[:2]):
        start = "".join(
            _fix_span_text(span.get("font", ""), span.get("text", ""), span=span)
            for span in line.get("spans", [])
        ).strip()
        if re.match(r"^(?:fig(?:ure)?\.?|table)\s*\d", start, re.I):
            bbox = line.get("bbox", (0, 0, 0, 0))
            floor = float(bbox[1])
            bottom = float(bbox[3])
            sizes = [
                float(span.get("size", 0) or 0)
                for span in line.get("spans", [])
                if float(span.get("size", 0) or 0) > 0
            ]
            base_size = max(sizes) if sizes else max(6.0, bottom - floor)
            previous_y = floor
            for following in lines[marker_index + 1:]:
                following_bbox = following.get("bbox", (0, 0, 0, 0))
                y0 = float(following_bbox[1])
                if y0 - previous_y > max(12.0, 1.8 * base_size):
                    break
                bottom = max(bottom, float(following_bbox[3]))
                previous_y = y0
            return floor, bottom
    return None


def block_text(block, figs=None, tag=False):
    """블록 안의 줄들을 사람이 읽을 한 문단 문자열로 합친다.

    화면상 줄바꿈(wrap)은 공백으로 이어 붙인다 — 한 문장이 여러 줄에 걸쳐도
    번역은 한 단위로 처리해야 자연스럽기 때문이다.

    figs 가 주어지면, 그림 영역에 든 줄(축 라벨 등)은 번역 대상에서 제외한다.

    핵심: PyMuPDF 는 인라인 전자배치((1s)²(2s)²(2pₓ)¹…)나 첨자 많은 식을, 같은
    시각적 줄인데도 '문자 유형별(괄호/본문숫자/위첨자/아래첨자/글자)'로 쪼개 여러
    line 으로 내보낸다. 그대로 line 순서로 join 하면 '( )( )( ) 1 2 2 s s p p x y'
    처럼 뒤섞인다. → y 가 겹치는 line 들을 한 '시각적 줄'로 묶고, 그 안 span 을
    x 순서로 재정렬해 읽기 순서를 복원한다(번역 입력 정확도↑, 깨진 인라인식 수정).

    tag=True 면 위/아래첨자 span 을 <sup>..</sup>/<sub>..</sub> 로 감싼다. 이 태그가
    번역을 거쳐 렌더에서 진짜 위/아래첨자로 그려져 H₂⁺·ψ_el·σ_g 같은 식이 평문화
    ('H+2','ψel','σg')되지 않는다. 같은 x 에 겹친 첨자는 sub→sup 순으로 정렬한다.
    """
    rows = []  # [{y0, y1, segment, items:[{x, cy, sz, t}]}]
    caption_band = _caption_band(block)
    for ln in block.get("lines", []):
        line_bbox = ln.get("bbox", (0, 0, 0, 0))
        caption_line = bool(
            caption_band is not None
            and caption_band[0] - 1.0 <= float(line_bbox[1]) <= caption_band[1] + 1.0
        )
        if not caption_line and _line_in_figs(line_bbox, figs):
            continue
        lb = ln.get("bbox", (0, 0, 0, 0))
        ly0, ly1 = lb[1], lb[3]
        items = []
        horizontal_line = abs(float((ln.get("dir") or (1.0, 0.0))[0])) >= 0.9
        line_span_sizes = [
            float(sp.get("size", 0.0) or 0.0)
            for sp in ln.get("spans", [])
            if str(sp.get("text", "")).strip()
        ]
        line_main_size = max(line_span_sizes) if line_span_sizes else 0.0
        baseline_samples = []
        for sp in ln.get("spans", []):
            t = _fix_span_text(sp.get("font", ""), sp.get("text", ""), span=sp)
            if t == "":
                continue
            b = sp.get("bbox", (lb[0], ly0, lb[0], ly1))
            items.append({"x": b[0], "cy": (b[1] + b[3]) / 2.0,
                          "sz": sp.get("size", 10.0) or 10.0, "t": t,
                          "absorbed": bool(sp.get("_absorbed_tiny_fragment"))})
            origin = sp.get("origin")
            if (
                horizontal_line
                and origin
                and len(origin) >= 2
                and line_main_size > 0
                and float(sp.get("size", 0.0) or 0.0) >= 0.85 * line_main_size
            ):
                baseline_samples.extend(
                    [float(origin[1])] * max(1, len(str(t).strip()))
                )
        if not items:
            continue
        line_baseline = None
        if baseline_samples:
            baseline_samples.sort()
            line_baseline = baseline_samples[len(baseline_samples) // 2]
        if ln.get("_caption_continuation"):
            first_x = min(item["x"] for item in items)
            items.insert(
                0,
                {
                    "x": first_x,
                    "cy": items[0]["cy"],
                    "sz": items[0]["sz"],
                    "t": " ",
                    "absorbed": False,
                }
            )
        segment = 1 if ln.get("_caption_column_continuation") else 0
        placed = False
        for row in rows:
            if row.get("segment", 0) != segment:
                continue
            oy = min(ly1, row["y1"]) - max(ly0, row["y0"])
            mh = max(1.0, min(ly1 - ly0, row["y1"] - row["y0"]))
            # Adjacent textbook lines that contain tall superscripts often overlap
            # by 55–62%.  Requiring stronger overlap prevents the next baseline from
            # being x-sorted into the current one (``frame y sin χ are ...``), while
            # true split-span/subscript lines still overlap almost completely.
            # Tall relation-symbol bboxes can overlap the following prose line by
            # more than 68% even though the baselines are a full line apart.  That
            # used to x-sort ``B - V = 1.6`` together with the next line into
            # ``BThe ... 1 the.3``.  For horizontal text, require compatible main
            # baselines as well as geometric overlap.  True sub/sup split-lines
            # have only a small baseline shift; rotated captions retain the prior
            # geometry-only path because a y-coordinate is not their baseline.
            baselines_compatible = True
            if row.get("baseline") is not None and line_baseline is not None:
                reference_size = max(
                    float(row.get("main_size", 0.0) or 0.0),
                    line_main_size,
                    1.0,
                )
                baselines_compatible = (
                    abs(float(row["baseline"]) - line_baseline)
                    <= 0.60 * reference_size
                )
            if oy > 0.68 * mh and baselines_compatible:  # 같은 시각적 줄
                row["items"].extend(items)
                row["y0"] = min(row["y0"], ly0)
                row["y1"] = max(row["y1"], ly1)
                if line_baseline is not None:
                    previous_weight = int(row.get("baseline_weight", 0) or 0)
                    line_weight = len(baseline_samples)
                    if row.get("baseline") is None or previous_weight <= 0:
                        row["baseline"] = line_baseline
                        row["baseline_weight"] = line_weight
                    elif line_weight > 0:
                        row["baseline"] = (
                            float(row["baseline"]) * previous_weight
                            + line_baseline * line_weight
                        ) / (previous_weight + line_weight)
                        row["baseline_weight"] = previous_weight + line_weight
                row["main_size"] = max(
                    float(row.get("main_size", 0.0) or 0.0), line_main_size
                )
                placed = True
                break
        if not placed:
            rows.append(
                {
                    "y0": ly0,
                    "y1": ly1,
                    "segment": segment,
                    "items": list(items),
                    "baseline": line_baseline,
                    "baseline_weight": len(baseline_samples),
                    "main_size": line_main_size,
                }
            )
    # A proven side-by-side caption is read column-major: finish the marker-bearing
    # left column before continuing at the top of the right column.  Ordinary
    # blocks retain their historical y-only ordering.
    rows.sort(key=lambda r: (r.get("segment", 0), r["y0"]))
    out = []
    for row in rows:
        its = row["items"]
        if tag:
            main = max(i["sz"] for i in its)
            big = [i["cy"] for i in its if i["sz"] >= 0.85 * main]
            mcy = (sum(big) / len(big)) if big else its[0]["cy"]
            for i in its:
                i["style"] = "normal"
                if i["t"].strip() and (i["absorbed"] or i["sz"] < 0.90 * main):  # 작은 글자 = 첨자 후보
                    if i["cy"] > mcy + 0.06 * main:
                        i["style"] = "sub"
                    elif i["cy"] < mcy - 0.06 * main:
                        i["style"] = "sup"
            # True coincident spans need normal<sub<sup ordering, but a coarse 4pt
            # bucket can move a superscript past the following prose span (r²).
            # Hundredth-point grouping retains the tie rule without changing the
            # ordinary left-to-right glyph order.
            rank = {"normal": 0, "sub": 1, "sup": 2}
            its.sort(key=lambda i: (round(i["x"], 2), rank[i["style"]]))
            s = ""
            for i in its:
                if i["absorbed"] and i["style"] == "sup" and s and not s.endswith(" "):
                    # Preserve the source extractor's token boundary between a
                    # separately encoded formula base and its absorbed charge.  The
                    # rich renderer emits this particular gap as a zero-advance
                    # space glyph, so copied/searchable text sees ``SO4 2-`` while
                    # the visual charge remains flush with SO4.
                    s += " "
                if i["style"] == "sub":
                    s += "<sub>" + i["t"] + "</sub>"
                elif i["style"] == "sup":
                    s += "<sup>" + i["t"] + "</sup>"
                else:
                    s += i["t"]
            s = _merge_adjacent_tags(s).strip()
        else:
            its.sort(key=lambda i: i["x"])  # 줄 안 x(왼→오) 순서
            s = "".join(i["t"] for i in its).strip()
        if s:
            out.append(s)
    return " ".join(out).strip()


def _merge_adjacent_tags(s):
    """인접한 같은 태그 병합: <sub>2</sub><sub>s</sub> → <sub>2s</sub> (깔끔·안정)."""
    s = re.sub(r"</sub>\s*<sub>", "", s)
    s = re.sub(r"</sup>\s*<sup>", "", s)
    return s


def _nonfig_rect(block, figs=None):
    """그림 영역 줄을 뺀, '번역 대상 줄들'만의 bbox.

    render 가 이 사각형만 덮고/그리도록 해서, 캡션에 붙어 있던 축 라벨(V(R_AB))을
    지우거나 그 위에 한글을 그리지 않게 한다(축 라벨은 영어 원본 그대로 유지).
    """
    r = None
    caption_band = _caption_band(block)
    for ln in block.get("lines", []):
        line_bbox = ln.get("bbox", (0, 0, 0, 0))
        caption_line = bool(
            caption_band is not None
            and caption_band[0] - 1.0 <= float(line_bbox[1]) <= caption_band[1] + 1.0
        )
        if not caption_line and _line_in_figs(line_bbox, figs):
            continue
        lr = fitz.Rect(ln["bbox"])
        r = lr if r is None else (r | lr)
    return r if r is not None else fitz.Rect(block["bbox"])


_BOLD_NAME = ("bold", "black", "heavy", "semibold", "-bd", "-bold", "medi")
_ITAL_NAME = ("italic", "oblique", "-it", "-ital")


def dominant_size_color(block):
    """글자 수 기준으로 가장 많이 쓰인 폰트 크기·색과, 블록의 볼드/이탤릭 여부를 고른다.

    본문은 보통 단일 크기/색이고, 제목 블록은 그 블록의 크기를 따른다. 굵게/기울임은
    span flags(16=bold, 2=italic) + 폰트명으로 판정하며, 블록 글자의 과반이 그 스타일일
    때 True(제목·강조 줄을 번역본에도 굵게/기울임으로 반영).
    """
    sizes = defaultdict(float)
    colors = defaultdict(float)
    bold_n = ital_n = total_n = 0.0
    for ln in block.get("lines", []):
        for sp in ln.get("spans", []):
            n = max(1, len(sp.get("text", "")))
            sizes[round(float(sp.get("size", 10.0)), 1)] += n
            colors[int(sp.get("color", 0))] += n
            flags = int(sp.get("flags", 0))
            fn = (sp.get("font", "") or "").lower()
            if (flags & 16) or any(k in fn for k in _BOLD_NAME):
                bold_n += n
            if (flags & 2) or any(k in fn for k in _ITAL_NAME):
                ital_n += n
            total_n += n
    size = max(sizes, key=sizes.get) if sizes else 10.0
    color = max(colors, key=colors.get) if colors else 0
    bold = total_n > 0 and bold_n >= 0.6 * total_n
    italic = total_n > 0 and ital_n >= 0.6 * total_n
    return size, color, bold, italic


def has_letters(s):
    """알파벳/한글 등 '글자'가 하나라도 있는지. 순수 숫자·기호 블록은 번역 제외."""
    return any(ch.isalpha() for ch in s)


# 수식 신호: 그리스·연산자·괄호조각·관계기호 등(수식폰트 외 ASCII 로 추출되는 식 대비).
_MATH_SIGN = re.compile(r"[Α-Ωα-ωϑϕϱ϶ϰ=±×÷√∞∫∑∏∂∇≤≥≈≠≡⎛⎝⎞⎠⎜⎟⌈⌉⌊⌋·−→←↔⇌]")


def _has_ordinary_font_prose(block):
    """Return whether a block contains any translatable natural-language word.

    Stacked fractions and other 2-D equations often mix mathematical fonts with
    ordinary roman-font unit literals (``h``, ``min``, ``km``).  Conversely, a
    wrapped prose sentence can have the same vertically separated / overlapping
    line geometry as a fraction, especially when its final row is short.  Geometry
    therefore cannot authorize KEEP when an ordinary-font word is present.

    This deliberately operates at span level: words drawn in a math font remain
    formula identifiers, while ordinary-font mathematical functions, units,
    acronyms and one-letter variables use the same narrow literal vocabulary as
    the formula-only response contract.  Compatibility ligatures are expanded for
    classification only, so ``ﬁnd`` is recognized as prose without touching the
    authoritative source glyph stream.
    """
    sizes = [
        float(span.get("size", 0) or 0)
        for line in block.get("lines", [])
        for span in line.get("spans", [])
        if str(span.get("text", "")).strip()
    ]
    if not sizes:
        return False
    body_size = 0.8 * max(sizes)
    for line in block.get("lines", []):
        for span in line.get("spans", []):
            if float(span.get("size", 0) or 0) < body_size:
                continue
            font = str(span.get("font", ""))
            if any(key in font for key in _MATH_FONT_KEYS):
                continue
            decoded = _fix_span_text(font, span.get("text", ""), span=span)
            decoded = _normalize_redrawn_latin_ligatures(decoded)
            for raw in re.findall(r"[A-Za-z]+(?:-[A-Za-z]+)*", decoded):
                lowered = raw.lower()
                if (
                    lowered in _FORMULA_LITERAL_WORDS
                    or len(raw) == 1
                    or raw == raw.upper()
                    or _looks_like_glued_math_identifier(raw)
                ):
                    continue
                return True
            if re.search(r"[가-힣]{2,}", decoded):
                return True
    return False


def _is_stacked_math(block):
    """위아래로 쌓인 2D 수식(분수 num/denom, (m/V), 루이스 점 구조 H:N:N:H 등)인지.

    판정: 같은 x 범위에 '세로로 떨어져 겹치는' 줄(y-band)이 2개 이상이고(=적층),
    본문 단어가 거의 없을 때(프로즈 제외). 이런 블록은 x-정렬로 한 줄로 못 펴서
    '( ) 1 atm 32.066' 처럼 깨지므로, 표시수식처럼 **원본 글리프를 보존**한다.
    인라인 위/아래첨자((1s)² 의 ²)는 첨자가 x 로 밀려 있어 x-overlap 이 작아 여기
    안 걸린다(그건 block_text 의 x-정렬이 처리). 진짜 분수/루이스만 잡는다."""
    lines = [
        ln for ln in block.get("lines", [])
        if any(s.get("text", "").strip() for s in ln.get("spans", []))
    ]
    if len(lines) < 2:
        return False
    # A wrapped natural-language sentence is never a formula-only KEEP block,
    # even if a short final line overlaps the first line like a numerator and its
    # citation / date supplies the old heuristic's only numeric signal.
    if _has_ordinary_font_prose(block):
        return False
    bands = []  # 시각적 줄(y-band) bbox 들
    for ln in lines:
        b = fitz.Rect(ln["bbox"])
        merged = False
        for k, bd in enumerate(bands):
            if min(b.y1, bd.y1) - max(b.y0, bd.y0) > 0.4 * min(
                max(1.0, b.y1 - b.y0), max(1.0, bd.y1 - bd.y0)
            ):
                bands[k] = bd | b
                merged = True
                break
        if not merged:
            bands.append(b)
    if len(bands) < 2:
        return False
    stacked = False
    for i in range(len(bands)):
        for j in range(i + 1, len(bands)):
            a, c = bands[i], bands[j]
            if a.y1 <= c.y0 or c.y1 <= a.y0:  # 세로로 분리된 두 band
                ox = min(a.x1, c.x1) - max(a.x0, c.x0)
                if ox > 0.3 * min(max(1.0, a.width), max(1.0, c.width)):
                    stacked = True  # x 로 겹침 = 위아래 적층
    if not stacked:
        return False
    raw = _block_raw_text(block)
    # 줄바꿈된 표 머리글·라벨('LCAO MO Notation', 'Atomic orbital (Atom A)')은 긴 단어가
    # 여럿 → 제외(번역 대상). 분수/루이스는 긴 본문 단어가 거의 없다.
    long_words = len(re.findall(r"[A-Za-z]{5,}|[가-힣]{3,}", raw))
    if long_words > 1:
        return False
    # 추가로 '수식 신호'가 있어야 식으로 본다 — 숫자/수식기호가 있거나, 알파 토큰
    # 대부분이 1~2글자(변수 m·V, 원소기호 H·N). 이래야 'LCAO MO Notation'(긴단어 1개,
    # 신호 없음) 같은 머리글이 식으로 오인돼 영어로 남지 않는다.
    has_digit = bool(re.search(r"\d", raw))
    has_sign = bool(_MATH_SIGN.search(raw)) or "/" in raw
    toks = re.findall(r"[A-Za-z가-힣]+", raw)
    short_ratio = (sum(1 for t in toks if len(t) <= 2) / len(toks)) if toks else 1.0
    # 소문자가 전혀 없으면 = 전부 대문자 원소기호/식(루이스 H:N:N:H 의 HHNNHH 등).
    # 머리글('Notation')은 소문자가 있어 여기서 걸러진다.
    no_lowercase = not re.search(r"[a-z]", raw)
    return has_digit or has_sign or short_ratio >= 0.6 or no_lowercase


def _keep_original_block(block):
    """번역하지 않고 **원본 글리프를 그대로 둘** 블록인지 판정.

    원칙(사용자 피드백): 문장 안 인라인 수식은 평소대로 번역하고, **독립(중앙배열)
    수식·기호 라벨은 원본 그대로 둔다**. 구분 신호는 '본문 단어 유무':
      - 영문 3글자+ 연속 단어가 있으면 = 문장(인라인 수식 포함) → 번역(False).
      - 단어가 없고 수식/기호(수식폰트 또는 그리스·연산자·괄호조각·= 등)가 있으면
        = 독립 표시수식([6.1] 같은 박스 식)·오비탈 라벨(1σg)·수식 조각 → 원본 유지(True).
    원본 유지하면 재그리기를 안 해, 2D 식이 흩어져 깨지던 표시 수식이 원본대로 보인다.
    단어 판정은 _has_word(본문 크기 span 만) — ψ^bond 처럼 작은 라벨에 단어가 있어도
    표시수식을 번역으로 오인하지 않는다."""
    raw = block_text(block)
    if (
        _FORMULA_LEADING_PROSE_FRAGMENT_RE.search(raw)
        or _FORMULA_TRAILING_SPLIT_WORD_RE.search(raw)
    ):
        return False
    if block.get("_preserve_formula"):
        return True
    if _is_stacked_math(block):
        return True  # 위아래로 쌓인 2D 수식(분수·루이스) → 원본 보존(x-정렬 불가)
    # Use the exact tagged representation emitted by cmd_extract.  Formula-only
    # blocks must never make a model/render round trip: even an identity string can
    # flatten a stacked fraction or replace a visually correct legacy glyph map.
    if _formula_only_visible_text(block_text(block, tag=True)):
        return True
    math_words = {
        "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
        "sinh", "cosh", "tanh", "log", "ln", "exp", "lim", "min", "max", "mod",
    }
    prose_words = []
    has_lowercase_stopword = False
    for word in re.findall(r"[A-Za-z]{2,}", raw):
        lower = word.lower()
        if word == lower and lower in _FORMULA_PROSE_STOPWORDS:
            has_lowercase_stopword = True
        # Broken word spacing in formula fonts can yield zsin/ycos.  A single
        # variable prefix followed by a known function is still equation syntax.
        prefixed_function = len(lower) > 1 and lower[0].isalpha() and lower[1:] in math_words
        if lower not in math_words and not prefixed_function:
            prose_words.append(lower)
    if has_lowercase_stopword:
        return False
    if _has_word(block) and prose_words:
        return False  # 본문 문장(인라인 수식 포함) → 번역
    has_math_font = False
    has_sign = False
    nchar = 0
    for ln in block.get("lines", []):
        for sp in ln.get("spans", []):
            fn = sp.get("font", "")
            txt = _fix_span_text(fn, sp.get("text", ""), span=sp)  # 디코드 후 판정
            nchar += sum(1 for c in txt if not c.isspace())
            if any(k in fn for k in _MATH_FONT_KEYS):
                has_math_font = True
            if _MATH_SIGN.search(txt):
                has_sign = True
    if not nchar:
        return False
    # 수식/기호 신호가 있어야 '식' — 단순 숫자·문장부호(2 225, [6.1])는 번역(원본유지 아님).
    if not has_math_font and not has_sign:
        return False
    return True


# ── 배경색 샘플링 (그림/그래프 위 텍스트 판별 + 색 맞춤 redaction) ───────────────
def _sample_pixmap(page):
    """배경색 샘플링용 페이지 픽스맵(zoom 1 → 1pt = 1px, 좌표 그대로 사용)."""
    _assert_safe_pixmap_geometry(page.rect, 1.0, "background sample")
    return page.get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False)


def _quant(px):
    return (px[0] // 16 * 16, px[1] // 16 * 16, px[2] // 16 * 16)


def _bg_in_rect(pix, rect):
    """rect 영역의 최빈색(=배경; 글자 잉크는 소수) 추정. 실패 시 None."""
    x0, y0 = max(0, int(rect.x0)), max(0, int(rect.y0))
    x1, y1 = min(pix.width, int(rect.x1)), min(pix.height, int(rect.y1))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    counts = {}
    sx, sy = max(1, (x1 - x0) // 12), max(1, (y1 - y0) // 6)
    yy = y0
    while yy < y1:
        xx = x0
        while xx < x1:
            try:
                q = _quant(pix.pixel(xx, yy))
                counts[q] = counts.get(q, 0) + 1
            except Exception:
                pass
            xx += sx
        yy += sy
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]


def _page_bg(pix):
    """모서리·여백 픽셀의 최빈색 = 페이지 배경색."""
    w, h = pix.width, pix.height
    pts = []
    for xx, yy in [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3), (w // 2, 2), (2, h // 2)]:
        try:
            pts.append(_quant(pix.pixel(xx, yy)))
        except Exception:
            pass
    if not pts:
        return (240, 240, 240)
    counts = {}
    for p in pts:
        counts[p] = counts.get(p, 0) + 1
    return max(counts.items(), key=lambda kv: kv[1])[0]


def _cdist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def _bg_around(pix, rect, m=3):
    """블록 '바로 바깥' 테두리의 정확한 최빈색 = 주변 배경색(글자 잉크가 없어 깨끗).
    이 색으로 덮으면 redaction 이 주변과 똑같아져 '상자' 경계가 안 보인다."""
    x0, y0, x1, y1 = int(rect.x0), int(rect.y0), int(rect.x1), int(rect.y1)
    W, H = pix.width, pix.height
    counts = {}

    def add(x, y):
        if 0 <= x < W and 0 <= y < H:
            try:
                p = pix.pixel(x, y)
                counts[p] = counts.get(p, 0) + 1
            except Exception:
                pass

    sy = max(1, (y1 - y0) // 8)
    sx = max(1, (x1 - x0) // 12)
    y = y0
    while y < y1:
        add(x0 - m, y)
        add(x1 + m - 1, y)
        y += sy
    x = x0
    while x < x1:
        add(x, y0 - m)
        add(x, y1 + m - 1)
        x += sx
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]  # 정확한 색(양자화 안 함)


def _cluster_rects(rects, gap=18.0):
    """가까운 사각형들을 묶는다(1패스 greedy). 그래프 라인아트 영역 잡기용."""
    clusters = []
    for r in rects:
        placed = False
        for c in clusters:
            cb = c["bbox"]
            # PyMuPDF Rect.intersects는 가로/세로 선처럼 폭이나 높이가 0인 path와의
            # 접촉을 False로 본다. 그래프 축·사각 프레임은 그런 선 path가 대부분이므로
            # 좌표 거리로 직접 판정해 합법적 line-art cluster를 놓치지 않는다.
            nearby = not (
                r.x1 < cb.x0 - gap
                or r.x0 > cb.x1 + gap
                or r.y1 < cb.y0 - gap
                or r.y0 > cb.y1 + gap
            )
            if nearby:
                c["bbox"] = cb | r
                c["n"] += 1
                placed = True
                break
        if not placed:
            clusters.append({"bbox": fitz.Rect(r), "n": 1})
    return clusters


def _figure_regions(page):
    """그림/그래프 영역 = 이미지 + '윤곽선' vector drawing(선·곡선·축·화살표·격자)을
    함께 묶은 클러스터. 배경 채움(fill-only) 사각형(색 배너 등)은 제외 → 배너 위 본문을
    figure 로 오인하지 않는다. 임베디드 raster occurrence는 path 수와 무관하게 독립
    후보이며, 같은 픽셀이 여러 위치에 배치되면 각 bbox를 별도 occurrence로 유지한다."""
    image_regions = []
    seen_image_rects = set()
    try:
        for im in page.get_images(full=True):
            for r in page.get_image_rects(im[0]):
                rr = fitz.Rect(r)
                key = tuple(round(v, 2) for v in (rr.x0, rr.y0, rr.x1, rr.y1))
                if key not in seen_image_rects:
                    seen_image_rects.add(key)
                    image_regions.append(rr)
    except Exception:
        pass
    drawing_elems = []
    try:
        for d in page.get_drawings():
            if "s" in (d.get("type") or ""):  # 윤곽선 path
                drawing_elems.append(fitz.Rect(d["rect"]))
    except Exception:
        pass
    text_rect = _page_text_rect(page)
    page_area = text_rect.width * text_rect.height
    # 거의 전면을 덮는 raster는 스캔 페이지 배경일 가능성이 높아 텍스트-PDF의 본문
    # 그림으로 취급하지 않는다. 실제 스캔 문서는 별도 OCR/비전 라우팅이 담당한다.
    regions = [
        r
        for r in image_regions
        if r.width > 0 and r.height > 0 and r.width * r.height < 0.88 * page_area
    ]
    for c in _cluster_rects(drawing_elems):
        b = c["bbox"]
        if (
            c["n"] >= 4
            and b.width > 50
            and b.height > 50
            and b.width * b.height < 0.88 * page_area
        ):
            # raster 위에 그려진 축/화살표 cluster라면 하나의 occurrence로 합친다.
            # 그렇지 않으면 독립 vector figure로 보존한다.
            merged = False
            for i, existing in enumerate(regions):
                inter = fitz.Rect(existing) & b
                min_area = max(1.0, min(abs(existing), abs(b)))
                if not inter.is_empty and abs(inter) >= 0.5 * min_area:
                    regions[i] = fitz.Rect(existing) | b
                    merged = True
                    break
            if not merged:
                regions.append(b)
    return regions


def _table_regions(page, min_rules=2):
    """가로 rule(테두리 선)로 표 영역을 추정한다. PyMuPDF find_tables 가 못 잡는
    booktabs형(세로선 없이 가로줄만 있는) 표를 잡기 위함. 인접한(가로로 겹치고 가까운)
    가로줄 ≥2개가 만드는 세로 구간을 표로 본다 → in-place 가 표 셀을 줄글로 뭉개지
    않도록 그 영역 텍스트를 영어 원본 그대로 둔다(그림과 동일 취급)."""
    text_rect = _page_text_rect(page)
    W = text_rect.width
    H = text_rect.height
    # A browser-style hyperlink underline is also a horizontal drawing rule.  Two
    # adjacent URL lines used to satisfy the booktabs heuristic and become a fake
    # table, which excluded both URLs from redraw and put their residual source text
    # ahead of every translated stream.  Link annotation geometry gives us a much
    # stronger signal than stroke colour or width, so reject only rules which hug a
    # URI annotation's lower edge and span the same horizontal interval.
    uri_rects = []
    try:
        for link in page.get_links():
            if int(link.get("kind", -1)) != int(fitz.LINK_URI):
                continue
            rect = fitz.Rect(link.get("from"))
            if not rect.is_empty and rect.width > 0:
                uri_rects.append(rect)
    except Exception:
        uri_rects = []

    def _is_uri_underline(x0, y, x1):
        width = max(1.0, x1 - x0)
        for link_rect in uri_rects:
            overlap = min(x1, link_rect.x1) - max(x0, link_rect.x0)
            endpoint_error = abs(x0 - link_rect.x0) + abs(x1 - link_rect.x1)
            if (
                overlap >= 0.90 * min(width, link_rect.width)
                and endpoint_error <= max(5.0, 0.06 * width)
                and min(abs(y - link_rect.y0), abs(y - link_rect.y1)) <= 3.0
            ):
                return True
        return False

    def _is_running_margin_rule(x0, y, x1):
        """Reject a page-header/footer separator before table clustering.

        A full-width running-head rule combined with a nearby illustration rule
        creates a giant false table spanning both columns.  Its protected region
        then hides the section heading and adjacent prose from extraction.  Real
        tables cannot use a rule in the outer 8% page margin while also spanning
        most of the printable page width.
        """
        width = max(1.0, x1 - x0)
        outer_margin = y <= 0.08 * H or y >= 0.92 * H
        return outer_margin and width >= 0.70 * W

    rules = []  # (x0, y, x1) 가로줄
    try:
        for dr in page.get_drawings():
            for it in dr.get("items", []):
                if it[0] == "l":  # line
                    p1, p2 = it[1], it[2]
                    if abs(p1.y - p2.y) < 1.6 and abs(p2.x - p1.x) > 0.22 * W:
                        x0 = min(p1.x, p2.x)
                        y = (p1.y + p2.y) / 2.0
                        x1 = max(p1.x, p2.x)
                        if (
                            not _is_uri_underline(x0, y, x1)
                            and not _is_running_margin_rule(x0, y, x1)
                        ):
                            rules.append((x0, y, x1))
                elif it[0] == "re":  # 얇은 사각형 = 가로줄
                    r = fitz.Rect(it[1])
                    if r.height < 2.2 and r.width > 0.22 * W:
                        y = (r.y0 + r.y1) / 2.0
                        if (
                            not _is_uri_underline(r.x0, y, r.x1)
                            and not _is_running_margin_rule(r.x0, y, r.x1)
                        ):
                            rules.append((r.x0, y, r.x1))
    except Exception:
        return []
    if len(rules) < min_rules:
        return []
    rules.sort(key=lambda t: t[1])
    # 가로로 겹치고 세로로 가까운(<230pt) 줄들을 한 표로 묶는다. y 순서에서 서로
    # 끼어드는 오른쪽 그래프 격자선이 왼쪽 표 그룹을 끊으면 안 되므로, 직전의 *전역*
    # rule이 아니라 각 기존 x-band 그룹의 마지막 rule과 비교한다.
    groups = []
    for rule in rules:
        candidates = []
        for group_index, group in enumerate(groups):
            previous = group[-1]
            overlap = min(rule[2], previous[2]) - max(rule[0], previous[0])
            minimum_width = max(
                1.0, min(rule[2] - rule[0], previous[2] - previous[0])
            )
            vertical_gap = rule[1] - previous[1]
            if overlap > 0.5 * minimum_width and 0 <= vertical_gap < 230:
                candidates.append(
                    (overlap / minimum_width, -vertical_gap, group_index)
                )
        if candidates:
            _overlap, _gap, chosen = max(candidates)
            groups[chosen].append(rule)
        else:
            groups.append([rule])
    out = []
    for g in groups:
        if len(g) < min_rules:
            continue
        x0 = min(r[0] for r in g)
        x1 = max(r[2] for r in g)
        y0 = min(r[1] for r in g)
        y1 = max(r[1] for r in g)
        if (x1 - x0) > 0.2 * W and 4 < (y1 - y0) < 0.85 * H:
            out.append(fitz.Rect(x0, y0, x1, y1))
    return out


_TABLE_BLOCK_PREFIX = "__pdf_table_cell__:"


def _rect_overlap_fraction(a, b):
    """Intersection area divided by the smaller rectangle area."""
    a = fitz.Rect(a)
    b = fitz.Rect(b)
    inter = a & b
    if inter.is_empty:
        return 0.0
    return abs(inter) / max(1.0, min(abs(a), abs(b)))


def _raw_table_region_has_repeated_multicolumn_evidence(page, rect):
    """Prove that an otherwise ambiguous ruled region contains table-like rows.

    Horizontal separators and rounded information panels are common in reports.
    Protecting every pair of long rules as a table drops the prose between them
    from extraction.  For a raw rule region which has no validated ``find_tables``
    layout, require at least two visual rows with two stable, widely separated cell
    starts.  Ordinary prose keeps normal inter-word gaps and therefore forms one
    cell per line.
    """
    rect = fitz.Rect(rect)
    try:
        words = page.get_text("words", clip=rect, sort=False)
    except TypeError:
        try:
            words = page.get_text("words", clip=rect)
        except Exception:
            return False
    except Exception:
        return False

    items = []
    for word in words or []:
        if len(word) < 5 or not str(word[4]).strip():
            continue
        box = fitz.Rect(word[:4])
        cx = (box.x0 + box.x1) / 2.0
        cy = (box.y0 + box.y1) / 2.0
        if not (rect.x0 - 0.5 <= cx <= rect.x1 + 0.5):
            continue
        if not (rect.y0 - 0.5 <= cy <= rect.y1 + 0.5):
            continue
        items.append({"rect": box, "cy": cy})
    if len(items) < 4:
        return False

    # Cluster words by baseline band without trusting producer block IDs: table
    # producers often merge an entire row into a single text block.
    rows = []
    for item in sorted(items, key=lambda value: (value["cy"], value["rect"].x0)):
        candidates = []
        for index, row in enumerate(rows):
            tolerance = max(2.5, 0.45 * max(row["height"], item["rect"].height))
            if abs(item["cy"] - row["cy"]) <= tolerance:
                candidates.append((abs(item["cy"] - row["cy"]), index))
        if candidates:
            _distance, index = min(candidates)
            row = rows[index]
            row["items"].append(item)
            row["cy"] = sum(value["cy"] for value in row["items"]) / len(row["items"])
            row["height"] = max(row["height"], item["rect"].height)
        else:
            rows.append(
                {"items": [item], "cy": item["cy"], "height": item["rect"].height}
            )

    multi_rows = []
    for row in rows:
        ordered = sorted(row["items"], key=lambda value: value["rect"].x0)
        cell_starts = [ordered[0]["rect"].x0]
        previous = ordered[0]["rect"]
        for item in ordered[1:]:
            current = item["rect"]
            # A normal space is only a few points.  Requiring both an absolute and
            # font-relative gap keeps wrapped / justified prose from masquerading
            # as columns while accepting compact scientific tables.
            minimum_gap = max(12.0, 1.25 * max(previous.height, current.height))
            if current.x0 - previous.x1 >= minimum_gap:
                cell_starts.append(current.x0)
            previous = current
        if len(cell_starts) >= 2:
            multi_rows.append(cell_starts)
    if len(multi_rows) < 2:
        return False

    tolerance = max(10.0, 0.035 * rect.width)
    for index, first in enumerate(multi_rows):
        for second in multi_rows[index + 1 :]:
            available = list(second)
            matches = 0
            for anchor in first:
                choices = [
                    (abs(anchor - candidate), position)
                    for position, candidate in enumerate(available)
                    if abs(anchor - candidate) <= tolerance
                ]
                if not choices:
                    continue
                _distance, position = min(choices)
                available.pop(position)
                matches += 1
            if matches >= 2:
                return True
    return False


def _region_has_non_table_art(page, rect):
    """Detect plotted curves/diagonals or raster art inside a table candidate."""
    rect = fitz.Rect(rect)
    try:
        for image in page.get_images(full=True):
            for image_rect in page.get_image_rects(image[0]):
                if _rect_overlap_fraction(rect, image_rect) >= 0.20:
                    return True
    except Exception:
        pass
    try:
        for drawing in page.get_drawings():
            drawing_rect = fitz.Rect(drawing.get("rect") or (0, 0, 0, 0))
            if _rect_overlap_fraction(rect, drawing_rect) <= 0.01:
                continue
            for item in drawing.get("items", []):
                if item[0] in {"c", "qu"}:  # Bezier / quad: plotted curve or shape
                    return True
                if item[0] == "l":
                    start, end = item[1], item[2]
                    if abs(start.x - end.x) > 1.6 and abs(start.y - end.y) > 1.6:
                        return True
    except Exception:
        pass
    return False


def _raw_text_block_in_rect(page, rect, raw_data=None):
    """Build one synthetic text block from glyphs whose centres are in ``rect``.

    Table producers frequently emit an entire row as one MuPDF block (and, in the
    fixture corpus, as strings such as ``TrialTime sDistance m``).  Assigning raw
    characters to a server-derived cell rectangle is deterministic and avoids
    trusting whitespace or the model to rediscover the columns.  The returned
    object uses the ordinary block/line/span schema so the existing decoder,
    scientific-markup handling and font/style code can be reused unchanged.
    """
    rect = fitz.Rect(rect)
    lines_out = []
    block_rect = None
    if raw_data is None:
        try:
            raw_data = page.get_text("rawdict")
        except Exception:
            return None
    for block in raw_data.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            spans_out = []
            line_rect = None
            for span in line.get("spans", []):
                chars = []
                char_rect = None
                for char in span.get("chars", []):
                    box = fitz.Rect(char.get("bbox") or (0, 0, 0, 0))
                    cx = (box.x0 + box.x1) / 2.0
                    cy = (box.y0 + box.y1) / 2.0
                    if not (rect.x0 - 0.25 <= cx <= rect.x1 + 0.25):
                        continue
                    if not (rect.y0 - 0.25 <= cy <= rect.y1 + 0.25):
                        continue
                    chars.append(str(char.get("c", "")))
                    char_rect = box if char_rect is None else (char_rect | box)
                if not chars or char_rect is None:
                    continue
                text = "".join(chars)
                if not text:
                    continue
                synthetic_span = {
                    key: copy.deepcopy(value)
                    for key, value in span.items()
                    if key not in {"chars", "bbox", "origin"}
                }
                synthetic_span["text"] = text
                synthetic_span["bbox"] = tuple(char_rect)
                spans_out.append(synthetic_span)
                line_rect = char_rect if line_rect is None else (line_rect | char_rect)
            if not spans_out or line_rect is None:
                continue
            synthetic_line = {
                key: copy.deepcopy(value)
                for key, value in line.items()
                if key not in {"spans", "bbox"}
            }
            synthetic_line["spans"] = spans_out
            synthetic_line["bbox"] = tuple(line_rect)
            lines_out.append(synthetic_line)
            block_rect = line_rect if block_rect is None else (block_rect | line_rect)
    if not lines_out or block_rect is None:
        return None
    lines_out.sort(key=lambda line: (line["bbox"][1], line["bbox"][0]))
    return {"type": 0, "bbox": tuple(block_rect), "lines": lines_out}


def _table_text_is_safe_candidate(
    page, cells, table_rect, *, text_strategy=False, backed_by_rules=False
):
    """Reject chart grids and prose columns before exposing table-cell IDs.

    A ruled table has strong geometry evidence.  A borderless table is accepted
    only when at least three compact, consistently populated rows are present and
    its cells look like labels/data rather than sentence columns.  Ambiguous
    geometry remains in the protected table region, so untranslated-language
    postflight fails closed instead of flattening it into prose.
    """
    populated = []
    row_counts = Counter()
    col_counts = Counter()
    for cell in cells:
        value = cell.get("value")
        text = str(value).strip() if isinstance(value, str) else ""
        if not text:
            block = _raw_text_block_in_rect(page, cell["rect"])
            text = block_text(block) if block is not None else ""
        if not text.strip():
            continue
        populated.append(text.strip())
        row_counts[cell["row"]] += 1
        col_counts[cell["col"]] += 1
    if len(populated) < 3 or len(row_counts) < 2 or len(col_counts) < 2:
        return False
    if len(populated) / max(1, len(cells)) < 0.35:
        return False
    if not any(any(char.isalpha() for char in text) for text in populated):
        return False
    page_rect = _page_text_rect(page)
    table_rect = fitz.Rect(table_rect)
    if (
        table_rect.width <= 8
        or table_rect.height <= 4
        or table_rect.width > 0.96 * page_rect.width
        or table_rect.height > 0.80 * page_rect.height
    ):
        return False
    if not text_strategy:
        return True

    # Borderless inference must be deliberately strict.  This excludes two-column
    # prose (long, punctuated cells) while retaining ordinary short data tables.
    # MuPDF's text strategy can turn justified book prose into five or six narrow
    # "columns" simply because word starts happen to align on consecutive lines.
    # Require independently observed whitespace-separated column starts before
    # accepting *any* text-strategy layout, including one near horizontal rules.
    # The latter matters for textbooks whose running-header rule can be grouped
    # with the top edge of a large illustration and falsely look like booktabs.
    if not _raw_table_region_has_repeated_multicolumn_evidence(page, table_rect):
        return False
    if backed_by_rules:
        return True
    if len(row_counts) < 3 or table_rect.height > 0.38 * page_rect.height:
        return False
    column_count = max(2, len(col_counts))
    well_populated = sum(1 for value in row_counts.values() if value >= 2)
    if well_populated < max(2, int(math.ceil(0.75 * len(row_counts)))):
        return False
    if any(len(text) > 80 for text in populated):
        return False
    prose_like = sum(
        1
        for text in populated
        if len(re.findall(r"[A-Za-z]{2,}|[\uac00-\ud7a3]{2,}", text)) >= 5
        or bool(re.search(r"[.!?;:]\s*$", text))
    )
    return prose_like <= max(1, len(populated) // (2 * column_count))


def _finder_table_cells(table, *, text_strategy=False, outer_rect=None):
    """Normalize a PyMuPDF table (including merged cells) to stable rectangles."""
    extracted = []
    try:
        values = table.extract()
    except Exception:
        values = []
    raw_rows = []
    for row_index, row in enumerate(getattr(table, "rows", []) or []):
        row_values = values[row_index] if row_index < len(values) else []
        entries = []
        for col_index, cell_rect in enumerate(getattr(row, "cells", []) or []):
            if cell_rect is None:
                continue
            value = row_values[col_index] if col_index < len(row_values) else None
            entries.append((col_index, fitz.Rect(cell_rect), value))
        if entries:
            raw_rows.append((row_index, entries))
    if not raw_rows:
        return []

    if not text_strategy:
        seen = set()
        for row_index, entries in raw_rows:
            for col_index, rect, _value in entries:
                key = tuple(round(number, 3) for number in rect)
                if key in seen:
                    continue
                seen.add(key)
                extracted.append(
                    {
                        "row": row_index,
                        "col": col_index,
                        "rect": rect,
                        "value": _value,
                    }
                )
        return extracted

    # Text strategy inserts empty separator rows and uses the next word's x as a
    # column edge.  Keep only rows with visible content and rebuild conservative
    # row/outer-column bounds.  This also captures a trailing unit which MuPDF's
    # tight last-cell bbox can otherwise omit.
    populated_rows = []
    for _source_row, entries in raw_rows:
        nonempty = [
            (column, rect, value)
            for column, rect, value in entries
            if isinstance(value, str) and value.strip()
        ]
        if nonempty:
            populated_rows.append(nonempty)
    if len(populated_rows) < 2:
        return []
    column_count = (
        max(
            max(column for column, _rect, _value in row)
            for row in populated_rows
        )
        + 1
    )
    starts = [None] * column_count
    ends = [None] * column_count
    for row in populated_rows:
        for column, rect, _value in row:
            starts[column] = (
                rect.x0
                if starts[column] is None
                else min(starts[column], rect.x0)
            )
            ends[column] = (
                rect.x1
                if ends[column] is None
                else max(ends[column], rect.x1)
            )
    if sum(value is not None for value in starts) < 2:
        return []
    known_starts = [value for value in starts if value is not None]
    gaps = [b - a for a, b in zip(known_starts, known_starts[1:]) if b - a > 2]
    typical_gap = sorted(gaps)[len(gaps) // 2] if gaps else 50.0
    table_box = fitz.Rect(outer_rect or getattr(table, "bbox", (0, 0, 0, 0)))
    x_bounds = [
        table_box.x0
        if outer_rect is not None
        else max(0.0, known_starts[0] - 0.35 * typical_gap)
    ]
    for column in range(1, column_count):
        start = starts[column]
        if start is None:
            return []
        x_bounds.append(start)
    x_bounds.append(
        table_box.x1
        if outer_rect is not None
        else max(
            max(value for value in ends if value is not None) + 3.0,
            known_starts[-1] + 0.65 * typical_gap,
        )
    )

    row_centres = []
    for row in populated_rows:
        row_centres.append(
            sum((rect.y0 + rect.y1) / 2.0 for _column, rect, _value in row) / len(row)
        )
    y_bounds = []
    if outer_rect is not None:
        y_bounds.append(table_box.y0)
    else:
        first_heights = [rect.height for _column, rect, _value in populated_rows[0]]
        y_bounds.append(row_centres[0] - 0.65 * max(first_heights or [10.0]))
    for previous, current in zip(row_centres, row_centres[1:]):
        y_bounds.append((previous + current) / 2.0)
    if outer_rect is not None:
        y_bounds.append(table_box.y1)
    else:
        last_heights = [rect.height for _column, rect, _value in populated_rows[-1]]
        y_bounds.append(row_centres[-1] + 0.65 * max(last_heights or [10.0]))

    for row_index, row in enumerate(populated_rows):
        present = {column for column, _rect, _value in row}
        for column in range(column_count):
            if column not in present:
                continue
            rect = fitz.Rect(
                x_bounds[column], y_bounds[row_index],
                x_bounds[column + 1], y_bounds[row_index + 1],
            )
            if rect.width > 3 and rect.height > 3:
                value = next(
                    (
                        row_value
                        for row_column, _row_rect, row_value in row
                        if row_column == column
                    ),
                    None,
                )
                extracted.append(
                    {"row": row_index, "col": column, "rect": rect, "value": value}
                )
    return extracted


def _table_layouts(page):
    """Return deterministic, independently renderable table-cell geometry.

    Default line detection handles full grids and merged cells.  The text strategy
    is a fallback for booktabs and borderless tables, guarded by the conservative
    validator above.  Any ruled region which cannot be decomposed safely is omitted
    here but remains in ``_skip_regions`` as protected source content.
    """
    rule_regions = _validate_regions(page, _table_regions(page))
    # Two unrelated long rules can be vertically close: a running-header rule and
    # the top of a figure frame are a common example in books.  Such a pair is not
    # strong table evidence until the text between it also has repeated, stable
    # whitespace-separated columns.  Default line-grid discovery remains usable
    # without this fallback, so this only tightens the text/booktabs path.
    table_like_rule_regions = [
        region
        for region in rule_regions
        if _raw_table_region_has_repeated_multicolumn_evidence(page, region)
    ]
    candidates = []

    def matching_rule_region(rect):
        matches = [
            region
            for region in table_like_rule_regions
            if _rect_overlap_fraction(rect, region) >= 0.60
        ]
        return (
            max(matches, key=lambda region: _rect_overlap_fraction(rect, region))
            if matches
            else None
        )

    finder = getattr(page, "find_tables", None)
    if callable(finder):
        try:
            for table in (finder().tables or []):
                rect = fitz.Rect(table.bbox)
                if _region_has_non_table_art(page, rect):
                    continue
                cells = _finder_table_cells(table)
                backed = matching_rule_region(rect) is not None
                if _table_text_is_safe_candidate(
                    page, cells, rect, text_strategy=False, backed_by_rules=backed
                ):
                    candidates.append({"rect": rect, "cells": cells, "strong": True})
        except Exception:
            pass
        try:
            for table in (finder(strategy="text").tables or []):
                rect = fitz.Rect(table.bbox)
                if _region_has_non_table_art(page, rect):
                    continue
                if any(
                    _rect_overlap_fraction(rect, item["rect"]) >= 0.65
                    for item in candidates
                ):
                    continue
                rule_rect = matching_rule_region(rect)
                cells = _finder_table_cells(
                    table,
                    text_strategy=True,
                    outer_rect=rule_rect,
                )
                effective_rect = fitz.Rect(rule_rect or rect)
                if _table_text_is_safe_candidate(
                    page,
                    cells,
                    effective_rect,
                    text_strategy=True,
                    backed_by_rules=rule_rect is not None,
                ):
                    candidates.append(
                        {
                            "rect": effective_rect,
                            "cells": cells,
                            "strong": rule_rect is not None,
                        }
                    )
        except Exception:
            pass

    # Stable order is part of the extract/render ID contract.
    candidates.sort(
        key=lambda item: (
            item["rect"].y0,
            item["rect"].x0,
            item["rect"].y1,
            item["rect"].x1,
        )
    )
    out = []
    for candidate in candidates:
        if any(
            _rect_overlap_fraction(candidate["rect"], prior["rect"]) >= 0.70
            for prior in out
        ):
            continue
        candidate["cells"].sort(
            key=lambda cell: (
                cell["row"],
                cell["col"],
                cell["rect"].y0,
                cell["rect"].x0,
            )
        )
        out.append(candidate)
    return out


def _table_cell_alignment(text_rect, cell_rect):
    """Infer the source cell's left/centre/right anchor from its glyph bbox."""
    text_rect = fitz.Rect(text_rect)
    cell_rect = fitz.Rect(cell_rect)
    centre_error = abs(
        (text_rect.x0 + text_rect.x1) / 2.0
        - (cell_rect.x0 + cell_rect.x1) / 2.0
    )
    if centre_error <= max(2.0, 0.08 * cell_rect.width):
        return fitz.TEXT_ALIGN_CENTER
    left_gap = max(0.0, text_rect.x0 - cell_rect.x0)
    right_gap = max(0.0, cell_rect.x1 - text_rect.x1)
    if right_gap <= max(3.0, 0.45 * left_gap):
        return fitz.TEXT_ALIGN_RIGHT
    return fitz.TEXT_ALIGN_LEFT


_TABLE_LITERAL_TOKENS = {
    "s", "ms", "us", "ns", "m", "cm", "mm", "km", "kg", "g", "mg",
    "l", "ml", "mol", "mmol", "hz", "khz", "mhz", "v", "mv", "a",
    "ma", "w", "kw", "j", "kj", "pa", "kpa", "mpa", "rpm", "ph", "id",
}
_TABLE_TRANSLATABLE_STATUS_TOKENS = frozenset(
    {
        "PASS", "FAIL", "OK", "HOLD", "YES", "NO", "TRUE", "FALSE",
        "OPEN", "CLOSED", "DONE", "ERROR", "HIGH", "LOW",
    }
)
_CHEMICAL_ELEMENT_SYMBOLS = frozenset(
    """H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni
    Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs
    Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb
    Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt
    Ds Rg Cn Nh Fl Mc Lv Ts Og""".split()
)


def _looks_like_table_chemical_formula(text):
    """Recognize a standalone elemental formula, not arbitrary uppercase prose."""
    compact = re.sub(r"\s+", "", str(text or ""))
    match = re.fullmatch(
        r"((?:[A-Z][a-z]?\d*)+)((?:\d*[+\-−])|(?:[+\-−]\d*))?",
        compact,
    )
    if not match:
        return False
    body, charge = match.groups()
    parts = re.findall(r"([A-Z][a-z]?)(\d*)", body)
    if not parts or any(symbol not in _CHEMICAL_ELEMENT_SYMBOLS for symbol, _n in parts):
        return False
    # A lone element name such as ``A`` is handled as an identifier below.  A
    # molecular formula has multiple elements, a stoichiometric count, or charge.
    return len(parts) >= 2 or any(number for _symbol, number in parts) or bool(charge)


def _table_cell_requires_translation(text, source_block=None):
    """Natural-language cells translate; formulae, measurements and IDs stay exact.

    ``source_block`` is the cell-clipped raw block produced by
    :func:`_raw_text_block_in_rect`.  It is authoritative when the ordinary formula
    classifier proves that the glyph stream must stay original.  Text alone loses
    the font, rise and sub/sup geometry used by that proof (``T_e [K]`` becomes
    ``Te [K]`` after tags are stripped), so independently re-classifying only the
    flattened string can give the same source glyphs two render owners.
    """
    plain = " ".join(_strip_tags(str(text or "")).split())
    if not plain or re.search(r"[\uac00-\ud7a3]", plain):
        return False
    # One invariant governs ordinary blocks and table cells: if the exact clipped
    # cell block is a KEEP block, it belongs solely to the original content stream.
    # Natural-language cells do not satisfy _keep_original_block and therefore
    # continue through the table translation path below.
    if source_block is not None and _keep_original_block(source_block):
        return False
    # Formula-only table headings belong to the source formula stream, not to a
    # synthetic table-cell overlay.  Borderless / booktabs producers commonly
    # encode adjacent headings in one display-math block while table discovery
    # assigns the same glyphs to one or more inferred cells.  Translating that
    # cell would redact only the inferred cell slice, redraw a flattened formula,
    # and leave the rest of the preserved source block on top (for example
    # ``Delta AT | TT - UTC`` becoming ``Delta ATTT - U`` plus a stray ``TC``).
    # The response layer already has a deliberately narrow formula-only contract;
    # reuse it here to give those glyphs exactly one owner.  Natural-language
    # headers (including status labels) continue through the normal cell path.
    if _formula_only_visible_text(plain):
        return False
    upper_plain = plain.upper()
    if upper_plain in _TABLE_TRANSLATABLE_STATUS_TOKENS:
        return True
    if _looks_like_table_chemical_formula(plain):
        return False
    if re.fullmatch(r"[A-Za-z]", plain):
        return False
    # Common row/sample keys combine a short alphabetic prefix with a serial
    # number.  They are stable identifiers rather than natural-language cells.
    if re.fullmatch(r"[A-Za-z]{1,4}\d+[A-Za-z0-9_.-]*", plain):
        return False
    words = re.findall(r"[A-Za-z][A-Za-z-]*", plain)
    if not words:
        return False
    meaningful = [
        word
        for word in words
        if word.lower() not in _TABLE_LITERAL_TOKENS
    ]
    # Single-letter row keys (A/B/C), formulas (NaCl), unit-only cells and numeric
    # measurements remain in their original content streams and exact coordinates.
    return any(
        len(word) >= 2
        and not (
            any(char.islower() for char in word)
            and re.fullmatch(r"(?:[A-Z][a-z]?){2,}", word)
        )
        for word in meaningful
    )


def _table_cell_blocks(page, page_number, layouts=None):
    """Extract independently translatable cells with deterministic string IDs."""
    out = []
    try:
        raw_data = page.get_text("rawdict")
    except Exception:
        raw_data = None
    for table_index, table in enumerate(
        _table_layouts(page) if layouts is None else layouts
    ):
        for cell in table["cells"]:
            block = _raw_text_block_in_rect(page, cell["rect"], raw_data=raw_data)
            if block is None:
                continue
            text = block_text(block, tag=True)
            if not text.strip():
                continue
            source_rect = fitz.Rect(block["bbox"])
            block_id = (
                f"{_TABLE_BLOCK_PREFIX}p{page_number + 1:04d}:"
                f"t{table_index:03d}:r{cell['row']:03d}:c{cell['col']:03d}"
            )
            size, color, bold, italic = dominant_size_color(block)
            out.append(
                {
                    "id": block_id,
                    "page": page_number,
                    "text": text,
                    "source_rect": source_rect,
                    "cell_rect": fitz.Rect(cell["rect"]),
                    "table_rect": fitz.Rect(table["rect"]),
                    "align": _table_cell_alignment(source_rect, cell["rect"]),
                    "size": size,
                    "color": color,
                    "bold": bold,
                    "italic": italic,
                    "translate": _table_cell_requires_translation(text, block),
                }
            )
    return out


def _figure_translation_regions(page, table_regions):
    """Figure regions with table-shaped vector clusters removed.

    A ruled table also satisfies the generic line-art figure heuristic.  Table-cell
    rendering is allowed through that particular cluster, while a neighbouring
    chart/image remains protected byte-for-byte.
    """
    figures = _validate_regions(page, _figure_regions(page))
    return [
        figure
        for figure in figures
        if not any(_rect_overlap_fraction(figure, table) >= 0.70 for table in table_regions)
    ]


def _prose_block_rects(page):
    """페이지의 '본문 산문' 블록 bbox 목록 — 긴 문장(여러 단어)을 담은 블록.
    그림/표 region 오검출(그래프 축선이 표로, 넓은 그림이 본문을 덮음) 판정용.
    표 셀·축 라벨·기호 조각처럼 짧은 텍스트는 산문이 아니다(제외)."""
    out = []
    try:
        data = page.get_text("dict")
    except Exception:
        return out
    for b in data.get("blocks", []):
        if b.get("type") != 0:
            continue
        raw = "".join(
            sp.get("text", "")
            for ln in (b.get("lines") or [])
            for sp in (ln.get("spans") or [])
        )
        letters = sum(1 for c in raw if c.isalpha())
        words = len(re.findall(r"[A-Za-z][A-Za-z]+|[가-힣]{2,}", raw))
        # 진짜 문장: 글자 60+ & 단어 10+ (표 셀/라벨/수식조각은 여기 안 걸린다).
        if letters >= 60 and words >= 10:
            out.append(fitz.Rect(b["bbox"]))
    return out


def _validate_regions(page, regions):
    """그림/표 region 오검출 제거. 본문 산문 블록을 여럿(또는 넓게) 삼키는 region 은
    버린다 — 안 그러면 그 안의 본문이 '영어 원본 유지'로 분류되어 번역에서 통째로
    빠진다(분광 그래프의 축선이 거대한 가짜 '표'로 잡혀 페이지 본문이 미번역되던 버그).
    표 셀·축 라벨만 든 진짜 표/그림은 산문 블록이 0~1개라 그대로 유지된다."""
    if not regions:
        return regions
    proses = _prose_block_rects(page)
    if not proses:
        return regions
    # 실제 이미지가 든 region(진짜 그림)은 절대 버리지 않는다 — 본문 가장자리가 겹쳐도
    # 그림 보호가 우선. 버리는 건 '이미지 없는' 휴리스틱 region 뿐이다(그래프 축선이
    # 거대한 가짜 '표'로 잡히거나, 벡터 전용 클러스터가 본문을 덮는 경우).
    img_rects = []
    try:
        for im in page.get_images(full=True):
            for r in page.get_image_rects(im[0]):
                img_rects.append(fitz.Rect(r))
    except Exception:
        pass
    out = []
    for r in regions:
        has_img = any(
            min(r.x1, i.x1) - max(r.x0, i.x0) > 2
            and min(r.y1, i.y1) - max(r.y0, i.y0) > 2
            for i in img_rects
        )
        if not has_img:
            inside = 0
            area_prose = 0.0
            for pr in proses:
                ix = min(r.x1, pr.x1) - max(r.x0, pr.x0)
                iy = min(r.y1, pr.y1) - max(r.y0, pr.y0)
                if ix > 0 and iy > 0:
                    inter = ix * iy
                    if inter > 0.5 * pr.width * pr.height:  # 블록 과반이 region 안
                        inside += 1
                        area_prose += inter
            ra = max(1.0, r.width * r.height)
            # 본문 산문 2개+ 삼키거나 region 면적의 18%+ 가 본문이면 오검출 → 버림.
            if inside >= 2 or area_prose > 0.18 * ra:
                continue
        out.append(r)
    return out


def _skip_regions(page, table_layouts=None):
    """Ordinary-block exclusion regions: figures plus safely decomposed tables.

    Ruled regions that remain geometrically ambiguous are still protected, while
    validated borderless tables are added from ``_table_layouts`` so their merged
    row blocks cannot be translated a second time as prose.
    """
    raw_tables = list(_table_regions(page))
    layout_rects = []
    try:
        layouts = _table_layouts(page) if table_layouts is None else table_layouts
        layout_rects = [fitz.Rect(table["rect"]) for table in layouts]
    except Exception:
        layouts = []
    # A geometric rule candidate is protected only when the independent table
    # finder validated it or its text itself proves repeated multi-column rows.
    # This keeps ambiguous content fail-closed without hiding single-column prose
    # panels from the translation payload.
    validated_raw_tables = [
        fitz.Rect(region)
        for region in raw_tables
        if any(_rect_overlap_fraction(region, layout) >= 0.60 for layout in layout_rects)
        or _raw_table_region_has_repeated_multicolumn_evidence(page, region)
    ]
    # Prefer the precise cell-derived layout. A coarse rule cluster can span a
    # nearby caption or second-column figure; adding it first caused the smaller
    # proven table rect to be discarded as a duplicate and hid valid prose.
    tables = list(layout_rects)
    tables.extend(validated_raw_tables)
    deduped_tables = []
    for table in tables:
        if any(_rect_overlap_fraction(table, prior) >= 0.90 for prior in deduped_tables):
            continue
        deduped_tables.append(fitz.Rect(table))
    # A default-grid table marked strong has already passed independent cell
    # decomposition and the non-table-art guard.  Do not send that proof through
    # the generic prose-region filter again: a definition table legitimately
    # contains several long prose cells, which otherwise make the filter discard
    # the table and expose both its merged row block and its synthetic cells as
    # competing translation owners.
    strong_tables = [
        fitz.Rect(table["rect"])
        for table in layouts
        if table.get("strong")
    ]
    guarded_candidates = list(_figure_regions(page)) + [
        table
        for table in deduped_tables
        if not any(
            _rect_overlap_fraction(table, strong) >= 0.90
            for strong in strong_tables
        )
    ]
    guarded = _validate_regions(page, guarded_candidates)
    for strong in strong_tables:
        if any(_rect_overlap_fraction(strong, prior) >= 0.90 for prior in guarded):
            continue
        guarded.append(strong)
    return guarded


# Page text is not the only user-visible language in a PDF.  Bookmark titles and
# selected document-info fields are shown by every mainstream reader, so expose
# natural-language values as deterministic virtual translation blocks.  The
# namespace cannot collide with the integer ids produced by iter_text_blocks().
_OUTLINE_BLOCK_PREFIX = "__pdf_outline__:"
_METADATA_BLOCK_PREFIX = "__pdf_metadata__:"
_TRANSLATABLE_METADATA_FIELDS = ("title", "subject", "keywords")
_XMP_MAX_BYTES = 4 * 1024 * 1024
_XMP_RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
_XMP_DC_NS = "http://purl.org/dc/elements/1.1/"
_XMP_PDF_NS = "http://ns.adobe.com/pdf/1.3/"
_XMP_XML_NS = "http://www.w3.org/XML/1998/namespace"
_XMP_DESCRIPTION = f"{{{_XMP_RDF_NS}}}Description"
_XMP_ALT = f"{{{_XMP_RDF_NS}}}Alt"
_XMP_BAG = f"{{{_XMP_RDF_NS}}}Bag"
_XMP_SEQ = f"{{{_XMP_RDF_NS}}}Seq"
_XMP_LI = f"{{{_XMP_RDF_NS}}}li"
_XMP_LANG = f"{{{_XMP_XML_NS}}}lang"
_XMP_TARGET_PROPERTIES = {
    f"{{{_XMP_DC_NS}}}title": "title",
    f"{{{_XMP_DC_NS}}}description": "subject",
    f"{{{_XMP_PDF_NS}}}Keywords": "keywords",
    f"{{{_XMP_DC_NS}}}subject": "keywords",
}
_DEFAULT_METADATA_PLACEHOLDERS = {
    ("title", "untitled"),
    ("subject", "unspecified"),
}


def _is_natural_language_document_label(value, *, metadata_field=None):
    """Conservatively identify user-facing English prose in a short label.

    URLs, paths, identifiers, acronyms and PDF-generator placeholders are kept
    byte-for-byte.  A normal one-word heading such as ``Introduction`` remains
    eligible, while opaque values such as ``RFC``, ``sec_1`` and ``/Fit`` do not.
    """
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text or len(text) > 4096:
        return False
    if metadata_field and (metadata_field, text.lower()) in _DEFAULT_METADATA_PLACEHOLDERS:
        return False
    if any(ord(ch) < 0x20 and ch not in "\t\n\r" for ch in text):
        return False
    if re.fullmatch(r"(?i)(?:https?|ftp|mailto|tel|file):\S+", text):
        return False
    if re.fullmatch(r"(?i)www\.\S+", text) or re.fullmatch(
        r"[^\s@]+@[^\s@]+\.[^\s@]+", text
    ):
        return False
    # A single path / identifier token is not prose.  Natural phrases may still
    # contain punctuation ("Part I - Results") and are handled below.
    if not re.search(r"\s", text) and (
        re.search(r"[/\\_]", text)
        or re.fullmatch(r"[A-Za-z]:.*", text)
        or re.fullmatch(r"[A-Za-z0-9-]+\.[A-Za-z0-9]{1,8}", text)
    ):
        return False
    words = re.findall(r"[A-Za-z]+(?:['’][A-Za-z]+)?", text)
    lexical_words = [
        word
        for word in words
        if len(re.sub(r"[^A-Za-z]", "", word)) >= 3
        # Short all-caps tokens are normally acronyms (RFC, API, GPU).  Longer
        # all-caps headings such as INTRODUCTION or RESULTS are natural language
        # and must not escape translation merely because of typography.
        and not re.fullmatch(r"[A-Z]{2,4}", word)
    ]
    return bool(lexical_words)


def _outline_block_id(index):
    return f"{_OUTLINE_BLOCK_PREFIX}{int(index):06d}"


def _metadata_block_id(field):
    return f"{_METADATA_BLOCK_PREFIX}{field}"


def _xmp_encryption_applies(doc):
    """Return whether the PDF encryption dictionary covers its metadata stream."""
    try:
        if bool(getattr(doc, "needs_pass", False)):
            return True
        value_type, value = doc.xref_get_key(-1, "Encrypt")
    except Exception as exc:
        raise RuntimeError("cannot inspect PDF metadata encryption state") from exc
    if value_type in {"null", "none"} or str(value).strip() in {"", "null"}:
        return False
    match = re.fullmatch(r"\s*(\d+)\s+\d+\s+R\s*", str(value))
    if value_type != "xref" or match is None:
        raise RuntimeError("unsupported PDF encryption dictionary reference")
    encrypt_xref = int(match.group(1))
    try:
        flag_type, flag_value = doc.xref_get_key(encrypt_xref, "EncryptMetadata")
    except Exception as exc:
        raise RuntimeError("cannot inspect PDF EncryptMetadata policy") from exc
    # ISO 32000 defaults EncryptMetadata to true when the key is absent.
    return not (
        flag_type == "bool" and str(flag_value).strip().lower() == "false"
    )


def _parse_document_xmp(doc):
    """Safely parse the source XMP packet, or fail before any output is produced.

    XMP is untrusted upload data.  External entities, DTDs, oversized packets,
    encrypted/inaccessible metadata streams, and malformed XML are rejected rather
    than being silently dropped by ``set_metadata`` or a garbage-collecting save.
    """
    try:
        xref = int(doc.xref_xml_metadata() or 0)
    except Exception as exc:
        raise RuntimeError("cannot locate PDF XMP metadata stream") from exc
    if xref <= 0:
        return None
    if _xmp_encryption_applies(doc):
        raise RuntimeError("encrypted PDF XMP metadata stream is not supported")
    try:
        if not doc.xref_is_stream(xref):
            raise RuntimeError("PDF XMP metadata object is not a stream")
        raw = bytes(doc.xref_stream(xref) or b"")
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError("cannot read PDF XMP metadata stream") from exc
    if not raw:
        raise RuntimeError("PDF XMP metadata stream is empty")
    if len(raw) > _XMP_MAX_BYTES:
        raise RuntimeError(
            f"PDF XMP metadata exceeds {_XMP_MAX_BYTES} byte safety limit"
        )
    if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", raw, flags=re.IGNORECASE):
        raise RuntimeError("PDF XMP metadata contains forbidden DTD/entity markup")
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
        raise RuntimeError("malformed PDF XMP metadata") from exc
    if tree.docinfo.doctype:
        raise RuntimeError("PDF XMP metadata contains a forbidden DTD")
    return {"xref": xref, "raw": raw, "tree": tree}


def _xmp_lang(element):
    return str(element.get(_XMP_LANG) or "").strip().lower()


def _xmp_text_value(element):
    if len(element):
        return None
    value = str(element.text or "").strip()
    return value or None


def _xmp_candidate_bindings(state):
    """Enumerate deterministic semantic XMP values and their mutable nodes.

    RDF Alt policy: x-default is the reader-priority source when it is natural
    language.  Otherwise the first eligible non-Korean alternative is translated.
    Rendering updates a natural x-default, adds/replaces a ko-KR alternative, and
    leaves every non-target language alternative unchanged.
    """
    if state is None:
        return []
    candidates = []
    root = state["tree"].getroot()
    for description in root.iter(_XMP_DESCRIPTION):
        for qname, field in _XMP_TARGET_PROPERTIES.items():
            value = description.get(qname)
            if value is not None:
                candidates.append(
                    {
                        "field": field,
                        "text": str(value),
                        "source": "xmp",
                        "mode": "attribute",
                        "element": description,
                        "attribute": qname,
                    }
                )
        for prop in description:
            field = _XMP_TARGET_PROPERTIES.get(prop.tag)
            if field is None:
                continue
            container = prop[0] if len(prop) == 1 else None
            if container is not None and container.tag == _XMP_ALT:
                alternatives = [child for child in container if child.tag == _XMP_LI]
                x_default = next(
                    (child for child in alternatives if _xmp_lang(child) == "x-default"),
                    None,
                )
                selected = None
                if x_default is not None and _is_natural_language_document_label(
                    _xmp_text_value(x_default), metadata_field=field
                ):
                    selected = x_default
                if selected is None:
                    selected = next(
                        (
                            child
                            for child in alternatives
                            if not _xmp_lang(child).startswith("ko")
                            and _is_natural_language_document_label(
                                _xmp_text_value(child), metadata_field=field
                            )
                        ),
                        None,
                    )
                if selected is not None:
                    candidates.append(
                        {
                            "field": field,
                            "text": str(_xmp_text_value(selected)),
                            "source": "xmp",
                            "mode": "alt",
                            "element": prop,
                            "container": container,
                            "selected": selected,
                        }
                    )
                continue
            if container is not None and container.tag in {_XMP_BAG, _XMP_SEQ}:
                for item in container:
                    if item.tag != _XMP_LI:
                        continue
                    value = _xmp_text_value(item)
                    if value is None:
                        continue
                    candidates.append(
                        {
                            "field": field,
                            "text": value,
                            "source": "xmp",
                            "mode": "list_item",
                            "element": item,
                            "property": prop,
                        }
                    )
                continue
            value = _xmp_text_value(prop)
            if value is not None:
                candidates.append(
                    {
                        "field": field,
                        "text": value,
                        "source": "xmp",
                        "mode": "text",
                        "element": prop,
                    }
                )
    return candidates


def _metadata_decision_key(value):
    return " ".join(str(value or "").split()).casefold()


def _metadata_translation_plan(doc):
    """Bind equivalent Info and XMP values to one translation decision."""
    xmp_state = _parse_document_xmp(doc)
    metadata = doc.metadata or {}
    candidates = []
    for field in _TRANSLATABLE_METADATA_FIELDS:
        value = metadata.get(field)
        if _is_natural_language_document_label(value, metadata_field=field):
            candidates.append(
                {
                    "field": field,
                    "text": str(value),
                    "source": "info",
                    "mode": "info",
                }
            )
    candidates.extend(
        candidate
        for candidate in _xmp_candidate_bindings(xmp_state)
        if _is_natural_language_document_label(
            candidate.get("text"), metadata_field=candidate.get("field")
        )
    )

    groups = []
    by_field_key = {}
    per_field_count = defaultdict(int)
    for candidate in candidates:
        field = str(candidate["field"])
        key = (field, _metadata_decision_key(candidate["text"]))
        group = by_field_key.get(key)
        if group is None:
            occurrence = per_field_count[field]
            block_id = _metadata_block_id(field)
            if occurrence:
                block_id = f"{block_id}:xmp:{occurrence:04d}"
            per_field_count[field] += 1
            group = {
                "id": block_id,
                "page": None,
                "text": str(candidate["text"]),
                "kind": "metadata",
                "field": field,
                "bindings": [],
            }
            by_field_key[key] = group
            groups.append(group)
        group["bindings"].append(candidate)

    blocks = []
    for group in groups:
        block = {key: value for key, value in group.items() if key != "bindings"}
        block["metadata_sources"] = sorted(
            {str(binding["source"]) for binding in group["bindings"]}
        )
        blocks.append(block)
    return {"blocks": blocks, "groups": groups, "xmp": xmp_state}


def _document_virtual_blocks(doc):
    """Return outline blocks first, then selected metadata blocks, deterministically."""
    blocks = []
    for index, item in enumerate(doc.get_toc(simple=False) or []):
        if len(item) < 3:
            continue
        level, title, page = item[:3]
        title = str(title or "")
        if not _is_natural_language_document_label(title):
            continue
        blocks.append(
            {
                "id": _outline_block_id(index),
                "page": int(page),  # TOC page numbering is intentionally 1-based.
                "text": title,
                "kind": "outline",
                "index": index,
                "level": int(level),
            }
        )

    blocks.extend(_metadata_translation_plan(doc)["blocks"])
    return blocks


def _page_is_truly_blank(page):
    """Conservatively prove that a page has no visible/translatable payload.

    This is intentionally stricter than the existing low-text ``scanned`` hint.
    A raster image, vector drawing, annotation, link, formula text, or an inspection
    error means the page is *not* blank and must never be silently passed through as
    an empty large-document chunk.
    """
    try:
        if str(page.get_text("text") or "").strip():
            return False
        if page.get_images(full=True):
            return False
        if page.get_drawings():
            return False
        if _raw_annotation_xrefs(page.parent, page):
            return False
        # Shadings or other unsupported operators may not appear in get_drawings().
        # A low-resolution white-page proof catches those without expensive output
        # rendering.  Accept only an entirely white RGB raster.
        if not _pixmap_geometry_is_safe(page.rect, 0.25):
            return False
        pix = page.get_pixmap(matrix=fitz.Matrix(0.25, 0.25), colorspace=fitz.csRGB, alpha=False)
        samples = bytes(pix.samples)
        return bool(samples) and min(samples) == 255
    except Exception:
        return False


def cmd_extract(pdf_path):
    doc = fitz.open(pdf_path)
    build_decoders(doc)  # 폰트 /Differences 디코더(깨진 글자 복원) — 추출 전에 준비
    hidden_ocr_pages = _hidden_ocr_scan_page_indexes(doc)
    blocks = []
    total_text_chars = 0
    # 페이지별 figure 영역(이미지 + 그래프 라인아트) 캐시 — 그림 위 텍스트 판별용.
    page_cache = {}
    table_cell_cache = {}
    table_layout_cache = {}

    def table_layouts(pno):
        if pno not in table_layout_cache:
            table_layout_cache[pno] = _table_layouts(doc[pno])
        return table_layout_cache[pno]

    def regions(pno):
        if pno not in page_cache:
            page_cache[pno] = _skip_regions(
                doc[pno], table_layouts(pno)
            )  # 그림 + 표
        return page_cache[pno]

    def table_cells(pno):
        if pno not in table_cell_cache:
            _use_page(pno)
            table_cell_cache[pno] = _table_cell_blocks(
                doc[pno], pno, table_layouts(pno)
            )
        return table_cell_cache[pno]

    # 표시수식 band 선계산 — 식 [6.1] 처럼 본체(= 든 수식 줄)는 원본유지(KEEP)되지만
    # 분자/첨자 조각(en·nn·0·A·B·r 등 Sabon 일반폰트, 수식기호 없음)은 KEEP 에 안
    # 걸려 번역·재그리기되어 흩어진다. 본체 줄의 y-band 안에 든 '단어 없는' 조각을
    # 같이 원본유지해 식 전체가 원본대로 보이게 한다.
    items = list(iter_text_blocks(doc, hidden_ocr_pages=hidden_ocr_pages))
    repeated_footer_ids = _repeated_hidden_ocr_footer_ids(
        items, doc, hidden_ocr_pages
    )
    repeated_footer_ids.update(
        bid
        for bid, pno, block in items
        if pno in hidden_ocr_pages
        and _hidden_ocr_footer_band_block(block, doc[pno])
    )
    page_blocks = defaultdict(list)
    for _bid, _pno, _blk in items:
        page_blocks[_pno].append(_blk)
    eq_bands = {}
    for _pno, _pbs in page_blocks.items():
        _use_page(_pno)
        _regs = regions(_pno)
        bands = []
        for _blk in _pbs:
            if not _keep_original_block(_blk):
                continue
            _t = block_text(_blk, _regs)
            if "=" in _t or _MATH_SIGN.search(_t):  # 표시수식 본체(=·그리스·연산자)
                _r = fitz.Rect(_blk["bbox"])
                bands.append(
                    fitz.Rect(_r.x0 - 30, _r.y0 - 13, _r.x1 + 30, _r.y1 + 13)
                )
        eq_bands[_pno] = bands

    def _in_eq_band(block, pno):
        r = fitz.Rect(block["bbox"])
        cx, cy = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
        return any(
            b.x0 <= cx <= b.x1 and b.y0 <= cy <= b.y1 for b in eq_bands.get(pno, [])
        )

    for bid, pno, block in items:
        _use_page(pno)  # 이 페이지의 폰트 디코더 활성화(깨진 글자 복원)
        regs = regions(pno)
        # 그림/그래프 영역에 든 '줄'(축 라벨·기호·분자식 등)은 빼고 합친다.
        # → 캡션과 한 블록에 묶인 'V(R_AB)' 같은 축 라벨이 번역문에 섞이지 않는다.
        text = block_text(block, regs)
        if not text or not has_letters(text):
            continue  # 모든 줄이 그림 영역이면 text 가 비어 자동 제외(그래프 라벨 등)
        if bid in repeated_footer_ids:
            continue  # 반복 저작권 footer: 모델/redaction 제외, 원본 scan 픽셀 보존
        if pno in hidden_ocr_pages and _hidden_ocr_static_block(block, text):
            continue  # 스캔 표·그림·수식 라벨은 원본 페이지 이미지 그대로 유지
        if _keep_original_block(block):
            continue  # 독립 표시수식·기호/오비탈 라벨([6.1]·1σg 등) → 원본 유지(재그리기·오역 방지)
        # 표시수식 band 안의 조각 → 원본 유지(식이 흩어지지 않게). (1) 단어 없는 조각,
        # 또는 (2) 작은 글씨(첨자 크기) 조각. 식의 아래/위첨자 라벨(V_en·V_nn 등)은
        # 'ennnVe'처럼 흩어져 [A-Za-z]{3,} 에 우연히 걸리지만, 글씨가 작아(첨자) 본문이
        # 아니다 → 번역·재그리기하면 식 위에 겹쳐 깨진다. 작으면 band 안에서 원본 유지.
        if _in_eq_band(block, pno):
            _bsz = dominant_size_color(block)[0] or 10.0
            _no_word = not re.search(r"[A-Za-z]{3,}", text) and not re.search(r"[가-힣]", text)
            if _no_word or _bsz < 8.5:
                continue
        total_text_chars += len(text)  # scanned 판정엔 모든 글자 포함
        # 그림 근처의 '짧은' 블록(축 끝 라벨 RAB 등)은 그대로 영어로 둔다.
        # 번역 대상 줄들만의 bbox 로 판정(그림 줄은 이미 빠짐).
        if len(text.strip()) <= 8:
            rect = _nonfig_rect(block, regs)
            cx, cy = (rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2
            near_fig = any(
                (reg.x0 - 40) <= cx <= (reg.x1 + 40)
                and (reg.y0 - 40) <= cy <= (reg.y1 + 40)
                for reg in regs
            )
            if near_fig:
                continue
        # 번역 payload 는 <sub>/<sup> 태그가 붙은 버전(위/아래첨자 보존). 위의 모든 판정은
        # 태그 없는 clean text 로 한다(태그가 길이·단어수 판정을 흔들지 않게).
        text_tagged = block_text(block, regs, tag=True)
        blocks.append({"id": bid, "page": pno, "text": text_tagged})
    # A table is not a figure: expose every non-empty cell as its own translation
    # unit. Numeric / identifier / unit-only cells deliberately stay in their
    # original streams, preserving exact values and coordinates.
    table_cell_count = 0
    for pno in range(len(doc)):
        if pno in hidden_ocr_pages:
            # A scan-backed table is part of the authoritative page image.  Cell
            # OCR is useful as evidence but must not repaint its original pixels.
            continue
        for cell in table_cells(pno):
            if not cell["translate"]:
                continue
            blocks.append(
                {"id": cell["id"], "page": pno, "text": cell["text"]}
            )
            total_text_chars += len(_strip_tags(cell["text"]))
            table_cell_count += 1
    page_block_count = len(blocks)
    # Page blocks must remain first because existing prompt batching and diagnostics
    # use visual reading order.  Reader UI strings follow in their stable namespace.
    blocks.extend(_document_virtual_blocks(doc))
    # 텍스트가 거의 없으면 스캔본(글자가 이미지)일 가능성이 높다 → Node가 안내.
    ocr_layer = bool(hidden_ocr_pages)
    scanned = len(doc) > 0 and (
        total_text_chars < 20 * len(doc) or ocr_layer
    )
    # 진단: 그림/표 영역 감지 수 + PyMuPDF 버전(서버/로컬 동작 차이 추적용)
    fig_regions = 0
    table_regions = 0
    for pg in range(len(doc)):
        try:
            fig_regions += len(_figure_regions(doc[pg]))
            table_regions += len(_table_regions(doc[pg]))
        except Exception:
            pass
    try:
        fitz_ver = fitz.version[0]
    except Exception:
        fitz_ver = "?"
    truly_blank = bool(len(doc)) and page_block_count == 0 and all(
        _page_is_truly_blank(doc[page_number]) for page_number in range(len(doc))
    )
    out = {
        "page_count": len(doc),
        "scanned": scanned,
        "ocr_layer": ocr_layer,
        "ocr_layer_pages": [page + 1 for page in sorted(hidden_ocr_pages)],
        "excluded_repeated_footer_count": len(repeated_footer_ids),
        "truly_blank": truly_blank,
        "blocks": blocks,
        "page_block_count": page_block_count,
        "virtual_block_count": len(blocks) - page_block_count,
        "fig_regions": fig_regions,
        "table_regions": table_regions,
        "table_cell_count": table_cell_count,
        "fitz": fitz_ver,
    }
    write_json_response(out)
    doc.close()


_MATH_SYMS = "∑∫√±×÷≤≥≠≈∞∂∇·°→←↔⟨⟩∝∈∉⊂⊃∪∩∀∃∮∇µΩ"


def _detect_two_column(doc, _frac=(0.2, 0.35, 0.5, 0.65, 0.8)):
    """본문 페이지의 텍스트 줄 가로 분포로 2단 레이아웃을 추정한다(ML 없이).

    전폭(페이지 폭의 60%+) 줄이 거의 없고, 좌측 전용/우측 전용 줄이 양쪽으로
    충분히 나뉘면 2단으로 본다. 표지·참고문헌 페이지에 흔들리지 않도록 문서 중앙
    표본 페이지들의 과반 동의가 있을 때만 True.
    """
    n = len(doc)
    if n == 0:
        return False
    idxs = sorted(set(min(n - 1, max(0, int(n * f))) for f in _frac))
    votes = 0
    counted = 0
    for pi in idxs:
        page = doc[pi]
        W = page.rect.width
        if W <= 0:
            continue
        lines = []
        for b in page.get_text("dict").get("blocks", []):
            for l in b.get("lines", []):
                x0, _, x1, _ = l["bbox"]
                if x1 - x0 > 2:
                    lines.append((x0, x1))
        if len(lines) < 12:
            continue  # 본문이 적은 페이지는 판정에서 제외
        counted += 1
        m = len(lines)
        full = sum(1 for x0, x1 in lines if (x1 - x0) > 0.6 * W)
        left = sum(1 for x0, x1 in lines if x1 < 0.55 * W)
        right = sum(1 for x0, x1 in lines if x0 > 0.45 * W)
        if full <= 0.08 * m and left >= 0.25 * m and right >= 0.25 * m:
            votes += 1
    return counted >= 2 and votes >= max(1, counted // 2 + counted % 2)


def _page_has_hidden_ocr_scan(page):
    """Detect a page-sized scan image paired with invisible OCR text."""
    page_area = abs(page.rect) or 1.0
    best_coverage = 0.0
    try:
        for image in page.get_images(full=True):
            for raw_rect in page.get_image_rects(image[0]):
                rect = fitz.Rect(raw_rect)
                rect.intersect(page.rect)
                best_coverage = max(best_coverage, abs(rect) / page_area)
            if best_coverage >= 0.85:
                break
    except Exception:
        return False
    if best_coverage < 0.85:
        return False

    invisible = 0
    visible = 0
    try:
        for span in page.get_texttrace():
            count = len(span.get("chars") or ())
            if not count:
                continue
            if span.get("type") == 3 or span.get("opacity") == 0:
                invisible += count
            else:
                visible += count
    except Exception:
        pass
    seen = invisible + visible
    if seen > 0:
        return invisible / seen >= 0.5

    try:
        for font in page.get_fonts():
            name = str(font[3] or "").upper()
            if "OCR" in name or "GLYPHLESS" in name or "INVISIBLE" in name:
                return True
    except Exception:
        pass
    return False


def _hidden_ocr_scan_page_indexes(doc):
    """Return zero-based pages whose visible source is a page-sized scan image."""
    out = set()
    for page_index, page in enumerate(doc):
        try:
            if _page_has_hidden_ocr_scan(page):
                out.add(page_index)
        except Exception:
            continue
    return out


def _ocr_footer_tokens(text):
    return {
        word
        for word in re.findall(r"[a-z]{4,}", str(text or "").lower())
        if word not in {"that", "this", "with", "from", "have", "been", "were"}
    }


def _repeated_hidden_ocr_footer_ids(items, doc, hidden_ocr_pages):
    """Find recurring tiny bottom-page copyright bands in OCR-layer scans.

    The pixels remain in the source image; these IDs are excluded only from model
    input and redaction.  Pairwise token overlap tolerates page-to-page OCR noise,
    while the narrow bottom-band / small-font / long-text gates avoid suppressing
    ordinary body paragraphs or genuine footnotes.
    """
    candidates = []
    for bid, pno, block in items:
        if pno not in hidden_ocr_pages:
            continue
        page = doc[pno]
        rect = fitz.Rect(block.get("bbox", (0, 0, 0, 0)))
        text = block_text(block).strip()
        size = dominant_size_color(block)[0] or 10.0
        if (
            rect.y0 < page.rect.y0 + 0.94 * page.rect.height
            or size > 9.25
            or len(text) < 90
        ):
            continue
        candidates.append((bid, pno, text, _ocr_footer_tokens(text)))

    repeated = set()
    for index, (bid, pno, text, tokens) in enumerate(candidates):
        for other_bid, other_pno, _other_text, other_tokens in candidates[index + 1:]:
            if pno == other_pno:
                continue
            common = tokens & other_tokens
            union = tokens | other_tokens
            if len(common) >= 6 and len(common) / max(len(union), 1) >= 0.16:
                repeated.update((bid, other_bid))

        # A final one-page chunk cannot prove recurrence.  Retain a narrow,
        # content-backed copyright fallback rather than sending legal boilerplate
        # to the translator or painting over its scan pixels.
        lowered = text.lower()
        copyright_terms = sum(
            term in lowered
            for term in (
                "copyright", "rights", "reserved", "copied", "scanned",
                "duplicated", "learning", "ebook", "echapter", "third party content",
            )
        )
        if len(text) >= 170 and re.search(r"\b(?:19|20)\d{2}\b", text) and copyright_terms >= 2:
            repeated.add(bid)
    return repeated


def _hidden_ocr_static_block(block, text):
    """Conservatively preserve scan pixels for table / figure / formula labels."""
    value = " ".join(str(text or "").split())
    if not value:
        return True
    if block.get("_preserve_formula") or _formula_only_visible_text(
        block_text(block, tag=True)
    ):
        return True
    if re.match(r"^(?:table|figure)\s+\d", value, re.I):
        return True
    words = re.findall(r"[A-Za-z]+", value)
    prose_connectors = {
        "and", "or", "so", "if", "then", "hence", "thus", "where",
        "example", "solution", "proof", "theorem", "definition", "illustration",
    }
    if any(word.lower() in prose_connectors for word in words):
        return False
    variable_words = all(
        len(word) == 1
        or word.lower() in _OCR_INLINE_MATH_FUNCTIONS
        or (
            len(word) <= 6
            and any(ch.isupper() for ch in word)
            and any(ch.islower() for ch in word)
        )
        for word in words
    ) if words else True
    math_punctuation = bool(
        _OCR_INLINE_MATH_OPERATOR_RE.search(value)
        or re.search(r"\d", value)
        or re.search(r"[()[\]{}]", value)
    )
    return bool(len(value) <= 90 and variable_words and (math_punctuation or words))


def _hidden_ocr_footer_band_block(block, page):
    """Narrow fallback for fragments split out of a proven scan footer band."""
    rect = fitz.Rect(block.get("bbox", (0, 0, 0, 0)))
    size = dominant_size_color(block)[0] or 10.0
    return bool(
        rect.y0 >= page.rect.y0 + 0.965 * page.rect.height
        and size <= 9.25
    )


def _page_has_dominant_raster(page, threshold=0.5):
    """Return True only when a raster image occupies a meaningful page majority."""
    page_area = abs(page.rect) or 1.0
    try:
        for image in page.get_images(full=True):
            for raw_rect in page.get_image_rects(image[0]):
                rect = fitz.Rect(raw_rect)
                rect.intersect(page.rect)
                if abs(rect) / page_area >= threshold:
                    return True
    except Exception:
        return False
    return False


def cmd_analyze(pdf_path):
    """텍스트 레이어 유무 + 수식 밀도 + 2단 여부를 판정(자동 변환방식 선택용).
    scanned: 텍스트 레이어 없음(스캔/이미지). math_density: 1000자당 수식 지표 점수.
    two_column: 본문이 2단 레이아웃인지(재조판 시 2단 보존 + 읽기순서 보정용).
    ocr_layer: 사진 스캔 위에 '숨은' OCR 텍스트층이 심긴 PDF(vFlat 등) — 이 경우
    scanned 를 True 로 승격해 비전 OCR 재조판 경로를 태운다(글자 교체 무의미)."""
    doc = fitz.open(pdf_path)
    total = 0
    parts = []
    low_text_nonblank_pages = []
    hidden_ocr_scan_pages = []
    for page_index, page in enumerate(doc):
        t = page.get_text("text") or ""
        text_chars = len(t.strip())
        total += text_chars
        parts.append(t)
        # 문서 전체 평균만 보면 텍스트가 긴 몇 페이지가 이미지-only 페이지를 가려
        # 혼합 PDF가 빠른 번역으로 잘못 라우팅된다. 글자가 거의 없는 개별 페이지가
        # 실제 빈 종이가 아니라면 그 페이지의 픽셀도 OCR해야 하므로 문서 전체를
        # strict OCR 재조판으로 보낸다. 진짜 백지는 그대로 보존하되 스캔 신호로 세지 않는다.
        if text_chars < 20 and _page_has_dominant_raster(page):
            low_text_nonblank_pages.append(page_index + 1)
        elif text_chars >= 20 and _page_has_hidden_ocr_scan(page):
            hidden_ocr_scan_pages.append(page_index + 1)
    text = "\n".join(parts)
    n = len(doc)
    scan_pages = sorted(set(low_text_nonblank_pages + hidden_ocr_scan_pages))
    scanned = n > 0 and (total < 20 * n or bool(scan_pages))
    # 깨진 텍스트층 감지: Type0/Identity-H 같은 서브셋 폰트가 ToUnicode 없이 박힌 PDF 는
    # 추출하면 글리프 인덱스가 그대로 나와 C0 제어문자·사설영역(PUA) 글자로 가득 찬다.
    # 정상 텍스트(한글·CJK 포함)는 본문에 제어문자가 사실상 없으므로, 비-공백 글자 중
    # 제어/PUA 비율이 높으면 '글자만 교체'로는 번역 불가 → OCR(이미지) 경로로 보내야 한다.
    nonspace = [c for c in text if not c.isspace()]
    ns = len(nonspace)
    garbage = 0
    for c in nonspace:
        o = ord(c)
        if o < 0x20 or o == 0x7F or 0x80 <= o <= 0x9F or 0xE000 <= o <= 0xF8FF:
            garbage += 1
    garbled_ratio = round(garbage / max(ns, 1), 3)
    # 본문이 충분히 있는데(스캔 아님) 깨짐 비율이 높으면 garbled. 5% 면 정상 문서와 명확히 구분.
    garbled = (not scanned) and ns > 200 and garbled_ratio > 0.05
    # ── 수학 글리프 깨짐(Math Pi 계열 폰트) 감지 ────────────────────────────────
    # Pearson MATHPRO·Mathematical Pi·MathTime(MTMI/MTSY)·GreekwMathPi 같은
    # 출판사 수학 폰트가 ToUnicode 없이 박히면 글리프가 멀쩡한 ASCII 로 '위장'되어
    # 추출된다: [→3, ]→4, /→>, >→7, <→6, ≥→Ú, √→2 등 (Thomas Calculus 실측 4.7%).
    # 제어문자가 없어 위 garbled_ratio(0%)를 통과하고, 수학 기호가 ASCII 로 새서
    # math_density 도 과소측정된다. 이 텍스트층으로 글자 교체(in-place)나 텍스트
    # 재조판을 하면 √x→2x, [0,3]→30,34 처럼 수학적으로 틀린 번역이 나오므로,
    # 스캔본과 동일하게 비전 OCR 재조판(이미지 판독) 경로로 보내야 한다.
    # 판정: 표본 페이지에서 'ToUnicode 없는 수학폰트' 글리프 비중 ≥1% + 절대량 확보.
    # (GillSansMTPro 같은 Monotype 'MT' 텍스트 폰트가 걸리지 않게 접두사 규칙 분리.)
    math_garbled = False
    math_garbled_ratio = 0.0
    if (not scanned) and (not garbled) and n > 0 and total > 0:
        rx_sub = re.compile(
            r"MATHPRO|MATHEMATICALPI|MATHPI|GREEKWMATHPI|MATHTIME|ESSTIX", re.I
        )
        rx_pre = re.compile(r"^(MTMI|MTSY|MTEX|MTGU|MTMS)", re.I)
        m_idxs = list(range(n)) if n <= 24 else sorted({round(i * (n - 1) / 23) for i in range(24)})
        bad_fonts = set()
        for pi in m_idxs:
            try:
                for f in doc[pi].get_fonts(full=True):
                    base = str(f[3] or "").split("+")[-1]
                    if rx_sub.search(base) or rx_pre.match(base):
                        tou = doc.xref_get_key(f[0], "ToUnicode")
                        if not tou or tou[0] in ("null", ""):
                            bad_fonts.add(base)
            except Exception:
                pass
        if bad_fonts:
            bad_glyphs = 0
            tot_glyphs = 0
            # texttrace 의 span font 는 서브셋 접두사(AAAAKU+)가 없고 31자 내로 잘릴 수
            # 있어 base 이름 앞부분 일치로 센다.
            keys = {b[:28] for b in bad_fonts}
            for pi in m_idxs:
                try:
                    for sp in doc[pi].get_texttrace():
                        cnt = len(sp.get("chars") or ())
                        if not cnt:
                            continue
                        fname = str(sp.get("font") or "")
                        if any(fname.startswith(k) for k in keys):
                            bad_glyphs += cnt
                        tot_glyphs += cnt
                except Exception:
                    pass
            math_garbled_ratio = round(bad_glyphs / max(tot_glyphs, 1), 4)
            # ratio(≥1%)가 주 신호 — 정상 문서는 이 폰트를 안 써서 ~0%다. 절대 하한(50)은
            # 아주 짧은 문서에서 소수 글리프로 오탐하는 것만 막는 안전장치(짧은 발췌도 감지).
            math_garbled = bad_glyphs >= 50 and math_garbled_ratio >= 0.01
    if math_garbled:
        garbled = True  # 라우팅은 기존 garbled(비전 OCR)와 동일 — 메시지 구분용 필드만 별도
    # ── 사진 스캔 + 숨은 OCR 텍스트층(vFlat·ocrmypdf 등) 감지 ──────────────────
    # 스캔 앱이 사진 위에 '보이지 않는' OCR 텍스트를 심으면 text_chars 가 커져 위
    # scanned(<20자/쪽) 판정을 통과하지 못한다. 그러나 실제 글자는 사진 픽셀이라
    # in-place 글자 교체는 '기울어진 사진 위 겹쳐쓰기 + 유령 redaction 박스'가 된다.
    # 판정: (1) 표본 페이지 대부분에서 이미지 한 장이 페이지의 85%+ 를 덮고
    #       (2) 텍스트 글리프 대부분이 비가시(render mode 3) → 스캔본으로 승격.
    # 전면 배경이미지 + '보이는' 실제 텍스트(포스터·슬라이드)는 (2)에서 걸러져
    # 오탐하지 않는다. texttrace 미지원 환경에서만 OCR 폰트명(V6X_OCR·GlyphLess
    # 등)을 폴백 증거로 쓴다(OCR-A/B 디자인 폰트 오탐 방지).
    ocr_layer = bool(hidden_ocr_scan_pages)
    photo_ratio = round(len(hidden_ocr_scan_pages) / max(n, 1), 3)
    invis_ratio = 1.0 if hidden_ocr_scan_pages else 0.0
    if (not scanned) and (not garbled) and n > 0 and total > 0:
        idxs = list(range(n)) if n <= 24 else sorted({round(i * (n - 1) / 23) for i in range(24)})
        photo_pages = 0
        invis_glyphs = 0
        vis_glyphs = 0
        ocr_font = False
        for pi in idxs:
            pg = doc[pi]
            parea = abs(pg.rect) or 1.0
            best_cov = 0.0
            try:
                for im in pg.get_images(full=True):
                    for r in pg.get_image_rects(im[0]):
                        rr = fitz.Rect(r)
                        rr.intersect(pg.rect)
                        cov = abs(rr) / parea
                        if cov > best_cov:
                            best_cov = cov
                    if best_cov >= 0.85:
                        break
            except Exception:
                pass
            if best_cov >= 0.85:
                photo_pages += 1
            try:
                for sp in pg.get_texttrace():
                    cnt = len(sp.get("chars") or ())
                    if not cnt:
                        continue
                    # type 3 = render mode 3(그리지 않는 글자). opacity 0 도 비가시.
                    if sp.get("type") == 3 or sp.get("opacity") == 0:
                        invis_glyphs += cnt
                    else:
                        vis_glyphs += cnt
            except Exception:
                pass
            if not ocr_font:
                try:
                    for f in pg.get_fonts():
                        nm = str(f[3] or "").upper()
                        if "OCR" in nm or "GLYPHLESS" in nm or "INVISIBLE" in nm:
                            ocr_font = True
                            break
                except Exception:
                    pass
        photo_ratio = round(photo_pages / max(len(idxs), 1), 3)
        seen = invis_glyphs + vis_glyphs
        invis_ratio = round(invis_glyphs / seen, 3) if seen else 0.0
        strong_invis = seen > 0 and invis_ratio >= 0.5
        fallback_font = seen == 0 and ocr_font  # texttrace 판독 불가 환경 폴백
        if photo_ratio >= 0.8 and (strong_invis or fallback_font):
            ocr_layer = True
            scanned = True  # 기존 스캔 라우팅(비전 OCR 재조판)을 그대로 태운다
    two_column = (not scanned) and (not garbled) and _detect_two_column(doc)
    # 수식 지표: 그리스 문자(U+0370–03FF), 수학 기호, 위/아래 첨자(U+2070–209F), '=' 빈도
    greek = sum(1 for c in text if "Ͱ" <= c <= "Ͽ")
    syms = sum(1 for c in text if c in _MATH_SYMS)
    subsup = sum(1 for c in text if "⁰" <= c <= "₟")
    eqs = text.count("=")
    math_score = greek * 3 + syms * 3 + subsup * 2 + eqs
    density = round((math_score / max(total, 1)) * 1000, 2)
    write_json_response(
        {
            "page_count": n,
            "text_chars": total,
            "scanned": scanned,
            "scan_page_count": len(scan_pages),
            "scan_pages": scan_pages,
            "garbled": garbled,
            "garbled_ratio": garbled_ratio,
            "math_garbled": math_garbled,
            "math_garbled_ratio": math_garbled_ratio,
            "math_score": math_score,
            "math_density": density,
            "two_column": two_column,
            "ocr_layer": ocr_layer,
            "photo_page_ratio": photo_ratio,
            "invisible_text_ratio": invis_ratio,
        }
    )
    doc.close()


def cmd_pagetext(pdf_path, max_chars_per_page=3500):
    """페이지별 텍스트층 덤프(JSON) — 스캔본에 심긴 기존 OCR 텍스트층을 비전 OCR
    재조판의 '참고 힌트'로 쓰기 위함. 판독 기준은 항상 페이지 이미지고 이 텍스트는
    보조다(오인식 가능). stdout: {"page_count": N, "pages": [{"page", "text"}]}"""
    max_chars_per_page = int(max_chars_per_page)
    doc = fitz.open(pdf_path)
    pages = []
    for i, page in enumerate(doc):
        t = (page.get_text("text") or "").strip()
        if not t:
            continue
        t = re.sub(r"[ \t]+", " ", t)
        if len(t) > max_chars_per_page:
            t = t[:max_chars_per_page] + " …(잘림)"
        pages.append({"page": i + 1, "text": t})
    write_json_response({"page_count": len(doc), "pages": pages})
    doc.close()


RASTER_TARGET_WIDTH_MIN = 600
RASTER_TARGET_WIDTH_MAX = 2400
RASTER_MIN_SAFE_ZOOM = 0.25
RASTER_MAX_TILES_PER_PAGE = 30
RASTER_MAX_TILES_TOTAL = 100
RASTER_MAX_TILE_PIXEL_DIMENSION = SAFE_PIXMAP_MAX_DIMENSION
RASTER_MAX_TILE_PIXEL_AREA = SAFE_PIXMAP_MAX_AREA
RASTER_MAX_PAGE_PIXEL_AREA = 32_000_000
RASTER_MAX_BATCH_PIXEL_AREA = 96_000_000


def _plan_raster_page_tiles(w_pt, h_pt, target_width_px):
    """Plan bounded OCR raster tiles without allocating a pixmap.

    Untrusted PDFs can declare page boxes hundreds of thousands of points wide
    or tall.  PyMuPDF would otherwise allocate that geometry before the later
    compressed-byte checks run.  This planner is the pre-allocation boundary
    shared by every page in :func:`cmd_rasterize`.
    """

    w_pt = float(w_pt)
    h_pt = float(h_pt)
    if (
        not math.isfinite(w_pt)
        or not math.isfinite(h_pt)
        or w_pt <= 0
        or h_pt <= 0
    ):
        raise ValueError("page has invalid OCR raster geometry")
    target_width_px = max(
        RASTER_TARGET_WIDTH_MIN,
        min(int(target_width_px), RASTER_TARGET_WIDTH_MAX),
    )
    # Downscale wide pages instead of the historical zoom>=1 behavior that
    # could request a 100,000px-wide pixmap.  Extremely small scales are
    # rejected because they are neither numerically safe nor readable OCR.
    zoom = min(target_width_px / w_pt, 4.0)
    if not math.isfinite(zoom) or zoom < RASTER_MIN_SAFE_ZOOM:
        raise ValueError("page geometry requires an unsafe OCR raster zoom")
    predicted_width = max(1, math.ceil(w_pt * zoom))
    if predicted_width > RASTER_MAX_TILE_PIXEL_DIMENSION:
        raise ValueError("page requires an over-wide OCR raster pixmap")

    tile_height_pt = 1800.0 / zoom
    tile_count = max(1, math.ceil(h_pt / (tile_height_pt * 1.15)))
    if tile_count > RASTER_MAX_TILES_PER_PAGE:
        raise ValueError("page requires too many OCR raster tiles")
    segment_height = h_pt / tile_count
    tiles = []
    page_pixels = 0
    for tile_index in range(tile_count):
        # OCR provenance requires an exact partition of the PDF page: every
        # point is rendered once, with neither an unproved gap nor duplicated
        # overlap.  The model prompt still treats consecutive images as one
        # ordered page, so overlap is not needed for reading-order recovery.
        y0 = segment_height * tile_index
        y1 = h_pt if tile_index == tile_count - 1 else segment_height * (tile_index + 1)
        predicted_height = max(1, math.ceil((y1 - y0) * zoom))
        tile_pixels = predicted_width * predicted_height
        if (
            predicted_height > RASTER_MAX_TILE_PIXEL_DIMENSION
            or tile_pixels > RASTER_MAX_TILE_PIXEL_AREA
        ):
            raise ValueError("page requires an oversized OCR raster tile")
        page_pixels += tile_pixels
        tiles.append(
            {
                "index": tile_index,
                "y0": y0,
                "y1": y1,
                "predicted_width": predicted_width,
                "predicted_height": predicted_height,
                "predicted_pixels": tile_pixels,
            }
        )
    if page_pixels > RASTER_MAX_PAGE_PIXEL_AREA:
        raise ValueError("page exceeds the OCR raster pixel budget")
    return {
        "zoom": zoom,
        "width": predicted_width,
        "tiles": tiles,
        "predicted_pixels": page_pixels,
    }


def cmd_rasterize(pdf_path, out_dir, target_width_px=1400, max_pages=20):
    """각 페이지를 가독 가능한 PNG 타일로 렌더링한다(스캔본을 Claude 비전으로 읽히기 위함).

    핵심: 일부 PDF(문제집 등)는 한 페이지가 세로로 매우 길다(예: 958×11833). 이를 한 장
    이미지로 보내면 Claude 가 긴 변을 1568px 로 줄여 글자가 다시 뭉개진다. 그래서 폭을
    가독 해상도(≈target_width_px)로 맞춰 렌더하되, 세로로 긴 페이지는 페이지 모양 타일로
    잘라(빈틈·겹침 없이) 각각 저장한다. clip 렌더라 거대한 픽스맵을 만들지 않는다."""
    target_width_px = max(
        RASTER_TARGET_WIDTH_MIN,
        min(int(target_width_px), RASTER_TARGET_WIDTH_MAX),
    )
    max_pages = int(max_pages)
    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    try:
        n = len(doc)
        planned_pages = min(n, max_pages)
        rendered_pages = 0
        files = []
        pages = []
        truncated = n > planned_pages
        batch_pixels = 0
        for i in range(planned_pages):
            page = doc[i]
            rect = page.rect
            plan = _plan_raster_page_tiles(
                rect.width or 612.0,
                rect.height or 792.0,
                target_width_px,
            )
            if len(files) + len(plan["tiles"]) > RASTER_MAX_TILES_TOTAL:
                truncated = True
                break
            if batch_pixels + plan["predicted_pixels"] > RASTER_MAX_BATCH_PIXEL_AREA:
                raise ValueError("OCR raster batch exceeds the pixel budget")
            batch_pixels += plan["predicted_pixels"]
            mat = fitz.Matrix(plan["zoom"], plan["zoom"])
            page_tiles = []
            for tile in plan["tiles"]:
                clip = fitz.Rect(
                    rect.x0,
                    rect.y0 + tile["y0"],
                    rect.x1,
                    rect.y0 + tile["y1"],
                )
                pix = page.get_pixmap(matrix=mat, clip=clip, alpha=False)
                out_path = os.path.join(
                    out_dir,
                    f"p-{i:03d}-{tile['index']:02d}.png",
                )
                pix.save(out_path)
                files.append(out_path)
                page_tiles.append(
                    {
                        "index": tile["index"],
                        "bbox": [0.0, tile["y0"], float(rect.width), tile["y1"]],
                        "width": int(pix.width),
                        "height": int(pix.height),
                        "file": out_path,
                    }
                )
            pages.append(
                {
                    "index": i,
                    "width": float(rect.width),
                    "height": float(rect.height),
                    "rotation": int(page.rotation or 0),
                    "tiles": page_tiles,
                }
            )
            rendered_pages += 1
        write_json_response(
            {
                "page_count": n,
                "rendered_pages": rendered_pages,
                "tiles": len(files),
                "truncated": truncated,
                "target_width_px": target_width_px,
                "files": files,
                "pages": pages,
            }
        )
    finally:
        doc.close()


def _color01(c):
    if isinstance(c, (list, tuple)):
        return tuple(float(x) for x in c[:3])
    c = int(c)
    return (((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255)


def _detect_align(rect, page_width, single_line=False, is_heading=False):
    """원문 블록 위치로 정렬을 추정한다.

    제목/저자처럼 '좁고 + 좌우 여백이 거의 대칭'인 블록은 가운데 정렬,
    그 외(본문 컬럼)는 양끝맞춤(justify) — LaTeX 조판처럼 단정해진다.
    단, **한 줄짜리 블록**(저자·소속·짧은 라벨 등)은 justify 하면 단어 사이가
    크게 벌어진다('Google   Brain') → 좁으면 가운데, 넓으면 왼쪽으로 처리한다.

    is_heading: 제목·섹션 헤딩은 **절대 양끝맞춤하지 않는다**. 번역으로 길어져 두
    줄로 넘어가면 첫 줄이 justify 되어 단어가 크게 벌어진다('H₂⁺에   대한   원자').
    헤딩은 기하적으로 가운데 정렬이면 가운데, 아니면 왼쪽으로 둔다(원문 헤딩과 동일).
    """
    w = rect.x1 - rect.x0
    left = rect.x0
    right = page_width - rect.x1
    # Tight glyph bboxes do not encode alignment directly, but their page anchors do:
    # balanced margins imply centered text, while a narrow bbox touching the right
    # page margin is a right-aligned running header / footer.  These checks happen
    # before the heading / single-line branches so those anchors survive translation.
    center_width_limit = (0.9 if is_heading else 0.62) * page_width
    if (
        w < center_width_limit
        and left > 0.08 * page_width
        and right > 0.08 * page_width
        and abs(left - right) < 0.08 * page_width
    ):
        return fitz.TEXT_ALIGN_CENTER
    if (
        w < 0.62 * page_width
        and right < 0.12 * page_width
        and left > 0.38 * page_width
    ):
        return fitz.TEXT_ALIGN_RIGHT
    if is_heading:
        # 헤딩: justify 금지. 중앙/우측 정렬은 위의 기하 신호로 이미 처리했다.
        return fitz.TEXT_ALIGN_LEFT
    if single_line:
        return fitz.TEXT_ALIGN_LEFT
    # 좁은 왼쪽/오른쪽 column의 짧은 여러 줄도 강제 justify하지 않는다.
    if w < 0.35 * page_width:
        return fitz.TEXT_ALIGN_LEFT
    return fitz.TEXT_ALIGN_JUSTIFY


def _is_prose_text(text):
    """Conservative prose signal used only for layout bounds / alignment.

    Identifiers, URLs, equations and short running labels must keep their dedicated
    anchor behavior.  Ordinary sentences have either several lexical tokens or a
    sufficiently long CJK run with sentence punctuation.
    """
    plain = " ".join(_strip_tags(str(text or "")).split())
    if not plain or re.match(r"^(?:https?|mailto):", plain, re.I):
        return False
    words = re.findall(r"[A-Za-z]{2,}|[\uac00-\ud7a3]{2,}", plain)
    if len(words) >= 4:
        return True
    letters = sum(1 for ch in plain if ch.isalpha())
    return letters >= 24 and bool(re.search(r"[.!?;:。！？]", plain))


def _infer_column_right_caps(items, page):
    """Infer a fail-safe right edge for body prose in each source x-band.

    A tight glyph bbox is not a license to expand all the way to the physical page
    edge.  Doing so reduced fixture-01's right margin from 48pt to 6pt and allowed a
    left-column paragraph to trespass into the right column.  We cluster body prose
    with similar source ``x0`` values and cap redraw at that band's observed maximum
    ``x1`` plus a small metric allowance.  A one-off narrow label is never treated as
    a column; a single genuinely wide paragraph is.

    Return ``{block_id: max_x}`` so callers can retain all other obstacle limits.
    """
    page_rect = _page_text_rect(page)
    width = max(1.0, page_rect.width)
    height = max(1.0, page_rect.height)
    candidates = []
    for item in items:
        rect, text, _size, _color, _bold, _italic, block_id = item
        rect = fitz.Rect(rect)
        cy = (rect.y0 + rect.y1) / 2.0
        if cy < page_rect.y0 + 0.07 * height or cy > page_rect.y1 - 0.07 * height:
            continue
        if not _is_prose_text(text):
            continue
        if rect.width < 0.16 * width and len(_strip_tags(str(text))) < 42:
            continue
        candidates.append((rect, block_id))
    if not candidates:
        return {}

    tolerance = max(6.0, 0.025 * width)
    groups = []
    for rect, block_id in sorted(candidates, key=lambda value: value[0].x0):
        chosen = None
        for group in groups:
            if abs(rect.x0 - group["anchor"]) <= tolerance:
                chosen = group
                break
        if chosen is None:
            chosen = {"anchor": rect.x0, "items": []}
            groups.append(chosen)
        chosen["items"].append((rect, block_id))
        chosen["anchor"] = sum(r.x0 for r, _bid in chosen["items"]) / len(
            chosen["items"]
        )

    eligible = []
    for group in groups:
        rects = [rect for rect, _bid in group["items"]]
        # A two-column body band is normally only 0.36--0.40 of the physical page
        # width.  Requiring three blocks or 0.42 page widths left sparse right
        # columns uncapped: Fundamental Astronomy p.23 has exactly two paragraphs,
        # and the lower one expanded from x=453.64 to x=496.63.  One paragraph that
        # is at least a plausible column width is already sufficient source-layout
        # evidence; short captions / running labels were filtered above.
        if len(rects) >= 2 or max(rect.width for rect in rects) >= 0.30 * width:
            eligible.append(group)
    eligible.sort(key=lambda group: group["anchor"])
    if not eligible:
        return {}

    # Extracted glyph bboxes can be fractionally narrower than font metrics.  Two
    # points accommodates that difference without visibly eroding the source
    # column margin or gutter; overflow is handled by wrapping / font shrink.
    allowance = 2.0
    gutter = max(8.0, 0.02 * width)
    caps = {}
    for index, group in enumerate(eligible):
        rects = [rect for rect, _bid in group["items"]]
        observed_right = max(rect.x1 for rect in rects)
        cap = min(page_rect.x1 - 6.0, observed_right + allowance)
        # A left-anchored single column should at least preserve a symmetric outer
        # margin.  ``min`` keeps the stricter observed-envelope cap for short lines.
        if group["anchor"] <= page_rect.x0 + 0.25 * width:
            symmetric = page_rect.x1 - max(6.0, group["anchor"] - page_rect.x0)
            cap = min(cap, symmetric)
        if index + 1 < len(eligible):
            next_anchor = eligible[index + 1]["anchor"]
            if next_anchor - group["anchor"] >= 0.20 * width:
                cap = min(cap, next_anchor - gutter)
        cap = max(observed_right, cap)
        for _rect, block_id in group["items"]:
            caps[block_id] = cap
    return caps


def _body_prose_must_not_be_right_aligned(rect, text, page):
    """Guard against mistaking a right-column sentence for a running label."""
    if not _is_prose_text(text):
        return False
    page_rect = _page_text_rect(page)
    cy = (rect.y0 + rect.y1) / 2.0
    return page_rect.y0 + 0.07 * page_rect.height <= cy <= page_rect.y1 - 0.07 * page_rect.height


_FORMULA_TRANSITION_RE = re.compile(
    r"^(?:gives?|yields?|which (?:gives?|yields?)|"
    r"and|or|hence|thus|therefore|consequently|whence|then|so|"
    r"it follows(?: that)?|we (?:get|obtain|find)|this (?:gives|yields))[,.:;]?$",
    re.I,
)


def _is_formula_transition_before_preserved_formula(
    rect, source_text, formula_rects, page
):
    """Identify a short prose bridge at a body-column edge before an equation.

    Tight glyph bboxes for words such as ``Hence`` or a standalone ``gives`` can
    look geometrically centred even though they are ordinary left-aligned prose
    introducing the display below.
    Require both a narrow discourse-transition phrase and a nearby preserved formula
    in the same source column.  Running headers, page numbers and right-side labels
    therefore retain their existing anchor behavior.
    """
    plain = " ".join(_strip_tags(str(source_text or "")).split())
    if not _FORMULA_TRANSITION_RE.fullmatch(plain):
        return False
    rect = fitz.Rect(rect)
    page_rect = _page_text_rect(page)
    cy = (rect.y0 + rect.y1) / 2.0
    if not (
        page_rect.y0 + 0.07 * page_rect.height
        <= cy
        <= page_rect.y1 - 0.07 * page_rect.height
    ):
        return False
    maximum_gap = max(16.0, 4.0 * max(rect.height, 1.0))
    for candidate in formula_rects:
        formula = fitz.Rect(candidate)
        gap = formula.y0 - rect.y1
        if gap < -1.0 or gap > maximum_gap:
            continue
        # The formula may be centred / indented, but it must begin in the same
        # half-page column and not sit wholly to the left of the transition.
        if formula.x1 < rect.x0 - 4.0:
            continue
        if formula.x0 - rect.x0 > 0.42 * page_rect.width:
            continue
        return True
    return False


def _matching_column_cap(rect, items, caps, page):
    """Reuse a proven prose-column envelope for a short block at the same x0."""
    rect = fitz.Rect(rect)
    tolerance = max(6.0, 0.025 * _page_text_rect(page).width)
    matches = [
        caps.get(item[6])
        for item in items
        if caps.get(item[6]) is not None
        and abs(fitz.Rect(item[0]).x0 - rect.x0) <= tolerance
    ]
    return min(matches) if matches else None


# GPOS/GSUB carry the shaping/positioning rules that must survive subsetting.
# fontTools legitimately removes GDEF when no retained glyph participates in its
# mark/ligature classes, so requiring an empty GDEF would reject plain Hangul text.
_REQUIRED_FONT_LAYOUT_TABLES = frozenset({"GPOS", "GSUB"})


def _font_unicode_coverage(ttfont):
    """Return every Unicode scalar mapped by any Unicode cmap in ``ttfont``."""
    coverage = set()
    cmap = ttfont.get("cmap")
    if cmap is None:
        return coverage
    for table in cmap.tables:
        try:
            if table.isUnicode():
                coverage.update(int(cp) for cp in table.cmap)
        except Exception:
            continue
    return coverage


def _subset_font_bytes(font_path, requested_codepoints, label):
    """Create a deterministic, in-memory Unicode subset for one bundled font.

    Full CJK fonts make MuPDF emit invalid five-hex-digit ToUnicode destinations
    for unused non-BMP cmap entries. Pre-subsetting to the exact text repertoire
    prevents that corruption and keeps each rendered PDF small. A failed subset is
    fatal: silently embedding the full font would recreate the broken CMap.
    """
    try:
        from fontTools import subset
        from fontTools.ttLib import TTFont
    except Exception as exc:
        raise RuntimeError(
            "fontTools is required for safe PDF text-layer font subsetting"
        ) from exc

    path = os.path.abspath(font_path)
    if not os.path.isfile(path):
        raise RuntimeError(f"required {label} font is missing: {path}")
    try:
        with open(path, "rb") as handle:
            source_bytes = handle.read()
        source = TTFont(io.BytesIO(source_bytes), recalcTimestamp=False, lazy=False)
        source_coverage = _font_unicode_coverage(source)
        if 0x20 not in source_coverage:
            raise RuntimeError("font does not map U+0020 SPACE")
        original_layout = _REQUIRED_FONT_LAYOUT_TABLES.intersection(source.keys())
        original_weight = int(source["OS/2"].usWeightClass)
        original_mac_style = int(source["head"].macStyle)

        options = subset.Options()
        options.recalc_timestamp = False
        options.layout_features = ["*"]
        options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 16, 17, 21, 22, 25]
        options.name_legacy = True
        options.name_languages = [0x409]
        options.notdef_glyph = True
        options.notdef_outline = True
        options.glyph_names = True

        wanted = set(int(cp) for cp in requested_codepoints)
        wanted.discard(0x00A0)  # never reintroduce NBSP's duplicate space mapping
        wanted.add(0x20)
        present = wanted.intersection(source_coverage)
        worker = subset.Subsetter(options=options)
        worker.populate(unicodes=present)
        worker.subset(source)

        output = io.BytesIO()
        source.save(output, reorderTables=True)
        subset_bytes = output.getvalue()
        source.close()

        check = TTFont(io.BytesIO(subset_bytes), recalcTimestamp=False, lazy=False)
        subset_coverage = _font_unicode_coverage(check)
        missing = present.difference(subset_coverage)
        lost_layout = original_layout.difference(check.keys())
        if missing:
            preview = ", ".join(f"U+{cp:04X}" for cp in sorted(missing)[:8])
            raise RuntimeError(f"subset lost required glyph mappings: {preview}")
        if lost_layout:
            raise RuntimeError(
                "subset lost required layout tables: " + ", ".join(sorted(lost_layout))
            )
        if int(check["OS/2"].usWeightClass) != original_weight:
            raise RuntimeError("subset changed OS/2 font weight metadata")
        if int(check["head"].macStyle) != original_mac_style:
            raise RuntimeError("subset changed head.macStyle metadata")
        check.close()
        return subset_bytes, subset_coverage
    except Exception as exc:
        if isinstance(exc, RuntimeError) and str(exc).startswith("required "):
            raise
        raise RuntimeError(f"safe {label} font subsetting failed: {exc}") from exc


def _contains_hangul(text):
    return any(
        (0x1100 <= ord(ch) <= 0x11FF)
        or (0x3130 <= ord(ch) <= 0x318F)
        or (0xA960 <= ord(ch) <= 0xA97F)
        or (0xAC00 <= ord(ch) <= 0xD7AF)
        or (0xD7B0 <= ord(ch) <= 0xD7FF)
        for ch in text
    )


def _font_for_character(ch, primary, fallback_fonts=()):
    """Choose a bundled subset font for one rendered character, fail closed."""
    cp = ord(ch)
    for candidate in (primary, *fallback_fonts):
        if candidate is not None and candidate.has_glyph(cp):
            return candidate
    raise RuntimeError(f"bundled PDF fonts do not cover U+{cp:04X}")


def _text_length_with_fonts(text, fontsize, primary, fallback_fonts=()):
    total = 0.0
    for ch in text:
        if ch in "\r\n":
            continue
        chosen = _font_for_character(ch, primary, fallback_fonts)
        total += chosen.text_length(ch, fontsize=fontsize)
    return total


def _font_covers_text(font, text):
    return all(ch.isspace() or font.has_glyph(ord(ch)) for ch in text)


def _has_leftover(ret):
    """TextWriter.fill_textbox 반환값(보통 leftover 리스트)에 '안 들어간 텍스트'가 있는지."""
    if not ret:
        return False
    if isinstance(ret, str):
        return bool(ret.strip())
    if isinstance(ret, (list, tuple)):
        return any(_has_leftover(x) for x in ret)
    return bool(ret)


def _draw_result(
    drawn=False,
    complete=False,
    shrunk=False,
    min_font=None,
    min_glyph_font=None,
):
    """텍스트 그리기 결과를 호출부가 손실 없이 판정할 수 있는 공통 형식으로 반환한다."""
    return {
        "drawn": bool(drawn),
        "complete": bool(complete),
        "shrunk": bool(shrunk),
        "min_font": round(float(min_font), 2) if min_font is not None else None,
        "min_glyph_font": (
            round(float(min_glyph_font), 2)
            if min_glyph_font is not None
            else (round(float(min_font), 2) if min_font is not None else None)
        ),
    }


def _draw_fit(
    page,
    rect,
    text,
    color,
    font,
    start_size,
    align,
    min_size=4.0,
    italic=False,
    max_x=None,
    max_y=None,
):
    """rect 안에 번역문을 그린다. TextWriter 는 write_text() 전엔 페이지에 안 그리므로
    fill_textbox 로 '다 들어갔는지' 먼저 확인하고 들어갈 때만 커밋한다(겹침·증발 방지).

    크기 정책 — 제목·헤딩이 번역으로 길어져도 작아지지 않게 하되 **이웃 블록을 절대
    침범하지 않는다**(겹침 방지):
    - 가로: 번역이 한 줄에 안 들어가면 오른쪽 여유(max_x: 오른쪽 이웃/페이지 여백)까지
      넓혀 한 줄에 담는다(가운데 정렬 제외). → 제목·헤딩이 크기 유지된 채 한 줄로.
    - 세로: 그래도 넘치면 아래 여유(max_y: 아래 이웃/페이지 여백)까지만 줄을 흘린다.
    - 가로·세로 여유로도 안 되면 그때만 폰트를 줄인다(이웃 침범 0).

    italic=True 면 전단(shear) morph 로 기울여 그려 원문 이탤릭을 반영한다(faux-oblique).
    """
    rect = fitz.Rect(rect)
    rect.normalize()
    if rect.width < 2 or rect.height < 1:
        return _draw_result()
    page_rect = _page_text_rect(page)
    writer_rect = fitz.Rect(page.rect)
    # 확장 상한 = 이웃 블록(없으면 페이지 여백). 최소 원래 크기는 보장.
    mx = max(rect.x1, max_x if max_x is not None else page_rect.x1 - 6)
    my = max(rect.y1, max_y if max_y is not None else page_rect.y1 - 6)

    morph = None
    if italic:
        morph = (fitz.Point(rect.x0, rect.y1), fitz.Matrix(1, 0, -0.28, 1, 0, 0))

    def _expand(r, fs):
        """한 줄에 안 들어가면 가로(→mx) 먼저, 그래도 넘치면 세로(→my)로만 확장.
        둘 다 이웃 한계 안이라 겹치지 않는다."""
        r = fitz.Rect(r)
        try:
            tl = font.text_length(text, fontsize=fs)
        except Exception:
            tl = 0.0
        # 가로 확장(가운데 정렬 제외): 1줄 폭이 모자라면 오른쪽 여유까지.
        if align != fitz.TEXT_ALIGN_CENTER and tl > r.width - 2 and mx > r.x1 + 1:
            r.x1 = mx
        # 한 줄 높이 보장(얇은 블록).
        lh = fs * 1.35
        if r.height < lh:
            r.y1 = max(r.y1, min(my, r.y0 + lh))
            if r.height < lh:
                r.y0 = max(page_rect.y0, r.y1 - lh)
        # 여전히 1줄 초과면 아래 여유까지만 늘려 wrap.
        if tl > r.width:
            need = (int(tl / max(1.0, r.width)) + 1) * fs * 1.32
            if need > r.height:
                r.y1 = min(my, r.y0 + need)
        return r

    def _try_fill(r, fs):
        try:
            # TextWriter's mediabox must be ``page.rect`` (rotated display space),
            # even though append / extraction coordinates are CropBox-relative.
            # Passing the unrotated text rect makes 90-degree pages transform or
            # clip inserted text incorrectly.
            tw = fitz.TextWriter(writer_rect)
            leftover = tw.fill_textbox(r, text, font=font, fontsize=fs, align=align)
            return tw, leftover
        except (ValueError, RuntimeError):
            return None

    def _commit(tw):
        if morph is not None:
            try:
                tw.write_text(page, color=color, morph=morph)
                return True
            except Exception:
                pass  # morph 실패 시 일반 그리기로 폴백
        try:
            tw.write_text(page, color=color)
            return True
        except Exception:
            return False

    fs = max(min_size, min(float(start_size), 400.0))
    # 가독성 바닥: 본문(원본 9pt+)은 원래 크기의 62% 아래로는 줄이지 않는다 — '깨알
    # 글씨(4pt)' 방지. 1차로 [바닥..원래] 범위에서 다 들어가는 가장 큰 크기를 찾는다.
    floor = max(min_size, round(0.62 * float(start_size), 1)) if start_size >= 9.0 else min_size
    while fs >= floor:
        res = _try_fill(_expand(rect, fs), fs)
        if res is not None and not _has_leftover(res[1]):
            drawn = _commit(res[0])
            return _draw_result(
                drawn=drawn,
                complete=drawn,
                shrunk=fs < float(start_size) - 0.01,
                min_font=fs,
            )
        fs -= 0.5
    # 바닥에서도 안 들어가면: 글자 잘림(내용 손실)이 깨알보다 나쁘므로 min_size 까지
    # 더 줄여 전부 담는다(이 경우는 F5 문단병합·F1 세로압축 후엔 드물다).
    fs = floor - 0.5
    while fs >= min_size:
        res = _try_fill(_expand(rect, fs), fs)
        if res is not None and not _has_leftover(res[1]):
            drawn = _commit(res[0])
            return _draw_result(
                drawn=drawn,
                complete=drawn,
                shrunk=True,
                min_font=fs,
            )
        fs -= 0.5
    # 그래도 안 들어가면 기존처럼 들어가는 만큼은 그리되 complete=False 로 기록한다.
    # Node 품질 게이트가 이 PDF를 사용자 결과로 내보내지 않는다.
    res = _try_fill(_expand(rect, min_size), min_size)
    if res is not None:
        drawn = _commit(res[0])
        return _draw_result(
            drawn=drawn,
            complete=drawn and not _has_leftover(res[1]),
            shrunk=min_size < float(start_size) - 0.01,
            min_font=min_size,
        )
    return _draw_result(
        drawn=False,
        complete=False,
        shrunk=min_size < float(start_size) - 0.01,
        min_font=min_size,
    )


def _draw_fit_rotated(
    page,
    rect,
    text,
    color,
    font_buffer,
    font_name,
    start_size,
    align,
    rotation,
    min_size=4.0,
):
    """All-or-nothing textbox fitting for a source caption rotated by 90 degrees.

    ``Page.insert_textbox(..., rotate=90)`` performs layout in the caption's own
    coordinate system: the physical strip height becomes line width and its width
    becomes line stack height.  This is substantially safer than flattening the
    strip into a 10pt-wide horizontal box or applying an unbounded morph.  The
    already validated/subset in-memory font is registered on the page, so this path
    retains the same ToUnicode and font-safety guarantees as ``TextWriter``.
    """
    rect = fitz.Rect(rect)
    rect.normalize()
    if rect.width < 2 or rect.height < 2 or rotation not in {90, 270}:
        return _draw_result()
    try:
        page.insert_font(
            fontname=str(font_name),
            fontbuffer=font_buffer,
            set_simple=False,
        )
    except Exception:
        return _draw_result()

    fs = max(min_size, min(float(start_size), 200.0))
    floor = (
        max(min_size, round(0.62 * float(start_size), 1))
        if start_size >= 9.0
        else min_size
    )
    candidates = []
    probe = fs
    while probe >= floor:
        candidates.append(probe)
        probe -= 0.5
    probe = floor - 0.5
    while probe >= min_size:
        candidates.append(probe)
        probe -= 0.5
    for probe in candidates:
        try:
            shape = page.new_shape()
            spare = shape.insert_textbox(
                rect,
                text,
                fontname=str(font_name),
                fontsize=probe,
                align=align,
                color=color,
                rotate=rotation,
            )
            if float(spare) < -0.01:
                continue
            shape.commit(overlay=True)
            return _draw_result(
                drawn=True,
                complete=True,
                shrunk=probe < float(start_size) - 0.01,
                min_font=probe,
            )
        except Exception:
            continue
    # PyMuPDF emits no text when the rotated textbox does not fit.  Report a hard
    # failure rather than committing a truncated caption or an unreadable fragment.
    return _draw_result(
        drawn=False,
        complete=False,
        shrunk=True,
        min_font=min_size,
    )


_TAG_RE = re.compile(r"<(sub|sup)>(.*?)</\1>", re.DOTALL)
_STRIP_TAG_RE = re.compile(r"</?(?:sub|sup)>")
_RICH_ZERO_ADVANCE_GAP = "\x00"
_CHARGE_GAP_RE = re.compile(
    r"(?<=</sub>)[ \t]+(?=<sup>(?:\d+[+\-−]|[+\-−])</sup>)"
)


def _strip_tags(s):
    """<sub>/<sup> 태그만 제거하고 내용은 남긴다(폭·길이 계산용)."""
    return _STRIP_TAG_RE.sub("", s) if ("<sub>" in s or "<sup>" in s) else s


def _has_tags(s):
    return "<sub>" in s or "<sup>" in s


def _translation_codepoints(by_page):
    """Exact printable repertoire that the renderer may place into the PDF."""
    codepoints = {0x20}
    for items in by_page.values():
        for _rect, text, _size, _color, _bold, _ital, _bid in items:
            for ch in _strip_tags(text):
                if ch.isspace():
                    codepoints.add(0x20)
                    continue
                cp = ord(ch)
                if cp > 0xFFFF:
                    raise ValueError(
                        f"unsupported non-BMP translation character U+{cp:06X}; "
                        "safe ToUnicode output is limited to BMP characters"
                    )
                codepoints.add(cp)
    codepoints.discard(0x00A0)
    codepoints.discard(0x202F)
    codepoints.add(0x20)
    return codepoints


def _parse_richtext(s):
    """<sub>..</sub>/<sup>..</sup> 가 든 문자열을 (글자, style) 목록으로 분해.
    style ∈ {'normal','sub','sup'}. 태그 밖 < > & 는 그대로 글자로 둔다."""
    # A separately encoded ionic charge has a semantic extraction boundary but no
    # visual gap.  Mark only that exact subscript->charge pattern; ordinary spaces
    # and H<sub>2</sub> O remain normal advancing word separators.
    s = _CHARGE_GAP_RE.sub(_RICH_ZERO_ADVANCE_GAP, s)
    atoms = []
    pos = 0
    for m in _TAG_RE.finditer(s):
        for ch in s[pos:m.start()]:
            atoms.append(
                (" ", "zero_space")
                if ch == _RICH_ZERO_ADVANCE_GAP
                else (ch, "normal")
            )
        style = "sub" if m.group(1) == "sub" else "sup"
        for ch in m.group(2):
            atoms.append((ch, style))
        pos = m.end()
    for ch in s[pos:]:
        atoms.append(
            (" ", "zero_space")
            if ch == _RICH_ZERO_ADVANCE_GAP
            else (ch, "normal")
        )
    return atoms


def _draw_rich(page, rect, html_text, color, font, start_size, align,
               max_x=None, max_y=None, min_size=5.0, fallback_fonts=()):
    """위/아래첨자(<sub>/<sup>)가 든 번역문을 진짜 첨자로 그린다(첨자는 0.66배 크기 +
    baseline 이동). TextWriter 한 개를 공유해 그리므로 insert_htmlbox 같은 OOM 이 없다.
    좌/가운데 정렬 + 탐욕적 줄바꿈 + 넘치면 폰트 축소. (수식 줄은 양끝맞춤 안 함.)

    반환: drawn/complete/shrunk/min_font 상태 dict."""
    rect = fitz.Rect(rect)
    rect.normalize()
    if rect.width < 4 or rect.height < 2:
        return _draw_result()
    pr = _page_text_rect(page)
    writer_rect = fitz.Rect(page.rect)
    right = max(rect.x1, max_x if max_x is not None else pr.x1 - 6)
    bottom = max(rect.y1, max_y if max_y is not None else pr.y1 - 6)
    atoms = _parse_richtext(html_text)
    if not atoms:
        return _draw_result()
    centered = align == fitz.TEXT_ALIGN_CENTER
    right_aligned = align == fitz.TEXT_ALIGN_RIGHT
    avail_w = (rect.width if centered else (right - rect.x0)) - 1.0
    avail_w = max(8.0, avail_w)

    def cw(ch, sz):
        chosen_font = _font_for_character(ch, font, fallback_fonts)
        return chosen_font.text_length(ch, fontsize=sz)

    # (글자,style) → 단어 단위로 묶기. 공백은 줄 시작/끝에서 버리고 단어 사이에만
    # 실제 U+0020 글리프로 한 번 넣는다. 좌표만 띄우던 이전 구현은 검색/복사 시
    # 한국어 단어가 붙어 나왔고, NBSP를 쓰면 pypdf 추출 결과가 달라졌다.
    def build_words():
        words, w = [], []
        for ch, st in atoms:
            if ch.isspace() and st != "zero_space":
                if w:
                    words.append(w)
                    w = []
            else:
                w.append((ch, st))
        if w:
            words.append(w)
        return words

    words = build_words()

    def layout(fs):
        """줄 단위 배치. 반환 (lines, total_h). lines=[(y, [(x,ch,sz,dy)])]."""
        sub = 0.66
        lh = fs * 1.34
        lines = []
        cur = []
        x = rect.x0
        for word in words:
            wid = sum(
                0.0
                if st == "zero_space"
                else cw(ch, fs * sub if st in {"sub", "sup"} else fs)
                for ch, st in word
            )
            space_w = cw(" ", fs) if cur else 0.0
            if cur and (x + space_w + wid) > rect.x0 + avail_w:
                lines.append(cur)
                cur = []
                x = rect.x0
                space_w = 0.0
            if cur:
                cur.append((x, " ", fs, 0.0, "normal"))
                x += space_w
            for ch, st in word:
                sz = fs * sub if st in {"sub", "sup"} else fs
                dy = 0.0
                if st == "sub":
                    dy = fs * 0.16
                elif st == "sup":
                    dy = -fs * 0.34
                cur.append((x, ch, sz, dy, st))
                if st != "zero_space":
                    x += cw(ch, sz)
        if cur:
            lines.append(cur)
        # 줄 끝 공백 트림 폭 계산 + 가운데 정렬 보정
        return lines, len(lines) * lh, lh

    fs = max(min_size, min(float(start_size), 200.0))
    chosen = None
    while fs >= min_size:
        lines, total_h, lh = layout(fs)
        max_line_w = 0.0
        for ln in lines:
            if not ln:
                continue
            last = ln[-1]
            max_line_w = max(
                max_line_w,
                (last[0] + cw(last[1], last[2])) - rect.x0,
            )
        fits = (
            rect.y0 + total_h <= bottom + 0.5
            and max_line_w <= avail_w + 0.5
        )
        if fits:
            chosen = (lines, lh, fs, True)
            break
        fs -= 0.5
    if chosen is None:
        # 최소 크기에서도 넘치면 기존처럼 그리되 complete=False 로 보고한다.
        fs = min_size
        lines, total_h, lh = layout(fs)
        chosen = (lines, lh, fs, False)
    lines, lh, fs, layout_complete = chosen

    tw = fitz.TextWriter(writer_rect)
    y = rect.y0 + fs
    expected_chars = sum(len(line) for line in lines)
    appended_chars = 0
    append_failed = False
    for ln in lines:
        if not ln:
            y += lh
            continue
        # 가운데 정렬이면 줄 폭만큼 x 이동
        x_off = 0.0
        if centered or right_aligned:
            last = ln[-1]
            line_w = (last[0] + cw(last[1], last[2])) - ln[0][0]
            if centered:
                x_off = max(0.0, (avail_w - line_w) / 2.0)
            else:
                x_off = max(0.0, avail_w - line_w)
        for (x, ch, sz, dy, st) in ln:
            try:
                chosen_font = _font_for_character(ch, font, fallback_fonts)
                tw.append(
                    fitz.Point(x + x_off, y + dy),
                    ch,
                    font=chosen_font,
                    fontsize=sz,
                )
                appended_chars += 1
            except Exception:
                append_failed = True
        y += lh
    write_ok = False
    try:
        tw.write_text(page, color=color)
        write_ok = True
    except Exception:
        write_ok = False
    # append/write 예외가 있으면 일부 글자가 실제로 기록됐더라도 성공한 draw 로 보지 않는다.
    drawn = write_ok and not append_failed and appended_chars == expected_chars
    # 품질 게이트의 min_font는 본문 base 크기다. 첨자의 의도된 0.66배를 기준으로
    # 거부하면 정상 수식까지 오탐하므로 실제 최소 글리프 크기는 별도 진단값으로 남긴다.
    actual_min_font = (
        fs * 0.66 if any(st in {"sub", "sup"} for _ch, st in atoms) else fs
    )
    return _draw_result(
        drawn=drawn,
        complete=drawn and layout_complete,
        shrunk=fs < float(start_size) - 0.01,
        min_font=fs,
        min_glyph_font=actual_min_font,
    )


def _clip_out(rect, regions):
    """rect 에서 figure 영역을 뺀 '그림 밖' 가장 큰 직사각형을 돌려준다(완전히 그림
    안이면 None). 캡션 bbox 가 그림 위로 뻗쳐도 그림 배경을 덮지 않게(흰 자국 방지) +
    그림 안 라벨(V(RAB) 등)은 원본 그대로 둔다."""
    r = fitz.Rect(rect)
    for f in regions:
        if not r.intersects(f):
            continue
        cands = []
        if f.x0 > r.x0:
            cands.append(fitz.Rect(r.x0, r.y0, min(r.x1, f.x0), r.y1))
        if f.x1 < r.x1:
            cands.append(fitz.Rect(max(r.x0, f.x1), r.y0, r.x1, r.y1))
        if f.y0 > r.y0:
            cands.append(fitz.Rect(r.x0, r.y0, r.x1, min(r.y1, f.y0)))
        if f.y1 < r.y1:
            cands.append(fitz.Rect(r.x0, max(r.y0, f.y1), r.x1, r.y1))
        cands = [c for c in cands if c.width > 2 and c.height > 2]
        if not cands:
            return None
        r = max(cands, key=lambda c: c.width * c.height)
    return r


def _split_out_keeps(rect, keeps):
    """Subtract exact 2-D keep rectangles from a source redaction rectangle.

    The previous implementation removed the keep's *entire horizontal band*.
    When a narrow brace or equation overlapped a prose bbox by a fraction of a
    point, that left unrelated source words on the other side of the column (for
    example ``is``, ``The altitude`` and ``on the other hand``).  Four-way 2-D
    subtraction preserves the formula pixels while still redacting prose to its
    left and right.
    """
    parts = [fitz.Rect(rect)]
    for k in keeps:
        protected = fitz.Rect(k)
        if protected.is_empty:
            continue
        # Leave a sub-point antialiasing halo around preserved source glyphs.
        protected = fitz.Rect(
            protected.x0 - 0.6,
            protected.y0 - 0.6,
            protected.x1 + 0.6,
            protected.y1 + 0.6,
        )
        nxt = []
        for r in parts:
            intersection = r & protected
            if intersection.is_empty or intersection.width <= 0 or intersection.height <= 0:
                nxt.append(r)
                continue
            # Top and bottom span the full width; left and right cover only the
            # protected object's vertical band.  These pieces are disjoint, so a
            # later keep can safely subtract from them again.
            if intersection.y0 - r.y0 > 0.2:
                nxt.append(fitz.Rect(r.x0, r.y0, r.x1, intersection.y0))
            if r.y1 - intersection.y1 > 0.2:
                nxt.append(fitz.Rect(r.x0, intersection.y1, r.x1, r.y1))
            if intersection.x0 - r.x0 > 0.2:
                nxt.append(
                    fitz.Rect(r.x0, intersection.y0, intersection.x0, intersection.y1)
                )
            if r.x1 - intersection.x1 > 0.2:
                nxt.append(
                    fitz.Rect(intersection.x1, intersection.y0, r.x1, intersection.y1)
                )
        parts = nxt
    return [p for p in parts if p.width > 0.5 and p.height > 0.5]


def _formula_pdf_content_tokens(data):
    """Yield PDF content-stream tokens outside strings, names and comments.

    Formula source streams are restored from their original ``BT ... ET`` bytes.
    A regex is not safe here because a literal string may itself contain the
    letters ``BT`` or ``ET``.  This deliberately small scanner is sufficient for
    locating operators while preserving every original byte between them.
    """
    data = bytes(data or b"")
    whitespace = b"\x00\x09\x0a\x0c\x0d\x20"
    delimiters = b"()<>[]{}/%"
    index = 0
    length = len(data)
    while index < length:
        byte = data[index]
        if byte in whitespace:
            index += 1
            continue
        if byte == 0x25:  # % comment
            newline = data.find(b"\n", index + 1)
            index = length if newline < 0 else newline + 1
            continue
        if byte == 0x28:  # balanced literal string, including escaped parens
            depth = 1
            index += 1
            while index < length and depth:
                current = data[index]
                if current == 0x5C:  # backslash escape / line continuation
                    index += 2
                    continue
                if current == 0x28:
                    depth += 1
                elif current == 0x29:
                    depth -= 1
                index += 1
            continue
        if byte == 0x3C and index + 1 < length and data[index + 1] != 0x3C:
            # Hexadecimal string.  ``<<`` remains two ordinary delimiter tokens.
            close = data.find(b">", index + 1)
            index = length if close < 0 else close + 1
            continue
        if byte == 0x2F:  # /Name: never an operator
            index += 1
            while (
                index < length
                and data[index] not in whitespace
                and data[index] not in delimiters
            ):
                index += 1
            continue
        if byte in delimiters:
            index += 1
            continue
        start = index
        while (
            index < length
            and data[index] not in whitespace
            and data[index] not in delimiters
        ):
            index += 1
        yield data[start:index], start, index


def _pdf_text_object_ranges(data):
    """Return exact byte ranges for top-level ``BT ... ET`` text objects."""
    opened = None
    ranges = []
    for token, start, end in _formula_pdf_content_tokens(data):
        if token == b"BT" and opened is None:
            opened = start
        elif token == b"ET" and opened is not None:
            ranges.append((opened, end))
            opened = None
    return ranges


def _page_text_object_groups(doc, page):
    groups = []
    for xref in page.get_contents():
        raw = bytes(doc.xref_stream(int(xref)) or b"")
        for start, end in _pdf_text_object_ranges(raw):
            groups.append(
                {
                    "xref": int(xref),
                    "start": start,
                    "end": end,
                    "data": raw[start:end],
                }
            )
    return groups


def _page_standalone_text_groups(doc, page):
    """Return source text objects with their inherited state made local.

    This is the formula-specific counterpart of
    :func:`_split_safe_residual_text_stream`.  Page streams may contain figures,
    clipping and images outside text objects, so those operators are ignored while
    the fill colour and persistent PDF text state are tracked exactly.
    """
    groups = []
    for xref in page.get_contents():
        raw_data = bytes(doc.xref_stream(int(xref)) or b"")
        tokens = _pdf_content_tokens(raw_data)
        fill = b"0 g"
        text_state = dict(_PDF_TEXT_STATE_DEFAULTS)
        graphics_stack = []
        operands = []
        index = 0
        while index < len(tokens):
            kind, raw, start, end = tokens[index]
            if kind == "operand":
                operands.append(raw)
                index += 1
                continue
            if raw == b"BT":
                if operands:
                    raise RuntimeError("source text object has pending operands")
                stop = index + 1
                while stop < len(tokens):
                    skind, sraw, _ss, _se = tokens[stop]
                    if skind == "operator" and sraw == b"ET":
                        break
                    if skind == "operator" and sraw == b"BT":
                        raise RuntimeError("nested source PDF text object")
                    stop += 1
                if stop >= len(tokens):
                    raise RuntimeError("unterminated source PDF text object")
                anchor, next_state = _analyse_safe_text_object(
                    tokens[index + 1 : stop], text_state
                )
                state_parts = [
                    text_state[operator] + b" " + operator
                    for operator in (b"Tc", b"Tw", b"Tz", b"TL", b"Tr", b"Ts")
                ]
                inherited_font = text_state.get(b"Tf")
                if inherited_font is not None:
                    state_parts.append(
                        inherited_font[0] + b" " + inherited_font[1] + b" Tf"
                    )
                body = bytes(raw_data[end : tokens[stop][2]])
                standalone = (
                    b"q\n"
                    + fill
                    + b"\nBT\n"
                    + b" ".join(state_parts)
                    + b"\n"
                    + body
                    + b"\nET\nQ\n"
                )
                groups.append(
                    {
                        "xref": int(xref),
                        "start": start,
                        "end": tokens[stop][3],
                        "data": standalone,
                        "anchor_pdf": anchor,
                    }
                )
                text_state = next_state
                index = stop + 1
                continue
            if raw == b"q":
                graphics_stack.append((fill, dict(text_state)))
            elif raw == b"Q":
                if graphics_stack:
                    fill, text_state = graphics_stack.pop()
            elif raw in {b"g", b"rg", b"k"}:
                count = {b"g": 1, b"rg": 3, b"k": 4}[raw]
                if len(operands) >= count:
                    values = operands[-count:]
                    if all(_PDF_NUMBER_TOKEN.match(value) for value in values):
                        fill = b" ".join(values + [raw])
            operands = []
            index += 1
    return groups


def _preserved_span_descriptor(span):
    origin = span.get("origin") or (0.0, 0.0)
    return {
        "font": str(span.get("font", "")),
        "origin_y": float(origin[1]),
        "bbox": fitz.Rect(span.get("bbox", (0, 0, 0, 0))),
    }


def _trace_matches_preserved_span(trace, descriptors):
    font_name = str(trace.get("font", ""))
    chars = list(trace.get("chars") or [])
    if not chars:
        return False
    for descriptor in descriptors:
        if descriptor["font"] != font_name:
            continue
        source_bbox = fitz.Rect(descriptor["bbox"])
        for char in chars:
            try:
                origin = char[2]
                x, y = float(origin[0]), float(origin[1])
            except Exception:
                continue
            # Dict spans may start with a space which texttrace omits.  Matching
            # the baseline plus any visible character origin is stable across a
            # redaction rewrite and does not confuse geometrically overlapping
            # prose with the protected formula.
            if (
                abs(y - descriptor["origin_y"]) <= 0.8
                and source_bbox.x0 - 1.0 <= x <= source_bbox.x1 + 1.0
            ):
                return True
    return False


def _tight_preserved_layout_obstacle(traces, descriptors, fallback, halo=0.6):
    """Return a glyph-tight obstacle for one exactly preserved text block.

    MuPDF ``dict`` span boxes can be much taller than the glyphs they describe,
    especially for vertically positioned or damaged scientific fonts.  Those raw
    boxes remain authoritative for redaction protection and exact text-object
    replay.  Layout clipping, however, may use the union of matching texttrace
    character boxes so a phantom span tail cannot take half of a neighbouring
    prose line's width.

    Every source descriptor must be proved by an exact font plus baseline and
    in-span character origin.  If even one descriptor is not matched, fail closed
    to the original raw rectangle.
    """
    raw = fitz.Rect(fallback)
    if (
        not descriptors
        or raw.is_empty
        or raw.width <= 0
        or raw.height <= 0
    ):
        return raw

    matched_boxes = []
    for descriptor in descriptors:
        source_bbox = fitz.Rect(descriptor["bbox"])
        descriptor_boxes = []
        for trace in traces:
            if str(trace.get("font", "")) != descriptor["font"]:
                continue
            for char in trace.get("chars") or []:
                try:
                    origin = char[2]
                    char_bbox = fitz.Rect(char[3])
                    x, y = float(origin[0]), float(origin[1])
                except Exception:
                    continue
                if (
                    abs(y - descriptor["origin_y"]) <= 0.8
                    and source_bbox.x0 - 1.0 <= x <= source_bbox.x1 + 1.0
                    and not char_bbox.is_empty
                    and char_bbox.width > 0
                    and char_bbox.height > 0
                ):
                    descriptor_boxes.append(char_bbox)
        if not descriptor_boxes:
            return raw
        matched_boxes.extend(descriptor_boxes)

    tight = fitz.Rect(matched_boxes[0])
    for char_bbox in matched_boxes[1:]:
        tight |= char_bbox
    padding = max(0.0, float(halo))
    tight = fitz.Rect(
        max(raw.x0, tight.x0 - padding),
        max(raw.y0, tight.y0 - padding),
        min(raw.x1, tight.x1 + padding),
        min(raw.y1, tight.y1 + padding),
    )
    if tight.is_empty or tight.width <= 0 or tight.height <= 0:
        return raw
    return tight


def _preserved_text_group_indexes(page, groups, descriptors):
    if not descriptors:
        return []
    text_log = [
        sequence
        for sequence, (kind, _bbox) in enumerate(page.get_bboxlog())
        if "text" in str(kind)
    ]
    if len(groups) != len(text_log):
        raise RuntimeError(
            "cannot prove preserved formula text-object mapping: "
            f"content_groups={len(groups)}, bboxlog_text={len(text_log)}"
        )
    traces_by_sequence = defaultdict(list)
    for trace in page.get_texttrace():
        traces_by_sequence[int(trace.get("seqno", -1))].append(trace)
    selected = []
    for group_index, sequence in enumerate(text_log):
        if any(
            _trace_matches_preserved_span(trace, descriptors)
            for trace in traces_by_sequence.get(sequence, [])
        ):
            selected.append(group_index)
    return selected


def _clip_preserved_text_group(page, data, descriptors, halo=0.75):
    """Clip one replayed source text object to its proven preserved spans.

    Some textbook producers put a formula glyph and distant prose in the same
    ``Tj`` / ``TJ`` object by using very large character spacing.  Redaction can
    safely remove the prose glyphs, but formula replay used to restore the whole
    text object and thereby resurrect source words such as ``circle``.  The
    descriptor bboxes are already bound to exact font, baseline and character
    origins, so use their union as a PDF clipping path around the replay.
    """
    inverse = ~page.transformation_matrix
    paths = []
    for descriptor in descriptors:
        rect = fitz.Rect(descriptor["bbox"])
        padding = max(0.0, float(halo))
        rect = fitz.Rect(
            rect.x0 - padding,
            rect.y0 - padding,
            rect.x1 + padding,
            rect.y1 + padding,
        ) & page.rect
        if rect.is_empty or rect.width <= 0 or rect.height <= 0:
            continue
        pdf_rect = rect * inverse
        values = (pdf_rect.x0, pdf_rect.y0, pdf_rect.width, pdf_rect.height)
        if not all(math.isfinite(value) for value in values):
            raise RuntimeError("preserved formula clip has non-finite geometry")
        paths.append(
            "{:.6f} {:.6f} {:.6f} {:.6f} re".format(*values).encode("ascii")
        )
    if not paths:
        raise RuntimeError("preserved formula clip has no valid geometry")
    return b"q\n" + b"\n".join(paths) + b"\nW n\n" + bytes(data) + b"\nQ\n"


def _build_preserved_text_overlay(doc, page, descriptors):
    """Snapshot exact source formula text operators for post-redaction replay."""
    groups = _page_standalone_text_groups(doc, page)
    selected = _preserved_text_group_indexes(page, groups, descriptors)
    if not selected:
        raise RuntimeError("preserved formula has no source text-object mapping")
    text_log = [
        sequence
        for sequence, (kind, _bbox) in enumerate(page.get_bboxlog())
        if "text" in str(kind)
    ]
    traces_by_sequence = defaultdict(list)
    for trace in page.get_texttrace():
        traces_by_sequence[int(trace.get("seqno", -1))].append(trace)
    # Each standalone chunk preserves the original font, glyph IDs, matrices,
    # persistent text spacing, fill colour and CFF encoding.  Clip each selected
    # object to only the descriptors that actually selected that object: a distant
    # prose glyph can share its TJ byte string with a formula glyph.
    chunks = []
    for index in selected:
        matching = [
            descriptor
            for descriptor in descriptors
            if any(
                _trace_matches_preserved_span(trace, [descriptor])
                for trace in traces_by_sequence.get(text_log[index], [])
            )
        ]
        if not matching:
            raise RuntimeError("preserved formula text object lost its descriptor binding")
        chunks.append(
            _clip_preserved_text_group(page, groups[index]["data"], matching)
        )
        chunks.append(b"\n")
    return b"".join(chunks), len(selected)


def _remove_preserved_text_objects(doc, page, descriptors):
    """Remove the redaction-damaged copy before replaying original formula text."""
    groups = _page_text_object_groups(doc, page)
    selected = _preserved_text_group_indexes(page, groups, descriptors)
    removals = defaultdict(list)
    for index in selected:
        group = groups[index]
        removals[group["xref"]].append((group["start"], group["end"]))
    for xref, ranges in removals.items():
        raw = bytes(doc.xref_stream(xref) or b"")
        output = []
        cursor = 0
        for start, end in sorted(ranges):
            output.append(raw[cursor:start])
            output.append(b" ")
            cursor = end
        output.append(raw[cursor:])
        doc.update_stream(xref, b"".join(output))
    return len(selected)


def _append_page_content_stream(doc, page, data):
    if not data:
        return page
    stream_xref = doc.get_new_xref()
    doc.update_object(stream_xref, "<<>>")
    doc.update_stream(stream_xref, bytes(data))
    page_xref = doc.page_xref(page.number)
    value_type, raw_value = doc.xref_get_key(page_xref, "Contents")
    if value_type == "array":
        updated = raw_value[:-1] + f" {stream_xref} 0 R]"
    elif value_type == "xref":
        updated = f"[{raw_value} {stream_xref} 0 R]"
    else:
        updated = f"[{stream_xref} 0 R]"
    doc.xref_set_key(page_xref, "Contents", updated)
    return doc.reload_page(page)


def _translated_source_residuals(page, redactions, protected_regions):
    """Find original-font English still visible inside translated source boxes.

    This is a postflight proof for the renderer's own redaction scope, not a
    language detector for the translated prose.  Generated text uses Quilo's
    bundled fonts and is ignored.  Original formula / figure text is also ignored
    when its centre remains inside an explicitly protected rectangle.
    """
    residuals = []
    protected = [fitz.Rect(region) for region in protected_regions]
    try:
        blocks = page.get_text("dict").get("blocks", [])
    except Exception:
        return [{"id": None, "text": "<text inspection failed>"}]
    for block in blocks:
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = str(span.get("text", ""))
                if not re.search(r"[A-Za-z]{2,}", text):
                    continue
                font_name = str(span.get("font", ""))
                if any(
                    marker in font_name.lower()
                    for marker in ("pretendard", "nanum", "quilo")
                ):
                    continue
                span_rect = fitz.Rect(span.get("bbox", (0, 0, 0, 0)))
                cx = (span_rect.x0 + span_rect.x1) / 2.0
                cy = (span_rect.y0 + span_rect.y1) / 2.0
                for rect, _color, is_table, bid in redactions:
                    source_rect = fitz.Rect(rect)
                    if not (
                        source_rect.x0 - 0.5 <= cx <= source_rect.x1 + 0.5
                        and source_rect.y0 - 0.5 <= cy <= source_rect.y1 + 0.5
                    ):
                        continue
                    if not is_table and any(
                        region.x0 - 0.75 <= cx <= region.x1 + 0.75
                        and region.y0 - 0.75 <= cy <= region.y1 + 0.75
                        for region in protected
                    ):
                        continue
                    residuals.append(
                        {
                            "id": bid,
                            "text": text[:80],
                            "bbox": [round(value, 2) for value in span_rect],
                            "font": font_name,
                        }
                    )
                    break
    return residuals


def _dedoverlap_column(items):
    """같은 단(column)에서 세로로 겹치는 블록들을 중점에서 잘라 분리한다.
    원본 PDF 의 블록 bbox 가 위/아래첨자 경계(예: H₂⁺)에서 서로 겹치는 경우가 있어,
    그대로 두면 두 번역문이 같은 자리(같은 y 띠)에 겹쳐 그려져 글자가 뭉친다."""
    order = sorted(range(len(items)), key=lambda i: (items[i][0].y0, items[i][0].x0))
    rects = [fitz.Rect(items[i][0]) for i in order]
    for a in range(len(order)):
        for b in range(a + 1, len(order)):
            ra, rb = rects[a], rects[b]
            if ra.y1 <= rb.y0 or rb.y1 <= ra.y0:
                continue  # 세로로 안 겹침
            ox = min(ra.x1, rb.x1) - max(ra.x0, rb.x0)
            if ox <= 0.30 * min(ra.width, rb.width):
                continue  # 가로로 거의 안 겹침 = 다른 단 → 그대로
            mid = (max(ra.y0, rb.y0) + min(ra.y1, rb.y1)) / 2.0
            top, bot = (ra, rb) if ra.y0 <= rb.y0 else (rb, ra)
            top.y1 = min(top.y1, mid)
            bot.y0 = max(bot.y0, mid)
    out = list(items)
    for k, i in enumerate(order):
        r = rects[k]
        if r.height < 3:
            r.y1 = r.y0 + 3.0
        out[i] = (r,) + tuple(items[i][1:])
    return out


def _est_text_height(text, width, fs, font):
    """번역문이 폭 width 에서 차지할 대략 높이(줄 수 × 줄간격). 겹침 방지를 위해
    살짝 넉넉히 잡는다(유효폭 90%·줄간격 1.34) — 과소추정하면 다음 블록과 겹친다."""
    if width < 6 or fs <= 0:
        return max(fs, 1.0) * 1.34
    text = _strip_tags(text)  # <sub>/<sup> 태그는 폭에서 제외
    try:
        tl = font.text_length(text, fontsize=fs)
    except Exception:
        tl = len(text) * fs * 0.5
    eff = max(1.0, width * 0.90)
    lines = max(1, int(math.ceil(tl / eff)))
    return lines * fs * 1.34


def _rects_overlap(a, b, min_frac=0.12):
    """두 rect 가 의미있게 2D 로 겹치는지(겹침 면적이 작은 폭의 min_frac 이상)."""
    ix = min(a.x1, b.x1) - max(a.x0, b.x0)
    iy = min(a.y1, b.y1) - max(a.y0, b.y0)
    return ix > 2 and iy > 2 and ix > min_frac * min(a.width, max(b.width, 1.0))


def _expand_lowercase_formula_tails_upward(
    items,
    static_rects,
    figs,
    formula_rects,
    source_text_by_id,
    page_rect,
    font,
    minimum_readable_size=8.0,
):
    """Use proven blank space above a page-continuation tail before a formula.

    A producer may place the last two prose lines immediately before an inline
    formula whose bbox overlaps the prose bbox by a point or two.  When that prose
    is the lowercase continuation of a previous-page sentence, Korean can need one
    additional line.  Generic compaction excludes the block because the *source*
    bboxes overlap, forcing a 7pt render even when a blank caption-to-prose gap is
    available directly above it.

    This repair is deliberately fail-closed: the source must begin lowercase, be a
    substantial unfinished prose tail, touch a preserved formula below, and have a
    completely obstacle-free gap above.  The adjusted draw rect ends before the
    formula and is used only when it can fit the target at the normal 8pt floor.
    Original redaction geometry remains unchanged in the caller.
    """
    if not items:
        return items
    page_rect = fitz.Rect(page_rect)
    fixed = [fitz.Rect(value) for value in static_rects] + [
        fitz.Rect(value) for value in figs
    ]
    source_rects = [fitz.Rect(item[0]) for item in items]
    out = list(items)
    for index, item in enumerate(items):
        rect, target, source_size, _color, _bold, _italic, block_id = item
        rect = fitz.Rect(rect)
        source = " ".join(
            _strip_tags(str(source_text_by_id.get(block_id, ""))).split()
        )
        # A column / figure can sit between the two visual fragments of one
        # hyphenated word.  In Fundamental Astronomy, for example, ID 419 ends
        # with ``fur-``, ID 420 is the intervening figure caption, and ID 421
        # starts with ``ther ...``.  ID 421 itself ends with a full stop, so the
        # older ``_ends_midsentence`` test made the safe upward expansion depend
        # on how verbose a particular Korean answer happened to be.  Bind this
        # exception to a nearby source ID that visibly ends in an alphabetic
        # discretionary hyphen; ordinary lowercase paragraphs remain excluded.
        hyphenated_predecessor = False
        try:
            numeric_id = int(block_id)
        except (TypeError, ValueError):
            numeric_id = None
        if numeric_id is not None:
            for delta in range(1, 4):
                previous = source_text_by_id.get(numeric_id - delta)
                if previous is None:
                    previous = source_text_by_id.get(str(numeric_id - delta), "")
                previous = " ".join(
                    _strip_tags(str(previous or "")).split()
                )
                if re.search(r"[A-Za-z]{2,}[-\u00ad\u2010\u2011]\s*$", previous):
                    hyphenated_predecessor = True
                    break
        if (
            not re.match(r"^[\s\"'‘“(\[]*[a-z]", source)
            or len(re.findall(r"[A-Za-z]+", source)) < 10
            or not (_ends_midsentence(source) or hyphenated_predecessor)
            or rect.height > 3.2 * max(float(source_size), 1.0)
        ):
            continue
        formula = None
        for candidate in formula_rects:
            candidate = fitz.Rect(candidate)
            overlap_x = min(rect.x1, candidate.x1) - max(rect.x0, candidate.x0)
            gap = candidate.y0 - rect.y1
            if (
                overlap_x > 2.0
                and gap >= -0.30 * max(float(source_size), 1.0)
                and gap <= 0.35 * max(float(source_size), 1.0)
            ):
                formula = candidate
                break
        # A proven hyphen continuation can use the verified blank band above even
        # when no separate formula rectangle follows it.  This is the actual
        # Fig. 3.24 layout: the caption ends above ``fur-`` / ``ther ...`` and the
        # next ordinary prose block prevents downward growth.  All obstacle and
        # overlap checks below still apply, so this does not become a generic
        # paragraph-expansion path.
        if formula is None and not hyphenated_predecessor:
            continue
        safe_bottom = (
            min(rect.y1, formula.y0 - 2.0)
            if formula is not None
            else rect.y1
        )
        current_height = max(0.0, safe_bottom - rect.y0)
        needed = _est_text_height(
            target, rect.width, minimum_readable_size, font
        )
        if needed <= current_height + 0.5:
            continue

        horizontal_obstacles = []
        for obstacle in fixed + [
            value for position, value in enumerate(source_rects) if position != index
        ]:
            overlap_x = min(rect.x1, obstacle.x1) - max(rect.x0, obstacle.x0)
            if overlap_x > 0.10 * min(rect.width, max(obstacle.width, 1.0)):
                horizontal_obstacles.append(obstacle)
        ceilings = [
            obstacle.y1
            for obstacle in horizontal_obstacles
            if obstacle.y1 <= rect.y0 + 0.5
        ]
        ceiling = max(ceilings, default=page_rect.y0 + 6.0)
        new_y0 = max(ceiling + 2.0, safe_bottom - needed)
        if new_y0 >= rect.y0 - 0.5:
            continue
        candidate_rect = fitz.Rect(rect.x0, new_y0, rect.x1, safe_bottom)
        if candidate_rect.height + 0.5 < needed:
            continue
        if any(
            _rects_overlap(candidate_rect, obstacle, 0.02)
            for obstacle in horizontal_obstacles
            if obstacle.y0 < safe_bottom - 0.5 and obstacle.y1 > new_y0 + 0.5
        ):
            continue
        out[index] = (candidate_rect,) + tuple(item[1:])
    return out


def _compact_columns(items, static_rects, figs, page_rect, font):
    """세로 압축 — 번역문이 원문보다 짧아(한국어 underflow) 블록마다 박스 아래가 비고,
    그 빈칸이 누적돼 문단 사이가 크게 벌어지는 것을 막는다. 같은 단의 본문 블록을
    위로 끌어올려 '원래 문단 간격'만 남기고 underflow 빈칸을 없앤다(누적 빈칸은 단
    아래쪽 한 곳으로 모인다 → 페이지가 자연스러워진다).

    겹침 절대 금지(안전망):
      - 블록은 위로만 이동(아래로 안 밀어 다른 글자를 침범하지 않음).
      - cursor: 다음 블록 새 y0 >= 직전 블록 글자 끝 → 같은 단 글자끼리 안 겹침.
      - **revert-on-overlap**: 새 위치가 어떤 앵커(번역 안 된 블록·수식·라벨·그림)나
        이미 배치된 다른 번역 글자와 겹치면 그 블록은 원위치로 되돌린다 → 압축이
        절대 새 겹침을 만들지 않는다(복잡한 수식·그림 페이지에서도 안전).
      - 머리말/꼬리말·그림과 겹치는 블록(캡션)은 이동 제외(앵커로만 작용).
    items: [(rect, ko, size, color, bold, ital, block_id), ...] (dedoverlap 후).
    반환 동일 형식.
    """
    if os.environ.get("NO_COMPACT"):
        return items
    if len(items) < 2:
        return items
    pw = page_rect.width
    ph = page_rect.height
    top_margin = page_rect.y0 + 0.07 * ph
    bot_margin = page_rect.y1 - 0.055 * ph
    fig_rects = [fitz.Rect(f) for f in figs]
    static_r = [fitz.Rect(s) for s in static_rects]
    item_r = [fitz.Rect(it[0]) for it in items]

    def has_orig_overlap(i):
        # 원위치에서 다른 블록(번역/미번역)과 이미 겹치는 블록 = 깨진 인라인 수식 등
        # 어수선한 영역 → 이동하면 겹침을 키운다. 압축 대상에서 제외(원위치 유지).
        ri = item_r[i]
        for k, o in enumerate(item_r):
            if k != i and _rects_overlap(ri, o, 0.10):
                return True
        for o in static_r:
            if _rects_overlap(ri, o, 0.10):
                return True
        return False

    def excluded(i):
        r = items[i][0]
        cy = (r.y0 + r.y1) / 2.0
        if cy < top_margin or cy > bot_margin:
            return True  # 머리말/꼬리말 고정
        if any(_rects_overlap(r, f, 0.0) for f in fig_rects):
            return True  # 그림에 붙은 블록(캡션 등)은 이동 제외
        if has_orig_overlap(i):
            return True  # 원위치부터 겹치는 어수선한 블록(깨진 수식 등) → 이동 제외
        return False

    movable = [i for i in range(len(items)) if not excluded(i)]
    if len(movable) < 2:
        return items
    movable_set = set(movable)
    # 고정 장애물 = 번역 안 된 블록 + 그림 + 이동 제외된(머리말/캡션) 블록 원위치.
    fixed = (
        [fitz.Rect(s) for s in static_rects]
        + fig_rects
        + [fitz.Rect(items[i][0]) for i in range(len(items)) if i not in movable_set]
    )

    centers = sorted((items[i][0].x0 + items[i][0].x1) / 2.0 for i in movable)
    split_x = None
    for a, b in zip(centers, centers[1:]):
        if b - a > 0.22 * pw:
            split_x = (a + b) / 2.0
            break

    def col_of(i):
        cx = (items[i][0].x0 + items[i][0].x1) / 2.0
        return 0 if (split_x is None or cx < split_x) else 1

    new_items = list(items)
    for col in (0, 1):
        idxs = sorted(
            [i for i in movable if col_of(i) == col],
            key=lambda i: items[i][0].y0,
        )
        if len(idxs) < 2:
            continue
        placed = []  # 이 단에 배치된 (새) 글자 rect 들 — 겹침 검사 대상.
        cursor = None  # 직전까지 배치된 내용의 아래 끝(단조 증가)
        prev_orig_y1 = None
        for i in idxs:
            r = items[i][0]
            th = _est_text_height(items[i][1], r.width, items[i][2] or 10.0, font)
            box_h = min(th, r.height)

            def keep_original():
                # 원위치 유지(절대 아래로 안 민다). cursor = '번역 글자'의 아래 끝(원위치
                # 기준) — 원래 박스 끝(r.y1)이 아니라 짧아진 번역 끝이어야 다음 블록이
                # 그 밑 빈칸으로 올라올 수 있다(세로압축의 핵심).
                placed.append(fitz.Rect(r.x0, r.y0, r.x1, r.y0 + box_h))
                return max(cursor or 0.0, r.y0 + box_h)

            if cursor is None or th >= r.height - 1.0:
                # 첫 블록이거나 underflow 아님 → 원위치 유지.
                cursor = keep_original()
                prev_orig_y1 = r.y1
                continue
            orig_gap = max(0.0, r.y0 - prev_orig_y1)
            target = cursor + orig_gap  # 위로 끌어올릴 목표 위치
            # 끌어올릴 여유가 없으면(겹쳐 있던 블록 등) 원위치 유지 — 절대 아래로 안 민다.
            if target >= r.y0 - 0.5:
                cursor = keep_original()
                prev_orig_y1 = r.y1
                continue
            cand = fitz.Rect(r.x0, target, r.x1, target + box_h)
            # 위로 올린 위치가 고정 앵커/이미 배치된 글자와 겹치면 → 원위치로 되돌림.
            if any(_rects_overlap(cand, o) for o in fixed) or any(
                _rects_overlap(cand, o) for o in placed
            ):
                cursor = keep_original()
                prev_orig_y1 = r.y1
                continue
            new_items[i] = (cand,) + tuple(items[i][1:])
            placed.append(fitz.Rect(cand))
            cursor = target + box_h
            prev_orig_y1 = r.y1
    return new_items


# ── Safe content-stream ordering for preserved text ──────────────────────────
#
# Redaction leaves equations / labels which are intentionally not translated in
# the original content stream, then appends each translated TextWriter stream.  A
# visual PDF reader looks correct, but content-order extractors consequently return
# every preserved equation before the page title.  The helpers below support only a
# deliberately narrow subset: page-local, top-level BT..ET objects with their own
# font and position, an identity CTM, device fill colour, no clipping / ExtGState /
# Form XObject, and ordinary Tj/TJ showing.  Anything more complex is left untouched
# for the strict postflight verifier to reject.  Applied rewrites additionally must
# be pixel-identical or the original /Contents array is restored.

_PDF_CONTENT_WHITESPACE = b"\x00\x09\x0a\x0c\x0d\x20"
_PDF_CONTENT_DELIMITERS = b"()<>[]{}/%"
_PDF_NUMBER_TOKEN = re.compile(rb"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$")
_PDF_UNSAFE_REORDER_OPERATORS = frozenset(
    {b"Do", b"BI", b"ID", b"EI", b"W", b"W*", b"gs", b"sh", b"cs", b"CS", b"sc", b"SC", b"scn", b"SCN"}
)
_PDF_TEXT_OPERATORS = frozenset(
    {b"Tf", b"Tm", b"Td", b"TD", b"T*", b"Tj", b"TJ", b"Tc", b"Tw", b"Tz", b"TL", b"Tr", b"Ts"}
)
_PDF_TEXT_STATE_DEFAULTS = {
    b"Tc": b"0",
    b"Tw": b"0",
    b"Tz": b"100",
    b"TL": b"0",
    b"Tr": b"0",
    b"Ts": b"0",
}


def _pdf_content_tokens(data):
    """Lex a PDF content stream without mistaking strings for operators.

    Returned entries are ``(kind, raw, start, end)``.  This is intentionally not a
    general PDF parser; it only establishes exact token boundaries needed by the
    conservative BT/ET splitter.
    """
    data = bytes(data or b"")
    out = []
    length = len(data)
    i = 0
    while i < length:
        byte = data[i]
        if byte in _PDF_CONTENT_WHITESPACE:
            i += 1
            continue
        if byte == 0x25:  # % comment
            i += 1
            while i < length and data[i] not in (0x0A, 0x0D):
                i += 1
            continue
        start = i
        if byte == 0x28:  # literal string, with nesting and escapes
            depth = 1
            i += 1
            while i < length and depth:
                current = data[i]
                if current == 0x5C:  # escaped byte / escaped newline
                    i += 2
                    continue
                if current == 0x28:
                    depth += 1
                elif current == 0x29:
                    depth -= 1
                i += 1
            if depth:
                raise ValueError("unterminated PDF literal string")
            out.append(("operand", data[start:i], start, i))
            continue
        if byte == 0x3C and i + 1 < length and data[i + 1] != 0x3C:
            # Hex string. Embedded ASCII 'BT' / 'ET' is data, never an operator.
            i += 1
            while i < length and data[i] != 0x3E:
                i += 1
            if i >= length:
                raise ValueError("unterminated PDF hex string")
            i += 1
            out.append(("operand", data[start:i], start, i))
            continue
        if byte == 0x2F:  # name object
            i += 1
            while (
                i < length
                and data[i] not in _PDF_CONTENT_WHITESPACE
                and data[i] not in _PDF_CONTENT_DELIMITERS
            ):
                i += 1
            out.append(("operand", data[start:i], start, i))
            continue
        if byte in b"[]{}<>":
            if byte in (0x3C, 0x3E) and i + 1 < length and data[i + 1] == byte:
                i += 2
            else:
                i += 1
            out.append(("operand", data[start:i], start, i))
            continue
        i += 1
        while (
            i < length
            and data[i] not in _PDF_CONTENT_WHITESPACE
            and data[i] not in _PDF_CONTENT_DELIMITERS
        ):
            i += 1
        raw = data[start:i]
        kind = "operand" if _PDF_NUMBER_TOKEN.match(raw) else "operator"
        out.append((kind, raw, start, i))
    return out


def _pdf_number(raw):
    if not _PDF_NUMBER_TOKEN.match(raw or b""):
        raise ValueError("non-numeric PDF operand")
    value = float(raw)
    if not math.isfinite(value):
        raise ValueError("non-finite PDF operand")
    return value


def _analyse_safe_text_object(tokens, current_text_state):
    """Validate one BT..ET body and return anchor + next persistent text state."""
    operands = []
    # Text state survives ET / the next BT.  ReportLab relies on this and commonly
    # emits ``Tf`` only for the first cell in a row, followed by independently
    # positioned ``BT ... TD (...) Tj ET`` objects.  Treat an inherited font as
    # sufficient only when it was established by a previously validated Tf.
    has_font = b"Tf" in current_text_state
    has_show = False
    anchor = None
    state = dict(current_text_state)
    for kind, raw, _start, _end in tokens:
        if kind == "operand":
            operands.append(raw)
            continue
        if raw in _PDF_UNSAFE_REORDER_OPERATORS or raw in {b"BT", b"ET", b"q", b"Q", b"cm"}:
            raise ValueError(f"unsafe operator in preserved text object: {raw!r}")
        if raw not in _PDF_TEXT_OPERATORS:
            # Marked content, compatibility sections, inline graphics, and custom
            # operators are outside the proven byte-preserving subset.
            raise ValueError(f"unsupported preserved text operator: {raw!r}")
        if raw == b"Tf":
            if len(operands) < 2 or not operands[-2].startswith(b"/"):
                raise ValueError("preserved text object lacks a local font operand")
            _pdf_number(operands[-1])
            has_font = True
            state[b"Tf"] = (operands[-2], operands[-1])
        elif raw == b"Tm":
            if len(operands) < 6:
                raise ValueError("invalid Tm operand count")
            values = [_pdf_number(value) for value in operands[-6:]]
            if anchor is None:
                anchor = (values[4], values[5])
        elif raw in {b"Td", b"TD"}:
            if len(operands) < 2:
                raise ValueError("invalid text-position operand count")
            values = [_pdf_number(value) for value in operands[-2:]]
            if anchor is None:
                anchor = (values[0], values[1])
        elif raw in {b"Tj", b"TJ"}:
            if not operands:
                raise ValueError("text showing operator lacks an operand")
            has_show = True
        elif raw in _PDF_TEXT_STATE_DEFAULTS:
            if not operands:
                raise ValueError("text state operator lacks an operand")
            value = operands[-1]
            numeric = _pdf_number(value)
            if raw == b"Tr" and abs(numeric) > 1e-9:
                # Stroke / clip text depends on stroke graphics state and clipping.
                raise ValueError("non-fill text rendering mode is not reorder-safe")
            state[raw] = value
        operands = []
    if not has_font or not has_show or anchor is None:
        raise ValueError("preserved text object is not independently positioned")
    return anchor, state


def _split_safe_residual_text_stream(data):
    """Return ``(graphics_only, chunks)`` or ``None`` for an unsupported stream.

    Each chunk is ``{"data": bytes, "anchor_pdf": (x, y)}``.  The raw text body is
    retained byte-for-byte; only a local device fill colour and default/persistent
    text-state prefix are added so the object no longer depends on an earlier BT.
    """
    try:
        tokens = _pdf_content_tokens(data)
        if not any(kind == "operator" and raw == b"BT" for kind, raw, _s, _e in tokens):
            return bytes(data), []
        if any(
            kind == "operator" and raw in _PDF_UNSAFE_REORDER_OPERATORS
            for kind, raw, _s, _e in tokens
        ):
            return None

        fill = b"0 g"
        graphics_state_stack = []
        text_state = dict(_PDF_TEXT_STATE_DEFAULTS)
        operands = []
        chunks = []
        removals = []
        index = 0
        while index < len(tokens):
            kind, raw, start, end = tokens[index]
            if kind == "operand":
                operands.append(raw)
                index += 1
                continue
            if raw == b"BT":
                if operands:
                    return None
                depth = 1
                stop = index + 1
                while stop < len(tokens):
                    skind, sraw, _ss, _se = tokens[stop]
                    if skind == "operator" and sraw == b"BT":
                        depth += 1
                    elif skind == "operator" and sraw == b"ET":
                        depth -= 1
                        if depth == 0:
                            break
                    stop += 1
                if stop >= len(tokens) or depth:
                    return None
                body_tokens = tokens[index + 1 : stop]
                anchor, next_state = _analyse_safe_text_object(
                    body_tokens, text_state
                )
                # Every separated stream starts with default text state.  Reapply
                # the exact state active before this BT, then retain its body bytes.
                state_parts = [
                    text_state[operator] + b" " + operator
                    for operator in (b"Tc", b"Tw", b"Tz", b"TL", b"Tr", b"Ts")
                ]
                inherited_font = text_state.get(b"Tf")
                if inherited_font is not None:
                    state_parts.append(
                        inherited_font[0] + b" " + inherited_font[1] + b" Tf"
                    )
                state_prefix = b" ".join(state_parts)
                et_end = tokens[stop][3]
                body = bytes(data[end : tokens[stop][2]])
                chunk = (
                    b"q\n"
                    + fill
                    + b"\nBT\n"
                    + state_prefix
                    + b"\n"
                    + body
                    + b"\nET\nQ\n"
                )
                chunks.append({"data": chunk, "anchor_pdf": anchor})
                removals.append((start, et_end))
                text_state = next_state
                index = stop + 1
                continue
            if raw == b"q":
                # q/Q saves and restores the text state as part of the graphics
                # state.  Do not let a font selected inside one saved scope leak
                # into a later scope when the separated chunks are made standalone.
                graphics_state_stack.append((fill, dict(text_state)))
            elif raw == b"Q":
                if not graphics_state_stack:
                    return None
                fill, text_state = graphics_state_stack.pop()
            elif raw in {b"g", b"rg", b"k"}:
                count = {b"g": 1, b"rg": 3, b"k": 4}[raw]
                if len(operands) < count:
                    return None
                values = operands[-count:]
                for value in values:
                    _pdf_number(value)
                fill = b" ".join(values + [raw])
            elif raw == b"cm":
                if len(operands) < 6:
                    return None
                matrix = [_pdf_number(value) for value in operands[-6:]]
                if any(
                    abs(actual - expected) > 1e-9
                    for actual, expected in zip(matrix, (1, 0, 0, 1, 0, 0))
                ):
                    return None
            elif raw in _PDF_UNSAFE_REORDER_OPERATORS or raw in {b"ET"}:
                return None
            operands = []
            index += 1
        if graphics_state_stack:
            return None

        graphics = bytearray(data)
        for start, end in removals:
            # Whitespace preserves token separation and every non-text byte offset.
            graphics[start:end] = b"\n" + b" " * max(0, end - start - 1)
        return bytes(graphics), chunks
    except (ValueError, TypeError, OverflowError):
        return None


def _page_standalone_text_groups(doc, page):
    """Return source text objects with inherited fill/text state made local."""
    groups = []
    for xref in page.get_contents():
        raw_data = bytes(doc.xref_stream(int(xref)) or b"")
        tokens = _pdf_content_tokens(raw_data)
        fill = b"0 g"
        text_state = dict(_PDF_TEXT_STATE_DEFAULTS)
        graphics_stack = []
        operands = []
        index = 0
        while index < len(tokens):
            kind, raw, start, end = tokens[index]
            if kind == "operand":
                operands.append(raw)
                index += 1
                continue
            if raw == b"BT":
                if operands:
                    raise RuntimeError("source text object has pending operands")
                stop = index + 1
                while stop < len(tokens):
                    skind, sraw, _ss, _se = tokens[stop]
                    if skind == "operator" and sraw == b"ET":
                        break
                    if skind == "operator" and sraw == b"BT":
                        raise RuntimeError("nested source PDF text object")
                    stop += 1
                if stop >= len(tokens):
                    raise RuntimeError("unterminated source PDF text object")
                anchor, next_state = _analyse_safe_text_object(
                    tokens[index + 1 : stop], text_state
                )
                state_parts = [
                    text_state[operator] + b" " + operator
                    for operator in (b"Tc", b"Tw", b"Tz", b"TL", b"Tr", b"Ts")
                ]
                inherited_font = text_state.get(b"Tf")
                if inherited_font is not None:
                    state_parts.append(
                        inherited_font[0] + b" " + inherited_font[1] + b" Tf"
                    )
                body = bytes(raw_data[end : tokens[stop][2]])
                standalone = (
                    b"q\n"
                    + fill
                    + b"\nBT\n"
                    + b" ".join(state_parts)
                    + b"\n"
                    + body
                    + b"\nET\nQ\n"
                )
                groups.append(
                    {
                        "xref": int(xref),
                        "start": start,
                        "end": tokens[stop][3],
                        "data": standalone,
                        "anchor_pdf": anchor,
                    }
                )
                text_state = next_state
                index = stop + 1
                continue
            if raw == b"q":
                graphics_stack.append((fill, dict(text_state)))
            elif raw == b"Q":
                if graphics_stack:
                    fill, text_state = graphics_stack.pop()
            elif raw in {b"g", b"rg", b"k"}:
                count = {b"g": 1, b"rg": 3, b"k": 4}[raw]
                if len(operands) >= count:
                    values = operands[-count:]
                    if all(_PDF_NUMBER_TOKEN.match(value) for value in values):
                        fill = b" ".join(values + [raw])
            operands = []
            index += 1
    return groups


def _preserved_span_descriptor(span):
    origin = span.get("origin") or (0.0, 0.0)
    return {
        "font": str(span.get("font", "")),
        "origin_y": float(origin[1]),
        "bbox": fitz.Rect(span.get("bbox", (0, 0, 0, 0))),
    }


def _trace_matches_preserved_span(trace, descriptors):
    font_name = str(trace.get("font", ""))
    chars = list(trace.get("chars") or [])
    if not chars:
        return False
    for descriptor in descriptors:
        if descriptor["font"] != font_name:
            continue
        source_bbox = fitz.Rect(descriptor["bbox"])
        for char in chars:
            try:
                origin = char[2]
                x, y = float(origin[0]), float(origin[1])
            except Exception:
                continue
            if (
                abs(y - descriptor["origin_y"]) <= 0.8
                and source_bbox.x0 - 1.0 <= x <= source_bbox.x1 + 1.0
            ):
                return True
    return False


def _preserved_text_group_indexes(page, groups, descriptors):
    if not descriptors:
        return []
    text_log = [
        sequence
        for sequence, (kind, _bbox) in enumerate(page.get_bboxlog())
        if "text" in str(kind)
    ]
    if len(groups) != len(text_log):
        raise RuntimeError(
            "cannot prove preserved formula text-object mapping: "
            f"content_groups={len(groups)}, bboxlog_text={len(text_log)}"
        )
    traces_by_sequence = defaultdict(list)
    for trace in page.get_texttrace():
        traces_by_sequence[int(trace.get("seqno", -1))].append(trace)
    selected = []
    for group_index, sequence in enumerate(text_log):
        if any(
            _trace_matches_preserved_span(trace, descriptors)
            for trace in traces_by_sequence.get(sequence, [])
        ):
            selected.append(group_index)
    return selected


def _clip_preserved_text_group(page, data, descriptors, halo=0.75):
    inverse = ~page.transformation_matrix
    paths = []
    for descriptor in descriptors:
        rect = fitz.Rect(descriptor["bbox"])
        padding = max(0.0, float(halo))
        rect = fitz.Rect(
            rect.x0 - padding,
            rect.y0 - padding,
            rect.x1 + padding,
            rect.y1 + padding,
        ) & page.rect
        if rect.is_empty or rect.width <= 0 or rect.height <= 0:
            continue
        pdf_rect = rect * inverse
        values = (pdf_rect.x0, pdf_rect.y0, pdf_rect.width, pdf_rect.height)
        if not all(math.isfinite(value) for value in values):
            raise RuntimeError("preserved formula clip has non-finite geometry")
        paths.append(
            "{:.6f} {:.6f} {:.6f} {:.6f} re".format(*values).encode("ascii")
        )
    if not paths:
        raise RuntimeError("preserved formula clip has no valid geometry")
    return b"q\n" + b"\n".join(paths) + b"\nW n\n" + bytes(data) + b"\nQ\n"


def _build_preserved_text_overlay(doc, page, descriptors):
    """Snapshot exact source formula operators for post-redaction replay."""
    groups = _page_standalone_text_groups(doc, page)
    selected = _preserved_text_group_indexes(page, groups, descriptors)
    if not selected:
        raise RuntimeError("preserved formula has no source text-object mapping")
    text_log = [
        sequence
        for sequence, (kind, _bbox) in enumerate(page.get_bboxlog())
        if "text" in str(kind)
    ]
    traces_by_sequence = defaultdict(list)
    for trace in page.get_texttrace():
        traces_by_sequence[int(trace.get("seqno", -1))].append(trace)
    chunks = []
    for index in selected:
        matching = [
            descriptor
            for descriptor in descriptors
            if any(
                _trace_matches_preserved_span(trace, [descriptor])
                for trace in traces_by_sequence.get(text_log[index], [])
            )
        ]
        if not matching:
            raise RuntimeError("preserved formula text object lost its descriptor binding")
        chunks.append(_clip_preserved_text_group(page, groups[index]["data"], matching))
        chunks.append(b"\n")
    return b"".join(chunks), len(selected)


def _append_page_content_stream(doc, page, data):
    if not data:
        return page
    stream_xref = doc.get_new_xref()
    doc.update_object(stream_xref, "<<>>")
    doc.update_stream(stream_xref, bytes(data))
    page_xref = doc.page_xref(page.number)
    value_type, raw_value = doc.xref_get_key(page_xref, "Contents")
    if value_type == "array":
        updated = raw_value[:-1] + f" {stream_xref} 0 R]"
    elif value_type == "xref":
        updated = f"[{raw_value} {stream_xref} 0 R]"
    else:
        updated = f"[{stream_xref} 0 R]"
    doc.xref_set_key(page_xref, "Contents", updated)
    return doc.reload_page(page)


def _new_pdf_stream(doc, data):
    xref = doc.get_new_xref()
    doc.update_object(xref, "<<>>")
    doc.update_stream(xref, bytes(data))
    return xref


def _set_page_content_xrefs(doc, page, xrefs):
    value = "[" + " ".join(f"{int(xref)} 0 R" for xref in xrefs) + "]"
    doc.xref_set_key(page.xref, "Contents", value)


def _logical_key_for_anchor(anchor_pdf, page, logical_rects, sequence):
    """Map a PDF-space baseline to the closest original logical text block."""
    x, pdf_y = anchor_pdf
    crop = fitz.Rect(page.cropbox)
    # Content-stream anchors use PDF page coordinates, while get_text() rectangles
    # are CropBox-relative with a top-left origin.  Subtract the CropBox x origin
    # and mirror y around its upper PDF edge.  This reduces to the previous formula
    # for origin-zero pages and safely supports ordinary inset book CropBoxes.
    text_x = x - crop.x0
    top_y = crop.y1 - pdf_y
    candidates = []
    for block_id, rect in logical_rects:
        rect = fitz.Rect(rect)
        if (
            rect.x0 - 24.0 <= text_x <= rect.x1 + 24.0
            and rect.y0 - 12.0 <= top_y <= rect.y1 + 12.0
        ):
            dx = 0.0 if rect.x0 <= text_x <= rect.x1 else min(abs(text_x - rect.x0), abs(text_x - rect.x1))
            dy = 0.0 if rect.y0 <= top_y <= rect.y1 else min(abs(top_y - rect.y0), abs(top_y - rect.y1))
            candidates.append((dx + dy, block_id))
    if not candidates:
        return None
    _distance, block_id = min(candidates, key=lambda value: (value[0], value[1]))
    return (int(block_id), round(float(top_y), 4), round(float(text_x), 4), sequence)


def _interleave_safe_page_text_streams(
    doc,
    page,
    residual_xrefs,
    generated_order,
    logical_rects,
):
    """Interleave preserved and generated text streams in source logical order.

    Returns ``(reloaded_page, diagnostic)``. Unsupported streams and any raster
    difference restore the exact original /Contents array and report ``applied``
    false; strict postflight remains responsible for rejecting an actual inversion.
    """
    diagnostic = {
        "applied": False,
        "reason": "not_needed",
        "objects": 0,
        "original_streams": 0,
        "residual_streams": len(residual_xrefs),
        "generated_streams": len(generated_order),
        "restored": False,
    }
    original_xrefs = list(page.get_contents())
    diagnostic["original_streams"] = len(original_xrefs)
    if not original_xrefs:
        return page, diagnostic
    # Raw stream baselines are proven for unrotated CropBoxes. Non-zero origins are
    # normalized in _logical_key_for_anchor and the final raster equality check is
    # still mandatory before the reordered streams are accepted.
    crop = fitz.Rect(page.cropbox)
    if int(page.rotation or 0) % 360:
        diagnostic["reason"] = "unsupported_page_geometry"
        return page, diagnostic
    if not _pixmap_geometry_is_safe(page.rect, 1.0):
        diagnostic["reason"] = "pixel_comparison_resource_limit"
        return page, diagnostic
    before = page.get_pixmap(colorspace=fitz.csRGB, alpha=False)
    before_signature = (before.width, before.height, bytes(before.samples))

    graphics_xrefs = []
    text_entries = []
    changed = False
    sequence = 0
    residual_set = {int(xref) for xref in residual_xrefs}
    try:
        for xref in original_xrefs:
            xref = int(xref)
            if xref in residual_set:
                data = bytes(doc.xref_stream(xref) or b"")
                split = _split_safe_residual_text_stream(data)
                if split is None:
                    diagnostic["reason"] = "unsupported_residual_stream"
                    diagnostic["offending_xref"] = xref
                    return page, diagnostic
                graphics, chunks = split
                if not chunks:
                    graphics_xrefs.append(xref)
                    continue
                changed = True
                graphics_xrefs.append(_new_pdf_stream(doc, graphics))
                for chunk in chunks:
                    key = _logical_key_for_anchor(
                        chunk["anchor_pdf"], page, logical_rects, sequence
                    )
                    if key is None:
                        diagnostic["reason"] = "unmapped_preserved_text"
                        diagnostic["offending_xref"] = xref
                        return page, diagnostic
                    text_entries.append((key, _new_pdf_stream(doc, chunk["data"])))
                    sequence += 1
                continue
            if xref in generated_order:
                # Even when no preserved text remains, generated table-cell streams
                # still need their source logical ordering proven and pixel-checked.
                changed = True
                generated_key = generated_order[xref]
                if len(generated_key) == 3:
                    block_id, source_y, suborder = generated_key
                else:  # compatibility with focused direct helper tests
                    block_id, suborder = generated_key
                    source_y = float(block_id)
                text_entries.append(
                    (
                        (
                            int(block_id),
                            round(float(source_y), 4),
                            float(suborder),
                            sequence,
                        ),
                        xref,
                    )
                )
                sequence += 1
                continue
            data = bytes(doc.xref_stream(xref) or b"")
            tokens = _pdf_content_tokens(data)
            if any(
                kind == "operator" and raw == b"BT"
                for kind, raw, _start, _end in tokens
            ):
                diagnostic["reason"] = "untracked_text_stream"
                diagnostic["offending_xref"] = xref
                return page, diagnostic
            graphics_xrefs.append(xref)
        if not changed:
            return page, diagnostic

        ordered_text = [xref for _key, xref in sorted(text_entries, key=lambda item: item[0])]
        _set_page_content_xrefs(doc, page, graphics_xrefs + ordered_text)
        reloaded = doc.reload_page(page)
        after = reloaded.get_pixmap(colorspace=fitz.csRGB, alpha=False)
        after_signature = (after.width, after.height, bytes(after.samples))
        if after_signature != before_signature:
            _set_page_content_xrefs(doc, reloaded, original_xrefs)
            restored = doc.reload_page(reloaded)
            diagnostic["reason"] = "pixel_mismatch"
            diagnostic["restored"] = True
            return restored, diagnostic
        diagnostic.update(
            {
                "applied": True,
                "reason": "pixel_exact",
                "objects": len(text_entries),
            }
        )
        return reloaded, diagnostic
    except Exception:
        # New xrefs are unreachable after restoration and disappear under garbage=3.
        try:
            _set_page_content_xrefs(doc, page, original_xrefs)
            page = doc.reload_page(page)
            diagnostic["restored"] = True
        except Exception:
            pass
        diagnostic["reason"] = "rewrite_error"
        return page, diagnostic


_SAFE_ACTIVE_URI_SCHEMES = {"http", "https", "mailto"}
_LOCAL_DESTINATION_ARITY = {
    "Fit": 0,
    "FitB": 0,
    "FitH": 1,
    "FitBH": 1,
    "FitV": 1,
    "FitBV": 1,
    "FitR": 4,
    "XYZ": 3,
}
_PDF_DESTINATION_ARGUMENT = re.compile(
    r"(?:null|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?)$"
)


def _safe_external_uri(uri):
    """Return whether an existing URI action is safe to re-create after redaction.

    Redaction can delete link annotations whose rectangles overlap replaced text. We
    restore ordinary web / email links, but never turn file, script, OS handler, or
    unknown custom schemes back into active annotations. LINK_LAUNCH and LINK_GOTOR
    are filtered separately by ``_capture_safe_links``.
    """
    if not isinstance(uri, str) or not uri or uri != uri.strip():
        return False
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in uri):
        return False
    match = re.match(r"^([A-Za-z][A-Za-z0-9+.-]*):", uri)
    if not match:
        return False
    return match.group(1).lower() in _SAFE_ACTIVE_URI_SCHEMES


def _rounded_rect(rect):
    rect = fitz.Rect(rect)
    return tuple(round(float(value), 3) for value in (rect.x0, rect.y0, rect.x1, rect.y1))


def _raw_local_destination(doc, annotation_xref):
    """Return a local destination's raw value and storage container, if present."""
    dest_type, dest_value = doc.xref_get_key(annotation_xref, "Dest")
    if dest_type != "null":
        return {"container": "Dest", "type": dest_type, "value": dest_value}
    action_type, action_name = doc.xref_get_key(annotation_xref, "A/S")
    if action_type == "name" and action_name == "/GoTo":
        dest_type, dest_value = doc.xref_get_key(annotation_xref, "A/D")
        if dest_type != "null":
            return {"container": "A/D", "type": dest_type, "value": dest_value}
    return None


def _parse_explicit_local_destination(raw, page_by_xref):
    """Parse only injection-safe, explicit local destination arrays.

    The numeric arguments stay in native PDF coordinates. Replaying those exact
    tokens preserves `/Fit*` behavior and `/XYZ` point / zoom semantics without a
    lossy round trip through PyMuPDF's normalized page coordinates.
    """
    if not raw or raw.get("type") != "array":
        return None
    match = re.fullmatch(
        r"\[\s*(\d+)\s+(\d+)\s+R\s*/([A-Za-z]+)(.*?)\s*\]",
        raw.get("value", ""),
        flags=re.DOTALL,
    )
    if not match:
        return None
    page_xref = int(match.group(1))
    target_page = page_by_xref.get(page_xref)
    view = match.group(3)
    if target_page is None or view not in _LOCAL_DESTINATION_ARITY:
        return None
    argument_text = match.group(4).strip()
    arguments = tuple(argument_text.split()) if argument_text else ()
    if len(arguments) != _LOCAL_DESTINATION_ARITY[view]:
        return None
    if any(not _PDF_DESTINATION_ARGUMENT.fullmatch(value) for value in arguments):
        return None
    return {
        "container": raw["container"],
        "target_page": target_page,
        "view": view,
        "arguments": arguments,
    }


def _safe_link_key(link):
    base = (link["source_page"], _rounded_rect(link["from"]), link["kind"])
    if link["kind"] == "uri":
        return base + (link["uri"],)
    return base + (
        int(link["target_page"]),
        link["destination_container"],
        link["destination_view"],
        tuple(link.get("destination_arguments", ())),
        link.get("opaque_destination", ""),
    )


_INDIRECT_REFERENCE_RE = re.compile(r"(?<!\d)(\d+)\s+(\d+)\s+R(?!\w)")


def _raw_annotation_xrefs(doc, page):
    """Return every indirect annotation reference from one raw ``/Annots`` array.

    PyMuPDF's ``first_link`` / ``get_links`` intentionally omit action types it
    does not understand (notably JavaScript and SubmitForm).  Security decisions
    therefore cannot start from those high-level iterators.  PDF annotations are
    required to be indirect objects; reject an opaque/direct array instead of
    silently retaining an action we could not inspect.
    """
    value_type, raw_value = doc.xref_get_key(int(page.xref), "Annots")
    if value_type == "null":
        return []
    if value_type == "xref":
        try:
            array_xref = int(str(raw_value).split()[0])
            raw_value = doc.xref_object(array_xref, compressed=False)
        except Exception as exc:
            raise RuntimeError("cannot resolve raw PDF annotation array") from exc
    elif value_type != "array":
        raise RuntimeError("unsupported raw PDF annotation array representation")

    text = str(raw_value or "").strip()
    if not text.startswith("[") or not text.endswith("]"):
        raise RuntimeError("malformed raw PDF annotation array")
    matches = list(_INDIRECT_REFERENCE_RE.finditer(text))
    if any(match.group(2) != "0" for match in matches):
        raise RuntimeError("raw PDF annotation array uses an unsupported generation")
    refs = [int(match.group(1)) for match in matches]
    # After removing legal indirect references, only brackets, whitespace and PDF
    # comments may remain.  Inline dictionaries or malformed tokens fail closed.
    remainder = _INDIRECT_REFERENCE_RE.sub("", text)
    remainder = re.sub(r"%[^\r\n]*", "", remainder)
    if re.sub(r"[\[\]\s]", "", remainder):
        raise RuntimeError("raw PDF annotation array contains a non-reference item")
    if len(refs) != len(set(refs)):
        raise RuntimeError("raw PDF annotation array contains duplicate references")
    for xref in refs:
        if xref <= 0 or xref >= doc.xref_length():
            raise RuntimeError("raw PDF annotation array contains an invalid reference")
    return refs


def _set_raw_annotation_xrefs(doc, page, xrefs):
    if xrefs:
        raw_value = "[" + " ".join(f"{int(xref)} 0 R" for xref in xrefs) + "]"
    else:
        raw_value = "null"
    doc.xref_set_key(int(page.xref), "Annots", raw_value)


def _capture_safe_links(doc):
    """Snapshot links which may safely be reconstructed after text redaction.

    MuPDF represents explicit ``/Dest [... /Fit]`` links as LINK_NAMED in some
    versions. We therefore inspect the annotation object directly and retain its
    destination container, view mode, and validated raw arguments. Opaque but
    resolvable named destinations may survive untouched; if redaction removes one,
    restoration fails closed instead of silently changing its behavior.
    """
    captured = []
    page_count = len(doc)
    page_by_xref = {doc.page_xref(page): page for page in range(page_count)}
    for source_page in range(page_count):
        page = doc[source_page]
        link = page.first_link
        while link is not None:
            next_link = link.next
            try:
                dest = link.dest
                kind = int(dest.kind)
                rect = fitz.Rect(link.rect)
                uri = link.uri or ""
            except Exception:
                link = next_link
                continue

            action_type, action_name = doc.xref_get_key(int(link.xref), "A/S")
            raw_uri_type, raw_uri = doc.xref_get_key(int(link.xref), "A/URI")
            if (
                kind == fitz.LINK_URI
                and action_type == "name"
                and action_name == "/URI"
                and raw_uri_type == "string"
                and _safe_external_uri(str(raw_uri))
            ):
                captured.append(
                    {
                        "_annotation_xref": int(link.xref),
                        "source_page": source_page,
                        "from": tuple(rect),
                        "kind": "uri",
                        "uri": str(raw_uri),
                    }
                )
            elif kind in (fitz.LINK_GOTO, fitz.LINK_NAMED):
                target_page = -1
                raw_destination = _raw_local_destination(doc, int(link.xref))
                explicit_destination = _parse_explicit_local_destination(
                    raw_destination, page_by_xref
                )
                if explicit_destination is not None:
                    target_page = explicit_destination["target_page"]
                try:
                    resolved_page, _x, _y = doc.resolve_link(uri)
                    if target_page < 0:
                        target_page = resolved_page
                except Exception:
                    pass
                if kind == fitz.LINK_GOTO and not (0 <= target_page < page_count):
                    try:
                        target_page = int(link.page)
                    except Exception:
                        target_page = -1
                if 0 <= target_page < page_count:
                    if explicit_destination is None:
                        # Only a named value stored in /Dest or a genuine /GoTo
                        # action is eligible.  A high-level LINK_NAMED view with no
                        # such raw local destination may actually be /Named,
                        # JavaScript or another active action and is not safe.
                        if not raw_destination or raw_destination.get("type") not in {
                            "name",
                            "string",
                        }:
                            link = next_link
                            continue
                        opaque = raw_destination
                        destination_container = opaque["container"]
                        destination_view = "opaque"
                        destination_arguments = ()
                        opaque_destination = (
                            f"{opaque.get('type', '')}:{opaque.get('value', '')}"
                        )
                    else:
                        destination_container = explicit_destination["container"]
                        destination_view = explicit_destination["view"]
                        destination_arguments = explicit_destination["arguments"]
                        opaque_destination = ""
                    captured.append(
                        {
                            "_annotation_xref": int(link.xref),
                            "source_page": source_page,
                            "from": tuple(rect),
                            "kind": "goto",
                            "target_page": target_page,
                            "destination_container": destination_container,
                            "destination_view": destination_view,
                            "destination_arguments": destination_arguments,
                            "opaque_destination": opaque_destination,
                        }
                    )
            # Never recreate LINK_LAUNCH, LINK_GOTOR, or unresolved named actions.
            link = next_link
    return captured


def _remove_unsafe_links(doc):
    """Remove active file / launch-style annotations from the generated PDF.

    These actions are never required for translation fidelity and can open local or
    remote files when a reader follows them. Removing them before the safe snapshot
    also guarantees that a non-overlapping action cannot simply survive redaction.
    """
    removed = 0
    safe_link_xrefs_by_page = defaultdict(set)
    for link in _capture_safe_links(doc):
        safe_link_xrefs_by_page[int(link.get("source_page", -1))].add(
            int(link.get("_annotation_xref", 0))
    )
    for page_number in range(len(doc)):
        page = doc[page_number]
        page_aa_type, _page_additional_actions = doc.xref_get_key(page.xref, "AA")
        if page_aa_type != "null":
            doc.xref_set_key(page.xref, "AA", "null")
            removed += 1
        annotation_xrefs = _raw_annotation_xrefs(doc, page)
        if not annotation_xrefs:
            continue
        safe_link_xrefs = safe_link_xrefs_by_page.get(page_number, set())
        retained = []
        changed = False
        for xref in annotation_xrefs:
            subtype_type, subtype = doc.xref_get_key(xref, "Subtype")
            action_type, _action = doc.xref_get_key(xref, "A")
            aa_type, _additional_actions = doc.xref_get_key(xref, "AA")
            has_action = action_type != "null"
            has_additional_actions = aa_type != "null"
            is_link = subtype_type == "name" and subtype == "/Link"

            if is_link:
                # A link is retained only when the exact same annotation was
                # classified by _capture_safe_links as an allow-listed URI or
                # resolvable local GoTo.  Unknown actions and every /AA are removed.
                if xref not in safe_link_xrefs or has_additional_actions:
                    removed += 1
                    changed = True
                    continue
            elif has_action or has_additional_actions:
                # Preserve non-link annotations and their /P back-reference, but
                # strip active actions which are unrelated to translation fidelity.
                if has_action:
                    doc.xref_set_key(xref, "A", "null")
                if has_additional_actions:
                    doc.xref_set_key(xref, "AA", "null")
                removed += 1
                changed = True
            retained.append(xref)

        if changed:
            _set_raw_annotation_xrefs(doc, page, retained)
            try:
                doc.reload_page(page)
            except Exception:
                pass
    return removed


def _insert_explicit_internal_destination(doc, link):
    """Insert one local link and replay its validated destination view exactly."""
    view = link.get("destination_view")
    container = link.get("destination_container")
    if view not in _LOCAL_DESTINATION_ARITY or container not in ("Dest", "A/D"):
        raise RuntimeError(
            "cannot safely reconstruct opaque internal PDF destination after redaction"
        )
    page = doc[int(link["source_page"])]
    before_xrefs = {
        int(item.get("xref", 0)) for item in page.get_links() if item.get("xref")
    }
    xref_floor = doc.xref_length()
    target_page = int(link["target_page"])
    page.insert_link(
        {
            "kind": fitz.LINK_GOTO,
            "from": fitz.Rect(link["from"]),
            "page": target_page,
            "to": fitz.Point(doc[target_page].rect.tl),
        }
    )
    after_xrefs = {
        int(item.get("xref", 0)) for item in page.get_links() if item.get("xref")
    }
    candidates = sorted(after_xrefs - before_xrefs)
    if len(candidates) != 1:
        candidates = []
        for xref in range(xref_floor, doc.xref_length()):
            subtype_type, subtype = doc.xref_get_key(xref, "Subtype")
            if subtype_type == "name" and subtype == "/Link":
                candidates.append(xref)
    if len(candidates) != 1:
        raise RuntimeError("could not identify newly inserted internal PDF link")
    annotation_xref = candidates[0]
    arguments = " ".join(link.get("destination_arguments", ()))
    destination = f"[{doc.page_xref(target_page)} 0 R /{view}"
    if arguments:
        destination += f" {arguments}"
    destination += "]"
    if container == "Dest":
        doc.xref_set_key(annotation_xref, "A", "null")
        doc.xref_set_key(annotation_xref, "Dest", destination)
    else:
        doc.xref_set_key(annotation_xref, "Dest", "null")
        doc.xref_set_key(annotation_xref, "A/S", "/GoTo")
        doc.xref_set_key(annotation_xref, "A/D", destination)


def _restore_safe_links(doc, expected):
    """Restore redaction-deleted safe links without losing or duplicating any."""
    current = _capture_safe_links(doc)
    current_counts = Counter(_safe_link_key(link) for link in current)
    expected_counts = Counter(_safe_link_key(link) for link in expected)
    restored = 0
    encountered = Counter()

    for link in expected:
        key = _safe_link_key(link)
        encountered[key] += 1
        if current_counts[key] >= encountered[key]:
            continue
        page = doc[link["source_page"]]
        if link["kind"] == "uri":
            page.insert_link(
                {
                    "kind": fitz.LINK_URI,
                    "from": fitz.Rect(link["from"]),
                    "uri": link["uri"],
                }
            )
        else:
            _insert_explicit_internal_destination(doc, link)
        current_counts[key] += 1
        restored += 1

    if current_counts != expected_counts:
        raise RuntimeError("safe PDF link preservation count mismatch")
    return restored


def _page_geometry_signature(doc):
    result = []
    for page_number in range(len(doc)):
        page = doc[page_number]
        result.append(
            (
                _rounded_rect(page.mediabox),
                _rounded_rect(page.cropbox),
                int(page.rotation or 0) % 360,
            )
        )
    return tuple(result)


def _canonical_pdf_value(value):
    """Make PyMuPDF destination values stable across save / re-open cycles."""
    if isinstance(value, dict):
        return tuple(
            (str(key), _canonical_pdf_value(item))
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
            if str(key) != "xref"  # object numbers may change under garbage collection
        )
    if isinstance(value, (list, tuple)):
        return tuple(_canonical_pdf_value(item) for item in value)
    if isinstance(value, (fitz.Point, fitz.Rect)):
        return tuple(round(float(item), 6) for item in value)
    if isinstance(value, float):
        return round(value, 6)
    if value is None or isinstance(value, (str, int, bool)):
        return value
    return str(value)


def _outline_signature(doc):
    """Capture titles plus all reader-visible navigation / presentation semantics."""
    result = []
    for item in doc.get_toc(simple=False) or []:
        level, title, page = item[:3]
        destination = item[3] if len(item) > 3 and isinstance(item[3], dict) else {}
        result.append(
            (
                int(level),
                str(title),
                int(page),
                _canonical_pdf_value(destination),
            )
        )
    return tuple(result)


def _outline_navigation_signature(signature):
    return tuple((item[0], item[2], item[3]) for item in signature)


def _metadata_mapping_signature(metadata):
    return tuple(
        (str(key), _canonical_pdf_value(value))
        for key, value in sorted((metadata or {}).items(), key=lambda pair: str(pair[0]))
    )


def _xmp_non_target_signature(state):
    """Hash all XMP structure/content outside the explicitly translated values.

    The canonical copy removes x-default / Korean Alt value nodes because adding a
    Korean alternative is an intentional target-side structural change.  Other
    language alternatives, custom attributes, rights, identifiers, processing
    instructions, comments, and arbitrary extension namespaces remain in the hash.
    """
    if state is None:
        return ("absent",)
    tree = copy.deepcopy(state["tree"])
    root = tree.getroot()
    marker = "__QUILO_TRANSLATED_XMP_VALUE__"
    for description in root.iter(_XMP_DESCRIPTION):
        for qname in _XMP_TARGET_PROPERTIES:
            if qname in description.attrib:
                description.set(qname, marker)
        for prop in description:
            if prop.tag not in _XMP_TARGET_PROPERTIES:
                continue
            container = prop[0] if len(prop) == 1 else None
            if container is not None and container.tag == _XMP_ALT:
                for child in list(container):
                    if child.tag != _XMP_LI:
                        continue
                    language = _xmp_lang(child)
                    if language == "x-default" or language.startswith("ko"):
                        # Bare target alternatives are normalized away so a newly
                        # inserted ko-KR/x-default node does not look like custom
                        # metadata drift.  Any custom attrs/children remain hashed.
                        extra_attrs = {
                            key: value
                            for key, value in child.attrib.items()
                            if key != _XMP_LANG
                        }
                        if not extra_attrs and len(child) == 0:
                            container.remove(child)
                        else:
                            child.set(_XMP_LANG, "__target__")
                            child.text = marker
                continue
            if container is not None and container.tag in {_XMP_BAG, _XMP_SEQ}:
                for child in container:
                    if child.tag == _XMP_LI and len(child) == 0:
                        child.text = marker
                continue
            prop.text = marker
    try:
        canonical = etree.tostring(tree, method="c14n", with_comments=True)
    except (etree.C14NError, ValueError) as exc:
        raise RuntimeError("cannot canonicalize PDF XMP metadata") from exc
    return ("sha256", hashlib.sha256(canonical).hexdigest(), len(canonical))


def _xmp_packet_signature(state):
    if state is None:
        return ("absent",)
    raw = bytes(state["raw"])
    return ("sha256", hashlib.sha256(raw).hexdigest(), len(raw))


def _metadata_signature(doc):
    state = _parse_document_xmp(doc)
    return (
        ("info", _metadata_mapping_signature(doc.metadata or {})),
        ("xmp", _xmp_packet_signature(state)),
    )


def _apply_xmp_binding(binding, translated):
    mode = binding["mode"]
    if mode == "attribute":
        binding["element"].set(binding["attribute"], translated)
        return
    if mode in {"text", "list_item"}:
        binding["element"].text = translated
        return
    if mode != "alt":
        raise RuntimeError(f"unsupported XMP translation binding: {mode}")

    container = binding["container"]
    alternatives = [child for child in container if child.tag == _XMP_LI]
    x_defaults = [child for child in alternatives if _xmp_lang(child) == "x-default"]
    natural_default = next(
        (
            child
            for child in x_defaults
            if _is_natural_language_document_label(
                _xmp_text_value(child), metadata_field=binding["field"]
            )
        ),
        None,
    )
    if natural_default is not None:
        natural_default.text = translated
    elif not x_defaults:
        default_node = etree.Element(_XMP_LI)
        default_node.set(_XMP_LANG, "x-default")
        default_node.text = translated
        container.insert(0, default_node)

    korean = [
        child for child in alternatives if _xmp_lang(child).startswith("ko")
    ]
    if korean:
        for child in korean:
            child.text = translated
    else:
        korean_node = etree.Element(_XMP_LI)
        korean_node.set(_XMP_LANG, "ko-KR")
        korean_node.text = translated
        container.append(korean_node)


def _resolve_virtual_translations(doc, translations):
    """Fail closed if a target reader-UI string has no non-empty translation."""
    blocks = _document_virtual_blocks(doc)
    resolved = {}
    missing = []
    for block in blocks:
        block_id = str(block["id"])
        value = translations.get(block_id)
        if value is None:
            value = translations.get(block["id"])
        if not isinstance(value, str) or not value.strip():
            missing.append(block_id)
            continue
        resolved[block_id] = _clean_ko(value).strip()
    if missing:
        raise RuntimeError(
            "missing or empty required PDF outline/metadata translations: "
            + ", ".join(missing[:12])
            + (f" (+{len(missing) - 12} more)" if len(missing) > 12 else "")
        )
    return blocks, resolved


def _apply_virtual_translations(doc, blocks, resolved, source_outline, source_metadata):
    """Update reader UI text while preserving navigation and metadata provenance."""
    expected_outline = list(source_outline)
    expected_info = dict(source_metadata)
    outline_replaced = 0
    metadata_replaced = 0
    toc_items = doc.get_toc(simple=False) or []
    metadata_plan = _metadata_translation_plan(doc)
    metadata_groups = {
        str(group["id"]): group for group in metadata_plan["groups"]
    }
    source_xmp_non_target = _xmp_non_target_signature(metadata_plan["xmp"])
    xmp_mutated = False
    info_mutated = False

    for block in blocks:
        block_id = str(block["id"])
        translated = resolved[block_id]
        if block["kind"] == "outline":
            index = int(block["index"])
            original = expected_outline[index]
            expected_outline[index] = (
                original[0],
                translated,
                original[2],
                original[3],
            )
            # PyMuPDF's high-level set_toc_item(title=...) currently clears the
            # outline /F bold+italic flags for some named Fit destinations.  Write
            # only /Title at the existing outline object instead: destination,
            # hierarchy, collapse state, color and style keys remain untouched.
            destination = toc_items[index][3] if len(toc_items[index]) > 3 else {}
            xref = int(destination.get("xref", 0)) if isinstance(destination, dict) else 0
            if xref <= 0:
                raise RuntimeError("cannot locate existing PDF outline object for title update")
            doc.xref_set_key(xref, "Title", fitz.get_pdf_str(translated))
            outline_replaced += 1
        elif block["kind"] == "metadata":
            group = metadata_groups.get(block_id)
            if group is None:
                raise RuntimeError(f"PDF metadata translation binding disappeared: {block_id}")
            for binding in group["bindings"]:
                if binding["source"] == "info":
                    expected_info[str(binding["field"])] = translated
                    info_mutated = True
                elif binding["source"] == "xmp":
                    _apply_xmp_binding(binding, translated)
                    xmp_mutated = True
                else:
                    raise RuntimeError("unknown PDF metadata translation source")
            metadata_replaced += 1

    if info_mutated:
        # Feed every source field back so author / creator / producer / dates and
        # non-target document information remain exact.
        doc.set_metadata(expected_info)
    if xmp_mutated:
        try:
            serialized = etree.tostring(
                metadata_plan["xmp"]["tree"],
                encoding="utf-8",
                xml_declaration=False,
            ).decode("utf-8")
            doc.set_xml_metadata(serialized)
        except (UnicodeError, etree.LxmlError, RuntimeError, ValueError) as exc:
            raise RuntimeError("cannot write translated PDF XMP metadata") from exc
        updated_xmp = _parse_document_xmp(doc)
        if _xmp_non_target_signature(updated_xmp) != source_xmp_non_target:
            raise RuntimeError("non-target PDF XMP metadata changed during translation")

    expected_outline = tuple(expected_outline)
    actual_outline = _outline_signature(doc)
    if _outline_navigation_signature(actual_outline) != _outline_navigation_signature(
        source_outline
    ):
        raise RuntimeError("PDF outline navigation semantics changed while translating titles")
    if actual_outline != expected_outline:
        raise RuntimeError("PDF outline title translation mismatch")
    expected_metadata_signature = _metadata_signature(doc)
    actual_info = _metadata_mapping_signature(doc.metadata or {})
    if actual_info != _metadata_mapping_signature(expected_info):
        raise RuntimeError("PDF metadata translation or preservation mismatch")
    return {
        "outline_replaced": outline_replaced,
        "metadata_replaced": metadata_replaced,
        "expected_outline": expected_outline,
        "expected_metadata": expected_metadata_signature,
    }


_CMAP_HEX_TOKEN = re.compile(rb"<([^<>]*)>")


def _validate_utf16_destination(token):
    """Return a stable anomaly label for one ToUnicode destination token."""
    if not token or re.fullmatch(rb"[0-9A-Fa-f]+", token) is None:
        return "invalid_hex_destination"
    if len(token) % 2:
        return "odd_length_hex_destination"
    raw = bytes.fromhex(token.decode("ascii"))
    if len(raw) % 2:
        return "odd_length_utf16_destination"
    try:
        decoded = raw.decode("utf-16-be", errors="strict")
    except UnicodeDecodeError:
        return "invalid_utf16_destination"
    # Python's strict UTF-16 decoder rejects unpaired surrogates. Retain an
    # explicit scalar check so future runtime behavior cannot admit > U+10FFFF.
    if any(ord(ch) > 0x10FFFF for ch in decoded):
        return "invalid_non_bmp_destination"
    return None


def _tounicode_stream_anomalies(stream):
    """Inspect destination values in bfchar / bfrange CMap sections."""
    anomalies = []
    for match in re.finditer(rb"beginbfchar(.*?)endbfchar", stream, re.DOTALL):
        tokens = [item.group(1) for item in _CMAP_HEX_TOKEN.finditer(match.group(1))]
        if len(tokens) % 2:
            anomalies.append("malformed_bfchar_arity")
        for destination in tokens[1::2]:
            issue = _validate_utf16_destination(destination)
            if issue:
                anomalies.append(issue)

    for match in re.finditer(rb"beginbfrange(.*?)endbfrange", stream, re.DOTALL):
        body = match.group(1)
        tokens = re.findall(rb"<([^<>]*)>|(\[)|(\])", body)
        flat = []
        for hex_value, open_bracket, close_bracket in tokens:
            if hex_value:
                flat.append(("hex", hex_value))
            elif open_bracket:
                flat.append(("open", b""))
            elif close_bracket:
                flat.append(("close", b""))
        index = 0
        while index < len(flat):
            if index + 2 >= len(flat) or flat[index][0] != "hex" or flat[index + 1][0] != "hex":
                anomalies.append("malformed_bfrange_arity")
                break
            index += 2  # source range endpoints are character codes, not destinations
            kind, value = flat[index]
            if kind == "hex":
                issue = _validate_utf16_destination(value)
                if issue:
                    anomalies.append(issue)
                index += 1
                continue
            if kind != "open":
                anomalies.append("malformed_bfrange_destination")
                break
            index += 1
            found_close = False
            while index < len(flat):
                kind, value = flat[index]
                index += 1
                if kind == "close":
                    found_close = True
                    break
                if kind != "hex":
                    anomalies.append("malformed_bfrange_array")
                    continue
                issue = _validate_utf16_destination(value)
                if issue:
                    anomalies.append(issue)
            if not found_close:
                anomalies.append("unterminated_bfrange_array")
                break
    return tuple(sorted(Counter(anomalies).items()))


def _font_xrefs(doc):
    xrefs = set()
    for page in doc:
        try:
            xrefs.update(int(font[0]) for font in page.get_fonts(full=True) if int(font[0]) > 0)
        except Exception:
            continue
    return xrefs


def _font_tounicode_stream(doc, font_xref):
    key_type, value = doc.xref_get_key(font_xref, "ToUnicode")
    if key_type != "xref":
        return None
    try:
        stream_xref = int(str(value).split()[0])
        return bytes(doc.xref_stream(stream_xref) or b"")
    except Exception:
        return None


def _cmap_anomaly_inventory(doc):
    """Count invalid CMaps by decompressed digest, independent of xref renumbering."""
    inventory = Counter()
    for font_xref in _font_xrefs(doc):
        stream = _font_tounicode_stream(doc, font_xref)
        if not stream:
            continue
        anomalies = _tounicode_stream_anomalies(stream)
        if anomalies:
            inventory[(hashlib.sha256(stream).hexdigest(), anomalies)] += 1
    return inventory


def _verify_saved_text_cmaps(path, source_anomalies, subset_font_digests, expect_generated):
    """Fail on newly introduced CMap defects while tolerating unchanged source defects."""
    saved = fitz.open(path)
    try:
        output_anomalies = _cmap_anomaly_inventory(saved)
        introduced = output_anomalies - source_anomalies
        if introduced:
            labels = []
            for (_digest, issues), count in introduced.items():
                labels.append(f"{count}x {dict(issues)}")
            raise RuntimeError(
                "saved PDF introduced invalid ToUnicode mappings: " + "; ".join(labels)
            )

        matched_subset_fonts = 0
        for font_xref in _font_xrefs(saved):
            try:
                embedded = saved.extract_font(font_xref)[3]
            except Exception:
                continue
            if not embedded:
                continue
            digest = hashlib.sha256(embedded).hexdigest()
            if digest not in subset_font_digests:
                continue
            matched_subset_fonts += 1
            stream = _font_tounicode_stream(saved, font_xref)
            if not stream:
                raise RuntimeError("generated subset font is missing a ToUnicode CMap")
            anomalies = _tounicode_stream_anomalies(stream)
            if anomalies:
                raise RuntimeError(
                    f"generated subset font has invalid ToUnicode mappings: {dict(anomalies)}"
                )
        if expect_generated and matched_subset_fonts == 0:
            raise RuntimeError("could not verify any generated subset font in saved PDF")
        return {
            "validated_subset_fonts": matched_subset_fonts,
            "preserved_source_cmap_anomalies": sum(
                (output_anomalies & source_anomalies).values()
            ),
        }
    finally:
        saved.close()


def _verify_saved_pdf_structure(
    path, safe_links, page_geometry, outline, metadata_signature
):
    """Re-open the saved file so object garbage collection cannot hide link loss."""
    saved = fitz.open(path)
    try:
        expected_links = Counter(_safe_link_key(link) for link in safe_links)
        actual_links = Counter(
            _safe_link_key(link) for link in _capture_safe_links(saved)
        )
        if actual_links != expected_links:
            raise RuntimeError("saved PDF safe link preservation mismatch")
        if _page_geometry_signature(saved) != page_geometry:
            raise RuntimeError("saved PDF page geometry preservation mismatch")
        if _outline_signature(saved) != outline:
            raise RuntimeError("saved PDF outline translation/preservation mismatch")
        if _metadata_signature(saved) != metadata_signature:
            raise RuntimeError("saved PDF metadata translation/preservation mismatch")
    finally:
        saved.close()


def cmd_render(pdf_path, out_path, font_path):
    payload = json.loads(sys.stdin.read() or "{}")
    translations = payload.get("translations", {}) or {}
    if not isinstance(translations, dict):
        raise ValueError("render translations must be a JSON object")

    doc = fitz.open(pdf_path)
    hidden_ocr_pages = _hidden_ocr_scan_page_indexes(doc)
    source_cmap_anomalies = _cmap_anomaly_inventory(doc)
    build_decoders(doc)  # 추출과 동일한 디코더 — 블록 텍스트/매칭 일관성 유지
    # Resolve these before mutating any page.  Direct renderer callers therefore
    # cannot silently leave an English bookmark / metadata field in the output;
    # normal Node callers have already passed assertCompleteTranslations as well.
    virtual_blocks, virtual_translations = _resolve_virtual_translations(
        doc, translations
    )
    unsafe_links_removed = _remove_unsafe_links(doc)
    safe_links = _capture_safe_links(doc)
    page_geometry = _page_geometry_signature(doc)
    source_outline = _outline_signature(doc)
    source_metadata = dict(doc.metadata or {})

    # 페이지별 그림 영역 캐시(추출과 동일 기준) — 축 라벨 줄을 덮기/그리기에서 뺀다.
    fig_cache = {}
    table_cell_cache = {}
    table_layout_cache = {}
    table_region_cache = {}
    figure_translation_cache = {}
    texttrace_cache = {}

    def figs_for(pno):
        if pno not in fig_cache:
            fig_cache[pno] = _skip_regions(
                doc[pno], table_layouts_for(pno)
            )  # 그림 + 표
        return fig_cache[pno]

    def table_layouts_for(pno):
        if pno not in table_layout_cache:
            table_layout_cache[pno] = _table_layouts(doc[pno])
        return table_layout_cache[pno]

    def table_cells_for(pno):
        if pno not in table_cell_cache:
            _use_page(pno)
            table_cell_cache[pno] = _table_cell_blocks(
                doc[pno], pno, table_layouts_for(pno)
            )
        return table_cell_cache[pno]

    def table_regions_for(pno):
        if pno not in table_region_cache:
            table_region_cache[pno] = [
                fitz.Rect(table["rect"]) for table in table_layouts_for(pno)
            ]
        return table_region_cache[pno]

    def figure_translation_regions_for(pno):
        if pno not in figure_translation_cache:
            figure_translation_cache[pno] = _figure_translation_regions(
                doc[pno], table_regions_for(pno)
            )
        return figure_translation_cache[pno]

    def texttraces_for(pno):
        if pno not in texttrace_cache:
            texttrace_cache[pno] = list(doc[pno].get_texttrace())
        return texttrace_cache[pno]

    # 번역이 있는 블록만 (페이지별로) 모은다.
    by_page = defaultdict(list)
    kept_by_page = defaultdict(list)  # 번역하지 않는 원본 글리프 rect — redaction 보호용
    layout_kept_by_page = defaultdict(list)  # glyph-tight draw/expansion obstacles
    preserved_spans_by_page = defaultdict(list)  # exact source text-op replay proof
    static_by_page = defaultdict(list)  # 번역 안 된 모든 블록(수식·라벨·미번역) — 압축 앵커
    formula_by_page = defaultdict(list)  # 원본 보존 표시수식 — 짧은 도입어 정렬 근거
    logical_rects_by_page = defaultdict(list)  # source content-order anchor map
    logical_source_y_by_id = {}
    source_text_by_id = {}
    table_layout_by_id = {}
    source_rotation_by_id = {}
    table_translation_pages = set()
    skipped_table_positions = defaultdict(list)
    pending_table_logical = defaultdict(list)
    # Formula-only identity translations intentionally keep the source PDF glyph
    # stream.  This is a completed render operation, but it is not a replacement:
    # report it separately so the caller can validate every preserved ID against
    # its source text instead of either redrawing damaged MathTime Unicode or
    # silently lowering the expected block count.
    preserved_original_ids = []
    for bid, pno, block in iter_text_blocks(
        doc, hidden_ocr_pages=hidden_ocr_pages
    ):
        _use_page(pno)  # cmd_extract와 동일한 페이지별 깨진 글리프 복원
        # Table-row source blocks have no ordinary translatable lines.  Their
        # glyphs are handled below as cell-specific string IDs; do not turn the
        # original merged row into a static clipping mask.  Figure/axis labels,
        # however, remain logical preserved-text anchors for content ordering.
        visible_text = block_text(block, figs_for(pno))
        block_rect = fitz.Rect(block["bbox"])
        block_centre = (
            (block_rect.x0 + block_rect.x1) / 2.0,
            (block_rect.y0 + block_rect.y1) / 2.0,
        )
        if not visible_text and any(
            table.x0 <= block_centre[0] <= table.x1
            and table.y0 <= block_centre[1] <= table.y1
            for table in table_regions_for(pno)
        ):
            skipped_table_positions[pno].append(
                (len(logical_rects_by_page[pno]), bid, block_rect)
            )
            continue
        logical_rect = fitz.Rect(block["bbox"])
        logical_rects_by_page[pno].append((bid, logical_rect))
        logical_source_y_by_id[bid] = float(logical_rect.y0)
        ko = translations.get(str(bid))
        if ko is None:
            ko = translations.get(bid)
        source_visible_text = str(visible_text or "").strip()
        source_tagged_text = str(block_text(block, figs_for(pno), tag=True) or "").strip()
        source_text_by_id[bid] = source_tagged_text or source_visible_text
        unchanged_translation = bool(
            ko
            and str(ko).strip()
            and str(ko).strip() == source_tagged_text
            and _formula_only_visible_text(source_tagged_text)
        )
        if unchanged_translation:
            preserved_original_ids.append(bid)
        if not ko or not str(ko).strip() or unchanged_translation:
            # 번역이 없거나 byte-for-byte 같은 블록은 원본이 그대로 남으므로(이동
            # 불가) 세로압축의 '고정 앵커'다.  Formula/code-only blocks are deliberately
            # returned unchanged by the response layer; preserving their original PDF glyphs
            # avoids replacing a visually correct MathTime glyph with a damaged Unicode map.
            r0 = fitz.Rect(_nonfig_rect(block, figs_for(pno)))
            static_by_page[pno].append(r0)
            # ``cmd_extract`` deliberately omits displayed equations, isolated
            # charges / coefficients, vector labels and table text.  Some of those
            # fragments (for example a separately encoded SO4 charge) are not
            # themselves classified by ``_keep_original_block`` but still overlap a
            # translated prose block's union bbox.  Protect every untranslated
            # visible block: incomplete callers then fail postflight with residual
            # source language instead of silently deleting source glyphs, while
            # intentional formula / figure fragments remain byte-for-byte intact.
            if not r0.is_empty and r0.width > 0 and r0.height > 0:
                kept_by_page[pno].append(r0)
                descriptors = [
                    _preserved_span_descriptor(span)
                    for line in block.get("lines", [])
                    for span in line.get("spans", [])
                    if str(span.get("text", "")).strip()
                ]
                if descriptors:
                    preserved_spans_by_page[pno].append((r0, descriptors))
                exact_formula_keep = bool(
                    unchanged_translation or _keep_original_block(block)
                )
                layout_obstacle = r0
                if exact_formula_keep:
                    layout_obstacle = _tight_preserved_layout_obstacle(
                        texttraces_for(pno), descriptors, r0
                    )
                layout_kept_by_page[pno].append(layout_obstacle)
                if exact_formula_keep:
                    formula_by_page[pno].append(r0)
            continue
        # 블록 전체 bbox 가 아니라 '그림 영역 줄을 뺀' bbox 만 덮는다.
        # → 캡션에 붙은 축 라벨(V(R_AB))을 지우지 않고 영어 그대로 남긴다.
        rect = _nonfig_rect(block, figs_for(pno))
        size, color, is_bold, is_ital = dominant_size_color(block)
        if block.get("_caption_chain"):
            source_direction = tuple(
                block.get("_source_text_direction")
                or _block_primary_direction(block)
            )
            if source_direction == (0, -1):
                source_rotation_by_id[bid] = 90
            elif source_direction == (0, 1):
                source_rotation_by_id[bid] = 270
        redraw_text = _normalize_redrawn_latin_ligatures(_clean_ko(ko)).strip()
        by_page[pno].append(
            (rect, redraw_text, size, color, is_bold, is_ital, bid)
        )
    for pno in range(len(doc)):
        if pno in hidden_ocr_pages:
            continue  # scanned table pixels remain in the page-sized source image
        for cell in table_cells_for(pno):
            bid = cell["id"]
            rect = fitz.Rect(cell["source_rect"])
            rank_candidates = []
            cx = (rect.x0 + rect.x1) / 2.0
            cy = (rect.y0 + rect.y1) / 2.0
            for _position, source_bid, source_rect in skipped_table_positions.get(pno, []):
                sx = (source_rect.x0 + source_rect.x1) / 2.0
                sy = (source_rect.y0 + source_rect.y1) / 2.0
                if _rect_overlap_fraction(rect, source_rect) > 0.02 or (
                    source_rect.y0 - 2 <= cy <= source_rect.y1 + 2
                ):
                    rank_candidates.append((abs(cx - sx) + 2.0 * abs(cy - sy), source_bid))
            order_rank = (
                min(rank_candidates, key=lambda value: (value[0], value[1]))[1]
                if rank_candidates
                else len(logical_rects_by_page[pno])
            )
            cell["order_rank"] = int(order_rank)
            pending_table_logical[pno].append((cell, int(order_rank), rect))
            logical_source_y_by_id[bid] = float(rect.y0)
            if not cell["translate"]:
                static_by_page[pno].append(rect)
                kept_by_page[pno].append(rect)
                layout_kept_by_page[pno].append(rect)
                continue
            table_layout_by_id[bid] = cell
            ko = translations.get(str(bid))
            if ko is None:
                ko = translations.get(bid)
            if not ko or not str(ko).strip():
                static_by_page[pno].append(rect)
                kept_by_page[pno].append(rect)
                layout_kept_by_page[pno].append(rect)
                continue
            table_translation_pages.add(pno)
            by_page[pno].append(
                (
                    rect,
                    _normalize_redrawn_latin_ligatures(_clean_ko(ko)).strip(),
                    cell["size"],
                    cell["color"],
                    cell["bold"],
                    cell["italic"],
                    bid,
                )
            )
    # Insert cell anchors where the original merged table-row streams occurred.
    # This retains the producer's left-column/right-column content order while
    # ordering cells row-major inside each table.
    for pno, pending in pending_table_logical.items():
        grouped = defaultdict(list)
        for cell, order_rank, rect in pending:
            key = tuple(round(value, 3) for value in cell["table_rect"])
            grouped[key].append((cell, order_rank, rect))
        insertions = []
        for table_key, entries in grouped.items():
            table_rect = fitz.Rect(table_key)
            positions = [
                position
                for position, _source_bid, skipped_rect in skipped_table_positions.get(pno, [])
                if _rect_overlap_fraction(skipped_rect, table_rect) > 0.05
            ]
            insert_at = min(positions) if positions else len(logical_rects_by_page[pno])
            entries.sort(
                key=lambda value: (
                    value[0]["cell_rect"].y0,
                    value[0]["cell_rect"].x0,
                    int(value[1]),
                )
            )
            insertions.append(
                (
                    insert_at,
                    table_rect.y0,
                    table_rect.x0,
                    [(order_rank, rect) for _cell, order_rank, rect in entries],
                )
            )
        offset = 0
        for insert_at, _y, _x, entries in sorted(insertions):
            actual = min(len(logical_rects_by_page[pno]), insert_at + offset)
            logical_rects_by_page[pno][actual:actual] = entries
            offset += len(entries)
    page_draw_expected = sum(len(items) for items in by_page.values())
    page_expected = page_draw_expected + len(preserved_original_ids)

    # 번역 전체에서 실제로 그릴 문자만 fontTools로 먼저 subset한다. 이 단계가 없으면
    # Pretendard의 미사용 non-BMP cmap entry 때문에 MuPDF가 5자리 목적값을 가진 깨진
    # ToUnicode를 생성한다. full-font 폴백은 같은 손상을 되살리므로 허용하지 않는다.
    translation_codepoints = _translation_codepoints(by_page)
    _fdir = os.path.dirname(os.path.abspath(font_path))
    regular_bytes, regular_coverage = _subset_font_bytes(
        font_path, translation_codepoints, "Pretendard Regular"
    )
    bold_path = os.path.join(_fdir, "Pretendard-Bold.ttf")
    bold_bytes, bold_coverage = _subset_font_bytes(
        bold_path, translation_codepoints, "Pretendard Bold"
    )
    fallback_path = os.path.join(_fdir, "NanumGothic-Regular.ttf")
    fallback_bytes, fallback_coverage = _subset_font_bytes(
        fallback_path, translation_codepoints, "NanumGothic fallback"
    )
    # Scientific prose frequently keeps source-authored inline operators inside
    # the translated sentence (for example M<sub>⊙</sub> and ⟨x⟩).  Those
    # are not standalone display equations, so keeping their original page
    # coordinates would separate the symbol from the reflowed Korean sentence.
    # STIX Two Math is an OFL-licensed bundled font dedicated to this exact
    # repertoire.  As with every other renderer font, subset it to the requested
    # code points and keep the global coverage check fail-closed.
    math_path = os.path.join(_fdir, "STIXTwoMath.otf")
    math_bytes, math_coverage = _subset_font_bytes(
        math_path, translation_codepoints, "STIX Two Math fallback"
    )
    covered = (
        regular_coverage
        | bold_coverage
        | fallback_coverage
        | math_coverage
    )
    missing = translation_codepoints.difference(covered)
    if missing:
        preview = ", ".join(f"U+{cp:04X}" for cp in sorted(missing)[:12])
        raise RuntimeError(f"bundled PDF fonts do not cover translation text: {preview}")

    # bytes 객체를 cmd_render가 끝날 때까지 보유한다. fitz.Font(fontbuffer=...)는 파일
    # 충돌 없는 in-memory font를 사용하므로 동시 job끼리 subset 파일을 덮어쓰지 않는다.
    subset_font_buffers = {
        "regular": regular_bytes,
        "bold": bold_bytes,
        "fallback": fallback_bytes,
        "math": math_bytes,
    }
    subset_font_digests = {
        hashlib.sha256(data).hexdigest() for data in subset_font_buffers.values()
    }
    font = fitz.Font(fontbuffer=subset_font_buffers["regular"])
    font_bold = fitz.Font(fontbuffer=subset_font_buffers["bold"])
    font_fb = fitz.Font(fontbuffer=subset_font_buffers["fallback"])
    font_math = fitz.Font(fontbuffer=subset_font_buffers["math"])

    replaced = 0
    shrunk = 0
    overflow = 0
    failed = 0
    overflow_ids = []
    failed_ids = []
    min_font = None
    min_glyph_font = None
    font_sizes = []
    reading_order_diagnostics = {}
    for pno, items in by_page.items():
        page = doc[pno]
        page_text_rect = _page_text_rect(page)
        sample = _sample_pixmap(page)  # redaction 색 맞춤용(원본 배경 샘플)
        page_bg = _page_bg(sample)
        figs = figs_for(pno)  # 그림 영역 — 덮기/그리기를 이 밖으로 자른다(캐시 재사용).
        # 블록 rect 를 그림 밖으로 클리핑(완전히 그림 안이면 제외). → 그림 배경에 흰 자국
        # 안 생기고, 캡션에 붙은 축 라벨(V(RAB) 등)도 원본 그대로 유지.
        # 그림 + '원본유지(수식·전자배치·라벨)' 블록 영역 밖으로 클리핑한다. 번역문이
        # 옆/위에 놓인 식·전자배치 위에 겹쳐 찍히던 것(답안 (d)(e), 논문 식 옆 본문 등)을
        # 막는다 — 번역문은 식과 안 겹치는 가장 큰 직사각형에만 그려진다.
        kept_here = layout_kept_by_page.get(pno, [])
        clip_regions = list(figs) + list(kept_here)
        # Drawing may use the largest safe rectangle after avoiding a neighbouring
        # figure/equation, but source deletion must still cover every translated
        # source glyph outside the *exact* protected geometry.  Keeping these
        # original rectangles prevents the draw clipping decision from leaving an
        # entire English strip behind.
        source_redaction_by_id = {
            bid: (fitz.Rect(rect), col, table_layout_by_id.get(bid) is not None)
            for rect, _ko, _sz, col, _bd, _it, bid in items
        }
        clipped_normal = []
        clipped_table = []
        for rect, ko, sz, col, bd, it, bid in items:
            table_layout = table_layout_by_id.get(bid)
            if table_layout is not None:
                # The source glyph bbox is the redaction target.  A table-like
                # vector cluster is deliberately not a clipping region for this
                # cell, but an independently detected neighbouring chart/image is.
                cr = fitz.Rect(rect)
                if any(
                    _rect_overlap_fraction(cr, figure) > 0.05
                    for figure in figure_translation_regions_for(pno)
                ):
                    cr = None
            else:
                cr = _clip_out(rect, clip_regions) if clip_regions else fitz.Rect(rect)
            if cr is None or cr.width < 3 or cr.height < 3:
                failed += 1
                failed_ids.append(bid)
                font_sizes.append(
                    {
                        "id": bid,
                        "source": round(float(sz), 2),
                        "rendered": None,
                        "min_glyph": None,
                    }
                )
                continue
            target = clipped_table if table_layout is not None else clipped_normal
            target.append((cr, ko, sz, col, bd, it, bid))
        # Infer source column envelopes before deduplication / vertical compaction.
        # Those later operations may change y or trim overlapping boxes, but never
        # establish permission to consume the page-edge margin or a neighbouring
        # column.
        column_right_caps = _infer_column_right_caps(clipped_normal, page)
        formula_transition_ids = set()
        formula_transition_caps = {}
        for transition_item in clipped_normal:
            transition_rect = fitz.Rect(transition_item[0])
            transition_id = transition_item[6]
            if not _is_formula_transition_before_preserved_formula(
                transition_rect,
                source_text_by_id.get(transition_id, ""),
                formula_by_page.get(pno, []),
                page,
            ):
                continue
            matching_cap = _matching_column_cap(
                transition_rect,
                clipped_normal,
                column_right_caps,
                page,
            )
            if matching_cap is None:
                continue
            formula_transition_ids.add(transition_id)
            formula_transition_caps[transition_id] = matching_cap
        # redaction(원문 지우기)은 '겹침 분할 전' 각 블록의 제 bbox 전체로 한다.
        # dedoverlap 은 '번역문 그리기' 위치만 좁히는 용도 — 그 좁힌 rect 로 redaction 까지
        # 하면, 큰 문단 조각이 첫 줄로 잘려 뒷부분 원문(영어)이 안 지워지고 남는다
        # (인라인 수식이 한 줄을 쪼갠 문단에서 흔함). 그리기는 dedoverlap 결과를 쓴다.
        redact_full = []
        for clipped_item in clipped_normal + clipped_table:
            bid = clipped_item[6]
            original = source_redaction_by_id.get(bid)
            if original is None:
                original = (
                    fitz.Rect(clipped_item[0]),
                    clipped_item[3],
                    table_layout_by_id.get(bid) is not None,
                )
            redact_full.append((*original, bid))
        clipped_normal = _dedoverlap_column(clipped_normal)
        clipped_normal = _expand_lowercase_formula_tails_upward(
            clipped_normal,
            static_by_page.get(pno, []),
            figs,
            formula_by_page.get(pno, []),
            source_text_by_id,
            page_text_rect,
            font,
        )
        # F1 세로압축: 한국어가 원문보다 짧아 생긴 문단 사이 빈칸을 없앤다(블록을 위로만
        # 끌어올림). redaction 은 위 redact_full(원위치)로 이미 잡아둬 영향 없다.
        # 앵커 = 번역 안 된 모든 블록(수식·라벨·미번역) + 그림 — 그 위로는 안 넘긴다.
        clipped_normal = _compact_columns(
            clipped_normal, static_by_page.get(pno, []), figs, page_text_rect, font
        )
        # Cell rectangles are immutable layout constraints: never deduplicate,
        # compact, or grow them into an adjacent row / column.
        clipped = clipped_normal + clipped_table
        # 각 블록의 확장 한계 = 오른쪽/아래 '이웃 블록'까지(없으면 페이지 여백). 제목·헤딩이
        # 번역으로 길어져 가로·세로로 늘어나도 이웃을 침범해 겹치지 않도록 막는다.
        crects = [it[0] for it in clipped]
        nC = len(crects)
        # 확장을 막는 '장애물' = 다른 번역 블록 + 원본유지(수식·표 셀·라벨) + 그림/표 영역.
        # 원본유지 블록과 영역을 포함해야, 표 헤딩 번역문이 아래 표 셀 위로 넘치거나
        # 본문이 인접 수식을 침범하지 않는다(TABLE 6.1 헤딩 겹침 수정).
        kept = list(layout_kept_by_page.get(pno, []))
        obstacles = crects + kept + list(figs)
        bounds = []
        for i in range(nC):
            ri = crects[i]
            table_layout = table_layout_by_id.get(clipped[i][6])
            if table_layout is not None:
                cell = fitz.Rect(table_layout["cell_rect"])
                inset_x = min(2.0, max(0.75, 0.04 * cell.width))
                inset_y = min(1.25, max(0.5, 0.06 * cell.height))
                left = cell.x0 + inset_x
                right = cell.x1 - inset_x
                if table_layout["align"] == fitz.TEXT_ALIGN_LEFT:
                    left = min(right - 3.0, max(left, ri.x0))
                elif table_layout["align"] == fitz.TEXT_ALIGN_RIGHT:
                    right = max(left + 3.0, min(right, ri.x1))
                inner = fitz.Rect(
                    left,
                    max(cell.y0 + inset_y, ri.y0 - 0.5),
                    right,
                    cell.y1 - inset_y,
                )
                if inner.width < 3 or inner.height < 2:
                    inner = fitz.Rect(cell)
                table_layout["draw_rect"] = inner
                bounds.append((inner.x0, inner.x1, inner.y1))
                continue
            lx = page_text_rect.x0 + 6.0
            bx = page_text_rect.x1 - 6.0
            by = page_text_rect.y1 - 6.0
            for rj in obstacles:
                if rj is ri:
                    continue  # 자기 자신(번역 블록)만 제외
                # 오른쪽 이웃 → 가로 확장 한계. 세로로 조금이라도 같은 띠에 걸치면(0.10)
                # 막는다 — 느슨하면(0.25) 수식 영역의 흩어진 블록이 서로를 못 보고 확장해 겹침.
                oy = min(ri.y1, rj.y1) - max(ri.y0, rj.y0)
                if rj.x0 >= ri.x1 - 1 and oy > 0.10 * min(ri.height, max(rj.height, 1.0)):
                    bx = min(bx, rj.x0 - 2)
                # 왼쪽 이웃 → 우측정렬 header/footer를 왼쪽으로 넓힐 수 있는 한계.
                if rj.x1 <= ri.x0 + 1 and oy > 0.10 * min(ri.height, max(rj.height, 1.0)):
                    lx = max(lx, rj.x1 + 2)
                # 아래 이웃 → 세로 확장 한계(가로로 조금이라도 겹치면 막는다).
                ox = min(ri.x1, rj.x1) - max(ri.x0, rj.x0)
                if rj.y0 >= ri.y1 - 1 and ox > 0.10 * min(ri.width, max(rj.width, 1.0)):
                    by = min(by, rj.y0 - 2)
            # 세로 확장은 원래 높이의 ~3배까지만(아래 이웃 미검출 시 runaway 방지 — 한
            # 블록이 페이지 절반을 덮어 다른 글자 위로 흐르는 일 차단).
            by = min(by, ri.y1 + 3.0 * max(ri.height, 8.0))
            source_cap = column_right_caps.get(clipped[i][6])
            if source_cap is None:
                source_cap = formula_transition_caps.get(clipped[i][6])
            if source_cap is not None:
                bx = min(bx, max(ri.x1, source_cap))
            bounds.append((min(lx, ri.x0), max(bx, ri.x1), max(by, ri.y1)))
        # 1) 원문 글자만 지운다. images=NONE 으로 그림은 보존.
        #    밝은(흰색 계열) 글자 → fill 생략. 그 외엔 '바로 바깥' 정확 배경색으로 덮어
        #    경계가 안 보이게(상자 느낌 제거).
        at_risk_preserved_descriptors = []
        for protected_rect, descriptors in preserved_spans_by_page.get(pno, []):
            if any(
                not (fitz.Rect(source_rect) & fitz.Rect(protected_rect)).is_empty
                for source_rect, _color, is_table_redaction, _bid in redact_full
                if not is_table_redaction
            ):
                at_risk_preserved_descriptors.extend(descriptors)
        preserved_text_overlay = None
        if at_risk_preserved_descriptors:
            preserved_text_overlay, _preserved_source_groups = (
                _build_preserved_text_overlay(
                    doc, page, at_risk_preserved_descriptors
                )
            )

        for rect, _col, is_table_redaction, _bid in redact_full:
            # 원본유지(표시수식·라벨) 블록과 겹치면, 그 글자를 지우지 않도록 redaction
            # 을 정확한 2-D 조각으로 잘라 보호한다.  일반 블록은 그림도 같은 방식으로
            # 보호하되, 독립 표 셀은 이미 검증된 셀 glyph bbox 자체를 사용한다.
            protected_regions = (
                []
                if is_table_redaction
                else list(kept_by_page.get(pno, [])) + list(figs)
            )
            sub = _split_out_keeps(rect, protected_regions)
            for sr in sub:
                r, g, b = _color01(_col)
                if min(r, g, b) > 0.8:
                    fill = None
                else:
                    bbg = _bg_around(sample, sr) or page_bg
                    fill = (bbg[0] / 255.0, bbg[1] / 255.0, bbg[2] / 255.0)
                page.add_redact_annot(sr, fill=fill)
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
        if preserved_text_overlay is not None:
            _remove_preserved_text_objects(
                doc, page, at_risk_preserved_descriptors
            )
            page = doc.reload_page(page)
        # Streams present at this exact point are the graphics/redaction residue and
        # any intentionally preserved source text.  Subsequent xref deltas belong to
        # one translated block and can be mapped back to its logical source id.
        residual_content_xrefs = list(page.get_contents())
        generated_content_order = {}
        # 2) 같은(클리핑된) 박스에 번역문 삽입. 본문 양끝맞춤, 제목/한 줄은 가운데/왼쪽.
        page_width = page_text_rect.width
        # 페이지 본문 글자 크기(글자 수 최빈) — 헤딩(제목·섹션 제목) 판정 기준.
        _size_chars = defaultdict(float)
        for _it in items:
            _size_chars[round(_it[2], 1)] += max(1, len(_it[1]))
        body_size = max(_size_chars, key=_size_chars.get) if _size_chars else 10.0
        for idx, (rect, ko, _size, color, is_bold, is_ital, bid) in enumerate(clipped):
            base = font_bold if is_bold else font  # 원문 굵게 → 번역본도 굵게
            fallback_fonts = (
                (font, font_fb, font_math)
                if is_bold
                else (font_fb, font_bold, font_math)
            )
            plain_text = _strip_tags(ko)
            mnx, mx, my = bounds[idx]
            table_layout = table_layout_by_id.get(bid)
            # 헤딩 = 본문보다 확실히 큰 글자, 또는 굵으면서 약간 큰 글자. 헤딩은
            # justify 금지(번역으로 길어져 두 줄이 되면 첫 줄 단어가 크게 벌어짐).
            is_heading = table_layout is None and (
                (_size >= 1.18 * body_size)
                or (is_bold and _size >= 1.08 * body_size)
            )
            try:
                # 가로로 넓힐 수 있는 최대 폭 기준 '한 줄 여부' 판정(넓혀서 1줄이면 justify
                # 금지 → 단어 벌어짐 방지). 가운데 정렬 블록은 원래 폭 기준.
                avail_w = (
                    rect.width
                    if rect.width >= 0.45 * page_width
                    else (mx - rect.x0)
                )
                one_line = _text_length_with_fonts(
                    plain_text, _size, base, fallback_fonts
                ) <= (avail_w - 2)
            except Exception:
                one_line = False
            align = (
                table_layout["align"]
                if table_layout is not None
                else _detect_align(
                    rect, page_width, single_line=one_line, is_heading=is_heading
                )
            )
            if (
                bid in formula_transition_ids
                and table_layout is None
                and align != fitz.TEXT_ALIGN_RIGHT
            ):
                align = fitz.TEXT_ALIGN_LEFT
            if (
                table_layout is None
                and
                align == fitz.TEXT_ALIGN_RIGHT
                and not is_heading
                and _body_prose_must_not_be_right_aligned(rect, plain_text, page)
            ):
                align = fitz.TEXT_ALIGN_LEFT
            # MuPDF의 JUSTIFY는 CJK 문장 첫 줄의 U+0020을 좌표 간격으로만 처리해
            # 텍스트 추출 시 단어가 붙을 수 있다. 한글 target만 LEFT로 내려 실제 space
            # glyph를 보존한다. 가운데/오른쪽/헤딩 정렬은 그대로 둔다.
            if align == fitz.TEXT_ALIGN_JUSTIFY and _contains_hangul(plain_text):
                align = fitz.TEXT_ALIGN_LEFT
            # Right-aligned running headers / footers are anchored by their original
            # x1.  The generic fit path expands a bbox to ``max_x`` for longer prose;
            # doing that here would move a short right label all the way to the page
            # edge and destroy its original margin.
            draw_rect = (
                fitz.Rect(table_layout["draw_rect"])
                if table_layout is not None
                else rect
            )
            draw_max_x = mx
            if align == fitz.TEXT_ALIGN_RIGHT and table_layout is None:
                # Grow to the left while keeping the source right edge fixed.  A
                # 2pt allowance is needed even for identity text because extracted
                # glyph bboxes can be a fraction narrower than font metrics.
                try:
                    required_width = _text_length_with_fonts(
                        plain_text, _size, base, fallback_fonts
                    ) + 2.0
                except Exception:
                    required_width = rect.width
                width = min(
                    max(rect.width, required_width),
                    max(rect.width, rect.x1 - mnx),
                )
                draw_rect = fitz.Rect(
                    rect.x1 - width, rect.y0, rect.x1, rect.y1
                )
                draw_max_x = rect.x1
            needs_mixed_writer = not _font_covers_text(base, plain_text)
            contents_before_draw = list(page.get_contents())
            source_rotation = source_rotation_by_id.get(bid)
            if (
                source_rotation in {90, 270}
                and not _has_tags(ko)
                and not needs_mixed_writer
                and table_layout is None
            ):
                draw_state = _draw_fit_rotated(
                    page,
                    draw_rect,
                    ko,
                    _color01(color),
                    (
                        subset_font_buffers["bold"]
                        if is_bold
                        else subset_font_buffers["regular"]
                    ),
                    "QuiloKoCaptionBold" if is_bold else "QuiloKoCaptionRegular",
                    _size,
                    align,
                    source_rotation,
                    min_size=4.0,
                )
            elif _has_tags(ko) or needs_mixed_writer:
                # 위/아래첨자 또는 주 글꼴에 없는 기호(예: ∈)는 글자별 bundled
                # subset font를 고르는 rich 드로어로 처리한다.
                draw_state = _draw_rich(
                    page, draw_rect, ko, _color01(color), base, _size, align,
                    max_x=draw_max_x, max_y=my,
                    min_size=(
                        5.0
                        if table_layout is not None or _has_tags(ko)
                        else 4.0
                    ),
                    fallback_fonts=fallback_fonts,
                )
            else:
                draw_state = _draw_fit(
                    page, draw_rect, ko, _color01(color), base, _size, align,
                    min_size=5.0 if table_layout is not None else 4.0,
                    italic=is_ital, max_x=draw_max_x, max_y=my,
                )
            contents_after_draw = list(page.get_contents())
            before_set = {int(xref) for xref in contents_before_draw}
            new_content_xrefs = [
                int(xref)
                for xref in contents_after_draw
                if int(xref) not in before_set
            ]
            if draw_state["drawn"]:
                content_order_rank = (
                    table_layout.get("order_rank", bid)
                    if table_layout is not None
                    else bid
                )
                for suborder, xref in enumerate(new_content_xrefs):
                    generated_content_order[xref] = (
                        content_order_rank,
                        logical_source_y_by_id.get(bid, float(rect.y0)),
                        suborder,
                    )
            if draw_state["shrunk"]:
                shrunk += 1
            if draw_state["min_font"] is not None:
                min_font = (
                    draw_state["min_font"]
                    if min_font is None
                    else min(min_font, draw_state["min_font"])
                )
            if draw_state["min_glyph_font"] is not None:
                min_glyph_font = (
                    draw_state["min_glyph_font"]
                    if min_glyph_font is None
                    else min(min_glyph_font, draw_state["min_glyph_font"])
                )
            font_sizes.append(
                {
                    "id": bid,
                    "source": round(float(_size), 2),
                    "rendered": draw_state["min_font"],
                    "min_glyph": draw_state["min_glyph_font"],
                }
            )
            if draw_state["drawn"]:
                replaced += 1
            if not draw_state["drawn"]:
                failed += 1
                failed_ids.append(bid)
            elif not draw_state["complete"]:
                overflow += 1
                overflow_ids.append(bid)

        page, reading_order_diagnostic = _interleave_safe_page_text_streams(
            doc,
            page,
            residual_content_xrefs,
            generated_content_order,
            logical_rects_by_page.get(pno, []),
        )
        if preserved_text_overlay is not None:
            page = _append_page_content_stream(
                doc, page, preserved_text_overlay
            )
        reading_order_diagnostics[str(pno + 1)] = reading_order_diagnostic
        source_residuals = _translated_source_residuals(
            page,
            redact_full,
            list(kept_by_page.get(pno, [])) + list(figs),
        )
        if source_residuals:
            preview = ", ".join(
                f"{item['id']}:{item['text']!r}" for item in source_residuals[:8]
            )
            doc.close()
            raise RuntimeError(
                f"residual source text remained after PDF redaction on page {pno + 1}: "
                f"{preview}"
            )
        if (
            pno in table_translation_pages
            and reading_order_diagnostic.get("reason") != "pixel_exact"
            and os.environ.get("PDF_TRANSLATE_ALLOW_TABLE_OVERLAY", "").strip() != "1"
        ):
            reason = reading_order_diagnostic.get("reason", "unknown")
            doc.close()
            raise RuntimeError(
                "table translation reading-order interleave was not proven "
                f"pixel-exact on page {pno + 1}: {reason}"
            )

    page_replaced = replaced
    virtual_stats = _apply_virtual_translations(
        doc,
        virtual_blocks,
        virtual_translations,
        source_outline,
        source_metadata,
    )
    virtual_replaced = (
        virtual_stats["outline_replaced"] + virtual_stats["metadata_replaced"]
    )
    replaced += virtual_replaced
    expected = page_expected + len(virtual_blocks)
    completed = replaced + len(preserved_original_ids)

    restored_links = _restore_safe_links(doc, safe_links)
    if _page_geometry_signature(doc) != page_geometry:
        raise RuntimeError("PDF page geometry changed while rendering translations")
    if _outline_signature(doc) != virtual_stats["expected_outline"]:
        raise RuntimeError("PDF outline changed after translating titles")
    if _metadata_signature(doc) != virtual_stats["expected_metadata"]:
        raise RuntimeError("PDF metadata changed after translating document information")

    doc.save(out_path, garbage=3, deflate=True)
    doc.close()
    try:
        _verify_saved_pdf_structure(
            out_path,
            safe_links,
            page_geometry,
            virtual_stats["expected_outline"],
            virtual_stats["expected_metadata"],
        )
        cmap_stats = _verify_saved_text_cmaps(
            out_path,
            source_cmap_anomalies,
            subset_font_digests,
            expect_generated=page_replaced > 0,
        )
    except Exception:
        try:
            os.remove(out_path)
        except OSError:
            pass
        raise
    write_json_response(
        {
            "ok": overflow == 0 and failed == 0 and completed == expected,
            "replaced": replaced,
            "drawn": replaced,
            "completed": completed,
            "expected": expected,
            "page_expected": page_expected,
            "page_drawn": page_replaced,
            "font_expected": page_draw_expected,
            "preserved_original": len(preserved_original_ids),
            "preserved_original_ids": preserved_original_ids,
            "virtual_replaced": virtual_replaced,
            "outline_expected": sum(
                1 for block in virtual_blocks if block.get("kind") == "outline"
            ),
            "outline_replaced": virtual_stats["outline_replaced"],
            "metadata_expected": sum(
                1 for block in virtual_blocks if block.get("kind") == "metadata"
            ),
            "metadata_replaced": virtual_stats["metadata_replaced"],
            "shrunk": shrunk,
            "overflow": overflow,
            "failed": failed,
            "overflow_ids": overflow_ids,
            "failed_ids": failed_ids,
            "restored_links": restored_links,
            "unsafe_links_removed": unsafe_links_removed,
            "min_font": round(min_font, 2) if min_font is not None else None,
            "min_glyph_font": (
                round(min_glyph_font, 2) if min_glyph_font is not None else None
            ),
            "font_sizes": font_sizes,
            "validated_subset_fonts": cmap_stats["validated_subset_fonts"],
            "preserved_source_cmap_anomalies": cmap_stats[
                "preserved_source_cmap_anomalies"
            ],
            "reading_order": reading_order_diagnostics,
        }
    )


_SPLIT_PROVENANCE_VERSION = 1
_SPLIT_DOCUMENT_KEY = "QuiloSplitDocument"
_SPLIT_PAGE_KEY = "QuiloSourcePage"
_SPLIT_TOKEN_KEY = "QuiloPageToken"
_SPLIT_TOKEN_RE = re.compile(r"[0-9a-f]{32}\Z")
_SPLIT_BOUNDARY_POLICY = "sentence-safe-backtrack-v1"


def _split_boundary_content(block, page):
    """Return ``(kind, text)`` for significant content near a page boundary.

    Running headers / footers, captions, URLs and short labels must not move a
    chunk boundary. Formula-only blocks are retained as sentinels: when one is the
    page's final significant block, it completes the same-page layout and prevents
    an earlier formula introduction from being mistaken for a cross-page cut.
    """
    height = max(1.0, float(page.rect.height))
    top_margin = float(page.rect.y0) + 0.08 * height
    bottom_margin = float(page.rect.y1) - 0.08 * height
    content_lines = []
    for line in block.get("lines", []) or []:
        rect = fitz.Rect(line.get("bbox", (0, 0, 0, 0)))
        centre_y = (rect.y0 + rect.y1) / 2.0
        if top_margin < centre_y < bottom_margin:
            content_lines.append(line)
    if not content_lines:
        return None
    content_block = _block_from_lines(block, content_lines)
    text = block_text(content_block).strip()
    if not text or not re.search(r"[A-Za-z]", text):
        return None
    if re.match(r"^(?:https?|mailto):", text, re.I):
        return None
    if re.match(
        r"^(?:fig(?:ure)?\.?|table|scheme|box)\s*[\dIVX]",
        text,
        re.I,
    ):
        return None
    if _keep_original_block(content_block) or _formula_only_visible_text(
        block_text(content_block, tag=True)
    ):
        return "formula", text
    if len(text) < 40 or not re.search(r"[A-Za-z]{3,}", text):
        return None
    return "prose", text


def _cross_page_continuations(doc):
    """Return zero-based page indexes whose following page continues a sentence.

    A non-terminal final prose block is unsafe even when the next page begins with
    a capital, citation, or section reference. Those are common continuation forms
    in textbooks and were the source of the original boundary loss. Formula-only
    final blocks are safe sentinels because they remain in the source PDF intact.
    """
    if len(doc) < 2:
        return set()
    build_decoders(doc)
    content_by_page = defaultdict(list)
    hidden_ocr_pages = _hidden_ocr_scan_page_indexes(doc)
    for _bid, pno, block in iter_text_blocks(
        doc, hidden_ocr_pages=hidden_ocr_pages
    ):
        _use_page(pno)
        entry = _split_boundary_content(block, doc[pno])
        if entry:
            content_by_page[pno].append(entry)

    continuations = set()
    sentence_end = re.compile(r"[.!?。．？！…][\"'\u2019\u201d)\]]*$")
    for pno in range(len(doc) - 1):
        current = content_by_page.get(pno)
        if not current:
            continue
        kind, head = current[-1]
        if kind != "prose":
            continue
        head = head.rstrip()
        if sentence_end.search(head):
            continue
        continuations.add(pno)
    return continuations


def _sentence_safe_chunk_ranges(doc, pages_per_chunk):
    """Plan contiguous chunks without ever exceeding ``pages_per_chunk``.

    Only an unsafe nominal boundary is moved, choosing the nearest safe boundary
    earlier in the current chunk.  Searching backwards (never forwards) preserves
    the concurrency / memory ceiling.  If the current chunk contains no safe cut,
    fail closed instead of silently separating a continued sentence.
    """
    total = len(doc)
    maximum = max(1, int(pages_per_chunk))
    continuations = _cross_page_continuations(doc) if total > maximum else set()
    ranges = []
    adjusted = []
    start = 0
    while start < total:
        nominal_end = min(start + maximum, total)
        end = nominal_end
        if nominal_end < total and (nominal_end - 1) in continuations:
            lower = start + 1
            for candidate in range(nominal_end - 1, lower - 1, -1):
                if (candidate - 1) not in continuations:
                    end = candidate
                    adjusted.append(
                        {
                            "nominal_end": nominal_end,
                            "selected_end": end,
                        }
                    )
                    break
            if end == nominal_end:
                raise RuntimeError(
                    "cannot find a sentence-safe PDF chunk boundary between "
                    f"source pages {start + 1} and {nominal_end}"
                )
        ranges.append((start, end))
        start = end
    return ranges, {
        "name": _SPLIT_BOUNDARY_POLICY,
        "max_pages_per_chunk": maximum,
        "search_scope": "entire_current_chunk",
        "adjusted_boundaries": adjusted,
        "unresolved_boundaries": [],
    }


def _set_split_page_provenance(doc, page, document_token, source_page, page_token):
    doc.xref_set_key(page.xref, _SPLIT_DOCUMENT_KEY, fitz.get_pdf_str(document_token))
    doc.xref_set_key(page.xref, _SPLIT_PAGE_KEY, str(int(source_page)))
    doc.xref_set_key(page.xref, _SPLIT_TOKEN_KEY, fitz.get_pdf_str(page_token))


def _read_split_page_provenance(doc, page):
    document_type, document_token = doc.xref_get_key(page.xref, _SPLIT_DOCUMENT_KEY)
    page_type, source_page = doc.xref_get_key(page.xref, _SPLIT_PAGE_KEY)
    token_type, page_token = doc.xref_get_key(page.xref, _SPLIT_TOKEN_KEY)
    if document_type != "string" or token_type != "string" or page_type not in {
        "int",
        "float",
    }:
        raise RuntimeError("merge part is missing PDF split provenance")
    try:
        source_page_number = int(float(source_page))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("merge part has invalid PDF source-page provenance") from exc
    return str(document_token), source_page_number, str(page_token)


def _validate_part_manifest(parts, manifest, source_page_count):
    if not isinstance(manifest, dict):
        raise RuntimeError("merge part manifest is required")
    if manifest.get("version") != _SPLIT_PROVENANCE_VERSION:
        raise RuntimeError("merge part manifest version is unsupported")
    document_token = str(manifest.get("document_token") or "")
    if not _SPLIT_TOKEN_RE.fullmatch(document_token):
        raise RuntimeError("merge part manifest document token is invalid")
    chunks = manifest.get("chunks")
    if not isinstance(chunks, list) or len(chunks) != len(parts):
        raise RuntimeError("merge part manifest count does not match parts")

    expected_page = 1
    all_tokens = set()
    normalized = []
    for index, (part_path, entry) in enumerate(zip(parts, chunks)):
        if not isinstance(entry, dict):
            raise RuntimeError("merge part manifest entry is invalid")
        try:
            start = int(entry.get("start"))
            end = int(entry.get("end"))
        except (TypeError, ValueError) as exc:
            raise RuntimeError("merge part manifest range is invalid") from exc
        tokens = entry.get("page_tokens")
        if (
            start != expected_page
            or end < start
            or not isinstance(tokens, list)
            or len(tokens) != end - start + 1
        ):
            raise RuntimeError("merge part manifest ranges are not contiguous")
        normalized_tokens = [str(token) for token in tokens]
        if any(not _SPLIT_TOKEN_RE.fullmatch(token) for token in normalized_tokens):
            raise RuntimeError("merge part manifest page token is invalid")
        if any(token in all_tokens for token in normalized_tokens):
            raise RuntimeError("merge part manifest contains duplicate page tokens")
        all_tokens.update(normalized_tokens)

        part = fitz.open(part_path)
        try:
            if part.needs_pass:
                raise RuntimeError(f"merge part is encrypted: {part_path}")
            if len(part) != len(normalized_tokens):
                raise RuntimeError(
                    f"merge part page count does not match manifest at part {index + 1}"
                )
            for local_index, expected_token in enumerate(normalized_tokens):
                actual_document, actual_page, actual_token = _read_split_page_provenance(
                    part, part[local_index]
                )
                expected_source_page = start + local_index
                if (
                    actual_document != document_token
                    or actual_page != expected_source_page
                    or actual_token != expected_token
                ):
                    raise RuntimeError(
                        f"merge part provenance mismatch at source page {expected_source_page}"
                    )
        finally:
            part.close()
        normalized.append(
            {"start": start, "end": end, "page_tokens": normalized_tokens}
        )
        expected_page = end + 1

    if expected_page != source_page_count + 1:
        raise RuntimeError("merge part manifest does not cover every source page")
    return {
        "version": _SPLIT_PROVENANCE_VERSION,
        "document_token": document_token,
        "chunks": normalized,
    }


def cmd_split(pdf_path, out_dir, pages_per_chunk=5):
    """텍스트 PDF 를 페이지 범위로 나눠 sub-PDF 들로 저장(재조판 병렬 처리용).
    각 chunk 를 동시에 번역해 합치면 Opus 품질 그대로 벽시계 시간을 줄인다.

    outline/문서정보는 페이지 chunk에 복제하지 않고 전체 문서의 virtual
    blocks로 한 번만 돌려준다. Node는 page chunks와 이 블록을 병렬
    번역하고, merge가 원본 구조에 번역된 제목을 한 번만 적용한다.
    """
    pages_per_chunk = max(1, int(pages_per_chunk))
    os.makedirs(out_dir, exist_ok=True)
    src = fitz.open(pdf_path)
    n = len(src)
    virtual_blocks = _document_virtual_blocks(src)
    outline_items = len(src.get_toc(simple=False) or [])
    chunk_ranges, split_policy = _sentence_safe_chunk_ranges(
        src, pages_per_chunk
    )
    document_token = os.urandom(16).hex()
    chunks = []
    manifest_chunks = []
    ci = 0
    for start, end in chunk_ranges:
        sub = fitz.open()
        sub.insert_pdf(src, from_page=start, to_page=end - 1)
        page_tokens = []
        for local_index in range(len(sub)):
            page_token = os.urandom(16).hex()
            _set_split_page_provenance(
                sub,
                sub[local_index],
                document_token,
                start + local_index + 1,
                page_token,
            )
            page_tokens.append(page_token)
        path = os.path.join(out_dir, f"chunk-{ci}.pdf")
        sub.save(path, garbage=3, deflate=True)
        sub.close()
        chunks.append(
            {
                "path": path,
                "start": start + 1,
                "end": end,
                "page_tokens": page_tokens,
            }
        )
        manifest_chunks.append(
            {"start": start + 1, "end": end, "page_tokens": page_tokens}
        )
        ci += 1
    src.close()
    write_json_response(
        {
            "page_count": n,
            "chunks": chunks,
            "split_policy": split_policy,
            "part_manifest": {
                "version": _SPLIT_PROVENANCE_VERSION,
                "document_token": document_token,
                "chunks": manifest_chunks,
            },
            "virtual_blocks": virtual_blocks,
            "structure": {
                "outline_items": outline_items,
                "outline_translation_blocks": sum(
                    1 for block in virtual_blocks if block.get("kind") == "outline"
                ),
                "metadata_translation_blocks": sum(
                    1 for block in virtual_blocks if block.get("kind") == "metadata"
                ),
            },
        }
    )


def _figure_caption(tblocks, reg, gap=80.0):
    """그림 영역 reg 의 캡션(마커 배치 힌트). 'FIGURE/그림/Table/표/Scheme …'으로
    시작하는, 그림과 가까운(세로로 겹치거나 위/아래 ±gap) 블록만 신뢰한다. 옆에
    붙은 캡션도 잡고, 본문 문단·저작권 푸터를 캡션으로 오인하지 않는다."""
    import re as _re

    # 키워드(FIGURE/그림/Table…) + 번호. 블록 앞부분에서만 찾아 본문 중간의
    # 'see Figure 6' 같은 참조는 캡션으로 오인하지 않는다.
    pat = _re.compile(
        r"(FIG(?:URE)?|그림|Figure|Table|TABLE|표|SCHEME|Scheme)\.?\s*[\dIVXP]",
        _re.I,
    )
    cx_r, cy_r = (reg.x0 + reg.x1) / 2.0, (reg.y0 + reg.y1) / 2.0
    cands = []
    for b in tblocks:
        if len(b) < 5:
            continue
        x0, y0, x1, y1 = b[0], b[1], b[2], b[3]
        txt = (b[4] or "").strip()
        if not txt:
            continue
        oneline = " ".join(txt.split())
        m = pat.search(oneline[:40])  # 캡션은 앞쪽에서 시작
        if not m:
            continue
        if y1 < reg.y0 - gap or y0 > reg.y1 + gap:
            continue  # 그림에서 세로로 너무 멀면 다른 그림 캡션
        cap = oneline[m.start() :]  # 키워드부터(앞에 붙은 축 라벨 등 제거)
        dist = abs((x0 + x1) / 2.0 - cx_r) + abs((y0 + y1) / 2.0 - cy_r)
        cands.append((dist, cap))
    if cands:
        cands.sort(key=lambda t: t[0])
        return cands[0][1][:90]
    return ""


def _expand_region_with_labels(
    page, reg, side_margin=64.0, below_pad=26.0, above_pad=11.0, other_regions=None
):
    """그림 region 을 주변에 '붙은' 짧은 라벨까지 넓힌다 — 축 눈금 숫자(350·40 등),
    곡선/화살표 이름(Secant Lines·Tangent Line), 축 제목(Time (days)·Number of flies).
    이 라벨들은 벡터 드로잉 bbox 밖의 '텍스트'라 _figure_regions 클러스터에 안 잡혀,
    좁은 pad 로 크롭하면 잘려 나간다.

    확장 방향을 구분해 그림 '위/아래'의 본문·수식을 이미지에 굽지 않는다:
    - 옆(좌/우): 그림과 세로로 겹치는 블록만 side_margin 까지 병합(축 숫자·곡선 라벨).
    - 아래: 바로 아래 below_pad 이내 + 가로로 겹치는 '짧은' 라벨만(x축 숫자·축 제목).
    - 위: 바로 위 above_pad 이내 + 가로로 겹치는 '아주 짧은' 라벨만(y축 문자 p·y 등).
    캡션 블록(FIGURE/그림 …)과 본문 산문(긴 문장)은 항상 제외한다.
    other_regions(같은 페이지의 다른 그림 영역)를 침범하지 않는다 — 인접한 다중 패널
    (그림 2.8 (a)(b)(c) 등)이 서로를 삼켜 같은 그리드가 중복 렌더되던 회귀 방지."""
    try:
        blocks = page.get_text("blocks")
    except Exception:
        return reg
    cap_pat = re.compile(
        r"^\s*(FIG(?:URE)?|그림|Figure|Table|TABLE|표|SCHEME|Scheme)\.?\s*[\dIVXP]",
        re.I,
    )

    def _is_prose(oneline, nlines):
        # 본문 문단 판정(여백 배치 그림 옆 본문 포함). 단어 수를 함께 봐서 '다단 수식
        # 라벨'(분수 스택처럼 여러 줄이지만 단어가 적음)을 본문으로 오인하지 않는다.
        letters = sum(1 for c in oneline if c.isalpha())
        words = len(re.findall(r"[A-Za-z][A-Za-z]+|[가-힣]{2,}", oneline))
        return (
            (letters >= 55 and words >= 9)  # 긴 한 줄 문단
            or (nlines >= 3 and words >= 10)  # 여러 줄 문단(수식 스택은 단어가 적어 제외)
            or (nlines >= 2 and words >= 14)  # 빽빽한 2줄 문단
        )

    # 본문 산문 블록 목록 — 확장이 이 블록과 겹치면 그 라벨은 병합하지 않는다(여백 그림
    # 옆 본문·수식을 이미지에 굽지 않기 위한 핵심 가드). 캡션은 산문에서 제외(짧고 별도 번역).
    prose_rects = []
    for b in blocks:
        if len(b) < 5:
            continue
        txt = (b[4] or "").strip()
        if not txt:
            continue
        oneline = " ".join(txt.split())
        if cap_pat.search(oneline[:40]):
            continue
        nlines = txt.count("\n") + 1
        if _is_prose(oneline, nlines):
            prose_rects.append(fitz.Rect(b[0], b[1], b[2], b[3]))

    def _hits_prose(rect):
        for pr_ in prose_rects:
            if rect.intersects(pr_):
                return True
        return False

    # 다른 그림 영역(살짝 수축시켜 경계 접촉은 허용)과 겹침 판정 — 다중 패널 상호 잠식 방지.
    others = []
    others_full = []
    for o in other_regions or []:
        if abs(o.x0 - reg.x0) < 0.5 and abs(o.y0 - reg.y0) < 0.5 and abs(o.x1 - reg.x1) < 0.5:
            continue  # 자기 자신
        others.append(fitz.Rect(o.x0 + 3, o.y0 + 3, o.x1 - 3, o.y1 - 3))
        others_full.append(fitz.Rect(o))

    def _hits_other(rect):
        for o in others:
            if not o.is_empty and rect.intersects(o):
                return True
        return False

    def _edge_dist(rect, box):
        dx = max(box.x0 - rect.x1, rect.x0 - box.x1, 0.0)
        dy = max(box.y0 - rect.y1, rect.y0 - box.y1, 0.0)
        return (dx * dx + dy * dy) ** 0.5

    def _owned_by_other(br_):
        # 라벨(축 숫자·화살표 이름 등)은 '가장 가까운 그림'의 것 — 다른 그림에 더 가까우면
        # 이 그림 크롭에 넣지 않는다(인접 그림의 →x·y 축 라벨이 옆 그림에 딸려오는 것 방지).
        if not others_full:
            return False
        d_self = _edge_dist(br_, reg)
        for o in others_full:
            if _edge_dist(br_, o) < d_self - 0.5:
                return True
        return False

    grown = fitz.Rect(reg)
    for b in blocks:
        if len(b) < 5:
            continue
        txt = (b[4] or "").strip()
        if not txt:
            continue
        br = fitz.Rect(b[0], b[1], b[2], b[3])
        oneline = " ".join(txt.split())
        # 캡션·본문 산문 제외.
        if cap_pat.search(oneline[:40]):
            continue
        nlines = txt.count("\n") + 1
        if _is_prose(oneline, nlines):
            continue
        short = len(oneline) <= 18
        vert_overlap = br.y0 < reg.y1 - 2 and br.y1 > reg.y0 + 2
        horiz_overlap = br.x0 < reg.x1 - 2 and br.x1 > reg.x0 + 2
        include = False
        if vert_overlap and br.x1 >= reg.x0 - side_margin and br.x0 <= reg.x1 + side_margin:
            include = True  # (1) 좌/우 옆 라벨 — 축 숫자·곡선/화살표 이름
        elif horiz_overlap and 0 <= br.y0 - reg.y1 <= below_pad and short:
            include = True  # (2) 바로 아래 x축 숫자·축 제목(짧은 것만)
        elif horiz_overlap and 0 <= reg.y0 - br.y1 <= above_pad and len(oneline) <= 6:
            include = True  # (3) 바로 위 축 문자(p·y 등, 아주 짧은 것만)
        if not include:
            continue
        # 라벨 자체가 다른 그림 영역 안에 있거나, 다른 그림에 더 가까우면(그 그림의 라벨) 스킵.
        if _hits_other(br) or _owned_by_other(br):
            continue
        # 이 라벨을 넣었을 때 확장 영역이 본문 산문이나 다른 그림 영역과 겹치면 스킵
        # (여백 그림 옆 본문 보호 + 인접 다중 패널 상호 잠식 방지).
        tentative = fitz.Rect(grown) | br
        if _hits_prose(tentative) or _hits_other(tentative):
            continue
        grown = tentative
    # 폭주 안전장치: 세로(위/아래 = 본문·캡션 방향)는 좁게 클립하고, 가로(옆 = 여백·거터
    # 방향, 본문 잠식 위험 낮음)는 넉넉히 둔다 — 세로로 겹치는 넓은 라벨(예: 접선 기울기
    # 식)이 오른쪽으로 길어도 온전히 담기게. 페이지 밖 클립은 호출부(cmd_figures)가 한다.
    safe = fitz.Rect(
        reg.x0 - side_margin - 150,
        reg.y0 - above_pad - 4,
        reg.x1 + side_margin + 150,
        reg.y1 + below_pad + 6,
    )
    grown = grown & safe
    return grown if not grown.is_empty else fitz.Rect(reg)


def _merge_panel_rows(regions, page):
    """가로로 나란한 패널들((a)(b)(c) 다중 패널 그림처럼 세로로 겹치고 가로 간격이 좁은
    그림 영역)을 하나의 그림으로 병합한다. 이렇게 해야 재조판본에서 원본처럼 '옆으로'
    배치되고(세로 스택 방지), 모델이 어느 패널을 어디 두는지 헷갈릴 일도 없다.
    독립된 그림 2개가 우연히 같은 높이에 있어도(간격이 크면) 병합하지 않는다."""
    W = page.rect.width
    rects = [fitz.Rect(r) for r in regions]
    used = [False] * len(rects)
    merged = []
    # 패널 사이 간격은 좁다(축 라벨 한 칸 정도). 컬럼 거터(~50pt+)를 패널 간격으로
    # 오인해 다른 단의 그림까지 병합하지 않도록 상한을 40pt 로 좁게 잡는다.
    max_gap = 40.0
    for i in range(len(rects)):
        if used[i]:
            continue
        grp = fitz.Rect(rects[i])
        used[i] = True
        changed = True
        while changed:
            changed = False
            for j in range(len(rects)):
                if used[j]:
                    continue
                s = rects[j]
                yov = min(grp.y1, s.y1) - max(grp.y0, s.y0)
                minh = min(grp.height, s.height)
                maxh = max(grp.height, s.height)
                gapx = max(s.x0 - grp.x1, grp.x0 - s.x1)  # 겹치면 음수
                # 같은 패널 행 조건: (1) 세로로 60%+ 겹침, (2) 가로 간격이 좁음,
                # (3) 두 영역의 높이가 비슷함(패널은 크기가 유사; 여백의 작은 그림이
                # 큰 그림에 딸려가는 것 방지), (4) 병합 결과가 페이지 폭을 거의 다
                # 덮지 않음(과병합 방지).
                if (
                    yov > 0.6 * minh
                    and gapx < max_gap
                    and minh > 0.55 * maxh
                ):
                    cand = grp | s
                    if cand.width < 0.94 * W:
                        grp = cand
                        used[j] = True
                        changed = True
        merged.append(grp)
    return merged


def _figure_anchor(tblocks, reg, page):
    """그림이 '어느 문항/문단'에 속하는지 알려주는 텍스트 앵커를 만든다 — 그래프가 많은
    연습문제 페이지에서 모델이 비슷한 그래프를 엉뚱한 문항에 배치하는 것을 막기 위함.
    그림 바로 위(같은 단 안)에서 가장 가까운 본문 블록의 앞부분을 앵커로 쓴다.
    문항 번호(예: '19.')가 있으면 특히 강한 단서가 된다."""
    W = page.rect.width
    cx = (reg.x0 + reg.x1) / 2.0
    best = None
    best_dy = 1e9
    for b in tblocks:
        if len(b) < 5:
            continue
        x0, y0, x1, y1 = b[0], b[1], b[2], b[3]
        txt = " ".join((b[4] or "").split())
        if len(txt) < 4:
            continue
        # 같은 단(가로로 그림과 겹치거나 그림 중심을 포함) + 그림 위에 있는 블록.
        horiz = x0 <= cx + 20 and x1 >= cx - 20
        if not horiz:
            continue
        dy = reg.y0 - y1  # 그림 위: 양수
        if dy < -6 or dy > 220:
            continue
        if dy < best_dy:
            best_dy = dy
            best = txt
    if not best:
        return ""
    # 문항 번호가 있으면 그것부터, 없으면 앞부분 60자.
    m = re.match(r"\s*(\d{1,3})[.)]", best)
    snippet = best[:70]
    return snippet


def _branding_image_xrefs(doc, sample_cap=60):
    """여러 페이지의 헤더/푸터 자리에 반복 등장하는 이미지의 xref 집합 — 로고·워터마크·
    브랜딩. 이런 이미지는 '그림'이 아니라 페이지 장식이므로 그림 추출에서 제외한다.
    xref 로 식별하므로, 같은 로고가 본문 중간에 '깨진 그림 대체'로 박혀도(예: LibreTexts
    가 누락 그림을 로고로 대체) 함께 걸러낸다.
    판정: 상단 18% 또는 하단 12% 띠 안에 나온 이미지 xref 가 3쪽 이상 & 표본의 40% 이상."""
    n = len(doc)
    if n < 3:
        return set()
    idxs = list(range(n)) if n <= sample_cap else sorted(
        {round(i * (n - 1) / (sample_cap - 1)) for i in range(sample_cap)}
    )
    from collections import defaultdict

    counts = defaultdict(int)
    for pi in idxs:
        pg = doc[pi]
        H = pg.rect.height or 1.0
        top_band = pg.rect.y0 + 0.18 * H
        bot_band = pg.rect.y1 - 0.12 * H
        seen = set()
        try:
            for im in pg.get_images(full=True):
                xref = im[0]
                in_band = False
                for r in pg.get_image_rects(xref):
                    rr = fitz.Rect(r)
                    if rr.y1 <= top_band or rr.y0 >= bot_band:
                        in_band = True
                        break
                if in_band and xref not in seen:
                    seen.add(xref)
                    counts[xref] += 1
        except Exception:
            pass
    thresh = max(3, int(0.4 * len(idxs)))
    return {x for x, c in counts.items() if c >= thresh}


def _branding_rects_on_page(page, branding_xrefs):
    """이 페이지에서 브랜딩 xref 이미지가 차지하는 모든 bbox(헤더/푸터든 본문이든)."""
    out = []
    if not branding_xrefs:
        return out
    try:
        for im in page.get_images(full=True):
            if im[0] in branding_xrefs:
                for r in page.get_image_rects(im[0]):
                    out.append(fitz.Rect(r))
    except Exception:
        pass
    return out


def cmd_figures(pdf_path, out_dir, zoom=3.0, max_figures=80):
    """텍스트 PDF 의 그림/도표 영역을 PNG 로 잘라 out_dir 에 저장하고 메타데이터를 낸다.
    재조판(re-typeset) 시 원본 그림을 \\includegraphics 로 복원하기 위한 입력.
    번호는 페이지 순·세로 위→아래 순으로 매겨 Claude 마커 순서와 맞춘다."""
    try:
        zoom = float(zoom)
    except Exception:
        zoom = 3.0
    zoom = max(1.5, min(5.0, zoom))
    try:
        max_figures = int(max_figures)
    except Exception:
        max_figures = 80
    max_figures = max(1, min(500, max_figures))
    doc = fitz.open(pdf_path)
    os.makedirs(out_dir, exist_ok=True)
    # 여러 페이지 헤더/푸터에 반복되는 로고·워터마크 이미지 xref(그림 아님) → 제외.
    branding_xrefs = _branding_image_xrefs(doc)
    figs_out = []
    candidate_ids = []
    discovered_ids = []
    emitted_ids = []
    truncated_ids = []
    failed_ids = []
    failures = []

    def _record_failure(occurrence_id, reason, exc=None):
        failed_ids.append(occurrence_id)
        item = {"id": occurrence_id, "reason": reason}
        if exc is not None:
            item["detail"] = str(exc)[:160]
        failures.append(item)

    for pno in range(len(doc)):
        page = doc[pno]
        regs = _figure_regions(page)
        if not regs:
            continue
        # 브랜딩 로고 이미지와 대부분 겹치는 region 은 그림이 아니므로 버린다(본문 중간에
        # 박힌 로고 = 깨진 그림 대체 포함).
        brand_rects = _branding_rects_on_page(page, branding_xrefs)
        if brand_rects:
            def _is_branding(r):
                rr = fitz.Rect(r)
                area = abs(rr) or 1.0
                for b in brand_rects:
                    inter = fitz.Rect(rr) & b
                    if not inter.is_empty and abs(inter) >= 0.6 * area:
                        return True
                return False

            regs = [r for r in regs if not _is_branding(r)]
            if not regs:
                continue
        # 가로로 나란한 패널((a)(b)(c) 등)을 한 그림으로 병합 → 원본처럼 옆으로 배치.
        regs = _merge_panel_rows(regs, page)
        regs = sorted(regs, key=lambda r: (round(r.y0, 1), round(r.x0, 1)))
        occurrences = []
        for reg_index, reg in enumerate(regs):
            occurrence_id = f"p{pno + 1}-r{reg_index + 1}"
            candidate_ids.append(occurrence_id)
            occurrences.append((occurrence_id, reg))
        try:
            tblocks = page.get_text("blocks")
        except Exception:
            tblocks = []
        mat = fitz.Matrix(zoom, zoom)
        pr = page.rect
        pgH = pr.height or 1.0
        pgW = pr.width or 1.0
        for occurrence_id, reg in occurrences:
            if reg.width < 45 or reg.height < 45:
                continue  # 너무 작음(아이콘·기호 조각) → 그림으로 보지 않음
            # 페이지 최상단 여백의 작은 영역 = 로고/헤더 장식(벡터 로고 포함) → 그림 아님.
            # 실제 그림은 상단 6% 여백에서 시작하지 않는다(제목·헤더 자리). 보수적으로 작은
            # 것만 제외(넓거나 큰 상단 배너형 그림은 유지).
            if (
                reg.y0 - pr.y0 < 0.06 * pgH
                and reg.height < 0.12 * pgH
                and reg.width < 0.5 * pgW
            ):
                continue
            discovered_ids.append(occurrence_id)
            # 상한 이후도 모든 페이지의 후보를 계속 조사해 잘린 occurrence ID를 남긴다.
            # 예전처럼 즉시 break하면 '상한에 걸렸는지'조차 호출부가 알 수 없었다.
            if len(figs_out) >= max_figures:
                truncated_ids.append(occurrence_id)
                continue
            # 벡터 드로잉 밖의 축 눈금 숫자·곡선 라벨·축 제목까지 크롭에 포함(잘림 방지).
            # 같은 페이지의 다른 그림 영역(regs)은 침범 금지 — 인접 다중 패널 상호 잠식 방지.
            reg2 = _expand_region_with_labels(page, reg, other_regions=regs)
            # 화살촉 등 미세 잘림 방지용 소폭 여백을 더하되, 페이지 밖으로 안 나가게.
            pad = 5.0
            rr = fitz.Rect(
                max(pr.x0, reg2.x0 - pad),
                max(pr.y0, reg2.y0 - pad),
                min(pr.x1, reg2.x1 + pad),
                min(pr.y1, reg2.y1 + pad),
            )
            if rr.is_empty or rr.width <= 0 or rr.height <= 0:
                _record_failure(occurrence_id, "invalid_crop_rect")
                continue
            if not _pixmap_geometry_is_safe(rr, zoom):
                _record_failure(occurrence_id, "crop_resource_limit")
                continue
            try:
                pix = page.get_pixmap(matrix=mat, clip=rr, alpha=False)
            except Exception as exc:
                _record_failure(occurrence_id, "pixmap_failed", exc)
                continue
            if pix.width < 12 or pix.height < 12:
                _record_failure(occurrence_id, "crop_pixels_too_small")
                continue
            n = len(figs_out) + 1
            fname = os.path.join(out_dir, f"fig-{n}.png")
            try:
                pix.save(fname)
            except Exception as exc:
                try:
                    if os.path.exists(fname):
                        os.remove(fname)
                except Exception:
                    pass
                _record_failure(occurrence_id, "crop_save_failed", exc)
                continue
            emitted_ids.append(occurrence_id)
            figs_out.append(
                {
                    "id": occurrence_id,
                    "n": n,
                    "page": pno + 1,
                    "bbox": [
                        round(reg.x0, 1),
                        round(reg.y0, 1),
                        round(reg.x1, 1),
                        round(reg.y1, 1),
                    ],
                    "caption": _figure_caption(tblocks, reg),
                    "anchor": _figure_anchor(tblocks, reg, page),
                    "file": os.path.abspath(fname),
                    "w": pix.width,
                    "h": pix.height,
                }
            )
    emitted_set = set(emitted_ids)
    unresolved = [fid for fid in discovered_ids if fid not in emitted_set]
    manifest = {
        "complete": (
            not truncated_ids
            and not failed_ids
            and not unresolved
            and len(emitted_ids) == len(discovered_ids)
        ),
        "candidate_ids": candidate_ids,
        "discovered_ids": discovered_ids,
        "emitted_ids": emitted_ids,
        "truncated_ids": truncated_ids,
        "failed_ids": failed_ids,
        "failures": failures,
        "max_figures": max_figures,
        "counts": {
            "candidate": len(candidate_ids),
            "discovered": len(discovered_ids),
            "emitted": len(emitted_ids),
            "truncated": len(truncated_ids),
            "failed": len(failed_ids),
        },
    }
    write_json_response(
        {"page_count": len(doc), "figures": figs_out, "figure_manifest": manifest}
    )
    doc.close()


def _page_dictionary_static_signature(doc):
    """Snapshot every source page key except translated content/resources.

    This comparison runs inside one open document, before xref garbage collection,
    so raw reference equality is meaningful and covers standard plus custom keys.
    """
    signatures = []
    for page_number in range(len(doc)):
        page_xref = int(doc.page_xref(page_number))
        keys = sorted(
            key
            for key in (doc.xref_get_keys(page_xref) or ())
            if key not in {"Contents", "Resources"}
        )
        signatures.append(
            tuple((key, doc.xref_get_key(page_xref, key)) for key in keys)
        )
    return tuple(signatures)


def _merge_parts_into_source_page_objects(
    source_pdf, parts, translations, part_manifest
):
    """Replace source page dictionaries while retaining source page object identity.

    Outline destinations often point directly at page object xrefs.  Appending parts
    to a blank PDF and rebuilding a TOC changes those references and can also
    normalize /Fit* or /XYZ arguments, collapse state, color and style.  Instead we
    append the translated pages to the source document, copy each appended page
    dictionary onto the corresponding *existing* source page xref, then delete the
    appended page-tree entries.  The outline objects and their target page objects
    therefore never move.

    Sanitized source annotations are retained deliberately.  Split chunks cannot
    represent a cross-chunk GoTo target and their annotations may point at temporary
    appended page xrefs.  The source annotations have the original page identity,
    exact destination mode/arguments and valid non-link /P references.  Unsafe link
    actions are removed before this preservation step.
    """
    dst = fitz.open(source_pdf)
    try:
        source_page_count = len(dst)
        if source_page_count <= 0:
            raise RuntimeError("merge source PDF has no pages")

        virtual_blocks, virtual_translations = _resolve_virtual_translations(
            dst, translations
        )
        source_outline = _outline_signature(dst)
        source_metadata = dict(dst.metadata or {})
        source_geometry = _page_geometry_signature(dst)
        unsafe_links_removed = _remove_unsafe_links(dst)
        safe_links = _capture_safe_links(dst)
        source_page_xrefs = [int(dst.page_xref(index)) for index in range(len(dst))]
        source_page_static = _page_dictionary_static_signature(dst)

        _validate_part_manifest(parts, part_manifest, source_page_count)
        total = source_page_count

        for part_path in parts:
            part = fitz.open(part_path)
            try:
                dst.insert_pdf(part)
            finally:
                part.close()

        appended_page_xrefs = [
            int(dst.page_xref(source_page_count + index)) for index in range(total)
        ]
        if len(appended_page_xrefs) != len(source_page_xrefs):
            raise RuntimeError("merge appended page mapping is incomplete")

        for translated_xref, source_xref in zip(
            appended_page_xrefs, source_page_xrefs
        ):
            # Preserve the complete source page dictionary and its original object
            # identity.  Only the translated page's content streams and resource
            # dictionary are grafted in; /Tabs, /Dur, /Trans, /StructParents,
            # page-level metadata, custom keys and sanitized /Annots stay untouched.
            for key in ("Contents", "Resources"):
                _value_type, raw_value = dst.xref_get_key(translated_xref, key)
                dst.xref_set_key(source_xref, key, raw_value)

        dst.delete_pages(source_page_count, source_page_count + total - 1)
        if len(dst) != source_page_count:
            raise RuntimeError("merge failed to remove temporary appended pages")
        if _page_dictionary_static_signature(dst) != source_page_static:
            raise RuntimeError("merge changed a preserved source page dictionary key")
        if _page_geometry_signature(dst) != source_geometry:
            raise RuntimeError("merge changed PDF page geometry")
        if _capture_safe_links(dst) != safe_links:
            # List order is deterministic by page/annotation order here.  The saved
            # validation below additionally compares a multiset signature.
            raise RuntimeError("merge changed source safe-link navigation semantics")
        if _remove_unsafe_links(dst):
            raise RuntimeError("merge introduced an unsafe link action")

        virtual_stats = _apply_virtual_translations(
            dst,
            virtual_blocks,
            virtual_translations,
            source_outline,
            source_metadata,
        )
        return {
            "doc": dst,
            "page_count": source_page_count,
            "safe_links": safe_links,
            "page_geometry": source_geometry,
            "virtual_blocks": virtual_blocks,
            "virtual_stats": virtual_stats,
            "unsafe_links_removed": unsafe_links_removed,
        }
    except Exception:
        dst.close()
        raise


def cmd_merge(out_path, *parts):
    """여러 sub-PDF 를 인자 순서대로 이어붙여 하나의 PDF 로 저장한다.

    stdin에 ``source_pdf``와 virtual ``translations``가 오면 대용량 번역의
    정식 경로다. 이 경우 원본 page xref/목차/문서정보를 명시적으로
    복원하고, 저장된 파일을 다시 열어 목차 목적지·Fit/XYZ 인수·스타일·
    metadata·링크·페이지 기하가 모두 일치할 때만 out_path로 원자적 교체한다.
    """
    if not parts:
        raise ValueError("merge: 합칠 PDF 경로가 없습니다.")
    payload = json.loads(sys.stdin.read() or "{}")
    if not isinstance(payload, dict):
        raise ValueError("merge payload must be a JSON object")
    source_pdf = payload.get("source_pdf")
    translations = payload.get("translations", {}) or {}
    part_manifest = payload.get("part_manifest")
    if translations is not None and not isinstance(translations, dict):
        raise ValueError("merge translations must be a JSON object")

    # Legacy append-only mode remains for internal callers that do not request
    # source-structure restoration.  Production large-PDF translation always sends
    # source_pdf and rejects structure_restored=false in Node.
    if not source_pdf:
        dst = fitz.open()
        total = 0
        try:
            for part_path in parts:
                part = fitz.open(part_path)
                try:
                    dst.insert_pdf(part)
                    total += len(part)
                finally:
                    part.close()
            dst.save(out_path, garbage=3, deflate=True)
        finally:
            dst.close()
        write_json_response(
            {
                "ok": True,
                "page_count": total,
                "parts": len(parts),
                "structure_restored": False,
                "virtual_replaced": 0,
            }
        )
        return

    if not os.path.isfile(source_pdf):
        raise ValueError("merge source_pdf does not exist")

    result = _merge_parts_into_source_page_objects(
        source_pdf, parts, translations, part_manifest
    )
    dst = result["doc"]
    virtual_stats = result["virtual_stats"]
    virtual_blocks = result["virtual_blocks"]
    temp_path = f"{out_path}.partial-{os.getpid()}-{os.urandom(6).hex()}"
    try:
        dst.save(temp_path, garbage=3, deflate=True)
        dst.close()
        _verify_saved_pdf_structure(
            temp_path,
            result["safe_links"],
            result["page_geometry"],
            virtual_stats["expected_outline"],
            virtual_stats["expected_metadata"],
        )
        os.replace(temp_path, out_path)
    except Exception:
        try:
            dst.close()
        except Exception:
            pass
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise

    outline_expected = sum(
        1 for block in virtual_blocks if block.get("kind") == "outline"
    )
    metadata_expected = sum(
        1 for block in virtual_blocks if block.get("kind") == "metadata"
    )
    virtual_replaced = (
        virtual_stats["outline_replaced"] + virtual_stats["metadata_replaced"]
    )
    write_json_response(
        {
            "ok": True,
            "page_count": result["page_count"],
            "parts": len(parts),
            "structure_restored": True,
            "outline_items": len(virtual_stats["expected_outline"]),
            "outline_expected": outline_expected,
            "outline_replaced": virtual_stats["outline_replaced"],
            "metadata_expected": metadata_expected,
            "metadata_replaced": virtual_stats["metadata_replaced"],
            "virtual_replaced": virtual_replaced,
            "restored_links": len(result["safe_links"]),
            "unsafe_links_removed": result["unsafe_links_removed"],
        }
    )


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: translate_pdf.py extract|render ...\n")
        sys.exit(2)
    mode = sys.argv[1]
    try:
        if mode == "extract":
            cmd_extract(sys.argv[2])
        elif mode == "analyze":
            cmd_analyze(sys.argv[2])
        elif mode == "pagetext":
            # pagetext <pdf> [max_chars_per_page] — 숨은 OCR 텍스트층 페이지별 덤프(비전 힌트용)
            cmd_pagetext(*sys.argv[2:4])
        elif mode == "rasterize":
            # rasterize <pdf> <out_dir> [long_edge_px] [max_pages]
            cmd_rasterize(*sys.argv[2:6])
        elif mode == "render":
            cmd_render(sys.argv[2], sys.argv[3], sys.argv[4])
        elif mode == "split":
            # split <pdf> <out_dir> [pages_per_chunk]
            cmd_split(*sys.argv[2:5])
        elif mode == "figures":
            # figures <pdf> <out_dir> [zoom] [max_figures] — 재조판 그림 복원용 크롭 추출
            cmd_figures(*sys.argv[2:6])
        elif mode == "merge":
            # merge <out_pdf> <part1> <part2> ... — 병렬 번역한 구간들을 순서대로 합치기
            cmd_merge(sys.argv[2], *sys.argv[3:])
        else:
            sys.stderr.write(f"unknown mode: {mode}\n")
            sys.exit(2)
    except Exception as e:  # noqa: BLE001 — Node 에 stderr 로 원인 전달
        sys.stderr.write(f"{type(e).__name__}: {e}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
