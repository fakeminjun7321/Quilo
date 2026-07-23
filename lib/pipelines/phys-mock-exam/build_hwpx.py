#!/usr/bin/env python3
"""물리 모의고사 HWPX(한글) 생성기.

phys-result/hwpx-gen.py 와 마찬가지로 Node 가 spawn 한다.
- stdin: generate.js content JSON ({ meta, problems[], date, title }).
- argv[1]: 출력 .hwpx 경로.

한 문서 안에 [시험지] + [답안지] 두 섹션을 넣는다.
수식은 linear Unicode(β, γ, √( ), 5/4, ², ₀)로 변환해 한글에서 바로 편집 가능하게 한다
(아름다운 조판 수식은 PDF 가 담당). 원본 skill 의 latex2lin 클리너를 재사용했다.

의존성: python-hwpx (import hwpx). 없으면 비0 종료 → Node 가 PDF-only 로 graceful degrade.
"""
import json
import os
import re
import sys

try:
    from hwpx.document import HwpxDocument
except Exception as e:  # python-hwpx 미설치 등 → Node 가 PDF-only 로 폴백
    sys.stderr.write(f"python-hwpx import 실패: {e!r}\n")
    sys.exit(3)

# ── LaTeX → linear Unicode (원본 skill build_hwpx.py 의 latex2lin 재사용) ──────
SUP = {'0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶',
       '7': '⁷', '8': '⁸', '9': '⁹', 'n': 'ⁿ', '-': '⁻', '+': '⁺', 'i': 'ⁱ'}
SUB = {'0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆',
       '7': '₇', '8': '₈', '9': '₉', 'p': 'ₚ', 'x': 'ₓ', 'i': 'ᵢ', 'R': 'ᵣ'}
GREEK = {
    r'\\gamma': 'γ', r'\\beta': 'β', r'\\psi': 'ψ', r'\\Delta': 'Δ', r'\\delta': 'δ',
    r'\\tau': 'τ', r'\\mu': 'μ', r'\\theta': 'θ', r'\\lambda': 'λ', r'\\pi': 'π',
    r'\\varphi': 'φ', r'\\phi': 'φ', r'\\omega': 'ω', r'\\Omega': 'Ω', r'\\Sigma': 'Σ',
    r'\\sigma': 'σ', r'\\rho': 'ρ', r'\\alpha': 'α', r'\\epsilon': 'ε', r'\\varepsilon': 'ε',
    r'\\nu': 'ν', r'\\eta': 'η', r'\\kappa': 'κ',
    r'\\cdot': '·', r'\\times': '×', r'\\approx': '≈', r'\\leq': '≤', r'\\le': '≤',
    r'\\geq': '≥', r'\\ge': '≥', r'\\neq': '≠', r'\\ne': '≠', r'\\to': '→',
    r'\\Rightarrow': '⇒', r'\\rightarrow': '→', r'\\infty': '∞', r'\\pm': '±', r'\\mp': '∓',
    r'\\oplus': '⊕', r'\\cosh': 'cosh', r'\\sinh': 'sinh', r'\\tanh': 'tanh', r'\\ln': 'ln',
    r'\\sin': 'sin', r'\\cos': 'cos', r'\\tan': 'tan', r'\\log': 'log',
    r'\\gg': '≫', r'\\ll': '≪', r'\\sqrt': '√', r'\\partial': '∂', r'\\nabla': '∇',
    r'\\propto': '∝', r'\\int': '∫', r'\\sum': 'Σ', r'\\hbar': 'ħ', r'\\angle': '∠',
    r'\\quad': '   ', r'\\,': ' ', r'\\;': ' ', r'\\!': '', r'\\left': '', r'\\right': '',
    r'\\displaystyle': '', r'\\nobreak': '',
}


def _sup(m):
    return ''.join(SUP.get(c, '^' + c) for c in m.group(1))


def _sub(m):
    return ''.join(SUB.get(c, '_' + c) for c in m.group(1))


def latex2lin(s):
    if not s:
        return ''
    s = str(s)
    s = s.replace('\\[', ' ').replace('\\]', ' ').replace('\\(', ' ').replace('\\)', ' ')
    s = re.sub(r'\$\$', ' ', s)
    s = re.sub(r'\\begin\{align\*?\}', ' ', s)
    s = re.sub(r'\\end\{align\*?\}', ' ', s)
    s = re.sub(r'\\begin\{pmatrix\}', ' ( ', s)
    s = re.sub(r'\\end\{pmatrix\}', ' ) ', s)
    s = re.sub(r'\\begin\{[^}]*\}', ' ', s)
    s = re.sub(r'\\end\{[^}]*\}', ' ', s)
    s = s.replace('\\\\', ' ; ').replace('&', ' ')
    for _ in range(3):
        s = re.sub(r'\\[tdc]?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}', r'(\1)/(\2)', s)
    s = re.sub(r'\\sqrt\s*\{([^{}]+)\}', r'√(\1)', s)
    s = re.sub(r'\\(?:text|mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}', r'\1', s)
    s = re.sub(r'\\(?:vec|hat|bar|tilde|overline)\s*\{([^{}]+)\}', r'\1', s)
    for k, v in GREEK.items():
        s = re.sub(k, v, s)
    s = re.sub(r'\^\{([^{}]+)\}', _sup, s)
    s = re.sub(r'\^([0-9n\-+i])', lambda m: SUP.get(m.group(1), '^' + m.group(1)), s)
    s = re.sub(r'_\{([^{}]+)\}', _sub, s)
    s = re.sub(r'_([0-9pxiR])', lambda m: SUB.get(m.group(1), '_' + m.group(1)), s)
    s = s.replace('$', '')
    s = re.sub(r'\*\*(.+?)\*\*', r'\1', s)
    s = s.replace('**', '')
    s = re.sub(r'\\[a-zA-Z]+\b', ' ', s)
    s = s.replace('{', '').replace('}', '').replace('\\', '')
    s = re.sub(r'[ \t]+', ' ', s)
    s = re.sub(r' *\n *', '\n', s)
    return s.strip()


def blocks(t):
    return [b.strip() for b in re.split(r'\n\s*\n', str(t or '')) if b.strip()]


def build(payload, out_path):
    meta = payload.get('meta') or {}
    problems = payload.get('problems') or []
    title = payload.get('title') or (
        f"물리 모의고사 — {meta.get('unit')}" if meta.get('unit') else "물리 모의고사"
    )
    date = payload.get('date') or ''
    total_pts = sum(int(p.get('points') or 0) for p in problems)

    d = HwpxDocument.new()
    bold = d.ensure_run_style(bold=True)

    sub = ' · '.join([x for x in [meta.get('unit'), meta.get('course')] if x])
    meta_line = f"{len(problems)}문항 · 총 {total_pts}점"
    if date:
        meta_line += f" · {date}"
    if sub:
        meta_line += f" · {sub}"

    # ── 시험지 섹션 ──────────────────────────────────────────────────────────
    d.add_paragraph(f"{title} — 시험지", char_pr_id_ref=bold)
    d.add_paragraph(meta_line)
    d.add_paragraph("이름: ______________    학번: ______________")
    d.add_paragraph("모든 수치는 계산기 없이 풀리도록 구성되었습니다.")
    d.add_paragraph("─" * 40)
    for n, p in enumerate(problems, 1):
        pts = int(p.get('points') or 0)
        d.add_paragraph(f"{n}.  {latex2lin(p.get('statement'))}   [{pts}점]", char_pr_id_ref=bold)
        fig = str(p.get('figure') or 'none').strip()
        if fig.lower() not in ('none', '', 'n/a'):
            d.add_paragraph(f"〔그림〕 {fig}")
        for ch in (p.get('choices') or []):
            d.add_paragraph(f"   {latex2lin(ch)}")
        d.add_paragraph("   답:")
        d.add_paragraph("")
        d.add_paragraph("─" * 40)

    # 시험지/답안지 구분(한글에는 add_page_break 가 없어 굵은 구분선으로 분리).
    d.add_paragraph("")
    d.add_paragraph("═" * 40)
    d.add_paragraph("")

    # ── 답안지 섹션 ──────────────────────────────────────────────────────────
    d.add_paragraph(f"{title} — 답안지 (모범답안 · 채점기준)", char_pr_id_ref=bold)
    d.add_paragraph("각 문제의 부분점수 합이 배점과 같습니다.")
    d.add_paragraph("─" * 40)
    for n, p in enumerate(problems, 1):
        pts = int(p.get('points') or 0)
        d.add_paragraph(f"{n}.  ({pts}점)  {latex2lin(p.get('statement'))}", char_pr_id_ref=bold)
        if p.get('answer'):
            d.add_paragraph(f"정답: {latex2lin(p.get('answer'))}", char_pr_id_ref=bold)
        if p.get('solution'):
            d.add_paragraph("풀이:", char_pr_id_ref=bold)
            for b in blocks(p.get('solution')):
                d.add_paragraph(latex2lin(b))
        if p.get('grading'):
            d.add_paragraph("채점기준:", char_pr_id_ref=bold)
            for b in blocks(p.get('grading')):
                d.add_paragraph(latex2lin(b))
        d.add_paragraph("─" * 40)

    d.save(out_path)


def main():
    raw = sys.stdin.buffer.read().decode('utf-8', 'replace')
    payload = json.loads(raw)
    out_path = sys.argv[1] if len(sys.argv) > 1 else 'exam.hwpx'
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    build(payload, out_path)


if __name__ == '__main__':
    main()
