"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.PORT = "0";
process.env.SESSION_SECRET = "retired-operational-record-test-secret";
process.env.QUILO_JOB_MEMORY_TEST_HOOKS = "1";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_KEY = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
process.env.DISABLE_SELF_PING = "1";
process.env.TECTONIC_BIN = "/usr/bin/false";

const nativeSetInterval = global.setInterval;
global.setInterval = (...args) => {
  const timer = nativeSetInterval(...args);
  timer.unref?.();
  return timer;
};
const { retiredVisibilityTestHooks: visibility } = require("../server");
global.setInterval = nativeSetInterval;

const serverSource = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
const studioSource = fs.readFileSync(
  path.join(__dirname, "../lib/artifacts-routes.js"),
  "utf8",
);
const retired = [
  "phys-inquiry",
  "math-inquiry",
  "eng-exam-prep",
  "korean-lit-exam",
  "phys-mock-exam",
];

test("historical jobs, files, usage rows, and cloud artifacts are hidden in memory", () => {
  const records = [
    { id: "active-job", reportType: "phys-result" },
    { id: "retired-job", reportType: "phys-inquiry" },
    { id: "retired-file", report_type: "math-inquiry" },
    { id: "retired-usage", meta: { reportType: "eng-exam-prep" } },
    { id: "legacy-name", filename: "2401_급수탐구보고서.hwpx" },
  ];
  assert.deepEqual(
    visibility.visibleReportRecords(records).map((record) => record.id),
    ["active-job"],
  );
  assert.equal(
    visibility.isHiddenCloudArtifact({
      name: "output.docx",
      appProperties: { quiloReportType: "korean-lit-exam" },
    }),
    true,
  );
  assert.equal(
    visibility.isHiddenCloudArtifact({ name: "chapter_모의고사.zip" }),
    true,
  );
  assert.equal(visibility.isHiddenCloudArtifact({ name: "화학결과.docx" }), false);
});

test("every typed operational list applies the retired-record boundary", () => {
  for (const route of [
    'app.get("/api/me/files"',
    'app.get("/api/me/jobs"',
    'app.get("/api/me/usage"',
    'app.get("/api/admin/usage-logs"',
  ]) {
    const start = serverSource.indexOf(route);
    assert.notEqual(start, -1, `${route} missing`);
    const block = serverSource.slice(start, start + 5000);
    assert.match(block, /visibleReportRecords\(/, `${route} does not filter retired rows`);
  }
  assert.match(
    serverSource,
    /getAnalyticsSummary\(days, \{\s*excludeReportTypes: RETIRED_TYPES/,
  );
  assert.match(serverSource, /createV1Router\(\{[\s\S]*?excludeReportTypes: RETIRED_TYPES/);
  const proGate = serverSource.slice(
    serverSource.indexOf("async function requireProMember"),
    serverSource.indexOf("// Max 회원 게이트"),
  );
  assert.match(proGate, /visibleBetaKeys\(features\)\.length > 0/);
});

test("Studio intent routing advertises and accepts only the released generator", () => {
  const start = studioSource.indexOf("const GEN_TYPES");
  const end = studioSource.indexOf('r.post("/api/studio/route"', start);
  const routerContract = studioSource.slice(start, end);
  assert.match(routerContract, /new Set\(\["cap-translate"\]\)/);
  for (const id of retired) {
    assert.doesNotMatch(routerContract, new RegExp(id), `${id} leaked into Studio router prompt`);
  }
  assert.match(studioSource, /GEN_TYPES\.has\(parsed\.reportType\)/);
  assert.match(studioSource, /if \(!out\.reportType\) out\.action = "chat"/);
});

test("retired beta operations remain blocked through the admin AI action path", () => {
  const execute = serverSource.slice(
    serverSource.indexOf('app.post("/api/admin/action/execute"'),
    serverSource.indexOf("// ── 코드 에디터", serverSource.indexOf('app.post("/api/admin/action/execute"')),
  );
  assert.equal((execute.match(/rejectRetiredBetaKey\(res, key\)/g) || []).length, 2);
  for (const id of retired) assert.equal(visibility.isRetiredType(id), true);
});
