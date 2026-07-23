# -*- coding: utf-8 -*-
"""DEF-040(수식표기혼재) report-only 리허설.

phys-result 실전 산출물(content JSON)의 모든 산문 문자열에 승격 파이프라인
(normalize_physics_equation_markers)을 돌린 뒤, 마커 '밖'에 남은 수식성
토큰을 전수 스캔한다 — m₁(유니코드 첨자 평문), F_net/M_system(언더스코어
라벨), 그리스+첨자 등. 같은 문단에 수식 객체(마커)와 잔존 토큰이 공존하면
'혼재'로 센다.

이 스크립트는 아무것도 바꾸지 않는다(관찰 전용). 수정 전 오탐 0 확인과
수정 후 잔존 0 확인의 양쪽 게이트로 쓴다.

실행: .venv/bin/python3 scripts/eq_mixed_notation_report.py [루트...]
      (기본: tmp/eval tmp/eval2)
"""
import importlib.util
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "lib", "equation"))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


phys = _load(
    "phys_result_hwpx_gen",
    os.path.join(ROOT, "lib", "pipelines", "phys-result", "hwpx-gen.py"),
)
pre = phys.pre

# 마커 밖 잔존 수식성 토큰 — DEF-040 시그니처
_RESIDUE_PATTERNS = [
    ("유니코드 첨자 평문(m₁·s²)", re.compile(
        r"[A-Za-zαβγδθλμπρστφω][₀₁₂₃₄₅₆₇₈₉⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+")),
    ("언더스코어 라벨(F_net)", re.compile(
        r"(?<![A-Za-z0-9_])[A-Za-zαβγδθλμπρστφωΩΔΣ]_[A-Za-z]{1,10}(?![A-Za-z0-9_])")),
    ("언더스코어 숫자(m_1)", re.compile(
        r"(?<![A-Za-z0-9_])[A-Za-zαβγδθλμπρστφωΩΔΣ]_[0-9](?![0-9])")),
]


def outside_marker_spans(text):
    spans = pre.find_equation_spans(text)
    pos = 0
    for start, end, _k, _b in spans:
        if start > pos:
            yield text[pos:start]
        pos = end
    if pos < len(text):
        yield text[pos:]


def iter_strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for v in node.values():
            yield from iter_strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from iter_strings(v)


def run(roots):
    files = []
    for root in roots:
        for dirpath, _d, names in os.walk(root):
            for n in names:
                if n.endswith(".json") and ("phys" in n or "free" in n):
                    files.append(os.path.join(dirpath, n))
    findings = []
    mixed = 0
    total_strings = 0
    for path in sorted(set(files)):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        for s in iter_strings(data):
            if len(s) < 4 or "\\" in s and "{{" not in s and "frac" in s:
                pass
            total_strings += 1
            promoted = phys.normalize_physics_equation_markers(s)
            promoted = pre.normalize_equation_markers(promoted)
            has_marker = "{{EQ" in promoted
            hits = []
            for label, rx in _RESIDUE_PATTERNS:
                for seg in outside_marker_spans(promoted):
                    for m in rx.finditer(seg):
                        hits.append((label, m.group(0)))
            if hits:
                if has_marker:
                    mixed += 1
                findings.append((os.path.relpath(path, ROOT), s[:80], hits[:6],
                                 has_marker))
    print(f"검사 문자열 {total_strings}개 (파일 {len(set(files))}개)")
    print(f"잔존 수식성 토큰이 있는 문단: {len(findings)}개 (그중 수식 객체와 혼재: {mixed}개)")
    for path, src, hits, has_marker in findings[:40]:
        tag = "혼재" if has_marker else "잔존"
        print(f"  [{tag}] {hits} ← {src!r} ({path})")
    return 1 if findings else 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    roots = [os.path.join(ROOT, a) for a in args] or [
        os.path.join(ROOT, "tmp", "eval"), os.path.join(ROOT, "tmp", "eval2")]
    sys.exit(run([r for r in roots if os.path.isdir(r)]))
