#!/usr/bin/env python3
"""Fail the HF image build when PDF runtime imports are incomplete."""

import importlib


REQUIRED_IMPORTS = (
    "fitz",
    "fontTools",
    "lxml.etree",
    "pdf2docx",
    "docx",
)


def main():
    failures = []
    for module_name in REQUIRED_IMPORTS:
        try:
            importlib.import_module(module_name)
        except Exception as exc:  # pragma: no cover - exercised in Docker build
            failures.append(f"{module_name}: {type(exc).__name__}: {exc}")
    if failures:
        raise SystemExit("PDF Python runtime check failed: " + "; ".join(failures))
    print("PDF Python runtime imports OK")


if __name__ == "__main__":
    main()
