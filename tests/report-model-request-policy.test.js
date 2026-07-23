"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  checkReportModelProviderAvailability,
  mergeUserModelProviderAvailability,
  providerForReportModel,
  resolveRequestedReportModel,
} = require("../lib/report-model-policy");

const ALLOWED = [
  "claude-opus-4-8",
  "claude-sonnet-5",
  "gpt-5.5",
  "gemini-3.1-pro",
];

test("an explicit allowed model is preserved exactly", () => {
  assert.deepEqual(
    resolveRequestedReportModel({
      requestedModel: " gpt-5.5 ",
      allowedModels: ALLOWED,
      defaultModel: "claude-opus-4-8",
    }),
    { ok: true, model: "gpt-5.5", usedDefault: false },
  );
});
test("an explicit unknown or report-disallowed model fails instead of silently falling back", () => {
  for (const requestedModel of ["injected-model", "gpt-5.5"]) {
    const result = resolveRequestedReportModel({
      requestedModel,
      allowedModels: ["claude-opus-4-8", "claude-sonnet-5"],
      defaultModel: "claude-opus-4-8",
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.model, undefined);
    assert.doesNotMatch(result.error, new RegExp(requestedModel));
  }
});

test("only an omitted or blank model may use the configured default", () => {
  for (const requestedModel of [undefined, null, "", "   "]) {
    assert.deepEqual(
      resolveRequestedReportModel({
        requestedModel,
        allowedModels: ALLOWED,
        defaultModel: "claude-sonnet-5",
      }),
      { ok: true, model: "claude-sonnet-5", usedDefault: true },
    );
  }

  const invalidDefault = resolveRequestedReportModel({
    requestedModel: "",
    allowedModels: ALLOWED,
    defaultModel: "server-misconfiguration",
  });
  assert.equal(invalidDefault.ok, false);
  assert.equal(invalidDefault.status, 503);
  assert.equal(invalidDefault.model, undefined);
});

test("report models map to their canonical providers", () => {
  assert.equal(providerForReportModel("claude-opus-4-8"), "anthropic");
  assert.equal(providerForReportModel("Codex-sonnet-5"), "anthropic");
  assert.equal(providerForReportModel("claude-fable-5"), "anthropic");
  assert.equal(providerForReportModel("gpt-5.4-mini"), "openai");
  assert.equal(providerForReportModel("gemini-2.5-flash"), "gemini");
  assert.equal(providerForReportModel("unknown-model"), null);
});

test("resolved models require merged server and BYOK provider availability", () => {
  const providers = mergeUserModelProviderAvailability(
    { anthropic: false, openai: false, gemini: true },
    { anthropic: "user-anthropic-secret", openai: "user-openai-secret" },
  );

  assert.deepEqual(
    checkReportModelProviderAvailability({
      model: "claude-sonnet-5",
      providers,
    }),
    { ok: true, provider: "anthropic" },
  );
  assert.deepEqual(
    checkReportModelProviderAvailability({ model: "gpt-5.5", providers }),
    { ok: true, provider: "openai" },
  );
  assert.deepEqual(
    checkReportModelProviderAvailability({
      model: "gemini-3.1-pro",
      providers,
    }),
    { ok: true, provider: "gemini" },
  );
});

test("an unavailable provider returns a provider-specific, secret-free 503", () => {
  const providers = { anthropic: false, openai: false, gemini: false };
  const cases = [
    ["claude-opus-4-8", "anthropic", /Claude/],
    ["gpt-5.4", "openai", /GPT/],
    ["gemini-2.5-flash", "gemini", /Gemini/],
  ];

  for (const [model, provider, messagePattern] of cases) {
    const result = checkReportModelProviderAvailability({ model, providers });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.provider, provider);
    assert.match(result.error, messagePattern);
    assert.doesNotMatch(result.error, /(?:sk-|secret|API_KEY|GEMINI_API_KEY)/i);
  }

  assert.deepEqual(
    checkReportModelProviderAvailability({
      model: "unknown-model",
      providers,
    }),
    { ok: false, status: 400, error: "지원하지 않는 AI 모델입니다." },
  );
});
