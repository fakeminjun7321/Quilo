import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "./app.js";
import { MemoryStore } from "./store/memory-store.js";

const config = {
  nodeEnv: "test",
  production: false,
  port: 0,
  allowedOrigin: "http://localhost:5173",
  sessionSecret: "drive-app-test-session-secret-that-is-long-enough",
  adminPassword: "correct horse battery staple",
  cronSecret: "cron-test-secret",
  kakaoSkillSecret: "",
  storage: "memory",
  classCode: "2-4",
  className: "2학년 4반",
  timezone: "Asia/Seoul",
  kakao: { enabled: false, botId: "", restApiKey: "", eventName: "quilo_schedule_notification", apiBase: "https://bot-api.kakao.com" },
};

test("Drive 자료도 기존 관리자·학생·HMAC 다운로드 권한 경계 안에서만 제공한다", async () => {
  const store = new MemoryStore(config);
  const driveFile = {
    id: "gdrive_test-file.signature",
    member_id: null,
    alias: "김종수T 학습지",
    filename: "worksheet.pdf",
    description: "Google Drive 자료",
    mime_type: "application/pdf",
    size_bytes: 18,
    provider: "google_drive",
    status: "active",
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z",
  };
  const googleDriveFileProvider = {
    configured: true,
    isManagedId: (id) => id === driveFile.id,
    listFiles: async () => [driveFile],
    getFile: async (id) => id === driveFile.id ? driveFile : null,
    downloadFile: async () => Buffer.from("%PDF-1.4\n%%EOF"),
    uploadFile: async () => driveFile,
    status: async () => ({ configured: true, connected: true, item_count: 1, folder_url: "https://drive.google.com/example" }),
  };
  const app = await createApp({
    config,
    store,
    googleDriveFileProvider,
    now: () => new Date("2026-07-16T03:00:00.000Z"),
  });
  const agent = request.agent(app);

  assert.equal((await request(app).get("/api/admin/drive/status")).status, 401);
  assert.equal((await agent.post("/api/admin/login").send({ password: config.adminPassword })).status, 200);

  const status = await agent.get("/api/admin/drive/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.connected, true);

  const listed = await agent.get("/api/admin/files");
  const item = listed.body.items.find((entry) => entry.id === driveFile.id);
  assert.equal(item.provider, "google_drive");
  assert.match(item.share_url, /^http:/);

  const publicDownload = await request(app).get(new URL(item.share_url).pathname).buffer(true);
  assert.equal(publicDownload.status, 200);
  assert.match(publicDownload.headers["cache-control"], /private/);
  assert.equal(publicDownload.headers["access-control-allow-origin"], undefined);
  assert.equal(publicDownload.body.toString(), "%PDF-1.4\n%%EOF");

  const synced = await agent.post("/api/admin/drive/sync");
  assert.equal(synced.status, 200);
  assert.equal(synced.body.item_count, 1);
});
