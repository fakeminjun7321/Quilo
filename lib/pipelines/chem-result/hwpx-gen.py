#!/usr/bin/env python3
"""chem-result HWPX generator.

This reuses the hardened paragraph/table/font helpers from the chem-pre HWPX
generator and adds the result-report specific sections plus real image/chart
embedding.
"""
import base64
import importlib.util
import json
import struct
import sys
from pathlib import Path
from lxml import etree

HERE = Path(__file__).resolve().parent
PRE_HWPX = HERE.parent / "chem-pre" / "hwpx-gen.py"
spec = importlib.util.spec_from_file_location("chem_pre_hwpx_gen", PRE_HWPX)
pre = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pre)

from hwpx import HwpxDocument


MAX_IMAGE_WIDTH = 33000
MAX_IMAGE_HEIGHT = 23000
MAX_CHART_WIDTH = 36000
MAX_CHART_HEIGHT = 23000
PX_TO_HWPUNIT = 75


def as_list(value):
    return value if isinstance(value, list) else []


def ref_to_string(ref):
    if isinstance(ref, str):
        return ref
    if isinstance(ref, dict):
        parts = [
            ref.get("author") or ref.get("authors"),
            ref.get("year") or ref.get("date"),
            ref.get("title"),
            ref.get("journal"),
            ref.get("publisher"),
            ref.get("url"),
        ]
        return ", ".join(str(p) for p in parts if p)
    return str(ref or "")


def decode_base64(value):
    if not value:
        return b""
    try:
        return base64.b64decode(value)
    except Exception:
        return b""


def image_format(name="", mimetype="", data=b""):
    name_ext = Path(str(name or "")).suffix.lower().lstrip(".")
    if name_ext in ("jpg", "jpeg", "png", "gif", "bmp"):
        return "jpg" if name_ext == "jpeg" else name_ext
    if mimetype:
        mt = mimetype.lower()
        if "jpeg" in mt:
            return "jpg"
        if "png" in mt:
            return "png"
        if "gif" in mt:
            return "gif"
        if "bmp" in mt:
            return "bmp"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8"):
        return "jpg"
    if data.startswith(b"GIF8"):
        return "gif"
    if data.startswith(b"BM"):
        return "bmp"
    return "png"


def image_size(data):
    try:
        if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
            return struct.unpack(">II", data[16:24])
        if data.startswith(b"GIF8") and len(data) >= 10:
            return struct.unpack("<HH", data[6:10])
        if data.startswith(b"BM") and len(data) >= 26:
            w = struct.unpack("<I", data[18:22])[0]
            h = abs(struct.unpack("<i", data[22:26])[0])
            return w, h
        if data.startswith(b"\xff\xd8"):
            i = 2
            while i + 9 < len(data):
                while i < len(data) and data[i] == 0xFF:
                    i += 1
                marker = data[i]
                i += 1
                if marker in (0xD8, 0xD9):
                    continue
                if i + 2 > len(data):
                    break
                size = struct.unpack(">H", data[i:i + 2])[0]
                if marker in range(0xC0, 0xC4) and i + 7 < len(data):
                    h, w = struct.unpack(">HH", data[i + 3:i + 7])
                    return w, h
                i += size
    except Exception:
        pass
    return 800, 500


def fit_size(width_px, height_px, max_width, max_height):
    width = max(int(width_px * PX_TO_HWPUNIT), 1)
    height = max(int(height_px * PX_TO_HWPUNIT), 1)
    scale = min(max_width / width, max_height / height, 1)
    return max(int(width * scale), 1), max(int(height * scale), 1), width, height


_PIC_SEQ = 0


def add_picture(doc, data, *, fmt="png", caption="", max_width=MAX_IMAGE_WIDTH,
                max_height=MAX_IMAGE_HEIGHT):
    if not data:
        return False
    # id(data)는 버퍼 GC·재사용 시 충돌해 다중 이미지 HWPX가 깨질 수 있어
    # 단조 증가 카운터로 그림 식별자를 고유하게 만든다. (코드 리뷰 ⑨)
    global _PIC_SEQ
    _PIC_SEQ += 1
    _pic_id = 1900000000 + _PIC_SEQ
    width_px, height_px = image_size(data)
    width, height, org_width, org_height = fit_size(
        width_px, height_px, max_width, max_height,
    )
    item_id = doc.add_image(data, fmt)

    para_pr = pre.make_para_pr(
        doc,
        align="CENTER",
        line_spacing=pre.LINE_SPACING_PERCENT,
        space_after=180,
    )
    para = doc.add_paragraph(
        "",
        para_pr_id_ref=para_pr,
        inherit_style=False,
        include_run=False,
    )
    pic = para.add_shape(
        "pic",
        attributes={
            "id": str(_pic_id),
            "zOrder": "1",
            "numberingType": "PICTURE",
            "textWrap": "TOP_AND_BOTTOM",
            "textFlow": "BOTH_SIDES",
            "lock": "0",
            "dropcapstyle": "None",
            "href": "",
            "groupLevel": "0",
            "instid": str(_pic_id + 100000000),
            "reverse": "0",
        },
    ).element

    etree.SubElement(pic, f"{pre.NS_HP}offset", x="0", y="0")
    etree.SubElement(pic, f"{pre.NS_HP}orgSz", width=str(org_width), height=str(org_height))
    etree.SubElement(pic, f"{pre.NS_HP}curSz", width=str(width), height=str(height))
    etree.SubElement(pic, f"{pre.NS_HP}flip", horizontal="0", vertical="0")
    etree.SubElement(
        pic,
        f"{pre.NS_HP}rotationInfo",
        angle="0",
        centerX=str(width // 2),
        centerY=str(height // 2),
        rotateimage="1",
    )
    rendering = etree.SubElement(pic, f"{pre.NS_HP}renderingInfo")
    etree.SubElement(rendering, f"{pre.NS_HC}transMatrix", e1="1", e2="0", e3="0", e4="0", e5="1", e6="0")
    etree.SubElement(rendering, f"{pre.NS_HC}scaMatrix", e1="1", e2="0", e3="0", e4="0", e5="1", e6="0")
    etree.SubElement(rendering, f"{pre.NS_HC}rotMatrix", e1="1", e2="0", e3="0", e4="0", e5="1", e6="0")
    etree.SubElement(
        pic,
        f"{pre.NS_HC}img",
        binaryItemIDRef=item_id,
        bright="0",
        contrast="0",
        effect="REAL_PIC",
        alpha="0",
    )
    rect = etree.SubElement(pic, f"{pre.NS_HP}imgRect")
    for name, x, y in (
        ("pt0", 0, 0),
        ("pt1", org_width, 0),
        ("pt2", org_width, org_height),
        ("pt3", 0, org_height),
    ):
        etree.SubElement(rect, f"{pre.NS_HC}{name}", x=str(x), y=str(y))
    etree.SubElement(pic, f"{pre.NS_HP}imgClip", left="0", right=str(org_width), top="0", bottom=str(org_height))
    etree.SubElement(pic, f"{pre.NS_HP}inMargin", left="0", right="0", top="0", bottom="0")
    etree.SubElement(pic, f"{pre.NS_HP}imgDim", dimwidth=str(org_width), dimheight=str(org_height))
    etree.SubElement(pic, f"{pre.NS_HP}effects")
    etree.SubElement(
        pic,
        f"{pre.NS_HP}sz",
        width=str(width),
        widthRelTo="ABSOLUTE",
        height=str(height),
        heightRelTo="ABSOLUTE",
        protect="0",
    )
    etree.SubElement(
        pic,
        f"{pre.NS_HP}pos",
        treatAsChar="1",
        affectLSpacing="0",
        flowWithText="1",
        allowOverlap="0",
        holdAnchorAndSO="0",
        vertRelTo="PARA",
        horzRelTo="COLUMN",
        vertAlign="TOP",
        horzAlign="CENTER",
        vertOffset="0",
        horzOffset="0",
    )
    etree.SubElement(pic, f"{pre.NS_HP}outMargin", left="0", right="0", top="0", bottom="0")
    etree.SubElement(pic, f"{pre.NS_HP}shapeComment").text = caption or "image"

    if caption:
        pre.add_para(
            doc,
            caption,
            base_size=pre.SIZE_CAPTION,
            align="CENTER",
            space_after=pre.SPACE_BODY,
        )
    return True


def add_table(doc, headers, rows, caption=None):
    headers = [str(h or "") for h in headers]
    rows = [[str(c or "") for c in row] for row in rows or []]
    if not headers:
        return

    solid_id = pre.make_solid_border_fill(doc)
    shaded_id = pre.make_shaded_border_fill(doc)
    table = doc.add_table(
        rows=len(rows) + 1,
        cols=len(headers),
        width=pre.TABLE_WIDTH,
        border_fill_id_ref=solid_id,
    )
    col_width = max(int(pre.TABLE_WIDTH / len(headers)), 3000)
    for c in range(len(headers)):
        for r in range(len(rows) + 1):
            try:
                table.cell(r, c).set_size(width=col_width)
            except Exception:
                pass

    for c, text in enumerate(headers):
        cell = table.cell(0, c)
        cell.element.set("borderFillIDRef", str(shaded_id))
        pre._replace_cell_with_styled(
            doc,
            cell,
            text,
            size=pre.SIZE_TABLE_HEADER,
            bold=True,
            align="CENTER",
            line_spacing=pre.TABLE_LINE_SPACING_PERCENT,
        )

    for r_idx, row in enumerate(rows, 1):
        for c_idx in range(len(headers)):
            cell = table.cell(r_idx, c_idx)
            cell.element.set("borderFillIDRef", str(solid_id))
            pre._replace_cell_with_styled(
                doc,
                cell,
                row[c_idx] if c_idx < len(row) else "",
                size=pre.SIZE_TABLE_BODY,
                align="CENTER",
                line_spacing=pre.TABLE_LINE_SPACING_PERCENT,
            )
    if caption:
        pre.add_para(
            doc,
            caption,
            base_size=pre.SIZE_CAPTION,
            align="CENTER",
            space_after=pre.SPACE_BODY,
        )


def build_header(doc, content):
    title_kr = content.get("title_kr", "")
    title_en = content.get("title_en", "")
    date = content.get("date", "")
    student_id = (content.get("student_id") or "").strip()
    student_name = (content.get("student_name") or "").strip()
    temp = (content.get("temperature") or content.get("conditions", {}).get("temperature") or "").strip()
    pressure = (content.get("pressure") or content.get("conditions", {}).get("pressure") or "").strip()

    pre.add_heading(doc, "실험 보고서", size=pre.SIZE_TITLE_BIG, align="CENTER", space_after=pre.SPACE_HEADING_LV1)
    title = f"{title_en} ({title_kr})" if title_en and title_kr else title_en or title_kr or "화학 결과보고서"
    pre.add_heading(doc, title, size=pre.SIZE_TITLE, align="CENTER", space_after=pre.SPACE_HEADING_LV1)
    identity = " ".join(x for x in [student_id, student_name] if x)
    if identity:
        pre.add_para(doc, identity, align="RIGHT")
    if date:
        pre.add_para(doc, f"날짜 : {date}", align="RIGHT")
    if temp or pressure:
        pre.add_para(doc, f"온도/기압 : {temp or ''} / {pressure or ''}", align="RIGHT", space_after=pre.SPACE_HEADING_LV1)


def build_purpose(doc, content):
    pre.add_heading(doc, "1. 실험목표", size=pre.SIZE_TITLE, space_before=pre.SPACE_HEADING_LV1, space_after=pre.SPACE_HEADING_LV2)
    pre.add_heading(doc, "가. 실험목표", size=pre.SIZE_HEADING, space_after=pre.SPACE_BODY)
    counter = 0
    for item in as_list(content.get("purpose")):
        counter += 1
        if not pre.add_numbered_item(doc, counter, item):
            counter -= 1


def build_theory(doc, content):
    pre.add_heading(doc, "2. 이론적 배경과 원리", size=pre.SIZE_TITLE, space_before=pre.SPACE_HEADING_LV1, space_after=pre.SPACE_HEADING_LV2)
    for s_idx, section in enumerate(as_list(content.get("theory"))):
        kr = pre.KR_NUM[s_idx] if s_idx < len(pre.KR_NUM) else str(s_idx + 1)
        pre.add_heading(
            doc,
            f"{kr}. {pre.strip_manual_numbering(section.get('topic', ''))}",
            size=pre.SIZE_HEADING,
            space_after=pre.SPACE_BODY,
        )
        counter = 0
        for item in as_list(section.get("items") or section.get("paragraphs")):
            if isinstance(item, str):
                counter += 1
                if not pre.add_numbered_item(doc, counter, item):
                    counter -= 1


def build_apparatus(doc, content):
    pre.add_heading(doc, "3. 실험 기구 및 시약", size=pre.SIZE_TITLE, space_before=pre.SPACE_HEADING_LV1, space_after=pre.SPACE_HEADING_LV2)
    pre.add_heading(doc, "가. 실험 기구", size=pre.SIZE_HEADING, space_after=pre.SPACE_BODY)
    counter = 0
    for item in as_list(content.get("apparatus")):
        if isinstance(item, dict):
            text = f"{item.get('name', '')}: {item.get('description', '')}"
        else:
            text = str(item)
        counter += 1
        if not pre.add_numbered_item(doc, counter, text):
            counter -= 1

    pre.add_heading(doc, "나. 시약", size=pre.SIZE_HEADING, space_after=pre.SPACE_BODY)
    counter = 0
    for item in as_list(content.get("chemicals")):
        if isinstance(item, dict):
            title = item.get("name") or item.get("iupac") or ""
            formula = item.get("formula") or ""
            desc = " ".join(
                str(x) for x in [
                    item.get("molar_mass"),
                    item.get("properties"),
                    item.get("toxicity"),
                ] if x
            )
            text = f"{title} ({formula}) {desc}".strip()
        else:
            text = str(item)
        counter += 1
        if not pre.add_numbered_item(doc, counter, text):
            counter -= 1


def build_procedure(doc, content):
    pre.add_heading(doc, "4. 실험 과정", size=pre.SIZE_TITLE, space_before=pre.SPACE_HEADING_LV1, space_after=pre.SPACE_HEADING_LV2)
    for sec_idx, section in enumerate(as_list(content.get("procedure"))):
        kr = pre.KR_NUM[sec_idx] if sec_idx < len(pre.KR_NUM) else str(sec_idx + 1)
        pre.add_heading(
            doc,
            f"{kr}. {pre.strip_manual_numbering(section.get('title', ''))}",
            size=pre.SIZE_HEADING,
            space_after=pre.SPACE_BODY,
        )
        counter = 0
        for step in as_list(section.get("steps")):
            text = step if isinstance(step, str) else step.get("text", "")
            counter += 1
            if not pre.add_numbered_item(doc, counter, text):
                counter -= 1


def _emit_exp_photos(doc, exp, photos, fig_counter):
    """실험 한 파트의 사진들을 캡션과 함께 삽입하고 갱신된 fig_counter 를 반환.
    default·minimal 출력이 동일한 캡션 규칙(사진마다 다른 캡션)을 공유하도록 분리."""
    photo_indices = as_list(exp.get("photo_indices"))
    photo_captions = exp.get("photo_captions")
    if not isinstance(photo_captions, list):
        photo_captions = []
    multiple = len(photo_indices) > 1
    for pos, photo_idx in enumerate(photo_indices):
        try:
            photo = photos[int(photo_idx)]
        except Exception:
            continue
        blob = decode_base64(photo.get("data_base64"))
        fmt = image_format(photo.get("name"), photo.get("mimetype"), blob)
        fig_counter += 1
        # 사진마다 다른 캡션: photo_captions[위치] 우선. 없으면 단일 사진은 통합 캡션/실험명을,
        # 여러 장이면 같은 통합 캡션을 모든 사진에 반복하지 않도록 첫 사진에만 단다.
        per_photo = ""
        if pos < len(photo_captions) and isinstance(photo_captions[pos], str):
            per_photo = photo_captions[pos].strip()
        if per_photo:
            desc = per_photo
        elif multiple:
            desc = (exp.get("photo_caption") or exp.get("name") or "실험 사진") if pos == 0 else ""
        else:
            desc = exp.get("photo_caption") or exp.get("name") or "실험 사진"
        caption = f"[그림 {fig_counter}] {desc}".rstrip()
        add_picture(doc, blob, fmt=fmt, caption=caption)
    return fig_counter


def _emit_charts(doc, charts, fig_counter):
    """차트 PNG 들을 본문에 삽입하고 갱신된 fig_counter 를 반환."""
    for chart in as_list(charts):
        blob = decode_base64(chart.get("png_base64"))
        if not blob:
            continue
        fig_counter += 1
        title = chart.get("title") or "그래프"
        caption = f"[그림 {fig_counter}] {title}"
        if chart.get("caption"):
            caption += f" - {chart.get('caption')}"
        add_picture(
            doc,
            blob,
            fmt="png",
            caption=caption,
            max_width=MAX_CHART_WIDTH,
            max_height=MAX_CHART_HEIGHT,
        )
    return fig_counter


def build_data(doc, content):
    pre.add_heading(doc, "5. 실험 결과", size=pre.SIZE_TITLE, space_before=pre.SPACE_HEADING_LV1, space_after=pre.SPACE_HEADING_LV2)
    data = content.get("data") or {}
    photos = as_list(content.get("__photos"))
    fig_counter = 0
    table_counter = 0

    if data.get("summary"):
        pre.add_para(doc, str(data["summary"]))

    for exp_idx, exp in enumerate(as_list(data.get("experiments")), 1):
        kr = pre.KR_NUM[exp_idx - 1] if exp_idx - 1 < len(pre.KR_NUM) else str(exp_idx)
        pre.add_heading(doc, f"{kr}. {exp.get('name', '측정 데이터')}", size=pre.SIZE_HEADING, space_after=pre.SPACE_BODY)

        table = exp.get("table") or {}
        if table.get("headers") and isinstance(table.get("rows"), list):
            table_counter += 1
            add_table(
                doc,
                table.get("headers"),
                table.get("rows"),
                caption=f"[표 {table_counter}] {exp.get('name', '측정 데이터')}",
            )

        stats = as_list(exp.get("stats"))
        counter = 0
        for stat in stats:
            if isinstance(stat, dict):
                text = f"{stat.get('label', '')}: {stat.get('value', '')}"
            else:
                text = str(stat)
            counter += 1
            if not pre.add_numbered_item(doc, counter, text):
                counter -= 1

        fig_counter = _emit_exp_photos(doc, exp, photos, fig_counter)

    summary_table = data.get("summary_table") or {}
    if summary_table.get("headers") and isinstance(summary_table.get("rows"), list):
        table_counter += 1
        add_table(
            doc,
            summary_table.get("headers"),
            summary_table.get("rows"),
            caption=f"[표 {table_counter}] 실험 결과 요약",
        )

    fig_counter = _emit_charts(doc, data.get("charts"), fig_counter)


def build_discussion(doc, content):
    pre.add_heading(doc, "6. 논의 및 결론", size=pre.SIZE_TITLE, space_before=pre.SPACE_HEADING_LV1, space_after=pre.SPACE_HEADING_LV2)
    discussion = content.get("discussion") or {}
    groups = [
        ("가. 결과 분석", discussion.get("analysis")),
        ("나. 오차 분석", discussion.get("errors")),
        ("다. 개선점", discussion.get("improvements")),
    ]
    for title, items in groups:
        values = as_list(items)
        if not values:
            continue
        pre.add_heading(doc, title, size=pre.SIZE_HEADING, space_after=pre.SPACE_BODY)
        counter = 0
        for item in values:
            counter += 1
            if not pre.add_numbered_item(doc, counter, item):
                counter -= 1


def build_references(doc, content):
    refs = as_list(content.get("references"))
    if not refs:
        return
    pre.add_heading(doc, "7. 참고 문헌", size=pre.SIZE_TITLE, space_before=pre.SPACE_HEADING_LV1, space_after=pre.SPACE_HEADING_LV2)
    for idx, ref in enumerate(refs, 1):
        pre.add_para(doc, f"[{idx}] {ref_to_string(ref)}", indent_left=pre.INDENT_5MM)


def build_pcei(doc, content):
    pcei = content.get("pcei") or {}
    # DEF-033: 4개 필드가 전부 비었으면(공백만 있어도) 섹션 전체 생략.
    # docx-gen.js buildPCEI와 동일 기준.
    if not any(str(pcei.get(k) or "").strip() for k in ("perception", "curiosity", "exploration", "insight")):
        return
    pre.add_heading(doc, "추가 작성 (PCEI)", size=pre.SIZE_TITLE, space_before=pre.SPACE_HEADING_LV1, space_after=pre.SPACE_HEADING_LV2)
    labels = [
        ("perception", "가. Perception (관찰)"),
        ("curiosity", "나. Curiosity (의문점)"),
        ("exploration", "다. Exploration (탐구)"),
        ("insight", "라. Insight (통찰)"),
    ]
    for key, label in labels:
        if not pcei.get(key):
            continue
        pre.add_heading(doc, label, size=pre.SIZE_HEADING, space_after=pre.SPACE_BODY)
        pre.add_para(doc, str(pcei[key]), indent_left=pre.INDENT_5MM)


def _para_text(value):
    return pre.strip_manual_numbering(value) if isinstance(value, str) else str(value)


def build_minimal_data(doc, content):
    """minimal 스타일: 가./나./다. 헤더 없이 실험명만 굵게, 표·통계 한 줄·사진·차트는
    본문 흐름에 그대로. docx-gen.js buildMinimalData 와 동일한 출력 규칙."""
    pre.add_heading(doc, "5. 실험 결과", size=pre.SIZE_TITLE, space_before=pre.SPACE_HEADING_LV1, space_after=pre.SPACE_HEADING_LV2)
    data = content.get("data") or {}
    photos = as_list(content.get("__photos"))
    fig_counter = 0
    table_counter = 0

    if data.get("summary"):
        pre.add_para(doc, str(data["summary"]))

    exps = as_list(data.get("experiments"))
    multiple_exps = len(exps) > 1
    for exp in exps:
        # 가./나. 헤더 금지 — 실험이 여러 개일 때만 실험명을 굵은 한 줄로.
        if multiple_exps:
            pre.add_para(doc, str(exp.get("name", "")), bold=True, space_after=120)

        table = exp.get("table") or {}
        if table.get("headers") and isinstance(table.get("rows"), list):
            table_counter += 1
            add_table(
                doc,
                table.get("headers"),
                table.get("rows"),
                caption=f"[표 {table_counter}] {exp.get('name', '측정 데이터')}",
            )

        stats = as_list(exp.get("stats"))
        if stats:
            parts = []
            for stat in stats:
                if isinstance(stat, dict):
                    parts.append(f"{stat.get('label', '')}: {stat.get('value', '')}")
                else:
                    parts.append(str(stat))
            pre.add_para(doc, ", ".join(parts), indent_left=pre.INDENT_5MM)

        fig_counter = _emit_exp_photos(doc, exp, photos, fig_counter)

    summary_table = data.get("summary_table") or {}
    if summary_table.get("headers") and isinstance(summary_table.get("rows"), list):
        table_counter += 1
        add_table(
            doc,
            summary_table.get("headers"),
            summary_table.get("rows"),
            caption=f"[표 {table_counter}] 실험 결과 요약",
        )

    fig_counter = _emit_charts(doc, data.get("charts"), fig_counter)


def build_minimal_discussion(doc, content):
    """minimal: 가./나./다. 헤더 없이 '6. 결론'. analysis 와 errors/improvements 가
    모두 있으면 '7. 논의'로 분리. docx-gen.js buildMinimalDiscussion 과 동일."""
    d = content.get("discussion") or {}
    analysis = as_list(d.get("analysis"))
    errors = as_list(d.get("errors"))
    improvements = as_list(d.get("improvements"))
    has_discussion = len(errors) > 0 or len(improvements) > 0

    pre.add_heading(doc, "6. 결론", size=pre.SIZE_TITLE, space_before=pre.SPACE_HEADING_LV1, space_after=pre.SPACE_HEADING_LV2)
    if not analysis and not has_discussion:
        pre.add_para(doc, "(논의 데이터 부족)")
    elif analysis:
        for a in analysis:
            pre.add_para(doc, _para_text(a))
    else:
        for t in [*errors, *improvements]:
            pre.add_para(doc, _para_text(t))

    if analysis and has_discussion:
        pre.add_heading(doc, "7. 논의", size=pre.SIZE_TITLE, space_before=pre.SPACE_HEADING_LV1, space_after=pre.SPACE_HEADING_LV2)
        for e in errors:
            pre.add_para(doc, _para_text(e))
        for imp in improvements:
            pre.add_para(doc, _para_text(imp))


def build_minimal_references(doc, content):
    """minimal: 결론+논의가 분리됐으면 8번, 아니면 7번. docx-gen.js buildMinimalReferences 와 동일."""
    d = content.get("discussion") or {}
    has_discussion = len(as_list(d.get("analysis"))) > 0 and (
        len(as_list(d.get("errors"))) > 0 or len(as_list(d.get("improvements"))) > 0
    )
    num = 8 if has_discussion else 7
    pre.add_heading(doc, f"{num}. 참고 문헌", size=pre.SIZE_TITLE, space_before=pre.SPACE_HEADING_LV1, space_after=pre.SPACE_HEADING_LV2)
    refs = as_list(content.get("references"))
    if not refs:
        pre.add_para(doc, "(참고문헌 미작성)")
        return
    for ref in refs:
        pre.add_para(doc, ref_to_string(ref))


def generate_hwpx(content):
    doc = HwpxDocument.new()
    doc._v5_allow_highlights = bool(content.get("__allowHighlights", True))
    pre.apply_page_layout(doc)
    pre.apply_default_font(doc, pre.resolve_font_face(content))
    # chem-result output is the continuation to place after the uploaded
    # pre-report PDF, so only render the added result/report-back sections.
    if content.get("__style") == "minimal":
        # minimal: 가./나./다. 헤더·PCEI 없이 docx minimal 과 동일한 간결 구성.
        build_minimal_data(doc, content)
        build_minimal_discussion(doc, content)
        build_minimal_references(doc, content)
    else:
        build_data(doc, content)
        build_discussion(doc, content)
        build_references(doc, content)
        build_pcei(doc, content)
    return doc


def main():
    if len(sys.argv) >= 2:
        content = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    else:
        content = json.loads(sys.stdin.read())
    content = pre._deep_clean_xml(content)  # XML 비허용 제어문자 제거 (코드 리뷰 ⑧)
    doc = generate_hwpx(content)
    if len(sys.argv) >= 3:
        target = Path(sys.argv[2])
        doc.save_to_path(str(target))
        pre._postprocess_equations(target)
        pre.ensure_embedded_bindata_items(target)
    else:
        import os
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".hwpx", delete=False) as tf:
            tmp_path = Path(tf.name)
        try:
            doc.save_to_path(str(tmp_path))
            pre._postprocess_equations(tmp_path)
            pre.ensure_embedded_bindata_items(tmp_path)
            sys.stdout.buffer.write(tmp_path.read_bytes())
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    main()
