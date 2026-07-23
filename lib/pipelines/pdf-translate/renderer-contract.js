"use strict";

// Renderer selection is deliberately separate from translation mode.
//
// mode=auto|inplace|retypeset decides the semantic/layout policy and therefore
// which postflight invariants apply. renderer only chooses the program that
// materializes an already-resolved retypeset document. Keeping the two axes
// separate prevents a missing LibreOffice installation from silently changing
// a user's requested translation policy.

const { qualityFailure } = require("./quality-gate");

const PDF_TRANSLATION_RENDERERS = Object.freeze([
  "auto",
  "tectonic",
  "libreoffice",
]);
const EFFECTIVE_PDF_TRANSLATION_RENDERERS = Object.freeze([
  "pymupdf",
  "tectonic",
  "libreoffice",
]);
const LIBREOFFICE_RENDERER_ENABLE_ENV = "PDF_TRANSLATE_LIBREOFFICE_ENABLED";
const ENABLED_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

class PdfTranslationRendererUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PdfTranslationRendererUnavailableError";
    this.code = "PDF_TRANSLATION_RENDERER_UNAVAILABLE";
    this.statusCode = 503;
    this.details = details;
  }
}

function isLibreOfficeRendererConfigured(env = process.env) {
  return ENABLED_ENV_VALUES.has(
    String(env && env[LIBREOFFICE_RENDERER_ENABLE_ENV] || "")
      .trim()
      .toLowerCase(),
  );
}

function probeLibreOfficeRenderer({
  env = process.env,
  findLibreOfficeBinary,
} = {}) {
  if (!isLibreOfficeRendererConfigured(env)) {
    return {
      available: false,
      reason: "disabled_by_configuration",
      binary: null,
    };
  }
  if (typeof findLibreOfficeBinary !== "function") {
    return {
      available: false,
      reason: "binary_probe_unavailable",
      binary: null,
    };
  }
  try {
    const binary = findLibreOfficeBinary({ env });
    if (!binary) {
      return {
        available: false,
        reason: "binary_unavailable",
        binary: null,
      };
    }
    return { available: true, reason: null, binary };
  } catch (_) {
    return {
      available: false,
      reason: "binary_unavailable",
      binary: null,
    };
  }
}

function getPdfTranslationRendererCapabilities(options = {}) {
  const libreoffice = probeLibreOfficeRenderer(options);
  return {
    version: 1,
    defaultRenderer: "auto",
    renderers: {
      auto: { available: true },
      pymupdf: { available: true },
      tectonic: { available: true },
      libreoffice: { available: libreoffice.available },
    },
  };
}

function assertLibreOfficeRendererAvailable(options = {}) {
  const capability = probeLibreOfficeRenderer(options);
  if (!capability.available) {
    const message = capability.reason === "disabled_by_configuration"
      ? `LibreOffice PDF 출력 엔진은 서버에서 비활성화되어 있습니다(${LIBREOFFICE_RENDERER_ENABLE_ENV}=1 필요).`
      : "LibreOffice PDF 출력 엔진을 현재 서버에서 사용할 수 없습니다.";
    throw new PdfTranslationRendererUnavailableError(message, {
      renderer: "libreoffice",
      reason: capability.reason,
    });
  }
  return capability.binary;
}

function normalizeRequestedRenderer(value, fallback = "auto") {
  const normalizedFallback = PDF_TRANSLATION_RENDERERS.includes(String(fallback))
    ? String(fallback)
    : "auto";
  const candidate = String(value == null ? "" : value).trim().toLowerCase();
  return PDF_TRANSLATION_RENDERERS.includes(candidate)
    ? candidate
    : normalizedFallback;
}

function assertEffectivePdfTranslationRenderer(value) {
  const renderer = String(value || "");
  if (!EFFECTIVE_PDF_TRANSLATION_RENDERERS.includes(renderer)) {
    throw qualityFailure(
      `PDF 번역 렌더러 검증 실패: 유효하지 않은 렌더러(${renderer || "없음"})입니다.`,
      {
        kind: "invalid_effective_renderer",
        effectiveRenderer: renderer || null,
      },
    );
  }
  return renderer;
}

function resolvePdfTranslationRenderer({
  requestedRenderer = "auto",
  effectiveMode,
} = {}) {
  const requested = normalizeRequestedRenderer(requestedRenderer);
  const mode = String(effectiveMode || "");
  if (!["inplace", "retypeset"].includes(mode)) {
    throw qualityFailure(
      `PDF 번역 렌더러를 결정할 수 없는 변환 방식(${mode || "없음"})입니다.`,
      { kind: "invalid_effective_mode", effectiveMode: mode || null },
    );
  }

  // In-place output is always produced by the geometry-preserving PyMuPDF
  // renderer. A requested retypeset renderer is remembered for telemetry/UI but
  // cannot change the already-resolved mode.
  const effectiveRenderer = mode === "inplace"
    ? "pymupdf"
    : requested === "libreoffice"
      ? "libreoffice"
      : "tectonic";

  return {
    requestedRenderer: requested,
    effectiveRenderer: assertEffectivePdfTranslationRenderer(effectiveRenderer),
    effectiveMode: mode,
    applies: mode === "retypeset",
    isAuto: requested === "auto",
  };
}

module.exports = {
  PDF_TRANSLATION_RENDERERS,
  EFFECTIVE_PDF_TRANSLATION_RENDERERS,
  LIBREOFFICE_RENDERER_ENABLE_ENV,
  PdfTranslationRendererUnavailableError,
  normalizeRequestedRenderer,
  assertEffectivePdfTranslationRenderer,
  isLibreOfficeRendererConfigured,
  probeLibreOfficeRenderer,
  getPdfTranslationRendererCapabilities,
  assertLibreOfficeRendererAvailable,
  resolvePdfTranslationRenderer,
};
