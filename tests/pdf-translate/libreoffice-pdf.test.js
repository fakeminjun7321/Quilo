"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  findLibreOfficeBinary,
  convertOfficeToPdf,
} = require("../../lib/pipelines/pdf-translate/libreoffice-pdf");

const ZIP_INPUT = Buffer.from("PK\x03\x04synthetic-office-document", "binary");
const PDF_OUTPUT = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n";

function makeFakeLibreOffice(root, body) {
  const executable = path.join(root, "fake-soffice");
  fs.writeFileSync(executable, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  return executable;
}

function successfulScript(extra = "") {
  return `
outdir=""
input=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--outdir" ]; then outdir="$argument"; fi
  previous="$argument"
  case "$argument" in *.docx|*.odt) input="$argument" ;; esac
done
test -n "$outdir"
test -n "$input"
test "$(basename "$(dirname "$input")")" = "input"
profile_count=0
for argument in "$@"; do
  case "$argument" in -env:UserInstallation=file://*) profile_count=$((profile_count + 1)) ;; esac
done
test "$profile_count" -eq 1
mkdir -p "$outdir"
printf '%s' '${PDF_OUTPUT.replace(/'/g, "'\\''")}' > "$outdir/document.pdf"
${extra}`;
}

async function withFakeLibreOffice(script, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-lo-test-"));
  const tempRoot = path.join(root, "temps");
  fs.mkdirSync(tempRoot);
  const binary = makeFakeLibreOffice(root, script);
  const previous = process.env.LIBREOFFICE_BIN;
  process.env.LIBREOFFICE_BIN = binary;
  try {
    return await callback({ root, tempRoot, binary });
  } finally {
    if (previous == null) delete process.env.LIBREOFFICE_BIN;
    else process.env.LIBREOFFICE_BIN = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertConversionTempsClean(tempRoot) {
  const leftovers = fs.readdirSync(tempRoot).filter((name) => name.startsWith("quilo-lo-pdf-"));
  assert.deepEqual(leftovers, []);
}

test("findLibreOfficeBinary honors LIBREOFFICE_BIN before PATH", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-lo-find-"));
  try {
    const configured = makeFakeLibreOffice(root, "exit 0");
    const pathDir = path.join(root, "path");
    fs.mkdirSync(pathDir);
    makeFakeLibreOffice(pathDir, "exit 0");
    fs.renameSync(path.join(pathDir, "fake-soffice"), path.join(pathDir, "soffice"));
    assert.equal(findLibreOfficeBinary({
      env: { LIBREOFFICE_BIN: configured, PATH: pathDir },
      platform: "test",
    }), configured);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findLibreOfficeBinary falls back to soffice on PATH", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-lo-path-"));
  try {
    const found = makeFakeLibreOffice(root, "exit 0");
    const soffice = path.join(root, "soffice");
    fs.renameSync(found, soffice);
    assert.equal(findLibreOfficeBinary({ env: { PATH: root }, platform: "test" }), soffice);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("converts a DOCX Buffer with an isolated profile and returns metadata", async () => {
  await withFakeLibreOffice(successfulScript(), async ({ tempRoot, binary }) => {
    const progress = [];
    const result = await convertOfficeToPdf(ZIP_INPUT, {
      inputFormat: "docx",
      tempRoot,
      onProgress: (message) => progress.push(message),
    });
    assert.equal(result.buffer.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.deepEqual(result.metadata, {
      renderer: "libreoffice",
      inputFormat: "docx",
      outputFilename: "document.pdf",
      outputBytes: result.buffer.length,
      durationMs: result.metadata.durationMs,
      timeoutMs: 180000,
      binary,
      filter: "writer_pdf_Export",
      exitCode: 0,
    });
    assert.ok(result.metadata.durationMs >= 0);
    assert.deepEqual(progress, [
      "LibreOffice로 PDF를 생성하는 중...",
      "LibreOffice PDF 생성 완료",
    ]);
    assertConversionTempsClean(tempRoot);
  });
});

test("converts an ODT file path after staging a private copy", async () => {
  await withFakeLibreOffice(successfulScript(), async ({ root, tempRoot }) => {
    const source = path.join(root, "source.odt");
    fs.writeFileSync(source, ZIP_INPUT);
    const result = await convertOfficeToPdf(source, { tempRoot });
    assert.equal(result.metadata.inputFormat, "odt");
    assert.equal(result.buffer.subarray(0, 5).toString("ascii"), "%PDF-");
    assertConversionTempsClean(tempRoot);
  });
});

test("fails closed and cleans up when LibreOffice creates no output", async () => {
  await withFakeLibreOffice("exit 0", async ({ tempRoot }) => {
    await assert.rejects(
      () => convertOfficeToPdf(ZIP_INPUT, { inputFormat: "docx", tempRoot }),
      (error) => error.code === "LIBREOFFICE_OUTPUT_MISSING",
    );
    assertConversionTempsClean(tempRoot);
  });
});

test("fails closed on multiple output entries", async () => {
  await withFakeLibreOffice(successfulScript("printf 'extra' > \"$outdir/extra.txt\""), async ({ tempRoot }) => {
    await assert.rejects(
      () => convertOfficeToPdf(ZIP_INPUT, { inputFormat: "docx", tempRoot }),
      (error) => error.code === "LIBREOFFICE_OUTPUT_MULTIPLE",
    );
    assertConversionTempsClean(tempRoot);
  });
});

test("fails closed on a wrong output name", async () => {
  const script = successfulScript("mv \"$outdir/document.pdf\" \"$outdir/wrong.pdf\"");
  await withFakeLibreOffice(script, async ({ tempRoot }) => {
    await assert.rejects(
      () => convertOfficeToPdf(ZIP_INPUT, { inputFormat: "docx", tempRoot }),
      (error) => error.code === "LIBREOFFICE_OUTPUT_WRONG",
    );
    assertConversionTempsClean(tempRoot);
  });
});

test("fails closed on empty and non-PDF outputs", async (t) => {
  await t.test("empty", async () => {
    const script = `${successfulScript()}\n: > "$outdir/document.pdf"`;
    await withFakeLibreOffice(script, async ({ tempRoot }) => {
      await assert.rejects(
        () => convertOfficeToPdf(ZIP_INPUT, { inputFormat: "docx", tempRoot }),
        (error) => error.code === "LIBREOFFICE_OUTPUT_EMPTY",
      );
      assertConversionTempsClean(tempRoot);
    });
  });
  await t.test("wrong magic", async () => {
    const script = `${successfulScript()}\nprintf 'not a pdf' > "$outdir/document.pdf"`;
    await withFakeLibreOffice(script, async ({ tempRoot }) => {
      await assert.rejects(
        () => convertOfficeToPdf(ZIP_INPUT, { inputFormat: "docx", tempRoot }),
        (error) => error.code === "LIBREOFFICE_OUTPUT_INVALID",
      );
      assertConversionTempsClean(tempRoot);
    });
  });
});

test("kills a timed-out LibreOffice conversion and cleans up", async () => {
  await withFakeLibreOffice("sleep 10", async ({ tempRoot }) => {
    await assert.rejects(
      () => convertOfficeToPdf(ZIP_INPUT, {
        inputFormat: "docx",
        tempRoot,
        timeoutMs: 50,
      }),
      (error) => error.code === "LIBREOFFICE_TIMEOUT",
    );
    assertConversionTempsClean(tempRoot);
  });
});

test("honors AbortSignal and cleans up", async () => {
  await withFakeLibreOffice("sleep 10", async ({ tempRoot }) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(
      () => convertOfficeToPdf(ZIP_INPUT, {
        inputFormat: "docx",
        tempRoot,
        signal: controller.signal,
      }),
      (error) => error.name === "AbortError" && error.code === "ABORT_ERR",
    );
    assertConversionTempsClean(tempRoot);
  });
});

test("rejects unsupported, mismatched, and invalid office inputs before spawning", async () => {
  await withFakeLibreOffice(successfulScript(), async ({ tempRoot }) => {
    await assert.rejects(
      () => convertOfficeToPdf(ZIP_INPUT, { inputFormat: "xlsx", tempRoot }),
      (error) => error.code === "LIBREOFFICE_INPUT_FORMAT_UNSUPPORTED",
    );
    await assert.rejects(
      () => convertOfficeToPdf(Buffer.from("not zip"), { inputFormat: "docx", tempRoot }),
      (error) => error.code === "LIBREOFFICE_INPUT_INVALID",
    );
    assertConversionTempsClean(tempRoot);
  });
});
