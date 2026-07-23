#!/usr/bin/env python3
"""Small isolated page-geometry/render helper for strict OCR evidence.

Kept separate from translate_pdf.py so table/XMP/render work there can evolve
without coupling the OCR provenance boundary to that command dispatcher.
"""

import json
import math
import os
import sys

import fitz


TARGET_WIDTH_MIN = 600
TARGET_WIDTH_MAX = 2400
MIN_SAFE_ZOOM = 0.25
MAX_TILE_COUNT = 30
MAX_TILE_PIXEL_DIMENSION = 4096
MAX_TILE_PIXEL_AREA = 12_000_000
MAX_PAGE_TOTAL_PIXELS = 32_000_000


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def inspect(pdf_path):
    doc = fitz.open(pdf_path)
    try:
        pages = []
        for index, page in enumerate(doc):
            rect = page.rect
            pages.append(
                {
                    "index": index,
                    "width": float(rect.width),
                    "height": float(rect.height),
                    "rotation": int(page.rotation or 0),
                }
            )
        emit({"page_count": len(doc), "pages": pages})
    finally:
        doc.close()


def render(pdf_path, out_dir, raw_indices, target_width="1400"):
    indices = json.loads(raw_indices)
    if not isinstance(indices, list) or any(
        not isinstance(value, int) or isinstance(value, bool) or value < 0
        for value in indices
    ):
        raise ValueError("indices must be a zero-based integer array")
    if len(set(indices)) != len(indices):
        raise ValueError("indices contain duplicates")
    width_px = max(TARGET_WIDTH_MIN, min(int(target_width), TARGET_WIDTH_MAX))
    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    try:
        if any(index >= len(doc) for index in indices):
            raise ValueError("page index is outside the PDF")
        pages = []
        for index in sorted(indices):
            page = doc[index]
            rect = page.rect
            source_width = float(rect.width or 612.0)
            source_height = float(rect.height or 792.0)
            if (
                not math.isfinite(source_width)
                or not math.isfinite(source_height)
                or source_width <= 0
                or source_height <= 0
            ):
                raise ValueError("page has invalid visual-adjudication geometry")
            zoom = min(width_px / source_width, 4.0)
            if not math.isfinite(zoom) or zoom < MIN_SAFE_ZOOM:
                raise ValueError("page geometry requires an unsafe visual-adjudication zoom")
            predicted_width = max(1, math.ceil(source_width * zoom))
            if predicted_width > MAX_TILE_PIXEL_DIMENSION:
                raise ValueError("page requires an over-wide visual-adjudication pixmap")
            tile_height_pt = 1800.0 / zoom
            overlap_pt = 130.0 / zoom
            tile_count = max(1, math.ceil(source_height / (tile_height_pt * 1.15)))
            if tile_count > MAX_TILE_COUNT:
                raise ValueError("page requires more than 30 visual-adjudication tiles")
            segment_height = source_height / tile_count
            tile_specs = []
            total_predicted_pixels = 0
            for tile_index in range(tile_count):
                y0 = max(0.0, segment_height * tile_index - overlap_pt / 2)
                y1 = min(source_height, segment_height * (tile_index + 1) + overlap_pt / 2)
                predicted_height = max(1, math.ceil((y1 - y0) * zoom))
                predicted_pixels = predicted_width * predicted_height
                if (
                    predicted_height > MAX_TILE_PIXEL_DIMENSION
                    or predicted_pixels > MAX_TILE_PIXEL_AREA
                ):
                    raise ValueError("page requires an oversized visual-adjudication tile")
                total_predicted_pixels += predicted_pixels
                tile_specs.append((tile_index, y0, y1))
            if total_predicted_pixels > MAX_PAGE_TOTAL_PIXELS:
                raise ValueError("page exceeds the cumulative visual-adjudication pixel budget")

            tiles = []
            for tile_index, y0, y1 in tile_specs:
                clip = fitz.Rect(rect.x0, rect.y0 + y0, rect.x1, rect.y0 + y1)
                pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip, alpha=False)
                filename = f"p-{index:05d}-{tile_index:02d}.png"
                file_path = os.path.join(out_dir, filename)
                pix.save(file_path)
                tiles.append(
                    {
                        "index": tile_index,
                        "bbox": [0.0, y0, source_width, y1],
                        "width": int(pix.width),
                        "height": int(pix.height),
                        "file": file_path,
                    }
                )
            pages.append(
                {
                    "index": index,
                    "source_width": source_width,
                    "source_height": source_height,
                    "tiles": tiles,
                }
            )
        emit({"page_count": len(doc), "pages": pages})
    finally:
        doc.close()


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: ocr-page-tool.py inspect PDF | render PDF OUT INDICES [WIDTH]")
    command = sys.argv[1]
    if command == "inspect" and len(sys.argv) == 3:
        inspect(sys.argv[2])
    elif command == "render" and len(sys.argv) in (5, 6):
        render(*sys.argv[2:])
    else:
        raise SystemExit("invalid command")
