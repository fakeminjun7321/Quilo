// Shared, fail-closed orchestration contract for PDF translation entrypoints.
//
// The main site and the standalone translation site intentionally have different
// authentication, billing, concurrency, and OCR capabilities.  Mode resolution,
// input coverage limits, and the final "safe to download" transition must not
// drift between those entrypoints, however, so those small policy decisions live
// here.

const { assertGeneratedOutputMagic } = require("../../output-validate");
const { canonicalJson } = require("./invariants");
const { qualityFailure } = require("./quality-gate");
const { validateRetypesetOcrEvidence } = require("./provenance");
const { verifyPdfTranslationPostflight } = require("./postflight");
const {
  buildVisualReview,
  createOcrSemanticReviewForOutput,
} = require("./ocr-semantic-review");

const PDF_TRANSLATION_MODES = Object.freeze(["auto", "inplace", "retypeset"]);
const EFFECTIVE_PDF_TRANSLATION_MODES = Object.freeze(["inplace", "retypeset"]);

function assertCanonicalOcrChunkSubset({
  reportedSubset,
  ocrEvidence,
  ocrRenderManifest,
  sourcePdf,
  expectedPageIndices,
  chunk = null,
} = {}) {
  let canonicalSubset = null;
  try {
    canonicalSubset = validateRetypesetOcrEvidence({
      ocrEvidence,
      ocrRenderManifest,
      sourcePdf,
      expectedPageIndices,
    }).subset;
    if (
      !reportedSubset ||
      !canonicalSubset ||
      canonicalJson(reportedSubset) !== canonicalJson(canonicalSubset)
    ) {
      throw new Error("reported OCR subset differs from canonical evidence");
    }
  } catch (error) {
    throw qualityFailure(
      `OCR 재조판 구간${chunk == null ? "" : ` ${chunk}`}의 OCR subset evidence가 ` +
        "canonical 원본 페이지 해시·블록·seal과 일치하지 않습니다.",
      {
        kind: "ocr_chunk_evidence_mismatch",
        chunk,
        causeCode: typeof error?.code === "string" ? error.code : null,
      },
    );
  }
  return canonicalSubset;
}

function normalizeRequestedMode(value, fallback = "auto") {
  const normalizedFallback = PDF_TRANSLATION_MODES.includes(String(fallback))
    ? String(fallback)
    : "auto";
  const candidate = String(value == null ? "" : value).trim();
  return PDF_TRANSLATION_MODES.includes(candidate) ? candidate : normalizedFallback;
}

function finiteNumber(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  const safeFallback = Number.isSafeInteger(Number(fallback)) && Number(fallback) > 0
    ? Number(fallback)
    : 1;
  if (value == null || String(value).trim() === "") return safeFallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return safeFallback;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : safeFallback;
}

function resolvePdfTranslationLimits({
  env = process.env,
  defaultMaxPages = 700,
} = {}) {
  const maxPages = positiveInteger(
    env && env.PDF_TRANSLATE_MAX_PAGES,
    defaultMaxPages,
  );
  // 스캔본만 별도로 30쪽에서 차단하던 상한은 완전히 폐지했다. Render에 과거
  // PDF_OCR_MAX_PAGES=30 값이 남아 있어도 적용하지 않으며, OCR도 전체 PDF 상한을
  // 따른다. 페이지별 픽셀·타일·요청 바이트 안전 예산은 별도 방어선으로 유지한다.
  return {
    maxPages,
    ocrMaxPages: maxPages,
  };
}

function resolvePdfTranslationMode({
  requestedMode = "auto",
  routing = {},
  restoreOnly = false,
  mathThreshold = process.env.PDF_AUTO_MATH_THRESHOLD,
} = {}) {
  const mode = normalizeRequestedMode(requestedMode);
  const scanned = !!(routing && routing.scanned);
  const mathDensity = finiteNumber(routing && routing.mathDensity, 0);
  const threshold = finiteNumber(mathThreshold, 12);
  const needsRetypeset = scanned || mathDensity >= threshold;
  let resolvedMode;

  if (restoreOnly || mode === "retypeset") {
    resolvedMode = "retypeset";
  } else if (mode === "inplace") {
    // Explicit in-place is respected for text PDFs. A scan has no replaceable
    // text boxes, so retypesetting is the only complete-output path.
    resolvedMode = scanned ? "retypeset" : "inplace";
  } else {
    resolvedMode = needsRetypeset ? "retypeset" : "inplace";
  }

  return {
    requestedMode: mode,
    resolvedMode,
    isAuto: mode === "auto",
    needsRetypeset,
    scanned,
    mathDensity,
    mathThreshold: threshold,
    restoreOnly: !!restoreOnly,
  };
}

function assertPdfTranslationInputCoverage({ routing = {}, maxPages } = {}) {
  const pageCount = Math.max(0, Number(routing && routing.pageCount) || 0);
  const tiles = Math.max(0, Number(routing && routing.tiles) || 0);
  const limit = positiveInteger(maxPages, 1);

  if (routing && routing.truncated) {
    throw qualityFailure(
      `OCR 입력 품질 검증 실패: ${pageCount || "?"}쪽 PDF의 페이지 이미지가 상한에 걸려 일부만 준비되었습니다. ` +
        "앞부분만 번역하지 않고 작업을 중단했습니다. 파일을 나누거나 OCR 상한을 조정한 뒤 다시 시도하세요.",
      { kind: "truncated_ocr_input", pageCount, tiles },
    );
  }

  if (pageCount > limit) {
    throw qualityFailure(
      `페이지가 너무 많습니다 (${pageCount}쪽 > 상한 ${limit}쪽). 파일을 나눠서 시도하세요.`,
      { kind: "pdf_page_limit_exceeded", pageCount, maxPages: limit },
    );
  }

  return { pageCount, maxPages: limit, truncated: false };
}

function assertEffectivePdfTranslationMode(value) {
  const mode = String(value || "");
  if (!EFFECTIVE_PDF_TRANSLATION_MODES.includes(mode)) {
    throw qualityFailure(
      `PDF 번역 최종 상태 검증 실패: 유효하지 않은 변환 방식(${mode || "없음"})입니다.`,
      { kind: "invalid_effective_mode", effectiveMode: mode || null },
    );
  }
  return mode;
}

function pdfTranslationOutputSuffix({ effectiveMode, restoreOnly = false } = {}) {
  const mode = assertEffectivePdfTranslationMode(effectiveMode);
  if (restoreOnly) return "_복원";
  return mode === "retypeset" ? "_재조판" : "_KO";
}

async function finalizePdfTranslationOutput({
  originalBuffer,
  resultBuffer,
  effectiveMode,
  restoreOnly = false,
  signal,
  onProgress = () => {},
  ocrEvidence = null,
  ocrRenderManifest = null,
  ocrSemanticReviewContext = null,
  requireOcrEvidence = false,
  ocrSemanticReviewBuilder = createOcrSemanticReviewForOutput,
  ocrRestoreVisualReviewBuilder = buildVisualReview,
  // Dependency injection is for deterministic unit tests. Production callers
  // rely on the strict shared verifier imported above.
  postflightVerifier = verifyPdfTranslationPostflight,
} = {}) {
  const mode = assertEffectivePdfTranslationMode(effectiveMode);
  const intent = restoreOnly ? "restore" : "translate";
  const pdfOutput = assertGeneratedOutputMagic(
    resultBuffer,
    "pdf",
    "PDF translation output",
  );

  let effectiveOcrSemanticReview = null;
  let effectiveOcrRestoreVisualReview = null;
  const needsOcrReview =
    requireOcrEvidence || ocrEvidence != null || ocrRenderManifest != null;
  if (
    intent === "translate" &&
    needsOcrReview
  ) {
    if (!ocrSemanticReviewContext || typeof ocrSemanticReviewContext !== "object") {
      throw qualityFailure(
        "스캔 재조판 번역의 독립 의미 검토 생성 정보가 없습니다. 결과를 제공하지 않습니다.",
        { kind: "ocr_semantic_review_context_missing" },
      );
    }
    onProgress("🧠 최종 PDF와 canonical OCR을 독립 모델로 의미 대조 중...");
    effectiveOcrSemanticReview = await ocrSemanticReviewBuilder({
      sourcePdf: originalBuffer,
      outputPdf: pdfOutput,
      ocrEvidence,
      ocrRenderManifest,
      signal,
      ...ocrSemanticReviewContext,
    });
    onProgress("✅ 독립 의미 검토와 출력 텍스트 해시 결합 완료");
  } else if (intent === "restore" && needsOcrReview) {
    if (!ocrSemanticReviewContext || typeof ocrSemanticReviewContext !== "object") {
      throw qualityFailure(
        "스캔 재조판 복원의 독립 시각 검토 생성 정보가 없습니다. 결과를 제공하지 않습니다.",
        { kind: "ocr_restore_visual_review_context_missing" },
      );
    }
    onProgress("👁️ 복원 PDF와 원본 스캔의 비텍스트·페이지 시각 보존을 독립 검토 중...");
    effectiveOcrRestoreVisualReview = await ocrRestoreVisualReviewBuilder({
      sourcePdf: originalBuffer,
      outputPdf: pdfOutput,
      ocrEvidence,
      ocrRenderManifest,
      intent: "restore",
      signal,
      ...ocrSemanticReviewContext,
    });
    onProgress("✅ 복원 시각 보존 검토와 출력 PDF 해시 결합 완료");
  }

  onProgress("🔬 원문과 결과 PDF를 대조해 최종 품질 검증 중...");
  const qualityReport = await postflightVerifier({
    originalBuffer,
    resultBuffer: pdfOutput,
    mode,
    intent,
    signal,
    ocrEvidence,
    ocrRenderManifest,
    ocrSemanticReview: effectiveOcrSemanticReview,
    ocrRestoreVisualReview: effectiveOcrRestoreVisualReview,
    ocrGenerationProvider:
      ocrSemanticReviewContext && ocrSemanticReviewContext.generationProvider,
    requireOcrEvidence,
  });
  if (
    !qualityReport ||
    qualityReport.passed !== true ||
    qualityReport.mode !== mode ||
    qualityReport.intent !== intent
  ) {
    throw qualityFailure(
      "PDF 번역 최종 상태 검증 실패: postflight 결과가 요청한 모드·의도와 일치하는 통과 보고서가 아닙니다.",
      {
        kind: "postflight_terminal_contract",
        expectedMode: mode,
        expectedIntent: intent,
        reportMode: qualityReport && qualityReport.mode,
        reportIntent: qualityReport && qualityReport.intent,
        reportPassed: qualityReport && qualityReport.passed,
      },
    );
  }
  onProgress("✅ 최종 품질 검증 통과 — 누락·손상 없는 결과만 제공합니다.");

  return {
    buffer: pdfOutput,
    effectiveMode: mode,
    intent,
    suffix: pdfTranslationOutputSuffix({ effectiveMode: mode, restoreOnly }),
    qualityReport,
  };
}

module.exports = {
  PDF_TRANSLATION_MODES,
  EFFECTIVE_PDF_TRANSLATION_MODES,
  normalizeRequestedMode,
  resolvePdfTranslationLimits,
  resolvePdfTranslationMode,
  assertPdfTranslationInputCoverage,
  assertEffectivePdfTranslationMode,
  assertCanonicalOcrChunkSubset,
  pdfTranslationOutputSuffix,
  finalizePdfTranslationOutput,
};
