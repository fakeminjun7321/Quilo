#!/usr/bin/env python3
"""Restore a manifest-pinned set of source PDF GoTo links to one final PDF.

The operation is deliberately narrow: it verifies that the declared links are
the complete semantic link difference between the source and target, patches a
staged copy incrementally, proves all page-body invariants, and only then
atomically replaces the target PDF. The pre-patch artifact is retained at the
manifest's backup path.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from typing import Any

import fitz


ROUND_DIGITS = 6


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_regular_file(path: Path, label: str) -> None:
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f"{label} must be a regular, non-symlink file: {path}")


def rounded(value: float) -> float:
    return round(float(value), ROUND_DIGITS)


def normalize_link(page_index: int, link: dict[str, Any]) -> tuple[Any, ...]:
    rect = tuple(rounded(value) for value in link["from"])
    destination = link.get("to")
    if isinstance(destination, fitz.Point):
        destination = (rounded(destination.x), rounded(destination.y))
    else:
        destination = None
    target = link.get("page")
    if isinstance(target, int) and target >= 0:
        target += 1
    return (
        page_index + 1,
        int(link["kind"]),
        rect,
        target,
        destination,
        rounded(link.get("zoom", 0.0)),
        link.get("uri"),
        link.get("file"),
    )


def manifest_link_key(item: dict[str, Any]) -> tuple[Any, ...]:
    return (
        int(item["source_page"]),
        fitz.LINK_GOTO,
        tuple(rounded(value) for value in item["rect"]),
        int(item["target_page"]),
        tuple(rounded(value) for value in item["to"]),
        rounded(item.get("zoom", 0.0)),
        None,
        None,
    )


def link_counter(document: fitz.Document) -> collections.Counter[tuple[Any, ...]]:
    return collections.Counter(
        normalize_link(page_index, link)
        for page_index, page in enumerate(document)
        for link in page.get_links()
    )


def link_counts(counter: collections.Counter[tuple[Any, ...]]) -> dict[str, int]:
    return {
        "goto": sum(count for key, count in counter.items() if key[1] == fitz.LINK_GOTO),
        "uri": sum(count for key, count in counter.items() if key[1] == fitz.LINK_URI),
        "other": sum(
            count
            for key, count in counter.items()
            if key[1] not in (fitz.LINK_GOTO, fitz.LINK_URI)
        ),
    }


def invalid_goto_destinations(
    counter: collections.Counter[tuple[Any, ...]], page_count: int
) -> list[tuple[Any, ...]]:
    return [
        key
        for key, count in counter.items()
        if count and key[1] == fitz.LINK_GOTO and not (1 <= int(key[3]) <= page_count)
    ]


def page_geometry(document: fitz.Document) -> list[tuple[Any, ...]]:
    return [
        (
            tuple(rounded(value) for value in page.mediabox),
            tuple(rounded(value) for value in page.cropbox),
            tuple(rounded(value) for value in page.rect),
            int(page.rotation),
        )
        for page in document
    ]


def outline_semantics(document: fitz.Document) -> list[tuple[int, str, int]]:
    return [(int(level), str(title), int(page)) for level, title, page, *_ in document.get_toc(simple=False)]


def content_hashes(document: fitz.Document) -> list[str]:
    return [hashlib.sha256(page.read_contents()).hexdigest() for page in document]


def text_hashes(document: fitz.Document) -> list[str]:
    return [
        hashlib.sha256(page.get_text("text").encode("utf-8")).hexdigest()
        for page in document
    ]


def image_records(document: fitz.Document) -> list[list[tuple[Any, ...]]]:
    result: list[list[tuple[Any, ...]]] = []
    for page in document:
        records = [
            (
                info["digest"].hex(),
                int(info["width"]),
                int(info["height"]),
                tuple(rounded(value) for value in info["bbox"]),
                tuple(rounded(value) for value in info["transform"]),
            )
            for info in page.get_image_info(hashes=True, xrefs=True)
        ]
        records.sort()
        result.append(records)
    return result


def render_hashes(document: fitz.Document, pages_one_based: list[int]) -> dict[int, str]:
    hashes: dict[int, str] = {}
    for page_number in pages_one_based:
        pixmap = document[page_number - 1].get_pixmap(
            matrix=fitz.Matrix(1, 1), colorspace=fitz.csRGB, alpha=False
        )
        hashes[page_number] = hashlib.sha256(pixmap.samples).hexdigest()
    return hashes


def assert_counts(actual: dict[str, int], expected: dict[str, Any], label: str) -> None:
    normalized = {key: int(expected[key]) for key in ("goto", "uri", "other")}
    if actual != normalized:
        raise RuntimeError(f"{label} link counts differ: actual={actual}, expected={normalized}")


def write_json_staged(path: Path, payload: dict[str, Any]) -> Path:
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temp_path = Path(temp_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    return temp_path


def restore_target_from_backup(backup: Path, target: Path) -> None:
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{target.name}.rollback.", suffix=".tmp", dir=target.parent
    )
    os.close(descriptor)
    temp_path = Path(temp_name)
    temp_path.unlink()
    try:
        shutil.copy2(backup, temp_path)
        os.replace(temp_path, target)
    finally:
        temp_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()

    manifest_path = args.manifest.expanduser().resolve()
    require_regular_file(manifest_path, "manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1:
        raise RuntimeError("unsupported manifest schema_version")

    source_path = Path(manifest["source_pdf"]).expanduser().resolve()
    target_path = Path(manifest["target_pdf"]).expanduser().resolve()
    metadata_path = Path(manifest["metadata_json"]).expanduser().resolve()
    backup_path = Path(manifest["backup_pdf"]).expanduser().resolve()
    script_path = Path(__file__).resolve()
    for path, label in (
        (source_path, "source PDF"),
        (target_path, "target PDF"),
        (metadata_path, "metadata JSON"),
    ):
        require_regular_file(path, label)
    if backup_path == target_path:
        raise RuntimeError("backup path must differ from target path")
    if backup_path.parent != target_path.parent:
        raise RuntimeError("backup and target must share one directory")

    source_hash = sha256_file(source_path)
    target_hash = sha256_file(target_path)
    if source_hash != manifest["expected_source_sha256"]:
        raise RuntimeError("source PDF SHA-256 does not match the manifest")
    if target_hash != manifest["expected_prepatch_output_sha256"]:
        raise RuntimeError("target PDF SHA-256 does not match the pre-patch manifest pin")
    if sha256_file(metadata_path) != manifest["expected_prepatch_metadata_sha256"]:
        raise RuntimeError("metadata JSON SHA-256 does not match the manifest")

    source = fitz.open(source_path)
    target = fitz.open(target_path)
    try:
        page_count = int(manifest["expected_page_count"])
        if len(source) != page_count or len(target) != page_count:
            raise RuntimeError("source or target page count differs from the manifest")

        source_links = link_counter(source)
        target_links = link_counter(target)
        assert_counts(link_counts(source_links), manifest["expected_source_link_counts"], "source")
        assert_counts(
            link_counts(target_links), manifest["expected_prepatch_link_counts"], "pre-patch target"
        )
        if invalid_goto_destinations(source_links, page_count):
            raise RuntimeError("source contains invalid semantic GoTo destinations")
        if invalid_goto_destinations(target_links, page_count):
            raise RuntimeError("pre-patch target contains invalid GoTo destinations")

        declared_links = collections.Counter(
            manifest_link_key(item) for item in manifest["links"]
        )
        missing = source_links - target_links
        extra = target_links - source_links
        if missing != declared_links or extra:
            raise RuntimeError(
                "manifest links are not the exact source-minus-target semantic link difference"
            )

        baseline_geometry = page_geometry(target)
        baseline_outlines = outline_semantics(target)
        baseline_contents = content_hashes(target)
        baseline_text = text_hashes(target)
        baseline_images = image_records(target)
        baseline_metadata = dict(target.metadata)
        touched_pages = sorted({int(item["source_page"]) for item in manifest["links"]})
        baseline_renders = render_hashes(target, touched_pages)
    finally:
        source.close()
        target.close()

    if backup_path.exists():
        require_regular_file(backup_path, "existing backup PDF")
        if sha256_file(backup_path) != target_hash:
            raise RuntimeError("existing backup does not match the pre-patch target")
    else:
        os.link(target_path, backup_path)
        require_regular_file(backup_path, "created backup PDF")
        if sha256_file(backup_path) != target_hash:
            raise RuntimeError("created backup hash mismatch")

    descriptor, staged_name = tempfile.mkstemp(
        prefix=f".{target_path.name}.source-bound-goto.",
        suffix=".tmp.pdf",
        dir=target_path.parent,
    )
    os.close(descriptor)
    staged_pdf = Path(staged_name)
    staged_pdf.unlink()
    staged_metadata: Path | None = None
    try:
        shutil.copy2(target_path, staged_pdf)
        staged = fitz.open(staged_pdf)
        try:
            for item in manifest["links"]:
                staged[int(item["source_page"]) - 1].insert_link(
                    {
                        "kind": fitz.LINK_GOTO,
                        "from": fitz.Rect(*item["rect"]),
                        "page": int(item["target_page"]) - 1,
                        "to": fitz.Point(*item["to"]),
                        "zoom": float(item.get("zoom", 0.0)),
                    }
                )
            staged.saveIncr()
        finally:
            staged.close()

        verified = fitz.open(staged_pdf)
        source = fitz.open(source_path)
        try:
            verified_links = link_counter(verified)
            assert_counts(
                link_counts(verified_links),
                manifest["expected_postpatch_link_counts"],
                "post-patch target",
            )
            if verified_links != link_counter(source):
                raise RuntimeError("post-patch target link multiset does not exactly equal source")
            if invalid_goto_destinations(verified_links, page_count):
                raise RuntimeError("post-patch target contains invalid GoTo destinations")
            if page_geometry(verified) != baseline_geometry:
                raise RuntimeError("page geometry or rotation changed")
            if outline_semantics(verified) != baseline_outlines:
                raise RuntimeError("outlines changed")
            if content_hashes(verified) != baseline_contents:
                raise RuntimeError("page content streams changed")
            if text_hashes(verified) != baseline_text:
                raise RuntimeError("page text changed")
            if image_records(verified) != baseline_images:
                raise RuntimeError("image pixels or placements changed")
            if dict(verified.metadata) != baseline_metadata:
                raise RuntimeError("PDF document metadata changed")
            if render_hashes(verified, touched_pages) != baseline_renders:
                raise RuntimeError("a touched page's 72-dpi pixels changed")
        finally:
            source.close()
            verified.close()

        post_hash = sha256_file(staged_pdf)
        if post_hash == target_hash:
            raise RuntimeError("patch did not change the PDF artifact hash")

        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("output_sha256") != target_hash:
            raise RuntimeError("metadata output_sha256 does not match the pre-patch target")
        manifest_hash = sha256_file(manifest_path)
        provenance = {
            "name": manifest["repair_name"],
            "status": "passed",
            "applied_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "source_sha256": source_hash,
            "pre_patch_output_sha256": target_hash,
            "post_patch_output_sha256": post_hash,
            "manifest": str(manifest_path),
            "manifest_sha256": manifest_hash,
            "script": str(script_path),
            "script_sha256": sha256_file(script_path),
            "backup": str(backup_path),
            "backup_sha256": sha256_file(backup_path),
            "added_goto_links": len(manifest["links"]),
            "pre_patch_link_counts": manifest["expected_prepatch_link_counts"],
            "post_patch_link_counts": manifest["expected_postpatch_link_counts"],
            "semantic_link_multiset_equal_source": True,
            "invalid_goto_destinations": 0,
            "invariants": {
                "page_count": page_count,
                "page_geometry_rotation_unchanged": True,
                "outline_semantics_unchanged": True,
                "page_content_streams_unchanged": True,
                "image_pixels_dimensions_placements_unchanged": True,
                "page_text_unchanged": True,
                "pdf_document_metadata_unchanged": True,
                "touched_page_72dpi_pixels_unchanged": True,
            },
        }
        metadata["output_sha256"] = post_hash
        metadata["postprocess_provenance"] = provenance
        merge_stats = metadata.setdefault("merge_stats", {})
        merge_stats["restored_links"] = sum(
            int(manifest["expected_postpatch_link_counts"][key])
            for key in ("goto", "uri", "other")
        )
        merge_stats["source_bound_links_restored"] = len(manifest["links"])
        merge_stats["final_goto_links"] = int(
            manifest["expected_postpatch_link_counts"]["goto"]
        )
        merge_stats["final_uri_links"] = int(
            manifest["expected_postpatch_link_counts"]["uri"]
        )
        merge_stats["final_other_links"] = int(
            manifest["expected_postpatch_link_counts"]["other"]
        )
        merge_stats["final_invalid_goto_destinations"] = 0
        staged_metadata = write_json_staged(metadata_path, metadata)

        os.replace(staged_pdf, target_path)
        try:
            os.replace(staged_metadata, metadata_path)
            staged_metadata = None
        except Exception:
            restore_target_from_backup(backup_path, target_path)
            raise

        if sha256_file(target_path) != post_hash:
            raise RuntimeError("published target hash differs from the verified staged PDF")
        if json.loads(metadata_path.read_text(encoding="utf-8")).get("output_sha256") != post_hash:
            raise RuntimeError("published metadata does not match the patched PDF")

        print(
            json.dumps(
                {
                    "ok": True,
                    "target_pdf": str(target_path),
                    "backup_pdf": str(backup_path),
                    "pre_patch_output_sha256": target_hash,
                    "post_patch_output_sha256": post_hash,
                    "link_counts": manifest["expected_postpatch_link_counts"],
                    "added_goto_links": len(manifest["links"]),
                    "invalid_goto_destinations": 0,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    finally:
        staged_pdf.unlink(missing_ok=True)
        if staged_metadata is not None:
            staged_metadata.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
