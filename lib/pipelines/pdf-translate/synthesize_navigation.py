#!/usr/bin/env python3
"""Fail-closed, evidence-bound navigation synthesis for scan-backed PDFs.

This is deliberately separate from the normal preservation path.  It may only be
used for a source/output pair that has no pre-existing outline or link actions,
and every synthesized bookmark / URI must be explicitly allow-listed in a
source-SHA-bound manifest.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
from urllib.parse import urlsplit

import fitz


SCHEMA_VERSION = 1
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_BOOKMARKS = 5000
MAX_VISIBLE_URLS = 1000
HEX_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


def _fail(message: str) -> None:
    raise ValueError(message)


def _strict_keys(value: dict, expected: set[str], context: str) -> None:
    actual = set(value)
    if actual != expected:
        _fail(
            f"{context} keys must be exactly {sorted(expected)}; "
            f"received {sorted(actual)}"
        )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _regular_non_symlink(path: Path, context: str) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        _fail(f"{context} does not exist")
    if stat.S_ISLNK(info.st_mode):
        _fail(f"{context} must not be a symlink")
    if not stat.S_ISREG(info.st_mode):
        _fail(f"{context} must be a regular file")


def _clean_text(value, context: str, maximum: int = 500) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        _fail(f"{context} must be a non-empty, trimmed string")
    if len(value) > maximum or any(ord(ch) < 0x20 for ch in value):
        _fail(f"{context} contains unsupported text")
    return value


def _page_number(value, page_count: int, context: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _fail(f"{context} must be an integer")
    if value < 1 or value > page_count:
        _fail(f"{context} must be from 1 to {page_count}")
    return value


def _normalized_text(value: str) -> str:
    return " ".join(str(value or "").split())


def _safe_http_uri(value) -> str:
    uri = _clean_text(value, "visible_urls[].uri", maximum=2048)
    if any(ord(ch) > 0x7E for ch in uri):
        _fail("visible_urls[].uri must be ASCII")
    parsed = urlsplit(uri)
    if parsed.scheme.lower() not in {"http", "https"}:
        _fail("visible_urls[].uri must use http or https")
    if not parsed.netloc or not parsed.hostname:
        _fail("visible_urls[].uri must have a host")
    if parsed.username is not None or parsed.password is not None:
        _fail("visible_urls[].uri must not contain credentials")
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError("visible_urls[].uri has an invalid port") from exc
    if "\\" in uri:
        _fail("visible_urls[].uri must not contain backslashes")
    return uri


def _source_has_links(doc: fitz.Document) -> bool:
    return any(page.first_link is not None for page in doc)


def _page_content_signature(doc: fitz.Document):
    result = []
    for page in doc:
        streams = []
        for xref in page.get_contents() or []:
            streams.append(hashlib.sha256(doc.xref_stream_raw(int(xref))).hexdigest())
        result.append(
            (
                tuple(round(float(value), 6) for value in page.mediabox),
                tuple(round(float(value), 6) for value in page.cropbox),
                int(page.rotation) % 360,
                tuple(streams),
            )
        )
    return tuple(result)


def _validate_manifest(raw, source: fitz.Document, source_sha256: str):
    if not isinstance(raw, dict):
        _fail("navigation manifest must be a JSON object")
    _strict_keys(
        raw,
        {"schema_version", "source_sha256", "bookmarks", "visible_urls"},
        "navigation manifest",
    )
    if raw["schema_version"] != SCHEMA_VERSION:
        _fail("unsupported navigation manifest schema_version")
    manifest_sha = raw["source_sha256"]
    if not isinstance(manifest_sha, str) or not HEX_SHA256.fullmatch(manifest_sha):
        _fail("source_sha256 must be a lowercase SHA-256 hex digest")
    if manifest_sha != source_sha256:
        _fail("navigation manifest source_sha256 does not match the source PDF")

    bookmarks = raw["bookmarks"]
    urls = raw["visible_urls"]
    if not isinstance(bookmarks, list) or not bookmarks or len(bookmarks) > MAX_BOOKMARKS:
        _fail(f"bookmarks must contain 1 to {MAX_BOOKMARKS} entries")
    if not isinstance(urls, list) or len(urls) > MAX_VISIBLE_URLS:
        _fail(f"visible_urls must contain at most {MAX_VISIBLE_URLS} entries")

    normalized_bookmarks = []
    bookmark_evidence = []
    previous_level = 0
    seen_bookmarks = set()
    for index, entry in enumerate(bookmarks):
        context = f"bookmarks[{index}]"
        if not isinstance(entry, dict):
            _fail(f"{context} must be an object")
        _strict_keys(entry, {"level", "title", "page", "evidence"}, context)
        level = entry["level"]
        if isinstance(level, bool) or not isinstance(level, int) or level < 1 or level > 8:
            _fail(f"{context}.level must be an integer from 1 to 8")
        if index == 0 and level != 1:
            _fail("the first bookmark level must be 1")
        if previous_level and level > previous_level + 1:
            _fail(f"{context}.level skips a hierarchy level")
        previous_level = level
        title = _clean_text(entry["title"], f"{context}.title", maximum=300)
        page = _page_number(entry["page"], len(source), f"{context}.page")
        evidence = entry["evidence"]
        if not isinstance(evidence, dict):
            _fail(f"{context}.evidence must be an object")
        _strict_keys(evidence, {"page", "text"}, f"{context}.evidence")
        evidence_page = _page_number(
            evidence["page"], len(source), f"{context}.evidence.page"
        )
        evidence_text = _clean_text(
            evidence["text"], f"{context}.evidence.text", maximum=500
        )
        page_text = _normalized_text(source[evidence_page - 1].get_text("text"))
        if _normalized_text(evidence_text) not in page_text:
            _fail(f"{context}.evidence.text is not present on the declared source page")
        signature = (level, title, page)
        if signature in seen_bookmarks:
            _fail(f"{context} duplicates a bookmark")
        seen_bookmarks.add(signature)
        normalized_bookmarks.append([level, title, page])
        bookmark_evidence.append((evidence_page, evidence_text))

    normalized_urls = []
    seen_urls = set()
    for index, entry in enumerate(urls):
        context = f"visible_urls[{index}]"
        if not isinstance(entry, dict):
            _fail(f"{context} must be an object")
        _strict_keys(entry, {"page", "uri"}, context)
        page = _page_number(entry["page"], len(source), f"{context}.page")
        uri = _safe_http_uri(entry["uri"])
        signature = (page, uri)
        if signature in seen_urls:
            _fail(f"{context} duplicates a visible URL allowlist entry")
        seen_urls.add(signature)
        normalized_urls.append((page, uri))

    return normalized_bookmarks, bookmark_evidence, normalized_urls


def _text_evidence_rectangles(page: fitz.Page, text: str):
    rectangles = page.search_for(text)
    unique = []
    seen = set()
    for rect in rectangles:
        signature = tuple(round(float(value), 3) for value in rect)
        if signature not in seen:
            seen.add(signature)
            unique.append(fitz.Rect(rect))
    return unique


def _visible_uri_rectangles(page: fitz.Page, uri: str):
    """Locate an exact URI, tolerating OCR-only whitespace inside one line.

    OCR layers sometimes split a visually continuous URL into adjacent tokens
    (for example ``numericalanalysis`` + ``1`` + ``burden/``).  Only exact
    concatenations of consecutive words from the same OCR line are accepted.
    """
    grouped = {}
    for word in page.get_text("words") or []:
        if len(word) < 8:
            continue
        grouped.setdefault((int(word[5]), int(word[6])), []).append(word)
    rectangles = []
    for words in grouped.values():
        words.sort(key=lambda item: int(item[7]))
        for start in range(len(words)):
            joined = ""
            rect = None
            for end in range(start, min(len(words), start + 16)):
                joined += str(words[end][4])
                rect = fitz.Rect(words[end][:4]) if rect is None else rect | fitz.Rect(words[end][:4])
                if joined == uri:
                    rectangles.append(rect)
                    break
                if len(joined) >= len(uri) or not uri.startswith(joined):
                    break
    unique = []
    seen = set()
    for rect in rectangles:
        signature = tuple(round(float(value), 3) for value in rect)
        if signature not in seen:
            seen.add(signature)
            unique.append(rect)
    return unique


def apply_navigation(source_path: Path, output_path: Path, manifest_bytes: bytes):
    _regular_non_symlink(source_path, "source PDF")
    _regular_non_symlink(output_path, "translated PDF")
    if len(manifest_bytes) > MAX_MANIFEST_BYTES:
        _fail("navigation manifest is too large")
    try:
        raw_manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("navigation manifest must be valid UTF-8 JSON") from exc

    source_sha256 = _sha256_file(source_path)
    source = fitz.open(source_path)
    output = fitz.open(output_path)
    temp_path = output_path.with_name(
        f".{output_path.name}.navigation-{os.getpid()}-{secrets.token_hex(8)}.partial"
    )
    try:
        if source.needs_pass or output.needs_pass:
            _fail("encrypted PDFs are not supported for navigation synthesis")
        if len(source) != len(output) or not len(source):
            _fail("source and translated PDFs must have the same non-zero page count")
        if source.get_toc() or _source_has_links(source):
            _fail("navigation synthesis is only allowed when the source has no outline or links")
        if output.get_toc() or _source_has_links(output):
            _fail("translated PDF already has an outline or links")

        bookmarks, bookmark_evidence, visible_urls = _validate_manifest(
            raw_manifest, source, source_sha256
        )
        before_content = _page_content_signature(output)
        expected_internal_links = []
        # The root bookmark describes the document itself.  Every remaining
        # bookmark is backed by visible TOC evidence, so make that exact TOC text
        # clickable as an internal GoTo link as well as exposing it in the reader
        # outline pane.
        for index in range(1, len(bookmarks)):
            _level, _title, target_page = bookmarks[index]
            evidence_page, evidence_text = bookmark_evidence[index]
            rectangles = _text_evidence_rectangles(
                source[evidence_page - 1], evidence_text
            )
            if not rectangles:
                _fail(
                    f"bookmark link evidence was not found on source page {evidence_page}: "
                    f"{evidence_text}"
                )
            target_point = fitz.Point(
                output[target_page - 1].rect.x0,
                output[target_page - 1].rect.y0,
            )
            for rect in rectangles:
                output[evidence_page - 1].insert_link(
                    {
                        "kind": fitz.LINK_GOTO,
                        "from": rect,
                        "page": target_page - 1,
                        "to": target_point,
                    }
                )
                expected_internal_links.append(
                    (
                        evidence_page,
                        target_page,
                        tuple(round(float(value), 3) for value in rect),
                    )
                )

        expected_links = []
        for page_number, uri in visible_urls:
            rectangles = _visible_uri_rectangles(source[page_number - 1], uri)
            if not rectangles:
                _fail(
                    f"visible URL evidence was not found on source page {page_number}: {uri}"
                )
            for rect in rectangles:
                output[page_number - 1].insert_link(
                    {"kind": fitz.LINK_URI, "from": rect, "uri": uri}
                )
                expected_links.append(
                    (
                        page_number,
                        uri,
                        tuple(round(float(value), 3) for value in rect),
                    )
                )

        output.set_toc(bookmarks, collapse=0)
        if temp_path.exists() or temp_path.is_symlink():
            _fail("temporary navigation output path already exists")
        output.save(temp_path, garbage=0, deflate=False)
        output.close()

        saved = fitz.open(temp_path)
        try:
            if _page_content_signature(saved) != before_content:
                _fail("navigation synthesis changed page geometry or content streams")
            actual_toc = [list(item[:3]) for item in saved.get_toc()]
            if actual_toc != bookmarks:
                _fail("saved bookmark hierarchy or destinations do not match the manifest")
            actual_links = []
            actual_internal_links = []
            for page_index, page in enumerate(saved):
                for link in page.get_links():
                    if int(link.get("kind", -1)) == int(fitz.LINK_URI):
                        actual_links.append(
                            (
                                page_index + 1,
                                str(link.get("uri") or ""),
                                tuple(
                                    round(float(value), 3)
                                    for value in fitz.Rect(link.get("from"))
                                ),
                            )
                        )
                    elif int(link.get("kind", -1)) == int(fitz.LINK_GOTO):
                        actual_internal_links.append(
                            (
                                page_index + 1,
                                int(link.get("page", -1)) + 1,
                                tuple(
                                    round(float(value), 3)
                                    for value in fitz.Rect(link.get("from"))
                                ),
                            )
                        )
            if sorted(actual_links) != sorted(expected_links):
                _fail("saved visible URL links do not match source evidence")
            if sorted(actual_internal_links) != sorted(expected_internal_links):
                _fail("saved TOC links do not match source evidence and destinations")
        finally:
            saved.close()
        os.replace(temp_path, output_path)
        return {
            "ok": True,
            "bookmarks": len(bookmarks),
            "toc_internal_links": len(expected_internal_links),
            "visible_url_allowlist_entries": len(visible_urls),
            "visible_url_links": len(expected_links),
            "source_sha256": source_sha256,
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        }
    finally:
        source.close()
        try:
            output.close()
        except Exception:
            pass
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def main() -> None:
    if len(sys.argv) != 4 or sys.argv[1] != "apply":
        sys.stderr.write(
            "usage: synthesize_navigation.py apply SOURCE.pdf TRANSLATED.pdf\n"
        )
        raise SystemExit(2)
    manifest_bytes = sys.stdin.buffer.read(MAX_MANIFEST_BYTES + 1)
    try:
        result = apply_navigation(Path(sys.argv[2]), Path(sys.argv[3]), manifest_bytes)
    except Exception as exc:
        sys.stderr.write(f"navigation synthesis failed: {exc}\n")
        raise SystemExit(1) from exc
    sys.stdout.write(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
