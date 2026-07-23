"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.join(__dirname, "..", "..");
const source = fs.readFileSync(path.join(root, "server.js"), "utf8");

test("browser login rejects a cross-origin POST before authentication", () => {
  assert.match(source, /function requireTrustedLoginOrigin\(req, res, next\)/);
  assert.match(
    source,
    /app\.post\("\/api\/login", requireTrustedLoginOrigin, async \(req, res\)/,
  );
  assert.match(source, /code: "UNTRUSTED_LOGIN_ORIGIN"/);
});

test("password recovery uses the same trusted-origin boundary and hides account existence", () => {
  assert.match(
    source,
    /app\.post\("\/api\/password-reset\/request", requireTrustedLoginOrigin/,
  );
  assert.match(
    source,
    /app\.post\("\/api\/password-reset\/confirm", requireTrustedLoginOrigin/,
  );
  assert.match(source, /계정에 인증된 이메일이 있으면 비밀번호 재설정 링크를 보냈습니다/);
  assert.match(source, /\[user\?\.username, user\?\.name\]\.some/);
});

test("server startup cannot create, promote, or re-password an administrator from environment variables", () => {
  assert.doesNotMatch(
    source,
    /ensureAdminFromEnv|ADMIN_NAME|ADMIN_PASSWORD|ADMIN_SYNC_PASSWORD|ADMIN_ALLOW_EXISTING_PROMOTION/,
  );
});

test("password changes invalidate markerless legacy browser sessions", () => {
  assert.match(
    source,
    /if \(!freshPwMark \|\| !u\.pwMark \|\| freshPwMark !== u\.pwMark\)/,
  );
});

test("paid write assist refreshes browser security state before provider routing", () => {
  const chat = source.slice(
    source.indexOf('app.post("/api/chat"'),
    source.indexOf('app.post("/api/chat/feedback"'),
  );
  assert.match(chat, /await refreshSessionUser\(req, \{ failClosed: true \}\)/);
  assert.match(chat, /if \(!sessionUser\)[\s\S]*?status\(401\)/);
  assert.ok(
    chat.indexOf("refreshSessionUser") < chat.indexOf("checkPaidLlmLimit"),
    "session freshness must be checked before paid usage/provider work",
  );

  const models = source.slice(
    source.indexOf('app.get("/api/write-assist/models"'),
    source.indexOf('app.get("/api/chat/status"'),
  );
  assert.match(models, /await refreshSessionUser\(req, \{ failClosed: true \}\)/);
  assert.match(models, /loggedIn: !!u/);
});

test("administrator self-demotion cannot bypass boolean validation", () => {
  assert.match(source, /isAdmin !== undefined && typeof isAdmin !== "boolean"/);
  assert.match(source, /actor\?\.id === req\.params\.id && isAdmin === false/);
});

test("the account response exposes an immutable principal id for browser storage isolation", () => {
  const route = source.match(/app\.get\("\/api\/me"[\s\S]*?\n\}\);/)?.[0] || "";
  assert.match(route, /id: u\.id/);
});

test("production refuses to boot without an explicit strong session secret", () => {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    SESSION_SECRET: "short",
  };
  const result = spawnSync(process.execPath, ["-e", "require('./server.js')"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /explicit SESSION_SECRET/);
});

test("production refuses to serve a broken stateful product without Supabase", () => {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    SESSION_SECRET: "a-production-only-secret-longer-than-32-characters",
    SUPABASE_URL: "",
    SUPABASE_SERVICE_KEY: "",
    ALLOW_STATELESS_PRODUCTION: "0",
  };
  const result = spawnSync(process.execPath, ["-e", "require('./server.js')"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /Production requires SUPABASE_URL/);
});
