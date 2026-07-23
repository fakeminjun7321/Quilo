"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const pricing = require("../lib/pricing");
const {
  checkGeminiReportAccess,
} = require("../lib/report-model-policy");

const root = path.join(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

test("reading-log keeps the 1-credit GPT-5.4-mini over-cap charge", () => {
  const usage = { input_tokens: 1200, output_tokens: 800 };
  const server = read("server.js");

  assert.equal(
    pricing.readingLogCreditsForUsage({
      usage,
      model: "gpt-5.4-mini",
      miniOverCap: false,
    }),
    0,
    "mini remains free while the daily allowance is available",
  );
  assert.equal(
    pricing.readingLogCreditsForUsage({
      usage,
      model: "gpt-5.4-mini",
      miniOverCap: true,
    }),
    1,
    "the reserved over-cap credit must not be refunded at completion",
  );
  assert.equal(
    pricing.readingLogCreditsForUsage({
      usage: null,
      model: "gpt-5.4-mini",
      miniOverCap: true,
    }),
    1,
    "the accepted over-cap job keeps its charge even if usage aggregation is absent",
  );
  assert.match(server, /job\.miniOverCap = miniOverCap/);
  assert.match(
    server,
    /readingLogCreditsForUsage\(\{[\s\S]*?miniOverCap: job\.miniOverCap/,
  );
});

test("billable report UI states the GPT-5.4-mini daily allowance", () => {
  const html = read("public/index.html");
  const workflow = read("public/workspace/report-workflow.js");
  const account = read("public/workspace/account-controller.js");
  const expected = "하루 5건 무료 · 이후 1크레딧";

  for (const name of ["model", "crModel", "prModel", "frModel", "rlModel"]) {
    assert.match(
      html,
      new RegExp(`name="${name}" value="gpt-5\\.4-mini"[^<]+${expected}`),
      `${name} must disclose the daily cap`,
    );
  }
  assert.match(html, new RegExp(`value="gpt-5\\.4-mini"[^<]+${expected}`));
  assert.match(workflow, /하루 5건 무료 · 이후 1크레딧/);
  assert.match(account, /하루 5건 무료 · 이후 1크레딧/);
});

test("Gemini report models are server-enforced as admin-only core models", () => {
  const server = read("server.js");

  for (const requestedModel of ["gemini-3.1-pro", "gemini-2.5-flash", "gemini-injected"]) {
    const result = checkGeminiReportAccess({
      requestedModel,
      reportType: "chem-pre",
      isAdmin: false,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.status, 403);
  }

  assert.deepEqual(
    checkGeminiReportAccess({
      requestedModel: "gemini-3.1-pro",
      reportType: "phys-result",
      isAdmin: true,
    }),
    { requested: true, allowed: true },
  );
  assert.equal(
    checkGeminiReportAccess({
      requestedModel: "gemini-3.1-pro",
      reportType: "reading-log",
      isAdmin: true,
    }).status,
    400,
  );
  assert.match(server, /effectiveIsAdmin && GEMINI_REPORT_TYPES\.has\(reportType\)/);
  assert.match(server, /checkGeminiReportAccess\(\{[\s\S]*?isAdmin: effectiveIsAdmin/);
});

test("Gemini labels and client credit estimates match the server price table", () => {
  const html = read("public/index.html");
  const helpers = read("public/workspace/report-helpers.js");

  assert.equal(pricing.MODEL_CREDITS["gemini-3.1-pro"], 2);
  assert.equal(pricing.MODEL_CREDITS["gemini-2.5-flash"], 1);
  assert.match(helpers, /"gemini-3\.1-pro": 2/);
  assert.match(helpers, /"gemini-2\.5-flash": 1/);
  assert.match(helpers, /"gemini-3\.1-pro": "Gemini 3\.1 Pro"/);
  assert.match(helpers, /"gemini-2\.5-flash": "Gemini 2\.5 Flash"/);
  assert.match(html, /value="gemini-3\.1-pro"[^<]+2크레딧/);
  assert.match(html, /value="gemini-2\.5-flash"[^<]+1크레딧/);
});
