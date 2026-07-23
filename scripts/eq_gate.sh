#!/usr/bin/env bash
# 수식 파이프라인 게이트 — 수식 관련 코드(lib/equation/*, 각 hwpx-gen.py 의
# 수식 경로, scripts/eq_*)를 고치면 이 스크립트 전체를 통과시켜야 한다.
# 배경/실측 근거: docs/hwp-equation-quirks.md
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PYTHON_BIN:-.venv/bin/python3}
[ -x "$PY" ] || PY=python3

echo "── ① 구조 파서 셀프테스트"
"$PY" lib/equation/hwp_script_parser.py

echo "── ② 골든셋 + 교차엔진 구조 동치성 + 미러 동기화"
"$PY" scripts/eq_engine_diff.py --quiet

echo "── ③ 실전 코퍼스 전량"
"$PY" scripts/eq_corpus_mine.py

echo "── ④ 문법 퍼저(시드 고정 400)"
"$PY" scripts/eq_fuzz.py

echo "── ⑤ 표기 혼재 리허설(정보용 — 실패해도 게이트는 통과)"
"$PY" scripts/eq_mixed_notation_report.py || true

echo "── ⑥ 렌더 시트 재생성(HWPX 수식 251개 자동 검증 포함)"
"$PY" scripts/eq_render_sheet.py

echo "── ⑦ 파이프라인 회귀(실렌더 포함 41종)"
node --test tests/pipelines/

echo "✓ 수식 게이트 전체 통과"
