"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const test = require("node:test");
const express = require("express");
const { createMcpRouter, TOOLS } = require("../lib/mcp/server");
const { createMcpOAuthRouter, pkceChallenge, safeRedirectUris } = require("../lib/mcp/oauth");

async function listen(app, t) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("MCP initializes, lists annotated tools, and exposes public catalog search", async (t) => {
  const app = express();
  app.use(express.json());
  const origin = await listen(app, t);
  app.use("/mcp", createMcpRouter({ baseUrl: () => origin, supa: null }));
  const rpc = async (method, params, id = 1) => {
    const response = await fetch(`${origin}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    return response.json();
  };
  const initialized = await rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(initialized.result.serverInfo.name, "Quilo");
  const listed = await rpc("tools/list", {});
  assert.equal(listed.result.tools.length, TOOLS.length);
  const email = listed.result.tools.find((item) => item.name === "job_email");
  assert.equal(email.annotations.readOnlyHint, false);
  assert.deepEqual(email.securitySchemes[0].scopes, ["jobs:write"]);
  const searched = await rpc("tools/call", { name: "search", arguments: { query: "PDF" } });
  assert.ok(searched.result.structuredContent.results.length > 0);
  assert.ok(searched.result.structuredContent.results.every((item) => item.title && item.text));
});

test("MCP catalog search and fetch hide server-retired features", async (t) => {
  const retired = new Set([
    "phys-inquiry",
    "math-inquiry",
    "eng-exam-prep",
    "korean-lit-exam",
    "phys-mock-exam",
  ]);
  const app = express();
  app.use(express.json());
  const origin = await listen(app, t);
  app.use(
    "/mcp",
    createMcpRouter({ baseUrl: () => origin, supa: null, excludeFeatureIds: retired }),
  );
  const rpc = async (name, args, id) => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return response.json();
  };

  const searched = await rpc("search", { query: "수행평가 시험" }, 10);
  assert.equal(
    searched.result.structuredContent.results.some((feature) => retired.has(feature.id)),
    false,
  );
  const fetched = await rpc("fetch", { id: "phys-inquiry" }, 11);
  assert.equal(fetched.result.isError, true);
  assert.match(fetched.result.structuredContent.error, /찾을 수 없습니다/);
});

test("MCP protected tools return OAuth challenge and accept audience-bound tokens", async (t) => {
  const raw = `quilo_live_deadbeef_${"x".repeat(43)}`;
  const chain = {
    select() { return this; }, eq() { return this; }, is() { return this; }, gt() { return this; },
    maybeSingle() { return Promise.resolve({ data: { id: "token-1", audience: this.audience }, error: null }); },
  };
  const supa = { getClient: () => ({ from: () => Object.create(chain) }) };
  const app = express();
  app.use(express.json());
  const origin = await listen(app, t);
  chain.audience = `${origin}/mcp`;
  app.use("/mcp", createMcpRouter({ baseUrl: () => origin, supa }));
  app.get("/api/v1/jobs", (req, res) => req.get("authorization") === `Bearer ${raw}` ? res.json({ jobs: [{ id: "job-mcp" }] }) : res.status(401).json({ error: "auth" }));
  const call = async (authorization) => {
    const headers = { "content-type": "application/json" };
    if (authorization) headers.authorization = authorization;
    const response = await fetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jobs_list", arguments: {} } }) });
    return response.json();
  };
  const denied = await call();
  assert.match(denied.result._meta["mcp/www_authenticate"][0], /oauth-protected-resource/);
  const allowed = await call(`Bearer ${raw}`);
  assert.equal(allowed.result.structuredContent.jobs[0].id, "job-mcp");
});

test("OAuth metadata, PKCE, and DCR redirect validation follow the remote MCP contract", async (t) => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  assert.equal(pkceChallenge(verifier), crypto.createHash("sha256").update(verifier).digest("base64url"));
  assert.deepEqual(safeRedirectUris(["https://chatgpt.com/connector/oauth/example"]), ["https://chatgpt.com/connector/oauth/example"]);
  assert.deepEqual(safeRedirectUris(["https://evil.example/callback"]), []);
  const inserted = [];
  const supa = { getClient: () => ({ from: () => ({ insert: async (row) => { inserted.push(row); return { error: null }; } }) }) };
  const app = express();
  app.use(express.json());
  const origin = await listen(app, t);
  app.use(createMcpOAuthRouter({ supa, getSessionUser: () => null, baseUrl: () => origin }));
  const metadata = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(metadata.resource, `${origin}/mcp`);
  const discovery = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
  assert.equal(discovery.registration_endpoint, `${origin}/oauth/register`);
  assert.deepEqual(discovery.code_challenge_methods_supported, ["S256"]);
  const registered = await fetch(`${origin}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector/oauth/example"], token_endpoint_auth_method: "none" }),
  });
  assert.equal(registered.status, 201);
  assert.match((await registered.json()).client_id, /^quilo_mcp_/);
  assert.equal(inserted.length, 1);
});

test("custom OAuth redirect allowlist entries require an exact URL match", () => {
  const previous = process.env.MCP_OAUTH_REDIRECT_ALLOWLIST;
  process.env.MCP_OAUTH_REDIRECT_ALLOWLIST = "https://trusted.example/oauth/callback";
  try {
    assert.deepEqual(
      safeRedirectUris(["https://trusted.example/oauth/callback"]),
      ["https://trusted.example/oauth/callback"],
    );
    assert.deepEqual(
      safeRedirectUris(["https://trusted.example/oauth/callback.evil.test/steal"]),
      [],
    );
    assert.deepEqual(
      safeRedirectUris(["https://trusted.example/oauth/callback/extra"]),
      [],
    );
  } finally {
    if (previous === undefined) delete process.env.MCP_OAUTH_REDIRECT_ALLOWLIST;
    else process.env.MCP_OAUTH_REDIRECT_ALLOWLIST = previous;
  }
});

test("MCP Drive content tools request data scope instead of status-only scope", () => {
  assert.deepEqual(
    TOOLS.find((item) => item.name === "integrations_status").securitySchemes[0].scopes,
    ["integrations:read"],
  );
  assert.deepEqual(
    TOOLS.find((item) => item.name === "google_drive_files").securitySchemes[0].scopes,
    ["integrations:data"],
  );
  assert.deepEqual(
    TOOLS.find((item) => item.name === "google_drive_comments").securitySchemes[0].scopes,
    ["integrations:data"],
  );
});

test("OAuth authorization accepts supported Set-backed scopes and renders consent", async (t) => {
  const registered = {
    client_id: "quilo_mcp_client",
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/example"],
  };
  const chain = {
    select() { return this; },
    eq() { return this; },
    maybeSingle() { return Promise.resolve({ data: registered, error: null }); },
  };
  const app = express();
  app.use((req, _res, next) => { req.session = {}; next(); });
  const origin = await listen(app, t);
  app.use(createMcpOAuthRouter({
    supa: { getClient: () => ({ from: () => Object.create(chain) }) },
    getSessionUser: () => ({ id: "user-1" }),
    baseUrl: () => origin,
  }));
  const query = new URLSearchParams({
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: registered.redirect_uris[0],
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
    scope: "integrations:read integrations:data",
  });
  const response = await fetch(`${origin}/oauth/authorize?${query}`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /integrations:read/);
  assert.match(body, /integrations:data/);
});
