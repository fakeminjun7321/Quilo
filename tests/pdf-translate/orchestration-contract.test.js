const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  normalizeRequestedMode,
  resolvePdfTranslationLimits,
  resolvePdfTranslationMode,
  assertPdfTranslationInputCoverage,
  pdfTranslationOutputSuffix,
  finalizePdfTranslationOutput,
} = require("../../lib/pipelines/pdf-translate/orchestration-contract");

test("requested mode normalization has one shared auto fallback", () => {
  assert.equal(normalizeRequestedMode("inplace"), "inplace");
  assert.equal(normalizeRequestedMode("retypeset"), "retypeset");
  assert.equal(normalizeRequestedMode("auto"), "auto");
  assert.equal(normalizeRequestedMode("unknown"), "auto");
  assert.equal(normalizeRequestedMode("", "inplace"), "inplace");
  assert.equal(normalizeRequestedMode("unknown", "not-a-mode"), "auto");
});

test("mode resolution respects explicit in-place except when replacement is impossible", () => {
  assert.deepEqual(
    resolvePdfTranslationMode({
      requestedMode: "inplace",
      routing: { scanned: false, mathDensity: 99 },
      mathThreshold: 12,
    }),
    {
      requestedMode: "inplace",
      resolvedMode: "inplace",
      isAuto: false,
      needsRetypeset: true,
      scanned: false,
      mathDensity: 99,
      mathThreshold: 12,
      restoreOnly: false,
    },
  );

  assert.equal(
    resolvePdfTranslationMode({
      requestedMode: "inplace",
      routing: { scanned: true, mathDensity: 0 },
    }).resolvedMode,
    "retypeset",
  );
});

test("auto and restore mode resolution are fail-closed", () => {
  assert.equal(
    resolvePdfTranslationMode({
      requestedMode: "auto",
      routing: { scanned: false, mathDensity: 12 },
      mathThreshold: 12,
    }).resolvedMode,
    "retypeset",
  );
  assert.equal(
    resolvePdfTranslationMode({
      requestedMode: "auto",
      routing: { scanned: false, mathDensity: 11.9 },
      mathThreshold: 12,
    }).resolvedMode,
    "inplace",
  );
  assert.equal(
    resolvePdfTranslationMode({
      requestedMode: "inplace",
      routing: { scanned: false, mathDensity: 0 },
      restoreOnly: true,
    }).resolvedMode,
    "retypeset",
  );
});

test("limit parsing preserves the overall cap and ignores the retired OCR-only cap", () => {
  assert.deepEqual(
    resolvePdfTranslationLimits({
      env: {},
      defaultMaxPages: 700,
    }),
    { maxPages: 700, ocrMaxPages: 700 },
  );
  assert.deepEqual(
    resolvePdfTranslationLimits({
      env: { PDF_TRANSLATE_MAX_PAGES: "80", PDF_OCR_MAX_PAGES: "20" },
      defaultMaxPages: 700,
    }),
    { maxPages: 80, ocrMaxPages: 80 },
  );
  assert.deepEqual(
    resolvePdfTranslationLimits({
      env: { PDF_TRANSLATE_MAX_PAGES: "80pages", PDF_OCR_MAX_PAGES: "0" },
      defaultMaxPages: 700,
    }),
    { maxPages: 700, ocrMaxPages: 700 },
  );
});

test("scan limits accept long documents through the shared page budget", () => {
  const limits = resolvePdfTranslationLimits({ env: {}, defaultMaxPages: 700 });
  for (const pageCount of [31, 60, 100, 300, 700]) {
    assert.deepEqual(
      assertPdfTranslationInputCoverage({
        routing: { pageCount, scanned: true, truncated: false },
        maxPages: Math.min(limits.maxPages, limits.ocrMaxPages),
      }),
      { pageCount, maxPages: 700, truncated: false },
    );
  }
  assert.throws(
    () => assertPdfTranslationInputCoverage({
      routing: { pageCount: 701, scanned: true },
      maxPages: Math.min(limits.maxPages, limits.ocrMaxPages),
    }),
    (error) => error.details.kind === "pdf_page_limit_exceeded",
  );
});

test("coverage gate rejects truncation and page overflow for text and scan inputs", () => {
  assert.throws(
    () => assertPdfTranslationInputCoverage({
      routing: { truncated: true, pageCount: 30, tiles: 38, scanned: true },
      maxPages: 80,
    }),
    (error) => error.code === "PDF_TRANSLATION_QUALITY_FAILURE" &&
      error.details.kind === "truncated_ocr_input",
  );

  for (const scanned of [false, true]) {
    assert.throws(
      () => assertPdfTranslationInputCoverage({
        routing: { pageCount: 81, scanned },
        maxPages: 80,
      }),
      (error) => error.code === "PDF_TRANSLATION_QUALITY_FAILURE" &&
        error.details.kind === "pdf_page_limit_exceeded" &&
        error.details.pageCount === 81,
    );
  }

  assert.deepEqual(
    assertPdfTranslationInputCoverage({
      routing: { pageCount: 80, scanned: true },
      maxPages: 80,
    }),
    { pageCount: 80, maxPages: 80, truncated: false },
  );
});

test("output suffix is derived only from a valid effective mode and intent", () => {
  assert.equal(pdfTranslationOutputSuffix({ effectiveMode: "inplace" }), "_KO");
  assert.equal(pdfTranslationOutputSuffix({ effectiveMode: "retypeset" }), "_재조판");
  assert.equal(
    pdfTranslationOutputSuffix({ effectiveMode: "retypeset", restoreOnly: true }),
    "_복원",
  );
  assert.throws(
    () => pdfTranslationOutputSuffix({ effectiveMode: "auto" }),
    (error) => error.details.kind === "invalid_effective_mode",
  );
});

test("terminal finalization verifies magic and postflight before success", async () => {
  const originalBuffer = Buffer.from("%PDF-original");
  const resultBuffer = Buffer.from("%PDF-result");
  const signal = new AbortController().signal;
  const progress = [];
  let received = null;
  const report = {
    schema_version: 2,
    passed: true,
    mode: "retypeset",
    intent: "restore",
  };

  const terminal = await finalizePdfTranslationOutput({
    originalBuffer,
    resultBuffer,
    effectiveMode: "retypeset",
    restoreOnly: true,
    signal,
    onProgress: (message) => progress.push(message),
    postflightVerifier: async (options) => {
      received = options;
      return report;
    },
  });

  assert.equal(received.originalBuffer, originalBuffer);
  assert.equal(received.resultBuffer, resultBuffer);
  assert.equal(received.mode, "retypeset");
  assert.equal(received.intent, "restore");
  assert.equal(received.signal, signal);
  assert.equal(terminal.buffer, resultBuffer);
  assert.equal(terminal.effectiveMode, "retypeset");
  assert.equal(terminal.intent, "restore");
  assert.equal(terminal.suffix, "_복원");
  assert.equal(terminal.qualityReport, report);
  assert.equal(progress.length, 2);
  assert.match(progress[0], /최종 품질 검증 중/);
  assert.match(progress[1], /품질 검증 통과/);
});

test("terminal finalizer builds OCR semantic review from the final PDF before postflight", async () => {
  const originalBuffer = Buffer.from("%PDF-ocr-original");
  const resultBuffer = Buffer.from("%PDF-ocr-result");
  const ocrEvidence = { evidence_sha256: "a".repeat(64) };
  const review = { schema_version: 1, task: "sealed-review" };
  const context = {
    generationProvider: "anthropic",
    generationModel: "mock-translator",
    generationRequestId: "translation-request-1",
  };
  let builderArgs = null;
  let postflightArgs = null;
  const terminal = await finalizePdfTranslationOutput({
    originalBuffer,
    resultBuffer,
    effectiveMode: "retypeset",
    ocrEvidence,
    ocrRenderManifest: { manifest_sha256: "b".repeat(64) },
    requireOcrEvidence: true,
    // A generator-supplied/prebuilt self-claim must never bypass live review.
    ocrSemanticReview: { schema_version: 1, task: "untrusted-prebuilt-review" },
    ocrSemanticReviewContext: context,
    ocrSemanticReviewBuilder: async (options) => {
      builderArgs = options;
      return review;
    },
    postflightVerifier: async (options) => {
      postflightArgs = options;
      return { passed: true, mode: "retypeset", intent: "translate" };
    },
  });
  assert.equal(builderArgs.sourcePdf, originalBuffer);
  assert.equal(builderArgs.outputPdf, resultBuffer);
  assert.equal(builderArgs.ocrEvidence, ocrEvidence);
  assert.equal(builderArgs.generationRequestId, context.generationRequestId);
  assert.equal(postflightArgs.ocrSemanticReview, review);
  assert.equal(terminal.buffer, resultBuffer);
});

test("terminal finalizer builds an independent visual review for OCR restore", async () => {
  const originalBuffer = Buffer.from("%PDF-ocr-restore-original");
  const resultBuffer = Buffer.from("%PDF-ocr-restore-result");
  const ocrEvidence = { evidence_sha256: "a".repeat(64) };
  const manifest = { manifest_sha256: "b".repeat(64) };
  const visualReview = { schema_version: 1, task: "sealed-restore-visual-review" };
  const context = {
    generationProvider: "anthropic",
    generationModel: "mock-typesetter",
    generationRequestId: "restore-request-1",
  };
  let builderArgs = null;
  let postflightArgs = null;
  const terminal = await finalizePdfTranslationOutput({
    originalBuffer,
    resultBuffer,
    effectiveMode: "retypeset",
    restoreOnly: true,
    ocrEvidence,
    ocrRenderManifest: manifest,
    requireOcrEvidence: true,
    ocrSemanticReviewContext: context,
    ocrRestoreVisualReviewBuilder: async (options) => {
      builderArgs = options;
      return visualReview;
    },
    postflightVerifier: async (options) => {
      postflightArgs = options;
      return { passed: true, mode: "retypeset", intent: "restore" };
    },
  });
  assert.equal(builderArgs.sourcePdf, originalBuffer);
  assert.equal(builderArgs.outputPdf, resultBuffer);
  assert.equal(builderArgs.ocrEvidence, ocrEvidence);
  assert.equal(builderArgs.generationProvider, "anthropic");
  assert.equal(builderArgs.intent, "restore");
  assert.equal(postflightArgs.ocrRestoreVisualReview, visualReview);
  assert.equal(postflightArgs.ocrGenerationProvider, "anthropic");
  assert.equal(postflightArgs.ocrSemanticReview, null);
  assert.equal(terminal.buffer, resultBuffer);
});

test("terminal finalization never emits success after invalid output or verifier failure", async () => {
  let verifierCalls = 0;
  const invalidProgress = [];
  await assert.rejects(
    () => finalizePdfTranslationOutput({
      originalBuffer: Buffer.from("%PDF-original"),
      resultBuffer: Buffer.from("not a PDF"),
      effectiveMode: "inplace",
      onProgress: (message) => invalidProgress.push(message),
      postflightVerifier: async () => { verifierCalls += 1; },
    }),
    /expected PDF output/,
  );
  assert.equal(verifierCalls, 0);
  assert.deepEqual(invalidProgress, []);

  const failedProgress = [];
  await assert.rejects(
    () => finalizePdfTranslationOutput({
      originalBuffer: Buffer.from("%PDF-original"),
      resultBuffer: Buffer.from("%PDF-result"),
      effectiveMode: "inplace",
      onProgress: (message) => failedProgress.push(message),
      postflightVerifier: async () => {
        throw new Error("strict verifier failed");
      },
    }),
    /strict verifier failed/,
  );
  assert.equal(failedProgress.length, 1);
  assert.match(failedProgress[0], /최종 품질 검증 중/);

  const mismatchedProgress = [];
  await assert.rejects(
    () => finalizePdfTranslationOutput({
      originalBuffer: Buffer.from("%PDF-original"),
      resultBuffer: Buffer.from("%PDF-result"),
      effectiveMode: "inplace",
      onProgress: (message) => mismatchedProgress.push(message),
      postflightVerifier: async () => ({
        passed: true,
        mode: "retypeset",
        intent: "translate",
      }),
    }),
    (error) => error.details.kind === "postflight_terminal_contract",
  );
  assert.equal(mismatchedProgress.length, 1);
});

test("both HTTP entrypoints use the shared terminal contract", () => {
  const root = path.resolve(__dirname, "../..");
  for (const filename of ["server.js", "translate-server.js"]) {
    const source = fs.readFileSync(path.join(root, filename), "utf8");
    assert.match(source, /pdf-translate\/orchestration-contract/);
    assert.match(source, /finalizePdfTranslationOutput\s*\(/);
    assert.doesNotMatch(source, /verifyPdfTranslationPostflight\s*\(/);
  }
});

test("main admin translation path bypasses only the page-count gate", () => {
  const root = path.resolve(__dirname, "../..");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const translator = fs.readFileSync(
    path.join(root, "lib/pipelines/pdf-translate/translate.js"),
    "utf8",
  );
  assert.match(server, /adminPageLimitBypass:\s*effectiveIsAdmin/);
  assert.match(server, /adminPageLimitBypass\s*\?\s*Number\.MAX_SAFE_INTEGER/);
  assert.match(translator, /maxPages\s*=\s*MAX_PAGES/);
  assert.match(translator, /pages\s*>\s*pageLimit/);
  assert.match(server, /assertCompleteRasterization/);
});

test("standalone scan path uses chunked large-document orchestration", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../translate-server.js"),
    "utf8",
  );
  assert.match(source, /defaultMaxPages:\s*700/);
  assert.match(source, /largeVision:\s*true/);
  assert.match(source, /async function translateLargeVisionPdf/);
  assert.match(source, /mergeOcrRenderManifests/);
  assert.match(source, /assertCanonicalOcrChunkSubset/);
  assert.match(source, /Promise\.allSettled/);
});
