#!/usr/bin/env python3
"""여러 단권 독서활동 기록지 .hwpx 를 하나의 멀티섹션 .hwpx 로 병합한다.

입력(stdin): JSON {"files": ["<base64 hwpx>", ...]}   # 같은 템플릿 산출물이어야 함
출력(stdout): 병합된 hwpx 바이트

방식: 첫 파일을 베이스로 두고, 이후 파일들의 Contents/section0.xml 을
Contents/sectionK.xml 로 추가한 뒤 content.hpf(manifest/spine)와
header.xml(secCnt)만 갱신한다. 표 XML 자체를 건드리지 않는 보수적 병합이라
단권에서 열리던 문서는 병합 후에도 동일 스타일(공유 header)로 열린다.
각 섹션은 자체 페이지 설정(secPr)을 유지하므로 책마다 새 페이지에서 시작한다.

용도: 구글폼 '교과 담당 교사 기준 하나의 파일 제출' 요건(2026-2학기 독서 활동 기록).
"""
import base64
import io
import json
import re
import sys
import zipfile


def main() -> None:
    data = json.loads(sys.stdin.read())
    blobs = [base64.b64decode(b) for b in data.get("files", [])]
    if not blobs:
        print("병합할 파일이 없습니다", file=sys.stderr)
        sys.exit(1)
    if len(blobs) == 1:
        sys.stdout.buffer.write(blobs[0])
        return

    base = zipfile.ZipFile(io.BytesIO(blobs[0]))
    names = base.namelist()
    header = base.read("Contents/header.xml").decode("utf-8")
    hpf = base.read("Contents/content.hpf").decode("utf-8")

    sections = [base.read("Contents/section0.xml")]
    previews = []
    try:
        previews.append(base.read("Preview/PrvText.txt").decode("utf-8", "ignore"))
    except KeyError:
        pass

    for blob in blobs[1:]:
        z = zipfile.ZipFile(io.BytesIO(blob))
        sections.append(z.read("Contents/section0.xml"))
        try:
            previews.append(z.read("Preview/PrvText.txt").decode("utf-8", "ignore"))
        except KeyError:
            pass

    n = len(sections)
    if 'secCnt="' in header:
        header = re.sub(r'secCnt="\d+"', f'secCnt="{n}"', header, count=1)

    items = "".join(
        f'<opf:item id="section{k}" href="Contents/section{k}.xml" media-type="application/xml"/>'
        for k in range(1, n)
    )
    refs = "".join(
        f'<opf:itemref idref="section{k}" linear="yes"/>' for k in range(1, n)
    )
    if '<opf:item id="settings"' in hpf:
        hpf = hpf.replace('<opf:item id="settings"', items + '<opf:item id="settings"', 1)
    else:
        hpf = hpf.replace("</opf:manifest>", items + "</opf:manifest>", 1)
    hpf = hpf.replace("</opf:spine>", refs + "</opf:spine>", 1)

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zo:
        # mimetype 은 규약상 첫 항목 + 무압축
        zo.writestr(zipfile.ZipInfo("mimetype"), base.read("mimetype"), zipfile.ZIP_STORED)
        replaced = {"mimetype", "Contents/header.xml", "Contents/content.hpf", "Preview/PrvText.txt"}
        for name in names:
            if name in replaced:
                continue
            zo.writestr(name, base.read(name), zipfile.ZIP_DEFLATED)
        zo.writestr("Contents/header.xml", header.encode("utf-8"), zipfile.ZIP_DEFLATED)
        zo.writestr("Contents/content.hpf", hpf.encode("utf-8"), zipfile.ZIP_DEFLATED)
        for k in range(1, n):
            zo.writestr(f"Contents/section{k}.xml", sections[k], zipfile.ZIP_DEFLATED)
        if previews:
            zo.writestr(
                "Preview/PrvText.txt",
                "\n\n".join(previews)[:4000].encode("utf-8"),
                zipfile.ZIP_DEFLATED,
            )
    sys.stdout.buffer.write(out.getvalue())


if __name__ == "__main__":
    main()
