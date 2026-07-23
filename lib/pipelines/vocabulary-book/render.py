#!/usr/bin/env python3
"""Render Quilo vocabulary JSON as a navigable A4 study workbook PDF."""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from urllib.parse import quote

from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


PAGE_W, PAGE_H = A4
PURPLE = HexColor("#2563EB")
PURPLE_SOFT = HexColor("#EEF4FF")
GOLD = HexColor("#0F6A8A")
INK = HexColor("#172033")
MUTED = HexColor("#667085")
LINE = HexColor("#D8E0EC")
PAPER = HexColor("#FFFFFF")

DESIGNS = {
    "science": {
        "primary": "#2563EB", "soft": "#EEF4FF", "accent": "#0F6A8A",
        "ink": "#172033", "muted": "#667085", "line": "#D8E0EC", "paper": "#FFFFFF",
    },
    "classic": {
        "primary": "#10213F", "soft": "#F7F2E8", "accent": "#9A6B17",
        "ink": "#171B24", "muted": "#69645C", "line": "#D8CFBD", "paper": "#FFFDF7",
    },
    "minimal": {
        "primary": "#111827", "soft": "#FAFAFA", "accent": "#6B7280",
        "ink": "#111827", "muted": "#6B7280", "line": "#D1D5DB", "paper": "#FFFFFF",
    },
}


def apply_design(value: object) -> str:
    """Select a deterministic, server-whitelisted visual design for this render process."""
    global PURPLE, PURPLE_SOFT, GOLD, INK, MUTED, LINE, PAPER
    key = clean(value, 20).lower()
    if key not in DESIGNS:
        key = "science"
    theme = DESIGNS[key]
    PURPLE = HexColor(theme["primary"])
    PURPLE_SOFT = HexColor(theme["soft"])
    GOLD = HexColor(theme["accent"])
    INK = HexColor(theme["ink"])
    MUTED = HexColor(theme["muted"])
    LINE = HexColor(theme["line"])
    PAPER = HexColor(theme["paper"])
    return key


def clean(value: object, limit: int = 1000) -> str:
    text = str(value or "")
    text = text.replace("—", "-").replace("–", "-").replace("―", "-")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def register_fonts(repo_root: Path) -> None:
    font_dir = repo_root / "lib" / "fonts"
    regular = font_dir / "Pretendard-Regular.ttf"
    bold = font_dir / "Pretendard-Bold.ttf"
    if not regular.exists() or not bold.exists():
        raise RuntimeError("Pretendard 글꼴 파일이 없습니다.")
    pdfmetrics.registerFont(TTFont("Pretendard", str(regular)))
    pdfmetrics.registerFont(TTFont("Pretendard-Bold", str(bold)))


def fit_size(text: str, font: str, preferred: float, width: float, minimum: float = 8) -> float:
    size = preferred
    while size > minimum and pdfmetrics.stringWidth(text, font, size) > width:
        size -= 0.5
    return size


def wrap_text(text: str, font: str, size: float, width: float, max_lines: int | None = None) -> list[str]:
    text = clean(text)
    if not text:
        return []
    words = text.split(" ")
    lines: list[str] = []
    current = ""
    for word in words:
        trial = word if not current else f"{current} {word}"
        if pdfmetrics.stringWidth(trial, font, size) <= width:
            current = trial
            continue
        if current:
            lines.append(current)
            current = ""
        if pdfmetrics.stringWidth(word, font, size) <= width:
            current = word
            continue
        piece = ""
        for char in word:
            trial_piece = piece + char
            if piece and pdfmetrics.stringWidth(trial_piece, font, size) > width:
                lines.append(piece)
                piece = char
            else:
                piece = trial_piece
        current = piece
    if current:
        lines.append(current)
    if max_lines and len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and pdfmetrics.stringWidth(last + "...", font, size) > width:
            last = last[:-1]
        lines[-1] = last.rstrip() + "..."
    return lines


def draw_lines(c: canvas.Canvas, lines: list[str], x: float, y: float, font: str, size: float, leading: float, color=None) -> float:
    c.setFillColor(INK if color is None else color)
    c.setFont(font, size)
    for line in lines:
        c.drawString(x, y, line)
        y -= leading
    return y


def safe_dest(prefix: str, value: object) -> str:
    raw = re.sub(r"[^A-Za-z0-9_-]+", "-", clean(value, 120)).strip("-")
    return f"{prefix}-{raw or 'item'}"


class Workbook:
    def __init__(self, data: dict, output: Path):
        self.data = data
        self.output = output
        self.units = list(data.get("chapters") or [])
        self.options = data.get("options") or {}
        self.design_style = apply_design(self.options.get("design_style"))
        self.entries = [entry for unit in self.units for entry in (unit.get("entries") or [])]
        self.c = canvas.Canvas(str(output), pagesize=A4, pageCompression=1)
        self.c.setTitle(clean((data.get("book") or {}).get("title") or data.get("title") or "Vocabulary Book"))
        self.c.setAuthor(clean((data.get("book") or {}).get("author") or "Quilo"))
        self.c.setSubject("Bilingual textbook vocabulary workbook")
        self.contents_pages = max(1, math.ceil(len(self.units) / 16))
        self.index_pages = max(1, math.ceil(len(self.entries) / 42))
        self.unit_pages: dict[int, int] = {}
        self.term_pages: dict[str, int] = {}
        self.term_dests: dict[str, str] = {}
        self._plan_pages()

    def _plan_pages(self) -> None:
        page = 2 + self.contents_pages
        for unit in self.units:
            number = int(unit.get("number") or 0)
            self.unit_pages[number] = page
            page += 1
            entries = list(unit.get("entries") or [])
            for index, entry in enumerate(entries):
                term = clean(entry.get("term"))
                dest = safe_dest(f"term-{number}-{index}", term)
                self.term_dests[f"{number}:{index}"] = dest
                self.term_pages[f"{number}:{index}"] = page + index // 2
            page += max(1, math.ceil(len(entries) / 2))
            if self.options.get("include_review", True):
                page += 1
        self.index_start_page = page
        page += self.index_pages
        self.memo_page = page if self.options.get("include_memo", True) else 0

    def link_dest(self, destination: str, rect: tuple[float, float, float, float]) -> None:
        try:
            self.c.linkRect("", destination, rect, relative=0, thickness=0)
        except Exception:
            pass

    def draw_footer(self, label: str = "VOCABULARY") -> None:
        page = self.c.getPageNumber()
        self.c.setFillColor(PURPLE)
        self.c.setFont("Pretendard-Bold", 9)
        self.c.drawString(48, 27, str(page))
        self.c.setFillColor(MUTED)
        self.c.setFont("Pretendard", 7)
        self.c.drawString(71, 27, clean(label, 80))
        self.c.setFillColor(PURPLE)
        self.c.setFont("Pretendard-Bold", 7)
        self.c.drawRightString(PAGE_W - 88, 27, "CONTENTS")
        self.link_dest("contents", (PAGE_W - 142, 18, PAGE_W - 82, 37))
        self.c.drawRightString(PAGE_W - 48, 27, "INDEX")
        self.link_dest("index", (PAGE_W - 82, 18, PAGE_W - 42, 37))

    def draw_tabs(self, current: int | None = None) -> None:
        if not self.units or len(self.units) > 18 or self.design_style == "minimal":
            return
        x = PAGE_W - 20
        top = PAGE_H - 76
        h = min(28, 610 / max(1, len(self.units)))
        for index, unit in enumerate(self.units):
            number = int(unit.get("number") or index + 1)
            y = top - index * h
            active = current == number
            self.c.setFillColor(PURPLE if active else PURPLE_SOFT)
            if self.design_style == "classic":
                self.c.rect(x, y - h + 1, 20, h - 2, fill=1, stroke=0)
            else:
                self.c.roundRect(x, y - h + 1, 20, h - 2, 4, fill=1, stroke=0)
            self.c.saveState()
            self.c.translate(x + 10, y - h / 2)
            self.c.rotate(90)
            self.c.setFillColor(white if active else MUTED)
            self.c.setFont("Pretendard-Bold", 6.2)
            self.c.drawCentredString(0, -2, f"U{number}")
            self.c.restoreState()
            self.link_dest(f"unit-{number}", (x, y - h + 1, x + 20, y - 1))

    def finish_page(self, label: str = "VOCABULARY", current: int | None = None) -> None:
        self.draw_tabs(current)
        self.draw_footer(label)
        self.c.showPage()

    def cover(self) -> None:
        book = self.data.get("book") or {}
        title = clean(book.get("title") or self.data.get("title") or "TEXTBOOK")
        subtitle = clean(book.get("subtitle") or "VOCABULARY")
        self.c.setFillColor(PAPER)
        self.c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
        self.c.setStrokeColor(INK)
        if self.design_style == "science":
            self.c.setFillColor(PURPLE)
            self.c.rect(0, 0, 24, PAGE_H, stroke=0, fill=1)
            self.c.setLineWidth(1.4)
            self.c.rect(62, 62, PAGE_W - 124, PAGE_H - 124, stroke=1, fill=0)
        elif self.design_style == "classic":
            self.c.setLineWidth(1.2)
            self.c.rect(44, 44, PAGE_W - 88, PAGE_H - 88, stroke=1, fill=0)
            self.c.setStrokeColor(GOLD)
            self.c.rect(52, 52, PAGE_W - 104, PAGE_H - 104, stroke=1, fill=0)
        else:
            self.c.setLineWidth(2.2)
            self.c.line(54, PAGE_H - 76, PAGE_W - 54, PAGE_H - 76)
            self.c.setStrokeColor(LINE)
            self.c.line(54, 76, PAGE_W - 54, 76)
        self.c.setFillColor(INK)
        size = fit_size(title.upper(), "Pretendard-Bold", 30, PAGE_W - 150, 18)
        self.c.setFont("Pretendard-Bold", size)
        self.c.drawCentredString(PAGE_W / 2, PAGE_H / 2 + 42, title.upper())
        self.c.setFillColor(GOLD)
        self.c.setFont("Pretendard", 27)
        self.c.drawCentredString(PAGE_W / 2, PAGE_H / 2 + 2, subtitle.upper())
        self.c.setFillColor(INK)
        self.c.setFont("Pretendard", 9)
        self.c.drawCentredString(PAGE_W / 2, 93, clean(book.get("source_line"), 180))
        self.c.setFillColor(MUTED)
        self.c.setFont("Pretendard", 6.5)
        self.c.drawCentredString(PAGE_W / 2, 76, clean(book.get("publisher_line"), 180))
        self.link_dest("contents", (40, 40, PAGE_W - 40, PAGE_H - 40))
        self.c.showPage()

    def contents(self) -> None:
        for page_index in range(self.contents_pages):
            if page_index == 0:
                self.c.bookmarkPage("contents")
                self.c.addOutlineEntry("Contents", "contents", level=0, closed=False)
            self.c.setFillColor(PURPLE)
            self.c.rect(28, PAGE_H - 38, PAGE_W - 56, 18, stroke=0, fill=1)
            self.c.setFillColor(PURPLE)
            self.c.setFont("Pretendard", 23)
            self.c.drawString(52, PAGE_H - 86, "C O N T E N T S")
            self.c.setFillColor(MUTED)
            self.c.setFont("Pretendard", 7)
            self.c.drawRightString(PAGE_W - 55, PAGE_H - 84, f"{page_index + 1} / {self.contents_pages}")
            y = PAGE_H - 130
            page_units = self.units[page_index * 16 : (page_index + 1) * 16]
            for unit in page_units:
                number = int(unit.get("number") or 0)
                title = f"{clean(unit.get('title_en'), 90)}  {clean(unit.get('title_ko'), 70)}"
                self.c.setFillColor(PURPLE)
                self.c.setFont("Pretendard-Bold", 9)
                self.c.drawString(52, y, str(number))
                self.c.setFillColor(INK)
                self.c.setFont("Pretendard-Bold", 8.5)
                for line in wrap_text(title, "Pretendard-Bold", 8.5, 390, 1):
                    self.c.drawString(89, y, line)
                self.c.setFillColor(GOLD)
                self.c.drawRightString(PAGE_W - 57, y, str(self.unit_pages.get(number, "")))
                self.c.setStrokeColor(LINE)
                self.c.line(52, y - 12, PAGE_W - 57, y - 12)
                self.link_dest(f"unit-{number}", (48, y - 13, PAGE_W - 53, y + 12))
                y -= 34
            self.finish_page("CONTENTS")

    def unit_cover(self, unit: dict) -> None:
        number = int(unit.get("number") or 0)
        self.c.bookmarkPage(f"unit-{number}")
        self.c.addOutlineEntry(
            f"Unit {number}. {clean(unit.get('title_en'), 100)}",
            f"unit-{number}",
            level=0,
            closed=False,
        )
        self.c.setFillColor(MUTED)
        self.c.setFont("Pretendard", 7)
        self.c.drawString(52, PAGE_H - 108, "TEXTBOOK VOCABULARY")
        self.c.setFillColor(PURPLE)
        self.c.setFont("Pretendard", 14)
        self.c.drawString(52, PAGE_H - 137, "U N I T")
        self.c.setFillColor(INK)
        self.c.setFont("Pretendard-Bold", 66)
        self.c.drawString(50, PAGE_H - 225, str(number))
        title_en = clean(unit.get("title_en"), 120)
        size = fit_size(title_en, "Pretendard-Bold", 24, 460, 15)
        self.c.setFont("Pretendard-Bold", size)
        self.c.drawString(52, PAGE_H - 290, title_en)
        self.c.setFillColor(PURPLE)
        self.c.setFont("Pretendard-Bold", 13)
        self.c.drawString(52, PAGE_H - 355, clean(unit.get("title_ko"), 100))
        self.c.setStrokeColor(PURPLE)
        self.c.setLineWidth(1.2)
        self.c.line(52, PAGE_H - 377, 150, PAGE_H - 377)
        entries = list(unit.get("entries") or [])
        counts = {
            "core": sum(1 for entry in entries if entry.get("kind") == "core"),
            "academic": sum(1 for entry in entries if entry.get("kind") == "academic"),
            "phrase": sum(1 for entry in entries if entry.get("kind") == "phrase"),
        }
        rows = [
            ("핵심 용어", "Key Terms", counts["core"]),
            ("학술 어휘", "Academic Vocabulary", counts["academic"]),
            ("문제 구문", "Problem Phrases", counts["phrase"]),
        ]
        y = 175
        for ko, en, count in rows:
            self.c.setFillColor(PURPLE)
            self.c.setFont("Pretendard-Bold", 9)
            self.c.drawString(52, y, ko)
            self.c.setFillColor(MUTED)
            self.c.setFont("Pretendard", 8)
            self.c.drawString(155, y, en)
            self.c.setFillColor(GOLD)
            self.c.setFont("Pretendard-Bold", 8.5)
            self.c.drawRightString(PAGE_W - 58, y, f"{count}개")
            self.c.setStrokeColor(LINE)
            self.c.line(52, y - 14, PAGE_W - 58, y - 14)
            y -= 38
        self.finish_page(f"VOCABULARY · {title_en}", number)

    def entry_block(self, unit: dict, entry: dict, index: int, top: float) -> None:
        number = int(unit.get("number") or 0)
        term = clean(entry.get("term"), 120)
        dest = self.term_dests.get(f"{number}:{index}")
        if dest:
            self.c.bookmarkHorizontalAbsolute(dest, top + 26)
        x, width = 48, PAGE_W - 96
        box_y = top - 88
        self.c.setFillColor(PURPLE_SOFT)
        self.c.setStrokeColor(PURPLE)
        self.c.setLineWidth(0.45)
        if self.design_style == "science":
            self.c.roundRect(x, box_y, width, 82, 6, fill=1, stroke=1)
        elif self.design_style == "classic":
            self.c.rect(x, box_y, width, 82, fill=1, stroke=1)
            self.c.setFillColor(PURPLE)
            self.c.rect(x, box_y + 77, width, 5, fill=1, stroke=0)
        else:
            self.c.setFillColor(PAPER)
            self.c.rect(x, box_y, width, 82, fill=1, stroke=0)
            self.c.setStrokeColor(INK)
            self.c.setLineWidth(1.2)
            self.c.line(x, box_y + 82, x + width, box_y + 82)
            self.c.setStrokeColor(LINE)
            self.c.setLineWidth(0.45)
            self.c.line(x, box_y, x + width, box_y)
        divider = x + (190 if self.design_style == "classic" else 207)
        self.c.setStrokeColor(LINE)
        self.c.line(divider, box_y, divider, box_y + 82)
        term_size = fit_size(term, "Pretendard-Bold", 15.5, 188, 8.5)
        self.c.setFillColor(PURPLE)
        self.c.setFont("Pretendard-Bold", term_size)
        self.c.drawString(x + 11, top - 31, term)
        pos = clean(entry.get("part_of_speech"), 8)
        pronunciation = clean(entry.get("pronunciation"), 120) if self.options.get("include_pronunciation", True) else ""
        self.c.setFillColor(MUTED)
        self.c.setFont("Pretendard", 6.5)
        self.c.drawString(x + 11, top - 54, f"{pos}    {pronunciation}".strip())
        self.c.setFont("Pretendard-Bold", 6.5)
        self.c.setFillColor(PURPLE)
        self.c.drawRightString(divider - 10, top - 66, "듣기")
        url = f"https://youglish.com/pronounce/{quote(term)}/english/us"
        self.c.linkURL(url, (divider - 48, top - 73, divider - 7, top - 55), relative=0, thickness=0)
        self.c.setStrokeColor(PURPLE)
        self.c.rect(divider + 12, top - 39, 6, 6, stroke=1, fill=0)
        definition = f"{clean(entry.get('meaning'), 120)}. {clean(entry.get('definition_ko'), 360)}"
        lines = wrap_text(definition, "Pretendard", 7.1, width - 236, 4)
        draw_lines(self.c, lines, divider + 25, top - 27, "Pretendard", 7.1, 9, INK)

        y = box_y - 17
        examples = list(entry.get("examples") or [])[:2]
        for pair in examples:
            self.c.setFillColor(INK)
            self.c.setFont("Pretendard-Bold", 6.8)
            self.c.drawString(x + 3, y, "예문")
            en_lines = wrap_text(clean(pair.get("en"), 320), "Pretendard", 7.2, width - 40, 2)
            y = draw_lines(self.c, en_lines, x + 35, y, "Pretendard", 7.2, 9, PURPLE)
            self.c.setFillColor(MUTED)
            self.c.setFont("Pretendard-Bold", 6.8)
            self.c.drawString(x + 3, y, "해석")
            ko_lines = wrap_text(clean(pair.get("ko"), 320), "Pretendard", 6.9, width - 40, 2)
            y = draw_lines(self.c, ko_lines, x + 35, y, "Pretendard", 6.9, 8.5, MUTED) - 2
        related = list(entry.get("related") or [])[:2]
        band_y = top - 295
        self.c.setFillColor(PURPLE_SOFT)
        if self.design_style == "science":
            self.c.roundRect(x, band_y, width, 25, 4, fill=1, stroke=0)
        elif self.design_style == "classic":
            self.c.rect(x, band_y, width, 25, fill=1, stroke=0)
        else:
            self.c.setStrokeColor(LINE)
            self.c.line(x, band_y + 24, x + width, band_y + 24)
        self.c.setFillColor(GOLD)
        self.c.setFont("Pretendard-Bold", 6.5)
        self.c.drawString(x + 8, band_y + 9, "파생 · 관련어")
        related_text = "   ".join(f"{clean(item.get('en'), 80)} {clean(item.get('ko'), 60)}" for item in related)
        self.c.setFillColor(MUTED)
        self.c.setFont("Pretendard", fit_size(related_text, "Pretendard", 6.4, width - 100, 5.5))
        self.c.drawString(x + 79, band_y + 9, related_text)
        self.c.setFillColor(MUTED)
        self.c.setFont("Pretendard", 5.8)
        source_label = clean(entry.get("source_label"), 64) or f"출처 {int(entry.get('source_page') or unit.get('page_start') or 0)}"
        self.c.drawRightString(x + width - 8, band_y + 9, source_label)

    def entry_pages(self, unit: dict) -> None:
        number = int(unit.get("number") or 0)
        entries = list(unit.get("entries") or [])
        for page_index in range(max(1, math.ceil(len(entries) / 2))):
            self.c.setStrokeColor(PURPLE)
            self.c.setLineWidth(1.1)
            self.c.line(48, PAGE_H - 58, PAGE_W - 48, PAGE_H - 58)
            self.c.setFillColor(INK)
            self.c.setFont("Pretendard-Bold", 8.5)
            self.c.drawRightString(PAGE_W - 48, PAGE_H - 46, f"{clean(unit.get('title_en'), 80)} · {clean(unit.get('title_ko'), 60)}")
            page_entries = entries[page_index * 2 : page_index * 2 + 2]
            for offset, entry in enumerate(page_entries):
                self.entry_block(unit, entry, page_index * 2 + offset, PAGE_H - 78 - offset * 335)
            self.finish_page(f"VOCABULARY · {clean(unit.get('title_en'), 70)}", number)

    def review(self, unit: dict) -> None:
        number = int(unit.get("number") or 0)
        entries = list(unit.get("entries") or [])[:20]
        self.c.setStrokeColor(PURPLE)
        self.c.setLineWidth(1.2)
        self.c.line(48, PAGE_H - 50, 110, PAGE_H - 50)
        self.c.setFillColor(MUTED)
        self.c.setFont("Pretendard", 6.8)
        self.c.drawString(52, PAGE_H - 78, f"UNIT {number} · {clean(unit.get('title_en'), 80).upper()}")
        self.c.setFillColor(INK)
        self.c.setFont("Pretendard-Bold", 20)
        self.c.drawString(52, PAGE_H - 112, "단원 평가")
        self.c.setFillColor(MUTED)
        self.c.setFont("Pretendard", 10)
        self.c.drawString(150, PAGE_H - 111, "Review Test")
        self.c.drawRightString(PAGE_W - 52, PAGE_H - 111, f"SCORE    / {len(entries)}")
        self.c.setStrokeColor(PURPLE)
        self.c.line(52, PAGE_H - 124, PAGE_W - 52, PAGE_H - 124)
        self.c.setFillColor(PURPLE)
        self.c.roundRect(52, PAGE_H - 158, 16, 16, 3, fill=1, stroke=0)
        self.c.setFillColor(white)
        self.c.setFont("Pretendard-Bold", 8)
        self.c.drawCentredString(60, PAGE_H - 153, "A")
        self.c.setFillColor(INK)
        self.c.setFont("Pretendard-Bold", 9)
        self.c.drawString(78, PAGE_H - 153, "다음 단어의 뜻을 쓰세요.")
        split = math.ceil(len(entries) / 2)
        for col, group in enumerate((entries[:split], entries[split:])):
            x = 52 + col * 248
            y = PAGE_H - 190
            for offset, entry in enumerate(group):
                self.c.setFillColor(GOLD)
                self.c.setFont("Pretendard-Bold", 6.5)
                self.c.drawString(x, y, str(offset + 1 + col * split))
                self.c.setFillColor(PURPLE)
                term = clean(entry.get("term"), 70)
                self.c.setFont("Pretendard", fit_size(term, "Pretendard", 7.2, 128, 5.5))
                self.c.drawString(x + 20, y, term)
                self.c.setStrokeColor(LINE)
                self.c.line(x + 145, y - 1, x + 232, y - 1)
                y -= 29
        y2 = PAGE_H - 520
        self.c.setFillColor(PURPLE)
        self.c.roundRect(52, y2, 16, 16, 3, fill=1, stroke=0)
        self.c.setFillColor(white)
        self.c.setFont("Pretendard-Bold", 8)
        self.c.drawCentredString(60, y2 + 5, "B")
        self.c.setFillColor(INK)
        self.c.setFont("Pretendard-Bold", 9)
        self.c.drawString(78, y2 + 5, "뜻을 보고 영어 표현을 쓰세요.")
        y = y2 - 30
        for index, entry in enumerate(entries[:8]):
            self.c.setFillColor(GOLD)
            self.c.setFont("Pretendard-Bold", 6.5)
            self.c.drawString(52, y, str(index + 1))
            self.c.setFillColor(INK)
            self.c.setFont("Pretendard", 7.2)
            self.c.drawString(75, y, clean(entry.get("meaning"), 90))
            self.c.setStrokeColor(LINE)
            self.c.line(235, y - 1, PAGE_W - 52, y - 1)
            y -= 26
        self.finish_page(f"REVIEW · {clean(unit.get('title_en'), 70)}", number)

    def index(self) -> None:
        indexed = []
        for unit in self.units:
            number = int(unit.get("number") or 0)
            for index, entry in enumerate(unit.get("entries") or []):
                indexed.append((clean(entry.get("term"), 120), clean(entry.get("meaning"), 100), number, index))
        indexed.sort(key=lambda item: item[0].casefold())
        for page_index in range(self.index_pages):
            if page_index == 0:
                self.c.bookmarkPage("index")
                self.c.addOutlineEntry("Index", "index", level=0, closed=False)
            self.c.setFillColor(PURPLE)
            self.c.rect(28, PAGE_H - 38, PAGE_W - 56, 18, stroke=0, fill=1)
            self.c.setFillColor(PURPLE)
            self.c.setFont("Pretendard", 23)
            self.c.drawString(52, PAGE_H - 86, "I N D E X")
            page_items = indexed[page_index * 42 : (page_index + 1) * 42]
            for col in range(2):
                x = 52 + col * 252
                y = PAGE_H - 125
                for term, meaning, number, index in page_items[col * 21 : (col + 1) * 21]:
                    self.c.setFillColor(PURPLE)
                    self.c.setFont("Pretendard-Bold", fit_size(term, "Pretendard-Bold", 7.5, 145, 5.5))
                    self.c.drawString(x, y, term)
                    self.c.setFillColor(MUTED)
                    self.c.setFont("Pretendard", fit_size(meaning, "Pretendard", 6.5, 72, 5.2))
                    self.c.drawString(x + 150, y, meaning)
                    page_no = self.term_pages.get(f"{number}:{index}", self.unit_pages.get(number, ""))
                    self.c.setFillColor(GOLD)
                    self.c.setFont("Pretendard-Bold", 6.5)
                    self.c.drawRightString(x + 232, y, str(page_no))
                    dest = self.term_dests.get(f"{number}:{index}")
                    if dest:
                        self.link_dest(dest, (x - 2, y - 5, x + 234, y + 8))
                    self.c.setStrokeColor(LINE)
                    self.c.line(x, y - 7, x + 232, y - 7)
                    y -= 29
            self.finish_page("INDEX")

    def memo(self) -> None:
        self.c.setFillColor(PURPLE)
        self.c.rect(28, PAGE_H - 38, PAGE_W - 56, 18, stroke=0, fill=1)
        self.c.setFillColor(INK)
        self.c.setFont("Pretendard", 18)
        self.c.drawString(66, PAGE_H - 82, "M E M O")
        self.c.setStrokeColor(PURPLE)
        self.c.setLineWidth(1)
        self.c.line(66, PAGE_H - 98, PAGE_W - 66, PAGE_H - 98)
        self.c.setStrokeColor(LINE)
        y = PAGE_H - 132
        while y > 70:
            self.c.line(66, y, PAGE_W - 66, y)
            y -= 24
        self.finish_page("MEMO")

    def render(self) -> None:
        self.cover()
        self.contents()
        for unit in self.units:
            self.unit_cover(unit)
            self.entry_pages(unit)
            if self.options.get("include_review", True):
                self.review(unit)
        self.index()
        if self.options.get("include_memo", True):
            self.memo()
        self.c.save()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--design", choices=sorted(DESIGNS))
    args = parser.parse_args()
    register_fonts(args.repo_root)
    data = json.loads(args.input.read_text(encoding="utf-8"))
    if args.design:
        data.setdefault("options", {})["design_style"] = args.design
    if not data.get("chapters"):
        raise ValueError("단어장 묶음 데이터가 없습니다.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    Workbook(data, args.output).render()
    print(json.dumps({"ok": True, "output": str(args.output), "bytes": args.output.stat().st_size}, ensure_ascii=False))


if __name__ == "__main__":
    main()
