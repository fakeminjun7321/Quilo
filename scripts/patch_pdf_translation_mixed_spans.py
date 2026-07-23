#!/usr/bin/env python3
"""Restore reviewed source formula spans after a layout-only prose replacement.

This helper is intentionally scoped to the one-run manual-override adapter.  It
does not change the shared renderer.  Every source span is bound by page, text,
font and bbox; its original PDF text operators are clipped and replayed through
the renderer's existing exact-preservation primitives.  Only the separately
declared prose rectangle receives bundled-font target text.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import sys

import fitz


ROOT = Path(__file__).resolve().parents[1]
TRANSLATE_PY = ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def load_renderer_module():
    spec = importlib.util.spec_from_file_location(
        "quilo_manual_mixed_span_renderer", TRANSLATE_PY
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load the shared PDF renderer module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def finite_rect(value, label: str) -> fitz.Rect:
    if not isinstance(value, list) or len(value) != 4:
        raise ValueError(f"{label} must contain four numbers")
    numbers = [float(item) for item in value]
    if not all(math.isfinite(item) for item in numbers):
        raise ValueError(f"{label} has a non-finite coordinate")
    rect = fitz.Rect(numbers)
    if rect.is_empty or rect.width <= 0 or rect.height <= 0:
        raise ValueError(f"{label} is empty")
    return rect


def rect_close(left: fitz.Rect, right: fitz.Rect, tolerance: float = 0.08) -> bool:
    return all(abs(a - b) <= tolerance for a, b in zip(left, right))


def text_spans(page: fitz.Page):
    for block in page.get_text("dict").get("blocks", []):
        if int(block.get("type", -1)) != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if str(span.get("text", "")):
                    yield span


def bound_source_span(page: fitz.Page, raw: dict, label: str) -> dict:
    expected_text = str(raw.get("text", ""))
    expected_font = str(raw.get("font", ""))
    expected_bbox = finite_rect(raw.get("bbox"), f"{label}.bbox")
    expected_hash = str(raw.get("text_sha256", ""))
    if sha256_bytes(expected_text.encode("utf-8")) != expected_hash:
        raise ValueError(f"{label} text hash mismatch")
    matches = [
        span
        for span in text_spans(page)
        if str(span.get("text", "")) == expected_text
        and str(span.get("font", "")) == expected_font
        and rect_close(fitz.Rect(span.get("bbox")), expected_bbox)
    ]
    if len(matches) != 1:
        raise RuntimeError(f"{label} matched {len(matches)} source spans instead of one")
    return matches[0]


def source_font_resources(source: fitz.Page, font_names: set[str], overlay: bytes):
    source_fonts = [item for item in source.get_fonts(full=True) if len(item) >= 5]
    operator_resources = {
        match.decode("ascii")
        for match in re.findall(
            rb"/([A-Za-z0-9_.-]+)\s+[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s+Tf\b",
            bytes(overlay),
        )
    }
    if not operator_resources:
        raise RuntimeError("preserved formula overlay names no font resources")
    resources = {}
    for name in font_names:
        source_rows = [
            row
            for row in source_fonts
            if str(row[3]) == name
            or str(row[3]).endswith(f"+{name}")
            or str(row[4]) == name
        ]
        if not source_rows:
            raise RuntimeError(f"source page has no font resource for {name}")
        selected_rows = [row for row in source_rows if str(row[4]) in operator_resources]
        if not selected_rows:
            raise RuntimeError(f"formula overlay did not bind the source font {name}")
        selected = selected_rows[0]
        resources[name] = {
            "xref": int(selected[0]),
            "resource_name": str(selected[4]),
        }
    return resources


def formula_overlay_document(source_doc, page_number: int, overlay: bytes, resources: dict):
    """Build a one-page, font-only Form source for ``show_pdf_page``.

    The ordinary translated artifact may garbage-collect a formula font after
    redacting its last use.  PyMuPDF cannot graft an arbitrary font xref between
    documents, so copy the source page into a tiny document, replace all content
    with the already-clipped exact formula operators, and retain only the bound
    font resources.  ``show_pdf_page`` then imports the full dependent font/CFF
    object graph without importing source images or prose.
    """
    overlay_doc = fitz.open()
    overlay_doc.insert_pdf(source_doc, from_page=page_number, to_page=page_number)
    page = overlay_doc[0]
    copied_fonts = [item for item in page.get_fonts(full=True) if len(item) >= 5]
    font_entries = []
    for item in resources.values():
        name = item["resource_name"]
        if not name or any(char in name for char in "/[]()<>{}%"):
            overlay_doc.close()
            raise RuntimeError("unsafe preserved font resource name")
        matches = [row for row in copied_fonts if str(row[4]) == name]
        if len(matches) != 1:
            overlay_doc.close()
            raise RuntimeError(f"copied formula page lost font resource {name}")
        font_entries.append(f"/{name} {int(matches[0][0])} 0 R")
    stream_xref = overlay_doc.get_new_xref()
    overlay_doc.update_object(stream_xref, "<<>>")
    overlay_doc.update_stream(stream_xref, overlay)
    overlay_doc.xref_set_key(page.xref, "Contents", f"{stream_xref} 0 R")
    overlay_doc.xref_set_key(
        page.xref,
        "Resources",
        f"<< /Font << {' '.join(font_entries)} >> >>",
    )
    return overlay_doc


def graft_formula_fonts(doc, page, formula_doc, resources: dict):
    """Import dependent font objects, then remove the temporary Form invocation.

    ``show_pdf_page`` is used only as PyMuPDF's supported cross-document object
    graft mechanism.  Its temporary Form would alter page content order and make
    a strict in-place verifier treat the page as structurally changed.  Bind the
    imported font xrefs directly into the page resource dictionary, remove the
    Form invocation stream / XObject entry, and let the exact source operators be
    appended as ordinary page content instead.
    """
    before_contents = set(page.get_contents())
    before_xobjects = {(int(item[0]), str(item[1])) for item in page.get_xobjects()}
    page.show_pdf_page(
        page.rect,
        formula_doc,
        0,
        keep_proportion=False,
        overlay=True,
    )
    page = doc.reload_page(page)
    new_contents = [xref for xref in page.get_contents() if xref not in before_contents]
    new_xobjects = [
        (int(item[0]), str(item[1]))
        for item in page.get_xobjects()
        if (int(item[0]), str(item[1])) not in before_xobjects
    ]
    if not new_contents or not new_xobjects:
        raise RuntimeError("font graft did not create a temporary Form binding")
    nested_fonts = [item for item in page.get_fonts(full=True) if len(item) >= 7]
    for item in resources.values():
        name = item["resource_name"]
        matches = [row for row in nested_fonts if str(row[4]) == name]
        if not matches:
            raise RuntimeError(f"font graft did not import {name}")
        doc.xref_set_key(page.xref, f"Resources/Font/{name}", f"{int(matches[0][0])} 0 R")

    kept_contents = [xref for xref in page.get_contents() if xref not in set(new_contents)]
    if not kept_contents:
        doc.xref_set_key(page.xref, "Contents", "[]")
    elif len(kept_contents) == 1:
        doc.xref_set_key(page.xref, "Contents", f"{kept_contents[0]} 0 R")
    else:
        doc.xref_set_key(
            page.xref,
            "Contents",
            "[" + " ".join(f"{xref} 0 R" for xref in kept_contents) + "]",
        )
    for _xref, name in new_xobjects:
        if name and not any(char in name for char in "/[]()<>{}%"):
            doc.xref_set_key(page.xref, f"Resources/XObject/{name}", "null")
    return doc.reload_page(page)


def clip_pixmap(page: fitz.Page, rect: fitz.Rect, zoom: float = 4.0):
    pixmap = page.get_pixmap(
        matrix=fitz.Matrix(zoom, zoom),
        clip=rect,
        colorspace=fitz.csRGB,
        alpha=False,
        annots=False,
    )
    return pixmap.width, pixmap.height, pixmap.stride, bytes(pixmap.samples)


def source_prose_style(page: fitz.Page, prose_rect: fitz.Rect):
    candidates = []
    for span in text_spans(page):
        rect = fitz.Rect(span.get("bbox"))
        overlap = rect & prose_rect
        if overlap.is_empty or overlap.width <= 0 or overlap.height <= 0:
            continue
        origin = span.get("origin") or (rect.x0, rect.y1)
        candidates.append(
            (
                float(overlap.get_area()),
                float(span.get("size") or 0),
                float(origin[1]),
            )
        )
    if not candidates:
        raise RuntimeError("prose bbox has no source text style")
    _area, size, baseline = max(candidates)
    if not math.isfinite(size) or size <= 0 or not math.isfinite(baseline):
        raise RuntimeError("source prose style is invalid")
    return size, baseline


def apply_repair(renderer, source_doc, output_doc, repair, font_path: str, index: int):
    page_number = int(repair.get("page", -1))
    if page_number < 0 or page_number >= source_doc.page_count:
        raise ValueError(f"repair[{index}] page is outside the PDF")
    source_page = source_doc[page_number]
    output_page = output_doc[page_number]
    if source_page.rect != output_page.rect or source_page.rotation != output_page.rotation:
        raise RuntimeError(f"repair[{index}] page geometry changed")

    full_rect = finite_rect(repair.get("full_bbox"), f"repair[{index}].full_bbox")
    prose_rect = finite_rect(repair.get("prose_bbox"), f"repair[{index}].prose_bbox")
    if full_rect != (full_rect & source_page.rect) or prose_rect != (prose_rect & full_rect):
        raise ValueError(f"repair[{index}] bbox escapes its page/full rectangle")

    raw_spans = repair.get("formula_spans")
    if not isinstance(raw_spans, list) or not raw_spans:
        raise ValueError(f"repair[{index}] has no formula spans")
    source_spans = [
        bound_source_span(source_page, raw, f"repair[{index}].formula_spans[{span_index}]")
        for span_index, raw in enumerate(raw_spans)
    ]
    formula_rects = [fitz.Rect(span.get("bbox")) for span in source_spans]
    for rect in formula_rects:
        if rect != (rect & full_rect):
            raise ValueError(f"repair[{index}] formula span escapes full_bbox")
        if not (rect & prose_rect).is_empty:
            raise ValueError(f"repair[{index}] prose bbox overlaps a formula span")
    descriptors = [renderer._preserved_span_descriptor(span) for span in source_spans]
    overlay, selected_groups = renderer._build_preserved_text_overlay(
        source_doc, source_page, descriptors
    )
    if selected_groups <= 0:
        raise RuntimeError(f"repair[{index}] selected no original formula text object")
    font_resources = source_font_resources(
        source_page,
        {str(span.get("font", "")) for span in source_spans},
        overlay,
    )

    source_pixels = [clip_pixmap(source_page, rect) for rect in formula_rects]
    output_page.add_redact_annot(full_rect, fill=None, cross_out=False)
    output_page.apply_redactions(
        images=fitz.PDF_REDACT_IMAGE_NONE,
        graphics=getattr(fitz, "PDF_REDACT_LINE_ART_NONE", 0),
        text=getattr(fitz, "PDF_REDACT_TEXT_REMOVE", 0),
    )
    output_page = output_doc.reload_page(output_page)
    formula_doc = formula_overlay_document(
        source_doc, page_number, overlay, font_resources
    )
    try:
        output_page = graft_formula_fonts(
            output_doc, output_page, formula_doc, font_resources
        )
    finally:
        formula_doc.close()
    output_page = renderer._append_page_content_stream(output_doc, output_page, overlay)

    final_prose = str(repair.get("final_prose", ""))
    if not final_prose.strip():
        raise ValueError(f"repair[{index}] final_prose is empty")
    minimum_font = max(8.0, float(repair.get("minimum_font_pt", 8.0)))
    source_size, source_baseline = source_prose_style(source_page, prose_rect)
    if source_size + 0.05 < minimum_font:
        raise RuntimeError(
            f"repair[{index}] source prose font {source_size:.2f}pt is below the minimum"
        )
    font = fitz.Font(fontfile=font_path)
    text_width = font.text_length(final_prose, fontsize=source_size)
    if text_width > prose_rect.width + 0.05:
        raise RuntimeError(
            f"repair[{index}] final prose does not fit at {source_size:.2f}pt"
        )
    alias = f"QMO{index + 1}"
    output_page.insert_font(fontname=alias, fontfile=font_path)
    output_page.insert_text(
        (prose_rect.x0, source_baseline),
        final_prose,
        fontsize=source_size,
        fontname=alias,
        color=(0, 0, 0),
        overlay=True,
    )
    return {
        "id": str(repair.get("id")),
        "page": page_number,
        "formula_rects": [list(rect) for rect in formula_rects],
        "source_pixels": source_pixels,
        "font_size": source_size,
        "font_width": text_width,
        "prose_rect": list(prose_rect),
    }


def verify_repair_pixels(source_doc, output_doc, proof):
    output_page = output_doc[proof["page"]]
    for rect_values, source_pixels in zip(
        proof["formula_rects"], proof["source_pixels"]
    ):
        if clip_pixmap(output_page, fitz.Rect(rect_values)) != source_pixels:
            raise RuntimeError(f"mixed-span formula pixels changed for ID {proof['id']}")


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 4:
        raise SystemExit(
            "usage: patch_pdf_translation_mixed_spans.py SOURCE.pdf TRANSLATED.pdf OUTPUT.pdf FONT.ttf"
        )
    source_path, translated_path, output_path, font_path = map(Path, args)
    if output_path.exists():
        raise FileExistsError(f"refusing to overwrite {output_path}")
    payload_bytes = sys.stdin.buffer.read()
    payload = json.loads(payload_bytes.decode("utf-8"))
    if int(payload.get("schema_version", 0)) != 1:
        raise ValueError("payload schema_version must be 1")
    source_bytes = source_path.read_bytes()
    translated_bytes = translated_path.read_bytes()
    if sha256_bytes(source_bytes) != payload.get("source_pdf_sha256"):
        raise ValueError("source PDF SHA-256 mismatch")
    if sha256_bytes(translated_bytes) != payload.get("translated_pdf_sha256"):
        raise ValueError("translated PDF SHA-256 mismatch")
    repairs = payload.get("repairs")
    if not isinstance(repairs, list) or not repairs:
        raise ValueError("payload repairs must be a non-empty array")

    renderer = load_renderer_module()
    source_doc = fitz.open(stream=source_bytes, filetype="pdf")
    output_doc = fitz.open(stream=translated_bytes, filetype="pdf")
    try:
        if source_doc.page_count != output_doc.page_count:
            raise RuntimeError("translated PDF page count changed")
        proofs = [
            apply_repair(renderer, source_doc, output_doc, repair, str(font_path), index)
            for index, repair in enumerate(repairs)
        ]
        output_doc.save(str(output_path), garbage=4, deflate=True)
    finally:
        output_doc.close()

    patched_doc = fitz.open(str(output_path))
    try:
        for proof in proofs:
            verify_repair_pixels(source_doc, patched_doc, proof)
        output_sha256 = sha256_bytes(output_path.read_bytes())
    finally:
        patched_doc.close()
        source_doc.close()
    result = {
        "ok": True,
        "repairs": len(proofs),
        "pixel_exact": True,
        "output_sha256": output_sha256,
        "items": [
            {
                "id": proof["id"],
                "page": proof["page"],
                "font_size": proof["font_size"],
                "font_width": proof["font_width"],
                "formula_spans": len(proof["formula_rects"]),
            }
            for proof in proofs
        ],
    }
    # Importing the shared renderer deliberately reserves fd 1 for its JSON
    # protocol and redirects incidental Python stdout to stderr.  Reuse that
    # exact protocol writer so the Node adapter receives one clean JSON object.
    renderer.write_json_response(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
