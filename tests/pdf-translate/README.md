# PDF translation golden fixture corpus

This directory defines a reproducible regression corpus for the PDF translation pipeline. All fixture content is synthetic and dedicated to CC0-1.0. Embedded Pretendard/Nanum font programs retain their upstream open-font licenses documented in `lib/fonts/Pretendard-LICENSE.txt` and `THIRD_PARTY_NOTICES.md`. Generated PDFs and rendered PNGs live under the git-ignored `tmp/pdfs/` directory; no PDF binary is committed.

The corpus covers:

- born-digital single-column text, exact numbers/units, URL text, external link annotations, an internal link, and an outline;
- two-column reading order, a ruled table, and vector-only figure primitives;
- equations, chemical formulae, visual subscripts/superscripts, Greek letters, and math operators;
- portrait, landscape, mixed page sizes, and explicit rotation metadata;
- an image-only scan and a full-page scan with a hidden render-mode-3 OCR text layer;
- already-Korean born-digital text;
- password-protected, structurally truncated, and non-PDF negative inputs.

`manifest.json` is the contract. Every case declares expected page count/geometry, invariant tokens, links, tables, images, and current pipeline routing. Negative cases declare the rejection category instead of a translation route.

## Install fixture-only dependencies

The repository `.venv` already includes PyMuPDF in normal development installs. Add the fixture tools without changing production dependencies:

```bash
uv pip install --python .venv/bin/python -r tests/pdf-translate/requirements.txt
```

If `uv` is unavailable:

```bash
.venv/bin/python -m pip install -r tests/pdf-translate/requirements.txt
```

Poppler must provide both `pdfinfo` and `pdftoppm`. On macOS:

```bash
brew install poppler
```

## Generate, verify, and render every page

Run from the repository root:

```bash
.venv/bin/python tests/pdf-translate/generate_fixtures.py
.venv/bin/python tests/pdf-translate/verify_fixtures.py
```

The verifier performs strict parser checks with pypdf, pdfplumber, PyMuPDF, and Poppler; validates manifest invariants; invokes the production `translate_pdf.py analyze` command; and renders every valid fixture page at 144 DPI. The encrypted fixture is rendered with its synthetic fixture password. Intentionally malformed/non-PDF inputs cannot be rendered and are instead required to fail parsing.

Artifacts:

- generated inputs: `tmp/pdfs/fixtures/`
- per-page PNGs: `tmp/pdfs/rendered/<fixture-id>/page-N.png`
- all-page contact sheet: `tmp/pdfs/rendered/contact-sheet.png`
- machine-readable verification result: `tmp/pdfs/fixture-verification.json`

Inspect `contact-sheet.png` and, when a thumbnail is ambiguous, inspect the corresponding full-resolution page PNG. No fixture is accepted merely because text extraction succeeds; visual rendering is a separate required check.

## Useful focused commands

Generate elsewhere:

```bash
.venv/bin/python tests/pdf-translate/generate_fixtures.py --output /tmp/quilo-pdf-fixtures
```

Verify without regenerating PNGs:

```bash
.venv/bin/python tests/pdf-translate/verify_fixtures.py --no-render
```

Inspect the production analyzer response directly:

```bash
.venv/bin/python lib/pipelines/pdf-translate/translate_pdf.py analyze tmp/pdfs/fixtures/06_hidden_ocr_layer.pdf | python3 -m json.tool
```

The generated files are deterministic except for encryption salts in the password-protected PDF. Tests must assert semantic/structural properties from the manifest, not whole-file hashes.
