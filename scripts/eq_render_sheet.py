# -*- coding: utf-8 -*-
"""한컴 실측 렌더 시트 생성기 — 수식 검증 체계의 마지막(사람 눈) 단계.

자동 검증(eq_engine_diff·eq_corpus_mine·eq_fuzz)은 스크립트 문자열까지만
보장한다. '한컴이 실제로 어떻게 그리는가'(tint 미렌더 사고류)는 실측만이
답이므로, 골든셋 + 실전 코퍼스 + 의심 키워드 프로브 전체를 번호·원문과
함께 한 HWPX 로 뽑아 macOS 한글/Windows 한컴에서 한 번에 훑게 한다.

확인 절차는 docs/hwp-equation-quirks.md 참고. 실측 결과는
lib/equation/hwp_script_parser.py 의 SAFE/SUSPECT 동의어 표에 반영한다.

실행:
  .venv/bin/python3 scripts/eq_render_sheet.py [출력.hwpx]
  (기본 출력: tmp/eq-render-sheet.hwpx)
"""
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "lib", "equation"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import hwpx_equation_tool as eq  # noqa: E402
from eq_engine_diff import GOLDEN  # noqa: E402
import eq_corpus_mine  # noqa: E402

from hwpx.document import HwpxDocument  # noqa: E402  (.venv python-hwpx)

# 프로브(3라운드, 2026-07-12 편집기 왕복 실측 반영) — 무따옴표 정준형의
# 초기 렌더 + 편집기 왕복(넣기) 안정성 검증. (라벨, {{EQ:}} 원시 스크립트).
# 확인 절차: ① 초기 렌더를 눈으로 확인 ② 각 수식을 더블클릭→넣기→닫기
# ③ 렌더가 변하는 항목 번호 기록 ④ 다른 이름(…-after.hwpx)으로 저장.
# 저장본의 스크립트를 원본과 diff 하면 편집기 정준형을 기계적으로 얻는다.
PROBES = [
    ("낱자 분해 라벨 — Ipivot·Tinitial 첨자가 정상인가(따옴표 없음)",
     "I_{ p i v o t } ~ ~ T_{ i n i t i a l }"),
    ("알몸 한글 — 따옴표 없이 한글이 그대로 나오는가",
     "수득률 = 실제 ~ 수득량"),
    ("함수 키워드 라벨 — max/min 이 업라이트로 나오는가",
     "v_{ max } ~ ~ E_{ min }"),
    ("알몸 단어 라벨/단위 — out·vap·kJ/mol 이 글자 그대로인가",
     "W_{ out } ~ ~ H_{ vap } ~ ~ 123 ~ kJ/mol"),
    ("낱자 상한/하한 — sup/inf 글자가 유지되는가(∞·증발 금지)",
     "s u p _{n >= 1} a_{n} ~ ~ i n f _{n} b_{n}"),
    ("스트레치 집합 중괄호(프로덕션 형태) — {x|x>0}",
     "LEFT{ x | x > 0 RIGHT}"),
    ("겹브레이스 강등형 — 윗줄+라벨 / 본문+아래 라벨로 나오는가",
     "bar {a+b}^{n} + {c+d}_{m}"),
    ("n제곱근 정규형 — 2·∛8 (3 이 2 의 지수로 붙으면 안 됨)",
     "2 {}^{3} sqrt {8}"),
    ("부정 기호 — ¬p", "¬ p"),
    ("하픈 글리프 — ⇋ 가 그대로 보이는가(⇌ 보존 개선의 근거)",
     "A ⇋ B"),
]

_LABEL_SWAP = str.maketrans({"\\": "＼", "{": "｛", "}": "｝", "^": "＾", "_": "＿"})


def _safe_label(text: str) -> str:
    """원문 표기를 검증기(raw LaTeX/스크립트 잔재 검출)에 안 걸리는 전각
    문자로 바꿔 평문 라벨로 남긴다 — 시트를 보는 사람이 원문을 알아야
    어긋난 렌더를 신고할 수 있다."""
    return text.translate(_LABEL_SWAP)


def build(out_path: str) -> None:
    doc = HwpxDocument.new()
    doc.add_paragraph("Quilo 수식 렌더 시트 — 한컴(한글) 실측 확인용 (3라운드)")
    doc.add_paragraph(
        "각 항목: 라벨(원문, 전각 치환) 다음 줄이 실제 수식 객체다. "
        "글자 그대로 노출·어긋난 기호·빈 박스를 발견하면 번호를 기록할 것."
    )
    doc.add_paragraph(
        "왕복 실험: S1 의 각 수식을 더블클릭해 수식 편집기를 열고 그대로 "
        "넣기를 눌러 닫는다. 렌더가 변하면 그 번호를 기록하고, 끝나면 "
        "'eq-render-sheet-after.hwpx' 로 다른 이름 저장해 주면 스크립트 "
        "차이를 기계적으로 분석할 수 있다."
    )

    doc.add_paragraph("")
    doc.add_paragraph("[S1] 의심 키워드 프로브 — 두 표기가 같은 기호인지 판정")
    for i, (label, script) in enumerate(PROBES, 1):
        doc.add_paragraph(f"S1-{i}. {label}")
        doc.add_paragraph("{{EQ:" + script + "}}")

    doc.add_paragraph("")
    doc.add_paragraph("[S2] 골든셋 — scripts/eq_engine_diff.py 의 전체 케이스")
    for i, tex in enumerate(GOLDEN, 1):
        doc.add_paragraph(f"S2-{i}. {_safe_label(tex)}")
        doc.add_paragraph("{{EQ-LATEX:" + tex + "}}")

    corpus, _n = eq_corpus_mine.collect(
        [os.path.join(ROOT, "tmp", "eval"), os.path.join(ROOT, "tmp", "eval2")], eq
    )
    latex_items = sorted({b for k, b in corpus if k == "EQ-LATEX"})
    raw_items = sorted({b for k, b in corpus if k == "EQ"})
    doc.add_paragraph("")
    doc.add_paragraph("[S3] 실전 코퍼스 — 실제 생성 산출물에서 추출")
    n = 0
    for tex in latex_items:
        n += 1
        doc.add_paragraph(f"S3-{n}. {_safe_label(tex)}")
        doc.add_paragraph("{{EQ-LATEX:" + tex + "}}")
    for body in raw_items:
        n += 1
        doc.add_paragraph(f"S3-{n}. {_safe_label(body)}")
        doc.add_paragraph("{{EQ:" + body + "}}")

    with tempfile.TemporaryDirectory(prefix="quilo-eq-sheet-") as temp:
        marked = Path(temp) / "marked.hwpx"
        doc.save(marked)
        count = eq.replace_equation_placeholders(marked, Path(out_path))
    issues = eq.validate_hwpx_equations(Path(out_path))
    if issues:
        print(f"⚠ 시트 검증 실패 {len(issues)}건:")
        for msg in issues[:10]:
            print("  -", msg)
        raise SystemExit(1)
    total = len(PROBES) + len(GOLDEN) + len(latex_items) + len(raw_items)
    print(f"✓ 렌더 시트 생성: {out_path} (수식 {count}개 / 항목 {total}건, 검증 통과)")


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "tmp", "eq-render-sheet.hwpx")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    build(out)
