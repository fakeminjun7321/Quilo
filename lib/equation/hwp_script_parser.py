# -*- coding: utf-8 -*-
"""한컴 수식 스크립트 구조 파서 + 교차엔진 동치성 비교기 (검증 전용).

목적: builtin(LatexToHwpConverter)과 hwip(vendor)은 같은 LaTeX 에 대해
텍스트가 다른 스크립트를 낸다(골든셋 123개 중 99개). 기존 검사는 전부
"나쁜 패턴이 없는가"(정규식)라서, 두 출력이 '같은 수식'인지는 아무도
보지 않았다. 이 모듈은 스크립트를 구조 트리로 파싱해 비교하고, 차이를
  - 양성(benign): 표기/공백/스트레치 괄호/검증된 동의 키워드 — 렌더 동일
  - 의심(suspect): 동의로 추정되나 한컴 실측 미확인 쌍(INF/inf 등)
  - 구조(struct): 진짜 다른 수식 — 한쪽 엔진의 결함 신호
로 분류한다. 서로 독립 구현인 두 엔진이 상호 검증 오라클이 된다.

부가로 한컴 렉싱 린트를 제공한다: 한컴 수식 편집기는 비인용 글자 런을
키워드 최장 일치로 잘라 읽으므로(대소문자 구분), 'pivot' 처럼 키워드
('pi')를 품은 비인용 런은 πvot 로 깨진다. lint_hancom_lexing() 이
이 위험을 스크립트 단독으로도 찾아낸다.

⚠ 이 모듈은 프로덕션 변환 경로(hwpx_equation_tool 의 replace/convert)에서
import 하지 않는다 — scripts/eq_engine_diff.py, 퍼저, 렌더 시트 등 검증
도구 전용이다. 파서가 틀려도 보고서 생성엔 영향이 없다.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field

# ── 어휘: 두 엔진이 실제로 내보내는 원자 키워드 ────────────────────────────
# builtin COMMANDS/ONE_ARG_COMMANDS/ENVIRONMENTS 의 값 + hwip vendor 의
# GREEK/FUNCTIONS/SYMBOLS/ACCENTS/MATRIX_ENV 값의 합집합. 여기 없는 글자
# 런은 '평문 글자(이탤릭 낱자)'로 취급해 낱자로 분해 비교한다.

GREEK_LOWER = frozenset(
    """alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota
    kappa lambda mu nu xi omicron pi varpi rho varrho sigma varsigma tau
    upsilon varupsilon phi varphi chi psi omega""".split()
)
# 대문자 그리스 — builtin 은 전대문자(DELTA), hwip 은 첫대문자(Delta)를 낸다.
# 두 표기 모두 수년/수개월 실서비스 산출물에서 정상 렌더가 확인된 형태다.
GREEK_UPPER = frozenset(
    """Gamma GAMMA Delta DELTA Theta THETA Lambda LAMBDA Xi XI Pi PI Sigma
    SIGMA Upsilon UPSILON Phi PHI Psi PSI Omega OMEGA Alpha Beta Epsilon
    Zeta Eta Iota Kappa Mu Nu Omicron Rho Tau Chi""".split()
)

FUNCTIONS = frozenset(
    """sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth ln
    log lg lim Lim max min exp Exp det gcd mod arg deg dim ker hom Pr sup
    inf INF""".split()
)

# 구조(폴드 대상) 키워드
STRUCT_WORDS = frozenset(
    """over atop CHOOSE sqrt root of cases matrix pmatrix bmatrix dmatrix
    smallmatrix LEFT RIGHT REL BUILDREL OVERBRACE UNDERBRACE BOX""".split()
)

ACCENT_FUNCS = frozenset(
    "vec hat bar dot ddot tilde acute grave check under dyad bold rm it not".split()
)

# 연산자/기호 단어(양 엔진 출력 어휘의 합집합 — 비교 원자)
SYMBOL_WORDS = frozenset(
    """times TIMES div DIV cdot plusminus minusplus approx APPROX equiv leq
    geq neq sim simeq cong propto doteq prec succ asymp ASYMP in IN owns
    notin subset supset subseteq supseteq union inter cup cap sqcap sqcup
    emptyset aleph uplus oplus ominus otimes odot oslash vee wedge circ
    bullet ast star partial nabla forall exist exists therefore because
    diamond angle triangle dagger ddagger lnot top bot models vdash prime
    hbar int oint dint tint qint sum prod DEG ANGSTROM ELL IMAG REIMAGE
    IMATH JMATH WP cdots ldots vdots ddots larrow rarrow lrarrow LARROW
    RARROW LRARROW uparrow downarrow udarrow UPARROW DOWNARROW UDARROW
    mapsto nwarrow nearrow swarrow searrow hookleft hookright VERT LLL
    COPROD TRIANGLED EXARROW SQSUBSET SQSUPSET SQSUBSETEQ SQSUPSETEQ
    BUILDREL LNOT RLHARPOONS LRHARPOONS vert""".split()
)

KEYWORDS: frozenset[str] = frozenset(
    GREEK_LOWER | GREEK_UPPER | FUNCTIONS | STRUCT_WORDS | ACCENT_FUNCS | SYMBOL_WORDS
)

# ── 동의 글리프 클래스 ──────────────────────────────────────────────────────
# SAFE: 두 표기 모두 같은 글리프로 렌더됨이 확인된 쌍. 2026-07-12 렌더 시트
#       실측(S1 프로브, tmp/eq-render-sheet.pdf)으로 in/IN·inf/INF·exist/
#       exists·union/cup·inter/cap·DELTA/Delta 확정. '=>' 는 ⇒ 가 아니라
#       '=' '>' 두 글자로 렌더됨이 확인되어 RARROW 와 동의어가 아니다(제외).
#       'lnot' 은 한컴 비키워드('ln'+'otp' 로 쪼개짐) — normalize 가 ¬ 로
#       치환하므로 출력에 남으면 그 자체가 결함 신호다(동의어 아님).
_SAFE_SYNONYM_SETS = [
    {"times", "TIMES", "×"},
    {"div", "DIV", "÷"},
    {"approx", "APPROX", "≈"},
    {"+-", "plusminus", "±"},
    {"-+", "minusplus", "∓"},
    {"==", "equiv", "≡"},
    {"<=", "leq", "≤"},
    {">=", "geq", "≥"},
    {"!=", "neq", "≠"},
    {"->", "rarrow", "→"},
    {"<-", "larrow", "←"},
    {"<->", "lrarrow", "↔"},
    {"LARROW", "⇐"},
    {"LRARROW", "⇔"},
    {"RARROW", "⇒"},
    {"LNOT", "¬"},
    {"RLHARPOONS", "⇋"},
    {"vert", "|"},
    {"cdot", "·", "∙", "⋅"},
    {"in", "IN", "∈"},
    {"inf", "INF", "∞"},
    {"exists", "exist", "∃"},
    {"cup", "union", "∪"},
    {"cap", "inter", "∩"},
]
# SUSPECT: 같은 글리프로 추정되나 아직 한컴 실측이 없는 쌍.
# 동치로 '통과'시키되 suspect 로 표시해 렌더 시트 검증 큐로 보낸다.
# (2026-07-12 실측 후 전부 SAFE 로 승격되어 현재 비어 있음 — 새 미검증
#  동의 쌍이 생기면 여기 먼저 넣고 렌더 시트로 확정한다.)
_SUSPECT_SYNONYM_SETS: list[set[str]] = []

_GLYPH_CLASS: dict[str, str] = {}
_SUSPECT_CLASS: dict[str, str] = {}
for _set in _SAFE_SYNONYM_SETS:
    _canon = sorted(_set)[0]
    for _w in _set:
        _GLYPH_CLASS[_w] = _canon
for _set in _SUSPECT_SYNONYM_SETS:
    _canon = sorted(_set)[0]
    for _w in _set:
        _SUSPECT_CLASS[_w] = _canon

# 대문자 그리스의 두 표기(DELTA/Delta)는 같은 Δ 다. 반면 delta(δ)와
# Delta(Δ)는 다른 글자이므로 단순 소문자화 비교는 금지 — 둘 다 '첫 글자
# 대문자'일 때만 소문자화 클래스로 접는다.
def _greek_upper_class(word: str) -> str | None:
    if word in GREEK_UPPER and word[:1].isupper():
        return "GREEK:" + word.lower()
    return None


def glyph_class(atom: str) -> str:
    """비교용 정준 클래스. suspect 쌍도 같은 클래스로 접되 호출부가
    is_suspect_pair() 로 표시 여부를 판단한다."""
    g = _greek_upper_class(atom)
    if g:
        return g
    if atom in _GLYPH_CLASS:
        return "SYN:" + _GLYPH_CLASS[atom]
    if atom in _SUSPECT_CLASS:
        return "SUS:" + _SUSPECT_CLASS[atom]
    return atom


def is_suspect_atom(atom: str) -> bool:
    return atom in _SUSPECT_CLASS


# 대소문자만 다른 SAFE 동의(INF/inf, IN/in, TIMES/times …)와 그리스 케이스
# 접기는 benign 'keyword-case'/'synonym' 카테고리로 기록된다.

# ── 토크나이저 ──────────────────────────────────────────────────────────────

# 여러 글자 연산자(긴 것 우선). '<->' 가 '<-' 보다 먼저 와야 한다.
_MULTI_OPS = ["<->", "<=>", "->", "<-", "=>", "<=", ">=", "!=", "==", "+-", "-+", "<<", ">>"]

_TOKEN_RE = re.compile(
    r'"(?P<lit>[^"]*)"'
    r"|(?P<op>" + "|".join(re.escape(o) for o in _MULTI_OPS) + r")"
    r"|(?P<word>[A-Za-z]+)"
    r"|(?P<num>\d+(?:\.\d+)?)"
    r"|(?P<space>[ \t `~]+)"
    r"|(?P<ctrl>[{}_^#&])"
    r"|(?P<ch>.)",
    re.DOTALL,
)


@dataclass
class Tok:
    kind: str  # lit | word | glyph | ctrl
    val: str


def tokenize(script: str) -> list[Tok]:
    """스크립트 → 원자 토큰. 공백/스페이싱(`, ~)은 버린다(한컴에서 항 구분일
    뿐 렌더되지 않음). 어휘 밖 글자 런과 숫자는 낱자 글리프로 분해한다 —
    한컴도 KClO 와 K C l O 를 같은 이탤릭 낱자 열로 그리며, 첨자(_^)가
    '직전 원자 1개'에 붙는 규칙과도 정합한다(KClO_{3} 의 3 은 O 에 붙는다).
    """
    toks: list[Tok] = []
    for m in _TOKEN_RE.finditer(script):
        if m.group("lit") is not None:
            inner = re.sub(r"\s+", " ", m.group("lit")).strip()
            toks.append(Tok("lit", inner))
        elif m.group("op"):
            toks.append(Tok("glyph", m.group("op")))
        elif m.group("word"):
            w = m.group("word")
            if w in KEYWORDS:
                toks.append(Tok("word", w))
            else:
                toks.extend(Tok("glyph", c) for c in w)
        elif m.group("num"):
            toks.extend(Tok("glyph", c) for c in m.group("num"))
        elif m.group("space"):
            continue
        elif m.group("ctrl"):
            toks.append(Tok("ctrl", m.group("ctrl")))
        else:
            ch = m.group("ch")
            if not ch.strip():
                continue
            toks.append(Tok("glyph", ch))
    return toks


# ── 트리 노드 ──────────────────────────────────────────────────────────────
# 노드는 튜플: ("glyph", v) ("lit", text) ("word", w)
# ("frac", kind, num_seq, den_seq) ("rad", idx_seq|None, body_seq)
# ("func", name, arg_seq) ("script", base|None, sub_seq|None, sup_seq|None)
# ("env", kind, rows[[seq,…],…]) ("labeled", op_class, (label_seq,…))
# ("brace2", name, label_seq|None, body_seq)   # OVER/UNDERBRACE
# seq 는 노드 list.

_ARROW_CLASS_WORDS = {
    "rarrow", "larrow", "lrarrow", "RARROW", "LARROW", "LRARROW",
    "uparrow", "downarrow", "udarrow", "UPARROW", "DOWNARROW", "UDARROW",
    "mapsto", "EXARROW",
}
_ARROW_CLASS_GLYPHS = {"->", "<-", "<->", "=>", "<=", "→", "←", "↔", "⇒", "⇐", "⇔"}

_MATRIX_KINDS = {"matrix", "pmatrix", "bmatrix", "dmatrix", "smallmatrix", "cases"}
_MATRIX_CANON = {"smallmatrix": "matrix"}


@dataclass
class ParseResult:
    seq: list
    notes: list[str] = field(default_factory=list)


def parse_script(script: str) -> ParseResult:
    notes: list[str] = []
    toks = tokenize(script)
    pos = [0]

    def parse_seq(depth: int) -> list:
        items: list = []
        while pos[0] < len(toks):
            t = toks[pos[0]]
            if t.kind == "ctrl" and t.val == "}":
                if depth == 0:
                    notes.append("unbalanced '}' ignored")
                    pos[0] += 1
                    continue
                break
            pos[0] += 1
            if t.kind == "ctrl" and t.val == "{":
                inner = parse_seq(depth + 1)
                if pos[0] < len(toks) and toks[pos[0]].kind == "ctrl" and toks[pos[0]].val == "}":
                    pos[0] += 1
                else:
                    notes.append("unclosed '{'")
                items.append(("group", inner))
            elif t.kind == "ctrl":
                items.append(("ctrl", t.val))  # _ ^ # & — 폴드 단계에서 처리
            elif t.kind == "lit":
                items.append(("lit", t.val))
            elif t.kind == "word":
                items.append(("word", t.val))
            else:
                items.append(("glyph", t.val))
        return items

    raw = parse_seq(0)
    return ParseResult(fold_seq(raw, notes), notes)


def _as_seq(item) -> list:
    """폴드 인자 정규화 — group 은 내용으로, 단일 노드는 1원소 seq 로."""
    if item is None:
        return []
    if item[0] == "group":
        return item[1]
    return [item]


def fold_seq(items: list, notes: list[str]) -> list:
    """선형 토큰열에 구조를 입힌다. 순서가 의미를 만든다:
    ① LEFT/RIGHT 스트레치 괄호 강하 ② REL/BUILDREL/브레이스 ③ 행렬/케이스
    ④ root…of / sqrt ⑤ 첨자(_^) 결합 ⑥ 고아 ^ + sqrt → n제곱근
    ⑦ over/atop/CHOOSE 분수 ⑧ 그룹 평탄화."""

    # ① LEFT/RIGHT — 키워드만 떼고 뒤 구분자는 남긴다(보이지 않는 '.' 는 함께 제거)
    out: list = []
    i = 0
    while i < len(items):
        it = items[i]
        if it[0] == "word" and it[1] in ("LEFT", "RIGHT"):
            nxt = items[i + 1] if i + 1 < len(items) else None
            if nxt and nxt[0] == "glyph" and nxt[1] == ".":
                i += 2  # 빈 구분자 — 통째로 소거
                continue
            i += 1  # 키워드만 소거, 구분자 글리프는 다음 루프가 그대로 취한다
            continue
        if it[0] == "group":
            out.append(("group", fold_seq(it[1], notes)))
            i += 1
            continue
        out.append(it)
        i += 1
    items = out

    # ② REL <화살표> {top} {bot} / BUILDREL <op> {label} / OVER·UNDERBRACE
    out = []
    i = 0
    while i < len(items):
        it = items[i]
        if it[0] == "word" and it[1] == "REL" and i + 1 < len(items):
            op = items[i + 1]
            labels = []
            j = i + 2
            while j < len(items) and len(labels) < 2 and items[j][0] == "group":
                labels.append(items[j][1])
                j += 1
            op_atom = op[1] if op[0] in ("word", "glyph") else "?"
            out.append(("labeled", glyph_class(op_atom),
                        tuple(l for l in labels if l)))
            i = j
            continue
        if it[0] == "word" and it[1] == "BUILDREL" and i + 2 < len(items):
            op = items[i + 1]
            label = items[i + 2]
            if label[0] == "group":
                op_atom = op[1] if op[0] in ("word", "glyph") else "?"
                out.append(("labeled", glyph_class(op_atom), (label[1],)))
                i += 3
                continue
        if it[0] == "word" and it[1] in ("OVERBRACE", "UNDERBRACE"):
            a = items[i + 1] if i + 1 < len(items) else None
            b = items[i + 2] if i + 2 < len(items) else None
            if a and a[0] == "group" and b and b[0] == "group":
                out.append(("brace2", it[1], a[1], b[1]))  # {label}{body}
                i += 3
                continue
            if a and a[0] == "group":
                out.append(("brace2", it[1], None, a[1]))  # {body} (+뒤 첨자로 라벨)
                i += 2
                continue
        out.append(it)
        i += 1
    items = out

    # ③ 행렬/케이스: kind {…} → rows/cols 분해
    out = []
    i = 0
    while i < len(items):
        it = items[i]
        if (
            it[0] == "word"
            and it[1] in _MATRIX_KINDS
            and i + 1 < len(items)
            and items[i + 1][0] == "group"
        ):
            kind = _MATRIX_CANON.get(it[1], it[1])
            rows: list[list[list]] = [[[]]]
            # 그룹 내부는 ①에서 재귀 폴드를 마쳐 ctrl 이 글리프로 강등된 뒤다.
            for cell_item in items[i + 1][1]:
                if cell_item in (("ctrl", "#"), ("glyph", "#")):
                    rows.append([[]])
                elif cell_item in (("ctrl", "&"), ("glyph", "&")):
                    rows[-1].append([])
                else:
                    rows[-1][-1].append(cell_item)
            out.append(("env", kind, rows))
            i += 2
            continue
        out.append(it)
        i += 1
    items = out

    # ④ root <idx> of <body> / sqrt <body>
    out = []
    i = 0
    while i < len(items):
        it = items[i]
        if it[0] == "word" and it[1] == "root":
            idx_parts: list = []
            j = i + 1
            while j < len(items) and items[j] != ("word", "of"):
                idx_parts.append(items[j])
                j += 1
            if j < len(items):  # 'of' 발견
                body = _as_seq(items[j + 1]) if j + 1 < len(items) else []
                out.append(("rad", [p for p in idx_parts], body))
                i = j + 2
                continue
        if it[0] == "word" and it[1] == "sqrt" and i + 1 < len(items):
            out.append(("rad", None, _as_seq(items[i + 1])))
            i += 2
            continue
        out.append(it)
        i += 1
    items = out

    # ⑤ 첨자 결합: <base> _ <arg> / ^ <arg> (반복 허용)
    out = []
    i = 0
    while i < len(items):
        it = items[i]
        if it[0] == "ctrl" and it[1] in ("_", "^"):
            base = out.pop() if out else None
            # 단일 항 그룹 밑은 알맹이로 — {(-&gt;)}^{Δ} 의 밑은 화살표 자신이다.
            if base and base[0] == "group" and len(base[1]) == 1:
                base = base[1][0]
            sub = sup = None
            while i < len(items) and items[i][0] == "ctrl" and items[i][1] in ("_", "^"):
                mark = items[i][1]
                arg = _as_seq(items[i + 1]) if i + 1 < len(items) else []
                if mark == "_":
                    sub = (sub or []) + arg
                else:
                    sup = (sup or []) + arg
                i += 2
            # OVERBRACE {body}^{label} / UNDERBRACE {body}_{label} → 라벨 승격
            if base and base[0] == "brace2" and base[2] is None:
                label = sup if base[1] == "OVERBRACE" else sub
                rest_sub = None if base[1] == "UNDERBRACE" else sub
                rest_sup = None if base[1] == "OVERBRACE" else sup
                node = ("brace2", base[1], label, base[3])
                if rest_sub or rest_sup:
                    node = ("script", node, rest_sub, rest_sup)
                out.append(node)
                continue
            out.append(("script", base, sub, sup))
            continue
        out.append(it)
        i += 1
    items = out

    # ⑥ 고아/빈밑 ^{n} + sqrt → n제곱근. hwip 의 \sqrt[n] 표기('^{n} sqrt')와
    #    정규화 표기('{}^{n} sqrt' — normalize_hwp_script 산출)를 모두 접는다.
    out = []
    i = 0
    while i < len(items):
        it = items[i]
        if (
            it[0] == "script"
            and (it[1] is None or (it[1][0] == "group" and not it[1][1]))
            and it[3]
            and not it[2]
            and i + 1 < len(items)
            and items[i + 1][0] == "rad"
            and items[i + 1][1] is None
        ):
            out.append(("rad", it[3], items[i + 1][2]))
            i += 2
            continue
        out.append(it)
        i += 1
    items = out

    # ⑦ 접두 단항(악센트/폰트): name <arg>
    out = []
    i = 0
    while i < len(items):
        it = items[i]
        if it[0] == "word" and it[1] in ACCENT_FUNCS and i + 1 < len(items):
            out.append(("func", it[1], _as_seq(items[i + 1])))
            i += 2
            continue
        out.append(it)
        i += 1
    items = out

    # ⑧ over/atop/CHOOSE — 좌우 인접 항을 취하는 이항 구조
    out = []
    i = 0
    while i < len(items):
        it = items[i]
        if it[0] == "word" and it[1] in ("over", "atop", "CHOOSE"):
            left = out.pop() if out else None
            right = items[i + 1] if i + 1 < len(items) else None
            if left is None or right is None:
                notes.append(f"dangling '{it[1]}'")
                out.append(it if left is None else left)
                i += 1
                continue
            out.append(("frac", it[1], _as_seq(left), _as_seq(right)))
            i += 2
            continue
        out.append(it)
        i += 1
    items = out

    # ⑨ 남은 순수 그룹은 시각적 묶음일 뿐(중괄호는 렌더되지 않음) — 평탄화.
    #    남은 ctrl(행렬 밖 줄바꿈 #, 정렬 & 등)은 비교 가능한 글리프로 강등.
    flat: list = []
    for it in items:
        if it[0] == "group":
            flat.extend(it[1])
        elif it[0] == "ctrl":
            flat.append(("glyph", it[1]))
        else:
            flat.append(it)
    return flat


# ── 비교 ────────────────────────────────────────────────────────────────────

_LEVEL_ORDER = {"equal": 0, "benign": 1, "suspect": 2, "struct": 3}


@dataclass
class Verdict:
    level: str = "equal"  # equal | benign | suspect | struct
    categories: set[str] = field(default_factory=set)
    diffs: list[str] = field(default_factory=list)

    def bump(self, level: str, category: str, detail: str = "") -> None:
        self.categories.add(category)
        if _LEVEL_ORDER[level] > _LEVEL_ORDER[self.level]:
            self.level = level
        if detail and level in ("suspect", "struct") and len(self.diffs) < 8:
            self.diffs.append(f"[{category}] {detail}")


def _repr_node(n) -> str:
    if n is None:
        return "∅"
    kind = n[0]
    if kind in ("glyph", "word", "lit"):
        return n[1] if kind != "lit" else f'"{n[1]}"'
    if kind == "frac":
        return f"({_repr_seq(n[2])} {n[1]} {_repr_seq(n[3])})"
    if kind == "rad":
        idx = _repr_seq(n[1]) if n[1] else ""
        return f"rad[{idx}]({_repr_seq(n[2])})"
    if kind == "func":
        return f"{n[1]}({_repr_seq(n[2])})"
    if kind == "script":
        s = _repr_node(n[1])
        if n[2]:
            s += f"_({_repr_seq(n[2])})"
        if n[3]:
            s += f"^({_repr_seq(n[3])})"
        return s
    if kind == "env":
        return f"{n[1]}[{len(n[2])}r]"
    if kind == "labeled":
        return f"labeled({n[1]};{','.join(_repr_seq(l) for l in n[2])})"
    if kind == "brace2":
        return f"{n[1]}({_repr_seq(n[2]) if n[2] else ''};{_repr_seq(n[3])})"
    return str(n)


def _repr_seq(seq) -> str:
    if not seq:
        return ""
    return " ".join(_repr_node(n) for n in seq)


def _atom_equal(a: str, b: str, v: Verdict) -> bool:
    if a == b:
        return True
    ca, cb = glyph_class(a), glyph_class(b)
    if ca == cb:
        if is_suspect_atom(a) or is_suspect_atom(b):
            v.bump("suspect", "suspect-synonym", f"{a!r} vs {b!r} — 한컴 실측 필요")
        elif a.lower() == b.lower():
            v.bump("benign", "keyword-case")
        else:
            v.bump("benign", "synonym")
        return True
    return False


def _word_run_text(seq: list, start: int) -> tuple[str, int]:
    """start 부터 이어지는 글리프 런을 문자열로 합친다(인용 비교용)."""
    buf = []
    i = start
    while i < len(seq) and seq[i][0] == "glyph" and len(seq[i][1]) == 1:
        buf.append(seq[i][1])
        i += 1
    return "".join(buf), i


def segment_keywords(run: str) -> list[str]:
    """한컴 그리디 렉싱 근사 — 비인용 글자 런에서 최장 일치 키워드(2글자 이상,
    대소문자 구분)를 찾는다. 'pivot' → ['pi']. 발견 = 렌더 파손 위험."""
    hits: list[str] = []
    i = 0
    n = len(run)
    while i < n:
        best = None
        for j in range(n, i + 1, -1):
            w = run[i:j]
            if len(w) >= 2 and w in KEYWORDS:
                best = w
                break
        if best:
            hits.append(best)
            i += len(best)
        else:
            i += 1
    return hits


def _lit_vs_run(lit_text: str, seq: list, idx: int, v: Verdict) -> int | None:
    """("lit", t) 와 반대편 비인용 글리프 런의 대조. 성공 시 소비한 인덱스,
    실패 시 None."""
    if " " in lit_text:
        return None  # 다단어 인용 vs 낱자 — 공백 렌더 차이가 실재
    run, end = _word_run_text(seq, idx)
    if not run:
        # 반대편이 키워드 1개(max 등)로 앉아 있을 수도 있다
        if idx < len(seq) and seq[idx][0] == "word" and seq[idx][1] == lit_text:
            v.bump("benign", "quoting")
            return idx + 1
        return None
    if run == lit_text:
        risky = segment_keywords(run)
        if risky:
            v.bump(
                "struct",
                "unquoted-keyword-risk",
                f"비인용 '{run}' 안의 키워드 {risky} — 한컴이 기호로 오해",
            )
        else:
            v.bump("benign", "quoting")
        return end
    return None


def _seq_equal(a: list, b: list, v: Verdict, path: str) -> bool:
    i = j = 0
    ok = True
    while i < len(a) and j < len(b):
        na, nb = a[i], b[j]
        # 인용 vs 비인용 런
        if na[0] == "lit" and nb[0] in ("glyph", "word"):
            consumed = _lit_vs_run(na[1], b, j, v)
            if consumed is not None:
                i += 1
                j = consumed
                continue
        if nb[0] == "lit" and na[0] in ("glyph", "word"):
            consumed = _lit_vs_run(nb[1], a, i, v)
            if consumed is not None:
                j += 1
                i = consumed
                continue
        if not _node_equal(na, nb, v, path):
            ok = False
            break
        i += 1
        j += 1
    if ok and (i < len(a) or j < len(b)):
        rest = _repr_seq(a[i:]) or _repr_seq(b[j:])
        v.bump("struct", "arity", f"{path}: 남는 항 {rest!r}")
        ok = False
    if not ok and not v.diffs:
        v.bump(
            "struct",
            "glyph",
            f"{path}: {_repr_seq(a[i:i+3])!r} vs {_repr_seq(b[j:j+3])!r}",
        )
    return ok


def _opt_seq_equal(a, b, v: Verdict, path: str) -> bool:
    return _seq_equal(a or [], b or [], v, path)


def _node_equal(na, nb, v: Verdict, path: str) -> bool:
    ka, kb = na[0], nb[0]
    if ka in ("glyph", "word") and kb in ("glyph", "word"):
        if _atom_equal(na[1], nb[1], v):
            return True
        v.bump("struct", "glyph", f"{path}: {na[1]!r} vs {nb[1]!r}")
        return False
    # 한쪽만 단일 항 그룹이면 알맹이끼리 비교(중괄호는 렌더되지 않음)
    if ka == "group" and len(na[1]) == 1 and kb != "group":
        return _node_equal(na[1][0], nb, v, path)
    if kb == "group" and len(nb[1]) == 1 and ka != "group":
        return _node_equal(na, nb[1][0], v, path)
    if ka == "group" and kb == "group":
        return _seq_equal(na[1], nb[1], v, path + "/{}")
    if ka != kb:
        v.bump("struct", "node-kind", f"{path}: {_repr_node(na)} vs {_repr_node(nb)}")
        return False
    if ka == "lit":
        if na[1] == nb[1]:
            return True
        v.bump("struct", "glyph", f"{path}: {na[1]!r} vs {nb[1]!r}")
        return False
    if ka == "frac":
        if na[1] != nb[1]:
            v.bump("struct", "node-kind", f"{path}: {na[1]} vs {nb[1]}")
            return False
        return _seq_equal(na[2], nb[2], v, path + "/num") and _seq_equal(
            na[3], nb[3], v, path + "/den"
        )
    if ka == "rad":
        return _opt_seq_equal(na[1], nb[1], v, path + "/idx") and _seq_equal(
            na[2], nb[2], v, path + "/rad"
        )
    if ka == "func":
        if na[1] != nb[1]:
            v.bump("struct", "node-kind", f"{path}: {na[1]} vs {nb[1]}")
            return False
        return _seq_equal(na[2], nb[2], v, path + f"/{na[1]}")
    if ka == "script":
        base_ok = (
            _node_equal(na[1], nb[1], v, path + "/base")
            if na[1] and nb[1]
            else na[1] == nb[1]
            or bool(v.bump("struct", "node-kind", f"{path}: 첨자 밑 {_repr_node(na[1])} vs {_repr_node(nb[1])}"))
        )
        return (
            base_ok
            and _opt_seq_equal(na[2], nb[2], v, path + "/sub")
            and _opt_seq_equal(na[3], nb[3], v, path + "/sup")
        )
    if ka == "env":
        if na[1] != nb[1]:
            v.bump("struct", "env-kind", f"{path}: {na[1]} vs {nb[1]}")
            return False
        if len(na[2]) != len(nb[2]):
            v.bump("struct", "arity", f"{path}: 행 {len(na[2])} vs {len(nb[2])}")
            return False
        for r, (ra, rb) in enumerate(zip(na[2], nb[2])):
            if len(ra) != len(rb):
                v.bump("struct", "arity", f"{path}: {r}행 열 {len(ra)} vs {len(rb)}")
                return False
            for c, (ca, cb) in enumerate(zip(ra, rb)):
                if not _seq_equal(ca, cb, v, f"{path}[{r}][{c}]"):
                    return False
        return True
    if ka == "labeled":
        if na[1] != nb[1] and glyph_class(na[1]) != glyph_class(nb[1]):
            v.bump("struct", "glyph", f"{path}: 라벨 연산자 {na[1]} vs {nb[1]}")
            return False
        la = [l for l in na[2] if l]
        lb = [l for l in nb[2] if l]
        if len(la) != len(lb):
            v.bump("benign", "label-pos")
            if not la or not lb:
                v.bump("struct", "arity", f"{path}: 라벨 수 {len(la)} vs {len(lb)}")
                return False
        for sa, sb in zip(la, lb):
            if not _seq_equal(sa, sb, v, path + "/label"):
                return False
        return True
    if ka == "brace2":
        if na[1] != nb[1]:
            v.bump("struct", "node-kind", f"{path}: {na[1]} vs {nb[1]}")
            return False
        return _opt_seq_equal(na[2], nb[2], v, path + "/label") and _seq_equal(
            na[3], nb[3], v, path + "/body"
        )
    v.bump("struct", "node-kind", f"{path}: 미지 노드 {ka}")
    return False


def _normalize_for_compare(seq: list) -> list:
    """비교 직전 재귀 정규화 — builtin 의 { -> }^{ DELTA }(overset)를 labeled
    로 승격해 hwip 의 REL 형태와 맞추고, 하위 seq 에도 똑같이 적용한다."""

    def norm_node(n):
        if n is None:
            return None
        kind = n[0]
        if kind == "group":
            return ("group", _normalize_for_compare(n[1]))
        if kind == "frac":
            return (kind, n[1], _normalize_for_compare(n[2]), _normalize_for_compare(n[3]))
        if kind == "rad":
            return (kind, _normalize_for_compare(n[1]) if n[1] else n[1],
                    _normalize_for_compare(n[2]))
        if kind == "func":
            return (kind, n[1], _normalize_for_compare(n[2]))
        if kind == "script":
            base = norm_node(n[1])
            sub = _normalize_for_compare(n[2]) if n[2] else n[2]
            sup = _normalize_for_compare(n[3]) if n[3] else n[3]
            if base and base[0] in ("glyph", "word"):
                atom = base[1]
                if (atom in _ARROW_CLASS_GLYPHS or atom in _ARROW_CLASS_WORDS) and (
                    sub or sup
                ):
                    labels = tuple(l for l in (sup, sub) if l)
                    return ("labeled", glyph_class(atom), labels)
            return (kind, base, sub, sup)
        if kind == "env":
            return (kind, n[1],
                    [[_normalize_for_compare(c) for c in row] for row in n[2]])
        if kind == "labeled":
            return (kind, n[1], tuple(_normalize_for_compare(l) for l in n[2]))
        if kind == "brace2":
            return (kind, n[1], _normalize_for_compare(n[2]) if n[2] else n[2],
                    _normalize_for_compare(n[3]))
        return n

    return [norm_node(n) for n in seq]


def compare_scripts(a: str, b: str) -> Verdict:
    """두 한컴 스크립트의 구조 동치성 판정."""
    v = Verdict()
    try:
        pa = parse_script(a)
        pb = parse_script(b)
    except Exception as exc:  # 파서 자체 결함 — 검증 도구는 죽지 않는다
        v.bump("struct", "parse-fail", f"파서 예외: {exc}")
        return v
    for note in pa.notes + pb.notes:
        if "unbalanced" in note or "unclosed" in note:
            v.bump("benign", "parse-note")
    _seq_equal(
        _normalize_for_compare(pa.seq), _normalize_for_compare(pb.seq), v, "$"
    )
    return v


def lint_hancom_lexing(script: str) -> list[str]:
    """단일 스크립트 린트 — 비인용 글자 런에 숨은 키워드(한컴 그리디 렉싱이
    기호로 바꿔 그릴 조각)를 찾는다. 'I_{pivot}' 류 파손의 조기 경보.

    원문 문자열 기준으로 본다 — 낱자 분해 표기('p i v o t')는 글자마다
    독립 토큰이라 렉싱 위험이 없으므로(무따옴표 안정 표기의 원리) 이어붙여
    검사하면 오탐이다. 런 전체가 키워드 하나(max·det)면 의도된 함수명이다."""
    warnings: list[str] = []
    unquoted = re.sub(r'"[^"]*"', " ", script)
    for run in re.findall(r"[A-Za-z]{2,}", unquoted):
        if run in KEYWORDS:
            continue
        hits = segment_keywords(run)
        if hits:
            warnings.append(f"비인용 런 '{run}' 에 키워드 {hits}")
    return warnings


# ── 셀프테스트 ──────────────────────────────────────────────────────────────

_SELFTEST = [
    # (a, b, 기대 level)
    ('I_{"pivot"} = {mgdT^{2}} over {4 pi^{2}}',
     'I_{"pivot"} `=` {m g d T^{2}} over {4 pi^{2}}', "equal"),
    ("vec {A} TIMES vec {B}", "vec {A} times vec {B}", "benign"),
    ("DELTA G = DELTA H - T DELTA S", "Delta G `=` Delta H `-` T Delta S", "benign"),
    ("sum_{n=1}^{ INF } {1} over {n^{2}}", "sum_{n `=` 1}^{inf} {1} over {n^{2}}",
     "benign"),
    ("2 {}^{3} sqrt {8}", "2 root 3 of {8}", "equal"),  # n제곱근 두 표기 동치
    ("( { partial V} over { partial T} )_{P}",
     "LEFT( {partial V} over {partial T} RIGHT)_{P}", "equal"),
    ("2KClO_{3} { -> }^{ DELTA } 2KCl", "2 KC l O_{3} REL rarrow {Delta} {} 2 KC l",
     "benign"),
    ("OVERBRACE {a+b}^{n}", "OVERBRACE {n} {a `+` b}", "equal"),
    ("x in A", "x ` IN ` A", "benign"),
    # 실결함 재현 — 서로 다른 수식은 반드시 struct 로 갈라야 한다
    ("2 root 3 of {8}", "2^{3} sqrt {8}", "struct"),          # n제곱근 결합 파손
    ("A^{T}", "A^{intercal}", "struct"),                       # 미지 명령 노출
    ("p <-> q", "p LRARROW q", "struct"),                      # ↔ vs ⇔
    ("{a} over {b}", "{a} over {c}", "struct"),
    ("sqrt {x + 1}", "sqrt {x} + 1", "struct"),
    ("x_{2}", "x^{2}", "struct"),
    ("matrix { a & b # c & d }", "pmatrix{ a & b # c & d }", "struct"),
    ('I_{"pivot"}', "I_{pivot}", "struct"),                    # pivot 안의 pi 위험
    ('v_{"max"}', "v_{max}", "benign"),                        # max 는 통짜 키워드
    ("VERT x VERT", "LEFT VERT x RIGHT VERT", "equal"),
    ("F(x) |_{0}^{1}", "F (x) |_{0}^{1}", "equal"),
    ("cases { x^{2} & (x >= 0) # -x & (x < 0) }",
     "cases{ x^{2} & (x geq 0) # `-` x & (x `<` 0) }", "benign"),
]


def run_selftest() -> int:
    bad = 0
    for a, b, want in _SELFTEST:
        got = compare_scripts(a, b).level
        # equal ⊂ benign 방향 완화는 허용하지 않는다 — 정확히 등급 일치 확인
        ok = got == want or (want == "equal" and got == "equal")
        if not ok:
            v = compare_scripts(a, b)
            print(f"✗ {a!r} vs {b!r}: want {want}, got {got} {v.diffs}")
            bad += 1
    lint = lint_hancom_lexing("I_{pivot} + x_{max}")
    if not any("pivot" in w for w in lint):
        print(f"✗ lint 가 pivot 위험을 놓침: {lint}")
        bad += 1
    if any("max" in w for w in lint):
        print(f"✗ lint 가 키워드 max 를 오탐: {lint}")
        bad += 1
    if bad:
        print(f"selftest 실패 {bad}건")
        return 1
    print(f"✓ hwp_script_parser selftest {len(_SELFTEST)}쌍 + lint 통과")
    return 0


if __name__ == "__main__":
    sys.exit(run_selftest())
