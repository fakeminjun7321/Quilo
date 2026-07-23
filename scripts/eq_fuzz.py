# -*- coding: utf-8 -*-
"""수식 변환 문법 퍼저 — 보고서 도메인 LaTeX 를 무작위 조합 생성해
두 엔진(builtin/hwip)에 동시에 넣고 다음을 단언한다:

  1. 불변식: 백슬래시 잔재 0, 중괄호 균형, 알몸 LaTeX 키워드 0,
     빈 분수 인자 0, 키워드 융합 0 (eq_engine_diff.check_output 재사용)
  2. 교차엔진 구조 동치성: 두 독립 구현이 같은 수식 트리를 내야 한다
     (hwp_script_parser.compare_scripts — suspect 까지 허용, struct 불일치 실패)
  3. 한컴 렉싱 린트: 비인용 글자 런의 키워드 오해 위험 0

시드 고정 결정론 — 같은 시드는 항상 같은 샘플을 만든다(회귀 재현 가능).

실행:
  .venv/bin/python3 scripts/eq_fuzz.py               # 기본 400샘플, seed 20260712
  .venv/bin/python3 scripts/eq_fuzz.py 1000 7        # N=1000, seed=7
"""
import importlib
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "lib", "equation"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import hwp_script_parser as hsp  # noqa: E402
import eq_engine_diff as diff_mod  # noqa: E402 — check_output 재사용


VARS = list("xyvtTmMEFLagdrkVPQ") + ["v_0", "x_0", "a_n", "m_1", "m_2"]
NUMS = ["2", "10", "0.5", "9.8", "100", "4", "1"]
GREEK = [
    r"\alpha", r"\beta", r"\theta", r"\lambda", r"\mu", r"\pi", r"\rho",
    r"\sigma", r"\tau", r"\omega", r"\Delta", r"\Omega", r"\epsilon",
    r"\phi", r"\gamma",
]
BINOP = [" + ", " - ", r" \times ", r" \cdot ", " = ", r" \pm ", " / ",
         r" \approx ", r" \leq ", r" \geq ", r" \neq ", r" \propto "]
ACCENT = [r"\vec", r"\hat", r"\bar", r"\dot", r"\ddot", r"\tilde"]


def gen_atom(rng: random.Random, depth: int) -> str:
    roll = rng.random()
    if depth <= 0 or roll < 0.45:
        return rng.choice(VARS + NUMS + GREEK)
    if roll < 0.55:
        return r"\frac{%s}{%s}" % (gen_expr(rng, depth - 1), gen_expr(rng, depth - 1))
    if roll < 0.62:
        return r"\sqrt{%s}" % gen_expr(rng, depth - 1)
    if roll < 0.70:
        return "%s^{%s}" % (gen_atom(rng, 0), gen_atom(rng, 0))
    if roll < 0.78:
        return "%s_{%s}" % (rng.choice(list("xvTEFIa")), gen_atom(rng, 0))
    if roll < 0.84:
        return "%s{%s}" % (rng.choice(ACCENT), rng.choice(list("ABFvxr")))
    if roll < 0.90:
        return r"\left( %s \right)" % gen_expr(rng, depth - 1)
    if roll < 0.94:
        return r"\sum_{%s=1}^{%s} %s" % (
            rng.choice("ink"), rng.choice(["N", "n", r"\infty"]),
            gen_atom(rng, depth - 1),
        )
    if roll < 0.97:
        return r"\int_{%s}^{%s} %s \, d%s" % (
            rng.choice(["0", "a"]), rng.choice(["1", "T", "b"]),
            gen_atom(rng, depth - 1), rng.choice("xt"),
        )
    return r"\lim_{n \to \infty} %s" % gen_atom(rng, depth - 1)


def gen_expr(rng: random.Random, depth: int) -> str:
    parts = [gen_atom(rng, depth)]
    for _ in range(rng.randint(0, 2)):
        parts.append(rng.choice(BINOP))
        parts.append(gen_atom(rng, depth))
    return "".join(parts)


def run(n_samples: int, seed: int) -> int:
    import hwpx_equation_tool as eq

    rng = random.Random(seed)
    samples = [gen_expr(rng, 3) for _ in range(n_samples)]

    def convert_all(engine):
        os.environ["EQUATION_ENGINE"] = engine
        importlib.reload(eq)
        if engine == "hwip":
            eq.hwip_convert_batch(samples)
        out = []
        for tex in samples:
            try:
                out.append(eq.placeholder_to_script("EQ-LATEX", tex))
            except Exception as exc:
                out.append(f"(ERROR {exc})")
        return out

    b_out = convert_all("builtin")
    h_out = convert_all("hwip")
    problems: list[str] = []
    stats = {"equal": 0, "benign": 0, "suspect": 0, "struct": 0}
    for i, tex in enumerate(samples):
        b, h = b_out[i], h_out[i]
        for engine, out in (("builtin", b), ("hwip", h)):
            if out.startswith("(ERROR"):
                problems.append(f"[{engine}] #{i} 변환 예외: {tex!r} → {out}")
                continue
            diff_mod.check_output(engine, f"fuzz#{i}", out, problems)
            for w in hsp.lint_hancom_lexing(out):
                problems.append(f"[{engine}] fuzz#{i} 한컴 렉싱 위험: {w} ({tex!r})")
        if b.startswith("(ERROR") or h.startswith("(ERROR"):
            continue
        v = hsp.compare_scripts(b, h)
        stats[v.level] += 1
        if v.level == "struct":
            problems.append(
                f"[struct] fuzz#{i} 두 엔진 구조 불일치: {tex!r}\n"
                f"      builtin: {b[:120]}\n      hwip   : {h[:120]}\n"
                f"      원인: {'; '.join(v.diffs) or v.categories}"
            )

    print(
        f"퍼저 {n_samples}샘플(seed={seed}) | "
        "구조 동치성: 동일 {equal} | 양성 {benign} | 의심 {suspect} | 불일치 {struct}".format(
            **stats
        )
    )
    if problems:
        print(f"⚠ 검사 실패 {len(problems)}건 (처음 20건):")
        for p in problems[:20]:
            print("  -", p)
        return 1
    print("✓ 퍼저 전 샘플 통과 (불변식/구조 동치성/렉싱 위험 0)")
    return 0


if __name__ == "__main__":
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    n = int(argv[0]) if argv else 400
    seed = int(argv[1]) if len(argv) > 1 else 20260712
    sys.exit(run(n, seed))
