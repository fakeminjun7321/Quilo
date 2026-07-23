"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const telemetry = require("../lib/product-telemetry");

test("upload summary stores extensions and buckets, never filenames", () => {
  const summary = telemetry.summarizeUploads([
    { originalname: "민준_실험결과.xlsx", size: 84000 },
    { originalname: "비밀 메모.PDF", size: 2 * 1024 * 1024 },
  ]);
  assert.deepEqual(summary.fileExtensions, ["pdf", "xlsx"]);
  assert.equal(summary.fileCount, 2);
  assert.equal(summary.fileSizeBuckets.lt_100kb, 1);
  assert.equal(summary.fileSizeBuckets["1mb_5mb"], 1);
  assert.equal(JSON.stringify(summary).includes("민준"), false);
  assert.equal(JSON.stringify(summary).includes("비밀"), false);
});

test("model provider mapping recognizes every supported report model family", () => {
  assert.equal(telemetry.providerForModel("Codex-sonnet-5"), "anthropic");
  assert.equal(telemetry.providerForModel("Codex-opus-4-8"), "anthropic");
  assert.equal(telemetry.providerForModel("gpt-5.5"), "openai");
});

test("product properties discard free text, URLs, identifiers, and unknown keys", () => {
  const properties = telemetry.sanitizeProductProperties({
    reportType: "phys-result",
    model: "claude-sonnet-5",
    format: "hwpx",
    fileExtensions: ["cap", "xlsx"],
    score: 5,
    tags: ["data_error", "not-allowed"],
    title: "개인 보고서 제목",
    userNotes: "원문 메모",
    email: "student@example.com",
    url: "/?token=secret",
    arbitrary: "do not keep",
  });
  assert.deepEqual(properties, {
    reportType: "phys-result",
    model: "claude-sonnet-5",
    format: "hwpx",
    fileExtensions: ["cap", "xlsx"],
    score: 5,
    tags: ["data_error"],
  });
});

test("event normalization accepts only allowlisted events and fixes page path", () => {
  const rows = telemetry.normalizeProductEvents([
    {
      name: "generation_completed",
      pagePath: "/?studentId=250001",
      properties: { reportType: "chem-result", source: "sse" },
    },
    { name: "keystroke", properties: { text: "secret" } },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_name, "generation_completed");
  assert.equal(rows[0].page_path, "/");
  assert.deepEqual(rows[0].properties, { reportType: "chem-result", source: "sse" });
});

test("quality feedback rejects free-form dispositions and strips unknown tags", () => {
  assert.deepEqual(
    telemetry.validateQualityFeedback({
      score: 4,
      disposition: "minor_edits",
      tags: ["chart_error", "custom free text"],
      comment: "must not be stored",
    }),
    { score: 4, disposition: "minor_edits", tags: ["chart_error"] },
  );
  assert.throws(
    () => telemetry.validateQualityFeedback({ score: 5, disposition: "perfect!!!" }),
    /사용 결과/,
  );
});

test("analytics summary returns aggregate metrics without user rows", () => {
  const summary = telemetry.aggregateAnalytics({
    days: 30,
    runs: [
      { accepted: true, status: "done", report_type: "phys-result", model: "claude-sonnet-5", total_ms: 1000, download_count: 1 },
      { accepted: true, status: "error", report_type: "chem-pre", model: "gpt-5.4", total_ms: 2000, error_phase: "generation", error_code: "generation_failed" },
      { accepted: false, status: "rejected", report_type: "chem-pre", model: "unknown", total_ms: 10 },
    ],
    events: [{ event_name: "generation_submitted" }],
    feedback: [{ score: 4, disposition: "minor_edits", tags: ["too_verbose"] }],
  });
  assert.equal(summary.runs.accepted, 2);
  assert.equal(summary.runs.completed, 1);
  assert.equal(summary.runs.rejected, 1);
  assert.equal(summary.runs.successRate, 0.5);
  assert.equal(summary.runs.downloads, 1);
  assert.equal(summary.quality.averageScore, 4);
  assert.equal("users" in summary, false);
});
