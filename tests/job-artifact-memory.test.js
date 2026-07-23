"use strict";

const { after, before, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

process.env.NODE_ENV = "test";
process.env.PORT = "0";
process.env.DEV_FAKE_AUTH = "1";
process.env.SESSION_SECRET = "job-artifact-memory-test-secret";
process.env.QUILO_JOB_MEMORY_TEST_HOOKS = "1";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_KEY = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
process.env.PRODUCT_TELEMETRY_ENABLED = "0";
process.env.DISABLE_SELF_PING = "1";
process.env.TECTONIC_BIN = "/usr/bin/false";

const supa = require("../lib/supabase");
// server가 불러오는 rate-limit의 장기 cleanup interval도 이 전용 테스트에서는
// 프로세스를 붙잡지 않게 한다(운영 코드의 timer 동작은 바꾸지 않는다).
const nativeSetInterval = global.setInterval;
global.setInterval = (...args) => {
  const timer = nativeSetInterval(...args);
  timer.unref?.();
  return timer;
};
const { app, jobArtifactMemoryTestHooks: memory } = require("../server");
global.setInterval = nativeSetInterval;

let baseUrl;
let httpServer;

function request(pathname, { method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${pathname}`,
      { method, agent: false, headers: { Connection: "close" } },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            text: () => body.toString("utf8"),
            json: () => JSON.parse(body.toString("utf8")),
          });
        });
      },
    );
    req.once("error", reject);
    req.end();
  });
}

before(async () => {
  httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  memory.jobs.clear();
});

after(async () => {
  memory.jobs.clear();
  httpServer?.closeIdleConnections?.();
  httpServer?.closeAllConnections?.();
  httpServer?.close();
  await new Promise((resolve) => setTimeout(resolve, 25));
});

test("result와 bundle files Buffer를 중복 없이 모두 회계한다", () => {
  const shared = Buffer.alloc(7);
  const bundlePart = Buffer.alloc(11);
  const job = {
    result: shared,
    files: [{ buffer: shared }, { buffer: bundlePart }],
  };

  assert.equal(memory.jobArtifactMemoryBytes(job), 18);
  assert.equal(memory.purgeJobArtifactMemory(job, 1234), 18);
  assert.equal(job.result, null);
  assert.equal(job.files[0].buffer, null);
  assert.equal(job.files[1].buffer, null);
  assert.equal(memory.purgeJobArtifactMemory(job, 1235), 0, "중복 cleanup은 멱등이어야 한다");
});

test("TTL/LRU cap은 완료 산출물만 비우고 running job은 보호한다", () => {
  const now = 100_000;
  const running = {
    id: "running",
    status: "running",
    createdAt: 1,
    result: Buffer.alloc(8),
  };
  const oldest = {
    id: "oldest",
    status: "done",
    createdAt: 2,
    artifactLastAccessAt: now - 500,
    result: Buffer.alloc(6),
  };
  const newest = {
    id: "newest",
    status: "done",
    createdAt: 3,
    artifactLastAccessAt: now - 100,
    result: Buffer.alloc(5),
  };
  memory.jobs.set(running.id, running);
  memory.jobs.set(oldest.id, oldest);
  memory.jobs.set(newest.id, newest);

  const capped = memory.enforceJobArtifactMemoryLimits({
    now,
    maxBytes: 13,
    ttlMs: 10_000,
  });
  assert.equal(capped.totalBytes, 13);
  assert.ok(Buffer.isBuffer(running.result), "running buffer는 cap eviction 대상이 아니다");
  assert.equal(oldest.result, null, "가장 오래 접근하지 않은 완료 산출물이 먼저 비워진다");
  assert.ok(Buffer.isBuffer(newest.result));

  newest.artifactLastAccessAt = now - 20_000;
  const expired = memory.enforceJobArtifactMemoryLimits({
    now,
    maxBytes: 100,
    ttlMs: 1_000,
  });
  assert.equal(expired.evictedJobs, 1);
  assert.equal(newest.result, null);
  assert.ok(Buffer.isBuffer(running.result), "TTL도 running buffer를 비우면 안 된다");
});

test("파일함 삭제 purge는 해당 fileId의 result/files 별칭만 제거한다", () => {
  const deletedBuffer = Buffer.from("deleted");
  const retainedBuffer = Buffer.from("retained");
  const job = {
    id: "delete-job",
    status: "done",
    userInfo: { id: "dev-admin" },
    fileId: "file-deleted",
    result: deletedBuffer,
    files: [
      { fileId: "file-deleted", buffer: deletedBuffer },
      { fileId: "file-retained", buffer: retainedBuffer },
    ],
  };
  memory.jobs.set(job.id, job);

  const affected = memory.purgeDeletedFileFromJobs("dev-admin", "file-deleted", 999);
  assert.deepEqual(affected, [job]);
  assert.equal(job.fileId, null);
  assert.equal(job.result, null);
  assert.equal(job.files[0].fileId, null);
  assert.equal(job.files[0].buffer, null);
  assert.equal(job.files[1].fileId, "file-retained");
  assert.equal(job.files[1].buffer, retainedBuffer);
  assert.deepEqual(
    memory.purgeDeletedFileFromJobs("dev-admin", "file-deleted", 1000),
    [],
    "같은 삭제 cleanup을 다시 적용해도 상태가 바뀌지 않는다",
  );
});

test("일반 PDF 통번역도 TTL 이후 fallback을 위해 파일함에 저장한다", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("async function runPdfTranslation");
  const end = source.indexOf("// 매뉴얼 파일명에서", start);
  const translationFlow = source.slice(start, end);
  assert.match(translationFlow, /durableArtifactPersistenceRequired\(job\)/);
  assert.match(translationFlow, /await saveReportFileDurably\(/);
  assert.doesNotMatch(
    translationFlow,
    /job\.background\s*&&\s*supa\.isEnabled\(\)/,
    "일반 작업을 background 여부로 storage에서 제외하면 TTL 뒤 다운로드가 사라진다",
  );
});

test("운영 저장소가 켜진 사용자 작업만 durable artifact를 필수로 본다", (t) => {
  const original = supa.isEnabled;
  t.after(() => {
    supa.isEnabled = original;
  });

  supa.isEnabled = () => true;
  assert.equal(
    memory.durableArtifactPersistenceRequired({ userInfo: { id: "user-1" } }),
    true,
  );
  assert.equal(memory.durableArtifactPersistenceRequired({ userInfo: {} }), false);

  supa.isEnabled = () => false;
  assert.equal(
    memory.durableArtifactPersistenceRequired({ userInfo: { id: "dev-admin" } }),
    false,
    "Supabase를 의도적으로 끄는 로컬/테스트는 RAM 전달을 유지한다",
  );

  assert.equal(memory.hasDurableArtifact({ fileId: "file-1" }), true);
  assert.equal(
    memory.hasDurableArtifact({ files: [{ fileId: null }, { fileId: "file-2" }] }),
    true,
  );
  assert.equal(memory.hasDurableArtifact({ result: Buffer.from("ram only") }), false);
});

test("파일함 저장은 일시 오류를 유한 재시도하고 식별자 없는 응답은 fail-closed 처리한다", async (t) => {
  const original = supa.saveReportFile;
  t.after(() => {
    supa.saveReportFile = original;
  });

  let calls = 0;
  const retries = [];
  supa.saveReportFile = async () => {
    calls += 1;
    if (calls < 3) throw new Error(`temporary-${calls}`);
    return { id: "stored-after-retry", expires_at: new Date().toISOString() };
  };
  const saved = await memory.saveReportFileDurably(
    { userId: "user-1", buffer: Buffer.from("artifact") },
    {
      attempts: 3,
      baseDelayMs: 0,
      onRetry: (attempt, error) => retries.push([attempt, error.message]),
    },
  );
  assert.equal(saved.id, "stored-after-retry");
  assert.equal(calls, 3);
  assert.deepEqual(retries, [
    [1, "temporary-1"],
    [2, "temporary-2"],
  ]);

  calls = 0;
  supa.saveReportFile = async () => {
    calls += 1;
    return null;
  };
  await assert.rejects(
    memory.saveReportFileDurably(
      { userId: "user-1", buffer: Buffer.from("artifact") },
      { attempts: 2, baseDelayMs: 0 },
    ),
    (error) => {
      assert.equal(error.code, "ARTIFACT_PERSISTENCE_FAILED");
      assert.match(error.message, /24시간 보관/);
      return true;
    },
  );
  assert.equal(calls, 2, "식별자 없는 성공 응답도 재시도 후 실패해야 한다");

  calls = 0;
  supa.saveReportFile = async () => {
    calls += 1;
    throw new Error("saveReportFile(upload): HTTP 413 payload too large");
  };
  await assert.rejects(
    memory.saveReportFileDurably(
      { userId: "user-1", buffer: Buffer.from("oversized") },
      { attempts: 4, baseDelayMs: 0 },
    ),
    { code: "ARTIFACT_PERSISTENCE_FAILED" },
  );
  assert.equal(calls, 1, "용량·권한 같은 영구 오류는 재시도하지 않아야 한다");
});

test("job download는 메모리 eviction 뒤 소유자 storage로 fallback하고 삭제 즉시 두 경로가 404다", async (t) => {
  const original = {
    isEnabled: supa.isEnabled,
    findUserById: supa.findUserById,
    downloadReportFile: supa.downloadReportFile,
    deleteReportFile: supa.deleteReportFile,
    recordGenerationDelivery: supa.recordGenerationDelivery,
  };
  t.after(() => Object.assign(supa, original));

  const stored = new Map([
    [
      "stored-file",
      {
        buffer: Buffer.from("stored artifact"),
        row: {
          job_id: "stored-job",
          filename: "result.txt",
          mime_type: "text/plain",
        },
      },
    ],
  ]);
  const ownershipChecks = [];
  supa.isEnabled = () => true;
  supa.findUserById = async (id) => ({
    id,
    name: "개발관리자",
    username: "개발관리자",
    is_admin: true,
    is_staff: true,
    is_developer: true,
    password_hash: "dev-fake-auth-local-only",
  });
  supa.downloadReportFile = async (userId, fileId) => {
    ownershipChecks.push([userId, fileId]);
    return stored.get(fileId) || null;
  };
  supa.deleteReportFile = async (userId, fileId) => {
    assert.equal(userId, "dev-admin");
    return stored.delete(fileId);
  };
  supa.recordGenerationDelivery = async () => {};

  const job = {
    id: "stored-job",
    status: "done",
    createdAt: Date.now(),
    artifactCompletedAt: Date.now(),
    userInfo: { id: "dev-admin" },
    fileId: "stored-file",
    result: null,
    filename: "result.txt",
    mimeType: "text/plain",
    files: [],
    progress: [],
    listeners: [],
  };
  memory.jobs.set(job.id, job);

  const fallback = await request(`/api/jobs/${job.id}/download`);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.text(), "stored artifact");
  assert.deepEqual(ownershipChecks, [["dev-admin", "stored-file"]]);
  assert.equal(job.result, null, "storage fallback은 산출물을 RAM에 재적재하지 않는다");

  const previewFallback = await request(`/api/jobs/${job.id}/preview`);
  assert.equal(previewFallback.status, 200);
  assert.match(previewFallback.text(), /stored artifact/);
  assert.deepEqual(ownershipChecks, [
    ["dev-admin", "stored-file"],
    ["dev-admin", "stored-file"],
  ]);

  const alias = Buffer.from("in-memory alias");
  job.result = alias;
  job.files = [{ fileId: "stored-file", buffer: alias, filename: "result.txt" }];
  const deleted = await request("/api/me/files/stored-file", { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json(), { ok: true });
  assert.equal(job.result, null);
  assert.equal(job.fileId, null);
  assert.equal(job.files[0].buffer, null);
  assert.equal(job.files[0].fileId, null);

  const jobDownloadAfterDelete = await request(`/api/jobs/${job.id}/download`);
  assert.equal(jobDownloadAfterDelete.status, 404);
  const jobPreviewAfterDelete = await request(`/api/jobs/${job.id}/preview`);
  assert.equal(jobPreviewAfterDelete.status, 404);
  const fileDrawerAfterDelete = await request("/api/me/files/stored-file/download");
  assert.equal(fileDrawerAfterDelete.status, 404);
});
