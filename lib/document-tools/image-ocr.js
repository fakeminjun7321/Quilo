"use strict";

const path = require("node:path");
const sharp = require("sharp");

const OCR_BASE_URL = String(process.env.MISTRAL_API_BASE || "https://api.mistral.ai/v1").replace(/\/+$/, "");
const OCR_MODEL = process.env.MISTRAL_OCR_MODEL || "mistral-ocr-latest";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const TARGET_IMAGE_BYTES = 19 * 1024 * 1024;
const MAX_IMAGE_PIXELS = Math.max(1, parseInt(process.env.IMAGE_OCR_MAX_PIXELS || "80000000", 10));
const MAX_IMAGE_EDGE = Math.max(1800, Math.min(8000, parseInt(process.env.IMAGE_OCR_MAX_EDGE || "6000", 10)));
const OCR_TIMEOUT_MS = Math.max(30_000, Math.min(240_000, parseInt(process.env.IMAGE_OCR_TIMEOUT_MS || "150000", 10)));
const OCR_REQUEST_ATTEMPTS = Math.max(1, Math.min(3, parseInt(process.env.IMAGE_OCR_REQUEST_ATTEMPTS || "2", 10)));
const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".bmp", ".avif"]);

class OcrInputError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = "OcrInputError";
    this.status = status;
  }
}

function originalBuffer(file) {
  const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.from(file?.buffer || []);
  if (!buffer.length) throw new OcrInputError("비어 있는 이미지입니다.");
  if (buffer.length > MAX_IMAGE_BYTES) throw new OcrInputError("이미지는 20MB 이하만 지원합니다.", 413);
  const name = String(file?.originalname || file?.name || "image");
  const ext = path.extname(name).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext) && !String(file?.mimetype || "").startsWith("image/")) {
    throw new OcrInputError("PNG, JPG, WEBP, GIF, TIFF, BMP, AVIF 이미지만 지원합니다.");
  }
  return { buffer, name };
}

function pipelineFor(buffer, {
  variant = "standard",
  edge = MAX_IMAGE_EDGE,
  allowEnlargement = false,
} = {}) {
  let pipeline = sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS, animated: false })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize({
      width: edge,
      height: edge,
      fit: "inside",
      withoutEnlargement: !allowEnlargement,
      kernel: sharp.kernel.lanczos3,
    });
  if (variant === "contrast") {
    pipeline = pipeline
      .greyscale()
      .clahe({ width: 3, height: 3, maxSlope: 3 })
      .sharpen({ sigma: 1.05, m1: 0.75, m2: 1.6 });
  } else if (variant === "handwriting") {
    // Preserve coloured pen strokes while lifting faint paper scans.  This
    // complements the greyscale pass instead of erasing blue/red handwriting.
    pipeline = pipeline
      .modulate({ brightness: 1.04, saturation: 1.18 })
      .linear(1.12, -10)
      .sharpen({ sigma: 0.85, m1: 0.55, m2: 1.25 });
  } else if (variant === "binary") {
    // Printed exam sheets and faint photocopies benefit from a hard black/white
    // pass. It is only one candidate; colour handwriting is retained by the
    // separate handwriting pass.
    pipeline = pipeline
      .greyscale()
      .clahe({ width: 4, height: 4, maxSlope: 3 })
      .median(1)
      .threshold(176)
      .sharpen({ sigma: 0.65, m1: 0.45, m2: 1.1 });
  }
  return pipeline;
}

async function prepareImageForOcr(file, { enhanced = false, variant = "" } = {}) {
  const { buffer, name } = originalBuffer(file);
  let metadata;
  try {
    metadata = await sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS, animated: false }).metadata();
  } catch (error) {
    throw new OcrInputError(`이미지를 읽을 수 없습니다: ${error.message}`);
  }
  const width = Number(metadata.width) || 0;
  const height = Number(metadata.height) || 0;
  if (!width || !height) throw new OcrInputError("이미지 크기를 확인할 수 없습니다.");

  const selectedVariant = variant || (enhanced ? "contrast" : "standard");
  if (!new Set(["standard", "contrast", "handwriting", "binary"]).has(selectedVariant)) {
    throw new OcrInputError("지원하지 않는 OCR 전처리 방식입니다.");
  }
  const naturalEdge = Math.max(width, height);
  const allowEnlargement = selectedVariant !== "standard" && naturalEdge < 2600;
  const targetEdge = allowEnlargement
    ? Math.min(MAX_IMAGE_EDGE, Math.max(2400, naturalEdge * 2))
    : MAX_IMAGE_EDGE;
  const screenshotLike = ["png", "gif", "tiff", "svg"].includes(String(metadata.format || "")) && selectedVariant === "standard";
  let output;
  let mediaType;
  try {
    if (screenshotLike) {
      output = await pipelineFor(buffer, { variant: selectedVariant, edge: targetEdge, allowEnlargement })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
      mediaType = "image/png";
    } else {
      output = await pipelineFor(buffer, { variant: selectedVariant, edge: targetEdge, allowEnlargement })
        .jpeg({ quality: selectedVariant === "standard" ? 96 : 95, chromaSubsampling: "4:4:4", mozjpeg: true })
        .toBuffer();
      mediaType = "image/jpeg";
    }

    if (output.length > TARGET_IMAGE_BYTES) {
      let reduced = null;
      for (const edge of [5200, 4400, 3600, 3000, 2400]) {
        for (const quality of [92, 86, 80, 72]) {
          const candidate = await pipelineFor(buffer, { variant: selectedVariant, edge })
            .jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: true })
            .toBuffer();
          if (candidate.length <= TARGET_IMAGE_BYTES) {
            reduced = candidate;
            break;
          }
        }
        if (reduced) break;
      }
      if (!reduced) throw new OcrInputError("OCR 제공자 제한(20MB)에 맞게 이미지를 최적화하지 못했습니다.", 413);
      output = reduced;
      mediaType = "image/jpeg";
    }
  } catch (error) {
    if (error instanceof OcrInputError) throw error;
    throw new OcrInputError(`OCR 이미지 전처리에 실패했습니다: ${error.message}`);
  }

  return {
    buffer: output,
    mediaType,
    name,
    originalBytes: buffer.length,
    finalBytes: output.length,
    originalWidth: width,
    originalHeight: height,
    enhanced: selectedVariant !== "standard",
    variant: selectedVariant,
  };
}

function providerError(payload, status) {
  const detail = payload?.message || payload?.detail || payload?.error?.message || payload?.error;
  return String(detail || `OCR 제공자 오류(${status})`).slice(0, 500);
}

function ocrRequestError(message, status, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "OcrRequestError";
  error.status = status;
  error.code = code;
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError"
    || error?.code === "ABORT_ERR"
    || /\b(?:operation was )?aborted\b/i.test(String(error?.message || ""));
}

function isRetryableProviderStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryDelay(attempt) {
  return new Promise((resolve) => setTimeout(resolve, Math.min(1_500, 350 * attempt)));
}

async function requestOcr(prepared, {
  apiKey,
  baseUrl = OCR_BASE_URL,
  model = OCR_MODEL,
  fetchImpl = globalThis.fetch,
  includeBlocks = true,
  tableFormat = "markdown",
  signal,
  timeoutMs = OCR_TIMEOUT_MS,
  maxAttempts = OCR_REQUEST_ATTEMPTS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("OCR 요청 기능을 사용할 수 없습니다.");
  const externalSignal = signal && typeof signal.addEventListener === "function" ? signal : null;
  const attempts = Math.max(1, Math.min(3, Number(maxAttempts) || 1));
  const requestBody = JSON.stringify({
    model,
    document: {
      type: "image_url",
      image_url: `data:${prepared.mediaType};base64,${prepared.buffer.toString("base64")}`,
    },
    include_blocks: !!includeBlocks,
    include_image_base64: false,
    extract_header: true,
    extract_footer: true,
    confidence_scores_granularity: "word",
    table_format: tableFormat === "html" ? "html" : "markdown",
  });

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (externalSignal?.aborted) {
      throw ocrRequestError("OCR 요청 연결이 중단되었습니다. 이미지를 다시 선택해 시도하세요.", 499, "OCR_CLIENT_ABORTED");
    }
    externalSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}/ocr`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: requestBody,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = ocrRequestError(providerError(payload, response.status), 502, "OCR_PROVIDER_ERROR");
        error.providerStatus = response.status;
        throw error;
      }
      if (!Array.isArray(payload.pages) || !payload.pages.length) {
        throw ocrRequestError("OCR 결과에 페이지가 없습니다.", 502, "OCR_EMPTY_RESULT");
      }
      return payload;
    } catch (error) {
      if (externalSignal?.aborted) {
        throw ocrRequestError("OCR 요청 연결이 중단되었습니다. 이미지를 다시 선택해 시도하세요.", 499, "OCR_CLIENT_ABORTED", error);
      }
      if (timedOut) {
        throw ocrRequestError("이미지 OCR 처리 시간이 초과되었습니다. 잠시 후 다시 시도하세요.", 504, "OCR_TIMEOUT", error);
      }

      const providerAborted = isAbortError(error);
      const transientProviderError = isRetryableProviderStatus(Number(error?.providerStatus));
      const networkError = error?.name === "TypeError";
      if ((providerAborted || transientProviderError || networkError) && attempt < attempts) {
        await retryDelay(attempt);
        continue;
      }
      if (providerAborted) {
        throw ocrRequestError("OCR 제공자 연결이 일시적으로 중단되었습니다. 잠시 후 다시 시도하세요.", 502, "OCR_PROVIDER_ABORTED", error);
      }
      if (networkError) {
        throw ocrRequestError("OCR 제공자에 연결하지 못했습니다. 잠시 후 다시 시도하세요.", 502, "OCR_PROVIDER_NETWORK", error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abort);
    }
  }

  throw ocrRequestError("이미지 OCR 요청을 완료하지 못했습니다.", 502, "OCR_REQUEST_FAILED");
}

function confidenceFromPayload(payload) {
  const pageScores = [];
  const minimumScores = [];
  const wordScores = [];
  for (const page of payload?.pages || []) {
    const scores = page?.confidence_scores || {};
    const average = Number(scores.average_page_confidence_score);
    const minimum = Number(scores.minimum_page_confidence_score);
    if (Number.isFinite(average)) pageScores.push(average);
    if (Number.isFinite(minimum)) minimumScores.push(minimum);
    for (const word of scores.word_confidence_scores || []) {
      const value = Number(word?.confidence != null ? word.confidence : word?.score);
      if (Number.isFinite(value)) wordScores.push(value);
    }
  }
  const average = wordScores.length
    ? wordScores.reduce((sum, value) => sum + value, 0) / wordScores.length
    : pageScores.length
      ? pageScores.reduce((sum, value) => sum + value, 0) / pageScores.length
      : null;
  const minima = minimumScores.length ? minimumScores : wordScores;
  const lowConfidenceWords = wordScores.filter((value) => value < 0.8).length;
  const strongWords = wordScores.filter((value) => value >= 0.95).length;
  return {
    average: average == null ? null : Math.max(0, Math.min(1, average)),
    minimum: minima.length ? Math.max(0, Math.min(1, Math.min(...minima))) : null,
    words: wordScores.length,
    lowConfidenceWords,
    lowConfidenceRate: wordScores.length ? lowConfidenceWords / wordScores.length : null,
    strongWordRate: wordScores.length ? strongWords / wordScores.length : null,
  };
}

function textFromPayload(payload) {
  return (payload?.pages || []).map((page) => String(page?.markdown || "")).join("\n\n").trim();
}

function payloadScore(payload) {
  const confidence = confidenceFromPayload(payload);
  const visibleChars = textFromPayload(payload).replace(/\s|[#*|`_~-]/g, "").length;
  const average = confidence.average == null ? 0.5 : confidence.average;
  const minimum = confidence.minimum == null ? average : confidence.minimum;
  const strong = confidence.strongWordRate == null ? average : confidence.strongWordRate;
  const corrupt = (textFromPayload(payload).match(/�/g) || []).length;
  return average * 720 + minimum * 120 + strong * 150 + Math.min(visibleChars, 5000) / 50 - corrupt * 25;
}

function layoutQualityFromPayload(payload) {
  let total = 0;
  let positioned = 0;
  let structural = 0;
  let linked = 0;
  const richTypes = new Set(["title", "list", "table", "image", "equation", "caption", "aside_text"]);
  for (const page of payload?.pages || []) {
    const tableIds = new Set((page?.tables || []).map((table) => String(table?.id || table?.table_id || "")));
    const imageIds = new Set((page?.images || []).map((image) => String(image?.id || image?.name || "")));
    for (const block of page?.blocks || []) {
      total += 1;
      const coords = [block?.top_left_x, block?.top_left_y, block?.bottom_right_x, block?.bottom_right_y].map(Number);
      if (coords.every(Number.isFinite) && coords[2] > coords[0] && coords[3] > coords[1]) positioned += 1;
      const type = String(block?.type || "text").toLowerCase();
      if (richTypes.has(type)) structural += 1;
      if (type === "table" && tableIds.has(String(block?.table_id || block?.tableId || ""))) linked += 1;
      if (type === "image" && imageIds.has(String(block?.image_id || block?.imageId || ""))) linked += 1;
    }
  }
  if (!total) return { score: 0, total: 0, positioned: 0, structural: 0, linked: 0 };
  const score = Math.max(0, Math.min(1,
    positioned / total * 0.68
    + Math.min(1, total / 8) * 0.16
    + Math.min(1, structural / 3) * 0.1
    + Math.min(1, linked / 2) * 0.06));
  return { score, total, positioned, structural, linked };
}

function textAgreement(left, right) {
  const normalize = (value) => String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[#*|`_~<>]/g, "");
  const a = normalize(left);
  const b = normalize(right);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (value) => {
    const out = new Set();
    if (value.length < 2) out.add(value);
    else for (let i = 0; i < value.length - 1; i += 1) out.add(value.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  ga.forEach((gram) => { if (gb.has(gram)) overlap += 1; });
  return overlap / Math.max(1, ga.size + gb.size - overlap);
}

function rankCandidates(candidates) {
  return candidates.map((candidate, index) => {
    const comparisons = candidates
      .map((other, otherIndex) => otherIndex === index
        ? null
        : textAgreement(textFromPayload(candidate.payload), textFromPayload(other.payload)))
      .filter(Number.isFinite);
    const consensus = comparisons.length
      ? comparisons.reduce((sum, value) => sum + value, 0) / comparisons.length
      : 1;
    const confidence = confidenceFromPayload(candidate.payload);
    const average = confidence.average == null ? 0.5 : confidence.average;
    const minimum = confidence.minimum == null ? average : confidence.minimum;
    const strong = confidence.strongWordRate == null ? average : confidence.strongWordRate;
    const providerScore = Math.max(0, Math.min(1, payloadScore(candidate.payload) / 1090));
    const layout = layoutQualityFromPayload(candidate.payload);
    const consensusScore = consensus * 0.44
      + average * 0.23
      + minimum * 0.07
      + strong * 0.08
      + providerScore * 0.06
      + layout.score * 0.12;
    return { ...candidate, consensus, consensusScore, layout };
  }).sort((a, b) => b.consensusScore - a.consensusScore);
}

function normalizeContentBlock(block, index) {
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    type: String(block?.type || "text").trim().toLowerCase().slice(0, 40),
    content: String(block?.content || "").slice(0, 120_000),
    topLeftX: number(block?.top_left_x ?? block?.topLeftX),
    topLeftY: number(block?.top_left_y ?? block?.topLeftY),
    bottomRightX: number(block?.bottom_right_x ?? block?.bottomRightX),
    bottomRightY: number(block?.bottom_right_y ?? block?.bottomRightY),
    ...(block?.table_id || block?.tableId ? { tableId: String(block.table_id || block.tableId).slice(0, 180) } : {}),
    ...(block?.image_id || block?.imageId ? { imageId: String(block.image_id || block.imageId).slice(0, 180) } : {}),
    order: index,
  };
}

function normalizeTableBlock(table, index) {
  return {
    id: String(table?.id || table?.table_id || `table-${index + 1}`).slice(0, 180),
    content: String(table?.content || table?.html || table?.markdown || "").slice(0, 300_000),
    format: String(table?.format || (/^\s*<table\b/i.test(String(table?.content || "")) ? "html" : "markdown")).slice(0, 20),
  };
}

function normalizeImageBlock(image, index) {
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  const normalized = {
    id: String(image?.id || image?.name || `image-${index + 1}`).slice(0, 180),
    topLeftX: number(image?.top_left_x ?? image?.topLeftX),
    topLeftY: number(image?.top_left_y ?? image?.topLeftY),
    bottomRightX: number(image?.bottom_right_x ?? image?.bottomRightX),
    bottomRightY: number(image?.bottom_right_y ?? image?.bottomRightY),
  };
  const annotation = String(image?.image_annotation || image?.imageAnnotation || "").trim();
  if (annotation) normalized.annotation = annotation.slice(0, 4000);
  return normalized;
}

function normalizePage(page, index, includeBlocks) {
  const scores = page?.confidence_scores || null;
  return {
    page: Number.isInteger(page?.index) ? page.index + 1 : index + 1,
    markdown: String(page?.markdown || ""),
    ...(Array.isArray(page?.tables) ? { tables: page.tables.slice(0, 80).map(normalizeTableBlock) } : {}),
    ...(Array.isArray(page?.images) ? { images: page.images.slice(0, 40).map(normalizeImageBlock) } : {}),
    ...(includeBlocks && Array.isArray(page?.blocks) ? { blocks: page.blocks.slice(0, 800).map(normalizeContentBlock) } : {}),
    ...(Array.isArray(page?.hyperlinks) ? { hyperlinks: page.hyperlinks } : {}),
    ...(page?.header ? { header: String(page.header) } : {}),
    ...(page?.footer ? { footer: String(page.footer) } : {}),
    ...(page?.dimensions ? { dimensions: page.dimensions } : {}),
    ...(scores ? {
      confidence: {
        average: Number.isFinite(Number(scores.average_page_confidence_score))
          ? Number(scores.average_page_confidence_score)
          : null,
        minimum: Number.isFinite(Number(scores.minimum_page_confidence_score))
          ? Number(scores.minimum_page_confidence_score)
          : null,
      },
    } : {}),
  };
}

async function extractImageText(file, {
  includeBlocks = true,
  tableFormat = "html",
  mode = "quality",
  signal,
  apiKey = process.env.MISTRAL_API_KEY,
  fetchImpl = globalThis.fetch,
  baseUrl = OCR_BASE_URL,
  model = OCR_MODEL,
} = {}) {
  if (!apiKey) throw new Error("MISTRAL_API_KEY가 설정되지 않았습니다.");
  const prepared = await prepareImageForOcr(file);
  const requestOptions = { apiKey, baseUrl, model, fetchImpl, includeBlocks, tableFormat, signal };
  const first = await requestOcr(prepared, requestOptions);
  // Public OCR now has one quality level. Keep the option in the function
  // signature for older API callers, but intentionally ignore fast/accurate.
  const normalizedMode = "quality";
  const candidates = [{ payload: first, prepared }];
  const warnings = [];
  const variants = ["contrast", "handwriting", "binary"];
  // Quality comparison passes are independent. Preparing and requesting them
  // together keeps multi-pass accuracy without multiplying user wait time.
  const preparedComparisons = await Promise.all(variants.map(async (variant) => {
    try {
      const candidatePrepared = await prepareImageForOcr(file, { variant });
      return { variant, prepared: candidatePrepared };
    } catch (error) {
      // Optional comparison passes must never discard a usable first result.
      warnings.push(`${variant}: ${String(error?.message || "재판독 실패").slice(0, 150)}`);
      return null;
    }
  }));
  const comparisonResults = await Promise.all(preparedComparisons.map(async (comparison) => {
    if (!comparison) return null;
    try {
      const payload = await requestOcr(comparison.prepared, requestOptions);
      return { payload, prepared: comparison.prepared };
    } catch (error) {
      warnings.push(`${comparison.variant}: ${String(error?.message || "재판독 실패").slice(0, 150)}`);
      return null;
    }
  }));
  candidates.push(...comparisonResults.filter(Boolean));
  const ranked = rankCandidates(candidates);
  const selectedCandidate = ranked[0];
  const selected = selectedCandidate.payload;
  const selectedPrepared = selectedCandidate.prepared;
  const agreement = selectedCandidate.consensus;
  const layoutConfidence = selectedCandidate.layout?.score || 0;

  const pages = selected.pages.map((page, index) => normalizePage(page, index, includeBlocks));
  const confidence = confidenceFromPayload(selected);
  const average = confidence.average == null ? 0.5 : confidence.average;
  const minimum = confidence.minimum == null ? average : confidence.minimum;
  const strong = confidence.strongWordRate == null ? average : confidence.strongWordRate;
  const verifiedConfidence = Math.max(0, Math.min(1,
    average * 0.55 + agreement * 0.3 + minimum * 0.1 + strong * 0.05));
  const reviewRequired = verifiedConfidence < 0.95
    || (confidence.minimum != null && confidence.minimum < 0.72)
    || agreement < 0.9
    || layoutConfidence < 0.75
    || ranked.length < 3;
  return {
    model: selected.model || model,
    pages,
    text: pages.map((page) => page.markdown).join("\n\n").trim(),
    confidence,
    quality: {
      agreement,
      verifiedConfidence,
      layoutConfidence,
      reviewRequired,
      selectedVariant: selectedPrepared.variant,
      successfulPasses: ranked.length,
      candidateScores: ranked.map((candidate) => ({
        variant: candidate.prepared.variant,
        score: Number((candidate.consensusScore * 100).toFixed(2)),
        agreement: candidate.consensus,
        confidence: confidenceFromPayload(candidate.payload).average,
        layoutConfidence: candidate.layout?.score || 0,
      })),
    },
    usage: selected.usage_info || null,
    source: {
      filename: selectedPrepared.name,
      originalBytes: selectedPrepared.originalBytes,
      processedBytes: selectedPrepared.finalBytes,
      width: selectedPrepared.originalWidth,
      height: selectedPrepared.originalHeight,
      enhanced: selectedPrepared.enhanced,
      variant: selectedPrepared.variant,
      enhancedRetry: true,
      ...(warnings.length ? { enhancedRetryWarning: warnings.join(" · ").slice(0, 400) } : {}),
      passes: candidates.length,
      attemptedPasses: 4,
      mode: normalizedMode,
    },
  };
}

module.exports = {
  MAX_IMAGE_BYTES,
  OcrInputError,
  confidenceFromPayload,
  extractImageText,
  layoutQualityFromPayload,
  prepareImageForOcr,
  textAgreement,
};
