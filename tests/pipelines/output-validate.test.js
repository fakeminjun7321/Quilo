"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const JSZip = require("jszip");

const {
  ENFORCEABLE_RULES,
  findEnforceableArtifactProblem,
  validateReportArtifact,
} = require("../../lib/output-validate");

test("핵심 보고서 4종은 치명적 산출물 결함을 기본 fail-closed로 분류한다", () => {
  const validation = {
    ok: false,
    problems: [{ rule: "raw-marker", detail: "raw {{EQN: marker" }],
  };
  for (const type of [
    "chem-pre",
    "chem-result",
    "phys-result",
    "print-pdf-restore",
  ]) {
    assert.equal(
      findEnforceableArtifactProblem(validation, { type })?.rule,
      "raw-marker",
      `${type}은 환경변수 없이 치명적 결함을 거부해야 한다`,
    );
  }
  assert.equal(
    findEnforceableArtifactProblem(validation, { type: "free" }),
    null,
    "기존 비핵심 파이프라인의 기본 정책은 이 변경에서 확장하지 않는다",
  );
  assert.equal(
    findEnforceableArtifactProblem(validation, {
      type: "free",
      enforceAll: true,
    })?.rule,
    "raw-marker",
    "기존 OUTPUT_VALIDATE_ENFORCE=1 opt-in은 유지한다",
  );
});

test("raw EQN 계열 마커와 불완전 문서 구조는 치명적 규칙으로 검출된다", async () => {
  const docx = new JSZip();
  docx.file(
    "word/document.xml",
    '<w:document xmlns:w="urn:test"><w:t>{{EQN-LATEX:x^2}}</w:t></w:document>',
  );
  const docxCheck = await validateReportArtifact(
    await docx.generateAsync({ type: "nodebuffer" }),
    { format: "docx", type: "chem-pre" },
  );
  assert.equal(docxCheck.ok, false);
  assert.equal(
    findEnforceableArtifactProblem(docxCheck, { type: "chem-pre" })?.rule,
    "raw-marker",
  );

  const hwpx = new JSZip();
  hwpx.file("Contents/section0.xml", "<section/>");
  const hwpxCheck = await validateReportArtifact(
    await hwpx.generateAsync({ type: "nodebuffer" }),
    { format: "hwpx", type: "phys-result" },
  );
  assert.ok(ENFORCEABLE_RULES.has("entry-missing"));
  assert.equal(
    findEnforceableArtifactProblem(hwpxCheck, { type: "phys-result" })?.rule,
    "entry-missing",
  );
});

test("긴 대시 같은 품질 경고는 fail-closed 대상이 아니다", async () => {
  const docx = new JSZip();
  docx.file(
    "word/document.xml",
    '<w:document xmlns:w="urn:test"><w:t>경고만 남길 긴 대시 \u2014</w:t></w:document>',
  );
  const check = await validateReportArtifact(
    await docx.generateAsync({ type: "nodebuffer" }),
    { format: "docx", type: "chem-result" },
  );
  assert.equal(check.ok, false);
  assert.equal(
    findEnforceableArtifactProblem(check, { type: "chem-result" }),
    null,
  );
});
