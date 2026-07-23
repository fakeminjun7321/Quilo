"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  generateLibreOfficePdf,
  getLibreOfficeGate,
} = require("../../lib/pipelines/pdf-translate/libreoffice-gen");

const PDF_INPUT = Buffer.from("%PDF-1.4\n%%EOF\n", "ascii");

function executable(root, name, body) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  return file;
}

function fakeBuilderBody({ sleep = 0, invalidMetadata = false, skipOutput = false } = {}) {
  return `
if [ ${sleep} != 0 ]; then sleep ${sleep}; fi
docx="$3"
metadata=""
start=""
end=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--metadata" ]; then metadata="$argument"; fi
  if [ "$previous" = "--start-page" ]; then start="$argument"; fi
  if [ "$previous" = "--end-page" ]; then end="$argument"; fi
  previous="$argument"
done
${skipOutput ? ":" : "printf 'PK\\003\\004synthetic-docx' > \"$docx\""}
bytes=0
if [ -f "$docx" ]; then bytes=$(wc -c < "$docx" | tr -d ' '); fi
${invalidMetadata
    ? "printf '{bad json' > \"$metadata\""
    : `cat > "$metadata" <<EOF
{"builder":"pdf2docx-clean-reading-v1","processed_pages":3,"docx_bytes":$bytes,"received_start":"$start","received_end":"$end"}
EOF`}
`;
}

function fakeLibreOfficeBody() {
  return `
outdir=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--outdir" ]; then outdir="$argument"; fi
  previous="$argument"
done
mkdir -p "$outdir"
printf '%%PDF-1.4\\n%%%%EOF\\n' > "$outdir/document.pdf"
`;
}

async function withFakes(builderBody, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-lo-gen-test-"));
  const tempRoot = path.join(root, "temps");
  fs.mkdirSync(tempRoot);
  const python = executable(root, "python", builderBody);
  const soffice = executable(root, "soffice", fakeLibreOfficeBody());
  const previousPython = process.env.PYTHON_BIN;
  const previousLibreOffice = process.env.LIBREOFFICE_BIN;
  process.env.PYTHON_BIN = python;
  process.env.LIBREOFFICE_BIN = soffice;
  try {
    return await callback({ root, tempRoot, python, soffice });
  } finally {
    if (previousPython == null) delete process.env.PYTHON_BIN;
    else process.env.PYTHON_BIN = previousPython;
    if (previousLibreOffice == null) delete process.env.LIBREOFFICE_BIN;
    else process.env.LIBREOFFICE_BIN = previousLibreOffice;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertTempsClean(tempRoot) {
  assert.deepEqual(
    fs.readdirSync(tempRoot).filter((name) => name.startsWith("quilo-lo-gen-")),
    [],
  );
}

test("builds clean-reading DOCX then LibreOffice PDF with zero-based range metadata", async () => {
  await withFakes(fakeBuilderBody(), async ({ tempRoot, python, soffice }) => {
    const progress = [];
    const result = await generateLibreOfficePdf(PDF_INPUT, {
      tempRoot,
      startPage: 7,
      endPage: 10,
      onProgress: (message) => progress.push(message),
    });
    assert.equal(result.buffer.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.equal(result.docxBuffer.subarray(0, 2).toString("ascii"), "PK");
    assert.equal(result.metadata.renderer, "libreoffice-clean-reading");
    assert.deepEqual(result.metadata.pageRange, {
      basis: "zero-based-end-exclusive",
      startPage: 7,
      endPage: 10,
    });
    assert.equal(result.metadata.build.received_start, "7");
    assert.equal(result.metadata.build.received_end, "10");
    assert.equal(result.metadata.builderProcess.python, python);
    assert.equal(result.metadata.libreOffice.binary, soffice);
    assert.ok(progress.length >= 4);
    assertTempsClean(tempRoot);
  });
});

test("fails closed on missing DOCX and malformed metadata", async (t) => {
  await t.test("missing DOCX", async () => {
    await withFakes(fakeBuilderBody({ skipOutput: true }), async ({ tempRoot }) => {
      await assert.rejects(
        () => generateLibreOfficePdf(PDF_INPUT, { tempRoot }),
        (error) => error.code === "LIBREOFFICE_DOCX_OUTPUT_INVALID",
      );
      assertTempsClean(tempRoot);
    });
  });
  await t.test("malformed metadata", async () => {
    await withFakes(fakeBuilderBody({ invalidMetadata: true }), async ({ tempRoot }) => {
      await assert.rejects(
        () => generateLibreOfficePdf(PDF_INPUT, { tempRoot }),
        (error) => error.code === "LIBREOFFICE_DOCX_METADATA_INVALID",
      );
      assertTempsClean(tempRoot);
    });
  });
});

test("times out the Python builder, honors abort, and cleans up", async (t) => {
  await t.test("timeout", async () => {
    await withFakes(fakeBuilderBody({ sleep: 10 }), async ({ tempRoot }) => {
      await assert.rejects(
        () => generateLibreOfficePdf(PDF_INPUT, { tempRoot, buildTimeoutMs: 50 }),
        (error) => error.code === "LIBREOFFICE_DOCX_TIMEOUT",
      );
      assertTempsClean(tempRoot);
    });
  });
  await t.test("abort", async () => {
    await withFakes(fakeBuilderBody({ sleep: 10 }), async ({ tempRoot }) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30);
      await assert.rejects(
        () => generateLibreOfficePdf(PDF_INPUT, { tempRoot, signal: controller.signal }),
        (error) => error.name === "AbortError" && error.code === "ABORT_ERR",
      );
      assertTempsClean(tempRoot);
    });
  });
});

test("process-wide LibreOffice FIFO defaults to one conversion", async () => {
  assert.equal(getLibreOfficeGate().capacity, 1);
  await withFakes(fakeBuilderBody({ sleep: 0.08 }), async ({ tempRoot }) => {
    const started = Date.now();
    await Promise.all([
      generateLibreOfficePdf(PDF_INPUT, { tempRoot }),
      generateLibreOfficePdf(PDF_INPUT, { tempRoot }),
    ]);
    assert.ok(Date.now() - started >= 140);
    assertTempsClean(tempRoot);
  });
});

test("rejects invalid page range before starting generation", async () => {
  await assert.rejects(
    () => generateLibreOfficePdf(PDF_INPUT, { startPage: 10, endPage: 10 }),
    (error) => error.code === "LIBREOFFICE_PAGE_RANGE_INVALID",
  );
});
