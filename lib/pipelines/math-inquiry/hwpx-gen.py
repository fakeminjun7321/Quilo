#!/usr/bin/env python3
"""math-inquiry HWPX generator — 수학Ⅲ 급수 탐구보고서 (수행평가).

학교 안내문 양식 구조를 직접 빌드한다:

  <탐구 제목> (가운데)                       작성자 OOO (오른쪽)
  Ⅰ. 탐구 주제
  Ⅱ. 탐구 목적
  Ⅲ. 선행연구 분석  (1. 이론적 배경 / 2. 선행연구 분석)
  Ⅳ. 탐구 과정 및 탐구 내용
  Ⅴ. 탐구 결과 정리 및 반성
  참고문헌

문단/수식/표/차트 헬퍼와 한컴 수식 후처리는 phys-result/hwpx-gen.py(및 chem-pre)의
공통 헬퍼를 그대로 재사용한다(phys-inquiry와 동일 패턴).
"""
import importlib.util
import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PHYS_HWPX = HERE.parent / "phys-result" / "hwpx-gen.py"

_spec = importlib.util.spec_from_file_location("phys_result_hwpx_gen", PHYS_HWPX)
phys = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(phys)

pre = phys.pre
HwpxDocument = phys.HwpxDocument

SECTIONS = [
    ("Ⅰ", "탐구 주제", "inquiry_topic"),
    ("Ⅱ", "탐구 목적", "inquiry_purpose"),
    ("Ⅲ", "선행연구 분석", None),  # 하위 1./2. 별도 처리
    ("Ⅳ", "탐구 과정 및 탐구 내용", "process"),
    ("Ⅴ", "탐구 결과 정리 및 반성", "results_reflection"),
]


def as_blocks(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def as_dict(value):
    return value if isinstance(value, dict) else {}


def render_blocks(doc, blocks, fig_counter, table_counter, *, indent_left=pre.INDENT_5MM):
    """문자열 | {subheading} | {equation} | {table} | {chart} 블록 렌더."""
    for blk in as_blocks(blocks):
        if isinstance(blk, str):
            if blk.strip():
                phys.add_para_to(
                    doc, doc, blk,
                    indent_left=indent_left, space_after=pre.SPACE_BODY,
                )
            continue
        if not isinstance(blk, dict):
            continue
        if blk.get("subheading"):
            phys.add_para_to(
                doc, doc, str(blk["subheading"]),
                base_size=pre.SIZE_BODY, bold=True,
                indent_left=indent_left,
                space_before=200, space_after=pre.SPACE_BODY,
            )
        elif blk.get("equation"):
            eq = str(blk["equation"]).strip()
            if eq:
                if "{{EQ" not in eq:
                    # LaTeX(백슬래시 명령 포함)면 EQ-LATEX — hwip 엔진이 한컴
                    # 수식으로 정확 변환. 백슬래시 없는 내용(레거시 한컴 스크립트·
                    # 단순식)은 종전대로 EQ(직접 스크립트) 경로 유지.
                    kind = "EQ-LATEX" if "\\" in eq else "EQ"
                    eq = "{{" + kind + ":" + eq + "}}"
                phys.add_para_to(
                    doc, doc, eq, align="CENTER", space_after=pre.SPACE_BODY,
                )
        elif isinstance(blk.get("table"), dict):
            t = blk["table"]
            headers = t.get("headers") or []
            rows = t.get("rows") or []
            if headers:
                table_counter["value"] += 1
                cap = t.get("caption") or "자료"
                phys.add_table(
                    doc, headers, rows,
                    caption=f"[표 {table_counter['value']}] {cap}", target=doc,
                )
        elif isinstance(blk.get("chart"), dict):
            phys.build_chart(doc, blk["chart"], fig_counter, target=doc)


def section_heading(doc, roman, title):
    phys.add_heading_to(
        doc, doc, f"{roman}. {title}",
        size=pre.SIZE_TITLE,
        space_before=pre.SPACE_HEADING_LV1,
        space_after=pre.SPACE_HEADING_LV2,
    )


def sub_heading(doc, num, title):
    phys.add_heading_to(
        doc, doc, f"{num}. {title}",
        size=pre.SIZE_HEADING,
        space_before=pre.SPACE_HEADING_LV2,
        space_after=pre.SPACE_BODY,
    )


def build_title(doc, content):
    title = str(content.get("title") or "급수 탐구보고서").strip()
    phys.add_para_to(
        doc, doc, f"<{title}>",
        base_size=pre.SIZE_TITLE_BIG, bold=True, align="CENTER",
        space_after=200,
    )
    sname = str(content.get("student_name") or "").strip()
    sid = str(content.get("student_id") or "").strip()
    who = " ".join(x for x in (sid, sname) if x)
    if who:
        phys.add_para_to(
            doc, doc, f"작성자 {who}",
            base_size=pre.SIZE_BODY, align="RIGHT",
            space_after=pre.SPACE_HEADING_LV1,
        )


def build_references(doc, content):
    refs = content.get("references")
    if not isinstance(refs, list) or not refs:
        return
    phys.add_heading_to(
        doc, doc, "참고문헌",
        size=pre.SIZE_TITLE,
        space_before=pre.SPACE_HEADING_LV1,
        space_after=pre.SPACE_HEADING_LV2,
    )
    for i, ref in enumerate(refs, 1):
        if isinstance(ref, dict):
            label = str(ref.get("label") or "").strip()
            url = str(ref.get("url") or "").strip()
        else:
            label, url = str(ref or "").strip(), ""
        if not label and not url:
            continue
        text = f"[{i}] {label}".strip()
        if url:
            text = f"{text} {url}".strip()
        phys.add_para_to(
            doc, doc, text,
            base_size=pre.SIZE_BODY, indent_left=pre.INDENT_5MM,
            space_after=pre.SPACE_BODY,
        )


def generate_hwpx(content):
    doc = HwpxDocument.new()
    doc._v5_allow_highlights = bool(content.get("__allowHighlights", True))
    phys.apply_phys_page_layout(doc)
    pre.apply_default_font(doc, pre.resolve_font_face(content))

    fig_counter = {"value": 0}
    table_counter = {"value": 0}

    build_title(doc, content)

    pr = as_dict(content.get("prior_research"))
    for roman, title, key in SECTIONS:
        section_heading(doc, roman, title)
        if key:
            render_blocks(doc, content.get(key), fig_counter, table_counter)
        else:  # Ⅲ. 선행연구 분석 — 하위 1./2.
            sub_heading(doc, "1", "이론적 배경")
            render_blocks(doc, pr.get("theory"), fig_counter, table_counter)
            sub_heading(doc, "2", "선행연구 분석")
            render_blocks(doc, pr.get("analysis"), fig_counter, table_counter)

    build_references(doc, content)
    return doc


# ── 미리보기 텍스트 ────────────────────────────────────────────────────────────

import re as _re

_EQ_MARKER_RE = _re.compile(r"\{\{EQN?(?:-LATEX)?:\s*(.*?)\}\}", _re.S)


def _clean_preview(text):
    s = str(text or "")
    s = _EQ_MARKER_RE.sub(lambda m: m.group(1), s)
    s = s.replace("_{", "").replace("^{", "")
    s = s.replace("{", "").replace("}", "")
    s = s.replace("**", "").replace("*", "")
    return s.strip()


def _flatten_blocks(blocks):
    out = []
    for blk in as_blocks(blocks):
        if isinstance(blk, str):
            if blk.strip():
                out.append(_clean_preview(blk))
        elif isinstance(blk, dict):
            if blk.get("subheading"):
                out.append(_clean_preview(blk["subheading"]))
            elif blk.get("equation"):
                out.append(_clean_preview(blk["equation"]))
    return out


def collect_preview_text(content):
    lines = [f"<{content.get('title') or '급수 탐구보고서'}>", ""]
    pr = as_dict(content.get("prior_research"))
    for roman, title, key in SECTIONS:
        lines.append(f"{roman}. {title}")
        if key:
            lines += _flatten_blocks(content.get(key))
        else:
            lines += _flatten_blocks(pr.get("theory"))
            lines += _flatten_blocks(pr.get("analysis"))
    return "\r\n".join(str(x) for x in lines).strip()[:8000] + "\r\n"


def update_preview_text(hwpx_path, text):
    src = Path(hwpx_path)
    with tempfile.NamedTemporaryFile(suffix=".hwpx", dir=src.parent, delete=False) as tf:
        tmp = Path(tf.name)
    try:
        with zipfile.ZipFile(src, "r") as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
            replaced = False
            for item in zin.infolist():
                if item.filename == "Preview/PrvText.txt":
                    zout.writestr(item, text.encode("utf-8"))
                    replaced = True
                else:
                    zout.writestr(item, zin.read(item.filename))
            if not replaced:
                zout.writestr("Preview/PrvText.txt", text.encode("utf-8"))
        shutil.move(str(tmp), str(src))
    except Exception:
        if tmp.exists():
            tmp.unlink()
        raise


def main():
    if len(sys.argv) >= 2 and sys.argv[1] != "-":
        content = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    else:
        content = json.loads(sys.stdin.read())

    content = pre._deep_clean_xml(content)
    doc = generate_hwpx(content)

    if len(sys.argv) >= 3:
        target = Path(sys.argv[2])
        doc.save_to_path(str(target))
        pre._postprocess_equations(target)
        pre.ensure_embedded_bindata_items(target)
        update_preview_text(target, collect_preview_text(content))
    else:
        import os
        with tempfile.NamedTemporaryFile(suffix=".hwpx", delete=False) as tf:
            tmp_path = Path(tf.name)
        try:
            doc.save_to_path(str(tmp_path))
            pre._postprocess_equations(tmp_path)
            pre.ensure_embedded_bindata_items(tmp_path)
            update_preview_text(tmp_path, collect_preview_text(content))
            sys.stdout.buffer.write(tmp_path.read_bytes())
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    main()
