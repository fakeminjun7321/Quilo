"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { cleanupExternalGeneratedArtifacts } = require("../lib/generated-artifact-cleanup");

function fixture() {
  const calls = [];
  const job = {
    userInfo: { id: "user-1" },
    fileId: "report-1",
    googleDriveFileId: "drive-1",
    googleDriveUrl: "https://drive.test/drive-1",
    dropboxFileId: "id:dropbox-1",
    dropboxFilePath: "/report.docx",
    cloudProvider: "dropbox",
    files: [
      { fileId: "report-1", filename: "first.pdf" },
      { fileId: "report-2", filename: "second.pdf" },
    ],
  };
  const supa = {
    isEnabled: () => true,
    deleteReportFile: async (...args) => { calls.push(["supabase", ...args]); },
    getCloudConnection: async (_userId, provider) => ({
      refresh_token: `${provider}-encrypted`,
    }),
  };
  const cloudProviders = {
    decryptToken: (value) => value.replace("-encrypted", "-refresh"),
    googleAccessToken: async (value) => `${value}-access`,
    deleteDriveFile: async (...args) => { calls.push(["google", ...args]); },
  };
  const dropbox = {
    decryptToken: (value) => value.replace("-encrypted", "-refresh"),
    refreshAccessToken: async (value) => ({ access_token: `${value}-access` }),
    deleteFile: async (args) => { calls.push(["dropbox", args]); },
  };
  return { job, calls, supa, cloudProviders, dropbox };
}

test("compensation cleanup removes every recorded external artifact", async () => {
  const f = fixture();
  const result = await cleanupExternalGeneratedArtifacts(f.job, f);
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls, [
    ["supabase", "user-1", "report-1"],
    ["supabase", "user-1", "report-2"],
    ["google", "google-refresh-access", "drive-1"],
    ["dropbox", { accessToken: "dropbox-refresh-access", path: "id:dropbox-1" }],
  ]);
  assert.equal(f.job.fileId, null);
  assert.deepEqual(f.job.files.map((entry) => entry.fileId), [null, null]);
  assert.equal(f.job.googleDriveFileId, "");
  assert.equal(f.job.googleDriveUrl, "");
  assert.equal(f.job.dropboxFileId, "");
  assert.equal(f.job.dropboxFilePath, "");
  assert.equal(f.job.cloudProvider, "");
});

test("failed cleanup preserves its identifier for a later retry", async () => {
  const f = fixture();
  f.cloudProviders.deleteDriveFile = async () => { throw new Error("Drive unavailable"); };
  const result = await cleanupExternalGeneratedArtifacts(f.job, f);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map((item) => item.provider), ["google"]);
  assert.equal(f.job.fileId, null);
  assert.equal(f.job.googleDriveFileId, "drive-1");
  assert.equal(f.job.googleDriveUrl, "https://drive.test/drive-1");
  assert.equal(f.job.dropboxFileId, "");
});

test("failed cleanup preserves only the failed multi-file identifier", async () => {
  const f = fixture();
  f.supa.deleteReportFile = async (userId, fileId) => {
    f.calls.push(["supabase", userId, fileId]);
    if (fileId === "report-2") throw new Error("Storage unavailable");
  };
  const result = await cleanupExternalGeneratedArtifacts(f.job, f);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.failures.map(({ provider, id }) => [provider, id]),
    [["supabase", "report-2"]],
  );
  assert.equal(f.job.fileId, null);
  assert.deepEqual(f.job.files.map((entry) => entry.fileId), [null, "report-2"]);
});

test("cleanup is a no-op without a user or recorded artifact", async () => {
  assert.deepEqual(
    await cleanupExternalGeneratedArtifacts({ userInfo: null }, {}),
    { ok: true, failures: [] },
  );
});
