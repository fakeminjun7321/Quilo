#!/usr/bin/env python3
"""Render an already-generated PDF to lossless 300 dpi PNGs for QA."""

import json
import os
import sys

import fitz


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: render_pdf.py INPUT.pdf OUTPUT_DIR DPI")
    pdf_path = os.path.realpath(sys.argv[1])
    output_dir = os.path.realpath(sys.argv[2])
    dpi = int(sys.argv[3])
    if dpi != 300:
        raise SystemExit("restoration QA renderer requires exactly 300 dpi")
    os.makedirs(output_dir, exist_ok=True)
    document = fitz.open(pdf_path)
    manifest = []
    scale = dpi / 72.0
    matrix = fitz.Matrix(scale, scale)
    for index, page in enumerate(document):
        pix = page.get_pixmap(matrix=matrix, alpha=False, colorspace=fitz.csRGB)
        name = f"page-{index + 1:03d}.png"
        target = os.path.join(output_dir, name)
        pix.save(target)
        manifest.append({
            "page": index + 1,
            "path": target,
            "width": pix.width,
            "height": pix.height,
            "dpi": dpi,
        })
    print(json.dumps({"pages": manifest}, ensure_ascii=False))


if __name__ == "__main__":
    main()
