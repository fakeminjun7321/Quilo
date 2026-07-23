// PDF translation completeness checks shared by the main and standalone servers.
// These helpers are deliberately pure so partial-success cases can be regression-tested
// without starting either server or calling an external model.

const PDF_TRANSLATION_QUALITY_ERROR = "PDF_TRANSLATION_QUALITY_FAILURE";
const DEFAULT_MIN_FONT_PT = 8;

function qualityFailure(message, details = {}) {
  const error = new Error(message);
  error.code = PDF_TRANSLATION_QUALITY_ERROR;
  error.details = details;
  return error;
}

function findMissingTranslationIds(blocks, translations) {
  const map = translations && typeof translations === "object" ? translations : {};
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => {
      const value = map[String(block && block.id)];
      return typeof value !== "string" || !value.trim();
    })
    .map((block) => String(block && block.id));
}

function assertCompleteTranslations(blocks, translations, { context = "PDF 번역" } = {}) {
  const expected = Array.isArray(blocks) ? blocks.length : 0;
  const missingIds = findMissingTranslationIds(blocks, translations);
  if (missingIds.length) {
    const preview = missingIds.slice(0, 8).join(", ");
    const more = missingIds.length > 8 ? ` 외 ${missingIds.length - 8}개` : "";
    throw qualityFailure(
      `${context} 품질 검증 실패: 전체 ${expected}개 문단 중 ${missingIds.length}개 문단의 번역을 받지 못했습니다` +
        ` (ID: ${preview}${more}). 미번역 원문을 섞지 않고 작업을 중단했습니다.`,
      { kind: "missing_translations", expected, missingIds },
    );
  }
  return { expected, translated: expected, missingIds: [] };
}

function resolveMinFontThreshold(value = process.env.PDF_TRANSLATE_MIN_FONT_PT) {
  if (value == null || String(value).trim() === "") return DEFAULT_MIN_FONT_PT;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULT_MIN_FONT_PT;
}

function finiteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assertCompleteRender(
  stats,
  expectedBlocks,
  {
    context = "PDF 번역 렌더링",
    minFontPt = resolveMinFontThreshold(),
    allowedPreservedOriginalIds = [],
  } = {},
) {
  const value = stats && typeof stats === "object" ? stats : {};
  const expected = Math.max(0, Number(expectedBlocks) || 0);
  const replaced = Math.max(0, Number(value.replaced) || 0);
  const overflow = Math.max(0, Number(value.overflow) || 0);
  const failed = Math.max(0, Number(value.failed) || 0);
  const overflowIds = Array.isArray(value.overflow_ids)
    ? value.overflow_ids.map(String)
    : [];
  const failedIds = Array.isArray(value.failed_ids) ? value.failed_ids.map(String) : [];
  // min_font는 본문 base 크기다. 첨자/위첨자의 정상적인 0.66배 축소는
  // min_glyph_font에만 기록하고 가독성 gate 기준으로 사용하지 않는다.
  const minFont = finiteNumberOrNull(value.min_font);
  const minGlyphFont = finiteNumberOrNull(value.min_glyph_font);
  const hasFontExpected = Object.prototype.hasOwnProperty.call(value, "font_expected");
  const fontExpected = hasFontExpected
    ? Math.max(0, Number(value.font_expected) || 0)
    : expected;
  const rendererExpected = Object.prototype.hasOwnProperty.call(value, "expected")
    ? Math.max(0, Number(value.expected) || 0)
    : expected;
  const fontSizes = Array.isArray(value.font_sizes) ? value.font_sizes : [];
  const validFontSizes = fontSizes.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const source = finiteNumberOrNull(entry.source);
    const rendered = finiteNumberOrNull(entry.rendered);
    return source != null && rendered != null && source > 0 && rendered > 0;
  });
  const virtualExpected = Math.max(0, Number(value.outline_expected) || 0) +
    Math.max(0, Number(value.metadata_expected) || 0);
  const virtualReplaced = Math.max(0, Number(value.virtual_replaced) || 0);
  const hasPreservedOriginal = Object.prototype.hasOwnProperty.call(
    value,
    "preserved_original",
  );
  const hasPreservedOriginalIds = Object.prototype.hasOwnProperty.call(
    value,
    "preserved_original_ids",
  );
  const preservedOriginalRaw = hasPreservedOriginal
    ? finiteNumberOrNull(value.preserved_original)
    : 0;
  const preservedOriginal = Number.isInteger(preservedOriginalRaw) && preservedOriginalRaw >= 0
    ? preservedOriginalRaw
    : 0;
  const preservedOriginalIds = Array.isArray(value.preserved_original_ids)
    ? value.preserved_original_ids.map(String)
    : [];
  const uniquePreservedOriginalIds = new Set(preservedOriginalIds);
  const allowedPreservedIds = new Set(
    Array.from(allowedPreservedOriginalIds || [], (id) => String(id)),
  );
  const unknownPreservedOriginalIds = preservedOriginalIds.filter(
    (id) => !allowedPreservedIds.has(id),
  );
  const explicitPreservationContract = hasPreservedOriginal || hasPreservedOriginalIds;
  const preservationContractPresent = !explicitPreservationContract || (
    hasPreservedOriginal &&
    hasPreservedOriginalIds &&
    Number.isInteger(preservedOriginalRaw) &&
    preservedOriginalRaw >= 0 &&
    preservedOriginalIds.length === preservedOriginal &&
    uniquePreservedOriginalIds.size === preservedOriginalIds.length &&
    unknownPreservedOriginalIds.length === 0
  );
  const pageExpected = Math.max(0, Number(value.page_expected) || 0);
  const pageDrawn = Math.max(0, Number(value.page_drawn) || 0);
  const drawn = Math.max(0, Number(value.drawn) || 0);
  const hasRendererCompleted = Object.prototype.hasOwnProperty.call(value, "completed");
  const rendererCompleted = hasRendererCompleted
    ? finiteNumberOrNull(value.completed)
    : null;
  const completed = replaced + preservedOriginal;
  const completedContractPresent = !hasRendererCompleted || (
    Number.isInteger(rendererCompleted) &&
    rendererCompleted >= 0 &&
    rendererCompleted === completed
  );
  const virtualContractPresent = !hasFontExpected
    ? !explicitPreservationContract
    : (
      Number.isInteger(fontExpected) &&
      fontExpected <= expected &&
      rendererExpected === expected &&
      pageExpected + virtualExpected === expected &&
      fontExpected + preservedOriginal === pageExpected &&
      pageDrawn === fontExpected &&
      virtualReplaced === virtualExpected &&
      Math.max(0, Number(value.outline_replaced) || 0) ===
        Math.max(0, Number(value.outline_expected) || 0) &&
      Math.max(0, Number(value.metadata_replaced) || 0) ===
        Math.max(0, Number(value.metadata_expected) || 0) &&
      replaced === fontExpected + virtualExpected &&
      drawn === replaced
    );
  const diagnosticsPresent =
    Object.prototype.hasOwnProperty.call(value, "overflow") &&
    Object.prototype.hasOwnProperty.call(value, "failed") &&
    Array.isArray(value.overflow_ids) &&
    Array.isArray(value.failed_ids) &&
    Array.isArray(value.font_sizes) &&
    preservationContractPresent &&
    completedContractPresent &&
    virtualContractPresent &&
    (fontExpected === 0 || (
      minFont != null &&
      fontSizes.length === fontExpected &&
      validFontSizes.length === fontExpected
    ));
  const reasons = [];
  if (value.ok !== true) reasons.push("렌더러가 불완전 상태를 보고함");
  if (completed !== expected) {
    reasons.push(
      preservedOriginal > 0
        ? `문단 처리 ${completed}/${expected}(삽입 ${replaced}, 원본 보존 ${preservedOriginal})`
        : `문단 삽입 ${replaced}/${expected}`,
    );
  }
  if (!preservationContractPresent) {
    reasons.push("원본 글리프 보존 계약이 유효하지 않음");
  }
  if (!completedContractPresent) {
    reasons.push("렌더러 완료 합계 계약이 유효하지 않음");
  }
  if (!diagnosticsPresent) reasons.push("렌더 완전성 진단값이 없음");
  if (overflow) reasons.push(`글자 넘침 ${overflow}개(ID: ${overflowIds.join(", ") || "미상"})`);
  if (failed) reasons.push(`그리기 실패 ${failed}개(ID: ${failedIds.join(", ") || "미상"})`);
  if (reasons.length) {
    throw qualityFailure(
      `${context} 품질 검증 실패: ${reasons.join("; ")}. ` +
        "일부 원문이 남은 PDF를 제공하지 않고 작업을 중단했습니다.",
      {
        kind: "incomplete_render",
        expected,
        replaced,
        completed,
        preservedOriginal,
        preservedOriginalIds,
        unknownPreservedOriginalIds,
        preservationContractPresent,
        rendererCompleted,
        completedContractPresent,
        overflow,
        failed,
        overflowIds,
        failedIds,
        diagnosticsPresent,
        rendererOk: value.ok === true,
        minFont,
        minGlyphFont,
        fontExpected,
        fontSizes,
      },
    );
  }
  const threshold = resolveMinFontThreshold(minFontPt);
  const fontViolations = threshold > 0
    ? validFontSizes.filter((entry) => {
        const source = finiteNumberOrNull(entry.source);
        const rendered = finiteNumberOrNull(entry.rendered);
        const required = Math.min(source, threshold);
        return rendered + 0.05 < required;
      })
    : [];
  if (fontViolations.length) {
    const preview = fontViolations
      .slice(0, 8)
      .map((entry) => `${entry.id}:${entry.source}→${entry.rendered}pt`)
      .join(", ");
    throw qualityFailure(
      `${context} 가독성 검증 실패: ${fontViolations.length}개 문단이 원문 크기 또는 ${threshold}pt 기준보다 작아졌습니다` +
        `${preview ? ` (${preview})` : ""}. ` +
        "내용을 억지로 축소한 PDF를 제공하지 않고 작업을 중단했습니다. 파일을 나누거나 재조판 방식으로 다시 시도하세요.",
      {
        kind: "unreadable_font_size",
        expected,
        replaced,
        minFont,
        minGlyphFont,
        threshold,
        fontViolations,
      },
    );
  }
  const result = {
    expected,
    replaced,
    overflow,
    failed,
    minFont,
    minGlyphFont,
    fontSizes,
  };
  if (explicitPreservationContract) {
    result.completed = completed;
    result.preservedOriginal = preservedOriginal;
    result.preservedOriginalIds = preservedOriginalIds;
  }
  return result;
}

function assertCompleteRasterization(
  meta,
  { preparedCount = null, context = "OCR 래스터화" } = {},
) {
  const value = meta && typeof meta === "object" ? meta : {};
  const pageCount = Math.max(0, Number(value.page_count) || 0);
  const renderedPages = Math.max(0, Number(value.rendered_pages) || 0);
  const files = Array.isArray(value.files) ? value.files : [];
  const tileCount = Math.max(0, Number(value.tiles) || 0);
  const reasons = [];

  if (value.truncated) {
    reasons.push(`전체 ${pageCount}쪽 중 ${renderedPages}쪽만 렌더링됨`);
  }
  if (pageCount <= 0) reasons.push("원본 페이지 수를 확인할 수 없음");
  if (renderedPages !== pageCount) {
    reasons.push(`페이지 커버리지 ${renderedPages}/${pageCount}`);
  }
  if (!files.length) reasons.push("생성된 페이지 이미지가 없음");
  if (tileCount !== files.length) {
    reasons.push(`타일 메타데이터 불일치 ${files.length}/${tileCount}`);
  }
  if (preparedCount != null && Number(preparedCount) !== files.length) {
    reasons.push(`모델 입력 타일 준비 ${Number(preparedCount) || 0}/${files.length}`);
  }

  if (reasons.length) {
    throw qualityFailure(
      `${context} 품질 검증 실패: ${reasons.join("; ")}. 일부 페이지만 번역하지 않고 작업을 중단했습니다. ` +
        "PDF를 더 작은 파일로 나누거나 OCR 페이지·타일 상한을 조정한 뒤 다시 시도하세요.",
      {
        kind: "incomplete_rasterization",
        pageCount,
        renderedPages,
        tileCount,
        fileCount: files.length,
        preparedCount: preparedCount == null ? null : Number(preparedCount) || 0,
      },
    );
  }
  return { pageCount, renderedPages, tileCount, preparedCount };
}

function assertCompleteChunkResults(
  results,
  { expectedCount, context = "OCR 재조판" } = {},
) {
  const list = Array.isArray(results) ? results : [];
  const expected = Math.max(0, Number(expectedCount) || list.length);
  const incomplete = [];
  for (let i = 0; i < expected; i += 1) {
    const result = list[i];
    if (!result || result.fellBack || result.error || !result.partPath) incomplete.push(i + 1);
  }
  if (incomplete.length) {
    throw qualityFailure(
      `${context} 품질 검증 실패: 전체 ${expected}개 구간 중 ${incomplete.length}개 구간이 완성되지 않았습니다 ` +
        `(구간: ${incomplete.join(", ")}). 미번역 원문 또는 빈 구간을 병합하지 않고 작업을 중단했습니다.`,
      { kind: "incomplete_chunks", expected, incomplete },
    );
  }
  return { expected, complete: expected };
}

function mayFallbackRetypesetToInplace({ requestedMode, restoreOnly = false } = {}) {
  // 재조판이 선택된 시점에는 명시 선택 여부와 무관하게 수식·깨진 폰트·OCR 등
  // in-place가 안전하지 않은 근거가 있다. 실패를 빠른 번역으로 조용히 강등하지 않는다.
  void requestedMode;
  void restoreOnly;
  return false;
}

module.exports = {
  PDF_TRANSLATION_QUALITY_ERROR,
  qualityFailure,
  findMissingTranslationIds,
  assertCompleteTranslations,
  resolveMinFontThreshold,
  assertCompleteRender,
  assertCompleteRasterization,
  assertCompleteChunkResults,
  mayFallbackRetypesetToInplace,
};
