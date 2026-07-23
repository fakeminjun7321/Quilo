"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const {
  createCatalogRouter,
  createExternalApiMiddleware,
  createOpenApiRouter,
  createTokenRouter,
  createV1Router,
  normalizeScopes,
} = require("../lib/external-api");
const { listFeatures } = require("../lib/quilo-catalog");

test("catalog represents the broad Quilo product, not only reports", () => {
  const features = listFeatures();
  assert.ok(features.length >= 30);
  for (const id of ["print-pdf-restore", "pdf-translate", "cap-translate", "image-ocr", "pdf-analysis", "vibe-coding", "file-chat", "quilo-schedule", "community", "lab", "dropbox", "google-drive", "google-docs", "notion", "email-results", "codex-plugin"]) {
    assert.ok(features.some((feature) => feature.id === id), `missing ${id}`);
  }
  assert.ok(new Set(features.map((feature) => feature.category)).size >= 6);
  assert.equal(features.find((feature) => feature.id === "chem-pre").execution, "remote");
  assert.equal(features.find((feature) => feature.id === "pdf-translate").execution, "remote");
  assert.equal(features.find((feature) => feature.id === "word-count").execution, "remote");
  assert.equal(features.find((feature) => feature.id === "lab").execution, "read-only");
  assert.equal(features.find((feature) => feature.id === "phys-inquiry").execution, "paused");
  assert.equal(features.find((feature) => feature.id === "vibe-coding").execution, "remote");
  assert.equal(features.find((feature) => feature.id === "file-chat").execution, "remote");
  assert.equal(features.find((feature) => feature.id === "pdf-analysis").path, "/tools/pdf-analysis.html");
  assert.equal(features.find((feature) => feature.id === "quilo-schedule").path, "/schedule/");
  assert.equal(features.find((feature) => feature.id === "community").execution, "remote");
  assert.equal(features.find((feature) => feature.id === "cap-translate").status, "pro");
  assert.equal(features.find((feature) => feature.id === "cap-translate").execution, "remote");
  assert.equal(features.find((feature) => feature.id === "print-pdf-restore").audience, "admin");
  assert.equal(features.find((feature) => feature.id === "print-pdf-restore").status, "beta");
  assert.deepEqual(features.find((feature) => feature.id === "print-pdf-restore").formats, ["pdf"]);
  for (const id of ["dropbox", "google-drive", "google-docs", "notion"]) {
    assert.equal(features.find((feature) => feature.id === id).path, "/#integrations");
  }
});

test("background jobs panel labels every pipeline feature in Korean", () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/workspace/background-jobs.js"), "utf8");
  const literal = source.match(/const TYPE_LABELS = (\{[\s\S]*?\});/)?.[1];
  assert.ok(literal, "TYPE_LABELS object not found in background-jobs.js");
  const TYPE_LABELS = new Function(`return ${literal};`)();
  const pipelines = listFeatures().filter((feature) => feature.kind === "pipeline");
  assert.ok(pipelines.length >= 16);
  for (const feature of pipelines) {
    const label = TYPE_LABELS[feature.id];
    assert.ok(typeof label === "string" && label.trim() && label !== feature.id,
      `TYPE_LABELS missing "${feature.id}" (${feature.title}) — 백그라운드 작업 목록에 raw id가 노출된다`);
  }
});

test("every /?report= link resolves to a reportType radio or a registered alias", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const radios = new Set(
    [...html.matchAll(/<input[^>]*name="reportType"[^>]*value="([^"]+)"/g)].map((m) => m[1]),
  );
  // 퇴역한 다섯 파이프라인은 숨김 라디오로도 공개 HTML에 남기지 않는다.
  assert.ok(radios.size >= 10, "active reportType radios missing from index.html");

  // report-registry.js는 자급자족 ESM(import문·최상위 DOM 접근 없음)이라 실제 export를
  // 그대로 검증한다. 패키지가 "type":"commonjs"라 파일 경로 import는 CJS로 파싱되므로
  // data: URL로 ESM 강제 로드한다.
  const registrySource = fs.readFileSync(path.join(__dirname, "../public/workspace/report-registry.js"), "utf8");
  const { REPORT_ALIASES } = await import(`data:text/javascript,${encodeURIComponent(registrySource)}`);
  for (const [id, alias] of Object.entries(REPORT_ALIASES)) {
    assert.ok(!radios.has(id), `${id} must not be both an alias and a radio`);
    assert.ok(radios.has(alias.base), `alias ${id} points at missing radio "${alias.base}"`);
  }
  assert.equal(REPORT_ALIASES["reading-log-bulk"]?.base, "reading-log");

  const resolvable = (id) => radios.has(id) || Object.prototype.hasOwnProperty.call(REPORT_ALIASES, id);
  const catalogIds = listFeatures()
    .map((feature) => String(feature.path || ""))
    .filter((featurePath) => featurePath.startsWith("/?report="))
    .map((featurePath) => featurePath.slice("/?report=".length));
  assert.ok(catalogIds.includes("reading-log-bulk"));
  for (const id of catalogIds) assert.ok(resolvable(id), `catalog link /?report=${id} is dead`);

  const shell = fs.readFileSync(path.join(__dirname, "../public/ui/shell.js"), "utf8");
  for (const [, id] of shell.matchAll(/\/\?report=([a-z0-9-]+)/g)) {
    assert.ok(resolvable(id), `shell nav link /?report=${id} is dead`);
  }
});

test("PDF analysis is exposed as a real browser workspace instead of a catalog-only link", () => {
  const page = fs.readFileSync(path.join(__dirname, "../public/tools/pdf-analysis.html"), "utf8");
  const runtime = fs.readFileSync(path.join(__dirname, "../public/ui/pdf-analysis.js"), "utf8");
  const shell = fs.readFileSync(path.join(__dirname, "../public/ui/shell.js"), "utf8");
  assert.match(page, /id="pdfAnalysisFile"/);
  assert.match(page, /id="pdfAnalysisResult"/);
  assert.match(runtime, /fetch\("\/api\/tools\/pdf\/analyze"/);
  assert.match(shell, /"pdf-analysis"[^\n]+"\/tools\/pdf-analysis\.html"/);
});

test("Quilo schedule stays available by direct URL but is hidden from the Quilo site shell", () => {
  const schedule = listFeatures().find((feature) => feature.id === "quilo-schedule");
  const shell = fs.readFileSync(path.join(__dirname, "../public/ui/shell.js"), "utf8");
  assert.equal(schedule.path, "/schedule/");
  assert.match(shell, /HIDDEN_FEATURE_IDS = new Set\(\["quilo-schedule"\]\)/);
  assert.match(shell, /if \(HIDDEN_FEATURE_IDS\.has\(id\)\) return null/);
  assert.match(shell, /filter\(\(item\) => !HIDDEN_FEATURE_IDS\.has\(item\.id\)\)/);
});

test("scope normalization rejects unknown permissions", () => {
  assert.deepEqual(normalizeScopes(["account:read", "admin:write", "account:read"]), ["account:read"]);
});

test("public catalog API supports search", async (t) => {
  const app = express();
  app.use("/api/catalog", createCatalogRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/catalog?q=PDF`);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=300, stale-while-revalidate=3600",
  );
  const body = await response.json();
  assert.ok(body.features.some((feature) => feature.id === "pdf-translate"));
});

test("the deployed catalog can hide retired features without deleting catalog data", async (t) => {
  const retired = new Set([
    "phys-inquiry",
    "math-inquiry",
    "eng-exam-prep",
    "korean-lit-exam",
    "phys-mock-exam",
  ]);
  const app = express();
  app.use("/api/catalog", createCatalogRouter({ excludeFeatureIds: retired }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  const listResponse = await fetch(`${origin}/api/catalog`);
  assert.equal(listResponse.status, 200);
  const body = await listResponse.json();
  assert.equal(body.features.some((feature) => retired.has(feature.id)), false);
  assert.equal(body.total, body.features.length);

  for (const id of retired) {
    const detailResponse = await fetch(`${origin}/api/catalog/${id}`);
    assert.equal(detailResponse.status, 404, `${id} detail leaked from catalog`);
  }

  // 원본 카탈로그는 삭제하지 않아 재개 시 단일 필터만 해제하면 된다.
  assert.ok(listFeatures().some((feature) => feature.id === "phys-inquiry"));
});

test("v1 middleware requires bearer auth and rewrites an allowed job route", async (t) => {
  const rawToken = `quilo_deadbeef_${"A".repeat(43)}`;
  const tokenRow = {
    id: "token-1",
    user_id: "user-1",
    name: "test",
    token_prefix: "deadbeef",
    scopes: ["jobs:read"],
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  const chain = {
    select() { return this; }, eq() { return this; }, is() { return this; }, gt() { return this; },
    update() { return this; },
    maybeSingle() { return Promise.resolve({ data: tokenRow, error: null }); },
    then(resolve) { return Promise.resolve(resolve({ data: null, error: null })); },
  };
  const supa = {
    getClient: () => ({ from: () => Object.create(chain) }),
    findUserById: async () => ({ id: "user-1", name: "민준", approved: true, email_verified: true }),
  };
  const app = express();
  app.use(createExternalApiMiddleware({ supa }));
  app.get("/api/me/jobs", (req, res) => res.json({ ok: true, user: req.apiUser.id }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const denied = await fetch(`http://127.0.0.1:${port}/api/v1/jobs`);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("x-request-id") || "", /^req_/);
  const deniedBody = await denied.json();
  assert.equal(deniedBody.code, "INVALID_ACCESS_TOKEN");
  assert.equal(deniedBody.requestId, denied.headers.get("x-request-id"));

  const allowed = await fetch(`http://127.0.0.1:${port}/api/v1/jobs`, {
    headers: { authorization: `Bearer ${rawToken}` },
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { ok: true, user: "user-1" });
});

test("v1 job detail returns only the authenticated user's runtime job", async (t) => {
  const rawToken = `quilo_deadbeef_${"B".repeat(43)}`;
  const tokenRow = {
    id: "token-2",
    user_id: "user-1",
    name: "job-reader",
    token_prefix: "deadbeef",
    scopes: ["jobs:read"],
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  const chain = {
    select() { return this; }, eq() { return this; }, is() { return this; }, gt() { return this; },
    update() { return this; },
    maybeSingle() { return Promise.resolve({ data: tokenRow, error: null }); },
    then(resolve) { return Promise.resolve(resolve({ data: null, error: null })); },
  };
  const supa = {
    getClient: () => ({ from: () => Object.create(chain) }),
    findUserById: async () => ({ id: "user-1", name: "민준", approved: true, email_verified: true }),
    getReportJob: async () => null,
  };
  const jobs = new Map([
    ["mine", { id: "mine", userInfo: { id: "user-1" }, status: "running", progress: ["준비 중"], createdAt: Date.now() }],
    ["other", { id: "other", userInfo: { id: "user-2" }, status: "running", progress: [] }],
    ["retired", { id: "retired", userInfo: { id: "user-1" }, reportType: "phys-inquiry", status: "done", progress: [] }],
  ]);
  const app = express();
  app.use(createExternalApiMiddleware({ supa }));
  app.use(
    "/api/v1",
    createV1Router({
      supa,
      getRuntimeJob: (id) => jobs.get(id) || null,
      excludeReportTypes: new Set(["phys-inquiry"]),
    }),
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const headers = { authorization: `Bearer ${rawToken}` };

  const mine = await fetch(`http://127.0.0.1:${port}/api/v1/jobs/mine`, { headers });
  assert.equal(mine.status, 200);
  const mineBody = await mine.json();
  assert.equal(mineBody.job.id, "mine");
  assert.equal(mineBody.job.status, "running");
  assert.deepEqual(mineBody.job.progress, ["준비 중"]);

  const other = await fetch(`http://127.0.0.1:${port}/api/v1/jobs/other`, { headers });
  assert.equal(other.status, 404);
  assert.equal((await other.json()).code, "JOB_NOT_FOUND");

  const retiredJob = await fetch(`http://127.0.0.1:${port}/api/v1/jobs/retired`, { headers });
  assert.equal(retiredJob.status, 404);
  assert.equal((await retiredJob.json()).code, "JOB_NOT_FOUND");
});

test("v1 account does not treat a retired-only beta grant as Pro", async (t) => {
  const rawToken = `quilo_deadbeef_${"C".repeat(43)}`;
  const tokenRow = {
    id: "token-account",
    user_id: "user-1",
    name: "account-reader",
    token_prefix: "deadbeef",
    scopes: ["account:read"],
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  const chain = {
    select() { return this; }, eq() { return this; }, is() { return this; }, gt() { return this; },
    update() { return this; },
    maybeSingle() { return Promise.resolve({ data: tokenRow, error: null }); },
    then(resolve) { return Promise.resolve(resolve({ data: null, error: null })); },
  };
  let featureKeys = ["phys-inquiry"];
  const supa = {
    getClient: () => ({ from: () => Object.create(chain) }),
    findUserById: async () => ({ id: "user-1", name: "민준", approved: true, email_verified: true }),
    getCredits: async () => 7,
    getUserBetaFeatures: async () => featureKeys,
    getActiveBackgroundSub: async () => null,
  };
  const app = express();
  app.use(createExternalApiMiddleware({ supa }));
  app.use("/api/v1", createV1Router({
    supa,
    excludeReportTypes: new Set(["phys-inquiry"]),
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}/api/v1/account`;
  const headers = { authorization: `Bearer ${rawToken}` };

  const retiredOnly = await fetch(endpoint, { headers });
  assert.equal(retiredOnly.status, 200);
  assert.equal((await retiredOnly.json()).plan, "free");

  featureKeys = ["phys-inquiry", "pro"];
  const active = await fetch(endpoint, { headers });
  assert.equal(active.status, 200);
  assert.equal((await active.json()).plan, "pro");
});

test("OpenAPI document is public and generated from the v1 route registry", async (t) => {
  const app = express();
  app.use("/api/openapi.json", createOpenApiRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/openapi.json`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.openapi, "3.1.0");
  assert.equal(body.paths["/api/v1/jobs/{id}"].get["x-quilo-scope"], "jobs:read");
  assert.equal(body.paths["/api/v1/reports"].post["x-quilo-scope"], "reports:write");
  assert.equal(body.paths["/api/v1/pdf-translations"].post["x-quilo-scope"], "translations:write");
  assert.equal(body.paths["/api/v1/pdf-translations/estimate"].post["x-quilo-scope"], "translations:read");
  assert.equal(body.paths["/api/v1/conversions/docx-to-hwpx"].post["x-quilo-scope"], "conversions:write");
  assert.equal(body.paths["/api/v1/documents/pdf/analyze"].post["x-quilo-scope"], "documents:read");
  assert.equal(body.paths["/api/v1/documents/hwpx/equations"].post["x-quilo-scope"], "documents:write");
  assert.equal(body.paths["/api/v1/documents/images/ocr"].post["x-quilo-scope"], "documents:write");
  assert.equal(body.paths["/api/v1/api-requests"].get["x-quilo-scope"], "account:read");
  assert.equal(body.paths["/api/v1/jobs/{id}/email"].post["x-quilo-scope"], "jobs:write");
  assert.equal(body.paths["/api/v1/integrations/google-drive/files"].post["x-quilo-scope"], "integrations:write");
  assert.equal(body.paths["/api/v1/integrations/google-drive/reports/{id}"].post["x-quilo-scope"], "integrations:write");
  assert.equal(body.paths["/api/v1/integrations/google-drive/files/{id}/comments"].get["x-quilo-scope"], "integrations:data");
  assert.equal(body.paths["/api/v1/integrations/google-drive/files/{id}/comments"].post["x-quilo-scope"], "integrations:write");
  assert.equal(body.paths["/api/v1/integrations/google-docs"].post["x-quilo-scope"], "integrations:write");
  assert.equal(body.paths["/api/v1/integrations/google-docs/{id}/append"].post["x-quilo-scope"], "integrations:write");
  assert.equal(body.paths["/api/v1/integrations/notion/pages"].post["x-quilo-scope"], "integrations:write");
  assert.equal(body.paths["/api/v1/webhooks"].post["x-quilo-scope"], "webhooks:write");
  assert.ok(body.components.securitySchemes.bearerAuth["x-scopes"]["account:read"]);
});

test("API request telemetry records route, scope, status, and request id", async (t) => {
  const rawToken = `quilo_deadbeef_${"E".repeat(43)}`;
  let logged = null;
  const tokenRow = { id: "token-5", user_id: "user-1", name: "telemetry", token_prefix: "deadbeef", scopes: ["account:read"], expires_at: new Date(Date.now() + 60000).toISOString() };
  const authChain = {
    select() { return this; }, eq() { return this; }, is() { return this; }, gt() { return this; }, update() { return this; },
    maybeSingle() { return Promise.resolve({ data: tokenRow, error: null }); },
    then(resolve) { return Promise.resolve(resolve({ data: null, error: null })); },
  };
  const client = {
    from(table) {
      if (table === "api_request_logs") return { insert(row) { logged = row; return Promise.resolve({ error: null }); } };
      return Object.create(authChain);
    },
  };
  const supa = {
    getClient: () => client,
    findUserById: async () => ({ id: "user-1", name: "민준", approved: true, email_verified: true }),
    listApiRequestLogs: async () => [{ requestId: "old" }],
  };
  const app = express();
  app.use(createExternalApiMiddleware({ supa }));
  app.use("/api/v1", createV1Router({ supa }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/api-requests`, {
    headers: { authorization: `Bearer ${rawToken}`, "x-request-id": "request-custom-123" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).requests, [{ requestId: "old" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logged.request_id, "request-custom-123");
  assert.equal(logged.path, "/api/v1/api-requests");
  assert.equal(logged.scope, "account:read");
  assert.equal(logged.status, 200);
});

test("PDF translation and conversion routes require their own scopes", async (t) => {
  const rawToken = `quilo_deadbeef_${"C".repeat(43)}`;
  const tokenRow = {
    id: "token-3",
    user_id: "user-1",
    name: "translator",
    token_prefix: "deadbeef",
    scopes: ["translations:read", "translations:write", "conversions:write"],
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  const chain = {
    select() { return this; }, eq() { return this; }, is() { return this; }, gt() { return this; },
    update() { return this; },
    insert() { return { select() { return this; }, single() { return Promise.resolve({ data: { id: "idem-1" }, error: null }); }, then(resolve) { return Promise.resolve(resolve({ error: null })); } }; },
    maybeSingle() { return Promise.resolve({ data: tokenRow, error: null }); },
    then(resolve) { return Promise.resolve(resolve({ data: null, error: null })); },
  };
  const supa = {
    getClient: () => ({ from: () => Object.create(chain) }),
    findUserById: async () => ({ id: "user-1", name: "민준", approved: true, email_verified: true }),
  };
  const app = express();
  app.use(createExternalApiMiddleware({ supa }));
  app.post("/api/translate-pdf/estimate", (_req, res) => res.json({ route: "estimate" }));
  app.post("/api/translate-pdf", (_req, res) => res.json({ route: "translate" }));
  app.post("/api/convert-docx", (_req, res) => res.json({ route: "convert" }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const headers = { authorization: `Bearer ${rawToken}`, "idempotency-key": "test-request-1234" };

  for (const [path, route] of [
    ["/api/v1/pdf-translations/estimate", "estimate"],
    ["/api/v1/pdf-translations", "translate"],
    ["/api/v1/conversions/docx-to-hwpx", "convert"],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).route, route);
  }
});

test("document analysis and processing routes use separate read and write scopes", async (t) => {
  const rawToken = `quilo_deadbeef_${"F".repeat(43)}`;
  const tokenRow = {
    id: "token-documents",
    user_id: "user-1",
    name: "documents",
    token_prefix: "deadbeef",
    scopes: ["documents:read", "documents:write"],
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  const chain = {
    select() { return this; }, eq() { return this; }, is() { return this; }, gt() { return this; }, update() { return this; },
    maybeSingle() { return Promise.resolve({ data: tokenRow, error: null }); },
    then(resolve) { return Promise.resolve(resolve({ data: null, error: null })); },
  };
  const supa = {
    getClient: () => ({ from: () => Object.create(chain) }),
    findUserById: async () => ({ id: "user-1", name: "민준", approved: true, email_verified: true }),
  };
  const app = express();
  app.use(createExternalApiMiddleware({ supa }));
  app.post("/api/tools/pdf/analyze", (_req, res) => res.json({ route: "pdf-analysis" }));
  app.post("/api/tools/hwpx/equations", (_req, res) => res.json({ route: "equations" }));
  app.post("/api/tools/images/ocr", (_req, res) => res.json({ route: "ocr" }));
  app.post("/api/tools/images/ocr/export", (_req, res) => res.json({ route: "ocr-export" }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const headers = { authorization: `Bearer ${rawToken}` };
  for (const [path, route] of [
    ["/api/v1/documents/pdf/analyze", "pdf-analysis"],
    ["/api/v1/documents/hwpx/equations", "equations"],
    ["/api/v1/documents/images/ocr", "ocr"],
    ["/api/v1/documents/images/ocr/export", "ocr-export"],
  ]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", headers });
    assert.equal(response.status, 200, path);
    assert.equal((await response.json()).route, route);
  }
});

test("studio, file chat, knowledge, and community v1 routes use dedicated scopes", async (t) => {
  const rawToken = `quilo_deadbeef_${"D".repeat(43)}`;
  const tokenRow = {
    id: "token-4",
    user_id: "user-1",
    name: "platform",
    token_prefix: "deadbeef",
    scopes: ["studios:read", "studios:write", "chat:write", "knowledge:read", "community:read", "community:write"],
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  const chain = {
    select() { return this; }, eq() { return this; }, is() { return this; }, gt() { return this; },
    update() { return this; },
    maybeSingle() { return Promise.resolve({ data: tokenRow, error: null }); },
    then(resolve) { return Promise.resolve(resolve({ data: null, error: null })); },
  };
  const supa = {
    getClient: () => ({ from: () => Object.create(chain) }),
    findUserById: async () => ({ id: "user-1", name: "민준", approved: true, email_verified: true }),
  };
  const app = express();
  app.use(express.json());
  app.use(createExternalApiMiddleware({ supa }));
  for (const [method, path, route] of [
    ["get", "/api/vibe/config", "vibe-config"],
    ["post", "/api/vibe/generate", "vibe-generate"],
    ["post", "/api/physics-studio/generate", "physics"],
    ["get", "/api/filechat/access", "chat-access"],
    ["post", "/api/filechat", "chat"],
    ["get", "/api/lab/entries", "lab"],
    ["get", "/api/community/posts", "community-read"],
    ["post", "/api/community/posts", "community-write"],
  ]) app[method](path, (_req, res) => res.json({ route }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const headers = { authorization: `Bearer ${rawToken}`, "content-type": "application/json" };
  for (const [method, path, route] of [
    ["GET", "/api/v1/studios/vibe/config", "vibe-config"],
    ["POST", "/api/v1/studios/vibe/generate", "vibe-generate"],
    ["POST", "/api/v1/studios/physics/generate", "physics"],
    ["GET", "/api/v1/file-chat/access", "chat-access"],
    ["POST", "/api/v1/file-chat/messages", "chat"],
    ["GET", "/api/v1/knowledge/lab", "lab"],
    ["GET", "/api/v1/community/posts", "community-read"],
    ["POST", "/api/v1/community/posts", "community-write"],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: method === "POST" ? "{}" : undefined });
    assert.equal(response.status, 200, `${method} ${path}`);
    assert.equal((await response.json()).route, route);
  }
});

test("token management returns JSON 401 instead of a login redirect", async (t) => {
  const app = express();
  app.use(express.json());
  app.use("/api/integrations", createTokenRouter({
    supa: { getClient: () => null },
    getSessionUser: () => null,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/integrations/tokens`, { redirect: "manual" });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  assert.deepEqual(await response.json(), { error: "로그인이 필요합니다." });
});
