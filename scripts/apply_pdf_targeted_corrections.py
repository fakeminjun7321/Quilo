#!/usr/bin/env python3
"""Fail-closed, source-bound final PDF correction publisher.

This is deliberately a one-artifact patcher.  It does not touch translation
parts, caches, or the shared PDF engine.  Every mutable region, outline title,
and optional content-stream cleanup is bound to the current artifact by hashes
before any output is written.
"""

from __future__ import annotations

import argparse
import collections
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import unicodedata

import fitz


MIN_FONT_PT = 8.0
RECT_TOLERANCE = 0.25
PRETENDARD = Path(__file__).resolve().parents[1] / "lib/fonts/Pretendard-Regular.ttf"
PRETENDARD_BOLD = Path(__file__).resolve().parents[1] / "lib/fonts/Pretendard-Bold.ttf"
STIX_MATH = Path(__file__).resolve().parents[1] / "lib/fonts/STIXTwoMath.otf"
SYSTEM_Y_FALLBACK = Path("/System/Library/Fonts/HelveticaNeue.ttc")
SYSTEM_CANADIAN_FALLBACK = Path(
    "/System/Library/Fonts/Supplemental/NotoSansCanadianAboriginal-Regular.otf"
)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", str(value))).strip()


def text_hash(value: str) -> str:
    return sha256_bytes(normalized_text(value).encode("utf-8"))


def decode_joiner(value: str) -> str:
    return "\n" if value == r"\n" else str(value)


_SCRIPT_TO_BASE = str.maketrans({
    "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5",
    "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "−", "⁺": "+",
    "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5",
    "₆": "6", "₇": "7", "₈": "8", "₉": "9", "ᐟ": "/",
})


def invariant_present(token: str, text: str) -> bool:
    token = str(token)
    if token in text:
        return True
    canonical_token = re.sub(r"\s+", "", token.translate(_SCRIPT_TO_BASE))
    canonical_text = re.sub(r"\s+", "", text.translate(_SCRIPT_TO_BASE))
    if canonical_token and canonical_token in canonical_text:
        return True
    # The reviewed Korean target spells the count in "두 해" rather than using
    # an Arabic digit.  Bind this exception to that exact semantic phrase.
    return token == "2" and "두 해" in text


def finite_rect(value, label: str) -> fitz.Rect:
    if not isinstance(value, list) or len(value) != 4:
        raise ValueError(f"{label} must contain four coordinates")
    numbers = [float(item) for item in value]
    if not all(math.isfinite(item) for item in numbers):
        raise ValueError(f"{label} contains a non-finite coordinate")
    rect = fitz.Rect(numbers)
    if rect.is_empty or rect.width <= 0 or rect.height <= 0:
        raise ValueError(f"{label} is empty")
    return rect


def rect_close(left: fitz.Rect, right: fitz.Rect, tolerance=RECT_TOLERANCE) -> bool:
    return all(abs(float(a) - float(b)) <= tolerance for a, b in zip(left, right))


def page_blocks(page: fitz.Page):
    for block in page.get_text("dict").get("blocks", []):
        if int(block.get("type", -1)) != 0:
            continue
        text = "\n".join(
            "".join(str(span.get("text", "")) for span in line.get("spans", []))
            for line in block.get("lines", [])
        )
        if text:
            yield block, text


def bind_region(page: fitz.Page, raw: dict, label: str) -> dict:
    rect = finite_rect(raw.get("bbox"), f"{label}.bbox")
    expected_text = str(raw.get("text", ""))
    expected_hash = str(raw.get("text_sha256", ""))
    if text_hash(expected_text) != expected_hash:
        raise ValueError(f"{label} manifest text hash mismatch")
    matches = [
        (block, text)
        for block, text in page_blocks(page)
        if rect_close(fitz.Rect(block.get("bbox")), rect)
        and text_hash(text) == expected_hash
    ]
    if len(matches) != 1:
        raise RuntimeError(f"{label} matched {len(matches)} current blocks instead of one")
    block, current = matches[0]
    span_rects = [
        fitz.Rect(span["bbox"])
        for line in block.get("lines", [])
        for span in line.get("spans", [])
        if str(span.get("text", "")).strip()
    ]
    if not span_rects:
        raise RuntimeError(f"{label} has no visible source spans")
    # Some producers split one visual formula across a normal text block and a
    # second, fully-contained math block.  The manifest rectangle owns both; add
    # only blocks wholly contained in it.  Merely overlapping table rows are not
    # included, which prevents a tall symbol bbox from erasing the next row.
    for other, _other_text in page_blocks(page):
        other_rect = fitz.Rect(other.get("bbox"))
        contained = all(
            rect[index] - RECT_TOLERANCE <= other_rect[index]
            <= rect[index + 2] + RECT_TOLERANCE
            for index in (0, 1)
        ) and all(
            other_rect[index] <= rect[index] + RECT_TOLERANCE
            for index in (2, 3)
        )
        if not contained:
            continue
        span_rects.extend(
            fitz.Rect(span["bbox"])
            for line in other.get("lines", [])
            for span in line.get("spans", [])
            if str(span.get("text", "")).strip()
        )
    unique = {}
    for span_rect in span_rects:
        unique[tuple(round(float(value), 4) for value in span_rect)] = span_rect
    span_rects = list(unique.values())
    return {"rect": rect, "redaction_rects": span_rects, "block": block, "text": current}


def contained_text_span_rects(page: fitz.Page, owner: fitz.Rect) -> list[fitz.Rect]:
    values = []
    for block, _text in page_blocks(page):
        block_rect = fitz.Rect(block.get("bbox"))
        if not (
            block_rect.x0 >= owner.x0 - RECT_TOLERANCE
            and block_rect.y0 >= owner.y0 - RECT_TOLERANCE
            and block_rect.x1 <= owner.x1 + RECT_TOLERANCE
            and block_rect.y1 <= owner.y1 + RECT_TOLERANCE
        ):
            continue
        values.extend(
            fitz.Rect(span["bbox"])
            for line in block.get("lines", [])
            for span in line.get("spans", [])
            if str(span.get("text", "")).strip()
        )
    return values


def validate_file_binding(root: Path, raw: dict, label: str) -> Path:
    path = root / str(raw.get("path", ""))
    if not path.is_file() or path.is_symlink():
        raise RuntimeError(f"{label} is not a regular file: {path}")
    actual = sha256_file(path)
    if actual != raw.get("sha256"):
        raise RuntimeError(f"{label} SHA-256 mismatch: {actual}")
    return path


def destination_semantics(detail: dict) -> dict:
    to = detail.get("to")
    return {
        "kind": int(detail.get("kind", 0)),
        "page_index": int(detail.get("page", -1)),
        "view": "XYZ",
        "left": round(float(to.x), 6) if to is not None else None,
        "top": round(float(to.y), 6) if to is not None else None,
        "zoom": round(float(detail.get("zoom", 0.0) or 0.0), 6),
    }


def manifest_destination(raw: dict) -> dict:
    return {
        "kind": fitz.LINK_GOTO if raw.get("kind") == "GoTo" else int(raw.get("kind", 0)),
        "page_index": int(raw.get("page_index", -1)),
        "view": str(raw.get("view", "XYZ")),
        "left": round(float(raw.get("left")), 6),
        "top": round(float(raw.get("top")), 6),
        "zoom": round(float(raw.get("zoom", 0.0) or 0.0), 6),
    }


def point_value(value):
    if value is None:
        return None
    if hasattr(value, "x"):
        return [round(float(value.x), 6), round(float(value.y), 6)]
    if isinstance(value, (tuple, list)):
        return [round(float(item), 6) for item in value]
    return value


def canonical_link(page_number: int, link: dict) -> dict:
    return {
        "source_page": page_number,
        "kind": int(link.get("kind", 0)),
        "from": [round(float(item), 6) for item in fitz.Rect(link.get("from"))],
        "page": int(link.get("page", -1)),
        "to": point_value(link.get("to")),
        "zoom": round(float(link.get("zoom", 0.0) or 0.0), 6),
        "uri": link.get("uri"),
        "file": link.get("file"),
        "name": link.get("name"),
    }


def snapshot_links(doc: fitz.Document) -> list[dict]:
    values = [
        canonical_link(page_number, link)
        for page_number, page in enumerate(doc)
        for link in page.get_links()
    ]
    return sorted(values, key=lambda item: json.dumps(item, sort_keys=True))


def raw_links(doc: fitz.Document):
    return [
        (page_number, dict(link), canonical_link(page_number, link))
        for page_number, page in enumerate(doc)
        for link in page.get_links()
    ]


def restore_redaction_removed_links(doc: fitz.Document, originals) -> int:
    def key(item):
        return json.dumps(item, sort_keys=True, ensure_ascii=False)

    before = collections.Counter(key(canonical) for _page, _raw, canonical in originals)
    after = collections.Counter(key(item) for item in snapshot_links(doc))
    extra = after - before
    if extra:
        raise RuntimeError("targeted redaction created unexpected link annotations")
    missing = before - after
    restored = 0
    for page_number, raw, canonical in originals:
        identity = key(canonical)
        if missing[identity] <= 0:
            continue
        payload = {
            "kind": int(raw["kind"]),
            "from": fitz.Rect(raw["from"]),
        }
        if payload["kind"] == fitz.LINK_GOTO:
            payload.update(
                page=int(raw["page"]),
                to=fitz.Point(raw["to"]),
                zoom=float(raw.get("zoom", 0.0) or 0.0),
            )
        elif payload["kind"] == fitz.LINK_URI:
            payload["uri"] = str(raw["uri"])
        else:
            raise RuntimeError(f"cannot safely restore link kind {payload['kind']}")
        doc[page_number].insert_link(payload)
        missing[identity] -= 1
        restored += 1
    if any(missing.values()):
        raise RuntimeError("failed to restore every redaction-removed link")
    return restored


def snapshot_images(doc: fitz.Document) -> list[dict]:
    xrefs = sorted({int(item[0]) for page in doc for item in page.get_images(full=True)})
    values = []
    for xref in xrefs:
        image = doc.extract_image(xref)
        values.append(
            {
                "sha256": sha256_bytes(image.get("image", b"")),
                "width": int(image.get("width", 0)),
                "height": int(image.get("height", 0)),
                "extension": str(image.get("ext", "")),
            }
        )
    return sorted(values, key=lambda item: json.dumps(item, sort_keys=True))


def page_geometry(page: fitz.Page) -> dict:
    def values(rect):
        return [round(float(item), 6) for item in rect]

    return {
        "mediabox": values(page.mediabox),
        "cropbox": values(page.cropbox),
        "rect": values(page.rect),
        "rotation": int(page.rotation),
    }


def page_streams(doc: fitz.Document, page: fitz.Page) -> list[str]:
    return [sha256_bytes(doc.xref_stream(int(xref))) for xref in page.get_contents()]


def resource_snapshot(doc: fitz.Document, page: fitz.Page):
    kind, value = doc.xref_get_key(page.xref, "Resources")
    if kind == "xref":
        xref = int(str(value).split()[0])
        return [kind, sha256_bytes(doc.xref_object(xref, compressed=False).encode("utf-8"))]
    return [kind, sha256_bytes(str(value).encode("utf-8"))]


def raster_page(page: fitz.Page, scale=2.0) -> tuple[int, int, int, bytes]:
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False, colorspace=fitz.csRGB)
    return pix.width, pix.height, pix.n, bytes(pix.samples)


def compare_pixels_outside_rects(before, after, rects, scale=2.0, halo_pt=4.0):
    if before[:3] != after[:3]:
        return False, None
    width, height, channels = before[:3]
    left, right = before[3], after[3]
    mask = bytearray(width * height)
    for rect in rects:
        rect = fitz.Rect(rect)
        x0 = max(0, int(math.floor((rect.x0 - halo_pt) * scale)))
        y0 = max(0, int(math.floor((rect.y0 - halo_pt) * scale)))
        x1 = min(width, int(math.ceil((rect.x1 + halo_pt) * scale)))
        y1 = min(height, int(math.ceil((rect.y1 + halo_pt) * scale)))
        for y in range(y0, y1):
            mask[y * width + x0:y * width + x1] = b"\x01" * max(0, x1 - x0)
    changed = 0
    for pixel in range(width * height):
        if mask[pixel]:
            continue
        start = pixel * channels
        if left[start:start + channels] != right[start:start + channels]:
            changed += 1
            if changed > 0:
                return False, {"count": changed, "pixel": [pixel % width, pixel // width]}
    return True, 0


class FontSet:
    def __init__(self):
        required = [PRETENDARD, PRETENDARD_BOLD]
        for path in required:
            if not path.is_file():
                raise RuntimeError(f"required font is missing: {path}")
        self.regular = fitz.Font(fontfile=str(PRETENDARD))
        self.bold = fitz.Font(fontfile=str(PRETENDARD_BOLD))
        # STIXTwoMath is optional in the public repository. MuPDF's built-in
        # Symbol font provides a deterministic embedded fallback for common math
        # glyphs instead of making every ordinary Korean correction fail at boot.
        self.math = (
            fitz.Font(fontfile=str(STIX_MATH))
            if STIX_MATH.is_file()
            else fitz.Font(fontname="symb")
        )
        self.extra = []
        for path in (SYSTEM_Y_FALLBACK, SYSTEM_CANADIAN_FALLBACK):
            if path.is_file():
                self.extra.append(fitz.Font(fontfile=str(path)))

    def choose(self, char: str, bold=False):
        preferred = self.bold if bold else self.regular
        for font in (preferred, self.math, *self.extra):
            if char.isspace() or font.has_glyph(ord(char)):
                return font
        raise RuntimeError(f"no embedded font covers U+{ord(char):04X}")


def dominant_style(bindings: list[dict]) -> tuple[float, tuple[float, float, float], bool]:
    rows = []
    for binding in bindings:
        for line in binding["block"].get("lines", []):
            for span in line.get("spans", []):
                text = str(span.get("text", ""))
                if not text.strip():
                    continue
                size = float(span.get("size", 8.5) or 8.5)
                color = int(span.get("color", 0) or 0)
                font = str(span.get("font", ""))
                rows.append((max(1, len(text)), size, color, "bold" in font.lower()))
    if not rows:
        return 8.5, (0.0, 0.0, 0.0), False
    rows.sort(key=lambda item: (-item[0], -item[1]))
    _weight, size, packed, bold = rows[0]
    color = (
        ((packed >> 16) & 255) / 255.0,
        ((packed >> 8) & 255) / 255.0,
        (packed & 255) / 255.0,
    )
    return max(MIN_FONT_PT, size), color, bold


def layout_lines(text: str, rect: fitz.Rect, size: float, fonts: FontSet, bold=False):
    line_height = size * 1.18
    max_lines = max(1, int((rect.height + 0.15) // line_height))
    tokens = re.findall(r"\S+|\s+", text)
    lines: list[list[tuple[str, fitz.Font]]] = [[]]
    widths = [0.0]

    def char_width(char, font):
        return 0.0 if char in "\r\n" else font.text_length(char, fontsize=size)

    def append_char(char):
        font = fonts.choose(char, bold=bold)
        width = char_width(char, font)
        if lines[-1] and widths[-1] + width > rect.width + 0.05:
            lines.append([])
            widths.append(0.0)
        lines[-1].append((char, font))
        widths[-1] += width

    for token in tokens:
        if token.isspace():
            if "\n" in token and lines[-1]:
                lines.append([])
                widths.append(0.0)
            elif lines[-1]:
                append_char(" ")
            continue
        token_rows = [(char, fonts.choose(char, bold=bold)) for char in token]
        token_width = sum(char_width(char, font) for char, font in token_rows)
        if lines[-1] and widths[-1] + token_width > rect.width + 0.05:
            while lines[-1] and lines[-1][-1][0] == " ":
                char, font = lines[-1].pop()
                widths[-1] -= char_width(char, font)
            lines.append([])
            widths.append(0.0)
        for char, _font in token_rows:
            append_char(char)
    while lines and not lines[-1]:
        lines.pop()
        widths.pop()
    fits = bool(lines) and len(lines) <= max_lines and all(width <= rect.width + 0.05 for width in widths)
    return lines, widths, line_height, fits


def draw_fragment(page: fitz.Page, rect: fitz.Rect, text: str, start_size: float,
                  color, bold: bool, fonts: FontSet, label: str) -> dict:
    chosen = None
    size = max(MIN_FONT_PT, float(start_size))
    while size + 0.001 >= MIN_FONT_PT:
        lines, widths, line_height, fits = layout_lines(text, rect, size, fonts, bold=bold)
        if fits:
            chosen = (size, lines, widths, line_height)
            break
        size = round(size - 0.25, 2)
    if chosen is None:
        raise RuntimeError(f"{label} overflows its target bbox at the 8pt floor")
    size, lines, widths, line_height = chosen
    rendered_logical = "\n".join("".join(char for char, _font in line) for line in lines)
    if normalized_text(rendered_logical) != normalized_text(text):
        raise RuntimeError(f"{label} layout lost or reordered text")
    writer = fitz.TextWriter(page.rect)
    baseline = rect.y0 + size
    appended = 0
    for line in lines:
        x = rect.x0
        run_font = None
        run = []
        run_x = x
        for char, font in line:
            if run_font is not None and font is not run_font:
                value = "".join(run)
                writer.append(fitz.Point(run_x, baseline), value, font=run_font, fontsize=size)
                appended += len(value)
                x += run_font.text_length(value, fontsize=size)
                run_x = x
                run = []
            if run_font is None or font is not run_font:
                run_font = font
            run.append(char)
        if run:
            value = "".join(run)
            writer.append(fitz.Point(run_x, baseline), value, font=run_font, fontsize=size)
            appended += len(value)
        baseline += line_height
    writer.write_text(page, color=color, overlay=True)
    return {"font_pt": round(size, 2), "lines": len(lines), "overflow": 0}


def draw_table_cell_tokens(page: fitz.Page, fragment: dict, binding: dict,
                           start_size: float, color, bold: bool, fonts: FontSet,
                           label: str) -> dict:
    tokens = str(fragment["text"]).split()
    source_lines = []
    for region in binding["regions"]:
        for line in region["block"].get("lines", []):
            text = "".join(str(span.get("text", "")) for span in line.get("spans", [])).strip()
            if text:
                source_lines.append((fitz.Rect(line["bbox"]).x0, fitz.Rect(line["bbox"])))
    source_lines.sort(key=lambda item: item[0])
    anchors = []
    for x, rect in source_lines:
        if not anchors or abs(x - anchors[-1][0]) > 1.0:
            anchors.append((x, rect))
    if len(tokens) != len(anchors):
        raise RuntimeError(
            f"{label} has {len(tokens)} target cells but {len(anchors)} bound source anchors"
        )
    stats = []
    full = fitz.Rect(fragment["_rect"])
    for index, (token, (x, source_rect)) in enumerate(zip(tokens, anchors)):
        right = anchors[index + 1][0] - 2.0 if index + 1 < len(anchors) else full.x1
        # Numeric source fonts can be slightly narrower than Pretendard. Borrow
        # at most 2pt of the proven blank inter-column gap on the left while
        # staying inside the manifest target rectangle.
        cell_x0 = max(full.x0, x - (2.0 if index else 0.0))
        cell = fitz.Rect(cell_x0, full.y0, max(x + 4.0, right), full.y1)
        stats.append(
            draw_fragment(
                page, cell, token, start_size, color, bold, fonts,
                f"{label}.cell[{index}]",
            )
        )
    return {
        "font_pt": min(item["font_pt"] for item in stats),
        "lines": max(item["lines"] for item in stats),
        "overflow": sum(item["overflow"] for item in stats),
    }


def validate_manifest(root: Path, manifest: dict, final_doc: fitz.Document):
    if manifest.get("schema_version") != 1 or manifest.get("status") != "ready_for_patcher":
        raise ValueError("unsupported or unready targeted correction manifest")
    source = validate_file_binding(root, manifest["binding"]["source_pdf"], "source_pdf")
    final = validate_file_binding(root, manifest["binding"]["final_pdf"], "final_pdf")
    for label, path in (("source_pdf", source), ("final_pdf", final)):
        expected = int(manifest["binding"][label].get("page_count", -1))
        with fitz.open(path) as document:
            if document.page_count != expected:
                raise RuntimeError(f"{label} page count mismatch")
    excluded = {
        int(page)
        for group in [*manifest.get("deferred", []), *manifest.get("exclusions", [])]
        for page in group.get("pages", [])
    }
    if not {483, 484, 485}.issubset(excluded):
        raise RuntimeError("source-preserved pages 483-485 are not excluded")
    bindings = []
    for correction_index, correction in enumerate(manifest.get("corrections", [])):
        label = f"corrections[{correction_index}]({correction.get('id')})"
        page_number = int(correction.get("page", 0))
        if page_number in excluded:
            raise RuntimeError(f"{label} targets a deferred/excluded page")
        chunk_index = int(correction.get("chunk_index", -1))
        local_page = int(correction.get("local_page", -1))
        artifact = correction.get("artifact_binding", {})
        chunk = validate_file_binding(
            root,
            {"path": artifact.get("chunk_path"), "sha256": artifact.get("chunk_sha256")},
            f"{label}.chunk",
        )
        part = validate_file_binding(
            root,
            {"path": artifact.get("part_path"), "sha256": artifact.get("part_sha256")},
            f"{label}.part",
        )
        split = json.loads((root / "split.json").read_text("utf-8"))
        chunks = split.get("chunks", [])
        if chunk_index < 0 or chunk_index >= len(chunks):
            raise RuntimeError(f"{label} chunk index is invalid")
        split_chunk = chunks[chunk_index]
        if Path(split_chunk["path"]).resolve() != chunk.resolve():
            raise RuntimeError(f"{label} chunk path disagrees with split.json")
        if page_number - int(split_chunk["start"]) + 1 != local_page:
            raise RuntimeError(f"{label} local/global page binding mismatch")
        with fitz.open(chunk) as chunk_doc, fitz.open(part) as part_doc:
            if chunk_doc.page_count != part_doc.page_count or local_page > chunk_doc.page_count:
                raise RuntimeError(f"{label} chunk/part page binding mismatch")
        page = final_doc[page_number - 1]
        region_bindings = [
            bind_region(page, region, f"{label}.regions[{region_index}]")
            for region_index, region in enumerate(correction["locator"].get("regions", []))
        ]
        joiner = decode_joiner(correction["locator"].get("current_joiner", ""))
        current = joiner.join(normalized_text(item["text"]) for item in region_bindings)
        if sha256_bytes(current.encode("utf-8")) != correction["locator"].get("current_text_sha256"):
            raise RuntimeError(f"{label} combined current text hash mismatch")
        fragments = correction.get("target", {}).get("fragments", [])
        target_joiner = decode_joiner(correction["target"].get("target_joiner", ""))
        target = target_joiner.join(normalized_text(item.get("text", "")) for item in fragments)
        if sha256_bytes(target.encode("utf-8")) != correction["target"].get("target_text_sha256"):
            raise RuntimeError(f"{label} combined target text hash mismatch")
        for fragment_index, fragment in enumerate(fragments):
            if text_hash(fragment.get("text", "")) != fragment.get("text_sha256"):
                raise RuntimeError(f"{label}.fragments[{fragment_index}] text hash mismatch")
            fragment["_rect"] = finite_rect(
                fragment.get("preferred_bbox", fragment.get("bbox")),
                f"{label}.fragments[{fragment_index}].bbox",
            )
            if not rect_close(fragment["_rect"], fragment["_rect"] & page.rect):
                raise RuntimeError(f"{label}.fragments[{fragment_index}] escapes the page")
        invariants = correction.get("invariants", {})
        for family in ("preserve_numbers", "preserve_units", "preserve_formula_tokens", "preserve_names"):
            for token in invariants.get(family, []):
                if not invariant_present(str(token), target):
                    raise RuntimeError(f"{label} target lost {family} token {token!r}")
        bindings.append(
            {
                "correction": correction,
                "regions": region_bindings,
                "fragments": fragments,
                "current": current,
                "target": target,
            }
        )
    return source, final, bindings, excluded


def apply_stream_cleanups(doc: fitz.Document, pdf_bytes: bytes, visual: dict) -> list[dict]:
    results = []
    for index, cleanup in enumerate(visual.get("unused_undefined_font_selections", [])):
        page_number = int(cleanup["page"])
        page = doc[page_number - 1]
        expected_page_xref = int(str(cleanup["page_object"]).split()[0])
        stream_xref = int(str(cleanup["content_stream_object"]).split()[0])
        if page.xref != expected_page_xref or stream_xref not in page.get_contents():
            raise RuntimeError(f"font cleanup[{index}] page/content object binding mismatch")
        start = int(cleanup["raw_object_file_offset"])
        end = int(cleanup["raw_object_end_offset_exclusive"])
        if sha256_bytes(pdf_bytes[start:end]) != cleanup["raw_object_sha256"]:
            raise RuntimeError(f"font cleanup[{index}] raw object hash mismatch")
        stream = doc.xref_stream(stream_xref)
        if len(stream) != int(cleanup["decoded_stream_length"]):
            raise RuntimeError(f"font cleanup[{index}] decoded stream length mismatch")
        if sha256_bytes(stream) != cleanup["decoded_stream_sha256"]:
            raise RuntimeError(f"font cleanup[{index}] decoded stream hash mismatch")
        tag = str(cleanup["undefined_tag"]).encode("ascii")
        operator = tag + b" 1 Tf"
        offset = int(cleanup["decoded_tag_offset"])
        if stream[offset:offset + len(operator)] != operator or stream.count(operator) != 1:
            raise RuntimeError(f"font cleanup[{index}] operator binding mismatch")
        replacement = b" " * len(operator)
        doc.update_stream(stream_xref, stream[:offset] + replacement + stream[offset + len(operator):])
        results.append({"page": page_number, "xref": stream_xref, "removed": operator.decode("ascii")})
    return results


def verify_outline_bindings(doc: fitz.Document, outline_corrections: list[dict]):
    toc = doc.get_toc(simple=False)
    bindings = []
    for item in outline_corrections:
        one_based = int(item["index"])
        if one_based <= 0 or one_based > len(toc):
            raise RuntimeError(f"outline index {one_based} is outside the document")
        entry = toc[one_based - 1]
        level, current, page, detail = entry
        if int(level) != int(item["level"]) or int(page) != int(item["page"]):
            raise RuntimeError(f"outline {one_based} level/page binding mismatch")
        if text_hash(current) != item["current"]["sha256"] or current != item["current"]["text"]:
            raise RuntimeError(f"outline {one_based} current title mismatch")
        if text_hash(item["target"]["text"]) != item["target"]["sha256"]:
            raise RuntimeError(f"outline {one_based} target title hash mismatch")
        current_destination = destination_semantics(detail)
        if current_destination != manifest_destination(item["destination"]):
            raise RuntimeError(
                f"outline {one_based} destination mismatch: {current_destination!r}"
            )
        bindings.append(
            {
                "index": one_based,
                "xref": int(detail["xref"]),
                "destination": current_destination,
                "target": item["target"]["text"],
            }
        )
    return bindings


def apply_outlines(doc: fitz.Document, bindings):
    for binding in bindings:
        doc.xref_set_key(binding["xref"], "Title", fitz.get_pdf_str(binding["target"]))


def outline_snapshot(doc: fitz.Document) -> list[dict]:
    return [
        {
            "level": int(entry[0]),
            "title": str(entry[1]),
            "page": int(entry[2]),
            "destination": destination_semantics(entry[3]),
        }
        for entry in doc.get_toc(simple=False)
    ]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--visual-manifest", type=Path)
    parser.add_argument("--metadata", default="metadata.json")
    parser.add_argument("--expected-goto-links", type=int, default=4145)
    parser.add_argument("--expected-uri-links", type=int, default=59)
    parser.add_argument("--expected-images", type=int, default=328)
    parser.add_argument("--skip-stream-cleanup", action="store_true")
    parser.add_argument("--dry-run-output", type=Path)
    args = parser.parse_args(argv)

    root = args.root.resolve()
    manifest_path = args.manifest.resolve()
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    visual = None
    visual_bytes = None
    if args.visual_manifest:
        visual_bytes = args.visual_manifest.resolve().read_bytes()
        visual = json.loads(visual_bytes)

    final_path = root / manifest["binding"]["final_pdf"]["path"]
    metadata_path = root / args.metadata
    original_pdf_bytes = final_path.read_bytes()
    original_pdf_sha = sha256_bytes(original_pdf_bytes)
    if visual is not None and visual.get("artifact", {}).get("sha256") != original_pdf_sha:
        raise RuntimeError("visual manifest is not bound to the current final PDF")

    source_doc = fitz.open(root / manifest["binding"]["source_pdf"]["path"])
    doc = fitz.open(stream=original_pdf_bytes, filetype="pdf")
    temp_path = root / f".{final_path.name}.targeted-{os.getpid()}.tmp.pdf"
    if temp_path.exists():
        raise FileExistsError(temp_path)
    try:
        source_path, bound_final, bindings, excluded = validate_manifest(root, manifest, doc)
        if bound_final.resolve() != final_path.resolve():
            raise RuntimeError("manifest final path is not the publish target")
        if source_doc.page_count != doc.page_count:
            raise RuntimeError("source/final page count mismatch")
        # User-requested scope: preserve every existing bookmark title, level, and
        # destination.  The manifest's proposed outline translations are not applied.
        outlines_before = outline_snapshot(doc)

        geometries = [page_geometry(page) for page in doc]
        raw_links_before = raw_links(doc)
        links_before = snapshot_links(doc)
        goto_count = sum(item["kind"] == fitz.LINK_GOTO for item in links_before)
        uri_count = sum(item["kind"] == fitz.LINK_URI for item in links_before)
        if (goto_count, uri_count) != (args.expected_goto_links, args.expected_uri_links):
            raise RuntimeError(f"link count mismatch: GoTo={goto_count}, URI={uri_count}")
        images_before = snapshot_images(doc)
        if len(images_before) != args.expected_images:
            raise RuntimeError(f"embedded image count mismatch: {len(images_before)}")
        patched_pages = sorted({int(item["correction"]["page"]) for item in bindings})
        changed_rects = {page: [] for page in patched_pages}
        before_rasters = {page: raster_page(doc[page - 1]) for page in patched_pages}
        untouched_streams = {
            page_number: page_streams(doc, page)
            for page_number, page in enumerate(doc, 1)
            if page_number not in patched_pages
        }
        excluded_snapshots = {
            page_number: {
                "streams": page_streams(doc, doc[page_number - 1]),
                "resources": resource_snapshot(doc, doc[page_number - 1]),
                "geometry": page_geometry(doc[page_number - 1]),
                "links": [item for item in links_before if item["source_page"] == page_number - 1],
            }
            for page_number in sorted(excluded)
            if 1 <= page_number <= doc.page_count
        }

        stream_cleanups = []
        if visual is not None and not args.skip_stream_cleanup:
            stream_cleanups = apply_stream_cleanups(doc, original_pdf_bytes, visual)

        by_page = {}
        for binding in bindings:
            by_page.setdefault(int(binding["correction"]["page"]), []).append(binding)
        fonts = FontSet()
        draw_stats = []
        for page_number, page_bindings in by_page.items():
            page = doc[page_number - 1]
            for binding in page_bindings:
                redaction_rects = []
                for region in binding["regions"]:
                    redaction_rects.extend(region["redaction_rects"])
                    changed_rects[page_number].append(region["rect"])
                for fragment in binding["fragments"]:
                    redaction_rects.extend(contained_text_span_rects(page, fragment["_rect"]))
                unique_redactions = {
                    tuple(round(float(value), 4) for value in rect): rect
                    for rect in redaction_rects
                }
                for redaction_rect in unique_redactions.values():
                    page.add_redact_annot(redaction_rect, fill=(1, 1, 1), cross_out=False)
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_NONE,
                graphics=getattr(fitz, "PDF_REDACT_LINE_ART_NONE", 0),
                text=getattr(fitz, "PDF_REDACT_TEXT_REMOVE", 0),
            )
            page = doc.reload_page(page)
            for binding in page_bindings:
                start_size, color, bold = dominant_style(binding["regions"])
                for fragment_index, fragment in enumerate(binding["fragments"]):
                    changed_rects[page_number].append(fragment["_rect"])
                    label = f"{binding['correction']['id']}.fragment[{fragment_index}]"
                    if binding["correction"]["target"].get("apply_mode") == "table_cell_numeric_restore":
                        stat = draw_table_cell_tokens(
                            page, fragment, binding, start_size, color, bold, fonts, label
                        )
                    else:
                        stat = draw_fragment(
                            page,
                            fragment["_rect"],
                            fragment["text"],
                            start_size,
                            color,
                            bold,
                            fonts,
                            label,
                        )
                    draw_stats.append({"id": binding["correction"]["id"], **stat})

        restored_links = restore_redaction_removed_links(doc, raw_links_before)

        doc.save(temp_path, garbage=0, deflate=True, clean=False)
        doc.close()
        doc = None

        patched = fitz.open(temp_path)
        try:
            if patched.page_count != len(geometries):
                raise RuntimeError("patched page count changed")
            if [page_geometry(page) for page in patched] != geometries:
                raise RuntimeError("patched page geometry changed")
            links_after = snapshot_links(patched)
            if links_after != links_before:
                difference = next(
                    (
                        {"index": index, "before": left, "after": right}
                        for index, (left, right) in enumerate(zip(links_before, links_after))
                        if left != right
                    ),
                    {"before_count": len(links_before), "after_count": len(links_after)},
                )
                raise RuntimeError(
                    "link annotations changed during targeted patch: "
                    + json.dumps(difference, ensure_ascii=False, sort_keys=True)
                )
            images_after = snapshot_images(patched)
            if images_after != images_before:
                raise RuntimeError("embedded images changed during targeted patch")
            cleanup_pages = {int(item["page"]) for item in stream_cleanups}
            for page_number, hashes in untouched_streams.items():
                if page_number in cleanup_pages:
                    continue
                if page_streams(patched, patched[page_number - 1]) != hashes:
                    raise RuntimeError(f"untouched page {page_number} content streams changed")
            for page_number, snapshot in excluded_snapshots.items():
                page = patched[page_number - 1]
                if (
                    page_streams(patched, page) != snapshot["streams"]
                    or resource_snapshot(patched, page) != snapshot["resources"]
                    or page_geometry(page) != snapshot["geometry"]
                    or [item for item in links_after if item["source_page"] == page_number - 1]
                    != snapshot["links"]
                ):
                    raise RuntimeError(f"excluded page {page_number} changed")
            for page_number in patched_pages:
                exact, changed = compare_pixels_outside_rects(
                    before_rasters[page_number],
                    raster_page(patched[page_number - 1]),
                    changed_rects[page_number],
                )
                if not exact:
                    raise RuntimeError(
                        f"page {page_number} changed outside targeted rectangles ({changed} pixels)"
                    )
            for binding in bindings:
                page = patched[int(binding["correction"]["page"]) - 1]
                page_text = normalized_text(page.get_text())
                if normalized_text(binding["current"]) in page_text:
                    raise RuntimeError(f"{binding['correction']['id']} retained bound source text")
                for fragment in binding["fragments"]:
                    fragment_text = normalized_text(fragment["text"])
                    clip_text = normalized_text(page.get_textbox(fragment["_rect"] + (-0.5, -0.5, 0.5, 0.5)))
                    if fragment_text not in clip_text and fragment_text not in page_text:
                        raise RuntimeError(
                            f"{binding['correction']['id']} target fragment is not extractable"
                        )
                target_scope = " ".join(
                    normalized_text(page.get_textbox(fragment["_rect"] + (-0.5, -0.5, 0.5, 0.5)))
                    for fragment in binding["fragments"]
                )
                for family in (
                    "preserve_numbers", "preserve_units", "preserve_formula_tokens", "preserve_names"
                ):
                    for token in binding["correction"].get("invariants", {}).get(family, []):
                        if not invariant_present(str(token), target_scope) and not invariant_present(str(token), page_text):
                            raise RuntimeError(
                                f"{binding['correction']['id']} rendered output lost {family} {token!r}"
                            )
            if outline_snapshot(patched) != outlines_before:
                raise RuntimeError("existing outline titles, hierarchy, or destinations changed")
            for cleanup in stream_cleanups:
                stream = patched.xref_stream(cleanup["xref"])
                if cleanup["removed"].encode("ascii") in stream:
                    raise RuntimeError(f"unused font operator remains on page {cleanup['page']}")
        finally:
            patched.close()

        output_sha = sha256_file(temp_path)
        if args.dry_run_output is not None:
            dry_output = args.dry_run_output.resolve()
            if dry_output.exists():
                raise FileExistsError(dry_output)
            dry_output.parent.mkdir(parents=True, exist_ok=True)
            os.replace(temp_path, dry_output)
            print(json.dumps({
                "ok": True,
                "dry_run": True,
                "output": str(dry_output),
                "output_sha256": output_sha,
                "body_corrections": len(bindings),
                "bound_regions": sum(len(item["regions"]) for item in bindings),
                "outline_title_corrections": 0,
                "outlines_preserved": len(outlines_before),
                "min_font_pt": min(item["font_pt"] for item in draw_stats),
                "overflow": 0,
                "goto_links": goto_count,
                "uri_links": uri_count,
                "images": len(images_before),
                "stream_cleanups": stream_cleanups,
                "restored_links": restored_links,
            }, ensure_ascii=False, indent=2))
            return 0
        metadata = json.loads(metadata_path.read_text("utf-8"))
        if metadata.get("output_sha256") != original_pdf_sha:
            raise RuntimeError("metadata is not bound to the current final PDF")
        metadata_before = metadata_path.read_bytes()
        metadata["output_sha256"] = output_sha
        metadata["targeted_corrections"] = {
            "schema": manifest["schema"],
            "batch": manifest["batch"],
            "manifest_sha256": sha256_bytes(manifest_bytes),
            "visual_manifest_sha256": sha256_bytes(visual_bytes) if visual_bytes else None,
            "input_pdf_sha256": original_pdf_sha,
            "output_pdf_sha256": output_sha,
            "body_corrections": len(bindings),
            "bound_regions": sum(len(item["regions"]) for item in bindings),
            "outline_title_corrections": 0,
            "outlines_preserved": len(outlines_before),
            "min_font_pt": min(item["font_pt"] for item in draw_stats),
            "overflow": sum(item["overflow"] for item in draw_stats),
            "links": {"goto": goto_count, "uri": uri_count},
            "images": len(images_before),
            "stream_cleanups": stream_cleanups,
            "restored_links": restored_links,
            "excluded_pages": sorted(excluded),
        }
        metadata_output = (json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        backup_pdf = root / f"{final_path.stem}.before-targeted-corrections.{original_pdf_sha[:12]}.pdf"
        backup_metadata = root / f"metadata.before-targeted-corrections.{original_pdf_sha[:12]}.json"
        for backup, data in ((backup_pdf, original_pdf_bytes), (backup_metadata, metadata_before)):
            if backup.exists():
                if backup.read_bytes() != data:
                    raise RuntimeError(f"existing backup differs: {backup}")
            else:
                with open(backup, "xb") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
        metadata_temp = root / f".{metadata_path.name}.targeted-{os.getpid()}.tmp"
        with open(metadata_temp, "xb") as handle:
            handle.write(metadata_output)
            handle.flush()
            os.fsync(handle.fileno())
        published_pdf = False
        try:
            os.replace(temp_path, final_path)
            published_pdf = True
            os.replace(metadata_temp, metadata_path)
        except Exception:
            if published_pdf:
                shutil.copyfile(backup_pdf, final_path)
            metadata_temp.unlink(missing_ok=True)
            raise
        if sha256_file(final_path) != output_sha:
            raise RuntimeError("published PDF hash mismatch")
        result = {
            "ok": True,
            "output": str(final_path),
            "output_sha256": output_sha,
            "backup": str(backup_pdf),
            "body_corrections": len(bindings),
            "bound_regions": sum(len(item["regions"]) for item in bindings),
            "outline_title_corrections": 0,
            "outlines_preserved": len(outlines_before),
            "min_font_pt": min(item["font_pt"] for item in draw_stats),
            "overflow": 0,
            "goto_links": goto_count,
            "uri_links": uri_count,
            "images": len(images_before),
            "stream_cleanups": stream_cleanups,
            "restored_links": restored_links,
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    finally:
        if doc is not None:
            doc.close()
        source_doc.close()
        temp_path.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
