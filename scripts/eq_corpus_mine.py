# -*- coding: utf-8 -*-
"""실전 수식 코퍼스 마이닝 + 교차엔진 구조 검증.

실제 생성 산출물(content JSON — tmp/eval, tmp/eval2 등)에서 수식을 전량
추출해, 골든셋(eq_engine_diff)이 못 보는 '실전 분포'를 두 엔진 + 구조
동치성 검사(hwp_script_parser)에 통과시킨다.

추출 대상:
  - 문자열 값 어디든 박힌 {{EQ:}}/{{EQ-LATEX:}}(변형 포함) 마커 본문
  - {"equation": "..."} 블록 값(free-report/math-inquiry/phys-inquiry 형태 —
    hwpx-gen 이 백슬래시 유무로 EQ-LATEX/EQ 자동 래핑하는 것과 동일 판정)

실행:
  .venv/bin/python3 scripts/eq_corpus_mine.py [스캔루트 ...]
  (루트 생략 시 tmp/eval tmp/eval2)
  --list  추출 코퍼스만 출력하고 종료
"""
import importlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "lib", "equation"))

import hwp_script_parser as hsp  # noqa: E402


def iter_strings(node):
    if isinstance(node, str):
        yield None, node
    elif isinstance(node, dict):
        for k, v in node.items():
            if k == "equation" and isinstance(v, str):
                yield "equation", v
            else:
                yield from iter_strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from iter_strings(v)


def mine_file(path, eq):
    """(kind, body) 목록 — kind ∈ {EQ, EQ-LATEX}."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return []
    found = []
    for key, s in iter_strings(data):
        text = eq.canonicalize_equation_marker_prefixes(s)
        markers = eq.find_equation_placeholders(text, strict=False)
        for ph in markers:
            kind = "EQ-LATEX" if "LATEX" in ph.kind else "EQ"
            found.append((kind, ph.body.strip()))
        if key == "equation" and "{{EQ" not in text and text.strip():
            # hwpx-gen 의 equation 블록 자동 래핑과 동일 판정
            kind = "EQ-LATEX" if "\\" in text else "EQ"
            found.append((kind, text.strip()))
    return found


def collect(roots, eq):
    corpus: dict[tuple[str, str], str] = {}  # (kind, body) -> 출처
    n_files = 0
    for root in roots:
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                if not name.endswith(".json"):
                    continue
                path = os.path.join(dirpath, name)
                items = mine_file(path, eq)
                if items:
                    n_files += 1
                for kind, body in items:
                    if body:
                        corpus.setdefault((kind, body), os.path.relpath(path, ROOT))
    return corpus, n_files


def run(roots, list_only=False):
    import hwpx_equation_tool as eq

    corpus, n_files = collect(roots, eq)
    latex_items = sorted({b for k, b in corpus if k == "EQ-LATEX"})
    raw_items = sorted({b for k, b in corpus if k == "EQ"})
    print(
        f"코퍼스: 파일 {n_files}개에서 EQ-LATEX {len(latex_items)}식 / "
        f"EQ(한컴 스크립트) {len(raw_items)}식 추출"
    )
    if list_only:
        for k, b in sorted(corpus):
            print(f"  [{k}] {b}   ← {corpus[(k, b)]}")
        return 0

    def convert_all(engine):
        os.environ["EQUATION_ENGINE"] = engine
        importlib.reload(eq)
        if engine == "hwip":
            eq.hwip_convert_batch(latex_items)
        out = {}
        for tex in latex_items:
            try:
                out[tex] = eq.placeholder_to_script("EQ-LATEX", tex)
            except Exception as exc:
                out[tex] = f"(ERROR {exc})"
        return out

    problems: list[str] = []
    suspects: dict[str, str] = {}
    stats = {"equal": 0, "benign": 0, "suspect": 0, "struct": 0}
    b_out = convert_all("builtin")
    h_out = convert_all("hwip")
    for tex in latex_items:
        b, h = b_out[tex], h_out[tex]
        for engine, out in (("builtin", b), ("hwip", h)):
            if out.startswith("(ERROR"):
                problems.append(f"[{engine}] 변환 예외: {tex!r} → {out}")
        if b.startswith("(ERROR") or h.startswith("(ERROR"):
            continue
        v = hsp.compare_scripts(b, h)
        stats[v.level] += 1
        if v.level == "suspect":
            for d in v.diffs:
                suspects.setdefault(d, tex)
        elif v.level == "struct":
            src = corpus.get(("EQ-LATEX", tex), "?")
            problems.append(
                f"[struct] 두 엔진 구조 불일치: {tex!r} (출처 {src})\n"
                f"      builtin: {b[:110]}\n      hwip   : {h[:110]}\n"
                f"      원인: {'; '.join(v.diffs) or v.categories}"
            )
        for engine, out in (("builtin", b), ("hwip", h)):
            for w in hsp.lint_hancom_lexing(out):
                problems.append(f"[{engine}] 한컴 렉싱 위험: {w} ({tex!r})")

    # {{EQ:}} 한컴 스크립트 직행 경로 — normalize 만 통과, 단독 린트
    for body in raw_items:
        try:
            out = eq.placeholder_to_script("EQ", body)
        except Exception as exc:
            problems.append(f"[EQ] 변환 예외: {body!r}: {exc}")
            continue
        for w in hsp.lint_hancom_lexing(out):
            problems.append(f"[EQ] 한컴 렉싱 위험: {w} ({body!r})")
        if "\\" in out:
            problems.append(f"[EQ] 백슬래시 잔재: {body!r} → {out[:110]}")

    print(
        "구조 동치성: 동일 {equal} | 양성 {benign} | 의심 {suspect} | 불일치 {struct}".format(
            **stats
        )
    )
    if suspects:
        print("⚠ 한컴 실측 대기 쌍:")
        for d, tex in sorted(suspects.items()):
            print(f"  - {d} (예: {tex})")
    if problems:
        print(f"⚠ 검사 실패 {len(problems)}건:")
        for p in problems:
            print("  -", p)
        return 1
    print("✓ 실전 코퍼스 전량 통과 (금지 패턴/구조 불일치/렉싱 위험 0)")
    return 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    roots = [os.path.join(ROOT, a) for a in args] or [
        os.path.join(ROOT, "tmp", "eval"),
        os.path.join(ROOT, "tmp", "eval2"),
    ]
    roots = [r for r in roots if os.path.isdir(r)]
    if not roots:
        print("스캔할 루트가 없다 (tmp/eval 부재).")
        sys.exit(0)
    sys.exit(run(roots, list_only="--list" in sys.argv))
