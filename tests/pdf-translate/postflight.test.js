const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  verifyPdfTranslationPostflight,
} = require("../../lib/pipelines/pdf-translate/postflight");
const {
  PDF_TRANSLATION_QUALITY_ERROR,
} = require("../../lib/pipelines/pdf-translate/quality-gate");

function escapePdfText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function syntheticPdf(pageSpecs) {
  const pages = pageSpecs.length ? pageSpecs : [{ text: "" }];
  const objectCount = 3 + pages.length * 2;
  const objects = new Array(objectCount);
  const pageIds = pages.map((_page, index) => 4 + index * 2);

  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  pages.forEach((spec, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const width = spec.width || 612;
    const height = spec.height || 792;
    const text = spec.text || "";
    const content = text
      ? `BT /F1 12 Tf 72 ${Math.max(72, height - 72)} Td (${escapePdfText(text)}) Tj ET\n`
      : "";
    const rotate = spec.rotation ? ` /Rotate ${spec.rotation}` : "";
    objects[pageId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}]${rotate} ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId - 1] =
      `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}endstream`;
  });

  const chunks = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [0];
  let position = chunks[0].length;
  objects.forEach((body, index) => {
    offsets.push(position);
    const chunk = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "ascii");
    chunks.push(chunk);
    position += chunk.length;
  });

  const xrefOffset = position;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}

function makeTempRoot(prefix = "pdf-postflight-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function assertPostflightTempsClean(root) {
  const leftovers = fs.readdirSync(root).filter((name) => name.startsWith("pdf-postflight-"));
  assert.deepEqual(leftovers, []);
}

const SOURCE_BACKED_GATE_NAMES = [
  "pdf_open",
  "source_pdf_open",
  "page_correspondence",
  "page_render",
  "blank_pages",
  "black_pages",
  "content_coverage",
  "page_order",
  "semantic_correspondence",
  "text_preservation",
  "raw_markers",
  "garbling",
  "untranslated_text",
  "number_preservation",
  "unit_preservation",
  "chemical_formula_preservation",
  "url_preservation",
  "image_duplicates",
  "image_preservation",
  "nontext_visual_preservation",
  "vector_provenance",
  "link_preservation",
];

function passingFakeReport(overrides = {}) {
  const gates = Object.fromEntries(SOURCE_BACKED_GATE_NAMES.map((name) => [name, {
    status: "pass",
    passed: true,
    hard: true,
    summary: "ok",
    details: {},
  }]));
  for (const name of ["semantic_correspondence", "text_preservation"]) {
    gates[name] = {
      status: "skip",
      passed: null,
      hard: true,
      summary: "not applicable",
      details: {},
    };
  }
  return {
    schema_version: 2,
    mode: "inplace",
    intent: "translate",
    passed: true,
    hard_failures: [],
    exit_code: 0,
    gates,
    ...overrides,
  };
}

function fakeVerifierScript(report, exitCode = 0) {
  const payload = typeof report === "string" ? report : JSON.stringify(report);
  return [
    'report_path=""',
    'for argument in "$@"; do report_path="$argument"; done',
    'cat > "$report_path" <<\'PDF_POSTFLIGHT_REPORT\'',
    payload,
    "PDF_POSTFLIGHT_REPORT",
    `exit ${exitCode}`,
  ].join("\n");
}

async function assertFakeReportInvalid(report) {
  await withFakePython(fakeVerifierScript(report), async (tempRoot) => {
    await assert.rejects(
      () => verifyPdfTranslationPostflight({
        originalBuffer: syntheticPdf([{ text: "Source" }]),
        resultBuffer: syntheticPdf([{ text: "Output" }]),
        tempRoot,
      }),
      (error) => {
        assert.equal(error.code, PDF_TRANSLATION_QUALITY_ERROR);
        assert.equal(error.details.kind, "postflight_report_invalid");
        assert.deepEqual(error.details.hard_failures, ["verifier_report_invalid"]);
        return true;
      },
    );
    assertPostflightTempsClean(tempRoot);
  });
}

async function withFakePython(script, callback) {
  const root = makeTempRoot("pdf-postflight-fake-");
  const fakePython = path.join(root, "python3");
  fs.writeFileSync(fakePython, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const previous = process.env.PYTHON_BIN;
  process.env.PYTHON_BIN = fakePython;
  try {
    return await callback(root);
  } finally {
    if (previous == null) delete process.env.PYTHON_BIN;
    else process.env.PYTHON_BIN = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("postflight returns a passing real verifier report and removes temp PDFs", async () => {
  const tempRoot = makeTempRoot();
  try {
    const report = await verifyPdfTranslationPostflight({
      originalBuffer: syntheticPdf([{ text: "Mass 12.5 kg" }]),
      resultBuffer: syntheticPdf([{ text: "Result 12.5 kg" }]),
      mode: "inplace",
      tempRoot,
    });
    assert.equal(report.passed, true);
    assert.equal(report.exit_code, 0);
    assert.deepEqual(report.hard_failures, []);
    assert.equal(report.mode, "inplace");
    assert.equal(report.intent, "translate");
    assertPostflightTempsClean(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("postflight throws qualityFailure with verifier hard_failures", async () => {
  const tempRoot = makeTempRoot();
  try {
    await assert.rejects(
      () => verifyPdfTranslationPostflight({
        originalBuffer: syntheticPdf([{ text: "Mass 12.5 kg" }]),
        resultBuffer: syntheticPdf([{ text: "Result unavailable" }]),
        tempRoot,
      }),
      (error) => {
        assert.equal(error.code, PDF_TRANSLATION_QUALITY_ERROR);
        assert.equal(error.details.kind, "postflight_verification");
        assert.ok(error.details.hard_failures.includes("number_preservation"));
        assert.ok(error.details.hard_failures.includes("unit_preservation"));
        assert.equal(error.details.report.passed, false);
        return true;
      },
    );
    assertPostflightTempsClean(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("postflight forwards retypeset mode to the real verifier", async () => {
  const tempRoot = makeTempRoot();
  try {
    const report = await verifyPdfTranslationPostflight({
      originalBuffer: syntheticPdf([{ text: "Value 5 kg", width: 612, height: 792 }]),
      resultBuffer: syntheticPdf([{ text: "Value 5 kg", width: 595, height: 842 }]),
      mode: "retypeset",
      tempRoot,
    });
    assert.equal(report.passed, true);
    assert.equal(report.mode, "retypeset");
    assertPostflightTempsClean(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("postflight forwards restore intent and permits preserved English", async () => {
  const tempRoot = makeTempRoot();
  const text = "This English source sentence remains exactly unchanged during restoration";
  try {
    const report = await verifyPdfTranslationPostflight({
      originalBuffer: syntheticPdf([{ text }]),
      resultBuffer: syntheticPdf([{ text }]),
      mode: "inplace",
      intent: "restore",
      tempRoot,
    });
    assert.equal(report.passed, true);
    assert.equal(report.intent, "restore");
    assert.equal(report.gates.untranslated_text.status, "skip");
    assert.equal(report.gates.text_preservation.status, "pass");
    assertPostflightTempsClean(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("postflight rejects a verifier report with an empty gate set", async () => {
  await assertFakeReportInvalid(passingFakeReport({ gates: {} }));
});

test("postflight rejects a report whose hard fail gate contradicts the summary", async () => {
  const report = passingFakeReport();
  report.gates.pdf_open = {
    status: "fail",
    passed: false,
    hard: true,
    summary: "failed",
    details: {},
  };
  await assertFakeReportInvalid(report);
});

test("postflight rejects required gates made non-hard or skipped outside policy", async () => {
  const nonHard = passingFakeReport();
  nonHard.gates.pdf_open.hard = false;
  await assertFakeReportInvalid(nonHard);

  const illegalSkip = passingFakeReport();
  illegalSkip.gates.image_preservation = {
    status: "skip",
    passed: null,
    hard: true,
    summary: "silently skipped",
    details: {},
  };
  await assertFakeReportInvalid(illegalSkip);

  const extraGate = passingFakeReport();
  extraGate.gates.unexpected = {
    status: "pass",
    passed: true,
    hard: true,
    summary: "not in schema",
    details: {},
  };
  await assertFakeReportInvalid(extraGate);
});

test("postflight rejects an unsupported verifier schema version", async () => {
  await assertFakeReportInvalid(passingFakeReport({ schema_version: 999 }));
});

test("postflight rejects malformed verifier JSON", async () => {
  await assertFakeReportInvalid("{ definitely-not-json");
});

test("postflight rejects a verifier report for a different mode or intent", async () => {
  await assertFakeReportInvalid(passingFakeReport({ mode: "retypeset", intent: "restore" }));
});

test("postflight abort kills the verifier and cleans temporary files", { timeout: 3000 }, async () => {
  await withFakePython("exec sleep 10", async (tempRoot) => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = verifyPdfTranslationPostflight({
      originalBuffer: syntheticPdf([{ text: "Source" }]),
      resultBuffer: syntheticPdf([{ text: "Output" }]),
      signal: controller.signal,
      timeoutMs: 2000,
      tempRoot,
    });
    setTimeout(() => controller.abort(new Error("user cancelled")), 40);
    await assert.rejects(promise, (error) => {
      assert.equal(error.name, "AbortError");
      assert.equal(error.code, "ABORT_ERR");
      return true;
    });
    assert.ok(Date.now() - started < 1500);
    assertPostflightTempsClean(tempRoot);
  });
});

test("postflight timeout is a fail-closed qualityFailure and cleans temp files", { timeout: 3000 }, async () => {
  await withFakePython("exec sleep 10", async (tempRoot) => {
    const started = Date.now();
    await assert.rejects(
      () => verifyPdfTranslationPostflight({
        originalBuffer: syntheticPdf([{ text: "Source" }]),
        resultBuffer: syntheticPdf([{ text: "Output" }]),
        timeoutMs: 60,
        tempRoot,
      }),
      (error) => {
        assert.equal(error.code, PDF_TRANSLATION_QUALITY_ERROR);
        assert.equal(error.details.kind, "postflight_timeout");
        assert.deepEqual(error.details.hard_failures, ["verifier_timeout"]);
        return true;
      },
    );
    assert.ok(Date.now() - started < 1500);
    assertPostflightTempsClean(tempRoot);
  });
});
