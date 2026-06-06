#!/usr/bin/env python3
"""PDF 통번역기 — 레이아웃/그림은 유지하고 텍스트만 교체한다.

DeepL 문서 번역과 같은 방식: 디지털 PDF(텍스트 레이어가 있는 PDF)에서 문단
단위로 텍스트를 추출하고, 같은 위치(bounding box)에 번역문을 다시 끼워넣는다.
그림·도표·벡터 그래픽은 손대지 않으므로 그대로 보존된다.

두 가지 모드로 동작한다 (Node가 두 번 spawn 한다):

  python translate_pdf.py extract <pdf_path>
      → stdout JSON: {"page_count": N, "scanned": bool,
                      "blocks": [{"id": int, "page": int, "text": str}, ...]}
      번역이 필요한 문단만 내보낸다. Node가 이걸 Claude로 번역한다.

  python translate_pdf.py render <pdf_path> <out_path> <font_path>
      ← stdin JSON: {"translations": {"<id>": "<korean text>", ...}}
      → out_path 에 번역된 PDF 저장
      → stdout JSON: {"ok": true, "replaced": int, "shrunk": int}

블록 id는 두 모드에서 동일한 순서로 매겨진다(같은 파일 → 같은 get_text 순서).
그래서 extract가 부여한 id를 render가 그대로 다시 계산해 매칭할 수 있다.
"""

import sys
import os
import re
import json
import math
import html
from collections import defaultdict

import fitz  # PyMuPDF


def _clean_ko(s):
    """모델 번역 출력 정리 — HTML 엔티티 복원(&gt;→>, &lt;→<, &amp;→&, &#176;→°).
    모델이 분수/부등호를 '±h&gt;2π'처럼 엔티티로 내보내 raw 로 보이던 문제 수정."""
    s = str(s)
    if "&" in s:
        try:
            s = html.unescape(s)
        except Exception:
            pass
    return s


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
            and 0 < len(txt) <= 2
            and (sp.get("size", 99) or 99) < 9.0  # 본문보다 작은 위/아래첨자
            and all(c.isdigit() or c in "+-−" for c in txt)
        )
        (frags if is_frag else out).append(b)
    if not frags:
        return blocks
    for frag in frags:
        fr = fitz.Rect(frag["bbox"])
        fcx, fcy = (fr.x0 + fr.x1) / 2, (fr.y0 + fr.y1) / 2
        host = None
        for h in out:
            hr = fitz.Rect(h["bbox"])
            if hr.y0 - 3 <= fcy <= hr.y1 + 3 and hr.x0 - 8 <= fcx <= hr.x1 + 8:
                host = h
                break
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
        for fsp in [s for fl in frag.get("lines", []) for s in fl.get("spans", [])]:
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
        host["bbox"] = list(fitz.Rect(host["bbox"]) | fr)
    return out


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
        # 둘 다 본문 산문(본문 크기 단어 보유)이어야 — 수식·짧은 라벨은 병합 제외.
        if not (_has_word(prev) and _has_word(blk)):
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
        if not _ends_midsentence(_block_raw_text(prev)):
            out.append(blk)
            continue
        # 새 블록이 '절 번호'(6.3, 6.13 등)나 챕터 목차 항목으로 시작하면 병합 안 함
        # — 목차(TOC) 항목들이 한 줄로 뭉쳐 'X.Y 제목 X.Z 제목 …'처럼 섞이는 것 방지.
        if re.match(r"\s*\d+\.\d+(\s|$)", _block_raw_text(blk)):
            out.append(blk)
            continue
        # 병합: 줄 이어붙이고 bbox 합침(prev 는 out[-1] 과 동일 객체 → 제자리 갱신).
        prev["lines"] = prev.get("lines", []) + blk.get("lines", [])
        prev["bbox"] = [
            min(ra.x0, rb.x0), min(ra.y0, rb.y0),
            max(ra.x1, rb.x1), max(ra.y1, rb.y1),
        ]
    return out


def iter_text_blocks(doc):
    """type=0(텍스트) 블록을 두 모드에서 동일한 순서/id로 순회한다.

    span 이 없는 빈 블록과 이미지 블록(type=1)은 건너뛰되, id 카운터는
    '텍스트 블록'에 대해서만 증가시켜 extract/render 간 id 가 일치하게 한다.
    위첨자 전하 분리 블록은 병합하고(_merge_superscript_ions), 문장 중간에서 끊긴
    인접 본문 띠도 한 문단으로 합친다(_coalesce_paragraphs). 모두 extract/render
    동일 로직 → id 일치 유지.
    """
    bid = 0
    for pno in range(len(doc)):
        page = doc[pno]
        data = page.get_text("dict")
        text_blocks = [
            b
            for b in data.get("blocks", [])
            if b.get("type") == 0 and any(ln.get("spans") for ln in (b.get("lines") or []))
        ]
        merged = _absorb_tiny_fragments(_merge_superscript_ions(text_blocks))
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
)

# 디코더는 페이지별로 만든다 — 같은 수식폰트도 서브셋마다 인코딩이 달라(코드 33이
# ψ/θ/σ …) 문서 전역 매핑은 오작동한다. 페이지의 폰트(서브셋)만으로 매핑하면 그 페이지
# 본문은 정확히 복원된다. 같은 페이지에 충돌 서브셋이 여럿이면 가장 풍부한(=본문) 것을
# 우선한다(span→서브셋 식별은 PyMuPDF API 로 불가능 — 그림 라벨 등은 한계가 남음).
_DECODERS_BY_PAGE = {}  # {pno: {정규화폰트명: {코드: 유니코드}}}
_CUR_DEC = {}  # 현재 페이지 디코더


def _norm_font(n):
    return (n or "").split("+")[-1]  # 서브셋 접두사(ABCDEF+) 제거


def _use_page(pno):
    """추출 시 현재 페이지의 디코더를 활성화(_fix_span_text 가 참조)."""
    global _CUR_DEC
    _CUR_DEC = _DECODERS_BY_PAGE.get(pno, {})


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
    global _DECODERS_BY_PAGE
    _DECODERS_BY_PAGE = {}
    for pno in range(len(doc)):
        try:
            fonts = doc[pno].get_fonts(full=True)
        except Exception:
            _DECODERS_BY_PAGE[pno] = {}
            continue
        bysub = {}  # 정규화명 -> [cmap(code→글리프명), ...]
        for f in fonts:
            name = _norm_font(f[3] if len(f) > 3 else "")
            if not name:
                continue
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
        _DECODERS_BY_PAGE[pno] = page_dec
    return _DECODERS_BY_PAGE


def _fix_span_text(font, text):
    """깨진 글자를 실제 유니코드로 복원. 폰트 /Differences 디코더 우선,
    못 풀면 CM 정적맵 폴백. 일반 본문 폰트의 진짜 글자는 건드리지 않는다."""
    if not text:
        return text
    f = font or ""
    dec = _CUR_DEC.get(_norm_font(f))
    out = []
    for ch in text:
        # 기호 전용 서브셋 폰트(WWDOC…)는 디코더보다 우선해 강제 매핑(전하·별표).
        # 디코더가 'MacRomanEncoding' 항등으로 '1'→'1' 을 돌려주면 깨진 채 남기 때문.
        if "WWDOC01" in f and ch in _WWDOC01_FIX:
            out.append(_WWDOC01_FIX[ch])
            continue
        if "WWDOC06" in f and ch in _WWDOC06_FIX:
            out.append(_WWDOC06_FIX[ch])
            continue
        if dec is not None:
            u = dec.get(ord(ch))
            if u is not None:
                out.append(u)
                continue
        if "CMSY" in f:
            out.append(_CMSY_FIX.get(ch, ch))
        elif "CMEX" in f:
            out.append(_CMEX_FIX.get(ch, ch))
        elif "CMMI" in f:
            out.append(_CMMI_FIX.get(ch, ch))
        elif "MathTechnical" in f:
            out.append(_MATHTECH_FIX.get(ch, ch))
        else:
            out.append(ch)
    return "".join(out)


def _line_in_figs(line_bbox, figs):
    """줄(line)의 중심이 그림 영역(±18pt) 안이면 True.

    그래프 Y축 라벨 'V(R_AB)' 처럼, PyMuPDF 가 그림 위 텍스트를 캡션과 같은
    블록으로 묶어버리는 경우가 있다. 그런 줄을 가려내 번역·덮기에서 빼면
    축 라벨은 영어 그대로 그래프에 남고, 캡션만 깔끔히 번역된다.
    """
    if not figs:
        return False
    cx = (line_bbox[0] + line_bbox[2]) / 2.0
    cy = (line_bbox[1] + line_bbox[3]) / 2.0
    return any(
        (f.x0 - 18) <= cx <= (f.x1 + 18) and (f.y0 - 18) <= cy <= (f.y1 + 18)
        for f in figs
    )


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
    rows = []  # [{y0, y1, items:[{x, cy, sz, t}]}]
    for ln in block.get("lines", []):
        if _line_in_figs(ln.get("bbox", (0, 0, 0, 0)), figs):
            continue
        lb = ln.get("bbox", (0, 0, 0, 0))
        ly0, ly1 = lb[1], lb[3]
        items = []
        for sp in ln.get("spans", []):
            t = _fix_span_text(sp.get("font", ""), sp.get("text", ""))
            if t == "":
                continue
            b = sp.get("bbox", (lb[0], ly0, lb[0], ly1))
            items.append({"x": b[0], "cy": (b[1] + b[3]) / 2.0,
                          "sz": sp.get("size", 10.0) or 10.0, "t": t})
        if not items:
            continue
        placed = False
        for row in rows:
            oy = min(ly1, row["y1"]) - max(ly0, row["y0"])
            mh = max(1.0, min(ly1 - ly0, row["y1"] - row["y0"]))
            if oy > 0.5 * mh:  # 같은 시각적 줄(세로로 과반 겹침)
                row["items"].extend(items)
                row["y0"] = min(row["y0"], ly0)
                row["y1"] = max(row["y1"], ly1)
                placed = True
                break
        if not placed:
            rows.append({"y0": ly0, "y1": ly1, "items": list(items)})
    rows.sort(key=lambda r: r["y0"])
    out = []
    for row in rows:
        its = row["items"]
        if tag:
            main = max(i["sz"] for i in its)
            big = [i["cy"] for i in its if i["sz"] >= 0.85 * main]
            mcy = (sum(big) / len(big)) if big else its[0]["cy"]
            for i in its:
                i["style"] = "normal"
                if i["sz"] < 0.78 * main:  # 작은 글자 = 첨자 후보
                    if i["cy"] > mcy + 0.06 * main:
                        i["style"] = "sub"
                    elif i["cy"] < mcy - 0.06 * main:
                        i["style"] = "sup"
            # x 4pt 버킷 + (normal<sub<sup) 순 → 겹친 첨자도 H₂⁺ 순서로(stable sort).
            rank = {"normal": 0, "sub": 1, "sup": 2}
            its.sort(key=lambda i: (round(i["x"] / 4.0), rank[i["style"]]))
            s = ""
            for i in its:
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
    for ln in block.get("lines", []):
        if _line_in_figs(ln.get("bbox", (0, 0, 0, 0)), figs):
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
    if _is_stacked_math(block):
        return True  # 위아래로 쌓인 2D 수식(분수·루이스) → 원본 보존(x-정렬 불가)
    if _has_word(block):
        return False  # 본문 문장(인라인 수식 포함) → 번역
    has_math_font = False
    has_sign = False
    nchar = 0
    for ln in block.get("lines", []):
        for sp in ln.get("spans", []):
            fn = sp.get("font", "")
            txt = _fix_span_text(fn, sp.get("text", ""))  # 디코드 후 판정
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
            if fitz.Rect(cb.x0 - gap, cb.y0 - gap, cb.x1 + gap, cb.y1 + gap).intersects(r):
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
    figure 로 오인하지 않는다. 얇은 선(축 등)도 포함해야 그래프가 잡힌다."""
    elems = []
    try:
        for im in page.get_images(full=True):
            for r in page.get_image_rects(im[0]):
                elems.append(fitz.Rect(r))
    except Exception:
        pass
    try:
        for d in page.get_drawings():
            if "s" in (d.get("type") or ""):  # 윤곽선 path
                elems.append(fitz.Rect(d["rect"]))
    except Exception:
        pass
    page_area = page.rect.width * page.rect.height
    regions = []
    for c in _cluster_rects(elems):
        b = c["bbox"]
        if (
            c["n"] >= 4
            and b.width > 50
            and b.height > 50
            and b.width * b.height < 0.88 * page_area
        ):
            regions.append(b)
    return regions


def _table_regions(page, min_rules=2):
    """가로 rule(테두리 선)로 표 영역을 추정한다. PyMuPDF find_tables 가 못 잡는
    booktabs형(세로선 없이 가로줄만 있는) 표를 잡기 위함. 인접한(가로로 겹치고 가까운)
    가로줄 ≥2개가 만드는 세로 구간을 표로 본다 → in-place 가 표 셀을 줄글로 뭉개지
    않도록 그 영역 텍스트를 영어 원본 그대로 둔다(그림과 동일 취급)."""
    W = page.rect.width
    H = page.rect.height
    rules = []  # (x0, y, x1) 가로줄
    try:
        for dr in page.get_drawings():
            for it in dr.get("items", []):
                if it[0] == "l":  # line
                    p1, p2 = it[1], it[2]
                    if abs(p1.y - p2.y) < 1.6 and abs(p2.x - p1.x) > 0.22 * W:
                        rules.append(
                            (min(p1.x, p2.x), (p1.y + p2.y) / 2.0, max(p1.x, p2.x))
                        )
                elif it[0] == "re":  # 얇은 사각형 = 가로줄
                    r = fitz.Rect(it[1])
                    if r.height < 2.2 and r.width > 0.22 * W:
                        rules.append((r.x0, (r.y0 + r.y1) / 2.0, r.x1))
    except Exception:
        return []
    if len(rules) < min_rules:
        return []
    rules.sort(key=lambda t: t[1])
    # 가로로 겹치고 세로로 가까운(<230pt) 줄들을 한 표로 묶는다.
    groups = [[rules[0]]]
    for r in rules[1:]:
        prev = groups[-1][-1]
        ox = min(r[2], prev[2]) - max(r[0], prev[0])
        minw = max(1.0, min(r[2] - r[0], prev[2] - prev[0]))
        if ox > 0.5 * minw and (r[1] - prev[1]) < 230:
            groups[-1].append(r)
        else:
            groups.append([r])
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


def _skip_regions(page):
    """번역 제외 영역 = 그림/그래프 + 표. 두 경우 모두 영역 안 텍스트는 영어 원본 유지.
    단, 본문 산문을 삼키는 오검출 region 은 _validate_regions 가 걸러낸다(미번역 방지)."""
    return _validate_regions(page, _figure_regions(page) + _table_regions(page))


def cmd_extract(pdf_path):
    doc = fitz.open(pdf_path)
    build_decoders(doc)  # 폰트 /Differences 디코더(깨진 글자 복원) — 추출 전에 준비
    blocks = []
    total_text_chars = 0
    # 페이지별 figure 영역(이미지 + 그래프 라인아트) 캐시 — 그림 위 텍스트 판별용.
    page_cache = {}

    def regions(pno):
        if pno not in page_cache:
            page_cache[pno] = _skip_regions(doc[pno])  # 그림 + 표
        return page_cache[pno]

    # 표시수식 band 선계산 — 식 [6.1] 처럼 본체(= 든 수식 줄)는 원본유지(KEEP)되지만
    # 분자/첨자 조각(en·nn·0·A·B·r 등 Sabon 일반폰트, 수식기호 없음)은 KEEP 에 안
    # 걸려 번역·재그리기되어 흩어진다. 본체 줄의 y-band 안에 든 '단어 없는' 조각을
    # 같이 원본유지해 식 전체가 원본대로 보이게 한다.
    items = list(iter_text_blocks(doc))
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
    # 텍스트가 거의 없으면 스캔본(글자가 이미지)일 가능성이 높다 → Node가 안내.
    scanned = len(doc) > 0 and total_text_chars < 20 * len(doc)
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
    out = {
        "page_count": len(doc),
        "scanned": scanned,
        "blocks": blocks,
        "fig_regions": fig_regions,
        "table_regions": table_regions,
        "fitz": fitz_ver,
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
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


def cmd_analyze(pdf_path):
    """텍스트 레이어 유무 + 수식 밀도 + 2단 여부를 판정(자동 변환방식 선택용).
    scanned: 텍스트 레이어 없음(스캔/이미지). math_density: 1000자당 수식 지표 점수.
    two_column: 본문이 2단 레이아웃인지(재조판 시 2단 보존 + 읽기순서 보정용)."""
    doc = fitz.open(pdf_path)
    total = 0
    parts = []
    for page in doc:
        t = page.get_text("text") or ""
        total += len(t.strip())
        parts.append(t)
    text = "\n".join(parts)
    n = len(doc)
    scanned = n > 0 and total < 20 * n
    two_column = (not scanned) and _detect_two_column(doc)
    # 수식 지표: 그리스 문자(U+0370–03FF), 수학 기호, 위/아래 첨자(U+2070–209F), '=' 빈도
    greek = sum(1 for c in text if "Ͱ" <= c <= "Ͽ")
    syms = sum(1 for c in text if c in _MATH_SYMS)
    subsup = sum(1 for c in text if "⁰" <= c <= "₟")
    eqs = text.count("=")
    math_score = greek * 3 + syms * 3 + subsup * 2 + eqs
    density = round((math_score / max(total, 1)) * 1000, 2)
    sys.stdout.write(
        json.dumps(
            {
                "page_count": n,
                "text_chars": total,
                "scanned": scanned,
                "math_score": math_score,
                "math_density": density,
                "two_column": two_column,
            },
            ensure_ascii=False,
        )
    )
    doc.close()


def cmd_rasterize(pdf_path, out_dir, target_width_px=1400, max_pages=20):
    """각 페이지를 가독 가능한 PNG 타일로 렌더링한다(스캔본을 Claude 비전으로 읽히기 위함).

    핵심: 일부 PDF(문제집 등)는 한 페이지가 세로로 매우 길다(예: 958×11833). 이를 한 장
    이미지로 보내면 Claude 가 긴 변을 1568px 로 줄여 글자가 다시 뭉개진다. 그래서 폭을
    가독 해상도(≈target_width_px)로 맞춰 렌더하되, 세로로 긴 페이지는 페이지 모양 타일로
    잘라(겹침 포함) 각각 저장한다. clip 렌더라 거대한 픽스맵을 만들지 않는다."""
    target_width_px = int(target_width_px)
    max_pages = int(max_pages)
    tile_h_px = 1800       # 타일 1장의 최대 높이(px)
    overlap_px = 130       # 타일 경계에서 줄이 잘리지 않도록 겹침
    max_tiles_per_page = 30
    max_tiles_total = 100
    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    n = len(doc)
    rendered = min(n, max_pages)
    files = []
    truncated = n > rendered
    for i in range(rendered):
        if len(files) >= max_tiles_total:
            truncated = True
            break
        page = doc[i]
        rect = page.rect
        w_pt = rect.width or 612.0
        h_pt = rect.height or 792.0
        zoom = target_width_px / w_pt
        zoom = max(1.0, min(zoom, 4.0))
        mat = fitz.Matrix(zoom, zoom)
        tile_h_pt = tile_h_px / zoom
        overlap_pt = overlap_px / zoom
        # 타일 수를 먼저 정해 '균등 분할'한다 → 얇은 자투리(앞 타일과 중복) 방지.
        # 1.15 여유: 한 타일보다 조금 더 긴 페이지(일반 A4 등)는 자르지 않고 1장으로.
        n_tiles = max(1, int(-(-h_pt // (tile_h_pt * 1.15))))  # ceil
        n_tiles = min(n_tiles, max_tiles_per_page)
        seg_pt = h_pt / n_tiles
        for t in range(n_tiles):
            if len(files) >= max_tiles_total:
                truncated = True
                break
            y0 = max(0.0, seg_pt * t - overlap_pt / 2)
            y1 = min(h_pt, seg_pt * (t + 1) + overlap_pt / 2)
            clip = fitz.Rect(rect.x0, rect.y0 + y0, rect.x1, rect.y0 + y1)
            pix = page.get_pixmap(matrix=mat, clip=clip, alpha=False)
            out_path = os.path.join(out_dir, f"p-{i:03d}-{t:02d}.png")
            pix.save(out_path)
            files.append(out_path)
    sys.stdout.write(
        json.dumps(
            {
                "page_count": n,
                "rendered_pages": rendered,
                "tiles": len(files),
                "truncated": truncated,
                "target_width_px": target_width_px,
                "files": files,
            },
            ensure_ascii=False,
        )
    )
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
    if is_heading:
        # 헤딩: justify 금지. 좌우 여백이 거의 대칭이면 가운데, 그 외엔 왼쪽.
        if (
            w < 0.9 * page_width
            and left > 0.12 * page_width
            and abs(left - right) < 0.10 * page_width
        ):
            return fitz.TEXT_ALIGN_CENTER
        return fitz.TEXT_ALIGN_LEFT
    if (
        w < 0.62 * page_width
        and left > 0.15 * page_width
        and abs(left - right) < 0.06 * page_width
    ):
        return fitz.TEXT_ALIGN_CENTER
    # 좁은 칼럼(저자·소속·짧은 라벨; 본문 단보다 좁음)은 justify 하면 단어가 크게
    # 벌어진다('Google   Brain') → 가운데 정렬. 본문 단(2단≈0.4W, 1단≈0.7W)은 제외.
    if w < 0.30 * page_width:
        return fitz.TEXT_ALIGN_CENTER
    if single_line:
        return (
            fitz.TEXT_ALIGN_CENTER if w < 0.5 * page_width else fitz.TEXT_ALIGN_LEFT
        )
    return fitz.TEXT_ALIGN_JUSTIFY


def _has_leftover(ret):
    """TextWriter.fill_textbox 반환값(보통 leftover 리스트)에 '안 들어간 텍스트'가 있는지."""
    if not ret:
        return False
    if isinstance(ret, str):
        return bool(ret.strip())
    if isinstance(ret, (list, tuple)):
        return any(_has_leftover(x) for x in ret)
    return bool(ret)


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
        return False
    page_rect = page.rect
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
            tw = fitz.TextWriter(page_rect)
            leftover = tw.fill_textbox(r, text, font=font, fontsize=fs, align=align)
            return tw, leftover
        except (ValueError, RuntimeError):
            return None

    def _commit(tw):
        if morph is not None:
            try:
                tw.write_text(page, color=color, morph=morph)
                return
            except Exception:
                pass  # morph 실패 시 일반 그리기로 폴백
        tw.write_text(page, color=color)

    fs = max(min_size, min(float(start_size), 400.0))
    # 가독성 바닥: 본문(원본 9pt+)은 원래 크기의 62% 아래로는 줄이지 않는다 — '깨알
    # 글씨(4pt)' 방지. 1차로 [바닥..원래] 범위에서 다 들어가는 가장 큰 크기를 찾는다.
    floor = max(min_size, round(0.62 * float(start_size), 1)) if start_size >= 9.0 else min_size
    while fs >= floor:
        res = _try_fill(_expand(rect, fs), fs)
        if res is not None and not _has_leftover(res[1]):
            _commit(res[0])
            return fs < float(start_size) - 0.01
        fs -= 0.5
    # 바닥에서도 안 들어가면: 글자 잘림(내용 손실)이 깨알보다 나쁘므로 min_size 까지
    # 더 줄여 전부 담는다(이 경우는 F5 문단병합·F1 세로압축 후엔 드물다).
    fs = floor - 0.5
    while fs >= min_size:
        res = _try_fill(_expand(rect, fs), fs)
        if res is not None and not _has_leftover(res[1]):
            _commit(res[0])
            return True
        fs -= 0.5
    # 그래도 안 들어가면 들어가는 만큼이라도(예외 무시 → render 전체는 계속).
    res = _try_fill(_expand(rect, min_size), min_size)
    if res is not None:
        _commit(res[0])
    return True


_TAG_RE = re.compile(r"<(sub|sup)>(.*?)</\1>", re.DOTALL)
_STRIP_TAG_RE = re.compile(r"</?(?:sub|sup)>")


def _strip_tags(s):
    """<sub>/<sup> 태그만 제거하고 내용은 남긴다(폭·길이 계산용)."""
    return _STRIP_TAG_RE.sub("", s) if ("<sub>" in s or "<sup>" in s) else s


def _has_tags(s):
    return "<sub>" in s or "<sup>" in s


def _parse_richtext(s):
    """<sub>..</sub>/<sup>..</sup> 가 든 문자열을 (글자, style) 목록으로 분해.
    style ∈ {'normal','sub','sup'}. 태그 밖 < > & 는 그대로 글자로 둔다."""
    atoms = []
    pos = 0
    for m in _TAG_RE.finditer(s):
        for ch in s[pos:m.start()]:
            atoms.append((ch, "normal"))
        style = "sub" if m.group(1) == "sub" else "sup"
        for ch in m.group(2):
            atoms.append((ch, style))
        pos = m.end()
    for ch in s[pos:]:
        atoms.append((ch, "normal"))
    return atoms


def _draw_rich(page, rect, html_text, color, font, start_size, align,
               max_x=None, max_y=None, min_size=5.0):
    """위/아래첨자(<sub>/<sup>)가 든 번역문을 진짜 첨자로 그린다(첨자는 0.66배 크기 +
    baseline 이동). TextWriter 한 개를 공유해 그리므로 insert_htmlbox 같은 OOM 이 없다.
    좌/가운데 정렬 + 탐욕적 줄바꿈 + 넘치면 폰트 축소. (수식 줄은 양끝맞춤 안 함.)

    반환: 원래 크기보다 줄였으면 True."""
    rect = fitz.Rect(rect)
    rect.normalize()
    if rect.width < 4 or rect.height < 2:
        return False
    pr = page.rect
    right = max(rect.x1, max_x if max_x is not None else pr.x1 - 6)
    bottom = max(rect.y1, max_y if max_y is not None else pr.y1 - 6)
    atoms = _parse_richtext(html_text)
    if not atoms:
        return False
    centered = align == fitz.TEXT_ALIGN_CENTER
    avail_w = (rect.width if centered else (right - rect.x0)) - 1.0
    avail_w = max(8.0, avail_w)

    def cw(ch, sz):
        try:
            return font.text_length(ch, fontsize=sz)
        except Exception:
            return sz * 0.5

    # (글자,style) → 단어 단위로 묶기(공백 분리). 단어는 [(ch,style,size_factor)].
    def build_words():
        words, w = [], []
        for ch, st in atoms:
            if ch == " ":
                if w:
                    words.append(w)
                    w = []
                words.append([(" ", "normal")])
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
            wid = sum(cw(ch, fs * sub if st != "normal" else fs) for ch, st in word)
            is_space = len(word) == 1 and word[0][0] == " "
            if not is_space and cur and (x + wid) > rect.x0 + avail_w:
                lines.append(cur)
                cur = []
                x = rect.x0
                if is_space:
                    continue
            for ch, st in word:
                sz = fs * sub if st != "normal" else fs
                dy = 0.0
                if st == "sub":
                    dy = fs * 0.16
                elif st == "sup":
                    dy = -fs * 0.34
                cur.append((x, ch, sz, dy, st))
                x += cw(ch, sz)
        if cur:
            lines.append(cur)
        # 줄 끝 공백 트림 폭 계산 + 가운데 정렬 보정
        return lines, len(lines) * lh, lh

    fs = max(min_size, min(float(start_size), 200.0))
    floor = max(min_size, round(0.62 * float(start_size), 1)) if start_size >= 9.0 else min_size
    chosen = None
    while fs >= floor:
        lines, total_h, lh = layout(fs)
        if rect.y0 + total_h <= bottom + 0.5:
            chosen = (lines, lh, fs)
            break
        fs -= 0.5
    if chosen is None:
        # 바닥까지 줄여도 넘치면 바닥 크기로(잘려도 그림)
        fs = floor
        lines, total_h, lh = layout(fs)
        chosen = (lines, lh, fs)
    lines, lh, fs = chosen

    tw = fitz.TextWriter(pr)
    y = rect.y0 + fs
    for ln in lines:
        if not ln:
            y += lh
            continue
        # 가운데 정렬이면 줄 폭만큼 x 이동
        x_off = 0.0
        if centered:
            last = ln[-1]
            line_w = (last[0] + cw(last[1], last[2])) - ln[0][0]
            x_off = max(0.0, (avail_w - line_w) / 2.0)
        for (x, ch, sz, dy, st) in ln:
            if ch == " ":
                continue
            try:
                tw.append(fitz.Point(x + x_off, y + dy), ch, font=font, fontsize=sz)
            except Exception:
                pass
        y += lh
    try:
        tw.write_text(page, color=color)
    except Exception:
        pass
    return fs < float(start_size) - 0.01


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
    """redaction rect 에서 '원본유지' 블록(표시수식·라벨)과 겹치는 가로띠를 빼고,
    그 위/아래의 띠만 돌려준다. 번역 블록 bbox 가 인접 식을 세로로 덮어 그 식 글자가
    지워지는 드문 경우를 막는다(겹치는 식이 없으면 rect 하나 그대로)."""
    parts = [fitz.Rect(rect)]
    for k in keeps:
        nxt = []
        for r in parts:
            ox = min(r.x1, k.x1) - max(r.x0, k.x0)
            oy = min(r.y1, k.y1) - max(r.y0, k.y0)
            # 가로로 의미있게 겹치고 식이 rect 안쪽 띠를 차지할 때만 분리.
            if ox <= 0.2 * (r.x1 - r.x0) or oy <= 0:
                nxt.append(r)
                continue
            if k.y0 - r.y0 > 3:  # 식 위쪽 띠
                nxt.append(fitz.Rect(r.x0, r.y0, r.x1, k.y0 - 1))
            if r.y1 - k.y1 > 3:  # 식 아래쪽 띠
                nxt.append(fitz.Rect(r.x0, k.y1 + 1, r.x1, r.y1))
        parts = nxt
    return [p for p in parts if p.width > 2 and p.height > 2]


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
    items: [(rect, ko, size, color, bold, ital), ...] (dedoverlap 후). 반환 동일 형식.
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


def cmd_render(pdf_path, out_path, font_path):
    payload = json.loads(sys.stdin.read() or "{}")
    translations = payload.get("translations", {}) or {}

    doc = fitz.open(pdf_path)
    build_decoders(doc)  # 추출과 동일한 디코더 — 블록 텍스트/매칭 일관성 유지

    # 페이지별 그림 영역 캐시(추출과 동일 기준) — 축 라벨 줄을 덮기/그리기에서 뺀다.
    fig_cache = {}

    def figs_for(pno):
        if pno not in fig_cache:
            fig_cache[pno] = _skip_regions(doc[pno])  # 그림 + 표
        return fig_cache[pno]

    # 번역이 있는 블록만 (페이지별로) 모은다.
    by_page = defaultdict(list)
    kept_by_page = defaultdict(list)  # 원본유지(표시수식·라벨) rect — redaction 보호용
    static_by_page = defaultdict(list)  # 번역 안 된 모든 블록(수식·라벨·미번역) — 압축 앵커
    for bid, pno, block in iter_text_blocks(doc):
        ko = translations.get(str(bid))
        if ko is None:
            ko = translations.get(bid)
        if not ko or not str(ko).strip():
            # 번역 없는 블록은 원본이 그대로 남으므로(이동 불가) 세로압축의 '고정 앵커'다.
            r0 = fitz.Rect(_nonfig_rect(block, figs_for(pno)))
            static_by_page[pno].append(r0)
            if _keep_original_block(block):  # 식·라벨 위치를 기억해 redaction 이 안 지우게
                kept_by_page[pno].append(r0)
            continue
        # 블록 전체 bbox 가 아니라 '그림 영역 줄을 뺀' bbox 만 덮는다.
        # → 캡션에 붙은 축 라벨(V(R_AB))을 지우지 않고 영어 그대로 남긴다.
        rect = _nonfig_rect(block, figs_for(pno))
        size, color, is_bold, is_ital = dominant_size_color(block)
        by_page[pno].append((rect, _clean_ko(ko).strip(), size, color, is_bold, is_ital))

    # 폰트는 한 번만 로드해 모든 TextWriter 가 공유한다. (insert_htmlbox 는 호출마다
    # 2MB 폰트를 Story 에 재적재해 24쪽/수백 블록에서 ~1.5GB OOM 을 냈다.)
    font = fitz.Font(fontfile=font_path)
    _fdir = os.path.dirname(os.path.abspath(font_path))

    def _load_sibling(name):
        try:
            p = os.path.join(_fdir, name)
            if os.path.exists(p) and os.path.abspath(p) != os.path.abspath(font_path):
                return fitz.Font(fontfile=p)
        except Exception:
            pass
        return None

    # 볼드 글꼴(원문 굵게 → 번역본도 굵게). 없으면 본문 글꼴로 대체(graceful).
    font_bold = _load_sibling("Pretendard-Bold.ttf") or font
    # 폴백 글꼴: 주 글꼴에 없는 글리프(예: ∈)를 가진 블록은 그 블록만 NanumGothic 으로
    # 그려 '두부(□)'를 방지한다.
    font_fb = _load_sibling("NanumGothic-Regular.ttf")

    def _pick_font(text, base):
        """블록 글자를 가장 잘 렌더하는 글꼴 선택(base 우선, 빠진 글리프가 적은 쪽)."""
        if not font_fb:
            return base
        miss_b = sum(
            1 for c in set(text) if ord(c) > 0x7F and not base.has_glyph(ord(c))
        )
        if miss_b == 0:
            return base
        miss_f = sum(
            1 for c in set(text) if ord(c) > 0x7F and not font_fb.has_glyph(ord(c))
        )
        return font_fb if miss_f < miss_b else base

    replaced = 0
    shrunk = 0
    for pno, items in by_page.items():
        page = doc[pno]
        sample = _sample_pixmap(page)  # redaction 색 맞춤용(원본 배경 샘플)
        page_bg = _page_bg(sample)
        figs = figs_for(pno)  # 그림 영역 — 덮기/그리기를 이 밖으로 자른다(캐시 재사용).
        # 블록 rect 를 그림 밖으로 클리핑(완전히 그림 안이면 제외). → 그림 배경에 흰 자국
        # 안 생기고, 캡션에 붙은 축 라벨(V(RAB) 등)도 원본 그대로 유지.
        # 그림 + '원본유지(수식·전자배치·라벨)' 블록 영역 밖으로 클리핑한다. 번역문이
        # 옆/위에 놓인 식·전자배치 위에 겹쳐 찍히던 것(답안 (d)(e), 논문 식 옆 본문 등)을
        # 막는다 — 번역문은 식과 안 겹치는 가장 큰 직사각형에만 그려진다.
        kept_here = kept_by_page.get(pno, [])
        clip_regions = list(figs) + list(kept_here)
        clipped = []
        for rect, ko, sz, col, bd, it in items:
            cr = _clip_out(rect, clip_regions) if clip_regions else fitz.Rect(rect)
            if cr is None or cr.width < 3 or cr.height < 3:
                continue
            clipped.append((cr, ko, sz, col, bd, it))
        # redaction(원문 지우기)은 '겹침 분할 전' 각 블록의 제 bbox 전체로 한다.
        # dedoverlap 은 '번역문 그리기' 위치만 좁히는 용도 — 그 좁힌 rect 로 redaction 까지
        # 하면, 큰 문단 조각이 첫 줄로 잘려 뒷부분 원문(영어)이 안 지워지고 남는다
        # (인라인 수식이 한 줄을 쪼갠 문단에서 흔함). 그리기는 dedoverlap 결과를 쓴다.
        redact_full = [(fitz.Rect(c[0]), c[3]) for c in clipped]  # (full rect, color)
        clipped = _dedoverlap_column(clipped)
        # F1 세로압축: 한국어가 원문보다 짧아 생긴 문단 사이 빈칸을 없앤다(블록을 위로만
        # 끌어올림). redaction 은 위 redact_full(원위치)로 이미 잡아둬 영향 없다.
        # 앵커 = 번역 안 된 모든 블록(수식·라벨·미번역) + 그림 — 그 위로는 안 넘긴다.
        clipped = _compact_columns(
            clipped, static_by_page.get(pno, []), figs, page.rect, font
        )
        # 각 블록의 확장 한계 = 오른쪽/아래 '이웃 블록'까지(없으면 페이지 여백). 제목·헤딩이
        # 번역으로 길어져 가로·세로로 늘어나도 이웃을 침범해 겹치지 않도록 막는다.
        crects = [it[0] for it in clipped]
        nC = len(crects)
        # 확장을 막는 '장애물' = 다른 번역 블록 + 원본유지(수식·표 셀·라벨) + 그림/표 영역.
        # 원본유지 블록과 영역을 포함해야, 표 헤딩 번역문이 아래 표 셀 위로 넘치거나
        # 본문이 인접 수식을 침범하지 않는다(TABLE 6.1 헤딩 겹침 수정).
        kept = list(kept_by_page.get(pno, []))
        obstacles = crects + kept + list(figs)
        bounds = []
        for i in range(nC):
            ri = crects[i]
            bx = page.rect.x1 - 6.0
            by = page.rect.y1 - 6.0
            for rj in obstacles:
                if rj is ri:
                    continue  # 자기 자신(번역 블록)만 제외
                # 오른쪽 이웃 → 가로 확장 한계. 세로로 조금이라도 같은 띠에 걸치면(0.10)
                # 막는다 — 느슨하면(0.25) 수식 영역의 흩어진 블록이 서로를 못 보고 확장해 겹침.
                oy = min(ri.y1, rj.y1) - max(ri.y0, rj.y0)
                if rj.x0 >= ri.x1 - 1 and oy > 0.10 * min(ri.height, max(rj.height, 1.0)):
                    bx = min(bx, rj.x0 - 2)
                # 아래 이웃 → 세로 확장 한계(가로로 조금이라도 겹치면 막는다).
                ox = min(ri.x1, rj.x1) - max(ri.x0, rj.x0)
                if rj.y0 >= ri.y1 - 1 and ox > 0.10 * min(ri.width, max(rj.width, 1.0)):
                    by = min(by, rj.y0 - 2)
            # 세로 확장은 원래 높이의 ~3배까지만(아래 이웃 미검출 시 runaway 방지 — 한
            # 블록이 페이지 절반을 덮어 다른 글자 위로 흐르는 일 차단).
            by = min(by, ri.y1 + 3.0 * max(ri.height, 8.0))
            bounds.append((max(bx, ri.x1), max(by, ri.y1)))
        # 1) 원문 글자만 지운다. images=NONE 으로 그림은 보존.
        #    밝은(흰색 계열) 글자 → fill 생략. 그 외엔 '바로 바깥' 정확 배경색으로 덮어
        #    경계가 안 보이게(상자 느낌 제거).
        for rect, _col in redact_full:
            # 원본유지(표시수식·라벨) 블록과 겹치면, 그 글자를 지우지 않도록 redaction
            # 을 위/아래로 잘라 보호한다(번역 블록 bbox 가 인접 식을 덮는 드문 경우).
            sub = _split_out_keeps(rect, kept_by_page.get(pno, []))
            for sr in sub:
                r, g, b = _color01(_col)
                if min(r, g, b) > 0.8:
                    fill = None
                else:
                    bbg = _bg_around(sample, sr) or page_bg
                    fill = (bbg[0] / 255.0, bbg[1] / 255.0, bbg[2] / 255.0)
                page.add_redact_annot(sr, fill=fill)
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
        # 2) 같은(클리핑된) 박스에 번역문 삽입. 본문 양끝맞춤, 제목/한 줄은 가운데/왼쪽.
        page_width = page.rect.width
        # 페이지 본문 글자 크기(글자 수 최빈) — 헤딩(제목·섹션 제목) 판정 기준.
        _size_chars = defaultdict(float)
        for _it in items:
            _size_chars[round(_it[2], 1)] += max(1, len(_it[1]))
        body_size = max(_size_chars, key=_size_chars.get) if _size_chars else 10.0
        for idx, (rect, ko, _size, color, is_bold, is_ital) in enumerate(clipped):
            base = font_bold if is_bold else font  # 원문 굵게 → 번역본도 굵게
            bfont = _pick_font(ko, base)  # 글리프 빠짐 방지(∈ 등은 폴백 글꼴로)
            mx, my = bounds[idx]
            # 헤딩 = 본문보다 확실히 큰 글자, 또는 굵으면서 약간 큰 글자. 헤딩은
            # justify 금지(번역으로 길어져 두 줄이 되면 첫 줄 단어가 크게 벌어짐).
            is_heading = (_size >= 1.18 * body_size) or (
                is_bold and _size >= 1.08 * body_size
            )
            try:
                # 가로로 넓힐 수 있는 최대 폭 기준 '한 줄 여부' 판정(넓혀서 1줄이면 justify
                # 금지 → 단어 벌어짐 방지). 가운데 정렬 블록은 원래 폭 기준.
                avail_w = (
                    rect.width
                    if rect.width >= 0.45 * page_width
                    else (mx - rect.x0)
                )
                one_line = bfont.text_length(_strip_tags(ko), fontsize=_size) <= (avail_w - 2)
            except Exception:
                one_line = False
            align = _detect_align(
                rect, page_width, single_line=one_line, is_heading=is_heading
            )
            if _has_tags(ko):
                # 위/아래첨자(<sub>/<sup>) 포함 → 진짜 첨자로 그리는 rich 드로어.
                drew_shrunk = _draw_rich(
                    page, rect, ko, _color01(color), bfont, _size, align,
                    max_x=mx, max_y=my,
                )
            else:
                drew_shrunk = _draw_fit(
                    page, rect, ko, _color01(color), bfont, _size, align,
                    italic=is_ital, max_x=mx, max_y=my,
                )
            if drew_shrunk:
                shrunk += 1
            replaced += 1

    doc.save(out_path, garbage=3, deflate=True)
    doc.close()
    sys.stdout.write(json.dumps({"ok": True, "replaced": replaced, "shrunk": shrunk}))


def cmd_split(pdf_path, out_dir, pages_per_chunk=5):
    """텍스트 PDF 를 페이지 범위로 나눠 sub-PDF 들로 저장(재조판 병렬 처리용).
    각 chunk 를 동시에 번역해 합치면 Opus 품질 그대로 벽시계 시간을 줄인다."""
    pages_per_chunk = max(1, int(pages_per_chunk))
    os.makedirs(out_dir, exist_ok=True)
    src = fitz.open(pdf_path)
    n = len(src)
    chunks = []
    ci = 0
    for start in range(0, n, pages_per_chunk):
        end = min(start + pages_per_chunk, n)
        sub = fitz.open()
        sub.insert_pdf(src, from_page=start, to_page=end - 1)
        path = os.path.join(out_dir, f"chunk-{ci}.pdf")
        sub.save(path, garbage=3, deflate=True)
        sub.close()
        chunks.append({"path": path, "start": start + 1, "end": end})
        ci += 1
    src.close()
    sys.stdout.write(
        json.dumps({"page_count": n, "chunks": chunks}, ensure_ascii=False)
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


def cmd_figures(pdf_path, out_dir, zoom=3.0):
    """텍스트 PDF 의 그림/도표 영역을 PNG 로 잘라 out_dir 에 저장하고 메타데이터를 낸다.
    재조판(re-typeset) 시 원본 그림을 \\includegraphics 로 복원하기 위한 입력.
    번호는 페이지 순·세로 위→아래 순으로 매겨 Claude 마커 순서와 맞춘다."""
    try:
        zoom = float(zoom)
    except Exception:
        zoom = 3.0
    zoom = max(1.5, min(5.0, zoom))
    doc = fitz.open(pdf_path)
    os.makedirs(out_dir, exist_ok=True)
    figs_out = []
    n = 0
    for pno in range(len(doc)):
        page = doc[pno]
        regs = _figure_regions(page)
        if not regs:
            continue
        regs = sorted(regs, key=lambda r: (round(r.y0, 1), round(r.x0, 1)))
        try:
            tblocks = page.get_text("blocks")
        except Exception:
            tblocks = []
        mat = fitz.Matrix(zoom, zoom)
        pr = page.rect
        for reg in regs:
            if reg.width < 45 or reg.height < 45:
                continue  # 너무 작음(아이콘·기호 조각) → 그림으로 보지 않음
            # 축 라벨·화살촉이 잘리지 않게 약간 여백을 주되, 페이지 밖으로 안 나가게.
            pad = 7.0
            rr = fitz.Rect(
                max(pr.x0, reg.x0 - pad),
                max(pr.y0, reg.y0 - pad),
                min(pr.x1, reg.x1 + pad),
                min(pr.y1, reg.y1 + pad),
            )
            try:
                pix = page.get_pixmap(matrix=mat, clip=rr, alpha=False)
            except Exception:
                continue
            if pix.width < 12 or pix.height < 12:
                continue
            n += 1
            fname = os.path.join(out_dir, f"fig-{n}.png")
            try:
                pix.save(fname)
            except Exception:
                n -= 1
                continue
            figs_out.append(
                {
                    "n": n,
                    "page": pno + 1,
                    "bbox": [
                        round(reg.x0, 1),
                        round(reg.y0, 1),
                        round(reg.x1, 1),
                        round(reg.y1, 1),
                    ],
                    "caption": _figure_caption(tblocks, reg),
                    "file": os.path.abspath(fname),
                    "w": pix.width,
                    "h": pix.height,
                }
            )
    sys.stdout.write(
        json.dumps({"page_count": len(doc), "figures": figs_out}, ensure_ascii=False)
    )
    doc.close()


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
        elif mode == "rasterize":
            # rasterize <pdf> <out_dir> [long_edge_px] [max_pages]
            cmd_rasterize(*sys.argv[2:6])
        elif mode == "render":
            cmd_render(sys.argv[2], sys.argv[3], sys.argv[4])
        elif mode == "split":
            # split <pdf> <out_dir> [pages_per_chunk]
            cmd_split(*sys.argv[2:5])
        elif mode == "figures":
            # figures <pdf> <out_dir> [zoom] — 재조판 그림 복원용 크롭 추출
            cmd_figures(*sys.argv[2:5])
        else:
            sys.stderr.write(f"unknown mode: {mode}\n")
            sys.exit(2)
    except Exception as e:  # noqa: BLE001 — Node 에 stderr 로 원인 전달
        sys.stderr.write(f"{type(e).__name__}: {e}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
