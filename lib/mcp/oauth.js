"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { ALLOWED_SCOPES, normalizeScopes } = require("../api-v1/scopes");
const { hashAccessToken } = require("../external-api");

const CLIENTS = "mcp_oauth_clients";
const CODES = "mcp_oauth_codes";
const REFRESH = "mcp_oauth_refresh_tokens";
const ACCESS = "user_access_tokens";
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
const REGISTRATION_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.MCP_OAUTH_REGISTRATION_LIMIT || "30", 10) || 30,
);
const registrationAttempts = new Map();
const DEFAULT_SCOPES = Object.freeze([
  "account:read", "jobs:read", "jobs:write", "tools:read",
  "studios:read", "studios:write", "community:read", "community:write",
  "integrations:read", "integrations:data", "integrations:write", "webhooks:read", "webhooks:write",
]);

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString("base64url"); }
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function pkceChallenge(verifier) { return crypto.createHash("sha256").update(String(verifier)).digest("base64url"); }
function oauthError(res, status, error, description) {
  res.status(status).json({ error, error_description: description });
}
function safeRedirectUris(values) {
  if (!Array.isArray(values) || !values.length || values.length > 10) return [];
  const extra = String(process.env.MCP_OAUTH_REDIRECT_ALLOWLIST || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.hash) return [];
        return [url.toString()];
      } catch {
        return [];
      }
    });
  return [...new Set(values.map(String))].filter((value) => {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.hash) return false;
      if (url.protocol !== "https:") {
        return process.env.NODE_ENV !== "production" &&
          ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
      }
      return url.hostname === "chatgpt.com" ||
        url.hostname.endsWith(".chatgpt.com") ||
        extra.includes(url.toString());
    } catch { return false; }
  });
}

function consumeRegistrationAttempt(req, now = Date.now()) {
  const key = String(req.ip || req.socket?.remoteAddress || "unknown");
  const current = registrationAttempts.get(key);
  const entry = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + REGISTRATION_WINDOW_MS }
    : current;
  entry.count += 1;
  registrationAttempts.set(key, entry);
  if (registrationAttempts.size > 5000) {
    for (const [storedKey, stored] of registrationAttempts) {
      if (stored.resetAt <= now) registrationAttempts.delete(storedKey);
    }
  }
  return {
    allowed: entry.count <= REGISTRATION_LIMIT,
    retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
  };
}
function rawAccessToken() {
  const prefix = crypto.randomBytes(4).toString("hex");
  return { prefix, raw: `quilo_live_${prefix}_${randomToken(32)}` };
}
function html(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function createMcpOAuthRouter({ supa, getSessionUser, baseUrl }) {
  const router = express.Router();
  const client = () => supa.getClient();
  const issuer = (req) => baseUrl(req);
  const resource = (req) => `${baseUrl(req)}/mcp`;

  router.get("/.well-known/oauth-protected-resource", (req, res) => res.json({
    resource: resource(req), authorization_servers: [issuer(req)], scopes_supported: [...ALLOWED_SCOPES],
    resource_documentation: `${baseUrl(req)}/developers.html`,
  }));
  router.get("/.well-known/oauth-protected-resource/mcp", (req, res) => res.json({
    resource: resource(req), authorization_servers: [issuer(req)], scopes_supported: [...ALLOWED_SCOPES],
    resource_documentation: `${baseUrl(req)}/developers.html`,
  }));
  router.get("/.well-known/oauth-authorization-server", (req, res) => res.json({
    issuer: issuer(req),
    authorization_endpoint: `${baseUrl(req)}/oauth/authorize`,
    token_endpoint: `${baseUrl(req)}/oauth/token`,
    registration_endpoint: `${baseUrl(req)}/oauth/register`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...ALLOWED_SCOPES],
  }));

  router.post("/oauth/register", async (req, res) => {
    const registration = consumeRegistrationAttempt(req);
    if (!registration.allowed) {
      res.set("Retry-After", String(registration.retryAfter));
      return oauthError(res, 429, "slow_down", "Too many OAuth client registrations.");
    }
    const db = client();
    if (!db) return oauthError(res, 503, "temporarily_unavailable", "OAuth storage is unavailable.");
    const redirectUris = safeRedirectUris(req.body?.redirect_uris);
    if (!redirectUris.length || redirectUris.length !== new Set((req.body?.redirect_uris || []).map(String)).size) {
      return oauthError(res, 400, "invalid_redirect_uri", "Only registered HTTPS ChatGPT callback URLs are accepted.");
    }
    if (req.body?.token_endpoint_auth_method && req.body.token_endpoint_auth_method !== "none") {
      return oauthError(res, 400, "invalid_client_metadata", "This server accepts public PKCE clients only.");
    }
    const row = {
      client_id: `quilo_mcp_${randomToken(18)}`,
      client_name: String(req.body?.client_name || "ChatGPT").trim().slice(0, 120) || "ChatGPT",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
    };
    const { error } = await db.from(CLIENTS).insert(row);
    if (error) return oauthError(res, 503, "temporarily_unavailable", "OAuth client registration failed.");
    res.status(201).json({ ...row, client_id_issued_at: Math.floor(Date.now() / 1000) });
  });

  router.get("/oauth/authorize", async (req, res) => {
    const db = client();
    if (!db) return res.status(503).send("OAuth 저장소를 사용할 수 없습니다.");
    const query = req.query || {};
    if (query.response_type !== "code" || !query.client_id || !query.redirect_uri || !query.code_challenge || query.code_challenge_method !== "S256") {
      return res.status(400).send("올바르지 않은 OAuth 요청입니다.");
    }
    const expectedResource = resource(req);
    if (String(query.resource || "") !== expectedResource) return res.status(400).send("OAuth resource가 일치하지 않습니다.");
    const { data: registered } = await db.from(CLIENTS).select("client_id, client_name, redirect_uris").eq("client_id", String(query.client_id)).maybeSingle();
    if (!registered || !registered.redirect_uris?.includes(String(query.redirect_uri))) return res.status(400).send("등록되지 않은 OAuth client 또는 redirect URI입니다.");
    const requested = String(query.scope || "").split(/\s+/).filter(Boolean);
    const scopes = normalizeScopes(requested.length ? requested : DEFAULT_SCOPES);
    if (!scopes.length || requested.some((scope) => !ALLOWED_SCOPES.has(scope))) return res.status(400).send("지원하지 않는 OAuth scope입니다.");
    if (!getSessionUser(req)) {
      req.session.oauthReturn = req.originalUrl;
      return res.redirect("/?oauth=continue");
    }
    const nonce = randomToken(24);
    req.session.mcpOAuthConsent = {
      nonce, clientId: registered.client_id, redirectUri: String(query.redirect_uri), state: String(query.state || ""),
      codeChallenge: String(query.code_challenge), scopes, resource: expectedResource, createdAt: Date.now(),
    };
    res.type("html").send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quilo 연결 승인</title><style>body{font-family:system-ui;background:#f6f7fb;color:#172033;margin:0}.card{max-width:620px;margin:8vh auto;background:#fff;padding:32px;border-radius:18px;box-shadow:0 16px 50px #2030501c}h1{margin-top:0}li{margin:8px 0}.actions{display:flex;gap:12px;margin-top:28px}button,a{padding:11px 18px;border-radius:10px;border:0;text-decoration:none;font-weight:700}.allow{background:#2563eb;color:#fff}.cancel{background:#edf1f7;color:#334}</style></head><body><main class="card"><h1>ChatGPT에 Quilo 연결</h1><p><b>${html(registered.client_name)}</b>에서 회원님의 Quilo 계정 기능을 사용하려고 합니다.</p><p>허용 권한:</p><ul>${scopes.map((s) => `<li>${html(s)}</li>`).join("")}</ul><p>쓰기 기능은 ChatGPT에서 실행 전 확인 대상이며, 언제든 개발자 페이지에서 토큰을 폐기할 수 있습니다.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="nonce" value="${html(nonce)}"><div class="actions"><button class="allow" name="decision" value="allow">연결 허용</button><button name="decision" value="deny">거부</button></div></form></main></body></html>`);
  });

  router.post("/oauth/authorize", express.urlencoded({ extended: false }), async (req, res) => {
    const pending = req.session?.mcpOAuthConsent;
    if (req.session) delete req.session.mcpOAuthConsent;
    if (!pending || pending.nonce !== req.body?.nonce || Date.now() - pending.createdAt > 10 * 60 * 1000 || !getSessionUser(req)) return res.status(400).send("OAuth 승인 요청이 만료되었습니다.");
    const redirect = new URL(pending.redirectUri);
    if (req.body?.decision !== "allow") {
      redirect.searchParams.set("error", "access_denied");
      if (pending.state) redirect.searchParams.set("state", pending.state);
      return res.redirect(redirect.toString());
    }
    const code = randomToken(32);
    const { error } = await client().from(CODES).insert({
      code_hash: sha256(code), user_id: getSessionUser(req).id, client_id: pending.clientId,
      redirect_uri: pending.redirectUri, code_challenge: pending.codeChallenge, scopes: pending.scopes,
      resource: pending.resource, expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    if (error) return res.status(503).send("OAuth 인증 코드를 발급하지 못했습니다.");
    redirect.searchParams.set("code", code);
    if (pending.state) redirect.searchParams.set("state", pending.state);
    res.redirect(redirect.toString());
  });

  router.post("/oauth/token", express.urlencoded({ extended: false }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const db = client();
    if (!db) return oauthError(res, 503, "temporarily_unavailable", "OAuth storage is unavailable.");
    const grant = String(req.body?.grant_type || "");
    try {
      if (grant === "authorization_code") {
        const code = String(req.body?.code || "");
        const { data: row } = await db.from(CODES).select("*").eq("code_hash", sha256(code)).is("used_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
        if (!row || row.client_id !== req.body?.client_id || row.redirect_uri !== req.body?.redirect_uri || row.resource !== req.body?.resource || pkceChallenge(req.body?.code_verifier) !== row.code_challenge) {
          return oauthError(res, 400, "invalid_grant", "Authorization code or PKCE verifier is invalid.");
        }
        const { data: consumed } = await db.from(CODES).update({ used_at: new Date().toISOString() }).eq("code_hash", row.code_hash).is("used_at", null).select("code_hash").maybeSingle();
        if (!consumed) return oauthError(res, 400, "invalid_grant", "Authorization code was already used.");
        return issueTokens(db, res, row);
      }
      if (grant === "refresh_token") {
        const value = String(req.body?.refresh_token || "");
        const { data: row } = await db.from(REFRESH).select("*").eq("token_hash", sha256(value)).is("revoked_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
        if (!row || row.client_id !== req.body?.client_id || row.resource !== req.body?.resource) return oauthError(res, 400, "invalid_grant", "Refresh token is invalid.");
        return issueAccessToken(db, res, row, value);
      }
      return oauthError(res, 400, "unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
    } catch (error) {
      console.error("[mcp-oauth] token:", error.message);
      return oauthError(res, 503, "temporarily_unavailable", "Token issuance failed.");
    }
  });
  return router;
}

async function issueTokens(db, res, row) {
  const refreshToken = `quilo_mcp_refresh_${randomToken(40)}`;
  const { error } = await db.from(REFRESH).insert({
    token_hash: sha256(refreshToken), user_id: row.user_id, client_id: row.client_id, scopes: row.scopes,
    resource: row.resource, expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
  });
  if (error) throw error;
  return issueAccessToken(db, res, row, refreshToken);
}
async function issueAccessToken(db, res, row, refreshToken) {
  const token = rawAccessToken();
  const expiresIn = 3600;
  const { error } = await db.from(ACCESS).insert({
    user_id: row.user_id, name: "ChatGPT MCP", token_hash: hashAccessToken(token.raw), token_prefix: token.prefix,
    token_mode: "live", audience: row.resource, scopes: normalizeScopes(row.scopes), expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  });
  if (error) throw error;
  res.json({ access_token: token.raw, token_type: "Bearer", expires_in: expiresIn, refresh_token: refreshToken, scope: normalizeScopes(row.scopes).join(" "), resource: row.resource });
}

module.exports = { createMcpOAuthRouter, pkceChallenge, safeRedirectUris };
