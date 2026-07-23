#!/usr/bin/env python3
r"""
Insert Hancom/HWPX equation objects into an existing .hwpx file.

Recommended AI workflow:
  1. Put placeholders in the HWPX body text:
       {{EQ:x = {-b +- sqrt {b^2 - 4ac}} over {2a}}}
  2. Run:
       python hwpx_equation_tool.py replace input.hwpx output.hwpx

The expression inside EQ is Hancom Equation Editor script, not LaTeX.
For common LaTeX snippets, use EQ-LATEX:
       {{EQ-LATEX:\frac{-b \pm \sqrt{b^2-4ac}}{2a}}}

For automatically numbered equations, use EQN or EQN-LATEX:
       {{EQN:x^2 + y^2 = z^2}}
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


HP_NS = "http://www.hancom.co.kr/hwpml/2011/paragraph"
HS_NS = "http://www.hancom.co.kr/hwpml/2011/section"

NS = {
    "hp": HP_NS,
    "hs": HS_NS,
    "hh": "http://www.hancom.co.kr/hwpml/2011/head",
    "hc": "http://www.hancom.co.kr/hwpml/2011/core",
    "ha": "http://www.hancom.co.kr/hwpml/2011/app",
    "hp10": "http://www.hancom.co.kr/hwpml/2016/paragraph",
    "config": "urn:oasis:names:tc:opendocument:xmlns:config:1.0",
}

XMLNS_RE = re.compile(rb'\sxmlns(?::([A-Za-z_][\w.-]*))?="([^"]+)"')


def qname(ns: str, tag: str) -> str:
    return f"{{{ns}}}{tag}"


def register_known_namespaces() -> None:
    for prefix, uri in NS.items():
        try:
            ET.register_namespace(prefix, uri)
        except ValueError:
            pass


def register_namespaces_from_xml(xml_bytes: bytes) -> None:
    """Preserve existing prefixes as much as ElementTree allows."""
    register_known_namespaces()
    for prefix_b, uri_b in XMLNS_RE.findall(xml_bytes[:12000]):
        prefix = prefix_b.decode("utf-8") if prefix_b else ""
        uri = uri_b.decode("utf-8")
        if prefix.lower().startswith("xml"):
            continue
        try:
            ET.register_namespace(prefix, uri)
        except ValueError:
            continue


@dataclass(frozen=True)
class EquationStyle:
    base_unit: int = 1000
    text_color: str = "#000000"
    line_thickness: int = 100
    letter_spacing: int = 0


@dataclass
class ReplacementContext:
    next_equation_number: int = 1


class IdGenerator:
    def __init__(self, root: ET.Element, start: int = 1000000) -> None:
        used: set[str] = set()
        max_numeric = start - 1
        for elem in root.iter():
            value = elem.attrib.get("id")
            if value is None:
                continue
            used.add(value)
            if value.isdigit():
                max_numeric = max(max_numeric, int(value))
        self._used = used
        self._next = max_numeric + 1

    def next(self) -> str:
        while str(self._next) in self._used:
            self._next += 1
        value = str(self._next)
        self._used.add(value)
        self._next += 1
        return value


def make_text_run(text: str, run_attrs: dict[str, str]) -> ET.Element:
    run = ET.Element(qname(HP_NS, "run"), run_attrs)
    t = ET.SubElement(run, qname(HP_NS, "t"))
    t.text = text
    return run


def _estimate_base_line(script: str) -> str:
    """편집기가 계산하는 baseLine(객체 높이 대비 글줄 기준선 위치 %)의 근사.

    넣기 후 XML 실측(2026-07-13): 분수/근호/큰 연산이 있으면 64~68,
    첨자만 있으면 72, 평문은 86. 정확값은 레이아웃 계산이 필요하지만
    이 근사만으로도 '넣기 후와 같은 정상 모양'이 된다(속성 프로브 B/C/E/G
    판정). 종전의 baseLine=0 은 문장 속 인라인 수식이 글줄에 어긋나 보이던
    원인이었다.
    """
    if re.search(
        r"\bover\b|\batop\b|\bsqrt\b|\bmatrix\b|\bcases\b|\bsum\b|\bint\b"
        r"|\bprod\b|\bCHOOSE\b|\bpmatrix\b|\bdmatrix\b|\bbmatrix\b",
        script,
    ):
        return "68"
    if "_" in script or "^" in script:
        return "72"
    return "86"


def make_equation(
    script: str,
    equation_id: str,
    style: EquationStyle = EquationStyle(),
    treat_as_char: bool = True,
) -> ET.Element:
    if not (script or "").strip():
        # 빈 hp:script 는 validate_hwpx_equations 가 fatal 로 보므로
        # 빈 수식 객체는 생성 단계에서 차단한다(호출부가 미리 걸러야 한다).
        raise ValueError("empty equation script")
    # 속성은 수식 편집기 '넣기'가 부여하는 정준 집합을 그대로 쓴다(넣기
    # 전후 XML diff + 속성 프로브 실측, 2026-07-13). 이 속성이 없으면
    # (특히 version/font/lineMode/baseLine) 문서를 열 때 수식이 구식
    # 렌더러로 그려져 글꼴·기준선이 어긋나고, 사용자가 수식마다 넣기를
    # 눌러야 정상으로 보이는 문제(P1)가 생긴다. version="Equation Version
    # 60" 은 새로 열 때의 스크립트 방언(토큰 단위 렉싱)까지 바꾼다.
    equation = ET.Element(
        qname(HP_NS, "equation"),
        {
            "id": equation_id,
            "zOrder": "0",
            "numberingType": "NONE",
            "textWrap": "TOP_AND_BOTTOM",
            "textFlow": "BOTH_SIDES",
            "lock": "0",
            "dropcapstyle": "None",
            "version": "Equation Version 60",
            "baseLine": _estimate_base_line(script),
            "textColor": style.text_color,
            "baseUnit": str(style.base_unit),
            "lineMode": "CHAR",
            "font": "HYhwpEQ",
        },
    )
    ET.SubElement(
        equation,
        qname(HP_NS, "sz"),
        {
            "width": "0",
            "height": "0",
            "widthRelTo": "ABS",
            "heightRelTo": "ABS",
        },
    )
    ET.SubElement(
        equation,
        qname(HP_NS, "pos"),
        {
            "treatAsChar": "1" if treat_as_char else "0",
            "affectLSpacing": "0",
            "flowWithText": "0",
            "allowOverlap": "0",
            "holdAnchorAndSO": "0",
            "rgroupWithPrevCtrl": "0",
            "vertRelTo": "PARA",
            "horzRelTo": "PARA",
            "vertAlign": "TOP",
            "horzAlign": "LEFT",
            "vertOffset": "0",
            "horzOffset": "0",
        },
    )
    script_elem = ET.SubElement(equation, qname(HP_NS, "script"))
    script_elem.text = script.strip()
    return equation


def make_equation_run(
    script: str,
    equation_id: str,
    run_attrs: dict[str, str],
    style: EquationStyle = EquationStyle(),
) -> ET.Element:
    run = ET.Element(qname(HP_NS, "run"), run_attrs)
    run.append(make_equation(script, equation_id, style=style))
    return run


class LatexToHwpConverter:
    """Small, practical converter for common math snippets.

    This is intentionally not a full TeX parser. It covers the patterns that
    show up most often in AI-generated equations and leaves plain text intact.
    """

    COMMANDS = {
        r"\times": " TIMES ",
        # \cdot 은 ×(TIMES)가 아니라 가운뎃점(cdot) — 수화물 CuSO4·5H2O,
        # 단위 곱 J/(mol·K), 내적 표기 관례. hwip 출력(cdot)과도 일치시켜
        # 같은 문서에서 ·/× 가 혼재하지 않게 한다.
        r"\cdot": " cdot ",
        r"\div": " DIV ",
        r"\pm": "+-",
        r"\mp": "-+",
        r"\approx": " APPROX ",
        r"\equiv": "==",
        r"\leq": "<=",
        r"\le": "<=",
        r"\geq": ">=",
        r"\ge": ">=",
        r"\neq": "!=",
        r"\ne": "!=",
        r"\rightarrow": "->",
        # 이중(겹줄) 화살표는 한컴 키워드 RARROW/LARROW/LRARROW 로 — 과거
        # \Leftarrow 를 "<="(≤)로 내던 오매핑은 부등호로 렌더되는 실결함이었고,
        # \Rightarrow/\Leftrightarrow 의 "=>"/"<->" 는 단줄 화살표 격하였다
        # (구조 동치성 검사로 발견, hwip vendor 표와 동일 키워드로 통일).
        r"\Rightarrow": "RARROW",
        r"\leftarrow": "<-",
        r"\Leftarrow": "LARROW",
        r"\leftrightarrow": "<->",
        r"\to": "->",
        r"\infty": "INF",
        r"\partial": "partial",
        r"\nabla": "nabla",
        r"\forall": "forall",
        r"\exists": "exists",
        r"\in": "in",
        r"\notin": "notin",
        r"\cup": "cup",
        r"\cap": "cap",
        r"\subset": "subset",
        r"\subseteq": "subseteq",
        r"\supset": "supset",
        r"\supseteq": "supseteq",
        r"\pi": "pi",
        r"\varepsilon": "epsilon",
        r"\epsilon": "epsilon",
        r"\vartheta": "theta",
        r"\theta": "theta",
        r"\varphi": "phi",
        r"\varrho": "rho",
        r"\varsigma": "sigma",
        r"\alpha": "alpha",
        r"\beta": "beta",
        r"\gamma": "gamma",
        r"\delta": "delta",
        r"\eta": "eta",
        r"\zeta": "zeta",
        r"\iota": "iota",
        r"\kappa": "kappa",
        r"\Delta": "DELTA",
        r"\lambda": "lambda",
        r"\mu": "mu",
        r"\nu": "nu",
        r"\xi": "xi",
        r"\rho": "rho",
        r"\sigma": "sigma",
        r"\tau": "tau",
        r"\upsilon": "upsilon",
        r"\Sigma": "SIGMA",
        r"\phi": "phi",
        r"\chi": "chi",
        r"\psi": "psi",
        r"\omega": "omega",
        r"\Gamma": "GAMMA",
        r"\Theta": "THETA",
        r"\Lambda": "LAMBDA",
        r"\Xi": "XI",
        r"\Pi": "PI",
        r"\Omega": "OMEGA",
        r"\Phi": "PHI",
        r"\Psi": "PSI",
        r"\sin": "sin",
        r"\cos": "cos",
        r"\tan": "tan",
        r"\cot": "cot",
        r"\sec": "sec",
        r"\csc": "csc",
        r"\arcsin": "arcsin",
        r"\arccos": "arccos",
        r"\arctan": "arctan",
        r"\sinh": "sinh",
        r"\cosh": "cosh",
        r"\tanh": "tanh",
        r"\log": "log",
        r"\ln": "ln",
        r"\exp": "exp",
        r"\min": "min",
        r"\max": "max",
        r"\lim": "lim",
        r"\sum": "sum",
        r"\prod": "prod",
        r"\int": "int",
        # 다중적분은 HWP 전용 키워드(dint/tint/qint)로 — 'iint'/'iiint' 는
        # 한컴 수식 키워드가 아니라 글자로 노출된다. hwip 출력과도 일치시킨다.
        r"\iint": "dint",
        r"\iiint": "tint",
        r"\iiiint": "qint",
        # 면/체적분 닫힌 적분 변형 — 한컴엔 단일 'oint' 만 있어 모두 oint 로.
        r"\oint": "oint",
        r"\oiint": "oint",
        r"\oiiint": "oint",
        r"\left": "",
        r"\right": "",
        r"\middle": "",
        # ── 물리/화학/수학 빈출 추가분 — hwip 출력 키워드와 맞춘다 ──
        r"\circ": "circ",
        r"\degree": "DEG",
        r"\hbar": "hbar",
        r"\ell": "ELL",
        r"\perp": "bot",
        r"\parallel": "parallel",
        r"\propto": "propto",
        r"\Upsilon": "Upsilon",
        r"\AA": "ANGSTROM",
        r"\Leftrightarrow": "LRARROW",
        r"\Longleftrightarrow": "LRARROW",
        r"\longleftrightarrow": "<->",
        r"\longrightarrow": "->",
        r"\longleftarrow": "<-",
        r"\Longrightarrow": "RARROW",
        r"\Longleftarrow": "LARROW",
        r"\implies": "RARROW",
        r"\iff": "LRARROW",
        r"\ldots": "ldots",
        r"\cdots": "cdots",
        r"\vdots": "vdots",
        r"\ddots": "ddots",
        r"\dotsb": "cdots",
        r"\dotsc": "cdots",
        r"\dots": "ldots",
        r"\sup": "sup",
        r"\inf": "inf",
        r"\det": "det",
        r"\gcd": "gcd",
        r"\arg": "arg",
        r"\deg": "deg",
        # ── 접두 충돌 빈출 명령 — 통짜 토큰 매칭(_commands_pattern)과 한 쌍.
        # 사전에 없어도 \cmd 안전망이 단어로 살리지만, 아래는 대응 키워드가
        # 있어 명시 매핑한다(hwip vendor 표의 neg/top/bot, FUNCTIONS 의 mod 와 동일).
        r"\limits": "",  # 연산자 첨자 '위치' 힌트 — 그릴 내용 없음
        r"\nolimits": "",
        # 크기/모드 선언 — 그릴 내용이 없다(hwip vendor 의 무시 목록과 한 쌍).
        r"\displaystyle": "",
        r"\textstyle": "",
        r"\scriptstyle": "",
        r"\scriptscriptstyle": "",
        r"\ensuremath": "",
        # AMS slanted 부등호 — 한컴엔 전용 글리프가 없어 일반 부등호로.
        r"\geqslant": ">=",
        r"\leqslant": "<=",
        r"\pmod": " mod ",  # a \equiv b \pmod{n} → a == b mod {n}
        r"\bmod": " mod ",
        r"\mod": " mod ",
        r"\top": "top",  # ⊤ — \to 와 접두 충돌('A^ -> p' 방지)
        r"\bot": "bot",
        r"\neg": "lnot",  # ¬ — \ne 와 접두 충돌
        r"\lnot": "lnot",
        r"\intercal": "T",  # 전치 A^\intercal ≈ A^T — \int 와 접두 충돌
        r"\mid": "|",
        # 노름/절댓값 구분자 — bare \lVert/\Vert 가 \cmd 안전망(convert 말미)
        # 으로 빠지면 'lVert' 영단어가 그대로 렌더되고, \| 는 백슬래시만 떼여
        # 단일 막대(절댓값)로 격하된다. 노름 ‖ 은 한컴 키워드 VERT, 절댓값은
        # 막대 글자(hwip readDelim 매핑과 동일). 양쪽 공백 패딩은
        # _command_replacement 가 보장해 키워드 융합(xVERT)이 없다.
        r"\lVert": "VERT",
        r"\rVert": "VERT",
        r"\Vert": "VERT",
        r"\|": "VERT",
        r"\lvert": "|",
        r"\rvert": "|",
        r"\vert": "|",
        # 리터럴 중괄호(집합 표기 \{x|x>0\}) — 알몸 '{' 는 한컴 그룹 여닫이로
        # 먹혀 기호가 증발한다(렌더 시트 S2-114 실측). 인용 리터럴로 살린다.
        # hwip 은 이 입력을 처리 못 해 _HWIP_UNSAFE_RE 가 빌트인으로 보낸다.
        r"\{": '"{"',
        r"\}": '"}"',
        r"\lbrace": '"{"',
        r"\rbrace": '"}"',
        r"\,": "`",
        r"\;": "~",
        r"\quad": "~",
        r"\qquad": "~ ~",
        r"\ ": "~",  # 단위 간격(\<space>) — 측정값 식마다 등장
        r"\!": "",
    }

    ONE_ARG_COMMANDS = {
        r"\overline": "bar",
        r"\bar": "bar",
        r"\vec": "vec",
        r"\hat": "hat",
        r"\widehat": "hat",
        r"\tilde": "tilde",
        r"\widetilde": "tilde",
        r"\dot": "dot",
        r"\ddot": "ddot",
        r"\overrightarrow": "dyad",
        r"\overbrace": "OVERBRACE",
        r"\underbrace": "UNDERBRACE",
        r"\mathrm": "",
        r"\mathbf": "",
        r"\mathit": "",
        r"\mathbb": "",
        r"\mathcal": "",
        r"\mathscr": "",
        r"\mathfrak": "",
        r"\mathsf": "",
        r"\mathtt": "",
        r"\mathnormal": "",
        r"\boldsymbol": "",
        r"\operatorname": "",
        r"\text": "",
        r"\textrm": "",
        r"\textnormal": "",
        r"\mbox": "",
        r"\textbf": "",
        r"\textit": "",
    }

    # \text 계열은 평문 본문일 때 한컴 인용 리터럴("...")로 감싼다 — 알몸으로
    # 벗기면 한컴이 토큰 사이 공백을 렌더하지 않아 'percent difference' 가
    # 'percentdifference' 로 붙고 over/in 등 키워드로 오인될 수 있다.
    TEXT_LITERAL_COMMANDS = frozenset(
        {r"\text", r"\textrm", r"\textnormal", r"\mbox"}
    )

    ENVIRONMENTS = {
        "matrix": "matrix",
        "pmatrix": "pmatrix",
        "bmatrix": "bmatrix",
        # 행렬식 |A| — 한컴 키워드는 dmatrix. vmatrix/Vmatrix 는 한컴에 없어
        # 이탤릭 단어 'vmatrix'+중괄호로 노출된다(hwip vendor 매핑과 동일).
        "vmatrix": "dmatrix",
        "Vmatrix": "dmatrix",
        "Bmatrix": "matrix",
        "smallmatrix": "matrix",
        "cases": "cases",
        "aligned": "matrix",
        "array": "matrix",
        # align/gather 계열 — 행은 # 로, 정렬 & 는 열 구분으로 살린다.
        "align": "matrix",
        "align*": "matrix",
        "alignat": "matrix",
        "alignedat": "matrix",
        "gather": "matrix",
        "gather*": "matrix",
        "gathered": "matrix",
        "split": "matrix",
        # equation 계열 — 감싸지 않고 내용만 남긴다.
        "equation": "",
        "equation*": "",
    }

    _COMMANDS_PATTERN: re.Pattern[str] | None = None

    @classmethod
    def _commands_pattern(cls) -> re.Pattern[str]:
        r"""COMMANDS 전체의 통짜 토큰 매칭용 단일 정규식(긴 명령 우선).

        str.replace() 평치환은 단어 경계가 없어 사전 밖 명령(\pmod, \limits,
        \top, \neg, \intercal …)이 사전 안 명령(\pm, \lim, \to, \ne, \int)을
        접두로 갖는 순간 엉뚱한 기호로 쪼개지고(\pmod → '+- od'), 백슬래시까지
        소비해 convert 말미의 \cmd 안전망마저 무력화됐다. 영문자 명령 뒤에
        (?![A-Za-z]) 를 강제해 통짜 토큰만 치환한다(TeX 토크나이즈와 동일 —
        숫자·기호는 명령 이름의 일부가 될 수 없어 바로 뒤에 와도 된다).
        """
        if cls._COMMANDS_PATTERN is None:
            alternatives = []
            for src in sorted(cls.COMMANDS, key=len, reverse=True):
                escaped = re.escape(src)
                if src[-1].isalpha():
                    escaped += r"(?![A-Za-z])"
                alternatives.append(escaped)
            cls._COMMANDS_PATTERN = re.compile("|".join(alternatives))
        return cls._COMMANDS_PATTERN

    @classmethod
    def _command_replacement(cls, match: re.Match[str]) -> str:
        # 양쪽 공백 패딩: `T\Delta S` 처럼 명령이 변수에 붙어 있으면 치환 시
        # `TDELTA` 로 키워드가 파손된다(깁스 식). 잉여 공백은 convert 말미에서 정리.
        dst = cls.COMMANDS[match.group(0)]
        return f" {dst.strip()} " if dst.strip() else dst

    def convert(self, latex: str) -> str:
        text = latex.strip()
        text = self._strip_math_delimiters(text)
        # 잘린 인자(\frac{a}{b) 복구 — 미폐합 중괄호를 먼저 보충해야 구조
        # 변환이 인자를 읽을 수 있다. 건너뛰면 아래 안전망이 백슬래시만 떼어
        # 'frac' 알몸 키워드가 실제 스크립트에 누출된다(hwip 의 관용 복구와
        # 동일한 동작).
        text = _balance_brace_groups(text)
        text = self._convert_structures(text)
        # 환경 변환 뒤 엉뚱한 위치에 남은 행 구분자 \\ 는 한컴 줄바꿈(#)으로.
        text = text.replace("\\\\", " # ")
        # \left. / \right. (evaluated-at 의 빈 구분자)는 명령과 함께 소비한다.
        # \left→"" 평치환 뒤에는 빈 구분자 '.' 와 소수점·마침표를 구별할 수
        # 없어 점이 가시 문자로 남으므로 반드시 평치환 전에 처리한다.
        text = re.sub(r"\\(?:left|right|middle)\s*\.", " ", text)
        # COMMANDS 일괄 치환 — 통짜 토큰만(접두 파손 방지), 양쪽 공백 패딩.
        # 상세는 _commands_pattern/_command_replacement docstring 참조.
        text = self._commands_pattern().sub(self._command_replacement, text)
        text = text.replace(r"\{", "{").replace(r"\}", "}")
        text = text.replace(r"\%", "%")
        text = text.replace(r"\_", "_")
        text = text.replace(r"\&", "&")
        # 미지원 명령 안전망 — 백슬래시(원시 LaTeX 잔재)는 어떤 경우에도 최종
        # 수식 스크립트에 남기지 않는다. 미지원 \begin/\end 는 마커만 버리고
        # 내용을 살리고, 그 밖의 \cmd 는 이름만 남긴다(공백 패딩으로 키워드
        # 파손 방지). 남은 외톨이 백슬래시도 제거한다.
        text = re.sub(r"\\(?:begin|end)\s*\{\s*[A-Za-z*]*\s*\}", " ", text)
        text = re.sub(r"\\([A-Za-z]+)", r" \1 ", text)
        text = text.replace("\\", " ")
        # \{ → { 치환 등으로 뒤늦게 어긋난 중괄호 짝을 한 번 더 복구한다 —
        # 변환기 출력은 항상 균형 잡힌 스크립트여야 한다.
        text = _balance_brace_groups(text)
        text = re.sub(
            r"\b(sum|prod|int|dint|tint|qint|oint|lim)(?=[_^])", r"\1 ", text
        )
        text = re.sub(r"\s+", " ", text)
        text = re.sub(r"\s+([_^])", r"\1", text)
        # `^ circ` 처럼 명령 치환 패딩으로 첨자 뒤에 공백이 끼면 첨자가 다음
        # 토큰에 못 붙는다 — 첨자는 항상 다음 토큰에 바로 붙인다.
        text = re.sub(r"([_^])\s+(?=[A-Za-z0-9{(])", r"\1", text)
        return text.strip()

    def _strip_math_delimiters(self, text: str) -> str:
        pairs = [
            (r"\(", r"\)"),
            (r"\[", r"\]"),
            ("$$", "$$"),
            ("$", "$"),
        ]
        for left, right in pairs:
            if text.startswith(left) and text.endswith(right):
                return text[len(left) : len(text) - len(right)].strip()
        return text

    def _convert_structures(self, text: str) -> str:
        previous = None
        current = text
        while previous != current:
            previous = current
            current = self._replace_labeled_arrows(current)
            current = self._replace_environments(current)
            current = self._replace_substack(current)
            current = self._replace_oversets(current)
            current = self._replace_frac(current)
            current = self._replace_sqrt(current)
            current = self._replace_binom(current)
            current = self._replace_one_arg_commands(current)
        return current

    def _replace_labeled_arrows(self, text: str) -> str:
        arrows = (
            (r"\xleftrightarrow", "<->"),
            (r"\xrightarrow", "->"),
            (r"\xleftarrow", "<-"),
        )
        for marker, arrow in arrows:
            idx = text.find(marker)
            while idx >= 0:
                pos = self._skip_spaces(text, idx + len(marker))
                try:
                    below = ""
                    if pos < len(text) and text[pos] == "[":
                        below, pos = self._read_balanced(text, pos, "[", "]")
                        pos = self._skip_spaces(text, pos)
                    if pos >= len(text) or text[pos] != "{":
                        idx = text.find(marker, idx + len(marker))
                        continue
                    above, end = self._read_balanced(text, pos, "{", "}")
                except ValueError:
                    idx = text.find(marker, idx + len(marker))
                    continue
                label = above.strip() or below.strip()
                converted_label = self._convert_structures(label)
                replacement = f"BUILDREL {arrow} {{{converted_label}}}"
                text = text[:idx] + replacement + text[end:]
                idx = text.find(marker, idx + len(replacement))
        return text

    def _replace_frac(self, text: str) -> str:
        # \cfrac(연분수)도 일반 분수와 동일한 over 구조 — hwip 과 같은 처리.
        for marker in (r"\dfrac", r"\tfrac", r"\cfrac", r"\frac"):
            text = self._replace_two_braced_args(text, marker, "{%s} over {%s}")
        return text

    def _replace_binom(self, text: str) -> str:
        # 한컴 이항계수 키워드는 CHOOSE (hwip 출력과 동일).
        for marker in (r"\dbinom", r"\tbinom", r"\binom"):
            text = self._replace_two_braced_args(text, marker, "{%s} CHOOSE {%s}")
        return text

    def _replace_oversets(self, text: str) -> str:
        # \overset{위}{본체} → {본체} ^{위} / \underset{아래}{본체} → {본체} _{아래}
        for marker, script_mark in (
            (r"\overset", "^"),
            (r"\stackrel", "^"),
            (r"\underset", "_"),
        ):
            idx = text.find(marker)
            while idx >= 0:
                after = idx + len(marker)
                if after < len(text) and text[after].isalpha():
                    idx = text.find(marker, after)
                    continue
                pos = self._skip_spaces(text, after)
                if pos >= len(text) or text[pos] != "{":
                    idx = text.find(marker, after)
                    continue
                try:
                    first, pos = self._read_balanced(text, pos, "{", "}")
                    pos = self._skip_spaces(text, pos)
                    if pos >= len(text) or text[pos] != "{":
                        idx = text.find(marker, after)
                        continue
                    second, end = self._read_balanced(text, pos, "{", "}")
                except ValueError:
                    idx = text.find(marker, after)
                    continue
                replacement = "{%s} %s{%s}" % (
                    self._convert_structures(second),
                    script_mark,
                    self._convert_structures(first),
                )
                text = text[:idx] + replacement + text[end:]
                idx = text.find(marker, idx + len(replacement))
        return text

    def _replace_substack(self, text: str) -> str:
        marker = r"\substack"
        idx = text.find(marker)
        while idx >= 0:
            after = idx + len(marker)
            pos = self._skip_spaces(text, after)
            if pos >= len(text) or text[pos] != "{":
                idx = text.find(marker, after)
                continue
            try:
                body, end = self._read_balanced(text, pos, "{", "}")
            except ValueError:
                idx = text.find(marker, after)
                continue
            replacement = f"matrix {{ {self._convert_matrix_body(body)} }}"
            text = text[:idx] + replacement + text[end:]
            idx = text.find(marker, idx + len(replacement))
        return text

    def _replace_one_arg_commands(self, text: str) -> str:
        for marker, command in sorted(
            self.ONE_ARG_COMMANDS.items(), key=lambda item: -len(item[0])
        ):
            idx = text.find(marker)
            while idx >= 0:
                after = idx + len(marker)
                if after < len(text) and text[after].isalpha():
                    # 더 긴 명령의 접두 매칭(\dot in \dots 등) — 건너뛴다.
                    idx = text.find(marker, after)
                    continue
                pos = self._skip_spaces(text, after)
                if pos >= len(text) or text[pos] != "{":
                    # 중괄호 없는 단일 토큰 인자: `\vec v`, `\hat\imath` 등
                    token = re.match(r"\\[A-Za-z]+|[A-Za-z0-9]", text[pos:])
                    if token is None:
                        idx = text.find(marker, after)
                        continue
                    body, end = token.group(0), pos + token.end()
                else:
                    try:
                        body, end = self._read_balanced(text, pos, "{", "}")
                    except ValueError:
                        idx = text.find(marker, after)
                        continue
                literal = self._text_literal_replacement(marker, body)
                if literal is not None:
                    text = text[:idx] + literal + text[end:]
                    idx = text.find(marker, idx + len(literal))
                    continue
                converted_body = self._convert_structures(body)
                # 선행 공백 패딩 — COMMANDS 치환의 양쪽 패딩과 같은 가드.
                # 없으면 `m\vec{a}` → 'mvec {a}', `A_x\hat{i}` → '_{"xhat"}' 처럼
                # 키워드가 앞 글자·첨자와 융합한다. 본문만 인라인하는 내용 명령
                # (\mathrm/\text 계열, command=="")은 패딩하지 않는다. 잉여
                # 공백은 convert 말미의 공백 정리가 거둬 간다.
                replacement = (
                    f" {command} {{{converted_body}}}" if command else converted_body
                )
                text = text[:idx] + replacement + text[end:]
                idx = text.find(marker, idx + len(replacement))
        return text

    def _text_literal_replacement(self, marker: str, body: str) -> str | None:
        r"""\text 계열 평문 본문의 한컴 인용 리터럴('"..."') 치환값.

        명령(\cmd)·중첩 그룹·첨자·따옴표가 섞인 본문은 None 을 돌려
        기존 변환 경로로 폴백한다. \mathrm 은 다글자 영문(단위 kg, mol 등)일
        때만 인용한다 — m/s^2 처럼 구조가 섞인 단위는 기존 경로가 맞다.
        """
        plain = body.strip()
        if not plain or re.search(r'[\\{}"^_]', plain):
            return None
        if marker in self.TEXT_LITERAL_COMMANDS:
            return f'"{plain}"'
        if marker == r"\mathrm" and re.fullmatch(r"[A-Za-z]{2,}", plain):
            return f'"{plain}"'
        return None

    def _replace_environments(self, text: str) -> str:
        for latex_name, hwp_name in self.ENVIRONMENTS.items():
            begin = rf"\begin{{{latex_name}}}"
            end = rf"\end{{{latex_name}}}"
            idx = text.find(begin)
            while idx >= 0:
                body_start = idx + len(begin)
                if latex_name in ("array", "alignat", "alignedat"):
                    after_begin = self._skip_spaces(text, body_start)
                    if after_begin < len(text) and text[after_begin] == "{":
                        try:
                            _, body_start = self._read_balanced(
                                text, after_begin, "{", "}"
                            )
                        except ValueError:
                            body_start = after_begin
                end_idx = text.find(end, body_start)
                if end_idx < 0:
                    idx = text.find(begin, body_start)
                    continue
                body = text[body_start:end_idx]
                converted_body = self._convert_matrix_body(body)
                if hwp_name:
                    replacement = f"{hwp_name} {{ {converted_body} }}"
                else:
                    replacement = converted_body
                text = text[:idx] + replacement + text[end_idx + len(end) :]
                idx = text.find(begin, idx + len(replacement))
        return text

    def _convert_matrix_body(self, body: str) -> str:
        # 행(\\)·열(&) 구분은 중괄호 깊이 0 에서만 인정한다 — \frac{a \\ b}{c}
        # 처럼 인자 안의 \\ 를 행으로 갈라 중괄호 짝을 깨뜨리지 않도록.
        rows = self._split_top_level(body.strip(), "\\\\")
        converted_rows: list[str] = []
        for row in rows:
            cells = [
                self._convert_structures(cell.strip())
                for cell in self._split_top_level(row, "&")
            ]
            converted_rows.append(" & ".join(cells))
        return " # ".join(converted_rows)

    @staticmethod
    def _split_top_level(text: str, separator: str) -> list[str]:
        """중괄호 깊이 0 에서만 separator 를 인정하는 분리기(이스케이프 보존)."""
        parts: list[str] = []
        buf: list[str] = []
        depth = 0
        i = 0
        n = len(text)
        sep_len = len(separator)
        while i < n:
            char = text[i]
            if depth == 0 and text.startswith(separator, i):
                parts.append("".join(buf))
                buf = []
                i += sep_len
                continue
            if char == "\\":
                buf.append(text[i : i + 2])
                i += 2
                continue
            if char == "{":
                depth += 1
            elif char == "}":
                depth = max(0, depth - 1)
            buf.append(char)
            i += 1
        parts.append("".join(buf))
        return parts

    def _replace_sqrt(self, text: str) -> str:
        marker = r"\sqrt"
        idx = text.find(marker)
        while idx >= 0:
            pos = idx + len(marker)
            pos = self._skip_spaces(text, pos)
            try:
                degree = None
                if pos < len(text) and text[pos] == "[":
                    degree, pos = self._read_balanced(text, pos, "[", "]")
                    pos = self._skip_spaces(text, pos)
                if pos >= len(text) or text[pos] != "{":
                    idx = text.find(marker, idx + len(marker))
                    continue
                body, end = self._read_balanced(text, pos, "{", "}")
            except ValueError:
                # 미폐합 [ / { — 이 출현은 건너뛰고 안전망(convert 말미)이 처리
                idx = text.find(marker, idx + len(marker))
                continue
            converted_body = self._convert_structures(body)
            # 선행 공백 패딩 — `2\sqrt{2}` 가 '2sqrt' 로 융합하지 않게
            # (_replace_one_arg_commands 와 동일 가드).
            if degree is None:
                replacement = f" sqrt {{{converted_body}}}"
            else:
                replacement = f" root {degree.strip()} of {{{converted_body}}}"
            text = text[:idx] + replacement + text[end:]
            idx = text.find(marker, idx + len(replacement))
        return text

    def _read_latex_arg(self, text: str, pos: int) -> tuple[str, int] | None:
        r"""LaTeX 인자 1개 읽기 — '{...}' 그룹 또는 단일 토큰(숫자/글자/\cmd).

        LaTeX 규약상 중괄호 없는 인자는 정확히 토큰 1개다(\frac12 = 1/2,
        \frac\pi2 = π/2, \frac d{dx}). 구조 특수문자(중괄호 짝·첨자·정렬 등)나
        문자열 끝이면 None — 호출부가 강등 경로를 결정한다.
        """
        pos = self._skip_spaces(text, pos)
        if pos >= len(text):
            return None
        if text[pos] == "{":
            try:
                return self._read_balanced(text, pos, "{", "}")
            except ValueError:
                return None
        token = re.match(r"\\[A-Za-z]+|[^\s{}\\^_&$%#]", text[pos:])
        if token is None:
            return None
        return token.group(0), pos + token.end()

    def _replace_two_braced_args(self, text: str, marker: str, template: str) -> str:
        idx = text.find(marker)
        while idx >= 0:
            after = idx + len(marker)
            if after < len(text) and text[after].isalpha():
                # 더 긴 명령의 접두 매칭(\frac in \fracs 등) — 건너뛴다.
                idx = text.find(marker, after)
                continue
            # LaTeX 규약: 인자는 '{...}' 그룹 또는 단일 토큰(\frac12 = 1/2).
            # 종전엔 '{' 필수라 통째로 건너뛰어 백슬래시 안전망이 'frac' 알몸
            # 키워드를 누출했다(fatal 강등). 잘려서 인자가 아예 없으면 hwip 의
            # 관용과 같게 빈 그룹으로 강등하고, 구조 특수문자가 막아서면 종전
            # 경로(건너뛰기)로 둔다.
            first_read = self._read_latex_arg(text, after)
            if first_read is None:
                if self._skip_spaces(text, after) >= len(text):
                    first_read = ("", len(text))
                else:
                    idx = text.find(marker, after)
                    continue
            first, pos = first_read
            second_read = self._read_latex_arg(text, pos)
            if second_read is None:
                if self._skip_spaces(text, pos) >= len(text):
                    second_read = ("", len(text))
                else:
                    idx = text.find(marker, after)
                    continue
            second, end = second_read
            replacement = template % (
                self._convert_structures(first),
                self._convert_structures(second),
            )
            text = text[:idx] + replacement + text[end:]
            idx = text.find(marker, idx + len(replacement))
        return text

    def _read_balanced(
        self, text: str, start: int, opener: str, closer: str
    ) -> tuple[str, int]:
        if text[start] != opener:
            raise ValueError(f"expected {opener!r} at index {start}")
        depth = 0
        i = start
        while i < len(text):
            char = text[i]
            if char == "\\":
                i += 2
                continue
            if char == opener:
                depth += 1
            elif char == closer:
                depth -= 1
                if depth == 0:
                    return text[start + 1 : i], i + 1
            i += 1
        raise ValueError(f"unclosed {opener!r} in LaTeX expression")

    def _skip_spaces(self, text: str, pos: int) -> int:
        while pos < len(text) and text[pos].isspace():
            pos += 1
        return pos


def _balance_brace_groups(text: str) -> str:
    r"""중괄호 짝 복구 — 잘린 인자(\frac{a}{b)도 변환 가능하게 만든다.

    부족한 '}' 는 끝에 보충하고 짝 없는 '}' 는 버린다(이스케이프 \{ \} 는
    세지 않는다 — hwip 토크나이저의 관용과 동일). 불균형 스크립트는 한컴이
    수식 객체를 그리지 못할 수 있으므로 최종 출력 직전에도 적용한다.
    """
    text = str(text or "")
    depth = 0
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        char = text[i]
        if char == "\\":
            out.append(text[i : i + 2])
            i += 2
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            if depth == 0:
                i += 1
                continue
            depth -= 1
        out.append(char)
        i += 1
    if depth > 0:
        out.append("}" * depth)
    return "".join(out)


def brace_unbraced_scripts(script: str) -> str:
    text = str(script or "")
    text = re.sub(r"([_^])(?!\{)([+\-])", r"\1{\2}", text)
    text = re.sub(r"([_^])(?!\{)(\d+(?:\.\d+)?)", r"\1{\2}", text)
    text = re.sub(r"([_^])(?!\{)([A-Za-z]+)", r"\1{\2}", text)
    return text


# 한컴 수식 키워드는 화학식 원소처럼 보여도 절대 앞뒤 토큰과 붙이면 안 된다.
# 빌트인 변환기는 전대문자 키워드를 내고(DELTA), hwip 엔진은 첫대문자 키워드도
# 낸다(Delta, LEFT(, RIGHT)). 종전 lookahead 가드는 키워드 '중간' 글자에서
# 시작하는 매칭(DELTA G 의 끝 'A' + 공백 + G → DELTAG)을 못 막아 깁스 식
# 'DELTA G = DELTA H - T DELTA S' 가 'DELTAG = DELTAH - TDELTAS' 로 깨졌다.
# → 키워드 구간을 통째로 보호(placeholder 치환)한 뒤 압축하고 복원한다.
# 대소문자 구분이라 원소 In(인듐)·Ta(탄탈럼)와 키워드 IN·Tau 는 충돌하지 않는다.
# 단일 소스(DEF-012): EQ_SCRIPT_KEYWORD 와 compact_chemical_spacing 은
# chem-pre/hwpx-gen.py 가 위임 스텁으로 재수출한다. 구현 수정은 이 파일에서만
# 하면 되고, scripts/eq_engine_diff.py 의 check_mirror_sync 가 검사한다.
EQ_SCRIPT_KEYWORD = (
    r"\b(?:BUILDREL|TIMES|DIV|APPROX|INF|DELTA|SIGMA|GAMMA|THETA|LAMBDA|XI|PI|"
    r"OMEGA|PHI|PSI|LEFT|RIGHT|IN|DEG|CASES|"
    r"ANGSTROM|ASYMP|BOX|CHOOSE|COPROD|DOWNARROW|ELL|EXARROW|IMAG|IMATH|JMATH|"
    r"LARROW|LLL|LRARROW|OVERBRACE|RARROW|REIMAGE|REL|SQSUBSETEQ|SQSUBSET|"
    r"SQSUPSETEQ|SQSUPSET|TRIANGLED|UDARROW|UNDERBRACE|UPARROW|VERT|WP|"
    r"Alpha|Beta|Gamma|Delta|Epsilon|Zeta|Eta|Theta|Iota|Kappa|Lambda|Mu|Nu|"
    r"Xi|Pi|Rho|Sigma|Tau|Upsilon|Phi|Chi|Psi|Omega)\b"
)


def compact_chemical_spacing(script: str) -> str:
    text = str(script or "")
    protected: list[str] = []

    def _protect(match: re.Match[str]) -> str:
        protected.append(match.group(0))
        return f"\x00{len(protected) - 1}\x00"

    # 인용 리터럴("percent difference", "Part A")은 통째로 보호한다 —
    # 내부의 대문자·공백을 화학식 압축이 이어 붙이면 안 된다.
    text = re.sub(r'"[^"]*"', _protect, text)
    text = re.sub(EQ_SCRIPT_KEYWORD, _protect, text)
    token = r"(?:[A-Z][a-z]?|\)(?:_\{[^}]+\})?)(?:_\{[^}]+\})?"
    text = re.sub(rf"({token})\s+(?=[A-Z][a-z]?|\()", r"\1", text)
    return re.sub(r"\x00(\d+)\x00", lambda m: protected[int(m.group(1))], text)


# 첨자 본문에 이 키워드들이 토큰으로 들어 있으면 텍스트 라벨이 아니라 수학식이다
# (예: lim 의 `n rarrow inf` — hwip 엔진이 \to/\infty 를 rarrow/inf 로 변환).
# 이를 인용해 버리면 화살표·∞ 가 문자 그대로 노출되므로 인용에서 제외한다.
# 그리스 키워드도 포함한다 — \lambda_{\pi} 는 양 엔진 모두 `lambda_{pi}` 를
# 내는데, pi 를 라벨로 인용하면 π 첨자가 업라이트 문자열 "pi" 로 죽는다.
# 첨자 라벨이 그리스 문자 '이름'과 정확히 일치하는 경우는 사실상 그리스
# 기호 의도다(Q_{in}/T_{mid} 류 영어 라벨과 달리 충돌 사례가 없다).
_SUBSCRIPT_GREEK_TOKENS = frozenset(
    {
        "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta",
        "eta", "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu",
        "xi", "pi", "varpi", "rho", "varrho", "sigma", "varsigma", "tau",
        "upsilon", "phi", "varphi", "chi", "psi", "omega",
    }
)
_SUBSCRIPT_MATH_TOKENS = (
    frozenset(
        {
            "rarrow", "larrow", "lrarrow", "uparrow", "downarrow", "inf",
            "infty", "ldots", "cdots", "vdots", "ddots",
            # 미분 연산자 키워드 — 경계 첨자 ∂V/∂S(oint_{partial V}) 의 ∂ 가
            # partial 로 풀린 뒤 텍스트 라벨로 인용('"partial V"')되면 ∂ 기호가
            # 업라이트 문자열로 죽는다. nabla 도 같은 이유(_{nabla phi} 등).
            "partial", "nabla",
        }
    )
    | _SUBSCRIPT_GREEK_TOKENS
)
# 다른 토큰과 '함께' 나올 때만 수학식 신호인 관계·연산 키워드 — 경계조건 첨자
# (max_{1 leq k leq n}, sum_{d mid n}, sup_{x in A})가 통째로 텍스트 라벨로
# 인용되는 사고를 막는다. 단독 본문은 진짜 라벨일 수 있어(Q_{in}, T_{mid})
# 현행대로 인용을 유지한다.
_SUBSCRIPT_MATH_BOUNDARY_TOKENS = frozenset(
    {
        "leq", "geq", "neq", "mid", "nmid", "in", "notin", "times", "div",
        "cdot", "approx", "equiv", "sim", "simeq", "cong", "propto", "mapsto",
        "subset", "subseteq", "supset", "supseteq", "cup", "cap", "union",
        "inter", "prec", "succ", "plusminus", "minusplus",
    }
)


def quote_textual_subscripts(script: str) -> str:
    """Protect multi-letter subscript labels from HWP equation keywords.

    Hancom equation scripts treat words such as `pi` as symbols. A physics
    label like `I_{pivot}` can therefore render as `I_{πvot}` unless the label
    is entered as literal text. Numeric and single-letter subscripts remain
    mathematical variables.
    """
    def repl(match: re.Match[str]) -> str:
        body = match.group(1).strip()
        if not body or body.startswith('"') or body.startswith("'"):
            return match.group(0)
        textual_label = re.fullmatch(
            r"(?=.*[A-Za-z])[A-Za-z0-9]+(?:[,\s_-]+[A-Za-z0-9]+)*",
            body,
        )
        if textual_label and len(body) >= 2:
            tokens = re.split(r"[,\s_-]+", body)
            lowered = {t.lower() for t in tokens}
            if lowered & _SUBSCRIPT_MATH_TOKENS:
                return match.group(0)
            if len(tokens) >= 2 and lowered & _SUBSCRIPT_MATH_BOUNDARY_TOKENS:
                return match.group(0)
            return f'_{{"{body}"}}'
        return match.group(0)

    return re.sub(r"_\{([^{}]+)\}", repl, str(script or ""))


def convert_inline_radicals(script: str) -> str:
    r"""Render spelled-out / unicode radicals as the native HWP ``sqrt {...}``.

    The LaTeX path already turns ``\sqrt{...}`` into ``sqrt {...}`` via
    ``_replace_sqrt``. This is the safety net for the ``{{EQ:...}}`` (HWP-script)
    path and for any stray ``sqrt(...)`` / ``√(...)`` that reaches the final
    script, so chemistry formulas like ``[H+] = sqrt(Ka C)`` form a real radical
    instead of literal text. An already-native ``sqrt {...}`` is left untouched
    and an unbalanced ``sqrt(`` is left as-is (fail safe: never emits a body-less
    command).
    """
    if "√" not in script and not re.search(r"(?<![A-Za-z\\])sqrt\b", script):
        return script
    # Normalise the spelled-out name to the symbol, but never an already-native
    # ``sqrt {`` keyword nor a LaTeX ``\sqrt``.
    text = re.sub(
        r"(?<![A-Za-z\\])sqrt\b(?!\s*\{)", "√", script, flags=re.IGNORECASE
    )
    if "√" not in text:
        return text
    n = len(text)
    brackets = {"(": ")", "{": "}", "[": "]"}
    out: list[str] = []
    i = 0
    while i < n:
        if text[i] != "√":
            out.append(text[i])
            i += 1
            continue
        if out and (out[-1].isalnum() or out[-1] in ")]}"):
            out.append(" ")
        j = i + 1
        while j < n and text[j].isspace():
            j += 1
        if j < n and text[j] in brackets:
            opener = text[j]
            closer = brackets[opener]
            depth = 0
            k = j
            inner = None
            while k < n:
                if text[k] == opener:
                    depth += 1
                elif text[k] == closer:
                    depth -= 1
                    if depth == 0:
                        inner = text[j + 1:k]
                        i = k + 1
                        break
                k += 1
            if inner is not None:
                if opener == "[":
                    # LaTeX 식 n제곱근 지수: sqrt[3]{x} / √[3](8) 의 [..] 는
                    # radicand 가 아니라 지수다. 바로 뒤(공백 허용)에 그룹이
                    # 따라오면 builtin _replace_sqrt 와 동일한 'root n of {...}'
                    # 구조로 변환한다. 그룹이 없으면(√[2gh] 단독) 현행대로
                    # [..] 를 radicand 로 본다.
                    p = i
                    while p < n and text[p].isspace():
                        p += 1
                    if p < n and text[p] in ("{", "("):
                        g_open = text[p]
                        g_close = brackets[g_open]
                        g_depth = 0
                        q = p
                        radicand = None
                        while q < n:
                            if text[q] == g_open:
                                g_depth += 1
                            elif text[q] == g_close:
                                g_depth -= 1
                                if g_depth == 0:
                                    radicand = text[p + 1:q]
                                    break
                            q += 1
                        if radicand is not None:
                            out.append(
                                "root "
                                + inner.strip()
                                + " of {"
                                + radicand.strip()
                                + "}"
                            )
                            i = q + 1
                            continue
                out.append("sqrt {" + inner.strip() + "}")
                continue
            out.append("√")  # unbalanced — fail safe
            i += 1
            continue
        atom = re.match(
            r"([A-Za-z0-9.]+(?:_\{[^{}]*\}|\^\{[^{}]*\}|\^[A-Za-z0-9])?)", text[j:]
        )
        if atom:
            out.append("sqrt {" + atom.group(1) + "}")
            i = j + atom.end()
            continue
        out.append("√")
        i += 1
    return "".join(out)


# 다중적분 스택('{∫∫∫}', 연속 '∫∫')을 한컴 키워드로 — 단일 글리프 치환보다 먼저.
_RAW_INTEGRAL_STACK_HWP = (
    (re.compile(r"\{\s*∮\s*∮\s*\}"), " oint "),
    (re.compile(r"\{\s*∫\s*∫\s*∫\s*\}"), " tint "),
    (re.compile(r"\{\s*∫\s*∫\s*\}"), " dint "),
    (re.compile(r"∫\s*∫\s*∫"), " tint "),
    (re.compile(r"∫\s*∫"), " dint "),
)

# 유니코드 수식 글리프 → 한컴 수식 키워드. {{EQ:}}(raw 한컴 스크립트) 경로는
# 엔진을 안 거치므로 여기서 직접 키워드로 바꾼다. 키워드는 앞뒤 공백으로
# 패딩해 글자 융합('E∂x'→'E partial x')을 막는다(잉여 공백은 말미 정리가 거둠).
_RAW_UNICODE_MATH_HWP = (
    ("∇", " nabla "),
    ("▽", " nabla "),
    ("∂", " partial "),
    ("∑", " sum "),
    ("∏", " prod "),
    ("∭", " tint "),
    ("∬", " dint "),
    ("∮", " oint "),
    ("∯", " oint "),
    ("∰", " oint "),
    ("∫", " int "),
    ("·", " cdot "),
    ("∙", " cdot "),
    ("⋅", " cdot "),
    ("×", " times "),
    ("±", " +- "),
    ("∓", " -+ "),
    ("≡", " == "),
    ("≅", " cong "),
    # 관계 연산자 — raw {{EQ:}} 가 글리프째 노출되지 않게 키워드로(LaTeX 경로와 일치).
    ("≤", " <= "),
    ("≥", " >= "),
    ("≠", " != "),
    ("≃", " simeq "),
    ("≪", " << "),
    ("≫", " >> "),
    ("∥", " parallel "),
    ("⊥", " bot "),
    ("∠", " angle "),
    ("∆", " DELTA "),  # U+2206 INCREMENT — 대문자 Δ 대용
    ("∝", " propto "),
    ("∞", " inf "),
    ("∈", " in "),
    ("∉", " notin "),
    ("⟨", " langle "),
    ("⟩", " rangle "),
    # 보조 수식 글리프 → 한컴 키워드. raw {{EQ:}} 경로는 엔진을 안 거치므로
    # 글리프째 노출되지 않게 직접 키워드로 바꾼다. 각 키워드가 normalize_hwp_script
    # 통과 후 따옴표 없이 남음을 실측 확인했다.
    ("ℏ", " hbar "),
    ("ℓ", " ell "),
    ("Å", " ANGSTROM "),  # U+212B 옹스트롬 기호
    ("Å", " ANGSTROM "),  # U+00C5 Å(라틴 A+고리)
    ("∴", " therefore "),
    ("∵", " because "),
    ("⊗", " otimes "),
    ("⊕", " oplus "),
    ("∅", " emptyset "),
    ("∼", " sim "),
    ("÷", " div "),
    # 그리스 소문자 → 한컴 키워드(소문자). 빌트인 COMMANDS·hwip 출력과 일치.
    ("α", " alpha "), ("β", " beta "), ("γ", " gamma "), ("δ", " delta "),
    ("ε", " epsilon "), ("ϵ", " epsilon "), ("ζ", " zeta "), ("η", " eta "),
    ("θ", " theta "), ("ϑ", " theta "), ("ι", " iota "), ("κ", " kappa "),
    ("λ", " lambda "), ("μ", " mu "), ("ν", " nu "), ("ξ", " xi "),
    ("ο", " o "), ("π", " pi "), ("ϖ", " pi "), ("ρ", " rho "),
    ("ϱ", " rho "), ("σ", " sigma "), ("ς", " sigma "), ("τ", " tau "),
    ("υ", " upsilon "), ("φ", " phi "), ("ϕ", " phi "), ("χ", " chi "),
    ("ψ", " psi "), ("ω", " omega "),
    # 그리스 대문자 → 한컴 키워드(대문자, 빌트인 COMMANDS 표기와 일치).
    ("Γ", " GAMMA "), ("Δ", " DELTA "), ("Θ", " THETA "), ("Λ", " LAMBDA "),
    ("Ξ", " XI "), ("Π", " PI "), ("Σ", " SIGMA "), ("Φ", " PHI "),
    ("Ψ", " PSI "), ("Ω", " OMEGA "), ("Υ", " UPSILON "),
)


def _normalize_raw_unicode_math(text: str) -> str:
    """{{EQ:}} raw 스크립트의 유니코드 수식 글리프를 한컴 키워드로 정규화.

    이미 한컴 인용('"..."') 안의 텍스트는 절대 건드리지 않는다(사용자가
    일부러 넣은 리터럴 보존). 인용 밖 구간에서만 스택/단일 글리프를 치환한다.
    idempotent — 글리프가 다 사라진 2회차 입력은 그대로 통과한다.
    """
    if not text:
        return text

    def _convert_segment(seg: str) -> str:
        # 유니코드 위/아래첨자를 ^{}/_{} 로 먼저 묶는다 — 글리프(∇/∂/ε)가 아직
        # raw 일 때 돌려야 ∇²→∇^{2}→(글리프 치환 후) nabla^{2}, ε₀→epsilon_{0}
        # 가 된다. idempotent(이미 ^{2} 면 무변).
        seg = _convert_unicode_scripts(seg)
        for pattern, kw in _RAW_INTEGRAL_STACK_HWP:
            seg = pattern.sub(kw, seg)
        for glyph, kw in _RAW_UNICODE_MATH_HWP:
            if glyph in seg:
                seg = seg.replace(glyph, kw)
        return seg

    # 인용 구간('"..."')은 보존하고 그 사이만 변환한다.
    out: list[str] = []
    for idx, part in enumerate(re.split(r'("[^"]*")', text)):
        out.append(part if idx % 2 == 1 else _convert_segment(part))
    return "".join(out)


# 인라인 나눗셈 a / b 를 {a} over {b} (한컴 분수 스택)로 바꾼다. 피연산자(factor)는
# '/' 에 인접한 한 덩어리만: 괄호/중괄호 균형군 | (partial|nabla)[첨자]+원자(∂B,∂²f)
# | 첨자 달린 원자(epsilon_{0}, r^{2}, I_{"cm"}). 앞 곱(μ₀ε₀ ∂E/∂t)이나 합(a + b/c)은
# 인접 factor만 잡아 b/c·∂E/∂t 만 분수가 된다. 단일 패스라 a/b/c 는 앞쪽만 처리.
_OVER_SCRIPTS = r"(?:\^\{[^}]*\}|_\{[^}]*\}|[_^][A-Za-z0-9])*"
# 중괄호 1단계 중첩 허용({Phi_{B}}) — 미분 dΦ_B/dt 의 피연산자가 braced 일 때.
_OVER_BRACED = r"\{(?:[^{}]|\{[^{}]*\})*\}"
# 소수(9.8, 0.0933)는 원자 토큰으로 보호한다 - 원자가 [A-Za-z0-9]+ 뿐이면
# '9.8/105' 의 분자가 '8' 로만 잡혀 '9.{8} over {105}' 처럼 소수점이 쪼개지고
# 정수부 '9.' 가 분수 밖에 남는다(R0 phys-atwood 실측, DEF-018 D-2).
_OVER_NUMBER = r"\d+\.\d+"
_OVER_ATOM = rf"(?:{_OVER_BRACED}|(?:{_OVER_NUMBER}|[A-Za-z0-9]+){_OVER_SCRIPTS})"
_OVER_FACTOR = (
    r"(?:"
    # \left( … \right) 통짜 — LEFT/RIGHT 키워드를 쪼개 잡으면 '{tau} over {LEFT}'
    # 류 파손 분수가 된다(퍼저 실측). 내부에 괄호가 또 있으면 매칭을 포기하고
    # 아래 blocklist 가드가 슬래시를 살린다.
    r"LEFT\s*\([^()]*?RIGHT\s*\)"
    r"|LEFT\s*\[[^\[\]]*?RIGHT\s*\]"
    r"|\([^()]*\)"                                   # (4 pi epsilon_{0})
    # 연산자 접두(partial|nabla) + 원자 — ∂B/∂t, ∂²f/∂x² 가 한 factor 로. (d 는
    # 미분이자 거리 변수라 모호 → 일반 factor 엔 안 넣고 아래 미분비 전처리에서만.)
    rf"|(?:partial|nabla)(?:\^\{{[^}}]*\}}|_\{{[^}}]*\}})?\s+{_OVER_ATOM}"
    # 1인자 장식/제곱근 + 인자 통짜 — 'sqrt {x} / 2' 의 분자는 {x} 가 아니라
    # sqrt {x} 전체다. 인자만 떼면 √(x/2) 로 의미가 바뀐다(양 엔진 공통 실측).
    rf"|(?:sqrt|vec|hat|bar|ddot|dot|tilde|dyad)\s*{_OVER_BRACED}"
    rf"|{_OVER_ATOM}"                                # epsilon_{0}, r^{2}, {묶인군}
    r")"
)
_SLASH_OVER_RE = re.compile(rf"(?<![A-Za-z0-9_])({_OVER_FACTOR})\s*/\s*({_OVER_FACTOR})")

# 슬래시 분수의 피연산자가 될 수 없는 구조 키워드 — 'X / int_{a}^{T} …' 를
# 접으면 적분 기호만 분모로 삼켜 피적분항이 고아가 된다(퍼저 실측). 이런
# 조합은 슬래시를 그대로 두는 것이 맞다. partial/nabla 는 미분 접두라 제외.
_OVER_BLOCK_OPERANDS = frozenset(
    """LEFT RIGHT over atop CHOOSE root of cases matrix pmatrix bmatrix
    dmatrix int oint dint tint qint sum prod lim REL BUILDREL OVERBRACE
    UNDERBRACE""".split()
)
_OVER_OPERAND_WORD_RE = re.compile(rf"[ \t]*([A-Za-z]+){_OVER_SCRIPTS}[ \t]*$")
# 분자 직전이 1인자 키워드(sqrt/vec…)나 첨자 마커면 그 {…} 는 키워드의 인자다
# — 인자만 분자로 떼면 의미가 바뀐다. factor 대안으로 통짜를 먼저 잡지만,
# root n of {x} 처럼 대안이 못 잡는 형태의 마지막 안전망.
_OVER_ARG_TAKERS = frozenset(
    """sqrt vec hat bar dot ddot tilde acute grave check dyad under rm it
    bold root of over atop CHOOSE""".split()
)
_OVER_TAIL_ARGTAKER_RE = re.compile(r"(?:\b([A-Za-z]+)|([_^]))[ \t]*$")
# hwip 낱자 분해 재접합 — 'd t / X' 의 분자가 t 만 잡혀 d 가 고아가 된다.
# 미분비(dX/dY)는 _DIFF_RATIO_RE 가 먼저 처리하므로, 그 뒤 잔여 'd 낱자 /'
# 만 빌트인('dt/X')과 같은 경계로 붙인다. 첨자(t^{2})가 껴도 잡는다.
_SPLIT_DIFF_NUM_RE = re.compile(
    r"(?<![A-Za-z0-9_}])d[ \t]+([A-Za-z])"
    r"(?=(?:\^\{[^}]*\}|_\{[^}]*\})*[ \t]*/)"
)


def _operand_blocked(operand: str) -> bool:
    m = _OVER_OPERAND_WORD_RE.fullmatch(operand)
    return bool(m) and m.group(1) in _OVER_BLOCK_OPERANDS
# 미분비 dX/dY · ∂X/∂Y : 양쪽이 모두 d/partial/nabla 로 시작할 때만 묶는다. d 를
# 한쪽만 보고 미분으로 처리하면 mgdT²/(4π²) 의 거리 d 까지 분리되므로(실측), 양쪽
# 동시 조건으로 진짜 도함수만 잡는다. 접두에 첨자(∂²) 허용, 피연산자 braced 허용.
_DIFF_TERM = (
    rf"(?:partial|nabla|d)(?:\^\{{[^}}]*\}}|_\{{[^}}]*\}})?\s+{_OVER_ATOM}"
)
_DIFF_RATIO_RE = re.compile(
    rf"(?<![A-Za-z0-9_])({_DIFF_TERM})\s*/\s*({_DIFF_TERM})"
)

# ── 단위 슬래시 가드 (DEF-018 D-3) ──────────────────────────────────────────
# 'ΔH (kJ/mol)' 표 헤더가 hwip 를 거치면 글자가 낱개 토큰으로 풀려('k J / m o l')
# 슬래시 분수화가 단어 중간을 쪼갠다('k {J} over {m} o l', R0 free-1 실측).
# kJ/mol, g/mL, rad/s, m/s 같은 '단위/단위' 표기는 분수 스택이 아니라 슬래시
# 그대로 두는 것이 맞다. 아래 보수 조건에서만 분수화를 건너뛴다:
#   (B) 양쪽 다 순수 문자 토큰(숫자·첨자·중괄호 없음, 1~4글자)이고 한쪽이 두
#       글자 이상 - 다글자 순수 문자 피연산자는 사실상 단위(mol, rad, kg)다.
#       단 그리스 이름(rho, tau, pi …)은 수식 변수라서 단위로 보지 않는다.
#   (A) 피연산자가 한 글자인데 슬래시 반대편 밖 바로 옆에 또 다른 '한 글자'
#       토큰이 나란히 있으면(k J / m o l 의 J·m) 낱개로 풀린 단어의 일부다.
#   (C) 한 글자/한 글자라도 바로 앞 토큰이 숫자면(1.47 m/s) 측정값 뒤 단위다.
# d/t, g/M 같은 고립 한 글자 변수비, rho/epsilon_{0}, T^{2}/(4pi^{2}) 등
# 첨자·괄호 낀 진짜 수식 분수는 종전대로 분수화된다.
_UNIT_WORD_RE = re.compile(r"[A-Za-z]{1,4}")
_GREEK_UNIT_EXCEPTIONS = frozenset(
    "pi chi phi psi eta rho tau mu nu xi beta zeta iota".split()
)
_LONE_LETTER_BEFORE_RE = re.compile(r"(?<![A-Za-z0-9_{}])[A-Za-z][ \t]+$")
_LONE_LETTER_AFTER_RE = re.compile(r"^[ \t]+[A-Za-z](?![A-Za-z0-9_^{])")
# (C)의 '앞 숫자' - 여는 괄호/중괄호 바로 뒤의 한 자리 숫자(sqrt {2 h / g},
# (2 h / g))는 측정값이 아니라 분수 계수이므로 제외한다. 측정값(1.47, 9.8,
# 47)은 마지막 자리 앞이 숫자나 소수점이라 이 예외에 걸리지 않는다.
_NUMBER_BEFORE_RE = re.compile(r"(?<![{(])\d[ \t]+$")


def _looks_like_unit_slash(seg: str, m: "re.Match[str]") -> bool:
    num, den = m.group(1), m.group(2)
    # (D) 거듭제곱 단위: m/s^{2}, kg/m^{3} — 분모가 '순수 문자+숫자 지수'이고
    #     측정 문맥(닫는 괄호·숫자·공백 명령 ~/`) 바로 뒤면 단위 표기다.
    #     (9.79 +- 0.05) ~ m/s^{2} 가 분수 스택으로 서는 것을 막는다.
    #     수식 본문의 F/m^{2} 류는 앞이 연산자/등호라 걸리지 않는다.
    den_power = re.fullmatch(r"([A-Za-z]{1,3})\^\{\d{1,2}\}", den.strip())
    if (
        den_power
        and _UNIT_WORD_RE.fullmatch(num)
        and num.lower() not in _GREEK_UNIT_EXCEPTIONS
        and den_power.group(1).lower() not in _GREEK_UNIT_EXCEPTIONS
        and re.search(r"[)\d~`][ \t]*$", seg[: m.start(1)])
    ):
        return True
    if not _UNIT_WORD_RE.fullmatch(num) or not _UNIT_WORD_RE.fullmatch(den):
        return False
    if num.lower() in _GREEK_UNIT_EXCEPTIONS or den.lower() in _GREEK_UNIT_EXCEPTIONS:
        return False
    if len(num) >= 2 or len(den) >= 2:
        return True  # (B) 다글자 순수 문자 = 단위 표기
    before = seg[: m.start(1)]
    after = seg[m.end(2):]
    if _LONE_LETTER_BEFORE_RE.search(before) or _LONE_LETTER_AFTER_RE.match(after):
        return True  # (A) 낱개로 풀린 단어 내부
    if _NUMBER_BEFORE_RE.search(before):
        return True  # (C) 숫자 측정값 바로 뒤 단위
    return False


def convert_slash_to_over(script: str) -> str:
    if "/" not in script:
        return script

    def _repl(m: "re.Match[str]") -> str:
        # 단위 표기(kJ/mol 류)는 슬래시를 살린다 - DEF-018 D-3 가드.
        if _looks_like_unit_slash(m.string, m):
            return m.group(0)
        # 구조 키워드 피연산자(int/sum/LEFT …)는 접으면 파손 — 슬래시 유지.
        if _operand_blocked(m.group(1)) or _operand_blocked(m.group(2)):
            return m.group(0)
        # 직전이 1인자 키워드/첨자 마커면 이 {…} 는 그 인자 — 분수화 금지.
        tail = _OVER_TAIL_ARGTAKER_RE.search(m.string[: m.start(1)])
        if tail and (tail.group(2) or tail.group(1) in _OVER_ARG_TAKERS):
            return m.group(0)
        return "{%s} over {%s}" % (m.group(1), m.group(2))

    def _seg(seg: str) -> str:
        if "/" not in seg:
            return seg
        # 미분비(dX/dY)를 먼저 묶고, 나머지 일반 나눗셈을 처리한다.
        seg = _DIFF_RATIO_RE.sub(r"{\1} over {\2}", seg)
        if "/" not in seg:
            return seg
        # hwip 낱자 분해 잔여('d t / X')를 빌트인과 같은 경계('dt / X')로 접합.
        seg = _SPLIT_DIFF_NUM_RE.sub(lambda m: "d" + m.group(1), seg)
        return _SLASH_OVER_RE.sub(_repl, seg)

    # 인용("...") 안의 단위(J/(mol·K) 등)·텍스트는 분수로 만들지 않는다.
    out = []
    for idx, part in enumerate(re.split(r'("[^"]*")', script)):
        out.append(part if idx % 2 == 1 else _seg(part))
    return "".join(out)


# ── 무따옴표 안정 표기(dequote) ──────────────────────────────────────────
# 편집기 왕복 실측(2026-07-12): 문서 초기 렌더러는 "..." 를 리터럴로 그리지만
# 한컴 수식 편집기는 넣기 시 따옴표를 일반 글자로 취급하고 내용을 재토큰화
# 한다 — "sup" 이 “”(sup 이 위첨자 연산자로 소모)로, "inf" 가 “∞”로 깨진다.
# 반면 키워드 단어(pi·approx·sqrt…)와 낱자 분해 표기는 왕복 안전하다(사용자
# 실보고서 2503codex_단진자.hwpx 의 편집기 제작 수식 19개에서 확인 — 전부
# 무따옴표·키워드 유지). 그래서 최종 스크립트의 따옴표를 안정 표기로 푼다:
#   · 한글/비ASCII·키워드 없는 단어(kg·mol·out·percent) → 알몸 그대로
#   · 함수명 키워드(max·lim·log…) → 알몸 키워드(업라이트 함수 렌더)
#   · 키워드를 품은 단어(pivot⊃pi, in, sup) → 빈 그룹 삽입 'p{}i{}v{}o{}t'
#     (2026-07-13 한컴 실측: 낱자+공백 'p i v o t' 는 편집기 넣기가 'pivot'
#      으로 재결합해 재오픈 시 문서 렌더러가 πvot 로 그린다. 빈 그룹 {} 은
#      각 글자를 렌더 안 보이는 그룹 경계로 나눠 그리디 렉싱을 원천 차단하고
#      편집기 재결합도 막는다 — I_{p{}ivot} → pivot 정상 렌더 직접 확인.)
#   · 단어 사이 실제 공백 → ~ (한컴 일반 공백)
#   · 구조 문자(#&^_`~"\)가 든 본문 → 인용 유지(희귀, 안전 우선. 단 중괄호
#     {} 는 아래에서 직접 삽입하므로 unsafe 목록에서 뺀다)
#
# 한컴 렉싱 위험 판정용 키워드(대소문자 구분, 2글자 이상). 검증용 파서
# (hwp_script_parser.KEYWORDS)와 취지는 같지만 여기선 '알몸으로 두면 기호로
# 바뀔 수 있는가'의 보수적 안전판이다 — 과잉 포함은 낱자 분해가 늘 뿐 무해.
_HANCOM_LEX_KEYWORDS = frozenset(
    """alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota
    kappa lambda mu nu xi omicron pi varpi rho varrho sigma varsigma tau
    upsilon phi varphi chi psi omega Gamma GAMMA Delta DELTA Theta THETA
    Lambda LAMBDA Xi XI Pi PI Sigma SIGMA Upsilon UPSILON Phi PHI Psi PSI
    Omega OMEGA Alpha Beta Epsilon Zeta Eta Iota Kappa Mu Nu Omicron Rho Tau
    Chi sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth ln
    log lg lim Lim max min exp Exp det gcd mod arg deg dim ker hom Pr sup
    inf INF over atop CHOOSE sqrt root of cases matrix pmatrix bmatrix
    dmatrix smallmatrix LEFT RIGHT REL BUILDREL vec hat bar dot ddot tilde
    acute grave check under dyad bold rm it not times TIMES div DIV cdot
    plusminus minusplus approx APPROX equiv leq geq neq sim simeq cong
    propto prec succ asymp in IN owns notin subset supset subseteq supseteq
    union inter cup cap sqcap sqcup emptyset aleph uplus oplus ominus otimes
    odot oslash vee wedge circ bullet ast star partial nabla forall exist
    exists therefore because diamond angle triangle dagger ddagger top bot
    models vdash prime hbar int oint dint tint qint sum prod DEG ANGSTROM
    ELL cdots ldots vdots ddots larrow rarrow lrarrow LARROW RARROW LRARROW
    uparrow downarrow udarrow mapsto hookleft hookright VERT""".split()
)
# 알몸으로 두어도 업라이트 함수명으로 렌더되는 키워드 — 라벨 "max" 등은
# 이대로 두는 쪽이 보기 좋다(∞/∈ 처럼 기호로 바뀌는 sup/inf/in 은 제외).
_DEQUOTE_FUNC_WORDS = frozenset(
    """sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth ln
    log lg lim max min exp det gcd mod arg deg dim ker hom Pr""".split()
)
# 인용 본문에 이 문자가 있으면 dequote 하지 않고 인용을 유지한다(희귀·안전
# 우선). 중괄호 {} 는 _split_keyword_run 이 직접 삽입하는 정상 출력 문자이자
# 인용 본문에 원래 없으므로 목록에서 뺀다 — 넣으면 방금 만든 {} 가 재진입
# 시 인용 유지로 되돌아가지만, dequote 는 인용을 없앤 뒤라 재진입이 없다.
_DEQUOTE_UNSAFE_CHARS = set('#&^_\\`~"')


def _word_hits_hancom_keyword(word: str) -> bool:
    """비인용 글자 런을 한컴 그리디 렉서가 기호로 오해할 수 있는가."""
    n = len(word)
    i = 0
    while i < n:
        for j in range(n, i + 1, -1):
            piece = word[i:j]
            if len(piece) >= 2 and piece in _HANCOM_LEX_KEYWORDS:
                return True
        i += 1
    return False


def _split_keyword_run(word: str) -> str:
    """키워드를 품은 글자 런의 모든 인접 글자 사이에 빈 그룹 {} 을 끼운다.

    한컴 문서 렌더러는 비인용 글자 런을 부분문자열 최장 일치로 렉싱해
    'pivot' 의 'pi' 를 π 로, 'initial' 의 'in' 을 ∈ 로 바꾼다. 빈 그룹 {}
    은 화면에 안 보이는 그룹 경계라, 글자 사이마다 끼우면 어떤 2글자도
    인접하지 못해 키워드 매칭이 원천 차단된다(2026-07-13 실측: I_{p{}ivot}
    → pivot 정상).

    '최소 삽입'(위험 키워드 경계에만 {})은 삽입이 새 인접쌍을 만들어 또
    다른 키워드가 생기는 함정이 있다 — 'initial' 을 in·it 로 끊으면 'ni'
    (한컴 owns 기호 ∋)가 새로 생겨 T_{i∃tial} 로 깨졌다(실측). 전 글자
    분리는 이 부류의 2차 파손을 구조적으로 없앤다. 빈 그룹은 렌더·구조
    동치성 모두 무해하므로(파서가 낱자 분해와 equal 로 인정) 대가가 없다.
    """
    return "{}".join(word)


def _dequote_word(word: str) -> str:
    if word in _DEQUOTE_FUNC_WORDS:
        return word
    if re.fullmatch(r"[A-Za-z]+", word) and _word_hits_hancom_keyword(word):
        return _split_keyword_run(word)  # 빈 그룹 전 글자 분리 — 렉싱·재결합 차단
    return word


def dequote_script(script: str) -> str:
    """인용 리터럴("...")을 편집기 왕복 안전 표기로 푼다."""
    if '"' not in script:
        return script

    def _wordy(w: str) -> bool:
        # '단어'(눈에 보이는 공백을 사이에 둘 대상) — 2글자 이상 또는 비ASCII
        # (한글은 한 글자도 단어). 낱자 분해된 알파벳 1글자는 토큰 구분용
        # 공백만 두면 붙어 보인다(한컴 공백은 렌더되지 않음).
        return len(w) >= 2 or any(ord(c) > 127 for c in w)

    def _repl(m: "re.Match[str]") -> str:
        body = m.group(1)
        if not body.strip():
            return " "
        if any(c in _DEQUOTE_UNSAFE_CHARS for c in body):
            return m.group(0)  # 구조 문자 포함 — 인용 유지가 안전
        words = [w for w in body.split(" ") if w]
        parts: list[str] = []
        for i, w in enumerate(words):
            if i and _wordy(words[i - 1]) and _wordy(w):
                parts.append("~")
            parts.append(_dequote_word(w))
        return " " + " ".join(parts) + " "

    return re.sub(r'"([^"]*)"', _repl, script)


def normalize_hwp_script(script: str) -> str:
    text = str(script or "").strip()
    text = _normalize_raw_unicode_math(text)
    # tint(∭)/dint(∬)/qint 키워드는 한컴 '본문' 렌더러가 글자 그대로 노출한다
    # (수식 편집기에선 ∭로 보이지만 본문에선 'tint' 텍스트 — 실측 확인 2026-06-15).
    # int/oint 은 본문에서 정상 렌더되므로 int 반복(∫∫∫/∫∫)으로 바꾼다. 이는
    # 다중적분의 표준 표기이기도 하다. \iiint→hwip 'tint'·∭→raw 'tint' 등 모든
    # 경로가 normalize 를 지나므로 여기 한 곳에서 처리하면 충분하다.
    text = re.sub(r"(?<![A-Za-z])qint(?![A-Za-z])", "int int int int", text)
    text = re.sub(r"(?<![A-Za-z])tint(?![A-Za-z])", "int int int", text)
    text = re.sub(r"(?<![A-Za-z])dint(?![A-Za-z])", "int int", text)
    # 백슬래시 없는 LaTeX 적분 키워드(iiint/iint/oiint)가 raw 스크립트에 들어오면
    # HWP 본문이 글자로 노출한다 — int 반복/oint 으로(iiint 먼저: iint 가 부분일치
    # 안 되게). \iiint→hwip 은 tint 거쳐 이미 처리되나, raw {{EQ:}} 에 모델/재구성이
    # iiint 를 직접 넣는 경우의 안전망.
    text = re.sub(r"(?<![A-Za-z])iiint(?![A-Za-z])", "int int int", text)
    text = re.sub(r"(?<![A-Za-z])iint(?![A-Za-z])", "int int", text)
    text = re.sub(r"(?<![A-Za-z])oiint(?![A-Za-z])", "oint", text)
    text = convert_inline_radicals(text)
    # 'root N of {X}' 는 한컴 문법이 아니다 — root 가 sqrt 동의어로 동작해
    # √N + 이탤릭 'of' + X 로 깨진다(렌더 시트 S1-10·S2-87 실측). 한컴에서
    # n제곱근은 빈 밑 위첨자 + sqrt 조합('{}^{N} sqrt {X}')으로 그린다.
    # 빈 밑 {} 이 있어야 위첨자가 앞 항의 지수로 붙지 않는다.
    text = re.sub(
        r"(?<![A-Za-z])root[ \t]+(?:\{(?P<braced>[^{}]*)\}|(?P<bare>[A-Za-z0-9]+))"
        r"[ \t]+of(?![A-Za-z])[ \t]*",
        lambda m: "{}^{" + (m.group("braced") or m.group("bare")) + "} sqrt ",
        text,
    )
    # 'lnot'(소문자)은 한컴 키워드가 아니다 — 문서 렌더러가 ln+otp 로 쪼갠다
    # (렌더 시트 S2-92 실측). 정준 키워드는 대문자 LNOT — 편집기 왕복 XML
    # 에서 확인했고(¬→LNOT 재직렬화) 문서 렌더러도 ¬p 로 정상 렌더(3라운드
    # after S1-9 실측). ¬ 글리프 입력도 같은 키워드로 접는다.
    text = re.sub(r"(?<![A-Za-z])lnot(?![A-Za-z])", " LNOT ", text)
    text = text.replace("¬", " LNOT ")
    # OVERBRACE/UNDERBRACE 는 한컴 키워드가 아니다 — 어느 인자 형태든 수식이
    # 통째로 빈 렌더가 된다(렌더 시트 2라운드 S1-9~11 실측: 2인자·후첨자·
    # 단일 인자 전멸). 내용 소실이 가장 나쁘므로 우아한 강등을 택한다:
    # 겹브레이스는 윗줄(bar)+위첨자 라벨로, 밑브레이스는 본문+아래첨자 라벨로.
    text = re.sub(  # hwip 2인자형: OVERBRACE {라벨} {본문}
        r"OVERBRACE[ \t]*\{(?P<l>[^{}]*)\}[ \t]*\{(?P<b>[^{}]*)\}",
        r"bar {\g<b>}^{\g<l>}",
        text,
    )
    text = re.sub(
        r"UNDERBRACE[ \t]*\{(?P<l>[^{}]*)\}[ \t]*\{(?P<b>[^{}]*)\}",
        r"{\g<b>}_{\g<l>}",
        text,
    )
    # 잔여(빌트인 후첨자형 'OVERBRACE {a+b}^{n}'·단일 인자) — 키워드만 강등.
    text = re.sub(r"(?<![A-Za-z])OVERBRACE(?![A-Za-z])", "bar", text)
    text = re.sub(r"(?<![A-Za-z])UNDERBRACE(?![A-Za-z])[ \t]*", "", text)
    text = (
        # '=>' 는 한컴에서 ⇒ 가 아니라 '=' '>' 두 글자로 렌더된다(렌더 시트
        # S1-3 실측) — 겹줄 화살표는 키워드 RARROW 로.
        text.replace("→", "->")
        .replace("⟶", "->")
        .replace("⇒", " RARROW ")
        .replace("←", "<-")
        .replace("⇌", "<->")
        .replace("↔", "<->")
        .replace("⇄", "<->")
    )
    text = re.sub(
        r"--\s*\[\s*(?P<label>[^\]]+?)\s*\]\s*(?P<arrow><->|<=>|->|<-|=>)",
        r"BUILDREL \g<arrow> {\g<label>}",
        text,
    )
    text = re.sub(
        r"(?P<arrow><->|<=>|->|<-|=>)\s*\[\s*(?P<label>[^\]]+?)\s*\]",
        r"BUILDREL \g<arrow> {\g<label>}",
        text,
    )
    text = text.replace("<=>", "<->")
    # 비례 기호: 모델이 약어 'prop' 을 쓰면 한컴이 ∝ 로 못 읽고 'prop' 글자로 렌더된다.
    # 정식 키워드 'propto'(=∝)로 교정. (\bprop\b 라 'propto'·'property' 는 안 건드림)
    text = re.sub(r"\bprop\b", "propto", text)
    # hwip 의 빈 구분자(LEFT. / RIGHT. — \left. evaluated-at 표기)는 한컴
    # 수용이 검증되지 않아 'LEFT.' 리터럴 노출 위험이 있다 — 구분자째
    # 제거한다(키워드+마침표 조합은 소수점과 혼동될 수 없다). 제거로
    # LEFT/RIGHT 짝이 깨지면 남은 키워드도 내리고 구분자만 남긴다 —
    # 미짝 키워드가 글자로 노출되는 것보다 괄호 자동크기 포기가 안전하다.
    if re.search(r"\b(?:LEFT|RIGHT)\s*\.", text):
        stripped = re.sub(r"\b(?:LEFT|RIGHT)\s*\.", " ", text)
        if len(re.findall(r"\bLEFT\b", stripped)) != len(
            re.findall(r"\bRIGHT\b", stripped)
        ):
            stripped = re.sub(r"\b(?:LEFT|RIGHT)\b\s*", "", stripped)
        text = stripped
    text = re.sub(r"\s+([_^])\s*", r"\1", text)
    text = brace_unbraced_scripts(text)
    text = quote_textual_subscripts(text)
    text = compact_chemical_spacing(text)
    text = convert_slash_to_over(text)
    # 따옴표 리터럴 → 무따옴표 안정 표기(편집기 왕복 안전). 반드시 위의
    # 인용 보호 패스들(compact/slash) 뒤, 공백 정리 앞에서 실행한다.
    text = dequote_script(text)
    # 리터럴 중괄호 센티널(preprocess 가 균형 \{\} 를 ⟬⟭ 로 보냄) → 스트레치
    # 중괄호. hwip 이 비ASCII 를 인용해도 dequote 가 먼저 벗겨 준다.
    text = text.replace("⟬", " LEFT{ ").replace("⟭", " RIGHT} ")
    text = re.sub(r"\b(APPROX|TIMES|DIV)(?=[A-Za-z0-9{])", r"\1 ", text)
    text = re.sub(r"(?<=[A-Za-z0-9}])(?=(APPROX|TIMES|DIV)\b)", " ", text)
    text = re.sub(r"\s{2,}", " ", text)
    text = _balance_brace_groups(text)
    return text.strip()


# ── hwip 엔진 브리지 (LaTeX → 한컴 수식 스크립트) ──────────────────────────
# vendor/hwip-converter.js (latex-to-hwp by 신민규 @minigu5, 사용 허락 받음 —
# vendor/NOTICE 참조)를 node 로 호출해 변환 품질을 올린다. 한컴 공식 명세 기반
# 파서라 빌트인 문자열 치환기보다 \cdot(내적), \left/\right(괄호 자동크기),
# \text{한글} 인용 등에서 정확하다.
#
# 동작 원칙:
#  - {{EQ-LATEX:}} / {{EQN-LATEX:}} 만 hwip 우선, 실패한 식은 빌트인 변환기 폴백.
#  - {{EQ:}}(이미 한컴 스크립트) 경로는 건드리지 않는다.
#  - node 실행 불가/오류 → 프로세스 단위로 조용히 비활성(빌트인 폴백). 최종
#    fatal 검증(validate_hwpx_equations)은 기존 정책 그대로 유지된다.
#  - EQUATION_ENGINE=builtin (또는 off) 으로 즉시 롤백 가능. 기본값은 hwip.
_HWIP_CLI = Path(__file__).resolve().parent / "vendor" / "hwip-cli.js"
_hwip_cache: dict[str, str] = {}
_hwip_failed: set[str] = set()
_hwip_disabled = False


# hwip 이 구조를 오조립하는 입력은 식 단위로 빌트인만 쓴다:
# - n제곱근 \sqrt[n]{x}: hwip 은 '^{n} sqrt {x}' 로 내는데 앞에 항이 있으면
#   (2\sqrt[3]{8}) ^{n} 이 그 항의 지수로 붙어 2³√8 로 렌더된다(구조 검사로
#   발견). 빌트인 경로는 normalize 가 '{}^{n} sqrt {x}' 로 정규화한다.
# - 리터럴 중괄호 \{ \}: hwip 토크나이저가 그룹 여닫이로 삼켜 집합 기호가
#   증발한다(렌더 시트 S2-114 실측). 빌트인은 인용 리터럴("{")로 낸다.
_HWIP_UNSAFE_RE = re.compile(r"\\sqrt\s*\[|\\[{}]|\\[lr]brace(?![A-Za-z])")


def hwip_engine_enabled() -> bool:
    if os.environ.get("EQUATION_ENGINE", "hwip").strip().lower() in (
        "builtin",
        "off",
        "0",
    ):
        return False
    return not _hwip_disabled and _HWIP_CLI.exists()


def hwip_convert_batch(latex_list: Iterable[str]) -> None:
    """unique LaTeX 들을 node 1회 호출로 변환해 캐시에 채운다(성공분만).

    실패(null)·오류는 빌트인 폴백으로 흘러가므로 이 함수는 절대 예외를 던지지
    않는다. 문서당 1회 프리워밍 + 캐시 미스 시 단건 호출 양쪽에서 쓰인다.
    """
    global _hwip_disabled
    if not hwip_engine_enabled():
        return
    todo = [
        t
        for t in dict.fromkeys(s.strip() for s in latex_list if s and s.strip())
        if t not in _hwip_cache
        and t not in _hwip_failed
        and not _HWIP_UNSAFE_RE.search(t)  # latex_to_script 의 빌트인 우회와 한 쌍
    ]
    if not todo:
        return
    try:
        proc = subprocess.run(
            ["node", str(_HWIP_CLI)],
            input=json.dumps({"latex": todo}).encode("utf-8"),
            capture_output=True,
            timeout=30,
        )
        scripts = json.loads(proc.stdout.decode("utf-8", "replace"))["scripts"]
        if len(scripts) != len(todo):
            raise ValueError("hwip output length mismatch")
        for tex, script in zip(todo, scripts):
            if isinstance(script, str) and script.strip():
                _hwip_cache[tex] = script.strip()
            else:
                _hwip_failed.add(tex)
    except Exception as exc:  # node 없음/타임아웃/깨진 출력 → 빌트인으로
        _hwip_disabled = True
        print(
            f"[equation] hwip engine unavailable, using builtin converter: {exc}",
            file=sys.stderr,
        )


def _expand_mhchem_body(body: str) -> str:
    """mhchem 반응식 본문을 일반 LaTeX 로 — 첨자·전하·화살표를 살린다."""
    s = body.strip()
    # 반응 화살표 (평형 먼저, 그다음 정/역방향)
    s = re.sub(r"<=>>|<<=>|<=>|<->", r" \\leftrightarrow ", s)
    s = re.sub(r"->", r" \\rightarrow ", s)
    s = re.sub(r"<-(?!>)", r" \\leftarrow ", s)
    # 원소 기호 뒤 숫자 = 아래첨자 (선두 계수 '2H2O'의 2 는 평문 유지)
    s = re.sub(r"(?<=[A-Za-z\)\]])(\d+)", r"_{\1}", s)
    # 전하: ^2+, ^-, ^+ → ^{...} (이미 ^{...} 인 것은 그대로)
    s = re.sub(r"\^(\d*[+-])", r"^{\1}", s)
    return s


def _expand_pu_body(body: str) -> str:
    r"""mhchem ``\pu{...}`` (물리량+단위) 본문을 일반 LaTeX 로 전개한다.

    평문 본문은 ``\text{...}`` 로 감싸 업라이트 단위 표기(한컴 인용 리터럴)로
    살리고, 구조가 섞인 본문은 명령 래퍼만 벗긴다 — 어느 쪽이든 'pu' 가
    글자로 노출되지 않는다. mhchem 고유 표기는 최소만 정규화한다:
    ``//`` 는 나눗셈, 단위 글자 사이 ``.``/``*`` 는 곱(·)이다.
    """
    s = re.sub(r"\s+", " ", body.strip())
    if not s:
        return " "
    s = s.replace("//", "/")
    s = re.sub(r"(?<=[A-Za-z])[.*](?=[A-Za-z])", "·", s)
    if not re.search(r'[\\^_{}"$&#%]', s):
        return r" \text{" + s + "} "
    return f" {s} "


_MHCHEM_COMMANDS = (("\\ce", _expand_mhchem_body), ("\\pu", _expand_pu_body))


def expand_mhchem(latex: str) -> str:
    r"""``\ce{...}``/``\pu{...}`` (mhchem) 를 양 엔진이 이해하는 일반 LaTeX 로
    전개한다.

    latex_to_script() 진입 직전의 단일 길목이라 hwip·빌트인 모두에 적용된다.
    이 전처리가 없으면 hwip 은 ce/pu 를 일반 함수로 취급해 'H2'의 2 가 본문
    숫자로, '->' 가 '`-` `>`' 두 연산자로, 단위가 글자 단위(k J / m o l)로
    분해되고, 빌트인은 raw \ce 가 백슬래시째 잔존한다.
    """
    if not any(cmd in latex for cmd, _expander in _MHCHEM_COMMANDS):
        return latex
    out: list[str] = []
    i = 0
    n = len(latex)
    while i < n:
        matched = None
        if latex[i] == "\\":
            for cmd, expander in _MHCHEM_COMMANDS:
                if latex.startswith(cmd, i) and not (
                    i + len(cmd) < n and latex[i + len(cmd)].isalpha()
                ):
                    matched = (cmd, expander)
                    break
        if matched is not None:
            cmd, expander = matched
            j = i + len(cmd)
            while j < n and latex[j].isspace():
                j += 1
            if j < n and latex[j] == "{":
                depth = 0
                k = j
                body = None
                while k < n:
                    char = latex[k]
                    if char == "\\":
                        k += 2
                        continue
                    if char == "{":
                        depth += 1
                    elif char == "}":
                        depth -= 1
                        if depth == 0:
                            body = latex[j + 1 : k]
                            break
                    k += 1
                if body is not None:
                    out.append(expander(body))
                    i = k + 1
                    continue
        out.append(latex[i])
        i += 1
    return "".join(out)


# 유니코드 화살표 → LaTeX 명령 선치환 표. 엔진 '출력' 후의 치환
# (normalize_hwp_script)만으로는 늦다 — hwip 이 미지의 유니코드 글리프를
# 텍스트 인용('"⇌"')으로 감싼 뒤에는 치환이 따옴표 안에 떨어져 화살표 기호
# 대신 리터럴 문자열 '<->' 가 렌더된다. 진입 전에 LaTeX 명령으로 바꾸면
# hwip 은 lrarrow/rarrow(네이티브 토큰), builtin 은 <->/-> 를 낸다.
_UNICODE_ARROW_LATEX = (
    ("⇌", r" \leftrightarrow "),
    ("⇄", r" \leftrightarrow "),
    ("↔", r" \leftrightarrow "),
    ("⟶", r" \rightarrow "),
    ("→", r" \rightarrow "),
    ("←", r" \leftarrow "),
    ("⇒", r" \Rightarrow "),
)

# 모델이 LaTeX 본문에 섞어 쓴 다중적분 '스택' 표기 → 정식 LaTeX 명령.
# 단일 글리프(∬∭) 치환보다 먼저 적용해야 '{∫∫∫}' 가 '\int\int\int' 로
# 갈라지지 않는다. 중괄호로 감싼 형태와 연속 글리프(공백 허용) 둘 다 잡는다.
_UNICODE_INTEGRAL_STACK_LATEX = (
    (re.compile(r"\{\s*∮\s*∮\s*\}"), r" \oint "),
    (re.compile(r"\{\s*∫\s*∫\s*∫\s*\}"), r" \iiint "),
    (re.compile(r"\{\s*∫\s*∫\s*\}"), r" \iint "),
    (re.compile(r"∫\s*∫\s*∫"), r" \iiint "),
    (re.compile(r"∫\s*∫"), r" \iint "),
)

# 그리스 글리프 → LaTeX 명령(어간). LaTeX/raw 두 경로가 공유한다 — hwip 은
# 일부 그리스(α/β/γ/δ/θ/λ/μ/π/σ/τ/ω 및 다수 대문자)를 미지 글리프로 보고
# 인용('"μ"')으로 감싸 버린다. 진입 전에 \명령으로 바꿔 인용 누출을 0으로 한다.
# (어간은 builtin COMMANDS 와 hwip vendor 표가 모두 아는 표준 명령만 쓴다.)
_GREEK_TO_LATEX_STEM = (
    ("α", "alpha"), ("β", "beta"), ("γ", "gamma"), ("δ", "delta"),
    ("ε", "epsilon"), ("ϵ", "epsilon"), ("ζ", "zeta"), ("η", "eta"),
    ("θ", "theta"), ("ϑ", "theta"), ("ι", "iota"), ("κ", "kappa"),
    ("λ", "lambda"), ("μ", "mu"), ("ν", "nu"), ("ξ", "xi"),
    ("π", "pi"), ("ϖ", "pi"), ("ρ", "rho"), ("ϱ", "rho"),
    ("σ", "sigma"), ("ς", "sigma"), ("τ", "tau"), ("υ", "upsilon"),
    ("φ", "phi"), ("ϕ", "phi"), ("χ", "chi"), ("ψ", "psi"), ("ω", "omega"),
    ("Α", "Alpha"), ("Β", "Beta"), ("Γ", "Gamma"), ("Δ", "Delta"),
    ("Ε", "Epsilon"), ("Ζ", "Zeta"), ("Η", "Eta"), ("Θ", "Theta"),
    ("Ι", "Iota"), ("Κ", "Kappa"), ("Λ", "Lambda"), ("Μ", "Mu"),
    ("Ν", "Nu"), ("Ξ", "Xi"), ("Ο", "Omicron"), ("Π", "Pi"),
    ("Ρ", "Rho"), ("Σ", "Sigma"), ("Τ", "Tau"), ("Υ", "Upsilon"),
    ("Φ", "Phi"), ("Χ", "Chi"), ("Ψ", "Psi"), ("Ω", "Omega"),
)

# 유니코드 수식 글리프 → 정식 LaTeX 명령 선치환 표. 엔진(hwip/builtin)
# 진입 '전'에 LaTeX 명령으로 바꿔야 한다 — hwip 은 미지의 유니코드 글리프를
# 텍스트 인용('"∇"', '"ρ"')으로 감싸 버려 수식 기호 대신 따옴표 리터럴이
# 렌더된다. LaTeX 명령으로 바꾸면 hwip/builtin 모두 정상 키워드를 낸다.
# 화살표는 _UNICODE_ARROW_LATEX 가 따로 처리한다(중복 금지).
_UNICODE_MATH_LATEX = (
    # 연산자
    ("∇", r" \nabla "),
    ("▽", r" \nabla "),  # U+25BD 흰 삼각형 — 모델이 nabla 대용으로 씀
    ("∂", r" \partial "),
    ("∑", r" \sum "),
    ("∏", r" \prod "),
    ("∭", r" \iiint "),
    ("∬", r" \iint "),
    ("∮", r" \oint "),
    ("∯", r" \oint "),  # U+222F 면적분
    ("∰", r" \oint "),  # U+2230 체적분
    ("∫", r" \int "),
    ("·", r" \cdot "),
    ("∙", r" \cdot "),  # U+2219 BULLET OPERATOR — 모델의 내적 대용
    ("⋅", r" \cdot "),  # U+22C5 DOT OPERATOR — 정식 곱셈 점
    ("×", r" \times "),
    ("±", r" \pm "),  # U+00B1 — 측정 불확도(9.81 ± 0.05)에 빈출
    ("∓", r" \mp "),
    ("≡", r" \equiv "),
    ("≅", r" \cong "),
    # 관계 연산자 — 누락 시 hwip 이 '"≤"' 따옴표 리터럴로 떨군다.
    ("≤", r" \leq "),
    ("≥", r" \geq "),
    ("≠", r" \neq "),
    ("≃", r" \simeq "),
    ("≪", r" \ll "),
    ("≫", r" \gg "),
    ("∥", r" \parallel "),
    ("⊥", r" \perp "),
    ("∠", r" \angle "),
    ("∆", r" \Delta "),  # U+2206 INCREMENT — 대문자 Δ(U+0394) 대용으로 씀
    ("∝", r" \propto "),
    ("∞", r" \infty "),
    ("∈", r" \in "),
    ("∉", r" \notin "),
    ("⟨", r" \langle "),
    ("⟩", r" \rangle "),
    # 보조 수식 글리프 — 누락 시 hwip 이 '"ℏ"'/'"÷"' 따옴표 리터럴로 떨군다.
    # 각 명령은 양 엔진이 따옴표 없는 키워드(hbar/ELL/ANGSTROM/therefore…)로
    # 변환함을 실측 확인했다. ÷ 는 LaTeX 의 정식 나눗셈 명령 \div 으로 보낸다.
    ("ℏ", r" \hbar "),       # U+210F PLANCK CONSTANT OVER 2 PI — 양자 빈출
    ("ℓ", r" \ell "),        # U+2113 SCRIPT SMALL L — 길이/각운동량 라벨
    ("Å", r" \AA "),    # U+212B ANGSTROM SIGN — 원자 길이 단위
    ("Å", r" \AA "),    # U+00C5 Å(라틴 A+고리) — 모델이 옹스트롬 대용으로 씀
    ("∴", r" \therefore "),
    ("∵", r" \because "),
    ("⊗", r" \otimes "),
    ("⊕", r" \oplus "),
    ("∅", r" \emptyset "),
    ("∼", r" \sim "),        # U+223C TILDE OPERATOR — 근사/비례 대용
    ("÷", r" \div "),
    # 소문자 오미크론은 LaTeX 명령(\omicron)이 없고 라틴 'o'와 동일 — 그냥 'o'.
    ("ο", " o "),
    # 그리스(빌트인 COMMANDS·hwip 누락분 — 중복은 무해)
    *((glyph, f" \\{stem} ") for glyph, stem in _GREEK_TO_LATEX_STEM),
)


# 유니코드 위/아래첨자 글리프 → 평문 숫자/부호(LaTeX ^{...}/_{...} 본문용).
# 'ⁿ'·'ⁱ'(U+207F/U+2071)도 포함 — 모델이 s⁻¹ 외에 xⁿ·eⁱ 류를 쓴다.
_SUPERSCRIPT_TO_LATEX = str.maketrans({
    "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
    "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
    "⁺": "+", "⁻": "-", "ⁿ": "n", "ⁱ": "i",
})
_SUBSCRIPT_TO_LATEX = str.maketrans({
    "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
    "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
    "₊": "+", "₋": "-",
})
# 유니코드 위첨자(연산자/지수 첨자)·아래첨자(라벨 첨자)의 '소속 문자' 분류용.
_SUPERSCRIPT_CHARS = "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿⁱ"
_SUBSCRIPT_CHARS = "₀₁₂₃₄₅₆₇₈₉₊₋"
# 첨자 직전의 '밑'이 될 수 없는 문자 — 공백/첨자 자신/여는 구분자. 그 외
# 어떤 문자(라틴·숫자·유니코드 연산자 ∇∂·그리스 ε 등) 뒤든 첨자로 묶는다.
# (유니코드 연산자 글리프 치환 '전에' 돌려 ∇²→∇^{2}→(이후)\nabla^{2} 가 되게 한다.)
_UNI_SUPERSCRIPT_RE = re.compile(
    rf"(?<=[^\s{_SUPERSCRIPT_CHARS}{{(\[^_])([{_SUPERSCRIPT_CHARS}]+)"
)
_UNI_SUBSCRIPT_RE = re.compile(
    rf"(?<=[^\s{_SUBSCRIPT_CHARS}{{(\[_^])([{_SUBSCRIPT_CHARS}]+)"
)


def _convert_unicode_scripts(s: str) -> str:
    """유니코드 위/아래첨자를 LaTeX ^{...}/_{...} 로. idempotent.

    선행문자(밑)가 있을 때만 묶는다 — 식 맨 앞 고립 첨자는 변환하지 않아
    2회차(이미 ^{2} 인 입력)에서 '2' 가 또 첨자로 잡히지 않는다. 유니코드
    연산자 치환 '전에' 호출해야 ∇²·∂² 가 밑(∇/∂) 째로 ∇^{2}·∂^{2} 로 묶인다.
    """
    s = _UNI_SUPERSCRIPT_RE.sub(
        lambda m: "^{" + m.group(1).translate(_SUPERSCRIPT_TO_LATEX) + "}", s
    )
    s = _UNI_SUBSCRIPT_RE.sub(
        lambda m: "_{" + m.group(1).translate(_SUBSCRIPT_TO_LATEX) + "}", s
    )
    return s


# 유니코드 치환에서 보호할 LaTeX 평문 명령 — 본문이 단위·라벨 리터럴이라
# '·'(mol·K) 등을 \cdot 으로 바꾸면 단위 표기가 깨진다(mhchem \pu 전개 산물).
_PROTECTED_TEXT_CMD_RE = re.compile(
    r"\\(?:text|textrm|textnormal|textbf|textit|mathrm|mathit|mathbf|mbox|operatorname)\s*\{"
)


def _apply_unicode_math_latex(s: str) -> str:
    r"""인용('"..."')·평문명령(\text{...}/\mathrm{...}) 바깥에서만 유니코드 치환.

    mhchem \pu 전개가 만든 \text{8.314 J/(mol·K)} 의 '·' 같은 리터럴 단위
    표기를 \cdot 으로 바꾸지 않도록, 보호 구간은 통째로 건너뛰고 그 밖의
    구간에서만 스택/단일 글리프를 LaTeX 명령으로 강등한다.
    """

    def _convert(seg: str) -> str:
        # 유니코드 위/아래첨자를 '밑'(연산자 글리프 포함)에 묶어 ^{...}/_{...} 로
        # 먼저 강등한다. 연산자 글리프 치환보다 앞서야 ∇²→∇^{2}→\nabla^{2}.
        seg = _convert_unicode_scripts(seg)
        for pattern, command in _UNICODE_INTEGRAL_STACK_LATEX:
            seg = pattern.sub(lambda _m, _c=command: _c, seg)
        for glyph, command in _UNICODE_MATH_LATEX:
            if glyph in seg:
                seg = seg.replace(glyph, command)
        return seg

    out: list[str] = []
    i = 0
    n = len(s)
    plain_start = 0  # 아직 변환 안 한 일반 구간의 시작
    while i < n:
        ch = s[i]
        # 한컴/리터럴 인용 보존
        if ch == '"':
            j = s.find('"', i + 1)
            if j < 0:
                break  # 짝 없는 따옴표 — 말미에서 통째 변환
            out.append(_convert(s[plain_start:i]))
            out.append(s[i : j + 1])
            i = plain_start = j + 1
            continue
        # \text{...}/\mathrm{...} 등 평문 인자 그룹 보존(중괄호 짝 맞춰 통째로)
        m = _PROTECTED_TEXT_CMD_RE.match(s, i)
        if m:
            depth = 0
            k = m.end() - 1  # '{' 위치
            while k < n:
                c = s[k]
                if c == "\\":
                    k += 2
                    continue
                if c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        k += 1
                        break
                k += 1
            out.append(_convert(s[plain_start:i]))
            out.append(s[i:k])
            i = plain_start = k
            continue
        i += 1
    out.append(_convert(s[plain_start:]))
    return "".join(out)


def preprocess_latex_body(raw_latex: str) -> str:
    """엔진 공통 LaTeX 전처리 — mhchem 전개 + \\limits 제거 + 유니코드 화살표 선치환.

    latex_to_script() 와 hwip 프리워밍이 같은 전처리를 거쳐야 캐시 키가
    일치한다 — 반드시 이 함수를 같이 쓸 것.
    """
    s = expand_mhchem(str(raw_latex or "").strip())
    # \limits/\nolimits 는 연산자 첨자의 '위치' 힌트일 뿐 그릴 내용이 없다.
    # hwip 은 미지 명령을 그대로 흘려 '\sum\limits_{...}' 가 'sum limits_{...}'
    # 로 새고 첨자가 limits 단어에 붙으므로 양 엔진 진입 전에 떼어낸다
    # (빌트인 COMMANDS 의 매핑은 {{EQ:}} 백슬래시 구제 등 convert 직접 호출
    # 경로용 이중 안전망).
    s = re.sub(r"\\(?:no)?limits(?![A-Za-z])", " ", s)
    # 닫힌 면/체적분 \oiint/\oiiint 는 한컴에 단일 'oint' 만 있다. 빌트인
    # COMMANDS 는 이미 oint 로 매핑하지만 hwip vendor 는 'oiint'(한컴 비키워드
    # → 글자 노출)를 내므로, 양 엔진 진입 전 \oint 로 정규화해 hwip 출력도
    # oint 로 맞춘다. (\iint/\iiint 는 hwip 이 dint/tint 로 정상 변환하므로 둠.)
    s = re.sub(r"\\oi+nt(?![A-Za-z])", r"\\oint", s)
    # \sup(상한)/\inf(하한) — 한컴에서 'sup' 은 위첨자 연산자라 수식 전체가
    # 빈 렌더로 증발하고(렌더 시트 S2-51·S2-68 실측), 'inf' 는 ∞ 로 그려져
    # 의미가 바뀐다(S1-1 실측). 함수명은 인용 리터럴로 강등한다 — \text{}
    # 경유로 양 엔진 모두 "sup"/"inf" 업라이트 텍스트를 낸다. (\infty 는
    # 뒤에 글자가 이어져 매칭되지 않고, \liminf 류는 백슬래시 직후가 아니라
    # 안전하다.)
    s = re.sub(r"\\(sup|inf)(?![A-Za-z])", r"\\text{\1}", s)
    # \intercal(전치 A^⊤ 표기) — hwip 은 미지 명령을 그대로 흘려 위첨자에
    # 'intercal' 영단어가 렌더된다. 양 엔진 진입 전 평문 T 로 강등한다
    # (빌트인 COMMANDS 의 T 매핑과 동일 결과, 구조 동치성 검사로 발견).
    s = re.sub(r"\\intercal(?![A-Za-z])", "{T}", s)
    # 리터럴 중괄호 \{ \} — 짝이 맞으면 센티널 글리프(⟬⟭)로 바꿔 양 엔진을
    # 통과시킨 뒤 normalize 가 스트레치 중괄호 LEFT{ RIGHT} 로 되살린다
    # (렌더 시트 2라운드 S1-4 실측: LEFT{ RIGHT} 정상 렌더, 인용("{")보다
    # 편집기 왕복에 안전). 짝이 안 맞으면 그대로 두어 빌트인 인용 폴백
    # (+_HWIP_UNSAFE_RE 의 hwip 우회)으로 흐른다.
    s = re.sub(r"\\lbrace(?![A-Za-z])", r"\\{", s)
    s = re.sub(r"\\rbrace(?![A-Za-z])", r"\\}", s)
    if s.count(r"\{") and s.count(r"\{") == s.count(r"\}"):
        s = s.replace(r"\{", " ⟬ ").replace(r"\}", " ⟭ ")
    # align/gather 계열 환경 — 빌트인은 matrix 로 접지만 hwip 은 내용만 남겨
    # 정렬 & 와 행 구분 # 이 환경 밖 알몸으로 노출된다(한컴 렌더 미보장).
    # 양 엔진 진입 전 matrix 로 정규화해 출력 구조를 일치시킨다. alignat
    # 계열은 뒤따르는 {n} 인자가 셀로 새므로 제외(보고서 산출물 미관측).
    s = re.sub(
        r"\\(begin|end)\{(?:aligned|align\*?|gathered|gather\*?|split)\}",
        r"\\\1{matrix}",
        s,
    )
    for glyph, command in _UNICODE_ARROW_LATEX:
        if glyph in s:
            s = s.replace(glyph, command)
    # 유니코드 수식 글리프·다중적분 스택 → LaTeX 명령. 인용/평문 명령 본문
    # (\text{...mol·K...})은 보호한다. 반드시 mhchem 전개 뒤에 적용한다.
    s = _apply_unicode_math_latex(s)
    return s.strip()


def latex_to_script(raw_latex: str) -> str:
    """LaTeX → 한컴 스크립트. hwip 우선, 식 단위로 빌트인 폴백."""
    raw_latex = preprocess_latex_body(raw_latex)
    if hwip_engine_enabled() and not _HWIP_UNSAFE_RE.search(raw_latex):
        if raw_latex not in _hwip_cache and raw_latex not in _hwip_failed:
            hwip_convert_batch([raw_latex])
        script = _hwip_cache.get(raw_latex)
        if script is not None:
            return script
    return LatexToHwpConverter().convert(raw_latex)


EQ_MARKER_PREFIXES = ("{{EQN-LATEX:", "{{EQ-LATEX:", "{{EQN:", "{{EQ:")

# 근접 오타 마커 교정용. EQN 을 EQ 보다 앞에 둔다(긴 어간 우선).
# 잡는 변형: 소문자({{eq:), 콜론 앞뒤 공백({{EQN-LATEX :), 전각 콜론
# ({{EQ-LATEX：), 하이픈 누락/언더스코어/공백 구분({{EQLATEX:, {{EQ_LATEX:,
# {{EQ LATEX:), 단일 여는 중괄호({EQ-LATEX:). 콜론이 반드시 따라와야 매칭되어
# 일반 산문·한컴 스크립트 그룹({EQN} 등)은 건드리지 않는다.
# 단일 소스(DEF-012): 과거 chem-pre/hwpx-gen.py 에 있던 동일 미러는 위임
# 스텁으로 바뀌었다. 구현 수정은 이 파일에서만 하면 되고, scripts/
# eq_engine_diff.py 의 check_mirror_sync 가 스텁 동일성을 회귀로 검사한다.
_EQ_PREFIX_RESCUE_RE = re.compile(
    r"\{\{?\s*(EQN|EQ)\s*[-_]?\s*(LATEX)?\s*[:：]", re.IGNORECASE
)


def _canonical_eq_prefix(m: re.Match[str]) -> str:
    """교정 콜백 — 어간(EQ/EQN)과 LATEX 유무로 정규 프리픽스를 재조립한다.

    단일 중괄호 입력도 항상 '{{' 로 정규화한다(이후 스캐너가 인식하도록).
    """
    stem = m.group(1).upper()
    return "{{" + stem + ("-LATEX:" if m.group(2) else ":")


def canonicalize_equation_marker_prefixes(text: str) -> str:
    """마커 프리픽스의 흔한 오타를 정규형('{{EQ[-LATEX]:')으로 교정한다.

    오타 마커는 스캐너(prefixes 정확 일치)가 못 찾아 변환이 통째로 누락된다 —
    대문자 오타는 validate 의 '{{EQ' 검사에 걸려 보고서 전체가 fatal 나고,
    소문자는 아무도 못 잡아 본문에 조용히 노출된다. 변환 전에 정규형으로
    되살려 정상 경로로 태운다. (단일 중괄호 변형 {EQ-LATEX:...} 의 닫는
    중괄호 1개 부족은 lenient 스캐너의 외톨이 '}' 종결 규칙이 흡수한다.)
    """
    text = str(text or "")
    if "{" not in text:
        return text
    return _EQ_PREFIX_RESCUE_RE.sub(_canonical_eq_prefix, text)


def _delatexed_plain_text(text: str) -> str:
    """LaTeX 백슬래시·마커 프리픽스·수식 구분자($)를 제거한 안전한 평문."""
    text = re.sub(r"\{\{(?:EQN-LATEX|EQ-LATEX|EQN|EQ):", "", str(text or ""))
    text = re.sub(r"\\([A-Za-z]+)", r"\1 ", text)
    text = text.replace("\\", " ")
    text = re.sub(r"\$+", "", text)
    return re.sub(r"\s{2,}", " ", text).strip()


def _resolve_nested_markers(kind: str, body: str) -> str:
    """본문 안에 중첩된 {{EQ*:...}} 마커 문법을 풀어낸다(마커 잔존 금지).

    바깥 스캐너는 안쪽 '{{'를 중괄호 깊이로 흡수하므로 body 에 마커 리터럴이
    그대로 들어온다 — 그대로 두면 한컴 수식 안에 '{{EQ:b}}' 가 노출된다.
    안쪽 마커는 문법만 벗겨 본문으로 흡수한다(LaTeX ↔ 한컴 스크립트 혼용 시
    안쪽 본문을 먼저 변환해 잇는다).
    """
    inner = find_equation_placeholders(body, strict=False)
    out: list[str] = []
    cursor = 0
    for ph in inner:
        out.append(body[cursor : ph.start])
        inner_body = ph.body
        if "{{EQ" in inner_body:
            inner_body = _resolve_nested_markers(ph.kind, inner_body)
        if ph.kind.endswith("-LATEX") and not kind.endswith("-LATEX"):
            try:
                inner_body = latex_to_script(inner_body)
            except Exception:
                inner_body = _delatexed_plain_text(inner_body)
        out.append(inner_body)
        cursor = ph.end
    tail = body[cursor:]
    if "{{EQ" in tail:
        tail = re.sub(r"\{\{(?:EQN-LATEX|EQ-LATEX|EQN|EQ):", "", tail)
    out.append(tail)
    return "".join(out)


def placeholder_to_script(kind: str, raw_script: str) -> str:
    raw_script = canonicalize_equation_marker_prefixes(raw_script.strip())
    if "{{EQ" in raw_script:
        # 모델이 마커를 겹쳐 쓴 경우 — 안쪽 마커 문법을 풀어 본문으로 흡수.
        raw_script = _resolve_nested_markers(kind, raw_script)
    if kind.endswith("-LATEX"):
        return normalize_hwp_script(latex_to_script(raw_script))
    if "\\" in raw_script:
        # {{EQ:}}(한컴 스크립트) 경로에 LaTeX 명령이 섞여 들어온 모델 실수 —
        # 백슬래시 잔재가 수식에 노출되지 않도록 구제한다. 단, hwip
        # (latex_to_script)은 한컴 키워드(over/cases/rm/matrix)를 미지의
        # 단어로 보고 글자 단위로 분해하므로 절대 태우지 않는다 — 미지
        # 토큰을 보존하면서 \cmd 만 치환·제거하는 빌트인 변환기로만 구제한다.
        return normalize_hwp_script(LatexToHwpConverter().convert(raw_script))
    return normalize_hwp_script(raw_script)


def is_numbered_placeholder(kind: str) -> bool:
    return kind.startswith("EQN")


def _equation_body_to_plain_text(kind: str, body: str) -> str:
    """마커 본문을 안전한 평문으로 — 마커 문법·백슬래시 잔재를 남기지 않는다."""
    body = (body or "").strip()
    if not body:
        return ""
    try:
        script = placeholder_to_script(kind, body)
        if script.strip():
            return script
    except Exception:
        pass
    return _delatexed_plain_text(body)


def strip_equation_markers_for_text(text: str) -> str:
    """Return a readable plain-text fallback for malformed equation markers.

    Report generation should not fail just because one model-produced
    `{{EQ:...}}` span has unbalanced braces. 마커 구간만 외과적으로 처리한다:
    본문은 가능하면 한컴 스크립트 텍스트로 변환해 남기고(raw `\\frac` 잔재
    금지), 마커 밖의 '}}' 같은 일반 산문 중괄호는 절대 건드리지 않는다.
    """
    text = canonicalize_equation_marker_prefixes(str(text or ""))
    parts: list[str] = []
    cursor = 0
    for placeholder in _find_placeholders_lenient(text):
        parts.append(text[cursor : placeholder.start])
        parts.append(
            _equation_body_to_plain_text(placeholder.kind, placeholder.body)
        )
        cursor = placeholder.end
    parts.append(text[cursor:])
    return "".join(parts)


@dataclass(frozen=True)
class Placeholder:
    start: int
    end: int
    kind: str
    body: str


def find_equation_placeholders(text: str, strict: bool = True) -> list[Placeholder]:
    """Find {{EQ:...}} blocks while allowing balanced braces inside the body."""
    placeholders: list[Placeholder] = []
    pos = 0
    prefixes = EQ_MARKER_PREFIXES

    while True:
        starts = [
            (text.find(prefix, pos), prefix)
            for prefix in prefixes
            if text.find(prefix, pos) >= 0
        ]
        if not starts:
            return placeholders

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
                    placeholders.append(
                        Placeholder(start=start, end=i + 2, kind=kind, body=text[body_start:i])
                    )
                    pos = i + 2
                    break
                if depth > 0:
                    depth -= 1
                i += 1
                continue
            i += 1
        else:
            if strict:
                raise ValueError(f"Unclosed equation placeholder starting at index {start}.")
            return placeholders


def _scan_marker_body_lenient(text: str, body_start: int) -> tuple[str, int]:
    """마커 본문을 관대하게 읽는다(절대 예외를 던지지 않는다).

    종결자는 ① 깊이 0 의 '}}', ② 깊이 0 에서 공백/줄끝/다음 마커 직전의
    외톨이 '}' (닫는 중괄호 1개가 모자란 흔한 모델 실수), ③ 텍스트 끝.
    마커 밖의 중괄호는 절대 건드리지 않는다.
    """
    depth = 0
    i = body_start
    n = len(text)
    while i < n:
        char = text[i]
        if char == "\\":
            i += 2
            continue
        if char == "{":
            depth += 1
            i += 1
            continue
        if char == "}":
            if depth > 0:
                depth -= 1
                i += 1
                continue
            if i + 1 < n and text[i + 1] == "}":
                return text[body_start:i], i + 2
            nxt = text[i + 1 : i + 2]
            if nxt == "" or nxt.isspace() or text.startswith("{{EQ", i + 1):
                return text[body_start:i], i + 1
            i += 1
            continue
        i += 1
    return text[body_start:], n


def _find_placeholders_lenient(text: str) -> list[Placeholder]:
    """관대한 마커 탐색 — 잘 닫힌 마커는 strict 와 동일하게, 미폐합 마커는
    _scan_marker_body_lenient 의 종결 규칙으로 본문을 복구해 돌려준다."""
    placeholders: list[Placeholder] = []
    pos = 0
    while True:
        starts = [
            (text.find(prefix, pos), prefix)
            for prefix in EQ_MARKER_PREFIXES
            if text.find(prefix, pos) >= 0
        ]
        if not starts:
            return placeholders
        start, prefix = min(starts, key=lambda item: item[0])
        body, end = _scan_marker_body_lenient(text, start + len(prefix))
        placeholders.append(
            Placeholder(start=start, end=end, kind=prefix[2:-1], body=body)
        )
        pos = end


def _placeholder_replacement_runs(
    placeholder: Placeholder,
    run_attrs: dict[str, str],
    id_gen: IdGenerator,
    style: EquationStyle,
    context: ReplacementContext,
) -> list[ET.Element]:
    """마커 1개를 대체할 run 목록을 만든다(절대 예외를 던지지 않는다).

    - 빈 본문 마커({{EQ:}} 등)는 수식 객체 없이 제거한다 — 빈 hp:script 는
      validate_hwpx_equations 가 fatal 로 보기 때문이다.
    - 변환 예외·빈 변환 결과('$' 등)는 마커 문법을 벗긴 평문으로 강등한다.
      어떤 경우에도 raw 마커나 백슬래시 LaTeX 가 본문에 남지 않는다.
    """
    body = placeholder.body.strip()
    if not body:
        return []
    try:
        script = placeholder_to_script(placeholder.kind, placeholder.body)
    except Exception as exc:
        print(
            f"[hwpx-equation] equation conversion failed; kept as plain text: {exc}",
            file=sys.stderr,
        )
        script = ""
    if not script.strip():
        fallback = _delatexed_plain_text(body)
        return [make_text_run(fallback, run_attrs)] if fallback else []
    result = [make_equation_run(script, id_gen.next(), run_attrs, style=style)]
    if is_numbered_placeholder(placeholder.kind):
        number = context.next_equation_number
        context.next_equation_number += 1
        result.append(make_text_run(f" ({number})", run_attrs))
    return result


def split_text_into_runs(
    text: str,
    run_attrs: dict[str, str],
    id_gen: IdGenerator,
    style: EquationStyle,
    context: ReplacementContext | None = None,
) -> tuple[list[ET.Element], int]:
    result: list[ET.Element] = []
    count = 0
    cursor = 0
    context = context or ReplacementContext()

    for placeholder in find_equation_placeholders(text):
        before = text[cursor : placeholder.start]
        if before:
            result.append(make_text_run(before, run_attrs))

        result.extend(
            _placeholder_replacement_runs(
                placeholder, run_attrs, id_gen, style, context
            )
        )
        count += 1
        cursor = placeholder.end

    after = text[cursor:]
    if after:
        result.append(make_text_run(after, run_attrs))
    return result, count


def is_plain_text_run(elem: ET.Element) -> bool:
    # hp:t 가 자식 요소(lineBreak 등)를 가지면 텍스트 전용 재구성 대상이 아니다
    # — 부주의하게 재구성하면 자식 요소와 tail 텍스트가 통째로 사라진다.
    return (
        elem.tag == qname(HP_NS, "run")
        and len(elem) == 1
        and elem[0].tag == qname(HP_NS, "t")
        and len(elem[0]) == 0
    )


@dataclass(frozen=True)
class TextRunSpan:
    run: ET.Element
    text: str
    start: int
    end: int


def build_text_run_spans(runs: list[ET.Element]) -> list[TextRunSpan]:
    spans: list[TextRunSpan] = []
    pos = 0
    for run in runs:
        text = run[0].text or ""
        start = pos
        end = start + len(text)
        spans.append(TextRunSpan(run=run, text=text, start=start, end=end))
        pos = end
    return spans


def attrs_at_position(spans: list[TextRunSpan], pos: int) -> dict[str, str]:
    for span in spans:
        if span.start <= pos < span.end:
            return dict(span.run.attrib)
        if pos == span.start:
            return dict(span.run.attrib)
    if spans:
        return dict(spans[-1].run.attrib)
    return {}


def text_slice_to_runs(
    spans: list[TextRunSpan],
    start: int,
    end: int,
) -> list[ET.Element]:
    result: list[ET.Element] = []
    if start >= end:
        return result

    for span in spans:
        overlap_start = max(start, span.start)
        overlap_end = min(end, span.end)
        if overlap_start >= overlap_end:
            continue
        local_start = overlap_start - span.start
        local_end = overlap_end - span.start
        text = span.text[local_start:local_end]
        if text:
            result.append(make_text_run(text, dict(span.run.attrib)))
    return result


def replace_placeholders_in_run_group(
    runs: list[ET.Element],
    id_gen: IdGenerator,
    style: EquationStyle,
    context: ReplacementContext,
) -> tuple[list[ET.Element], int]:
    spans = build_text_run_spans(runs)
    text = "".join(span.text for span in spans)
    if "{{EQ" not in text:
        return runs, 0

    result: list[ET.Element] = []
    count = 0
    cursor = 0
    for placeholder in find_equation_placeholders(text):
        result.extend(text_slice_to_runs(spans, cursor, placeholder.start))
        run_attrs = attrs_at_position(spans, placeholder.start)
        result.extend(
            _placeholder_replacement_runs(
                placeholder, run_attrs, id_gen, style, context
            )
        )
        count += 1
        cursor = placeholder.end

    result.extend(text_slice_to_runs(spans, cursor, len(text)))
    if not result:
        # 그룹 전체가 빈 마커뿐이던 경우 — 문단이 비지 않게 빈 텍스트 run 유지
        result.append(make_text_run("", dict(runs[0].attrib) if runs else {}))
    return result, count


def replace_placeholders_in_run_group_lenient(
    runs: list[ET.Element],
    id_gen: IdGenerator,
    style: EquationStyle,
    context: ReplacementContext,
    anchors: list[tuple[int, ET.Element]] | None = None,
) -> tuple[list[ET.Element], int]:
    """Convert placeholders leniently — never raises.

    잘 닫힌 마커는 그대로 변환하고, 닫는 중괄호가 모자란 마커는 관대한 종결
    규칙으로 복구해 변환한다. 변환 불가 마커는 마커 문법만 벗긴 평문으로
    강등된다(_placeholder_replacement_runs). anchors(마커 본문을 가로지른
    비텍스트 run)는 마커 밖이면 제 위치에, 마커 안이면 수식 run 바로 뒤에
    보존한다 — 절대 버리지 않는다.
    """
    spans = build_text_run_spans(runs)
    text = "".join(span.text for span in spans)
    pending = sorted(anchors or [], key=lambda item: item[0])
    result: list[ET.Element] = []
    count = 0
    cursor = 0

    def emit_plain(upto: int) -> None:
        nonlocal cursor
        while pending and pending[0][0] <= upto:
            offset, elem = pending.pop(0)
            if offset > cursor:
                result.extend(text_slice_to_runs(spans, cursor, offset))
                cursor = offset
            result.append(elem)
        if upto > cursor:
            result.extend(text_slice_to_runs(spans, cursor, upto))
            cursor = upto

    for placeholder in _find_placeholders_lenient(text):
        emit_plain(placeholder.start)
        run_attrs = attrs_at_position(spans, placeholder.start)
        result.extend(
            _placeholder_replacement_runs(
                placeholder, run_attrs, id_gen, style, context
            )
        )
        count += 1
        cursor = placeholder.end
        # 마커 본문을 가로질렀던 비텍스트 run 은 수식 직후에 보존한다.
        while pending and pending[0][0] <= placeholder.end:
            result.append(pending.pop(0)[1])

    emit_plain(len(text))
    for _offset, elem in pending:
        result.append(elem)

    if not result:
        run_attrs = dict(runs[0].attrib) if runs else {}
        result.append(make_text_run(strip_equation_markers_for_text(text), run_attrs))
    return result, count


def _flatten_structured_text_run(run: ET.Element) -> list[ET.Element]:
    """<hp:t>a<lineBreak/>b</hp:t> 를 [a run, 요소 run, b run] 으로 분해한다.

    자식 요소는 자기만의 hp:t/run 에 보존되고(텍스트 없음 → 비텍스트 run 으로
    취급되어 anchor 브리지를 탄다), tail 텍스트는 평범한 텍스트 run 이 되어
    마커 스캐너가 볼 수 있게 된다.
    """
    attrs = dict(run.attrib)
    t = run[0]
    pieces: list[ET.Element] = []
    if t.text:
        pieces.append(make_text_run(t.text, attrs))
    for sub in list(t):
        tail = sub.tail
        sub.tail = None
        holder = ET.Element(qname(HP_NS, "run"), dict(attrs))
        holder_t = ET.SubElement(holder, qname(HP_NS, "t"))
        holder_t.append(sub)
        pieces.append(holder)
        if tail:
            pieces.append(make_text_run(tail, attrs))
    if not pieces:
        pieces.append(make_text_run("", attrs))
    return pieces


def _normalize_paragraph_text_nodes(para: ET.Element) -> bool:
    """마커 변환 전 문단 텍스트 정리. 반환값: 트리 변경 여부.

    - 마커 프리픽스 오타({{eq:, {{EQN-LATEX : 등)를 정규형으로 교정한다
      (hp:t 의 text 와 자식 요소의 tail 모두).
    - 문단에 마커가 있으면, 자식 요소(lineBreak 등)를 품은 hp:t 를 평문
      run + 요소 run 으로 분해한다 — tail 에 걸친 마커가 통째로 누락되거나
      재구성 과정에서 자식 요소·tail 이 삭제되는 블라인드를 없앤다.
    """
    changed = False
    run_tag = qname(HP_NS, "run")
    t_tag = qname(HP_NS, "t")

    def _is_text_shaped(run: ET.Element) -> bool:
        return run.tag == run_tag and len(run) == 1 and run[0].tag == t_tag

    for run in para:
        if not _is_text_shaped(run):
            continue
        t = run[0]
        fixed = canonicalize_equation_marker_prefixes(t.text or "")
        if fixed != (t.text or ""):
            t.text = fixed
            changed = True
        for sub in t:
            fixed_tail = canonicalize_equation_marker_prefixes(sub.tail or "")
            if fixed_tail != (sub.tail or ""):
                sub.tail = fixed_tail
                changed = True

    para_text = "".join(
        "".join(run[0].itertext()) for run in para if _is_text_shaped(run)
    )
    if "{{EQ" not in para_text:
        return changed

    index = 0
    while index < len(para):
        run = para[index]
        if _is_text_shaped(run) and len(run[0]):
            pieces = _flatten_structured_text_run(run)
            para.remove(run)
            for offset, piece in enumerate(pieces):
                para.insert(index + offset, piece)
            index += len(pieces)
            changed = True
            continue
        index += 1
    return changed


# ── 마커 없는 '변환 가능' 잔재 구제(최후 안전망) ────────────────────────────
# validate 의 잔재 검사(_LATEX_RESIDUE_RE/_HWP_SCRIPT_RESIDUE_RE)는 마커 없이
# 본문에 흘러나온 \frac{1}{2}, {실제} over 이론질량, sqrt {Ka over C} 같은
# 조각을 fatal 로 본다. 검출과 구제의 커버리지가 어긋나면 '변환 가능한' 입력이
# 구제 시도조차 없이 보고서 생성 전체를 죽이므로(가용성 사고), 마커 변환이
# 끝난 뒤 남은 잔재 중 변환 가능한 조각만 보수적으로(주변 산문 흡수 없이)
# 수식으로 구제한다. 변환이 정말 실패한 잔재만 validate 의 fatal 로 남는다.
_RESIDUE_BRACED = r"\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}"
_RESIDUE_WORD = r"[A-Za-z0-9.()!^_+\-가-힣]+"
_RESIDUE_LATEX_FRAGMENT_RE = re.compile(
    # \left...\right 짝과 \begin{env}...\end{env} 짝을 먼저(내부 \frac 포함
    # 통째로), 그다음 인자 있는 명령, 마지막에 외톨이 반쪽 순으로 잡는다.
    r"\\left\b.{0,200}?\\right\s*(?:\\[{}()|]|[()\[\]|.])?"
    r"|\\begin\s*\{([A-Za-z*]+)\}.{0,800}?\\end\s*\{\1\}"
    rf"|\\[dt]?frac\s*{_RESIDUE_BRACED}\s*{_RESIDUE_BRACED}"
    rf"|\\sqrt\s*(?:\[[^\[\]]*\]\s*)?{_RESIDUE_BRACED}"
    rf"|\\(?:text|ce)\s*{_RESIDUE_BRACED}"
    # \sum_{i=1}^{n} 처럼 첨자가 '_' 로 바로 붙는 형태도 잡는다(\b 는 word
    # char 인 '_' 앞에서 매칭되지 않으므로 (?![A-Za-z]) 를 쓴다).
    rf"|\\(?:sum|lim|int)(?![A-Za-z])(?:\s*[_^]\s*(?:{_RESIDUE_BRACED}|[A-Za-z0-9+\-]))*"
    r"|\\(?:left|right)\b\s*(?:\\[{}()|]|[()\[\]|.])?"
    r"|\\(?:begin|end)\b\s*\{[A-Za-z*]*\}"
)
_RESIDUE_HWP_FRAGMENT_RE = re.compile(
    rf"{_RESIDUE_BRACED}\s*over\b(?:\s*(?:{_RESIDUE_BRACED}|{_RESIDUE_WORD}))?"
    rf"|{_RESIDUE_WORD}\s*over\s*{_RESIDUE_BRACED}"
    rf"|\bover\s*{_RESIDUE_BRACED}"
    rf"|\bsqrt\s*{_RESIDUE_BRACED}"
)

# 본문(hp:t)에 보이면 안 되는 한컴 수식 스크립트 조각({1} over {2},
# sqrt {Ka over C}) — validate 의 잔재 검출용. 변환기/게이트
# (_RESIDUE_HWP_FRAGMENT_RE)와 같은 _RESIDUE_BRACED(중첩 3단) 빌딩블록을
# 공유한다. 과거 이 검출만 단일 레벨([^{}]*)이어서 'sqrt {x^{2}+1}' 같은
# 첨자 포함 조각이 구제 게이트에서도 막히고 검출에서도 침묵 통과해 raw
# 스크립트가 사용자에게 노출됐다. 검출이 구제보다 넓어지면(커버리지 역전)
# 변환 가능한 입력이 구제 시도 없이 fatal 나므로, 패턴을 넓힐 때는 반드시
# _RESIDUE_HWP_FRAGMENT_RE 가 같은 입력을 변환할 수 있는지 먼저 확인할 것
# (구제 ⊇ 검출 방향 유지).
_HWP_SCRIPT_RESIDUE_RE = re.compile(
    rf"{_RESIDUE_BRACED}\s*over\b"
    rf"|\bover\s*{_RESIDUE_BRACED}"
    rf"|\bsqrt\s*{_RESIDUE_BRACED}"
)

# 단독 LaTeX 기호 명령 → 유니코드/평문 강등 화이트리스트. 수식화(조각 래핑)
# 시도 후에도 남은, 인자 없는 기호 명령만 안전하게 평문 문자로 바꾼다 —
# \times 100, E = h\nu, \Delta G 처럼 frac/sqrt 류 구조가 없어 검출
# (_LATEX_RESIDUE_RE)도 구제(조각 래핑)도 못 잡던 사각의 보수적 폴백이다.
# '=' 포함 산문 전체를 수식으로 승격하는 공격적 방식은 오탐 위험으로 금지,
# 검출(fatal) 확대도 금지. 구조 명령(frac/sqrt/sum/lim/int …)과 미지 명령은
# 절대 넣지 않는다(미지 명령은 보존 — 조용한 의미 파괴 방지).
# 단일 소스(DEF-012): 과거 chem-pre/hwpx-gen.py 에 있던 동일 미러는 위임
# 스텁으로 바뀌었다. 구현 수정은 이 파일에서만 하면 되고, scripts/
# eq_engine_diff.py 의 check_mirror_sync 가 스텁 동일성을 회귀로 검사한다.
_BARE_LATEX_SYMBOL_MAP = {
    # 연산자/관계
    "times": "×", "cdot": "·", "div": "÷", "pm": "±", "mp": "∓",
    "approx": "≈", "sim": "~", "simeq": "≃", "cong": "≅", "equiv": "≡",
    "neq": "≠", "ne": "≠", "leq": "≤", "le": "≤", "geq": "≥", "ge": "≥",
    "ll": "≪", "gg": "≫", "propto": "∝", "infty": "∞", "partial": "∂",
    "nabla": "∇", "degree": "°", "circ": "°", "bullet": "•",
    "ldots": "…", "cdots": "⋯", "dots": "…", "prime": "′", "prod": "∏",
    # 화살표
    "rightarrow": "→", "to": "→", "longrightarrow": "→", "Rightarrow": "⇒",
    "leftarrow": "←", "longleftarrow": "←", "Leftarrow": "⇐",
    "leftrightarrow": "↔", "Leftrightarrow": "⇔", "rightleftharpoons": "⇌",
    "uparrow": "↑", "downarrow": "↓",
    # 그리스 소문자
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ",
    "epsilon": "ε", "varepsilon": "ε", "zeta": "ζ", "eta": "η",
    "theta": "θ", "vartheta": "ϑ", "iota": "ι", "kappa": "κ",
    "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π",
    "varpi": "ϖ", "rho": "ρ", "varrho": "ϱ", "sigma": "σ",
    "varsigma": "ς", "tau": "τ", "upsilon": "υ", "phi": "φ",
    "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω",
    # 그리스 대문자
    "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ",
    "Pi": "Π", "Sigma": "Σ", "Upsilon": "Υ", "Phi": "Φ", "Psi": "Ψ",
    "Omega": "Ω",
    # 함수명 — 백슬래시만 벗긴다(업라이트 평문 표기)
    "ln": "ln", "log": "log", "lg": "lg", "exp": "exp",
    "sin": "sin", "cos": "cos", "tan": "tan", "cot": "cot",
    "sec": "sec", "csc": "csc", "sinh": "sinh", "cosh": "cosh",
    "tanh": "tanh", "arcsin": "arcsin", "arccos": "arccos",
    "arctan": "arctan", "min": "min", "max": "max", "deg": "deg",
    "mod": "mod",
}
_BARE_LATEX_SYMBOL_CMD_RE = re.compile(r"\\([A-Za-z]+)")


def replace_bare_latex_symbol_commands(text):
    r"""평문 속 단독 LaTeX 기호 명령(\times, \nu, \Delta …)을 유니코드로 강등.

    _BARE_LATEX_SYMBOL_MAP 화이트리스트에 있는 명령만 바꾸고, 미지 명령
    (\nuclear 등 — 명령 이름은 [A-Za-z]+ 최장 일치라 \nu 가 \nuclear 의
    일부를 먹는 일은 없다)과 구조 명령은 그대로 둔다. 마커({{EQ*:...}})
    본문 보호는 호출부 몫이다 — 반드시 마커 밖 구간만 넘길 것.
    단일 소스(DEF-012): chem-pre/hwpx-gen.py 는 이 함수를 위임 스텁으로
    재수출한다. 구현 수정은 이 파일에서만 한다.
    """
    s = str(text or "")
    if "\\" not in s:
        return s

    def _one(m):
        repl = _BARE_LATEX_SYMBOL_MAP.get(m.group(1))
        if repl is None:
            return m.group(0)
        prev = s[m.start() - 1] if m.start() > 0 else ""
        # 'ln'/'log' 같은 영문자 치환이 앞 토큰에 들러붙지 않게 한 칸 띄운다
        # (-RT\ln K → -RT ln K). 기호(×, Δ …) 치환은 그대로 잇는다(h\nu → hν).
        if repl[:1].isascii() and repl[:1].isalpha() and prev.isascii() and prev.isalnum():
            return " " + repl
        return repl

    return _BARE_LATEX_SYMBOL_CMD_RE.sub(_one, s)


def _demote_bare_latex_symbols_outside_markers(text: str) -> str:
    """마커({{EQ*:...}}) 밖 평문 구간의 단독 LaTeX 기호 명령만 유니코드로 강등.

    마커 본문(LaTeX 원문)은 변환 엔진 몫이므로 절대 건드리지 않는다.
    """
    s = str(text or "")
    if "\\" not in s:
        return s
    parts: list[str] = []
    cursor = 0
    for ph in _find_placeholders_lenient(s):
        parts.append(replace_bare_latex_symbol_commands(s[cursor : ph.start]))
        parts.append(s[ph.start : ph.end])
        cursor = ph.end
    parts.append(replace_bare_latex_symbol_commands(s[cursor:]))
    return "".join(parts)


def rescue_convertible_residue_text(text: str) -> str:
    """마커 없는 본문 텍스트의 변환 가능한 수식 잔재를 {{EQ*:...}} 로 감싼다.

    잔재 조각 자체만 감싸고 주변 산문은 흡수하지 않는다. 이미 마커가 있는
    텍스트는 건드리지 않는다 — 마커 잔존은 별도 fatal 경로의 몫이다.
    수식화로 못 감싼 단독 LaTeX 기호 명령(\\times, \\nu …)은 마지막에
    유니코드 평문으로 강등한다(rescue 먼저 → 남은 기호만 치환).
    """
    s = str(text or "")
    if not s or "{{EQ" in s:
        return s
    # 게이트로 _LATEX_RESIDUE_RE 를 쓰지 않는다 — \b 가 '_' 앞에서 매칭되지
    # 않아 \sum_{i=1} 류를 놓친다. 조각 정규식 자체가 백슬래시 명령 기준이라
    # 산문 오탐이 없다(구제 커버리지 ⊇ 검출 커버리지 방향만 허용).
    if "\\" in s:
        s = _RESIDUE_LATEX_FRAGMENT_RE.sub(
            lambda m: "{{EQ-LATEX:" + m.group(0) + "}}", s
        )
    # 한컴 스크립트 조각 게이트는 변환 정규식(_RESIDUE_HWP_FRAGMENT_RE) 자체를
    # 공유한다 — 게이트(과거 단일 레벨 _HWP_SCRIPT_RESIDUE_RE)와 변환기(중첩
    # 3단)가 어긋나 'sqrt {x^{2}+1}'·'{T^{2}} over 4' 류가 구제 시도조차 못
    # 받던 내부 모순의 재발 방지. 백슬래시가 남았으면(조각 래핑으로 못 감싼
    # 단독 기호 명령) 유니코드 강등 폴백도 거쳐야 하므로 함께 본다.
    if not _RESIDUE_HWP_FRAGMENT_RE.search(s) and "\\" not in s:
        return s
    # ① LaTeX 래핑으로 생긴 마커 본문({{EQ-LATEX:\sqrt{x}}})의 sqrt 가 다시
    # 잡히지 않도록 마커 밖 구간만 한컴 스크립트 조각을 {{EQ:...}} 로 감싼다.
    parts: list[str] = []
    cursor = 0
    for ph in _find_placeholders_lenient(s):
        parts.append(
            _RESIDUE_HWP_FRAGMENT_RE.sub(
                lambda m: "{{EQ:" + m.group(0) + "}}", s[cursor : ph.start]
            )
        )
        parts.append(s[ph.start : ph.end])
        cursor = ph.end
    parts.append(
        _RESIDUE_HWP_FRAGMENT_RE.sub(
            lambda m: "{{EQ:" + m.group(0) + "}}", s[cursor:]
        )
    )
    # ② 수식화(①·LaTeX 조각 래핑) 후에도 마커 밖에 남은 단독 기호 명령만
    # 유니코드로 강등한다 — 마커 본문(\frac, \Delta …)은 변환 엔진 몫.
    return _demote_bare_latex_symbols_outside_markers("".join(parts))


def _marker_continues_past_end(text: str) -> bool:
    """run 그룹 경계에서 끝난 텍스트에 미완(미폐합) 마커가 걸려 있는지."""
    if "{{EQ" in text:
        placeholders = find_equation_placeholders(text, strict=False)
        cursor = placeholders[-1].end if placeholders else 0
        if "{{EQ" in text[cursor:]:
            return True
    # 프리픽스 자체가 run 경계에서 잘린 경우('{{E' + 'Q-LATEX:...')도 잇는다.
    for prefix in EQ_MARKER_PREFIXES:
        for length in range(2, len(prefix)):
            if text.endswith(prefix[:length]):
                return True
    return False


def replace_placeholders_in_section(
    xml_bytes: bytes,
    style: EquationStyle = EquationStyle(),
    context: ReplacementContext | None = None,
) -> tuple[bytes, int]:
    register_namespaces_from_xml(xml_bytes)
    root = ET.fromstring(xml_bytes)
    id_gen = IdGenerator(root)
    context = context or ReplacementContext()
    converted = 0
    did_change = False

    for para in root.findall(f".//{{{HP_NS}}}p"):
        if _normalize_paragraph_text_nodes(para):
            did_change = True
        replacements: list[tuple[int, int, list[ET.Element], int]] = []
        children = list(para)
        index = 0
        while index < len(children):
            if not is_plain_text_run(children[index]):
                index += 1
                continue

            start = index
            group: list[ET.Element] = []
            anchors: list[tuple[int, ET.Element]] = []
            while index < len(children):
                child = children[index]
                if is_plain_text_run(child):
                    group.append(child)
                    index += 1
                    continue
                group_text = "".join(run[0].text or "" for run in group)
                if _marker_continues_past_end(group_text) and any(
                    is_plain_text_run(later) for later in children[index + 1 :]
                ):
                    # 비텍스트 run(책갈피·ctrl·lineBreak 등)이 마커 본문을
                    # 가로질렀다 — 그룹을 끊지 말고 위치를 기억해 보존한다.
                    anchors.append((len(group_text), child))
                    index += 1
                    continue
                break

            group_text = "".join(run[0].text or "" for run in group)
            if "{{EQ" not in group_text:
                continue

            if anchors:
                new_runs, count = replace_placeholders_in_run_group_lenient(
                    group,
                    id_gen=id_gen,
                    style=style,
                    context=context,
                    anchors=anchors,
                )
                replacements.append((start, index, new_runs, count))
                continue

            try:
                new_runs, count = replace_placeholders_in_run_group(
                    group,
                    id_gen=id_gen,
                    style=style,
                    context=context,
                )
            except Exception as exc:
                new_runs, count = replace_placeholders_in_run_group_lenient(
                    group,
                    id_gen=id_gen,
                    style=style,
                    context=context,
                )
                print(
                    "[hwpx-equation] malformed equation marker handled leniently: "
                    f"{exc}",
                    file=sys.stderr,
                )
                replacements.append((start, index, new_runs, count))
                continue
            if count:
                replacements.append((start, index, new_runs, count))

        for start, end, new_runs, count in reversed(replacements):
            for old_run in children[start:end]:
                para.remove(old_run)
            for offset, run in enumerate(new_runs):
                para.insert(start + offset, run)
            converted += count
            did_change = True

    # 2차 — 마커 없이 본문에 남은 '변환 가능' 잔재 구제. 1차에서 마커는 모두
    # 소진됐으므로 남은 평문 run 의 \frac{1}{2}, {a} over {b}, sqrt {..} 조각을
    # 마커로 감싸 즉시 변환한다(실패 시 _placeholder_replacement_runs 가 마커
    # 문법 없는 평문으로 강등). validate 가 fatal 로 보기 전의 마지막 안전망.
    for para in root.findall(f".//{{{HP_NS}}}p"):
        index = 0
        while index < len(para):
            run = para[index]
            index += 1
            if not is_plain_text_run(run):
                continue
            text = run[0].text or ""
            if "\\" not in text and "over" not in text and "sqrt" not in text:
                continue
            rescued = rescue_convertible_residue_text(text)
            if rescued == text:
                continue
            run_attrs = dict(run.attrib)
            new_runs: list[ET.Element] = []
            cursor = 0
            for ph in _find_placeholders_lenient(rescued):
                if ph.start > cursor:
                    new_runs.append(
                        make_text_run(rescued[cursor : ph.start], run_attrs)
                    )
                new_runs.extend(
                    _placeholder_replacement_runs(
                        ph, run_attrs, id_gen, style, context
                    )
                )
                converted += 1
                cursor = ph.end
            if cursor < len(rescued):
                new_runs.append(make_text_run(rescued[cursor:], run_attrs))
            if not new_runs:
                new_runs.append(make_text_run("", run_attrs))
            insert_at = index - 1
            para.remove(run)
            for offset, new_run in enumerate(new_runs):
                para.insert(insert_at + offset, new_run)
            index = insert_at + len(new_runs)
            did_change = True

    if not did_change:
        return xml_bytes, 0
    return ET.tostring(root, encoding="utf-8", xml_declaration=True), converted


def find_section_files(zip_file: zipfile.ZipFile) -> list[str]:
    return sorted(
        name
        for name in zip_file.namelist()
        if name.startswith("Contents/section") and name.endswith(".xml")
    )


def write_zip_with_updates(
    input_hwpx: Path,
    output_hwpx: Path,
    updates: dict[str, bytes],
) -> None:
    output_hwpx.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(input_hwpx, "r") as zin, zipfile.ZipFile(output_hwpx, "w") as zout:
        names = zin.namelist()
        if "mimetype" in names:
            info = zin.getinfo("mimetype")
            out_info = copy.copy(info)
            out_info.compress_type = zipfile.ZIP_STORED
            zout.writestr(out_info, updates.get("mimetype", zin.read("mimetype")))

        for name in names:
            if name == "mimetype":
                continue
            info = zin.getinfo(name)
            out_info = copy.copy(info)
            data = updates.get(name, zin.read(name))
            zout.writestr(out_info, data)


def replace_equation_placeholders(
    input_hwpx: Path,
    output_hwpx: Path,
    style: EquationStyle = EquationStyle(),
    section: str | None = None,
    equation_number_start: int = 1,
) -> int:
    context = ReplacementContext(next_equation_number=equation_number_start)
    with zipfile.ZipFile(input_hwpx, "r") as zf:
        sections = [section] if section else find_section_files(zf)
        if not sections:
            raise FileNotFoundError("No Contents/section*.xml files found in HWPX.")

        # hwip 프리워밍: 문서 전체의 {{EQ-LATEX}} 본문을 node 1회 호출로 미리 변환.
        # 실패해도 무해 — 캐시 미스 식은 단건 호출/빌트인으로 폴백된다.
        if hwip_engine_enabled():
            bodies: list[str] = []
            for section_name in sections:
                try:
                    root = ET.fromstring(zf.read(section_name))
                    text = canonicalize_equation_marker_prefixes(
                        "".join(root.itertext())
                    )
                    for ph in _find_placeholders_lenient(text):
                        if ph.kind.endswith("-LATEX"):
                            # latex_to_script 와 같은 전처리 — 캐시 키 일치 필수
                            bodies.append(preprocess_latex_body(ph.body))
                except Exception:
                    continue
            hwip_convert_batch(bodies)

        updates: dict[str, bytes] = {}
        total = 0
        for section_name in sections:
            xml_bytes = zf.read(section_name)
            new_xml, count = replace_placeholders_in_section(
                xml_bytes,
                style=style,
                context=context,
            )
            if new_xml != xml_bytes:
                updates[section_name] = new_xml
            total += count

    write_zip_with_updates(input_hwpx, output_hwpx, updates)
    return total


def append_equation_paragraph_to_section(
    xml_bytes: bytes,
    script: str,
    style: EquationStyle = EquationStyle(),
    char_pr_id: str = "0",
    para_pr_id: str = "0",
    style_id: str = "0",
) -> bytes:
    register_namespaces_from_xml(xml_bytes)
    root = ET.fromstring(xml_bytes)
    id_gen = IdGenerator(root)

    para = ET.Element(
        qname(HP_NS, "p"),
        {
            "id": id_gen.next(),
            "paraPrIDRef": para_pr_id,
            "styleIDRef": style_id,
            "pageBreak": "0",
            "columnBreak": "0",
            "merged": "0",
        },
    )
    run_attrs = {"charPrIDRef": char_pr_id}
    para.append(make_equation_run(script, id_gen.next(), run_attrs, style=style))
    root.append(para)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def append_equation(
    input_hwpx: Path,
    output_hwpx: Path,
    script: str,
    style: EquationStyle = EquationStyle(),
    section: str = "Contents/section0.xml",
    char_pr_id: str = "0",
    para_pr_id: str = "0",
    style_id: str = "0",
) -> None:
    with zipfile.ZipFile(input_hwpx, "r") as zf:
        xml_bytes = zf.read(section)
        new_xml = append_equation_paragraph_to_section(
            xml_bytes,
            script,
            style=style,
            char_pr_id=char_pr_id,
            para_pr_id=para_pr_id,
            style_id=style_id,
        )
    write_zip_with_updates(input_hwpx, output_hwpx, {section: new_xml})


def build_style(args: argparse.Namespace) -> EquationStyle:
    return EquationStyle(
        base_unit=args.base_unit,
        text_color=args.color,
        line_thickness=args.line_thickness,
        letter_spacing=args.letter_spacing,
    )


def iter_scripts(xml_bytes: bytes) -> Iterable[str]:
    register_namespaces_from_xml(xml_bytes)
    root = ET.fromstring(xml_bytes)
    for script in root.findall(f".//{{{HP_NS}}}script"):
        yield script.text or ""


def inspect_equations(input_hwpx: Path) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    with zipfile.ZipFile(input_hwpx, "r") as zf:
        for section_name in find_section_files(zf):
            for script in iter_scripts(zf.read(section_name)):
                found.append((section_name, script))
    return found


# 최종 HWPX에 절대 남아서는 안 되는 금지 수식 마커(CLAUDE.md "절대 하지 말 것").
# 변환기가 없어 raw 텍스트로 노출되므로, 발견되면 postprocess를 fatal 처리한다.
FORBIDDEN_EQUATION_MARKERS = ("{{MATH:", "{{FORMULA:", "{{EQUATION:", "[[수식")

# 본문(hp:t)에 보이면 안 되는 원시 LaTeX 잔재 — lenient 경로 누수 안전망.
_LATEX_RESIDUE_RE = re.compile(
    r"\\(?:frac|sqrt|left|right|begin|end|sum|lim|int|text|ce)\b"
)
# 본문(hp:t)의 한컴 수식 스크립트 잔재 검출(_HWP_SCRIPT_RESIDUE_RE)은
# 구제 쪽 정의(_RESIDUE_HWP_FRAGMENT_RE)와 같은 빌딩블록을 공유해야 하므로
# 위쪽 '잔재 구제' 섹션(_RESIDUE_BRACED 옆)에 정의되어 있다.
# 수식 스크립트(hp:script)에는 백슬래시 명령이 존재할 수 없다 — 어떤 \cmd 든
# 변환 실패(엔진 강등 잔재) 신호다.
_SCRIPT_BACKSLASH_RE = re.compile(r"\\[A-Za-z]+|\\[ ,;!]")
# 백슬래시 없이 남은 LaTeX 전용 구조 키워드 — 변환기가 잘린 인자를 못 읽고
# 안전망이 백슬래시만 뗀 강등 잔재('frac {a}{b')의 신호다. sqrt/root/over/
# lim 등 한컴 정식 키워드는 절대 포함하지 않는다. 인용 리터럴("...") 내부는
# 임의 텍스트이므로 검사 전에 제거하고 본다.
_SCRIPT_BARE_LATEX_KEYWORD_RE = re.compile(r"\b(?:[dtc]?frac|[dt]?binom)\b")


def _forbidden_markers_in(text: str) -> list[str]:
    if not text:
        return []
    upper = text.upper()
    return [m for m in FORBIDDEN_EQUATION_MARKERS if m.upper() in upper]


def _marker_residue_in(text: str) -> bool:
    """마커 문법 잔재 탐지 — 대소문자·콜론 앞뒤 공백 오타까지 잡는다."""
    if not text:
        return False
    return "{{EQ" in text or bool(_EQ_PREFIX_RESCUE_RE.search(text))


def validate_hwpx_equations(input_hwpx: Path) -> list[str]:
    issues: list[str] = []
    try:
        with zipfile.ZipFile(input_hwpx, "r") as zf:
            sections = find_section_files(zf)
            if not sections:
                return ["No Contents/section*.xml files found in HWPX."]

            for section_name in sections:
                try:
                    xml_bytes = zf.read(section_name)
                    register_namespaces_from_xml(xml_bytes)
                    root = ET.fromstring(xml_bytes)
                except ET.ParseError as exc:
                    issues.append(f"{section_name}: XML parse error: {exc}")
                    continue

                for t in root.findall(f".//{{{HP_NS}}}t"):
                    # itertext(): 자식 요소(lineBreak 등)의 tail 텍스트까지 포함
                    t_text = "".join(t.itertext())
                    if _marker_residue_in(t_text):
                        issues.append(f"{section_name}: unresolved placeholder: {t_text}")
                    if _LATEX_RESIDUE_RE.search(t_text):
                        issues.append(
                            f"{section_name}: raw LaTeX residue in text: {t_text}"
                        )
                    if _HWP_SCRIPT_RESIDUE_RE.search(t_text):
                        issues.append(
                            f"{section_name}: raw equation script in text: {t_text}"
                        )
                    for marker in _forbidden_markers_in(t_text):
                        issues.append(
                            f"{section_name}: forbidden equation marker {marker!r}: {t_text}"
                        )

                run_tag = qname(HP_NS, "run")
                t_tag = qname(HP_NS, "t")
                for para in root.findall(f".//{{{HP_NS}}}p"):
                    # 문단 전체 텍스트(비텍스트 run 은 길이 0 취급) — run 경계로
                    # 쪼개진 마커/잔재를 잡는다. 개별 t 에서 이미 잡힌 것은 제외.
                    parts: list[str] = []
                    for child in para:
                        if child.tag != run_tag:
                            continue
                        for t in child.findall(t_tag):
                            parts.append("".join(t.itertext()))
                    para_text = "".join(parts)
                    if _marker_residue_in(para_text) and not any(
                        _marker_residue_in(part) for part in parts
                    ):
                        issues.append(
                            f"{section_name}: unresolved split placeholder: {para_text}"
                        )
                    if _LATEX_RESIDUE_RE.search(para_text) and not any(
                        _LATEX_RESIDUE_RE.search(part) for part in parts
                    ):
                        issues.append(
                            f"{section_name}: raw LaTeX residue (split) in text: {para_text}"
                        )
                    if _HWP_SCRIPT_RESIDUE_RE.search(para_text) and not any(
                        _HWP_SCRIPT_RESIDUE_RE.search(part) for part in parts
                    ):
                        issues.append(
                            f"{section_name}: raw equation script (split) in text: {para_text}"
                        )
                    split_markers = [
                        m
                        for m in _forbidden_markers_in(para_text)
                        if not any(m in _forbidden_markers_in(p) for p in parts)
                    ]
                    for marker in split_markers:
                        issues.append(
                            f"{section_name}: forbidden equation marker {marker!r} (split): {para_text}"
                        )

                for script in root.findall(f".//{{{HP_NS}}}script"):
                    script_text = script.text or ""
                    if not script_text.strip():
                        issues.append(f"{section_name}: empty equation script")
                        continue
                    if _marker_residue_in(script_text):
                        issues.append(
                            f"{section_name}: marker residue in equation script: {script_text}"
                        )
                    if _SCRIPT_BACKSLASH_RE.search(script_text):
                        issues.append(
                            f"{section_name}: raw LaTeX residue in equation script: {script_text}"
                        )
                    script_sans_quotes = re.sub(r'"[^"]*"', " ", script_text)
                    if _SCRIPT_BARE_LATEX_KEYWORD_RE.search(script_sans_quotes):
                        issues.append(
                            f"{section_name}: bare LaTeX structure keyword in equation script: {script_text}"
                        )
                    if script_sans_quotes.count("{") != script_sans_quotes.count("}"):
                        issues.append(
                            f"{section_name}: unbalanced braces in equation script: {script_text}"
                        )
                    for marker in _forbidden_markers_in(script_text):
                        issues.append(
                            f"{section_name}: forbidden equation marker {marker!r} in equation script: {script_text}"
                        )
    except zipfile.BadZipFile:
        return [f"{input_hwpx} is not a valid HWPX/ZIP file."]

    return issues


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Insert Hancom equation objects into HWPX files."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    replace_p = sub.add_parser(
        "replace", help="Replace {{EQ:...}} placeholders with hp:equation objects."
    )
    replace_p.add_argument("input_hwpx", type=Path)
    replace_p.add_argument("output_hwpx", type=Path)
    replace_p.add_argument("--section", help="Only edit one section XML path.")
    replace_p.add_argument("--base-unit", type=int, default=1000)
    replace_p.add_argument("--color", default="#000000")
    replace_p.add_argument("--line-thickness", type=int, default=100)
    replace_p.add_argument("--letter-spacing", type=int, default=0)
    replace_p.add_argument(
        "--number-start",
        type=int,
        default=1,
        help="First number used for {{EQN:...}} placeholders.",
    )

    append_p = sub.add_parser("append", help="Append one equation paragraph.")
    append_p.add_argument("input_hwpx", type=Path)
    append_p.add_argument("output_hwpx", type=Path)
    append_p.add_argument("--script", required=True, help="Hancom equation script.")
    append_p.add_argument("--latex", action="store_true", help="Treat --script as LaTeX.")
    append_p.add_argument("--section", default="Contents/section0.xml")
    append_p.add_argument("--char-pr-id", default="0")
    append_p.add_argument("--para-pr-id", default="0")
    append_p.add_argument("--style-id", default="0")
    append_p.add_argument("--base-unit", type=int, default=1000)
    append_p.add_argument("--color", default="#000000")
    append_p.add_argument("--line-thickness", type=int, default=100)
    append_p.add_argument("--letter-spacing", type=int, default=0)

    convert_p = sub.add_parser("convert-latex", help="Convert common LaTeX to HWP script.")
    convert_p.add_argument("latex")

    inspect_p = sub.add_parser("inspect", help="Print equation scripts in a HWPX file.")
    inspect_p.add_argument("input_hwpx", type=Path)

    validate_p = sub.add_parser(
        "validate", help="Check XML, unresolved placeholders, and empty scripts."
    )
    validate_p.add_argument("input_hwpx", type=Path)

    args = parser.parse_args(argv)

    if args.command == "replace":
        count = replace_equation_placeholders(
            args.input_hwpx,
            args.output_hwpx,
            style=build_style(args),
            section=args.section,
            equation_number_start=args.number_start,
        )
        print(f"Inserted {count} equation(s): {args.output_hwpx}")
        return 0

    if args.command == "append":
        raw_script = str(args.script or "")
        if not raw_script.strip():
            # make_equation 의 ValueError traceback 대신 명확한 메시지로 종료.
            print("ERROR: --script is empty — nothing to append.", file=sys.stderr)
            return 2
        # --latex 는 본 파이프라인과 동일 경로(placeholder_to_script:
        # mhchem \ce/\pu 전개·유니코드 화살표 선치환 + hwip 우선/빌트인 폴백
        # + normalize_hwp_script)로 라우팅한다 — LatexToHwpConverter.convert
        # 직접 호출은 이 전처리를 전부 우회해 \ce{...} 의 'ce' 영단어 노출
        # 같은 회귀를 만든다.
        script = (
            placeholder_to_script("EQ-LATEX", raw_script)
            if args.latex
            else raw_script
        )
        if not script.strip():
            print(
                "ERROR: LaTeX conversion produced an empty equation script.",
                file=sys.stderr,
            )
            return 2
        append_equation(
            args.input_hwpx,
            args.output_hwpx,
            script,
            style=build_style(args),
            section=args.section,
            char_pr_id=args.char_pr_id,
            para_pr_id=args.para_pr_id,
            style_id=args.style_id,
        )
        print(f"Appended equation: {args.output_hwpx}")
        return 0

    if args.command == "convert-latex":
        raw_latex = str(args.latex or "")
        if not raw_latex.strip():
            print("ERROR: empty LaTeX input.", file=sys.stderr)
            return 2
        # append --latex 와 동일하게 전체 파이프라인 경로로 변환한다.
        script = placeholder_to_script("EQ-LATEX", raw_latex)
        if not script.strip():
            print(
                "ERROR: LaTeX conversion produced an empty equation script.",
                file=sys.stderr,
            )
            return 2
        print(script)
        return 0

    if args.command == "inspect":
        for section_name, script in inspect_equations(args.input_hwpx):
            print(f"{section_name}: {script}")
        return 0

    if args.command == "validate":
        issues = validate_hwpx_equations(args.input_hwpx)
        if not issues:
            print(f"OK: {args.input_hwpx}")
            return 0
        for issue in issues:
            print(f"ERROR: {issue}")
        return 1

    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    sys.exit(main())
