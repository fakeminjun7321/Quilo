#!/usr/bin/env python3
"""Verify, route-analyze, and Poppler-render the synthetic PDF corpus."""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path
from typing import Any

import fitz
import pdfplumber
from PIL import Image, ImageDraw, ImageFont, ImageStat
from pypdf import PdfReader
from pypdf.errors import FileNotDecryptedError, PdfReadError


ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = Path(__file__).with_name("manifest.json")
DEFAULT_FIXTURES = ROOT / "tmp" / "pdfs" / "fixtures"
DEFAULT_RENDER = ROOT / "tmp" / "pdfs" / "rendered"
ANALYZER = ROOT / "lib" / "pipelines" / "pdf-translate" / "translate_pdf.py"


class CheckFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CheckFailure(message)


def normalized(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text or "").split())


def run(command: list[str], *, allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(command, text=True, capture_output=True, check=False)
    if proc.returncode and not allow_failure:
        raise CheckFailure(
            f"command failed ({proc.returncode}): {' '.join(command)}\n"
            f"stdout: {proc.stdout[-1000:]}\nstderr: {proc.stderr[-1000:]}"
        )
    return proc


def count_outline_items(items: list[Any]) -> int:
    count = 0
    for item in items:
        if isinstance(item, list):
            count += count_outline_items(item)
        else:
            count += 1
    return count


def collect_links(reader: PdfReader) -> tuple[list[str], int]:
    external: list[str] = []
    internal = 0
    for page in reader.pages:
        annotations = page.get("/Annots") or []
        for ref in annotations:
            annotation = ref.get_object()
            if annotation.get("/Subtype") != "/Link":
                continue
            action = annotation.get("/A")
            uri = action.get("/URI") if action else None
            if uri:
                external.append(str(uri))
            elif annotation.get("/Dest") is not None or action is not None:
                internal += 1
    return external, internal


def analyze_route(path: Path) -> dict[str, Any]:
    proc = run([sys.executable, str(ANALYZER), "analyze", str(path)])
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise CheckFailure(f"analyzer returned invalid JSON for {path.name}: {exc}: {proc.stdout[-1000:]}") from exc


def inspect_unencrypted(path: Path, expected: dict[str, Any], routing_policy: dict[str, Any]) -> dict[str, Any]:
    reader = PdfReader(str(path), strict=True)
    require(not reader.is_encrypted, f"{path.name}: unexpectedly encrypted")
    pages = len(reader.pages)
    require(pages == expected["page_count"], f"{path.name}: page count {pages} != {expected['page_count']}")
    with fitz.open(path) as doc:
        require(len(doc) == pages, f"{path.name}: PyMuPDF page count disagrees")
        image_count = sum(len(page.get_images(full=True)) for page in doc)
        span_sizes = {
            round(float(span.get("size", 0)), 2)
            for page in doc
            for block in page.get_text("dict").get("blocks", [])
            for line in block.get("lines", [])
            for span in line.get("spans", [])
            if float(span.get("size", 0)) > 0
        }
        invisible = 0
        visible = 0
        for page in doc:
            for span in page.get_texttrace():
                amount = len(span.get("chars") or ())
                if span.get("type") == 3 or span.get("opacity") == 0:
                    invisible += amount
                else:
                    visible += amount
    require(image_count >= expected.get("min_images", 0), f"{path.name}: images {image_count} below minimum")
    if "min_distinct_font_sizes" in expected:
        require(
            len(span_sizes) >= expected["min_distinct_font_sizes"],
            f"{path.name}: only {len(span_sizes)} distinct font sizes ({sorted(span_sizes)})",
        )
    if "min_invisible_text_ratio" in expected:
        ratio = invisible / max(invisible + visible, 1)
        require(
            ratio >= expected["min_invisible_text_ratio"],
            f"{path.name}: invisible text ratio {ratio:.3f} below minimum",
        )
    for page_no, box_expected in enumerate(expected.get("page_boxes", [])):
        page = reader.pages[page_no]
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)
        rotation = int(page.rotation or 0) % 360
        require(math.isclose(width, box_expected["width_pt"], abs_tol=0.2), f"{path.name} p{page_no + 1}: width {width}")
        require(math.isclose(height, box_expected["height_pt"], abs_tol=0.2), f"{path.name} p{page_no + 1}: height {height}")
        require(rotation == box_expected["rotation"], f"{path.name} p{page_no + 1}: rotation {rotation}")
    with pdfplumber.open(path) as pdf:
        page_texts = [page.extract_text() or "" for page in pdf.pages]
        extracted = normalized("\n".join(page_texts))
        vector_count = sum(len(page.lines) + len(page.rects) + len(page.curves) for page in pdf.pages)
        require(
            vector_count >= expected.get("min_vector_objects", 0),
            f"{path.name}: vector objects {vector_count} below minimum",
        )
        for table_expected in expected.get("tables", []):
            page_index = table_expected["page"] - 1
            candidates = pdf.pages[page_index].extract_tables()
            shapes = [
                (len(table), max((len(row or []) for row in table), default=0))
                for table in candidates
                if table
            ]
            wanted = (table_expected["rows"], table_expected["columns"])
            require(wanted in shapes, f"{path.name}: expected table shape {wanted}, found {shapes}")
    for token in expected.get("text_tokens", []):
        require(normalized(token) in extracted, f"{path.name}: missing extracted token {token!r}")
    if "max_extractable_text_chars" in expected:
        compact_length = len("".join(extracted.split()))
        require(
            compact_length <= expected["max_extractable_text_chars"],
            f"{path.name}: extracted {compact_length} chars, expected at most {expected['max_extractable_text_chars']}",
        )
    external, internal = collect_links(reader)
    for uri in expected.get("external_links", []):
        require(uri in external, f"{path.name}: missing external link annotation {uri}")
    require(internal >= expected.get("min_internal_links", 0), f"{path.name}: only {internal} internal links")
    outline_count = count_outline_items(reader.outline)
    require(outline_count >= expected.get("min_outline_items", 0), f"{path.name}: only {outline_count} outline items")
    analysis = analyze_route(path)
    route_expected = expected.get("routing")
    if route_expected:
        for field, wanted in route_expected.get("analysis", {}).items():
            require(analysis.get(field) == wanted, f"{path.name}: analyzer {field}={analysis.get(field)!r}, expected {wanted!r}")
        density_bounds = route_expected.get("math_density", {})
        density = float(analysis.get("math_density", 0))
        if "min" in density_bounds:
            require(density >= density_bounds["min"], f"{path.name}: math density {density} below minimum")
        if "max" in density_bounds:
            require(density <= density_bounds["max"], f"{path.name}: math density {density} above maximum")
        threshold = float(routing_policy["math_density_threshold"])
        mode = "retypeset" if analysis.get("scanned") or analysis.get("garbled") or density >= threshold else "inplace"
        require(mode == route_expected["mode"], f"{path.name}: derived route {mode}, expected {route_expected['mode']}")
    return {
        "pages": pages,
        "text_chars": len(extracted),
        "images": image_count,
        "vector_objects": vector_count,
        "external_links": external,
        "internal_links": internal,
        "outline_items": outline_count,
        "invisible_text_ratio": round(invisible / max(invisible + visible, 1), 4),
        "analysis": analysis,
    }


def inspect_encrypted(path: Path, expected: dict[str, Any]) -> dict[str, Any]:
    reader = PdfReader(str(path), strict=True)
    require(reader.is_encrypted, f"{path.name}: expected encryption")
    blocked = False
    try:
        _ = len(reader.pages)
    except FileNotDecryptedError:
        blocked = True
    require(blocked, f"{path.name}: pages were readable without a password")
    status = reader.decrypt(expected["password"])
    require(bool(status), f"{path.name}: fixture password did not decrypt file")
    require(len(reader.pages) == expected["page_count"], f"{path.name}: unlocked page count mismatch")
    text = normalized("\n".join(page.extract_text() or "" for page in reader.pages))
    for token in expected.get("text_tokens_after_unlock", []):
        require(normalized(token) in text, f"{path.name}: missing unlocked token {token!r}")
    for page_no, box_expected in enumerate(expected.get("page_boxes", [])):
        page = reader.pages[page_no]
        require(math.isclose(float(page.mediabox.width), box_expected["width_pt"], abs_tol=0.2), f"{path.name}: width mismatch")
        require(math.isclose(float(page.mediabox.height), box_expected["height_pt"], abs_tol=0.2), f"{path.name}: height mismatch")
        require(int(page.rotation or 0) % 360 == box_expected["rotation"], f"{path.name}: rotation mismatch")
    return {"pages": len(reader.pages), "encrypted": True, "unauthenticated_access_blocked": blocked}


def inspect_negative(path: Path, expected: dict[str, Any]) -> dict[str, Any]:
    data = path.read_bytes()
    classification = expected["classification"]
    if classification == "not_pdf":
        require(not data.startswith(b"%PDF-"), f"{path.name}: unexpectedly has PDF signature")
        info = run(["pdfinfo", str(path)], allow_failure=True)
        require(info.returncode != 0, f"{path.name}: pdfinfo unexpectedly accepted non-PDF")
    elif classification == "malformed_pdf":
        require(data.startswith(b"%PDF-"), f"{path.name}: malformed fixture lacks PDF signature")
        parse_failed = False
        try:
            PdfReader(str(path), strict=True)
        except (PdfReadError, EOFError, ValueError):
            parse_failed = True
        info = run(["pdfinfo", str(path)], allow_failure=True)
        require(parse_failed or info.returncode != 0, f"{path.name}: malformed fixture was accepted by both parsers")
    else:
        raise CheckFailure(f"{path.name}: unknown negative classification {classification}")
    return {"classification": classification, "rejection": expected["rejection"]}


def render_fixture(path: Path, target_dir: Path, expected: dict[str, Any]) -> list[Path]:
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True)
    prefix = target_dir / "page"
    command = ["pdftoppm", "-r", "144", "-png"]
    if expected.get("encrypted"):
        command.extend(["-upw", expected["password"]])
    command.extend([str(path), str(prefix)])
    run(command)
    images = sorted(target_dir.glob("page-*.png"))
    require(len(images) == expected["page_count"], f"{path.name}: rendered {len(images)} pages")
    for image_path in images:
        with Image.open(image_path) as image:
            require(image.width >= 500 and image.height >= 500, f"{image_path}: suspicious dimensions {image.size}")
            stat = ImageStat.Stat(image.convert("RGB").resize((128, 128)))
            require(max(stat.stddev) >= 2.0, f"{image_path}: rendered page appears blank")
    return images


def make_contact_sheet(rendered: list[tuple[str, Path]], output: Path) -> None:
    if not rendered:
        return
    thumb_w, thumb_h = 360, 510
    label_h = 42
    columns = 3
    rows = math.ceil(len(rendered) / columns)
    sheet = Image.new("RGB", (columns * thumb_w, rows * (thumb_h + label_h)), "#d9e0e6")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for index, (label, image_path) in enumerate(rendered):
        with Image.open(image_path) as source:
            page = source.convert("RGB")
            page.thumbnail((thumb_w - 24, thumb_h - 24), Image.Resampling.LANCZOS)
        x = (index % columns) * thumb_w
        y = (index // columns) * (thumb_h + label_h)
        px = x + (thumb_w - page.width) // 2
        py = y + 12 + (thumb_h - 24 - page.height) // 2
        sheet.paste(page, (px, py))
        draw.text((x + 12, y + thumb_h + 12), label, fill="#111827", font=font)
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, format="PNG", optimize=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=MANIFEST_PATH)
    parser.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES)
    parser.add_argument("--render-dir", type=Path, default=DEFAULT_RENDER)
    parser.add_argument("--no-render", action="store_true")
    args = parser.parse_args()
    for tool in ("pdfinfo", "pdftoppm"):
        require(shutil.which(tool) is not None, f"required Poppler tool not found: {tool}")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    results: dict[str, Any] = {"schema_version": 1, "fixtures": {}}
    failures: list[str] = []
    rendered: list[tuple[str, Path]] = []
    for item in manifest["fixtures"]:
        path = args.fixtures / item["filename"]
        try:
            require(path.is_file(), f"missing generated fixture: {path}")
            expected = item["expected"]
            if not expected["valid_pdf"]:
                detail = inspect_negative(path, expected)
            elif expected.get("encrypted"):
                detail = inspect_encrypted(path, expected)
            else:
                info = run(["pdfinfo", str(path)])
                require("Pages:" in info.stdout, f"{path.name}: pdfinfo did not report pages")
                detail = inspect_unencrypted(path, expected, manifest["routing_policy"])
            if item.get("render") and not args.no_render:
                images = render_fixture(path, args.render_dir / item["id"], expected)
                rendered.extend((f"{item['id']} p{index + 1}", image) for index, image in enumerate(images))
                detail["rendered_pages"] = len(images)
            results["fixtures"][item["id"]] = {"ok": True, **detail}
            print(f"PASS {item['id']}")
        except Exception as exc:
            failures.append(f"{item['id']}: {exc}")
            results["fixtures"][item["id"]] = {"ok": False, "error": str(exc)}
            print(f"FAIL {item['id']}: {exc}", file=sys.stderr)
    if not args.no_render:
        make_contact_sheet(rendered, args.render_dir / "contact-sheet.png")
    result_path = args.render_dir.parent / "fixture-verification.json"
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f"verified {len(manifest['fixtures'])} fixtures")
    print(f"results: {result_path.relative_to(ROOT)}")
    if not args.no_render:
        print(f"contact sheet: {(args.render_dir / 'contact-sheet.png').relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
