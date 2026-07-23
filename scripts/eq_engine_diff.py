# -*- coding: utf-8 -*-
"""
수식 엔진 골든셋 비교 도구 — builtin(LatexToHwpConverter) vs hwip(vendor).

보고서 도메인(화학/물리/수학 급수)의 대표 LaTeX 들을 **실제 파이프라인 경로**
(placeholder_to_script = 엔진 변환 + normalize_hwp_script)로 두 번 돌려 비교한다.
hwip 통합의 회귀 검증용. 출력 끝에 요약(변환 성공률/금지 패턴 검사)을 찍는다.

실행:
  .venv/bin/python3 scripts/eq_engine_diff.py          # 비교표 + 검사
  .venv/bin/python3 scripts/eq_engine_diff.py --quiet  # 검사 결과만
"""
import os
import re
import sys
import importlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "lib", "equation"))

import hwp_script_parser as hsp  # noqa: E402 — 구조 동치성 비교기(검증 전용)

# 도메인별 골든셋 — 실제 보고서(화학 사전/결과, 물리 결과/수행, 수학 급수)에서
# 나오는 형태를 대표한다. 새 유형의 수식 문제가 발견되면 여기에 추가할 것.
GOLDEN = [
    # ── 물리 ──
    r"I_{pivot} = \frac{mgdT^2}{4\pi^2}",
    r"T = 2\pi\sqrt{\frac{L}{g}}",
    r"\omega = \sqrt{\frac{k}{m}}",
    r"\vec{F} = m\vec{a}",
    r"\vec{A} \cdot \vec{B} = AB\cos\theta",
    r"\vec{A} \times \vec{B}",
    r"E = \frac{1}{2}mv^2 + \frac{1}{2}I\omega^2",
    r"\sum_{i=1}^{N} m_i r_i^2",
    r"v = v_0 + at, \quad x = x_0 + v_0 t + \frac{1}{2}at^2",
    r"\left( \frac{\partial V}{\partial T} \right)_P",
    r"\sin^2\theta + \cos^2\theta = 1",
    r"\Delta x = \frac{\lambda L}{d}",
    r"F = G\frac{m_1 m_2}{r^2}",
    r"\eta = \frac{W_{out}}{Q_{in}} \times 100\%",
    # ── 화학 ──
    r"\Delta G = \Delta H - T\Delta S",
    r"K_a = \frac{[H^+][A^-]}{[HA]}",
    r"pH = -\log[H^+]",
    r"[H^+] = \sqrt{K_a C}",
    r"k = A e^{-\frac{E_a}{RT}}",
    r"\ln \frac{P_2}{P_1} = -\frac{\Delta H_{vap}}{R} \left( \frac{1}{T_2} - \frac{1}{T_1} \right)",
    r"PV = nRT",
    r"M = \frac{w}{V} \times \frac{1000}{M_w}",
    r"\text{수득률} = \frac{\text{실제 수득량}}{\text{이론 수득량}} \times 100\%",
    r"q = mc\Delta T",
    r"\Delta T_b = K_b \cdot m",
    # ── 수학(급수 탐구) ──
    r"\sum_{n=1}^{\infty} ar^{n-1} = \frac{a}{1-r} \quad (|r| < 1)",
    r"\lim_{n \to \infty} \left| \frac{a_{n+1}}{a_n} \right| = L",
    r"S_n = \frac{a(1-r^n)}{1-r}",
    r"\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}",
    r"e = \sum_{n=0}^{\infty} \frac{1}{n!}",
    r"\int_0^1 x^2 \, dx = \frac{1}{3}",
    r"\lim_{n \to \infty} \left(1 + \frac{1}{n}\right)^n = e",
    r"a_n = a_1 + (n-1)d",
    # ── 까다로운 케이스 ──
    r"x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}",
    r"\begin{pmatrix} a & b \\ c & d \end{pmatrix}",
    r"f(x) = \begin{cases} x^2 & (x \ge 0) \\ -x & (x < 0) \end{cases}",
    r"\frac{\frac{1}{a} + \frac{1}{b}}{\frac{1}{c}}",
    r"\hat{x} + \tilde{y} + \bar{z} + \dot{q}",
    r"90\% \pm 0.5\%",
    r"\text{평균속도} = \frac{\Delta x}{\Delta t}",
    # ── 회귀 추가분(2026-06-11): builtin 미지원 명령·mhchem·키워드 융합 ──
    r"g = (9.79 \pm 0.05)\ \mathrm{m/s^2}",
    r"\theta_{max} = 45^\circ",
    r"E = \hbar \omega",
    r"P \propto T^4",
    r"\tau = F\ell",
    r"d = 1.54\,\AA",
    r"\vec v + \overrightarrow{AB}",
    r"\Delta G^\circ = -RT \ln K",
    r"25\,^\circ\text{C}",
    r"a_1, a_2, \ldots, a_n",
    r"\sup_{n \ge 1} a_n \le \det A",
    r"\dbinom{2n}{n} \le 4^n",
    r"x \in \mathbb{R}, \quad \sum_{d \mid n} d",
    r"\ce{2H2 + O2 -> 2H2O}",
    r"\ce{N2 + 3H2 <=> 2NH3}",
    r"\ce{Fe^{3+} + e^- -> Fe^{2+}}",
    r"\begin{align} x &= y \\ z &= w \end{align}",
    r"\begin{matrix} \frac{a \\ b}{c} \end{matrix}",
    r"2KClO_3 \overset{\Delta}{\rightarrow} 2KCl + 3O_2",
    r"\overbrace{a+b}^{n} + \underbrace{c+d}_{m}",
    # ── 회귀 추가분(2026-06-12): 유니코드 화살표·경계조건 첨자·연분수·
    #    잘린 인자·\text 다단어·\cdot·\left. (evaluated-at) ──
    "HA ⇌ H^+ + A^-",
    "2H_2 + O_2 → 2H_2O",
    r"\max_{1 \leq k \leq n} a_{k}",
    r"\min_{n \geq 1} a_n",
    r"\max_{k \neq j} |a_k|",
    r"\sum_{d \mid n} d",
    r"a_{1, \ldots, n}",
    r"\sup_{x \in A} f(x)",
    r"\cfrac{1}{2 + \cfrac{3}{4}}",
    r"\frac{a}{b",   # 잘린 인자 — 알몸 frac 키워드 누출·중괄호 불균형 회귀
    r"\sqrt{x",
    r"\binom{n}{k",
    r"\%\,\text{percent difference} = \frac{|I_{pivot} - I_{cm}|}{I_{cm}} \times 100\%",
    r"\text{percent difference}",
    r"\text{Diff}",
    r"\mathrm{kg}",
    r"v_{\text{max}}",
    r"CuSO_4 \cdot 5H_2O",
    r"R = 8.314 \, \mathrm{J/(mol \cdot K)}",
    r"\left. F(x) \right|_{0}^{1}",
    r"\left. \frac{dy}{dx} \right|_{x=0}",
    # ── 회귀 추가분(2026-06-12b): 1-인자 명령 융합(mvec/xhat/2sqrt)·접두 충돌
    #    명령(\pmod 의 \pm, \limits 의 \lim, \top 의 \to, \neg 의 \ne,
    #    \intercal 의 \int)·행렬식 vmatrix→dmatrix ──
    r"A_x\hat{i} + A_y\hat{j}",
    r"q\vec{v} \times \vec{B}",
    r"r\hat{r}",
    r"I\ddot{\theta}",
    r"2\sqrt{2}",
    r"2\sqrt[3]{8}",
    r"a \equiv b \pmod{n}",
    r"\sum\limits_{n=1}^{\infty} a_n",
    r"\lim\limits_{n \to \infty} \frac{a_{n+1}}{a_n}",
    r"A^\top B",
    r"\neg p",
    r"A^\intercal",
    r"\begin{vmatrix} a & b \\ c & d \end{vmatrix} = ad - bc",
    # ── 회귀 추가분(2026-06-12c): 중괄호 없는 단일 토큰 인자(LaTeX 규약:
    #    \frac12 = 1/2) — hwip 의 숫자 run 통짜 오인(분자 12, 다음 항을
    #    분모로 삼킴, 빈 분모 박스)과 builtin 'frac' 알몸 키워드 누출 회귀 ──
    r"\frac12 x",
    r"\frac12",
    r"\frac12 + \frac13",
    r"\frac1{2x} + \frac{a}2",
    r"\frac\pi2",
    r"\binom52",
    # ── 회귀 추가분(2026-06-12d): 노름 구분자 — bare \lVert/\rVert/\Vert 의
    #    'lVert'/'Vert' 리터럴 단어 노출, \|·\left\| 의 노름 ‖→| 단일 막대
    #    격하(절댓값 의미 변형) 회귀. \lvert 계열은 절댓값 | 유지 확인용 ──
    r"\lVert x \rVert \leq \lVert x - y \rVert + \lVert y \rVert",
    r"\Vert x \Vert",
    r"\left\| x \right\|",
    r"\|v\|",
    r"\lvert x \rvert",
    # ── 회귀 추가분(2026-06-12e): 그리스 첨자 인용 사고(\lambda_{\pi} →
    #    _{"pi"})·\pu 단위·미확인 명령 영단어 누출(implies/iff/geqslant/
    #    displaystyle/mid)·물리 %Diff/絶對값·공백 낀 첨자(_ {max}) ──
    r"\lambda_{\pi}",
    r"E_{\alpha} + T_{\beta}",
    r"\pu{123 kJ/mol}",
    r"\pu{8.314 J//(mol.K)}",
    r"p \implies q",
    r"p \iff q",
    r"a \geqslant b, c \leqslant d",
    r"\displaystyle \frac{a}{b}",
    r"\{ x \mid x > 0 \}",
    r"\%Diff = |I_{pivot} - I_{cm}|/I_{cm} \times 100\%",
    r"\omega _{max} = 2.5 rad/s",
    # ── 회귀 추가분(2026-06-14): 물리 탐구성찰 보고서의 벡터 미적분(맥스웰
    #    방정식)·발산정리·다중적분. 실제 깨진 보고서(2402_…_일반물리학탐구성찰)
    #    에서 ∇/▽(나블라)·∂(편미분)·∭∬∮∯(닫힌·다중적분)·{∫∫∫}/{∮∮}(스택)이
    #    따옴표 리터럴('"∇"')·비키워드(iiint/oiint)·경계첨자 인용('"partial V"')
    #    로 깨졌다. LaTeX 정식 입력은 양 엔진 모두 정상이어야 한다.
    r"\iiint_{V} (\nabla \cdot F)\, dV = \oint_{\partial V} F \cdot dA",
    r"\iint_{S} (\nabla \times F) \cdot dA = \oint_{\partial S} F \cdot dl",
    r"\nabla \cdot E = \rho / \epsilon_{0}",
    r"\nabla \times E = -\partial B / \partial t",
    r"\nabla \cdot (\nabla \times A) = 0",
    r"B = \nabla \times A",
    # 닫힌 면/체적분 \oiint/\oiiint — 한컴 비키워드 'oiint' 글자 노출 회귀
    # (빌트인은 COMMANDS, hwip 은 preprocess_latex_body 의 \oint 정규화로 잡힌다).
    r"\oiint_{S} E \cdot dA = Q / \epsilon_{0}",
    # ── 회귀 추가분(2026-07-12): 구조 동치성 검사(hwp_script_parser)로 발견한
    #    실결함 잠금 — 이중화살표 오매핑(빌트인 \Leftarrow→'<='(≤ 격하),
    #    \Leftrightarrow/\iff→'<->'(단줄 격하)), hwip n제곱근 결합 파손
    #    (2\sqrt[3]{8}→2^{3}√8), \intercal 영단어 노출, align 환경 알몸 &/# ──
    r"p \Leftarrow q",
    r"A \Leftrightarrow B",
    # ── 회귀 추가분(2026-07-12b): 렌더 시트 실측으로 확정한 한컴 결함 잠금 —
    #    \inf 하한(알몸 inf 는 ∞ 로 렌더), \sup 충돌은 기존 #51·#68 케이스가
    #    담당. n제곱근·\neg·집합 중괄호는 기존 케이스의 guard 갱신으로 잠금 ──
    r"\inf_{n \ge 1} b_n",
]

# 최종 스크립트에 절대 남으면 안 되는 패턴(원시 LaTeX 잔재/마커 잔재 신호).
# 중첩 중괄호 {{ }} 는 정상 스크립트(sqrt {{L} over {g}})에 나오므로 검사하지 않는다.
FORBIDDEN = [
    r"\frac", r"\sqrt", r"\left", r"\right", r"\begin", r"\end",
    r"\sum", r"\lim", r"\int", r"\text", "{{EQ", "{{EQN",
]
# 키워드가 화학식 압축에 붙어 파손된 신호(예: TDELTAS, TDelta, HLEFT, xVERT)
GLUED_KEYWORD = [
    "DELTA", "Delta", "SIGMA", "Sigma", "Omega", "Theta", "Lambda", "LEFT", "RIGHT",
    "VERT",
]
# 1-인자 구조 명령이 직전 글자에 붙은 융합 신호 — 'mvec {a}', '2sqrt {2}',
# 'A_{"xhat"}' (builtin 선행 패딩 누락 회귀). 인용 라벨 안의 융합(_{"xhat"})도
# 잡아야 하므로 따옴표를 벗기지 않은 원문에 대고 검사한다 — 골든셋의 영어
# 인용 텍스트에 hat/bar 따위로 끝나는 단어(that 등)를 넣으면 오탐하니 주의.
FUSED_COMMAND_RE = re.compile(
    r"[A-Za-z0-9}](?:vec|widehat|hat|widetilde|tilde|overline|bar|ddot|dot|"
    r"sqrt|root|dyad)\b"
)
# dot/bar 를 꼬리로 갖는 합법 키워드 — 융합 검사 전에 가린다(붙은 'Iddot'·
# 'Ncdot' 류는 \b 경계가 없어 가려지지 않고 그대로 검출된다).
FUSED_LEGIT_RE = re.compile(r"\b(?:cdot|ddot|odot|hbar)\b")
# 백슬래시 없이 남은 LaTeX 전용 구조 키워드(강등 잔재 'frac {a}{b' 신호) —
# validate_hwpx_equations 의 _SCRIPT_BARE_LATEX_KEYWORD_RE 와 동일 기준.
BARE_KEYWORD_RE = re.compile(r"\b(?:[dtc]?frac|[dt]?binom)\b")
# 빈 인자 분수/이항계수(over {}·{} over·CHOOSE {}) — 단일 토큰 인자(\frac12)
# 오인이나 인자 소실의 신호. REL 화살표의 정상 빈 라벨 {} 과 달리 over/CHOOSE
# 의 인자는 골든셋 입력에서 비어선 안 된다.
EMPTY_FRAC_ARG_RE = re.compile(
    r"\{\s*\}\s*(?:over|CHOOSE)\b|\b(?:over|CHOOSE)\s*\{\s*\}"
)

# {{EQ:...}}(한컴 스크립트) 경로 회귀 — 본문에 LaTeX \연산자가 샌 입력은
# hwip 재해석 금지(over/cases/rm 글자 분해), sqrt[3]{x} 는 n제곱근 구조로.
# (입력, 출력에 반드시 살아 있어야 하는 구조 조각들)
GOLDEN_EQ = [
    (r"{a} over {b} \times 100", ["over", "TIMES"]),
    (r"cases{x & x \ge 0 # -x & x < 0}", ["cases", ">="]),
    (r"rm {mol} \cdot L^{-1}", ["rm", "mol", "cdot"]),
    (r"{DELTA T} over {t} \approx 0.5", ["DELTA", "over", "APPROX"]),
    # n제곱근은 '{}^{n} sqrt' — 'root n of' 는 한컴 문법이 아니어서 √n+'of'
    # 로 깨진다(렌더 시트 실측 2026-07-12).
    ("sqrt[3]{x} + 1", ["^{3} sqrt {x}"]),
    ("√[3]{8} = 2", ["^{3} sqrt {8}"]),
    # {{EQ:}} raw 경로에 모델이 유니코드 적분 글리프·다중적분 스택을 섞어 쓴
    # 실제 깨짐(2026-06-14, 물리 탐구성찰). 엔진을 안 거치므로 normalize_hwp_script
    # 의 raw 유니코드 정규화가 직접 키워드로 바꿔야 한다 — '"∭"'/'{∫∫∫}'/'∂' 가
    # 따옴표 리터럴·비키워드로 남으면 안 된다(아래 check_extra_regressions 가
    # 백슬래시·금지패턴도 함께 검사).
    (r"{∮∮}_{S} E cdot dA = {∫∫∫}_{V} ( nabla cdot E ) dV",
     ["oint_{S}", "int int int_{V}", "nabla cdot E"]),
    (r"∭_{V} (∇·F) dV = ∯_{∂V} F·dA",
     ["int int int_{V}", "nabla cdot F", "oint_", "partial V", "F cdot dA"]),
    (r"∬_{S} (∇×F)·dA = ∮_{∂S} F·dl",
     ["int int_{S}", "nabla times F", "cdot dA", "oint_", "partial S"]),
]

# {{EQ:}} raw 경로 출력에 절대 없어야 할 유니코드 수식 글리프·따옴표 리터럴·
# 스택 잔재. GOLDEN_EQ 의 유니코드 케이스에만 적용한다(다른 EQ 입력엔 무해).
RAW_EQ_FORBIDDEN_GLYPHS = (
    '"∇"', '"▽"', '"∂"', '"∭"', '"∬"', '"∮"', '"∯"',
    "∇", "▽", "∂", "∫", "∬", "∭", "∮", "∯", "∰",
    "{∫", "{∮", "·",
)

# EQ-LATEX 골든 케이스의 구조 잠금 — 입력별 (반드시 살 조각 keep, 과거 파손
# 신호 ban)을 두 엔진 출력 모두에 검사한다. 접두 충돌(\pmod→'+- od',
# \limits→'lim its', \top→'-> p', \neg→'!= g', \intercal→'{int} ercal'),
# 행렬식 vmatrix→dmatrix, \cdot(·)→TIMES(×) 역행을 잠근다.
GOLDEN_LATEX_GUARD = {
    r"a \equiv b \pmod{n}": (["mod"], ["+- od", "od{"]),
    r"\sum\limits_{n=1}^{\infty} a_n": (["sum_"], ["limits", "lim its"]),
    r"\lim\limits_{n \to \infty} \frac{a_{n+1}}{a_n}": (
        ["lim_"], ["limits", "lim its"],
    ),
    r"A^\top B": (["top"], ["-> p"]),
    # lnot(소문자)은 한컴 비키워드('ln'+'otp' 렌더, 실측) — 정준은 LNOT
    # (편집기 재직렬화·문서 렌더 모두 실측 확인).
    r"\neg p": (["LNOT"], ["lnot", "!= g"]),
    r"A^\intercal": (["{T}"], [" ercal", "intercal"]),
    r"p \Leftarrow q": (["LARROW"], ["<="]),
    r"A \Leftrightarrow B": (["LRARROW"], ["<->"]),
    # n제곱근 — 'root n of' 는 √n+'of' 로 깨지고(실측), hwip 의 알몸 ^{3} 은
    # 선행 항에 붙는다. 정규형은 빈 밑 '{}^{3} sqrt'.
    r"2\sqrt[3]{8}": (["{}^{3} sqrt {8}"], ["root", "2^{3}"]),
    r"\begin{align} x &= y \\ z &= w \end{align}": (["matrix"], []),
    # \sup/\inf 함수명 — 알몸 sup 은 한컴 위첨자 연산자와 충돌해 수식이
    # 통째로 증발하고(실측 S2-51·68), 알몸 inf 는 ∞ 로 그려진다. 인용은
    # 편집기 왕복에서 깨지므로(실측) 낱자 분해가 정준형이다.
    r"\sup_{n \ge 1} a_n \le \det A": (["s{}u{}p"], ["sup_{", '"sup"', "s u p"]),
    r"\inf_{n \ge 1} b_n": (["i{}n{}f"], ["inf_{", '"inf"', "i n f"]),
    r"\sup_{x \in A} f(x)": (["s{}u{}p"], ["sup_{", '"sup"', "s u p"]),
    r"\begin{vmatrix} a & b \\ c & d \end{vmatrix} = ad - bc": (
        ["dmatrix"], ["vmatrix", "Vmatrix"],
    ),
    r"\vec{A} \cdot \vec{B} = AB\cos\theta": (["cdot"], ["TIMES"]),
    r"R = 8.314 \, \mathrm{J/(mol \cdot K)}": (["cdot"], ["TIMES"]),
    # 단일 토큰 인자(\frac12 = 1/2) — 숫자 run 통짜 오인({12})·빈 분모(over {})
    # ·builtin 알몸 frac 누출(BARE_KEYWORD_RE가 별도 검출)을 잠근다.
    r"\frac12 x": (["{1} over {2}"], ["{12}", "over {}"]),
    r"\frac12": (["{1} over {2}"], ["{12}", "over {}"]),
    r"\frac12 + \frac13": (
        ["{1} over {2}", "{1} over {3}"],
        ["{12}", "{13}", "over {}"],
    ),
    r"\frac1{2x} + \frac{a}2": (["{1} over", "{a} over {2}"], ["over {}"]),
    r"\frac\pi2": (["over {2}"], ["over {}"]),
    r"\binom52": (["{5} CHOOSE {2}"], ["{52}"]),
    # 노름 구분자 — 'lVert'/'Vert' 영단어 노출 금지(대소문자 구분: 키워드는
    # 전대문자 VERT), 노름 ‖ 이 단일 막대 |(절댓값)로 격하되면 안 된다.
    # \lvert 계열(절댓값)은 반대로 | 를 유지하고 VERT 로 승격되면 안 된다.
    r"\lVert x \rVert \leq \lVert x - y \rVert + \lVert y \rVert": (
        ["VERT"], ["lVert", "rVert", "|"],
    ),
    r"\Vert x \Vert": (["VERT"], ["Vert", "|"]),
    r"\left\| x \right\|": (["VERT"], ["|"]),
    r"\|v\|": (["VERT"], ["|"]),
    r"\lvert x \rvert": (["|"], ["lvert", "rvert", "VERT"]),
    # 그리스 '이름' 첨자는 텍스트 인용 금지 — π 첨자가 업라이트 "pi" 로 죽는다.
    r"\lambda_{\pi}": (["pi"], ['"pi"']),
    r"E_{\alpha} + T_{\beta}": (["alpha", "beta"], ['"alpha"', '"beta"']),
    # \pu(mhchem 물리량+단위) — 'pu' 영단어 노출 금지. 단위는 무따옴표
    # 안정 표기(kJ/mol 등 키워드 없는 단어는 알몸, 공백은 ~)가 정준형.
    r"\pu{123 kJ/mol}": (["123 ~ kJ/mol"], ["pu", '"']),
    r"\pu{8.314 J//(mol.K)}": (["8.314 ~ J/(mol·K)"], ["pu", '"']),
    # 미확인 명령 영단어 누출 — 양 엔진 모두 기호/무시로 처리해야 한다.
    r"p \implies q": (["RARROW"], ["implies"]),
    r"p \iff q": (["LRARROW"], ["iff"]),
    r"a \geqslant b, c \leqslant d": ([], ["geqslant", "leqslant"]),
    r"\displaystyle \frac{a}{b}": (["over"], ["displaystyle"]),
    # 집합 리터럴 중괄호 — 알몸 '{' 는 그룹으로 먹혀 증발(실측 S2-114).
    # 정준형은 스트레치 쌍 LEFT{ RIGHT} (실측 S1-4 정상, 무따옴표).
    r"\{ x \mid x > 0 \}": (["LEFT{", "|", "RIGHT}"], ["mid", '"{"']),
    # 물리 %Diff 절댓값식 — 라벨 정준형: 키워드 품은 pivot 은 낱자 분해,
    # 키워드 없는 cm 은 알몸(무따옴표 안정 표기).
    r"\%Diff = |I_{pivot} - I_{cm}|/I_{cm} \times 100\%": (
        ["p{}i{}v{}o{}t", "{ cm }"], ['"pivot"', '"cm"', "p i v o t"],
    ),
    # LaTeX 원문의 '_ {…}' 공백 첨자 — max 는 함수 키워드라 알몸 유지.
    r"\omega _{max} = 2.5 rad/s": (["_{ max }"], ['"max"', "m a x"]),
    # ── 벡터 미적분 / 맥스웰(2026-06-14, int 반복 갱신 2026-06-15) ──
    # ∇/∂ 는 nabla/partial 키워드로(따옴표 리터럴 금지). 다중적분은 int 반복
    # (iiint→'int int int', iint→'int int') — 한컴 '본문' 렌더러가 tint/dint 를
    # 글자로 노출하므로(실측) int 반복으로 ∫∫∫/∫∫ 를 그린다. 닫힌적분은 oint.
    # 경계 첨자 _{∂V}/_{∂S} 는 인용되지 않은 partial(_{"partial V"} 금지).
    # \times 는 엔진별 대소문자(builtin TIMES / hwip times)라 keep 에서 제외.
    r"\iiint_{V} (\nabla \cdot F)\, dV = \oint_{\partial V} F \cdot dA": (
        ["int int int_", "nabla cdot", "oint_", "partial V"],
        ['"partial', "iiint", "tint", '"nabla"'],
    ),
    r"\iint_{S} (\nabla \times F) \cdot dA = \oint_{\partial S} F \cdot dl": (
        ["int int_", "nabla", "oint_", "partial S"],
        ['"partial', "iint_", "dint", '"nabla"'],
    ),
    r"\nabla \cdot E = \rho / \epsilon_{0}": (
        ["nabla cdot E", "rho", "epsilon_{0}"],
        ['"nabla"', '"rho"', "∇", "▽"],
    ),
    r"\nabla \times E = -\partial B / \partial t": (
        ["nabla", "partial B", "partial t"],
        ['"partial"', "∂"],
    ),
    r"\nabla \cdot (\nabla \times A) = 0": (
        ["nabla cdot", "nabla"],
        ['"nabla"', "▽"],
    ),
    r"B = \nabla \times A": (["nabla"], ['"nabla"', "▽"]),
    r"\oiint_{S} E \cdot dA = Q / \epsilon_{0}": (
        ["oint_", "epsilon_{0}"],
        ["oiint", '"epsilon"'],
    ),
}

# 구조 불일치 심사 후 '의도된 차이'로 승인한 케이스 — {LaTeX: 사유}.
# 새 struct 불일치는 여기 등록하기 전에 반드시 원인 심사부터 한다.
STRUCT_ALLOW: dict[str, str] = {}

# 근접 오타 마커 변형 — canonicalize + lenient 스캐너가 전부 구제해야 한다.
MARKER_VARIANTS = [
    ("{{EQ-LATEX：\\frac{1}{2}}} 입니다", "EQ-LATEX"),  # 전각 콜론(U+FF1A)
    ("{{EQLATEX:\\frac{a}{b}}}", "EQ-LATEX"),           # 하이픈 누락
    ("{{EQ_LATEX:\\frac{1}{2}}}", "EQ-LATEX"),          # 언더스코어
    ("{EQ-LATEX:\\frac{1}{2}} 입니다", "EQ-LATEX"),     # 단일 중괄호
    ("{{eqn latex: x^2}} 끝", "EQN-LATEX"),             # 소문자+공백 구분
]


def check_output(engine, label, out, problems):
    """엔진 출력 공통 검사 — 금지 패턴/알몸 키워드/중괄호 불균형/키워드 붙음."""
    for bad in FORBIDDEN:
        if bad in out:
            problems.append(f"[{engine}] {label} 출력에 금지 패턴 {bad!r}: {out[:120]}")
    sans_quotes = re.sub(r'"[^"]*"', " ", out)
    if BARE_KEYWORD_RE.search(sans_quotes):
        problems.append(f"[{engine}] {label} 출력에 알몸 LaTeX 키워드: {out[:120]}")
    # 인용 리터럴을 벗긴 sans_quotes 가 아니라 원문에 대고 검사한다 —
    # {"실제 수득량"} over 의 인용 제거가 가짜 빈 그룹({ } over)을 만든다.
    if EMPTY_FRAC_ARG_RE.search(out):
        problems.append(f"[{engine}] {label} 출력에 빈 분수 인자: {out[:120]}")
    if sans_quotes.count("{") != sans_quotes.count("}"):
        problems.append(f"[{engine}] {label} 출력 중괄호 불균형: {out[:120]}")
    for kw in GLUED_KEYWORD:
        if re.search(rf"[A-Za-z0-9\}}]{kw}\b", out):
            problems.append(f"[{engine}] {label} 출력에 키워드 붙음({kw}): {out[:120]}")
    if FUSED_COMMAND_RE.search(FUSED_LEGIT_RE.sub(" ", out)):
        problems.append(f"[{engine}] {label} 출력에 구조 명령 융합: {out[:120]}")


def check_extra_regressions(eq, engine, problems):
    """마커 근접변형 구제 + {{EQ:한컴 스크립트}} 경로 회귀 검사."""
    for raw, want_kind in MARKER_VARIANTS:
        fixed = eq.canonicalize_equation_marker_prefixes(raw)
        phs = eq._find_placeholders_lenient(fixed)
        if len(phs) != 1 or phs[0].kind != want_kind:
            problems.append(
                f"[{engine}] 마커 변형 교정 실패: {raw!r} → {fixed!r} "
                f"(마커 {len(phs)}개)"
            )
            continue
        try:
            out = eq.placeholder_to_script(phs[0].kind, phs[0].body)
        except Exception as exc:
            problems.append(f"[{engine}] 마커 변형 변환 예외: {raw!r}: {exc}")
            continue
        if not out.strip():
            problems.append(f"[{engine}] 마커 변형 빈 출력: {raw!r}")
        check_output(engine, f"마커변형 {raw!r}", out, problems)
    for body, must_keep in GOLDEN_EQ:
        try:
            out = eq.placeholder_to_script("EQ", body)
        except Exception as exc:
            problems.append(f"[{engine}] EQ 경로 변환 예외: {body!r}: {exc}")
            continue
        for piece in must_keep:
            if piece not in out:
                problems.append(
                    f"[{engine}] EQ 경로 구조 소실({piece!r} 없음): "
                    f"{body!r} → {out[:120]}"
                )
        if "\\" in out:
            problems.append(f"[{engine}] EQ 경로 백슬래시 잔재: {out[:120]}")
        for glyph in RAW_EQ_FORBIDDEN_GLYPHS:
            if glyph in out:
                problems.append(
                    f"[{engine}] EQ 경로 유니코드 글리프 잔재({glyph!r}): "
                    f"{body!r} → {out[:120]}"
                )
        check_output(engine, f"EQ {body!r}", out, problems)


# ── 이중 미러 동기화 검사 ────────────────────────────────────────────────────
# lib/pipelines/chem-pre/hwpx-gen.py 는 hwpx_equation_tool 의 일부 심볼을
# (의존성 문제로) 복제해 갖고 있다 — EQ_SCRIPT_KEYWORD·compact_chemical_spacing·
# _EQ_PREFIX_RESCUE_RE·canonicalize_equation_marker_prefixes. 한쪽만 고치는
# 사고(과거 TDELTAS 파손)가 재발하지 않도록 둘의 동일성을 회귀로 잡는다.
_MIRROR_FUNC_NAMES = (
    "compact_chemical_spacing",
    "_canonical_eq_prefix",
    "canonicalize_equation_marker_prefixes",
    "replace_bare_latex_symbol_commands",
)
_MIRROR_ASSIGN_NAMES = (
    "EQ_SCRIPT_KEYWORD",
    "_EQ_PREFIX_RESCUE_RE",
    "_BARE_LATEX_SYMBOL_MAP",
    "_BARE_LATEX_SYMBOL_CMD_RE",
)
_MIRROR_COMPACT_PROBES = [
    "DELTA G = DELTA H - T DELTA S",
    "2 H_{2} + O_{2} -> 2 H_{2} O",
    'C u S O_{4} cdot 5 H_{2} O',
    '"percent difference" H O',
    "Na Cl + H_{2} O",
    "x VERT y VERT z",
    "LEFT ( H_{2} O RIGHT )",
    "{A l_{2} O_{3}} over {2}",
    "K Cl O_{3} BUILDREL -> {DELTA} K Cl",
]
# 단독 LaTeX 기호 명령 → 유니코드 강등(replace_bare_latex_symbol_commands)
# 미러 동작 프로브 — 화이트리스트 치환, 미지/구조 명령 보존, 한글 산문 무변형.
_MIRROR_SYMBOL_PROBES = [
    "\\times 100 이다. 또한 E = h\\nu 이고 \\Delta G = -RT\\ln K 다.",
    "농도 1.0 \\mu mol/L, 파장은 \\lambda, 각진동수는 \\omega 다.",
    "오차 \\pm 0.5, 근사 \\approx 3.14, 발산 \\infty, 각도 45^\\circ.",
    "\\nuclear 같은 미지 명령과 \\frac, \\sqrt 구조 명령은 보존한다.",
    "백슬래시가 없는 정상 한글 산문 문장은 그대로 두어야 한다.",
]


def _load_chem_pre_mirror():
    """chem-pre/hwpx-gen.py 의 미러 심볼만 AST 로 추출해 exec 한다.

    모듈 전체 import 는 python-hwpx/PIL 등 무거운 의존성을 끌고 오므로,
    미러 대상 노드의 소스 조각만 떼어 가벼운 네임스페이스에서 실행한다.
    """
    import ast

    path = os.path.join(ROOT, "lib", "pipelines", "chem-pre", "hwpx-gen.py")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    segments = []
    found = set()
    for node in ast.parse(src).body:
        if isinstance(node, ast.FunctionDef) and node.name in _MIRROR_FUNC_NAMES:
            segments.append(ast.get_source_segment(src, node))
            found.add(node.name)
        elif isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id in _MIRROR_ASSIGN_NAMES
            for t in node.targets
        ):
            segments.append(ast.get_source_segment(src, node))
            found.update(
                t.id for t in node.targets if isinstance(t, ast.Name)
            )
    missing = (set(_MIRROR_FUNC_NAMES) | set(_MIRROR_ASSIGN_NAMES)) - found
    if missing:
        raise LookupError(f"chem-pre 미러 심볼을 찾지 못함: {sorted(missing)}")
    ns = {"re": re}
    exec("\n\n".join(segments), ns)  # noqa: S102 — 자사 저장소 소스 한정
    return ns


def check_mirror_sync(eq, problems):
    """tool ↔ chem-pre 미러의 정규식 원문·함수 동작 동일성 검사."""
    try:
        chem = _load_chem_pre_mirror()
    except Exception as exc:
        problems.append(f"[mirror] chem-pre 미러 로드 실패: {exc}")
        return
    if chem["EQ_SCRIPT_KEYWORD"] != eq.EQ_SCRIPT_KEYWORD:
        problems.append(
            "[mirror] EQ_SCRIPT_KEYWORD 불일치 — tool 과 chem-pre/hwpx-gen.py 를 "
            "함께 수정해야 한다"
        )
    if chem["_EQ_PREFIX_RESCUE_RE"].pattern != eq._EQ_PREFIX_RESCUE_RE.pattern or (
        chem["_EQ_PREFIX_RESCUE_RE"].flags != eq._EQ_PREFIX_RESCUE_RE.flags
    ):
        problems.append("[mirror] _EQ_PREFIX_RESCUE_RE 불일치 (패턴/플래그)")
    if chem["_BARE_LATEX_SYMBOL_MAP"] != eq._BARE_LATEX_SYMBOL_MAP:
        problems.append(
            "[mirror] _BARE_LATEX_SYMBOL_MAP 불일치 — tool 과 chem-pre/hwpx-gen.py 를 "
            "함께 수정해야 한다"
        )
    if (
        chem["_BARE_LATEX_SYMBOL_CMD_RE"].pattern
        != eq._BARE_LATEX_SYMBOL_CMD_RE.pattern
    ):
        problems.append("[mirror] _BARE_LATEX_SYMBOL_CMD_RE 불일치 (패턴)")
    for probe in _MIRROR_SYMBOL_PROBES:
        a = eq.replace_bare_latex_symbol_commands(probe)
        b = chem["replace_bare_latex_symbol_commands"](probe)
        if a != b:
            problems.append(
                f"[mirror] replace_bare_latex_symbol_commands 동작 불일치: {probe!r} → "
                f"tool {a!r} ≠ chem-pre {b!r}"
            )
        if "\\" not in probe and a != probe:
            problems.append(
                f"[mirror] replace_bare_latex_symbol_commands 가 백슬래시 없는 "
                f"산문을 변형: {probe!r} → {a!r}"
            )
    for probe in _MIRROR_COMPACT_PROBES:
        a = eq.compact_chemical_spacing(probe)
        b = chem["compact_chemical_spacing"](probe)
        if a != b:
            problems.append(
                f"[mirror] compact_chemical_spacing 동작 불일치: {probe!r} → "
                f"tool {a!r} ≠ chem-pre {b!r}"
            )
    for raw, _kind in MARKER_VARIANTS:
        a = eq.canonicalize_equation_marker_prefixes(raw)
        b = chem["canonicalize_equation_marker_prefixes"](raw)
        if a != b:
            problems.append(
                f"[mirror] canonicalize 동작 불일치: {raw!r} → "
                f"tool {a!r} ≠ chem-pre {b!r}"
            )


def run(quiet=False):
    import hwpx_equation_tool as eq

    def convert_with(engine):
        os.environ["EQUATION_ENGINE"] = engine
        importlib.reload(eq)
        out = []
        if engine == "hwip":
            eq.hwip_convert_batch(GOLDEN)  # 프리워밍 경로도 함께 검증
        for tex in GOLDEN:
            try:
                out.append(eq.placeholder_to_script("EQ-LATEX", tex))
            except Exception as exc:
                out.append(f"(ERROR {exc})")
        return out, eq

    problems = []
    builtin_out, eq_builtin = convert_with("builtin")
    check_mirror_sync(eq_builtin, problems)
    check_extra_regressions(eq_builtin, "builtin", problems)
    hwip_out, eq_mod = convert_with("hwip")
    check_extra_regressions(eq_mod, "hwip", problems)
    hwip_used = eq_mod.hwip_engine_enabled() and len(eq_mod._hwip_cache) > 0

    diff_count = 0
    struct_stats = {"equal": 0, "benign": 0, "suspect": 0, "struct": 0}
    suspects: dict[str, str] = {}  # 카테고리 상세 → 대표 케이스
    for i, tex in enumerate(GOLDEN):
        b, h = builtin_out[i], hwip_out[i]
        differs = b != h
        diff_count += differs
        check_output("hwip", f"#{i+1}", h, problems)
        check_output("builtin", f"#{i+1}", b, problems)
        # ── 구조 동치성: 두 엔진 출력이 '같은 수식'인지 트리 비교 ──
        if not (b.startswith("(ERROR") or h.startswith("(ERROR")):
            verdict = hsp.compare_scripts(b, h)
            struct_stats[verdict.level] += 1
            if verdict.level == "suspect":
                for d in verdict.diffs:
                    suspects.setdefault(d, f"#{i+1} {tex}")
            elif verdict.level == "struct" and tex not in STRUCT_ALLOW:
                problems.append(
                    f"[struct] #{i+1} 두 엔진 구조 불일치: {tex!r}\n"
                    f"      builtin: {b[:110]}\n      hwip   : {h[:110]}\n"
                    f"      원인: {'; '.join(verdict.diffs) or verdict.categories}"
                )
            for engine, out in (("builtin", b), ("hwip", h)):
                for w in hsp.lint_hancom_lexing(out):
                    problems.append(f"[{engine}] #{i+1} 한컴 렉싱 위험: {w}")
        keep, ban = GOLDEN_LATEX_GUARD.get(tex, ((), ()))
        for engine, out in (("builtin", b), ("hwip", h)):
            for piece in keep:
                if piece not in out:
                    problems.append(
                        f"[{engine}] #{i+1} 구조 소실({piece!r} 없음): {out[:120]}"
                    )
            for piece in ban:
                if piece in out:
                    problems.append(
                        f"[{engine}] #{i+1} 파손 신호({piece!r} 잔존): {out[:120]}"
                    )
        if not quiet:
            mark = "≠" if differs else "="
            print(f"── {i+1}. {tex}")
            print(f"   [builtin] {b}")
            if differs:
                print(f"   [hwip   ] {h}")
            else:
                print(f"   [hwip   ] (동일)")
            print()

    fell_back = sum(1 for t in GOLDEN if t.strip() in eq_mod._hwip_failed)
    print("──── 요약 ────")
    print(f"골든셋 {len(GOLDEN)}개 | hwip 엔진 사용: {hwip_used} | builtin과 다른 출력: {diff_count}개 | hwip 변환실패→폴백: {fell_back}개")
    print(
        "구조 동치성: 동일 {equal} | 양성 차이 {benign} | 의심(실측 필요) {suspect}"
        " | 불일치 {struct}".format(**struct_stats)
        + (f" (허용 목록 {len(STRUCT_ALLOW)}건)" if STRUCT_ALLOW else "")
    )
    if suspects:
        print("⚠ 한컴 실측 확인 대기(렌더 시트 대상) — 동치로 통과시켰으나 미검증:")
        for detail, where in sorted(suspects.items()):
            print(f"  - {detail} (예: {where})")
    if problems:
        print(f"⚠ 검사 실패 {len(problems)}건:")
        for p in problems:
            print("  -", p)
        return 1
    print("✓ 금지 패턴/키워드 파손 검사 통과")
    return 0


if __name__ == "__main__":
    sys.exit(run(quiet="--quiet" in sys.argv))
