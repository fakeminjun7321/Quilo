#!/usr/bin/env python3
"""phys-inquiry HWPX generator — 일반물리학 탐구 및 사고 과정 성찰 보고서.

실험 결과보고서가 아니라 사고 과정 성찰 보고서다. 차트·사진 임베드가 없고
본문(단락·수식·소제목·표 블록) 위주로 다음 구조를 만든다.

  (제목) 일반물리학 탐구 및 사고 과정 성찰 보고서
  I. 문제 상황 설정
  II. 사고 과정 및 문제 해결
  III. 물리적 해석 및 성찰
  IV. 참고문헌

문단/제목/표/수식 헬퍼와 한컴 수식 후처리는 phys-result/hwpx-gen.py(그리고 그것이
재사용하는 chem-pre/hwpx-gen.py)의 공통 헬퍼를 그대로 import 해서 쓴다.
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
TEMPLATE_HWPX = HERE / "templates" / "inquiry-template.hwpx"

# phys-result 모듈을 통째로 로드 — 그 안에서 chem-pre(pre) 도 함께 로드된다.
_spec = importlib.util.spec_from_file_location("phys_result_hwpx_gen", PHYS_HWPX)
phys = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(phys)

pre = phys.pre  # chem-pre/hwpx-gen.py 공통 헬퍼
HwpxDocument = phys.HwpxDocument

ROMAN = ["I", "II", "III", "IV", "V", "VI"]


# ── 입력 정규화 ────────────────────────────────────────────────────────────────

def as_blocks(value):
    """문자열이든 리스트든 블록 리스트로 통일."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def as_dict(value):
    return value if isinstance(value, dict) else {}


# ── 블록 렌더링 ────────────────────────────────────────────────────────────────

def render_blocks(doc, target, blocks, *, indent_left=pre.INDENT_5MM):
    """블록 배열을 본문으로 렌더한다.

    블록 종류:
      - str                         → 단락
      - {"subheading": "..."}       → 굵은 소제목
      - {"equation": "..."}         → 가운데 정렬 수식 한 줄 ({{EQ:...}} 로 감싸 후처리)
      - {"table": {headers,rows}}   → 표
    """
    for blk in as_blocks(blocks):
        if isinstance(blk, str):
            if blk.strip():
                phys.add_para_to(
                    doc, target, blk,
                    indent_left=indent_left, space_after=pre.SPACE_BODY,
                )
            continue
        if not isinstance(blk, dict):
            continue
        if blk.get("subheading"):
            phys.add_para_to(
                doc, target, str(blk["subheading"]),
                base_size=pre.SIZE_BODY, bold=True,
                indent_left=indent_left,
                space_before=200, space_after=pre.SPACE_BODY,
            )
        elif blk.get("equation"):
            eq = str(blk["equation"]).strip()
            if eq:
                if "{{EQ" not in eq:
                    # LaTeX(백슬래시 명령 포함)면 EQ-LATEX — hwip 엔진이 한컴
                    # 수식으로 정확 변환. 그 외는 종전대로 EQ(직접 스크립트).
                    kind = "EQ-LATEX" if "\\" in eq else "EQ"
                    eq = "{{" + kind + ":" + eq + "}}"
                phys.add_para_to(
                    doc, target, eq, align="CENTER", space_after=pre.SPACE_BODY,
                )
        elif isinstance(blk.get("table"), dict):
            t = blk["table"]
            headers = t.get("headers") or []
            rows = t.get("rows") or []
            if headers:
                phys.add_table(
                    doc, headers, rows,
                    caption=t.get("caption") or None, target=doc,
                )


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


# ── 문서 빌드 ─────────────────────────────────────────────────────────────────

def build_title(doc, content):
    title = content.get("title") or "일반물리학 탐구 및 사고 과정 성찰 보고서"
    phys.add_para_to(
        doc, doc, title,
        base_size=pre.SIZE_TITLE_BIG, bold=True, align="CENTER",
        space_after=200,
    )
    topic = (content.get("topic_title") or "").strip()
    if topic:
        phys.add_para_to(
            doc, doc, topic,
            base_size=pre.SIZE_BODY, align="CENTER", space_after=200,
        )
    sid = str(content.get("student_id") or "").strip()
    sname = str(content.get("student_name") or "").strip()
    who = (sid + " " + sname).strip()
    if who:
        phys.add_para_to(
            doc, doc, who,
            base_size=pre.SIZE_BODY, align="CENTER",
            space_after=pre.SPACE_HEADING_LV1,
        )


def build_problem_setup(doc, content):
    section_heading(doc, ROMAN[0], "문제 상황 설정")
    ps = as_dict(content.get("problem_setup"))
    sub_heading(doc, "1", "선택한 물리적 주제 / 상황")
    render_blocks(doc, doc, ps.get("topic_situation"))
    sub_heading(doc, "2", "탐구 배경 및 필요성")
    render_blocks(doc, doc, ps.get("background"))


def build_thinking_process(doc, content):
    section_heading(doc, ROMAN[1], "사고 과정 및 문제 해결")
    tp = as_dict(content.get("thinking_process"))
    sub_heading(doc, "1", "초기 접근")
    render_blocks(doc, doc, tp.get("initial_approach"))
    sub_heading(doc, "2", "오류 인식")
    render_blocks(doc, doc, tp.get("error_recognition"))
    sub_heading(doc, "3", "새로운 관점의 접근 및 최종 해결")
    render_blocks(doc, doc, tp.get("resolution"))

    da = tp.get("detailed_analysis")
    if isinstance(da, dict):
        body = da.get("body")
        if body:
            da_title = (da.get("title") or "세부 분석 내용").strip()
            phys.add_heading_to(
                doc, doc, f"3.1 {da_title}",
                size=pre.SIZE_BODY,
                space_before=pre.SPACE_BODY, space_after=pre.SPACE_BODY,
            )
            render_blocks(doc, doc, body, indent_left=pre.INDENT_10MM)
    elif isinstance(da, list) and da:
        phys.add_heading_to(
            doc, doc, "3.1 세부 분석 내용",
            size=pre.SIZE_BODY,
            space_before=pre.SPACE_BODY, space_after=pre.SPACE_BODY,
        )
        render_blocks(doc, doc, da, indent_left=pre.INDENT_10MM)


def build_interpretation(doc, content):
    section_heading(doc, ROMAN[2], "물리적 해석 및 성찰")
    it = as_dict(content.get("interpretation"))
    sub_heading(doc, "1", "결과의 물리적 의미 해석")
    render_blocks(doc, doc, it.get("physical_meaning"))
    sub_heading(doc, "2", "초기 오개념에 대한 성찰 및 일반화된 해석")
    render_blocks(doc, doc, it.get("reflection"))


def build_references(doc, content):
    refs = content.get("references")
    if not isinstance(refs, list) or not refs:
        return
    section_heading(doc, ROMAN[3], "참고문헌")
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


# ── 학교 양식(HWPX 템플릿) 채우기 ─────────────────────────────────────────────
# templates/inquiry-template.hwpx 의 헤딩·번호·글꼴·레이아웃은 그대로 두고,
# 각 안내문("...기술하십시오.") 자리만 생성 내용으로 바꾼다.

def load_template_doc():
    if TEMPLATE_HWPX.exists():
        try:
            return HwpxDocument.open(str(TEMPLATE_HWPX))
        except Exception:
            return None
    return None


def _el_text(el):
    return "".join(t.text or "" for t in el.iter(f"{pre.NS_HP}t")).strip()


def _section_paras(sec_el):
    return [el for el in sec_el if el.tag == f"{pre.NS_HP}p"]


def _find_para(sec_el, needle):
    for el in _section_paras(sec_el):
        if needle in _el_text(el):
            return el
    return None


def _set_para_text(el, text):
    ts = list(el.iter(f"{pre.NS_HP}t"))
    if not ts:
        return
    ts[0].text = text
    for extra in ts[1:]:
        extra.text = ""


def _insert_after(anchor_el, new_els):
    for el in reversed(new_els):
        parent = el.getparent()
        if parent is not None:
            parent.remove(el)
        anchor_el.addnext(el)


def _build_and_move(doc, sec_el, anchor_el, build_fn):
    """build_fn 이 문서 끝에 붙인 요소들(문단·표)을 anchor 바로 뒤로 옮긴다."""
    mark = len(list(sec_el))
    build_fn()
    new_els = list(sec_el)[mark:]
    _insert_after(anchor_el, new_els)
    return new_els


# 양식의 안내문(placeholder). 본문 채운 뒤 이 문단들은 제거한다.
TEMPLATE_PLACEHOLDER_HINTS = [
    "기술하십시오", "서술하십시오", "정리하십시오",
    "저자, 「도서/논문명」",
]


def fill_template(doc, content):
    sec = doc.oxml.sections[0]
    sec_el = sec.element

    # 1) 학번 이름 줄
    sid = str(content.get("student_id") or "").strip()
    sname = str(content.get("student_name") or "").strip()
    who = (sid + " " + sname).strip()
    for el in _section_paras(sec_el):
        if _el_text(el) in ("학번 이름", "학번이름"):
            if who:
                _set_para_text(el, who)
            break

    ps = as_dict(content.get("problem_setup"))
    tp = as_dict(content.get("thinking_process"))
    it = as_dict(content.get("interpretation"))

    # 2) 각 헤딩 뒤에 생성 본문 삽입
    fills = [
        ("1. 선택한 물리적 주제", ps.get("topic_situation")),
        ("2. 탐구 배경 및 필요성", ps.get("background")),
        ("1. 초기 접근", tp.get("initial_approach")),
        ("2. 오류 인식", tp.get("error_recognition")),
        ("3. 새로운 관점의 접근", tp.get("resolution")),
        ("1. 결과의 물리적 의미 해석", it.get("physical_meaning")),
        ("2. 초기 오개념에 대한 성찰", it.get("reflection")),
    ]
    for needle, blocks in fills:
        anchor = _find_para(sec_el, needle)
        if anchor is None or not as_blocks(blocks):
            continue
        _build_and_move(doc, sec_el, anchor, lambda b=blocks: render_blocks(doc, doc, b))

    # 3) 3.1.1 수식적 도출 — detailed_analysis. 내용 없으면 3.1/3.1.1 헤딩째 제거.
    da = tp.get("detailed_analysis")
    da_body = None
    if isinstance(da, dict):
        da_body = da.get("body")
    elif isinstance(da, list):
        da_body = da
    da_anchor = _find_para(sec_el, "3.1.1 수식적 도출")
    if da_anchor is not None:
        if as_blocks(da_body):
            _build_and_move(
                doc, sec_el, da_anchor,
                lambda: render_blocks(doc, doc, da_body, indent_left=pre.INDENT_10MM),
            )
        else:
            for needle in ("3.1.1 수식적 도출", "3.1 세부 분석 내용"):
                el = _find_para(sec_el, needle)
                if el is not None:
                    sec_el.remove(el)

    # 4) IV. 참고문헌
    refs = content.get("references")
    ref_anchor = _find_para(sec_el, "IV. 참고문헌")
    if ref_anchor is not None and isinstance(refs, list) and refs:
        def build_refs():
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
        _build_and_move(doc, sec_el, ref_anchor, build_refs)

    # 5) 양식 안내문(placeholder) + '(2)' 스텁 제거
    for el in list(_section_paras(sec_el)):
        t = _el_text(el)
        if any(h in t for h in TEMPLATE_PLACEHOLDER_HINTS) or t == "(2)":
            sec_el.remove(el)

    # 6) 양식 끝의 빈 문단 제거 — 템플릿 꼬리의 빈 문단들이 번호 목록 스타일을
    #    달고 있어 출력물에 "1. 2. 3." 빈 번호로 노출되던 문제.
    paras = _section_paras(sec_el)
    for el in reversed(paras):
        if _el_text(el):
            break
        sec_el.remove(el)

    if hasattr(sec, "mark_dirty"):
        sec.mark_dirty()


def generate_hwpx(content):
    doc = load_template_doc()
    if doc is not None:
        # 학교 양식 기반: 양식 헤딩·번호·레이아웃 유지, 본문만 채움
        doc._v5_allow_highlights = bool(content.get("__allowHighlights", True))
        pre.apply_body_font(doc, pre.resolve_font_face(content))
        fill_template(doc, content)
        return doc

    # 템플릿이 없으면 기존 방식대로 새 문서 생성 (graceful fallback)
    doc = HwpxDocument.new()
    doc._v5_allow_highlights = bool(content.get("__allowHighlights", True))
    phys.apply_phys_page_layout(doc)
    pre.apply_default_font(
        doc,
        pre.resolve_font_face(content),
    )
    build_title(doc, content)
    build_problem_setup(doc, content)
    build_thinking_process(doc, content)
    build_interpretation(doc, content)
    build_references(doc, content)
    return doc


# ── 미리보기 텍스트 ────────────────────────────────────────────────────────────

# math-inquiry 버전과 동기화 — {{EQ-LATEX:...}} 마커도 벗긴다(미지원이면
# 미리보기(PrvText)에 raw 마커 문법이 그대로 노출된다).
_EQ_MARKER_RE = __import__("re").compile(
    r"\{\{EQN?(?:-LATEX)?:\s*(.*?)\}\}", __import__("re").S
)


def _clean_preview(text):
    """미리보기(PrvText)용으로 수식·인라인 마커를 읽기 좋게 정리한다."""
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
    lines = [content.get("title") or "일반물리학 탐구 및 사고 과정 성찰 보고서"]
    if content.get("topic_title"):
        lines.append(str(content["topic_title"]))
    lines.append("")
    ps = as_dict(content.get("problem_setup"))
    lines.append("I. 문제 상황 설정")
    lines += _flatten_blocks(ps.get("topic_situation"))
    lines += _flatten_blocks(ps.get("background"))
    tp = as_dict(content.get("thinking_process"))
    lines.append("II. 사고 과정 및 문제 해결")
    lines += _flatten_blocks(tp.get("initial_approach"))
    lines += _flatten_blocks(tp.get("error_recognition"))
    lines += _flatten_blocks(tp.get("resolution"))
    it = as_dict(content.get("interpretation"))
    lines.append("III. 물리적 해석 및 성찰")
    lines += _flatten_blocks(it.get("physical_meaning"))
    lines += _flatten_blocks(it.get("reflection"))
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
