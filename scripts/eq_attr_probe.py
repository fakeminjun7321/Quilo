# -*- coding: utf-8 -*-
"""수식 객체 '속성' A/B 프로브 — P1(생성 직후 비정상, 넣기 후 정상) 원인 판정.

넣기 전후 XML 비교(2026-07-13)로 편집기가 부여하는 정준 속성을 확인했다:
  version="Equation Version 60" font="HYhwpEQ" lineMode="CHAR" baseLine=64~89
  (+zOrder/numberingType/textWrap/textFlow/lock/dropcapstyle, outMargin,
   sz width=계산값 height=1000 heightRelTo="PAGE")
우리 생성기는 baseLine=0, sz=0×0, font/version/lineMode 누락 — 이것이
"모든 수식이 넣기 후에야 정상"의 유력 원인이다. 수식을 '문장 속 인라인'
으로 배치해(베이스라인 차이가 보이도록) 속성 변형 A~E 를 비교한다.

또한 version 속성이 문서 렌더러의 스크립트 방언까지 바꾸는지 본다 —
바뀐다면(E행 pivot 이 πvot 가 아니라 pivot 으로 보이면) 편집 왕복 파손
(P2)까지 한 번에 해결된다.

실행: .venv/bin/python3 scripts/eq_attr_probe.py   # tmp/eq-attr-probe.hwpx
확인: 한글에서 열어 어느 행(A~E)이 '넣기를 누른 것과 같은 정상 모양'인지,
      E행 라벨이 pivot/πvot 중 무엇인지 알려줄 것. 넣기는 누르지 않는다.
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

# (행 라벨, 스크립트, 속성 변형)
OUR_SCRIPT = "I_{ p i v o t } `=` {m g d T^{2}} over {4 pi^{2}}"
EDITOR_SCRIPT = "I _{pivot} `=` {mgdT ^{2}} over {4 pi  ^{2}}"
SIMPLE_OUR = "T `=` 2 pi sqrt {{L} over {g}}"
SIMPLE_EDITOR = "T`=`2 pi  sqrt {{L} over {g}}"

ROWS = [
    ("A. 현행 속성 + 현행 스크립트 (대조군)", OUR_SCRIPT, "current"),
    ("B. 정준 속성(sz 유지) + 현행 스크립트", OUR_SCRIPT, "canon_keep_sz"),
    ("C. 정준 속성 + sz 복제 + 현행 스크립트", OUR_SCRIPT, "canon_full"),
    ("D. 현행 속성 + 편집기 스크립트 (스크립트 효과 분리)", EDITOR_SCRIPT, "current"),
    ("E. 정준 속성 + 편집기 스크립트 (넣기 완전 복제)", EDITOR_SCRIPT, "canon_full"),
    ("F. 단순식 — 현행 속성 (대조군)", SIMPLE_OUR, "current"),
    ("G. 단순식 — 정준 속성 + 편집기 스크립트", SIMPLE_EDITOR, "canon_full"),
]

# 편집기 정준 속성(넣기 후 XML 실측). id/textColor/baseUnit 은 기존 값 유지.
_CANON_ATTRS = (
    ('zOrder', '0'), ('numberingType', 'NONE'), ('textWrap', 'TOP_AND_BOTTOM'),
    ('textFlow', 'BOTH_SIDES'), ('lock', '0'), ('dropcapstyle', 'None'),
    ('version', 'Equation Version 60'), ('lineMode', 'CHAR'), ('font', 'HYhwpEQ'),
)


def _patch_equation(m: "re.Match[str]", mode: str, base_line: str) -> str:
    tag, body = m.group(1), m.group(2)
    if mode == "current":
        return m.group(0)
    keep = dict(re.findall(r'([A-Za-z]+)="([^"]*)"', tag))
    attrs = [("id", keep.get("id", "0"))]
    attrs += list(_CANON_ATTRS)
    attrs.insert(8, ("baseLine", base_line))  # version 뒤 위치(편집기 순서 근사)
    attrs.append(("textColor", keep.get("textColor", "#000000")))
    attrs.append(("baseUnit", keep.get("baseUnit", "1000")))
    new_tag = " ".join(f'{k}="{v}"' for k, v in attrs)
    if mode == "canon_full":
        body = re.sub(
            r"<hp:sz[^/]*/>",
            '<hp:sz width="12000" widthRelTo="ABSOLUTE" height="1000" '
            'heightRelTo="PAGE" protect="0"/>',
            body,
            count=1,
        )
        if "<hp:outMargin" not in body:
            body = re.sub(
                r"(<hp:pos[^/]*/>)",
                r'\1<hp:outMargin left="0" right="0" top="0" bottom="0"/>',
                body,
                count=1,
            )
    return f"<hp:equation {new_tag}>{body}</hp:equation>"


def build(out_path: str) -> None:
    doc = HwpxDocument.new()
    doc.add_paragraph("수식 속성 A/B 프로브 — 넣기 없이, 어느 행이 '넣기 후와 같은 정상 모양'인지 판정")
    doc.add_paragraph("각 행: 문장 속 인라인 수식이다. 베이스라인(수식이 글줄에 앉는 높이)·글꼴·")
    doc.add_paragraph("라벨(pivot/πvot)을 비교할 것. E행이 넣기 결과와 동일해야 정상이다.")
    for label, script, _mode in ROWS:
        doc.add_paragraph(label)
        doc.add_paragraph("문장 앞 텍스트 {{EQ:" + script + "}} 문장 뒤 텍스트로 이어진다.")
    with tempfile.TemporaryDirectory(prefix="quilo-eq-attr-") as temp:
        marked = Path(temp) / "marked.hwpx"
        doc.save(marked)
        eq.replace_equation_placeholders(marked, Path(out_path))
    # 변형 적용 — 문서 내 수식 등장 순서 = ROWS 순서
    with zipfile.ZipFile(out_path) as z:
        names = z.namelist()
        data = {n: z.read(n) for n in names}
    xml = data["Contents/section0.xml"].decode("utf-8")
    idx = [0]

    def _sub(m: "re.Match[str]") -> str:
        row = ROWS[idx[0]] if idx[0] < len(ROWS) else None
        idx[0] += 1
        if row is None:
            return m.group(0)
        base_line = "64" if "over" in row[1] else "72"
        return _patch_equation(m, row[2], base_line)

    xml = re.sub(r"<hp:equation\b([^>]*)>(.*?)</hp:equation>", _sub, xml, flags=re.S)
    data["Contents/section0.xml"] = xml.encode("utf-8")
    with zipfile.ZipFile(out_path, "w") as z:
        for n in names:
            z.writestr(n, data[n])
    print(f"✓ 속성 프로브 생성: {out_path} (행 {len(ROWS)}개)")


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "tmp", "eq-attr-probe.hwpx")
    build(out)
