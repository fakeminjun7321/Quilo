"use strict";

const GEMINI_REPORT_MODELS = Object.freeze([
  "gemini-3.1-pro",
  "gemini-2.5-flash",
]);

const GEMINI_REPORT_TYPES = new Set([
  "chem-pre",
  "chem-result",
  "phys-result",
  "free",
]);

function serverModelProviderAvailability(env = process.env) {
  return {
    anthropic: !!env.ANTHROPIC_API_KEY,
    openai: !!(env.GPT_API_KEY || env.OPENAI_API_KEY),
    gemini: !!env.GEMINI_API_KEY,
  };
}

function mergeUserModelProviderAvailability(serverProviders, userKeys) {
  const base = serverProviders || {};
  const keys = userKeys || {};
  return {
    anthropic: !!base.anthropic || !!keys.anthropic,
    openai: !!base.openai || !!keys.openai,
    // Gemini BYOK is intentionally unsupported. Only the server credential can
    // make Gemini report models available.
    gemini: !!base.gemini,
  };
}

function providerForReportModel(model) {
  const normalized = String(model || "").trim().toLowerCase();
  if (/^gpt(?:-|$)/.test(normalized)) return "openai";
  if (/^gemini(?:-|$)/.test(normalized)) return "gemini";
  if (
    /^(?:claude|codex)-(?:opus|sonnet|fable)(?:-|$)/.test(normalized)
  ) {
    return "anthropic";
  }
  return null;
}

/**
 * Resolve a report model without ever replacing a non-empty client choice.
 *
 * An omitted/blank choice may use the caller's default. A non-empty choice
 * must be present in the report type's current allow-list; otherwise the
 * caller should return this 400 result instead of silently running another
 * (potentially differently priced) model.
 */
function resolveRequestedReportModel({
  requestedModel,
  allowedModels,
  defaultModel,
} = {}) {
  const requested = String(requestedModel || "").trim();
  const allowed = new Set(
    Array.isArray(allowedModels)
      ? allowedModels.map((model) => String(model || "").trim()).filter(Boolean)
      : [],
  );

  if (requested) {
    if (!allowed.has(requested)) {
      return {
        ok: false,
        status: 400,
        error: "이 보고서에서는 요청한 AI 모델을 사용할 수 없습니다.",
      };
    }
    return { ok: true, model: requested, usedDefault: false };
  }

  const fallback = String(defaultModel || "").trim();
  if (fallback && allowed.has(fallback)) {
    return { ok: true, model: fallback, usedDefault: true };
  }

  return {
    ok: false,
    status: 503,
    error: "현재 이 보고서에 사용할 기본 AI 모델이 준비되지 않았습니다.",
  };
}

/**
 * Check the already-merged server/BYOK provider booleans for a resolved model.
 * Gemini availability remains server-only because
 * mergeUserModelProviderAvailability intentionally ignores Gemini BYOK.
 */
function checkReportModelProviderAvailability({ model, providers } = {}) {
  const provider = providerForReportModel(model);
  if (!provider) {
    return {
      ok: false,
      status: 400,
      error: "지원하지 않는 AI 모델입니다.",
    };
  }

  if (providers && providers[provider] === true) {
    return { ok: true, provider };
  }

  const errors = {
    anthropic:
      "Claude 모델은 현재 사용할 수 없습니다. 잠시 후 다시 시도하거나 개인 설정에서 Anthropic API 키를 등록해 주세요.",
    openai:
      "GPT 모델은 현재 사용할 수 없습니다. 잠시 후 다시 시도하거나 개인 설정에서 OpenAI API 키를 등록해 주세요.",
    gemini:
      "Gemini 모델은 현재 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  };
  return {
    ok: false,
    status: 503,
    provider,
    error: errors[provider],
  };
}

function checkGeminiReportAccess({ requestedModel, reportType, isAdmin }) {
  const model = String(requestedModel || "").trim();
  if (!/^gemini/i.test(model)) return { requested: false, allowed: true };
  if (!isAdmin) {
    return {
      requested: true,
      allowed: false,
      status: 403,
      error: "Gemini 모델은 관리자 전용입니다.",
    };
  }
  if (!GEMINI_REPORT_MODELS.includes(model) || !GEMINI_REPORT_TYPES.has(reportType)) {
    return {
      requested: true,
      allowed: false,
      status: 400,
      error: "이 보고서에서는 요청한 Gemini 모델을 사용할 수 없습니다.",
    };
  }
  return { requested: true, allowed: true };
}

module.exports = {
  GEMINI_REPORT_MODELS,
  GEMINI_REPORT_TYPES,
  checkGeminiReportAccess,
  checkReportModelProviderAvailability,
  providerForReportModel,
  resolveRequestedReportModel,
  serverModelProviderAvailability,
  mergeUserModelProviderAvailability,
};
