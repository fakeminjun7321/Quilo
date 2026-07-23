import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

const validProduction = {
  NODE_ENV: "production",
  CLASSBOT_STORAGE: "supabase",
  CLASSBOT_SESSION_SECRET: "s".repeat(32),
  CLASSBOT_ADMIN_PASSWORD: "a".repeat(16),
  CLASSBOT_CRON_SECRET: "c".repeat(32),
  CLASSBOT_KAKAO_SKILL_SECRET: "k".repeat(32),
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  KAKAO_EVENT_ENABLED: "false",
};

test("production은 Supabase 저장소와 충분히 긴 secret을 강제한다", () => {
  assert.throws(
    () => loadConfig({ ...validProduction, CLASSBOT_STORAGE: "memory" }),
    /CLASSBOT_STORAGE must be supabase/,
  );
  assert.throws(
    () => loadConfig({ ...validProduction, CLASSBOT_SESSION_SECRET: "short" }),
    /at least 32 characters/,
  );
  assert.throws(
    () => loadConfig({ ...validProduction, CLASSBOT_KAKAO_SKILL_SECRET: "" }),
    /CLASSBOT_KAKAO_SKILL_SECRET/,
  );
  assert.equal(loadConfig(validProduction).storage, "supabase");
  assert.equal(loadConfig(validProduction).allowedOrigin, "");
});

test("production은 서로 다른 secret과 HTTPS 외부 주소만 허용한다", () => {
  assert.throws(
    () => loadConfig({ ...validProduction, CLASSBOT_CRON_SECRET: validProduction.CLASSBOT_SESSION_SECRET }),
    /distinct values/,
  );
  assert.throws(
    () => loadConfig({ ...validProduction, SUPABASE_URL: "http://example.supabase.co" }),
    /must use HTTPS/,
  );
  assert.throws(
    () => loadConfig({ ...validProduction, CLASSBOT_ALLOWED_ORIGIN: "http://class.example" }),
    /must use HTTPS/,
  );
  assert.equal(loadConfig({ ...validProduction, CLASSBOT_ALLOWED_ORIGIN: "https://class.example" }).allowedOrigin, "https://class.example");
});

test("Render에서는 production 검증을 강제하고 placeholder와 미지원 timezone을 거부한다", () => {
  assert.throws(
    () => loadConfig({ ...validProduction, NODE_ENV: "development", RENDER: "true", CLASSBOT_ADMIN_PASSWORD: "local-admin-local-admin" }),
    /placeholder or development default/,
  );
  assert.equal(loadConfig({ ...validProduction, NODE_ENV: "development", RENDER: "true" }).production, true);
  assert.throws(
    () => loadConfig({ ...validProduction, CLASSBOT_TIMEZONE: "UTC" }),
    /only Asia\/Seoul/,
  );
});

test("기존 Quilo 서버의 Supabase·세션 환경변수를 재사용하고 관리자 비밀번호는 재사용하지 않는다", () => {
  const config = loadConfig({
    ...validProduction,
    CLASSBOT_EMBEDDED: "1",
    CLASSBOT_SESSION_SECRET: "",
    CLASSBOT_ADMIN_PASSWORD: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    SESSION_SECRET: "q".repeat(32),
    ADMIN_PASSWORD: "existing-quilo-admin-password",
    SUPABASE_SERVICE_KEY: "existing-service-key",
  });
  assert.equal(config.sessionSecret, "q".repeat(32));
  assert.equal(config.adminPassword, "");
  assert.equal(config.embedded, true);
  assert.equal(config.supabaseServiceRoleKey, "existing-service-key");
});

test("embedded 운영은 별도 관리자 비밀번호 없이 로드되고 standalone 운영은 계속 요구한다", () => {
  assert.doesNotThrow(() => loadConfig({
    ...validProduction,
    CLASSBOT_EMBEDDED: "1",
    CLASSBOT_ADMIN_PASSWORD: "",
  }));
  assert.throws(
    () => loadConfig({ ...validProduction, CLASSBOT_ADMIN_PASSWORD: "" }),
    /CLASSBOT_ADMIN_PASSWORD/,
  );
});

test("Google Drive 자료실은 Quilo 사용자와 앱 소유 폴더 override만 허용한다", () => {
  const config = loadConfig({
    ...validProduction,
    CLASSBOT_GOOGLE_DRIVE_OWNER_USER_ID: "11111111-2222-3333-4444-555555555555",
    CLASSBOT_GOOGLE_DRIVE_FOLDER_NAME: "Quilo schedule 자료실",
  });
  assert.equal(config.googleDrive.folderId, "");
  assert.equal(config.googleDrive.ownerUserId, "11111111-2222-3333-4444-555555555555");
  assert.equal(config.googleDrive.folderName, "Quilo schedule 자료실");
  assert.throws(
    () => loadConfig({ ...validProduction, CLASSBOT_GOOGLE_DRIVE_FOLDER_ID: "invalid folder/id" }),
    /FOLDER_ID is invalid/,
  );
});
