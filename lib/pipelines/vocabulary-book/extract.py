#!/usr/bin/env python3
"""Extract a bounded, user-selected page range from a textbook PDF."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def parse_page_range(raw: str, page_count: int, max_pages: int) -> list[int]:
    text = (raw or "").strip()
    if not text:
        if page_count > max_pages:
            raise ValueError(
                f"전체 {page_count}쪽입니다. 한 번에 최대 {max_pages}쪽까지 만들 수 있으니 페이지 범위를 입력하세요."
            )
        return list(range(1, page_count + 1))

    selected: set[int] = set()
    for token in re.split(r"\s*,\s*", text):
        if not token:
            continue
        match = re.fullmatch(r"(\d+)\s*(?:-|~|–|—)\s*(\d+)", token)
        if match:
            start, end = int(match.group(1)), int(match.group(2))
            if start > end:
                start, end = end, start
            selected.update(range(start, end + 1))
            continue
        if re.fullmatch(r"\d+", token):
            selected.add(int(token))
            continue
        raise ValueError(f"페이지 범위를 이해하지 못했습니다: {token}")

    invalid = sorted(page for page in selected if page < 1 or page > page_count)
    if invalid:
        preview = ", ".join(str(page) for page in invalid[:5])
        raise ValueError(f"PDF에 없는 페이지가 포함되어 있습니다: {preview} (전체 {page_count}쪽)")
    ordered = sorted(selected)
    if not ordered:
        raise ValueError("선택된 페이지가 없습니다.")
    if len(ordered) > max_pages:
        raise ValueError(f"한 번에 최대 {max_pages}쪽까지 만들 수 있습니다. 현재 {len(ordered)}쪽을 선택했습니다.")
    return ordered


def extract(pdf_path: Path, page_range: str, max_pages: int) -> dict:
    try:
        import fitz
    except Exception as exc:  # pragma: no cover - deployment dependency error
        raise RuntimeError(f"PyMuPDF(fitz)를 불러오지 못했습니다: {exc}") from exc

    doc = fitz.open(str(pdf_path))
    try:
        if doc.needs_pass:
            raise ValueError("암호가 걸린 PDF는 사용할 수 없습니다.")
        page_count = int(doc.page_count)
        if page_count < 1:
            raise ValueError("페이지가 없는 PDF입니다.")
        selected = parse_page_range(page_range, page_count, max_pages)
        pages = []
        for number in selected:
            page = doc.load_page(number - 1)
            text = page.get_text("text", sort=True)
            text = text.replace("\x00", " ")
            text = re.sub(r"[ \t]+", " ", text)
            text = re.sub(r"\n{3,}", "\n\n", text).strip()
            pages.append({"number": number, "text": text})
        metadata = doc.metadata or {}
        return {
            "page_count": page_count,
            "selected_pages": selected,
            "title": str(metadata.get("title") or "").strip(),
            "pages": pages,
        }
    finally:
        doc.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--pages", default="")
    parser.add_argument("--max-pages", type=int, default=80)
    args = parser.parse_args()
    try:
        result = extract(args.pdf, args.pages, max(1, args.max_pages))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(2)
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))


if __name__ == "__main__":
    main()
