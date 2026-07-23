"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");
const { createExternalApiMiddleware } = require("../lib/external-api");
const {
  assertPublicDns,
  assertWebhookCapacity,
  buildPinnedHttpsOptions,
  encryptSecret,
  decryptSecret,
  isPrivateAddress,
  requestPinnedWebhook,
  validateWebhookUrl,
} = require("../lib/api-v1/webhooks");
const { claimIdempotency } = require("../lib/api-v1/idempotency");
const { EventEmitter } = require("node:events");
const cloudProviders = require("../lib/cloud/oauth-providers");

test("test-mode access tokens sandbox write operations without calling live handlers", async (t) => {
  const rawToken = `quilo_test_deadbeef_${"S".repeat(43)}`;
  const tokenRow = {
    id: "token-test", user_id: "user-1", name: "sandbox", token_prefix: "deadbeef", token_mode: "test",
    scopes: ["reports:write"], expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  const chain = {
    select() { return this; }, eq() { return this; }, is() { return this; }, gt() { return this; }, update() { return this; },
    maybeSingle() { return Promise.resolve({ data: tokenRow, error: null }); },
    then(resolve) { return Promise.resolve(resolve({ error: null })); },
  };
  const supa = {
    getClient: () => ({ from: () => Object.create(chain) }),
    findUserById: async () => ({ id: "user-1", name: "민준", approved: true, email_verified: true }),
  };
  let liveCalls = 0;
  const app = express();
  app.use(createExternalApiMiddleware({ supa }));
  app.post("/api/generate", (_req, res) => { liveCalls++; res.json({ jobId: "live" }); });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/reports`, {
    method: "POST",
    headers: { authorization: `Bearer ${rawToken}` },
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.sandbox, true);
  assert.equal(body.chargedCredits, 0);
  assert.match(body.jobId, /^sbx_/);
  assert.equal(liveCalls, 0);
});

test("webhook secrets round-trip and private destinations are rejected", () => {
  const encrypted = encryptSecret("whsec_example", "test-key");
  assert.notEqual(encrypted, "whsec_example");
  assert.equal(decryptSecret(encrypted, "test-key"), "whsec_example");
  assert.equal(validateWebhookUrl("https://example.com/hooks"), "https://example.com/hooks");
  assert.throws(() => validateWebhookUrl("http://example.com/hooks"), /HTTPS/);
  assert.throws(() => validateWebhookUrl("https://127.0.0.1/hooks"), /사설 IP/);
  for (const address of [
    "10.0.0.1", "100.64.0.1", "172.16.0.1", "192.0.2.1", "192.88.99.2", "192.168.1.1", "198.18.0.1",
    "::1", "169.254.1.1", "2001:5::1", "2001:db8::1", "fc00::1", "fe80::1", "ff02::1",
    "::ffff:10.0.0.1", "::ffff:172.16.0.1", "::ffff:169.254.1.1", "::ffff:192.168.1.1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2001:4860:4860::8888"), false);
  assert.equal(isPrivateAddress("2001:20::1"), false);
  assert.equal(isPrivateAddress("2001:30::1"), false);
  assert.equal(isPrivateAddress("::ffff:8.8.8.8"), false);
  assert.throws(() => validateWebhookUrl("https://[::ffff:127.0.0.1]/hooks"), /사설 IP/);
});

test("webhook DNS validation rejects mixed public/private answers and returns only validated records", async () => {
  const lookup = async (_hostname, options) => {
    assert.deepEqual(options, { all: true, verbatim: true });
    return [{ address: "93.184.216.34", family: 4 }, { address: "::ffff:169.254.169.254", family: 6 }];
  };
  await assert.rejects(
    assertPublicDns("https://hooks.example/callback", lookup),
    /공개 인터넷 주소/,
  );

  const records = await assertPublicDns("https://hooks.example/callback", async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]);
  assert.deepEqual(records, [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]);
});

test("webhook HTTPS requests pin the validated address while preserving TLS identity and Host", async () => {
  const url = new URL("https://hooks.example/callback?source=quilo");
  const options = buildPinnedHttpsOptions(url, { address: "93.184.216.34", family: 4 }, {
    "content-type": "application/json",
  });
  assert.equal(options.hostname, "93.184.216.34");
  assert.equal(options.family, 4);
  assert.equal(options.servername, "hooks.example");
  assert.equal(options.headers.host, "hooks.example");
  assert.equal(options.path, "/callback?source=quilo");
  assert.equal("lookup" in options, false);
  assert.throws(
    () => buildPinnedHttpsOptions(new URL("http://hooks.example/callback"), { address: "93.184.216.34", family: 4 }),
    /HTTPS/,
  );

  let responseDestroyed = false;
  const fakeRequest = (requestOptions, onResponse) => {
    assert.equal(requestOptions.hostname, "93.184.216.34");
    const request = new EventEmitter();
    request.end = () => onResponse({
      statusCode: 302,
      destroy() { responseDestroyed = true; },
    });
    return request;
  };
  await assert.rejects(
    requestPinnedWebhook(url, { address: "93.184.216.34", family: 4 }, {
      headers: {},
      body: "{}",
      requestImpl: fakeRequest,
    }),
    /redirect/i,
  );
  assert.equal(responseDestroyed, true);
});

test("webhook endpoint creation is rejected at the per-user active endpoint cap", async () => {
  const filters = [];
  const query = {
    select(columns, options) {
      assert.equal(columns, "id");
      assert.deepEqual(options, { count: "exact", head: true });
      return this;
    },
    eq(column, value) { filters.push([column, value]); return this; },
    then(resolve, reject) { return Promise.resolve({ count: 10, error: null }).then(resolve, reject); },
  };
  const client = { from(table) { assert.equal(table, "api_webhook_endpoints"); return query; } };
  await assert.rejects(assertWebhookCapacity(client, "user-1"), (error) => error?.code === "WEBHOOK_LIMIT_REACHED");
  assert.deepEqual(filters, [["user_id", "user-1"], ["enabled", true]]);
});

test("idempotency stores the first response and replays it without executing again", async () => {
  let stored = null;
  const client = {
    from() {
      return {
        insert(row) {
          return {
            select() { return this; },
            single() {
              if (stored) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
              stored = { id: "idem-1", ...row };
              return Promise.resolve({ data: { id: stored.id }, error: null });
            },
          };
        },
        select() {
          return {
            eq() { return this; },
            maybeSingle() { return Promise.resolve({ data: stored, error: null }); },
          };
        },
        update(patch) {
          return {
            eq() {
              stored = { ...stored, ...patch };
              return Promise.resolve({ error: null });
            },
          };
        },
        delete() { return { eq() { stored = null; return Promise.resolve({ error: null }); } }; },
      };
    },
  };
  const request = () => ({
    apiRoute: { idempotent: true, operationId: "createReport" },
    apiUser: { id: "user-1" }, apiAuth: { id: "token-1" },
    get(name) { return name === "idempotency-key" ? "same-request-123" : ""; },
  });
  const response = () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    res.body = null;
    res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
    res.status = (status) => { res.statusCode = status; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
  };
  const sendApiError = (_req, res, status, code, error) => res.status(status).json({ code, error });
  const first = response();
  assert.equal(await claimIdempotency({ req: request(), res: first, client, sendApiError }), false);
  first.status(202).json({ jobId: "job-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stored.state, "completed");
  const second = response();
  assert.equal(await claimIdempotency({ req: request(), res: second, client, sendApiError }), true);
  assert.equal(second.statusCode, 202);
  assert.deepEqual(second.body, { jobId: "job-1" });
  assert.equal(second.headers["idempotent-replayed"], "true");
});

test("cloud OAuth credentials are authenticated-encrypted at rest", () => {
  const previous = process.env.CLOUD_TOKEN_SECRET;
  process.env.CLOUD_TOKEN_SECRET = "test-cloud-secret-with-enough-entropy";
  try {
    const encrypted = cloudProviders.encryptToken("refresh-token-example");
    assert.notEqual(encrypted, "refresh-token-example");
    assert.equal(cloudProviders.decryptToken(encrypted), "refresh-token-example");
    const parts = encrypted.split(":");
    parts[3] = `${parts[3].slice(0, -1)}${parts[3].endsWith("A") ? "B" : "A"}`;
    assert.throws(() => cloudProviders.decryptToken(parts.join(":")));
  } finally {
    if (previous == null) delete process.env.CLOUD_TOKEN_SECRET;
    else process.env.CLOUD_TOKEN_SECRET = previous;
  }
});

test("Google OAuth uses least-privilege Drive file access for Drive and Docs", () => {
  const previous = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    tokenSecret: process.env.CLOUD_TOKEN_SECRET,
  };
  process.env.GOOGLE_CLIENT_ID = "client.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  process.env.CLOUD_TOKEN_SECRET = "test-cloud-token-secret";
  try {
    const url = new URL(cloudProviders.authorizationUrl("google", {
      state: "state",
      redirectUri: "https://quilolab.com/api/cloud/google/callback",
    }));
    const scopes = new Set((url.searchParams.get("scope") || "").split(" "));
    assert.ok(scopes.has("https://www.googleapis.com/auth/drive.file"));
    assert.ok(scopes.has("openid"));
    assert.ok(scopes.has("email"));
    assert.ok(scopes.has("profile"));
    assert.equal(scopes.has("https://www.googleapis.com/auth/documents"), false);
    assert.equal(scopes.has("https://www.googleapis.com/auth/drive"), false);
  } finally {
    if (previous.clientId == null) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = previous.clientId;
    if (previous.clientSecret == null) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = previous.clientSecret;
    if (previous.tokenSecret == null) delete process.env.CLOUD_TOKEN_SECRET;
    else process.env.CLOUD_TOKEN_SECRET = previous.tokenSecret;
  }
});

test("Google Drive helpers preserve folder, source, conversion, and list query metadata", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("upload/drive")) {
      return new Response(JSON.stringify({ id: "file-1", name: "보고서", mimeType: cloudProviders.GOOGLE_DOC_MIME }), { status: 200 });
    }
    return new Response(JSON.stringify({ files: [{ id: "folder-1", name: "Quilo", mimeType: cloudProviders.GOOGLE_FOLDER_MIME }] }), { status: 200 });
  };
  const files = await cloudProviders.listDriveFiles("access", {
    folderId: "parent-1",
    foldersOnly: true,
    query: "Quilo",
    fetchImpl,
  });
  assert.equal(files[0].id, "folder-1");
  const listUrl = new URL(calls[0].url);
  assert.equal(listUrl.searchParams.get("pageSize"), "50");
  assert.match(listUrl.searchParams.get("q"), /'parent-1' in parents/);
  assert.match(listUrl.searchParams.get("q"), /mimeType = 'application\/vnd\.google-apps\.folder'/);
  assert.match(listUrl.searchParams.get("q"), /name contains 'Quilo'/);

  await cloudProviders.uploadDriveFile("access", {
    name: "보고서.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    targetMimeType: cloudProviders.GOOGLE_DOC_MIME,
    folderId: "folder-1",
    appProperties: { quiloSourceKey: "report:1:gdoc" },
    buffer: Buffer.from("docx"),
    fetchImpl,
  });
  const upload = calls[1];
  assert.equal(upload.options.method, "POST");
  assert.match(upload.options.headers["content-type"], /^multipart\/related; boundary=/);
  const multipart = upload.options.body.toString("utf8");
  assert.match(multipart, /"parents":\["folder-1"\]/);
  assert.match(multipart, /"mimeType":"application\/vnd\.google-apps\.document"/);
  assert.match(multipart, /"quiloSourceKey":"report:1:gdoc"/);
});

test("Google token revocation posts the token without exposing it in the URL", async () => {
  let captured = null;
  const ok = await cloudProviders.revokeGoogleToken("refresh-secret", {
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return new Response("", { status: 200 });
    },
  });
  assert.equal(ok, true);
  assert.equal(captured.url, "https://oauth2.googleapis.com/revoke");
  assert.equal(captured.options.method, "POST");
  assert.equal(String(captured.options.body), "token=refresh-secret");
  assert.doesNotMatch(captured.url, /refresh-secret/);
});

test("Google Drive compensation delete is scoped, authenticated, and idempotent", async () => {
  const calls = [];
  assert.equal(await cloudProviders.deleteDriveFile("access", ""), false);
  assert.equal(await cloudProviders.deleteDriveFile("access", "file /한글", {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(null, { status: 204 });
    },
  }), true);
  assert.equal(calls[0].url, "https://www.googleapis.com/drive/v3/files/file%20%2F%ED%95%9C%EA%B8%80");
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(calls[0].options.headers.authorization, "Bearer access");

  assert.equal(await cloudProviders.deleteDriveFile("access", "already-gone", {
    fetchImpl: async () => new Response("missing", { status: 404 }),
  }), true);
});
