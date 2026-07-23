# -*- coding: utf-8 -*-
"""키워드 위험 라벨(pivot·in·sup)의 '지속 가능' 표기 판정 프로브.

문서 렌더러는 결합된 글자 런을 탐욕 매칭하고(pivot→πvot, 재오픈 실측
2026-07-13), 편집기는 낱자/인용/빈그룹 보호를 전부 재직렬화로 파괴한다.
양쪽 모두에서 살아남는 표기를 찾기 위해, 한컴 공식 명세의 로만체 명령
`rm`(영문 기본 이탤릭의 텍스트 전환) 계열을 포함한 후보를 나란히 렌더한다.

스크립트는 normalize/dequote 를 우회해 '원문 그대로' 주입한다(속성은
make_equation 정준 속성 그대로).

실행: .venv/bin/python3 scripts/eq_label_probe.py   # tmp/eq-label-probe.hwpx
판정: 한글에서 열어 각 행 첨자가 pivot/πvot/∈/sup 중 무엇인지 확인.
"""
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "lib", "equation"))

import hwpx_equation_tool as eq  # noqa: E402
from hwpx.document import HwpxDocument  # noqa: E402

ZWSP = "​"

# (라벨, 최종 스크립트 원문)
ROWS = [
    ("1. 결합 대조군 — πvot 로 깨지는 형태", "I_{pivot} `=` x"),
    ("2. 현행 낱자 분해 — pivot(이탤릭) 기대", "I_{ p i v o t } `=` x"),
    ("3. 인용 리터럴(구방식) — pivot(업라이트) 기대", 'I_{"pivot"} `=` x'),
    ("4. rm+결합 — rm 이 탐욕 매칭을 막는가", "I_{rm pivot} `=` x"),
    ("5. rm 중괄호 한정 — 실제 채택 후보 형태", "I_{{rm pivot}} `=` x"),
    ("6. in 결합 대조군 — ∈ 로 깨지는 형태", "Q_{in} + W"),
    ("7. rm+in — 텍스트 in 이 살아나는가", "Q_{{rm in}} + W"),
    ("8. 현행 낱자 sup — 이탤릭 sup 기대", "s u p _{n} a_{n}"),
    ("9. rm+sup — 연산자 충돌을 rm 이 막는가", "{rm sup}_{n} a_{n}"),
    ("10. 보이지 않는 분리자(ZWSP) — pivot + 박스 없음이면 후보",
     "I_{p" + ZWSP + "ivot} `=` x"),
]


def build(out_path: str) -> None:
    doc = HwpxDocument.new()
    doc.add_paragraph("라벨 표기 판정 프로브 — 각 행 첨자가 무엇으로 보이는지 기록")
    doc.add_paragraph("(pivot 정상 / πvot 파손 / ∈ 파손 / 박스·증발 여부)")
    for i, (label, _script) in enumerate(ROWS, 1):
        doc.add_paragraph(label)
        doc.add_paragraph("본문 속 {{EQ:PROBESLOT" + str(i) + "}} 이어지는 문장.")
    with tempfile.TemporaryDirectory(prefix="quilo-eq-label-") as temp:
        marked = Path(temp) / "marked.hwpx"
        doc.save(marked)
        eq.replace_equation_placeholders(marked, Path(out_path))
    # 슬롯 스크립트를 원문 후보로 교체(normalize 우회 주입)
    with zipfile.ZipFile(out_path) as z:
        names = z.namelist()
        data = {n: z.read(n) for n in names}
    xml = data["Contents/section0.xml"].decode("utf-8")
    for i, (_label, script) in enumerate(ROWS, 1):
        esc = script.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        xml, n = re.subn(
            rf"(<hp:script[^>]*>)PROBESLOT{i}(</hp:script>)",
            lambda m, e=esc: m.group(1) + e + m.group(2),
            xml,
        )
        if n != 1:
            raise SystemExit(f"슬롯 {i} 주입 실패({n})")
    data["Contents/section0.xml"] = xml.encode("utf-8")
    with zipfile.ZipFile(out_path, "w") as z:
        for n in names:
            z.writestr(n, data[n])
    print(f"✓ 라벨 프로브 생성: {out_path} (행 {len(ROWS)}개, 원문 주입 완료)")


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "tmp", "eq-label-probe.hwpx")
    build(out)
