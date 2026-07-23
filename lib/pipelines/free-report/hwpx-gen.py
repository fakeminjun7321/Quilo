#!/usr/bin/env python3
"""free-report HWPX generator — 자유 보고서.

고정 양식이 아니라 모델이 정한 자유 구조(sections[].blocks[])를 그대로 렌더한다.
블록: 문자열 | {subheading} | {equation} | {table} | {chart} | {image} | {list}

문단/제목/표/수식/차트/사진 헬퍼와 한컴 수식 후처리는 phys-result/hwpx-gen.py(및
그것이 재사용하는 chem-pre/hwpx-gen.py)의 공통 헬퍼를 그대로 import 해서 쓴다.
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

# phys-result 모듈을 통째로 로드 — 그 안에서 chem-pre(pre) 도 함께 로드된다.
_spec = importlib.util.spec_from_file_location("phys_result_hwpx_gen", PHYS_HWPX)
phys = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(phys)

pre = phys.pre  # chem-pre/hwpx-gen.py 공통 헬퍼
HwpxDocument = phys.HwpxDocument


def as_blocks(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


# ── 블록 렌더링 ────────────────────────────────────────────────────────────────

def render_blocks(doc, blocks, ctx, *, indent_left=pre.INDENT_5MM):
    """문자열 | {subheading} | {equation} | {table} | {chart} | {image} | {list} 렌더."""
    photos = ctx["photos"]
    fig_counter = ctx["fig_counter"]
    table_counter = ctx["table_counter"]
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
                cap = t.get("caption")
                caption = f"[표 {table_counter['value']}] {cap}" if cap else None
                phys.add_table(doc, headers, rows, caption=caption, target=doc)
        elif isinstance(blk.get("chart"), dict):
            phys.build_chart(doc, blk["chart"], fig_counter, target=doc)
        elif isinstance(blk.get("image"), dict):
            img = blk["image"]
            phys.add_photo_blocks(
                doc,
                img.get("photo_indices"),
                photos,
                fig_counter,
                img.get("caption") or "",
                target=doc,
                photo_captions=img.get("photo_captions"),
            )
        elif isinstance(blk.get("list"), list):
            for item in blk["list"]:
                if item is None or str(item).strip() == "":
                    continue
                phys.add_para_to(
                    doc, doc, f"• {item}",
                    indent_left=indent_left, space_after=pre.SPACE_BODY,
                )


def section_heading(doc, title):
    phys.add_heading_to(
        doc, doc, str(title),
        size=pre.SIZE_TITLE,
        space_before=pre.SPACE_HEADING_LV1,
        space_after=pre.SPACE_HEADING_LV2,
    )


# ── 문서 빌드 ─────────────────────────────────────────────────────────────────

def build_title(doc, content):
    title = str(content.get("title") or "보고서").strip()
    phys.add_para_to(
        doc, doc, title,
        base_size=pre.SIZE_TITLE_BIG, bold=True, align="CENTER",
        space_after=200,
    )
    subtitle = str(content.get("subtitle") or "").strip()
    if subtitle:
        phys.add_para_to(
            doc, doc, subtitle,
            base_size=pre.SIZE_BODY, align="CENTER", space_after=160,
        )
    sid = str(content.get("student_id") or "").strip()
    sname = str(content.get("student_name") or "").strip()
    who = (sid + " " + sname).strip()
    if who:
        phys.add_para_to(
            doc, doc, who,
            base_size=pre.SIZE_BODY, align="CENTER", space_after=120,
        )
    date = str(content.get("date") or "").strip()
    if date:
        phys.add_para_to(
            doc, doc, date,
            base_size=pre.SIZE_BODY, align="CENTER",
            space_after=pre.SPACE_HEADING_LV1,
        )


def build_sections(doc, content, ctx):
    sections = content.get("sections")
    if not isinstance(sections, list):
        return
    for sec in sections:
        if not isinstance(sec, dict):
            continue
        if sec.get("heading"):
            section_heading(doc, sec["heading"])
        render_blocks(doc, sec.get("blocks"), ctx)


def build_references(doc, content):
    refs = content.get("references")
    if not isinstance(refs, list) or not refs:
        return
    section_heading(doc, "참고문헌")
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
    ctx = {
        "photos": phys.as_list(content.get("__photos")),
        "fig_counter": {"value": 0},
        "table_counter": {"value": 0},
    }
    build_title(doc, content)
    build_sections(doc, content, ctx)
    build_references(doc, content)
    return doc


# ── 미리보기 텍스트 ────────────────────────────────────────────────────────────

_EQ_MARKER_RE = __import__("re").compile(
    r"\{\{EQN?(?:-LATEX)?:\s*(.*?)\}\}", __import__("re").S
)


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
            elif isinstance(blk.get("list"), list):
                for item in blk["list"]:
                    if item is not None and str(item).strip():
                        out.append("• " + _clean_preview(item))
    return out


def collect_preview_text(content):
    lines = [str(content.get("title") or "보고서")]
    if content.get("subtitle"):
        lines.append(str(content["subtitle"]))
    lines.append("")
    sections = content.get("sections")
    if isinstance(sections, list):
        for sec in sections:
            if not isinstance(sec, dict):
                continue
            if sec.get("heading"):
                lines.append(str(sec["heading"]))
            lines += _flatten_blocks(sec.get("blocks"))
            lines.append("")
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
