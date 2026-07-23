"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("generation failure resolves billing before deleting any artifact", () => {
  const catchStart = source.indexOf("// 결제 응답 유실 뒤 산출물을 먼저 삭제하면");
  const billing = source.indexOf("await settleReservationOnFailure(job)", catchStart);
  const cleanup = source.indexOf("await cleanupExternalGeneratedArtifacts(job", catchStart);
  const purge = source.indexOf("purgeJobArtifactMemory(job)", catchStart);
  assert.ok(catchStart >= 0);
  assert.ok(billing > catchStart);
  assert.ok(cleanup > billing);
  assert.ok(purge > cleanup);
  assert.match(source.slice(catchStart, cleanup), /billing\.status !== "uncertain"/);
  assert.match(source.slice(catchStart, cleanup), /billing\.status === "settled" && hasArtifact/);
});

test("external upload identifiers are recorded before abort can be observed", () => {
  const generationStart = source.indexOf("async function runGeneration");
  const googleUpload = source.indexOf("await cloudProviders.uploadDriveFile", generationStart);
  const googleId = source.indexOf("job.googleDriveFileId =", googleUpload);
  const googleAbort = source.indexOf("assertGenerationActive()", googleId);
  assert.ok(googleUpload >= 0 && googleId > googleUpload && googleAbort > googleId);

  const dropboxUpload = source.indexOf("await dbx.uploadFile", generationStart);
  const dropboxId = source.indexOf("job.dropboxFileId =", dropboxUpload);
  const dropboxAbort = source.indexOf("assertGenerationActive()", dropboxId);
  assert.ok(dropboxUpload >= 0 && dropboxId > dropboxUpload && dropboxAbort > dropboxId);

  const storageUpload = source.indexOf("await saveReportFileDurably", generationStart);
  const storageId = source.indexOf("job.fileId = savedFile.id", storageUpload);
  const storageAbort = source.indexOf("assertGenerationActive()", storageId);
  assert.ok(storageUpload >= 0 && storageId > storageUpload && storageAbort > storageId);
});

test("산출물 영속 저장이 정산과 done 상태보다 먼저 확정된다", () => {
  const generationStart = source.indexOf("async function runGeneration");
  const generationEnd = source.indexOf("// 사용자가 진행 중인 작업을 중지", generationStart);
  const flow = source.slice(generationStart, generationEnd);
  const storagePhase = flow.indexOf('job.telemetryPhase = "storage"');
  const durableSave = flow.indexOf("await saveReportFileDurably(", storagePhase);
  const durableGuard = flow.indexOf(
    "durableArtifactPersistenceRequired(job) && !durableSaved",
    storagePhase,
  );
  const billingPhase = flow.indexOf('job.telemetryPhase = "billing"', storagePhase);
  const done = flow.indexOf('job.status = "done"', billingPhase);

  assert.ok(storagePhase >= 0);
  assert.ok(durableSave > storagePhase);
  assert.ok(durableGuard > durableSave);
  assert.ok(billingPhase > durableGuard);
  assert.ok(done > billingPhase);
  assert.doesNotMatch(
    flow.slice(storagePhase, billingPhase),
    /파일함 저장 실패[^\n]*\u2192[^\n]*완료/,
  );
});

test("PDF 통번역은 영속 fileId 확인 후에만 완료 목록에 추가한다", () => {
  const start = source.indexOf("async function runPdfTranslation");
  const end = source.indexOf("// 매뉴얼 파일명에서", start);
  const flow = source.slice(start, end);
  const durableSave = flow.indexOf("await saveReportFileDurably(");
  const assignId = flow.indexOf("entry.fileId = savedFile.id", durableSave);
  const pushEntry = flow.indexOf("job.files.push(entry)", assignId);
  const done = flow.indexOf('job.status = "done"', pushEntry);

  assert.ok(durableSave >= 0);
  assert.ok(assignId > durableSave);
  assert.ok(pushEntry > assignId);
  assert.ok(done > pushEntry);
});

test("graceful shutdown refunds and compensates only known-unsettled jobs", () => {
  const start = source.indexOf("async function gracefulShutdown");
  const body = source.slice(start, source.indexOf('process.once("SIGTERM"', start));
  assert.match(body, /settleReservationOnFailure\(job\)/);
  assert.match(body, /billing\.status === "settled" \|\| billing\.status === "uncertain"/);
  assert.match(body, /cleanupExternalGeneratedArtifacts\(job/);
});
