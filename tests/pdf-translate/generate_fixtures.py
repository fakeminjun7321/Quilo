#!/usr/bin/env python3
"""Generate the synthetic PDF translation regression corpus.

Generated PDFs intentionally live under tmp/ and are never committed.  All
fixture content is synthetic and dedicated to the public domain (CC0-1.0).
Embedded repository fonts retain their documented upstream open-font licenses.
"""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
from typing import Callable

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, LETTER, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = Path(__file__).with_name("manifest.json")
DEFAULT_OUTPUT = ROOT / "tmp" / "pdfs" / "fixtures"
FONT_REGULAR_PATH = ROOT / "lib" / "fonts" / "Pretendard-Regular.ttf"
FONT_BOLD_PATH = ROOT / "lib" / "fonts" / "Pretendard-Bold.ttf"
FONT_MATH_PATH = ROOT / "lib" / "fonts" / "NanumGothic-Regular.ttf"
FONT_REGULAR = "FixtureSans"
FONT_BOLD = "FixtureSansBold"
FONT_MATH = "FixtureMath"


def register_fonts() -> None:
    for path in (FONT_REGULAR_PATH, FONT_BOLD_PATH, FONT_MATH_PATH):
        if not path.is_file():
            raise FileNotFoundError(f"required repository font is missing: {path}")
    if FONT_REGULAR not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(FONT_REGULAR, str(FONT_REGULAR_PATH)))
    if FONT_BOLD not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(FONT_BOLD, str(FONT_BOLD_PATH)))
    if FONT_MATH not in pdfmetrics.getRegisteredFontNames():
        # Pretendard intentionally omits several set-theory/operator glyphs.
        # NanumGothic is already repository-owned and covers that range, so the
        # fixture remains portable instead of depending on a system math font.
        pdfmetrics.registerFont(TTFont(FONT_MATH, str(FONT_MATH_PATH)))


def new_canvas(target, pagesize=A4) -> canvas.Canvas:
    c = canvas.Canvas(
        target,
        pagesize=pagesize,
        pageCompression=1,
        invariant=1,
    )
    c.setAuthor("Quilo PDF Translation Regression Corpus")
    c.setCreator("tests/pdf-translate/generate_fixtures.py")
    c.setSubject("Synthetic CC0 fixture content")
    return c


def draw_header(c: canvas.Canvas, width: float, height: float, title: str, marker: str) -> None:
    c.setFillColor(colors.HexColor("#17324d"))
    c.rect(0, height - 72, width, 72, stroke=0, fill=1)
    c.setFillColor(colors.white)
    c.setFont(FONT_BOLD, 17)
    c.drawString(42, height - 42, title)
    c.setFont(FONT_REGULAR, 8.5)
    c.drawRightString(width - 42, height - 42, marker)
    c.setFillColor(colors.black)


def draw_footer(c: canvas.Canvas, width: float, marker: str, page_number: int) -> None:
    c.setStrokeColor(colors.HexColor("#b8c3cc"))
    c.line(42, 34, width - 42, 34)
    c.setFillColor(colors.HexColor("#52606d"))
    c.setFont(FONT_REGULAR, 8)
    c.drawString(42, 21, "Synthetic CC0 regression fixture")
    c.drawRightString(width - 42, 21, f"{marker} | page {page_number}")
    c.setFillColor(colors.black)


def wrap_lines(text: str, font_name: str, size: float, max_width: float) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = word if not current else f"{current} {word}"
        if not current or pdfmetrics.stringWidth(candidate, font_name, size) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def draw_wrapped(
    c: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    width: float,
    *,
    font: str = FONT_REGULAR,
    size: float = 10.5,
    leading: float = 15,
    color=colors.black,
) -> float:
    c.setFont(font, size)
    c.setFillColor(color)
    for line in wrap_lines(text, font, size, width):
        c.drawString(x, y, line)
        y -= leading
    c.setFillColor(colors.black)
    return y


def generate_text_links(path: Path) -> None:
    width, height = A4
    c = new_canvas(str(path), A4)
    c.setTitle("Text, numbers, and links fixture")
    marker = "FIXTURE-TEXT-001"
    c.bookmarkPage("fixture-start")
    c.addOutlineEntry("Fixture start", "fixture-start", level=0, closed=False)
    draw_header(c, width, height, "Measurement transfer note", marker)
    y = height - 104
    y = draw_wrapped(
        c,
        "This born-digital page exercises ordinary paragraph translation while exact values, units, identifiers, and links remain invariant.",
        48,
        y,
        width - 96,
    ) - 12
    c.setFont(FONT_BOLD, 11)
    c.drawString(48, y, "Invariant measurement ledger")
    y -= 23
    for line in (
        "Mass 12.50 g; temperature 298.15 K; speed 3.00 m/s; concentration 0.250 mol/L.",
        "Scientific notation: 6.022e23 mol^-1; uncertainty +/- 0.03 g; sample ID A-17.",
        "Keep every decimal point, sign, slash, exponent marker, and unit exactly associated with its value.",
    ):
        y = draw_wrapped(c, line, 48, y, width - 96, size=10.2, leading=15) - 4
    y -= 8
    c.setFont(FONT_BOLD, 11)
    c.drawString(48, y, "External references")
    y -= 24
    links = (
        "https://example.com/quilo/pdf-fixture?case=text-001",
        "https://doi.org/10.0000/quilo.fixture.001",
    )
    c.setFont(FONT_REGULAR, 9.5)
    for url in links:
        c.setFillColor(colors.HexColor("#075985"))
        c.drawString(48, y, url)
        link_width = pdfmetrics.stringWidth(url, FONT_REGULAR, 9.5)
        c.linkURL(url, (48, y - 2, 48 + link_width, y + 10), relative=0, thickness=0)
        c.setStrokeColor(colors.HexColor("#075985"))
        c.line(48, y - 2, 48 + link_width, y - 2)
        y -= 22
    c.setFillColor(colors.black)
    y -= 8
    y = draw_wrapped(
        c,
        "The translation may reflow prose inside its text box, but it must not drop a sentence, merge unrelated numbers, or alter a target URI. The internal jump below must also survive document reconstruction when that feature is declared supported.",
        48,
        y,
        width - 96,
    ) - 16
    c.setFillColor(colors.HexColor("#166534"))
    c.setFont(FONT_BOLD, 10)
    c.drawString(48, y, "Jump to the fixture heading")
    jump_width = pdfmetrics.stringWidth("Jump to the fixture heading", FONT_BOLD, 10)
    c.linkRect("", "fixture-start", (48, y - 2, 48 + jump_width, y + 11), relative=0, thickness=0)
    c.setFillColor(colors.black)
    draw_footer(c, width, marker, 1)
    c.showPage()
    c.save()


def draw_column_lines(c: canvas.Canvas, page_no: int, x: float, y: float, side: str) -> float:
    c.setFont(FONT_REGULAR, 8.6)
    for i in range(1, 17):
        c.drawString(x, y, f"COLUMN-{side}-P{page_no}-{i:02d} concise source sentence.")
        y -= 15.5
    return y


def draw_ruled_table(c: canvas.Canvas, x: float, y_top: float) -> None:
    widths = (70, 72, 82)
    row_h = 22
    rows = (
        ("Trial", "Time s", "Distance m"),
        ("A", "1.25", "0.125"),
        ("B", "2.50", "0.250"),
        ("C", "3.75", "0.375"),
    )
    total_w = sum(widths)
    total_h = row_h * len(rows)
    c.setStrokeColor(colors.HexColor("#334155"))
    c.setLineWidth(0.7)
    c.setFillColor(colors.HexColor("#dbeafe"))
    c.rect(x, y_top - row_h, total_w, row_h, stroke=0, fill=1)
    c.setFillColor(colors.black)
    for r in range(len(rows) + 1):
        yy = y_top - r * row_h
        c.line(x, yy, x + total_w, yy)
    xx = x
    c.line(xx, y_top, xx, y_top - total_h)
    for width in widths:
        xx += width
        c.line(xx, y_top, xx, y_top - total_h)
    for r, row in enumerate(rows):
        xx = x
        c.setFont(FONT_BOLD if r == 0 else FONT_REGULAR, 8.2)
        for value, width in zip(row, widths):
            c.drawCentredString(xx + width / 2, y_top - r * row_h - 15, value)
            xx += width


def draw_vector_chart(c: canvas.Canvas, x: float, y: float, width: float, height: float) -> None:
    c.setStrokeColor(colors.HexColor("#475569"))
    c.setLineWidth(0.8)
    c.rect(x, y, width, height, stroke=1, fill=0)
    c.line(x + 28, y + 25, x + 28, y + height - 18)
    c.line(x + 28, y + 25, x + width - 15, y + 25)
    for i in range(1, 5):
        xx = x + 28 + i * (width - 48) / 5
        yy = y + 25 + i * (height - 48) / 5
        c.setStrokeColor(colors.HexColor("#cbd5e1"))
        c.line(xx, y + 25, xx, y + height - 18)
        c.line(x + 28, yy, x + width - 15, yy)
    c.setStrokeColor(colors.HexColor("#dc2626"))
    c.setLineWidth(2)
    p = c.beginPath()
    p.moveTo(x + 30, y + 34)
    p.curveTo(x + 75, y + 38, x + 105, y + 96, x + width - 24, y + height - 28)
    c.drawPath(p, stroke=1, fill=0)
    c.setFillColor(colors.HexColor("#dc2626"))
    for px, py in ((x + 48, y + 43), (x + 90, y + 72), (x + 136, y + 111), (x + 180, y + 142)):
        c.circle(px, py, 2.8, stroke=0, fill=1)
    c.setFillColor(colors.black)
    c.setFont(FONT_BOLD, 8)
    c.drawString(x + 35, y + height - 14, "VECTOR-CURVE-V1")


def generate_two_column(path: Path) -> None:
    width, height = A4
    c = new_canvas(str(path), A4)
    c.setTitle("Two-column, table, and vector fixture")
    marker = "FIXTURE-COLUMNS-002"
    for page_no in (1, 2):
        draw_header(c, width, height, "Two-column field record", marker)
        y = height - 98
        c.setStrokeColor(colors.HexColor("#cbd5e1"))
        c.line(width / 2, 86, width / 2, y + 6)
        draw_column_lines(c, page_no, 48, y, "L")
        draw_column_lines(c, page_no, width / 2 + 18, y, "R")
        if page_no == 1:
            draw_ruled_table(c, 48, 452)
            draw_vector_chart(c, width / 2 + 18, 280, 228, 172)
        else:
            c.setFont(FONT_BOLD, 9)
            c.drawString(48, 452, "SECOND-PAGE-COLUMN-CONTINUITY")
            c.setStrokeColor(colors.HexColor("#0f766e"))
            c.setLineWidth(1.2)
            for j in range(8):
                c.line(48 + j * 25, 410 - j * 10, 245 + j * 3, 410 - j * 10)
            c.setFillColor(colors.HexColor("#0f766e"))
            c.circle(410, 365, 58, stroke=1, fill=0)
            c.circle(410, 365, 32, stroke=1, fill=0)
            c.setFillColor(colors.black)
        draw_footer(c, width, marker, page_no)
        c.showPage()
    c.save()


def draw_rich_paragraph(c: canvas.Canvas, markup: str, x: float, y: float, width: float) -> float:
    style = ParagraphStyle(
        "fixture-equation",
        fontName=FONT_REGULAR,
        fontSize=13,
        leading=21,
        textColor=colors.black,
        alignment=TA_LEFT,
    )
    p = Paragraph(markup, style)
    _, height = p.wrap(width, 100)
    p.drawOn(c, x, y - height)
    return y - height


def generate_math_chem(path: Path) -> None:
    width, height = A4
    c = new_canvas(str(path), A4)
    c.setTitle("Math, chemistry, and scripts fixture")
    marker = "FIXTURE-MATH-CHEM-003"
    draw_header(c, width, height, "Equations and chemical notation", marker)
    y = height - 112
    equations = (
        "Energy: E = mc<super>2</super>",
        "Gravity: F = Gm<sub>1</sub>m<sub>2</sub>/r<super>2</super>",
        "Combustion: 2H<sub>2</sub> + O<sub>2</sub> -> 2H<sub>2</sub>O",
        "Acid and ion: H<sub>2</sub>SO<sub>4</sub>, SO<sub>4</sub><super>2-</super>",
        "Equilibrium: CO<sub>2</sub> + H<sub>2</sub>O &lt;=&gt; H<sub>2</sub>CO<sub>3</sub>",
    )
    for equation in equations:
        y = draw_rich_paragraph(c, equation, 56, y, width - 112) - 10
    c.setStrokeColor(colors.HexColor("#94a3b8"))
    c.line(56, y, width - 56, y)
    y -= 27
    c.setFont(FONT_REGULAR, 12)
    c.drawString(56, y, "ΔG = ΔH - TΔS; λ = 2π/k; Ω = V/I; μ = 1.25 × 10^-3")
    y -= 27
    c.setFont(FONT_MATH, 12)
    c.drawString(56, y, "∑ ∫ √ ± × ÷ ≤ ≥ ≠ ≈ ∞ ∂ ∇ · ° → ← ↔ ∝ ∈ ∉ ∪ ∩ ∀ ∃ ∮")
    y -= 38
    c.setFillColor(colors.HexColor("#f8fafc"))
    c.roundRect(52, y - 66, width - 104, 74, 6, stroke=0, fill=1)
    c.setFillColor(colors.black)
    c.setFont(FONT_BOLD, 10)
    c.drawString(66, y - 13, "MATH-CHEM-LEDGER")
    c.setFont(FONT_REGULAR, 9.5)
    c.drawString(66, y - 33, "ASCII invariants: H2SO4 | CO2 | 6.022e23 | E = mc2")
    c.drawString(66, y - 51, "Do not translate variable names, coefficients, charges, or equation numbers.")
    draw_footer(c, width, marker, 1)
    c.showPage()
    c.save()


def generate_mixed_geometry(path: Path) -> None:
    raw = io.BytesIO()
    c = new_canvas(raw, A4)
    pages = (
        (A4, "FIXTURE-GEOMETRY-004-P1", "A4 portrait"),
        (landscape(A4), "FIXTURE-GEOMETRY-004-P2", "A4 landscape"),
        (LETTER, "FIXTURE-GEOMETRY-004-P3", "Letter rotated 90 degrees"),
    )
    for index, (page_size, marker, label) in enumerate(pages, start=1):
        c.setPageSize(page_size)
        width, height = page_size
        draw_header(c, width, height, "Mixed page geometry", marker)
        c.setFont(FONT_BOLD, 20)
        c.drawString(54, height - 135, label)
        c.setFont(FONT_REGULAR, 11)
        c.drawString(54, height - 164, f"Declared media box: {width:.2f} x {height:.2f} pt")
        c.drawString(54, height - 184, "Geometry, page order, and rotation metadata are immutable.")
        c.setStrokeColor(colors.HexColor("#2563eb"))
        c.setLineWidth(3)
        c.rect(54, 82, width - 108, height - 292, stroke=1, fill=0)
        draw_footer(c, width, marker, index)
        c.showPage()
    c.save()
    raw.seek(0)
    reader = PdfReader(raw)
    writer = PdfWriter()
    for index, page in enumerate(reader.pages):
        if index == 2:
            page.rotate(90)
        writer.add_page(page)
    writer.add_metadata(
        {
            "/Title": "Mixed page geometry fixture",
            "/Author": "Quilo PDF Translation Regression Corpus",
        }
    )
    with path.open("wb") as handle:
        writer.write(handle)


def pil_font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT_BOLD_PATH if bold else FONT_REGULAR_PATH), size=size)


def make_scan_image(marker: str, *, hidden_ocr: bool) -> Image.Image:
    width, height = 1240, 1754
    image = Image.new("RGB", (width, height), (244, 242, 234))
    d = ImageDraw.Draw(image)
    navy = (35, 55, 75)
    d.rectangle((0, 0, width, 155), fill=navy)
    d.text((72, 52), "Scanned laboratory record", font=pil_font(44, bold=True), fill="white")
    d.text((72, 108), marker, font=pil_font(22), fill=(214, 225, 235))
    y = 235
    lines = (
        "Calibration record" if hidden_ocr else "Image-only measurement sheet",
        "Sample ID: HIDDEN-OCR-602" if hidden_ocr else "Sample ID: SCAN-501",
        "Pressure: 101.3 kPa",
        "Delivered volume: 84.20 mL",
        "Ambient temperature: 298.15 K",
        "All text on this page is printed into the page image.",
    )
    for index, line in enumerate(lines):
        d.text((90, y), line, font=pil_font(31 if index else 38, bold=index == 0), fill=(30, 34, 39))
        y += 75
    table_x, table_y = 90, 760
    col_widths = (230, 300, 360)
    row_h = 82
    rows = (
        ("Trial", "Time (s)", "Distance (m)"),
        ("A", "1.25", "0.125"),
        ("B", "2.50", "0.250"),
        ("C", "3.75", "0.375"),
    )
    x_positions = [table_x]
    for value in col_widths:
        x_positions.append(x_positions[-1] + value)
    for r in range(len(rows) + 1):
        yy = table_y + r * row_h
        d.line((table_x, yy, x_positions[-1], yy), fill=(55, 65, 75), width=3)
    for xx in x_positions:
        d.line((xx, table_y, xx, table_y + len(rows) * row_h), fill=(55, 65, 75), width=3)
    for r, row in enumerate(rows):
        for col, value in enumerate(row):
            d.text(
                (x_positions[col] + 18, table_y + r * row_h + 22),
                value,
                font=pil_font(25, bold=r == 0),
                fill=(25, 30, 35),
            )
    d.text((90, 1210), "Observer note: preserve values and units exactly.", font=pil_font(29), fill=(30, 34, 39))
    d.rectangle((60, 190, width - 60, height - 90), outline=(120, 115, 100), width=2)
    return image


def image_bytes(image: Image.Image) -> io.BytesIO:
    stream = io.BytesIO()
    image.save(stream, format="JPEG", quality=88, optimize=True, progressive=False)
    stream.seek(0)
    return stream


def generate_scan_only(path: Path) -> None:
    width, height = A4
    c = new_canvas(str(path), A4)
    c.setTitle("Image-only scan fixture")
    image = make_scan_image("FIXTURE-SCAN-ONLY-005", hidden_ocr=False)
    c.drawImage(ImageReader(image_bytes(image)), 0, 0, width=width, height=height, mask="auto")
    c.showPage()
    c.save()


def generate_hidden_ocr(path: Path) -> None:
    width, height = A4
    c = new_canvas(str(path), A4)
    c.setTitle("Hidden OCR text layer fixture")
    image = make_scan_image("FIXTURE-HIDDEN-OCR-006", hidden_ocr=True)
    c.drawImage(ImageReader(image_bytes(image)), 0, 0, width=width, height=height, mask="auto")
    text = c.beginText(43, height - 82)
    text.setFont(FONT_REGULAR, 11)
    text.setLeading(18)
    text.setTextRenderMode(3)
    for line in (
        "Scanned laboratory record",
        "FIXTURE-HIDDEN-OCR-006",
        "Calibration record",
        "Sample ID: HIDDEN-OCR-602",
        "Pressure: 101.3 kPa",
        "Delivered volume: 84.20 mL",
        "Ambient temperature: 298.15 K",
        "All text on this page is printed into the page image.",
        "Trial Time (s) Distance (m)",
        "A 1.25 0.125",
        "B 2.50 0.250",
        "C 3.75 0.375",
        "Observer note: preserve values and units exactly.",
    ):
        text.textLine(line)
    c.drawText(text)
    c.showPage()
    c.save()


def generate_korean(path: Path) -> None:
    width, height = A4
    c = new_canvas(str(path), A4)
    c.setTitle("Already Korean fixture")
    marker = "FIXTURE-KOREAN-007"
    draw_header(c, width, height, "한국어 실험 기록", marker)
    y = height - 118
    c.setFont(FONT_BOLD, 15)
    c.drawString(52, y, "이미 한국어로 작성된 문서입니다.")
    y -= 34
    paragraphs = (
        "이 문장은 번역 과정에서 의미와 문장 부호를 그대로 유지해야 합니다. 이미 한국어인 문장을 영어로 바꾸거나 삭제하면 안 됩니다.",
        "측정값은 질량 15.20 g, 온도 298.15 K이며 시료 번호 KO-77을 사용했습니다.",
        "표제, 본문, 단위, 식별자와 페이지 순서를 모두 보존합니다.",
    )
    for paragraph in paragraphs:
        y = draw_wrapped(c, paragraph, 52, y, width - 104, size=11, leading=19) - 15
    c.setFillColor(colors.HexColor("#eef6ff"))
    c.roundRect(52, y - 90, width - 104, 96, 8, stroke=0, fill=1)
    c.setFillColor(colors.black)
    c.setFont(FONT_BOLD, 10.5)
    c.drawString(68, y - 24, "불변값 확인")
    c.setFont(FONT_REGULAR, 10)
    c.drawString(68, y - 48, "질량 15.20 g | 온도 298.15 K | 시료 번호 KO-77")
    draw_footer(c, width, marker, 1)
    c.showPage()
    c.save()


def generate_encrypted(path: Path) -> None:
    raw = io.BytesIO()
    width, height = A4
    c = new_canvas(raw, A4)
    marker = "FIXTURE-ENCRYPTED-008"
    draw_header(c, width, height, "Password-protected input", marker)
    c.setFont(FONT_REGULAR, 12)
    c.drawString(54, height - 135, "The pipeline must reject this file until a password is explicitly supplied.")
    draw_footer(c, width, marker, 1)
    c.showPage()
    c.save()
    raw.seek(0)
    reader = PdfReader(raw)
    writer = PdfWriter()
    writer.append_pages_from_reader(reader)
    writer.add_metadata({"/Title": "Password-protected regression fixture"})
    writer.encrypt(
        user_password="fixture-password",
        owner_password="fixture-owner",
        algorithm="AES-256",
    )
    with path.open("wb") as handle:
        writer.write(handle)


def generate_truncated(path: Path) -> None:
    path.write_bytes(
        b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
        b"2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\n"
    )


def generate_not_pdf(path: Path) -> None:
    path.write_text(
        "FIXTURE-NOT-PDF-010\nThis is deliberately plain UTF-8 text, not a PDF container.\n",
        encoding="utf-8",
    )


GENERATORS: dict[str, Callable[[Path], None]] = {
    "text-links-001": generate_text_links,
    "two-column-table-vector-002": generate_two_column,
    "math-chem-003": generate_math_chem,
    "mixed-geometry-004": generate_mixed_geometry,
    "scan-only-005": generate_scan_only,
    "hidden-ocr-006": generate_hidden_ocr,
    "already-korean-007": generate_korean,
    "password-protected-008": generate_encrypted,
    "truncated-pdf-009": generate_truncated,
    "not-pdf-010": generate_not_pdf,
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--manifest", type=Path, default=MANIFEST_PATH)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    fixtures = manifest.get("fixtures", [])
    manifest_ids = {item["id"] for item in fixtures}
    if manifest_ids != set(GENERATORS):
        missing = sorted(manifest_ids - set(GENERATORS))
        extra = sorted(set(GENERATORS) - manifest_ids)
        raise RuntimeError(f"manifest/generator mismatch: missing={missing}, extra={extra}")
    register_fonts()
    args.output.mkdir(parents=True, exist_ok=True)
    expected_names = {item["filename"] for item in fixtures}
    for old in args.output.iterdir():
        if old.is_file() and old.name not in expected_names:
            old.unlink()
    for item in fixtures:
        target = args.output / item["filename"]
        GENERATORS[item["id"]](target)
        try:
            display = target.resolve().relative_to(ROOT)
        except ValueError:
            display = target.resolve()
        print(f"generated {display} ({target.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
