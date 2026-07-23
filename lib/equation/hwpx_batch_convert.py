#!/usr/bin/env python3
"""Convert LaTeX spans and Quilo equation markers in an existing HWPX."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import tempfile
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

import hwpx_equation_tool as equation_tool


HP_NS = "http://www.hancom.co.kr/hwpml/2011/paragraph"
TEXT_TAG = f"{{{HP_NS}}}t"
SECTION_RE = re.compile(r"^Contents/section\d+\.xml$")


def _escaped(text: str, index: int) -> bool:
    count = 0
    cursor = index - 1
    while cursor >= 0 and text[cursor] == "\\":
        count += 1
        cursor -= 1
    return count % 2 == 1


def _single_dollar_formula(body: str) -> bool:
    value = body.strip()
    if not value or re.fullmatch(r"\d[\d,]*(?:\.\d+)?", value):
        return False
    return bool(
        re.search(r"\\[A-Za-z]+|[_^{}=<>+\-*/|]", value)
        or re.search(r"[A-Za-z]\d|\d[A-Za-z]", value)
        or re.fullmatch(r"[A-Za-z]{1,3}(?:['′’]+)?", value)
    )


def find_latex_spans(text: str) -> list[tuple[int, int, str]]:
    spans: list[tuple[int, int, str]] = []
    cursor = 0
    while cursor < len(text):
        pairs = (("$$", "$$"), ("\\[", "\\]"), ("\\(", "\\)"))
        matched = False
        for opening, closing in pairs:
            if text.startswith(opening, cursor) and not _escaped(text, cursor):
                end = text.find(closing, cursor + len(opening))
                if end >= 0:
                    body = text[cursor + len(opening):end]
                    if body.strip():
                        spans.append((cursor, end + len(closing), body))
                        cursor = end + len(closing)
                        matched = True
                        break
        if matched:
            continue
        if text[cursor] == "$" and not _escaped(text, cursor):
            if cursor + 1 < len(text) and text[cursor + 1] == "$":
                cursor += 2
                continue
            end = cursor + 1
            while True:
                end = text.find("$", end)
                if end < 0:
                    break
                if not _escaped(text, end) and not (end + 1 < len(text) and text[end + 1] == "$"):
                    break
                end += 1
            if end >= 0:
                body = text[cursor + 1:end]
                if _single_dollar_formula(body):
                    spans.append((cursor, end + 1, body))
                    cursor = end + 1
                    continue
        cursor += 1
    return spans


def wrap_latex_spans(text: str) -> tuple[str, int]:
    if "{{EQ" in text.upper():
        return text, 0
    spans = find_latex_spans(text)
    if not spans:
        return text, 0
    parts: list[str] = []
    cursor = 0
    for start, end, body in spans:
        parts.append(text[cursor:start])
        parts.append("{{EQ-LATEX:" + body.strip() + "}}")
        cursor = end
    parts.append(text[cursor:])
    return "".join(parts), len(spans)


def _write_zip(source: zipfile.ZipFile, output: Path, updates: dict[str, bytes]) -> None:
    with zipfile.ZipFile(output, "w") as target:
        for info in source.infolist():
            data = updates.get(info.filename, source.read(info.filename))
            clone = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            clone.compress_type = zipfile.ZIP_STORED if info.filename == "mimetype" else info.compress_type
            clone.external_attr = info.external_attr
            clone.comment = info.comment
            clone.extra = info.extra
            clone.create_system = info.create_system
            target.writestr(clone, data)


def mark_latex_in_hwpx(source_path: Path, output_path: Path) -> tuple[int, int]:
    updates: dict[str, bytes] = {}
    detected = 0
    changed = 0
    with zipfile.ZipFile(source_path, "r") as source:
        names = {info.filename for info in source.infolist()}
        sections = sorted(name for name in names if SECTION_RE.match(name))
        if not sections:
            raise RuntimeError("Contents/section*.xml을 찾지 못했습니다.")
        for name in sections:
            raw = source.read(name)
            equation_tool.register_namespaces_from_xml(raw)
            root = ET.fromstring(raw)
            section_count = 0
            for node in root.iter(TEXT_TAG):
                if not node.text:
                    continue
                node.text, count = wrap_latex_spans(node.text)
                section_count += count
            if section_count:
                updates[name] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
                detected += section_count
                changed += 1
        _write_zip(source, output_path, updates)
    return detected, changed


def convert(input_path: Path, output_path: Path, mode: str) -> dict[str, int]:
    detected = 0
    changed = 0
    with tempfile.TemporaryDirectory(prefix="quilo-hwpx-mark-") as temp:
        marked = Path(temp) / "marked.hwpx"
        if mode in {"all", "latex"}:
            detected, changed = mark_latex_in_hwpx(input_path, marked)
        else:
            shutil.copyfile(input_path, marked)
        equations = equation_tool.replace_equation_placeholders(marked, output_path)
    issues = equation_tool.validate_hwpx_equations(output_path)
    if issues:
        raise RuntimeError("; ".join(issues[:8]))
    return {"detected": detected, "equations": equations, "sections_changed": changed}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_hwpx", type=Path)
    parser.add_argument("output_hwpx", type=Path)
    parser.add_argument("--mode", choices=("all", "latex", "placeholders"), default="all")
    args = parser.parse_args()
    result = convert(args.input_hwpx, args.output_hwpx, args.mode)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
