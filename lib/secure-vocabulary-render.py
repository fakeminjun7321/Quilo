#!/usr/bin/env python3
"""Rasterize one private vocabulary-example page with an accountable watermark."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import fitz


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--page", type=int, required=True)
    parser.add_argument("--watermark", required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    document = fitz.open(args.pdf)
    if args.page < 1 or args.page > document.page_count:
        raise ValueError("page out of range")
    page = document[args.page - 1]
    width = page.rect.width
    height = page.rect.height
    label = str(args.watermark)[:96]

    for row, y in enumerate(range(92, int(height), 118)):
        offset = 32 if row % 2 else 78
        for x in range(offset, int(width), 245):
            page.insert_text(
                (x, y),
                label,
                fontsize=8.2,
                fontname="helv",
                color=(0.45, 0.48, 0.54),
                fill_opacity=0.16,
                overlay=True,
            )

    pixmap = page.get_pixmap(matrix=fitz.Matrix(1.8, 1.8), colorspace=fitz.csRGB, alpha=False)
    image = pixmap.tobytes("jpeg", jpg_quality=84)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(image)
    else:
        sys.stdout.buffer.write(image)


if __name__ == "__main__":
    main()
