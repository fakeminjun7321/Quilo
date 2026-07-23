"use strict";

const crypto = require("crypto");
const express = require("express");
const { CATEGORIES, listFeatures, getFeature } = require("./quilo-catalog");
const { createBearerAuthMiddleware } = require("./api-v1/auth");
const { createOpenApiRouter } = require("./api-v1/openapi");
const { createV1Router } = require("./api-v1/router");
const {
  ALLOWED_SCOPES,
  normalizeScopes,
  publicScopeDefinitions,
} = require("./api-v1/scopes");

const TOKEN_PREFIX = "quilo_";
const TOKEN_TABLE = "user_access_tokens";
const MCP_REFRESH_TABLE = "mcp_oauth_refresh_tokens";
const TOKEN_TABLE_MISSING = /user_access_tokens|schema cache|relation .* does not exist/i;
function hashAccessToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

function createRawAccessToken(mode = "live") {
  const normalizedMode = mode === "test" ? "test" : "live";
  const prefix = crypto.randomBytes(4).toString("hex");
  const secret = crypto.randomBytes(32).toString("base64url");
  return { raw: `${TOKEN_PREFIX}${normalizedMode}_${prefix}_${secret}`, prefix, mode: normalizedMode };
}

function createCatalogRouter({ excludeFeatureIds = [] } = {}) {
  const router = express.Router();
  const excluded = new Set(
    [...excludeFeatureIds].map((id) => String(id || "").trim()).filter(Boolean),
  );
  router.use((_req, res, next) => {
    // 공개 기능 카탈로그는 배포 사이에만 바뀌고 사용자별 정보가 없다. 짧은
    // 브라우저/CDN 캐시로 모든 공개 페이지가 같은 18KB JSON을 매번 다시
    // 내려받는 일을 줄이되, 배포 직후에는 백그라운드 재검증으로 빠르게 갱신한다.
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    next();
  });
  router.get("/", (req, res) => {
    const filters = {
      category: String(req.query.category || "").trim() || undefined,
      status: String(req.query.status || "").trim() || undefined,
      audience: String(req.query.audience || "").trim() || undefined,
      execution: String(req.query.execution || "").trim() || undefined,
      query: String(req.query.q || "").trim() || undefined,
    };
    const features = listFeatures(filters).filter((feature) => !excluded.has(feature.id));
    res.json({
      product: "Quilo",
      tagline: "학습과 연구의 전 과정을 연결하는 AI Workspace",
      principles: ["업로드한 실제 자료를 우선", "제출 가능한 파일로 완성", "사용자가 검토하고 제출"],
      categories: CATEGORIES,
      features,
      total: features.length,
    });
  });
  router.get("/:id", (req, res) => {
    const id = String(req.params.id || "");
    if (excluded.has(id)) return res.status(404).json({ error: "기능을 찾을 수 없습니다." });
    const feature = getFeature(id);
    if (!feature) return res.status(404).json({ error: "기능을 찾을 수 없습니다." });
    res.json({ feature, category: CATEGORIES[feature.category] || null });
  });
  return router;
}

function createTokenRouter({ supa, getSessionUser }) {
  const router = express.Router();
  const requireIntegrationSession = (req, res, next) => {
    if (req.apiAuth) {
      return res.status(403).json({ error: "액세스 토큰으로 토큰을 관리할 수 없습니다." });
    }
    if (!getSessionUser(req)) {
      return res.status(401).json({ error: "로그인이 필요합니다." });
    }
    next();
  };

  router.get("/tokens", requireIntegrationSession, async (req, res) => {
    if (req.apiAuth) return res.status(403).json({ error: "액세스 토큰으로 다른 토큰을 관리할 수 없습니다." });
    const user = getSessionUser(req);
    const client = supa.getClient();
    if (!client || !user?.id) return res.status(503).json({ error: "토큰 저장소를 사용할 수 없습니다." });
    try {
      const { data, error } = await client
        .from(TOKEN_TABLE)
        .select("id, name, token_prefix, token_mode, scopes, expires_at, last_used_at, created_at, revoked_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      res.json({
        tokens: (data || []).map(publicTokenRow),
        allowedScopes: [...ALLOWED_SCOPES],
        scopeDefinitions: publicScopeDefinitions(),
      });
    } catch (error) {
      tokenStoreError(res, error);
    }
  });

  router.get("/api-requests", requireIntegrationSession, async (req, res) => {
    const user = getSessionUser(req);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    try {
      const requests = typeof supa.listApiRequestLogs === "function"
        ? await supa.listApiRequestLogs(user.id, { limit })
        : [];
      res.json({ requests });
    } catch (error) {
      res.status(500).json({ error: "API 요청 기록을 불러오지 못했습니다." });
    }
  });

  router.post("/tokens", requireIntegrationSession, async (req, res) => {
    if (req.apiAuth) return res.status(403).json({ error: "액세스 토큰으로 다른 토큰을 만들 수 없습니다." });
    const user = getSessionUser(req);
    const client = supa.getClient();
    if (!client || !user?.id) return res.status(503).json({ error: "토큰 저장소를 사용할 수 없습니다." });
    const name = String(req.body?.name || "Codex").trim().slice(0, 80);
    const scopes = normalizeScopes(req.body?.scopes);
    const days = Math.max(1, Math.min(365, Math.trunc(Number(req.body?.expiresInDays) || 30)));
    const mode = String(req.body?.mode || "live") === "test" ? "test" : "live";
    if (!name) return res.status(400).json({ error: "토큰 이름이 필요합니다." });
    if (!scopes.length) return res.status(400).json({ error: "권한 범위를 하나 이상 선택하세요." });
    try {
      const { count, error: countError } = await client
        .from(TOKEN_TABLE)
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .is("revoked_at", null)
        .gt("expires_at", new Date().toISOString());
      if (countError) throw countError;
      if ((count || 0) >= 10) return res.status(409).json({ error: "활성 토큰은 최대 10개까지 만들 수 있습니다." });
      const token = createRawAccessToken(mode);
      const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
      const { data, error } = await client
        .from(TOKEN_TABLE)
        .insert({
          user_id: user.id,
          name,
          token_hash: hashAccessToken(token.raw),
          token_prefix: token.prefix,
          token_mode: token.mode,
          scopes,
          expires_at: expiresAt,
        })
        .select("id, name, token_prefix, token_mode, scopes, expires_at, created_at")
        .single();
      if (error) throw error;
      res.status(201).json({ token: token.raw, record: publicTokenRow(data), warning: "이 토큰은 지금 한 번만 표시됩니다." });
    } catch (error) {
      tokenStoreError(res, error);
    }
  });

  router.delete("/tokens/:id", requireIntegrationSession, async (req, res) => {
    if (req.apiAuth) return res.status(403).json({ error: "액세스 토큰으로 다른 토큰을 폐기할 수 없습니다." });
    const user = getSessionUser(req);
    const client = supa.getClient();
    if (!client || !user?.id) return res.status(503).json({ error: "토큰 저장소를 사용할 수 없습니다." });
    try {
      const revokedAt = new Date().toISOString();
      const { data, error } = await client
        .from(TOKEN_TABLE)
        .update({ revoked_at: revokedAt })
        .eq("id", req.params.id)
        .eq("user_id", user.id)
        .is("revoked_at", null)
        .select("id, audience")
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "토큰을 찾을 수 없습니다." });
      // MCP access token만 폐기하면 남은 refresh token이 새 access token을 발급해
      // 폐기를 되돌릴 수 있다. 같은 사용자·resource의 refresh family도 함께 닫는다.
      if (data.audience) {
        const { error: refreshError } = await client
          .from(MCP_REFRESH_TABLE)
          .update({ revoked_at: revokedAt })
          .eq("user_id", user.id)
          .eq("resource", data.audience)
          .is("revoked_at", null);
        if (refreshError) throw refreshError;

        // One refresh token can mint several one-hour access-token siblings.
        // Closing only the selected row would leave those siblings usable even
        // though the UI reports a successful MCP revocation. Revoke the complete
        // user/resource access family as the fail-closed legacy-compatible rule.
        const { error: accessFamilyError } = await client
          .from(TOKEN_TABLE)
          .update({ revoked_at: revokedAt })
          .eq("user_id", user.id)
          .eq("audience", data.audience)
          .is("revoked_at", null);
        if (accessFamilyError) throw accessFamilyError;
      }
      res.json({ ok: true });
    } catch (error) {
      tokenStoreError(res, error);
    }
  });

  return router;
}

function createExternalApiMiddleware({ supa }) {
  return createBearerAuthMiddleware({
    supa,
    hashToken: hashAccessToken,
    tokenTable: TOKEN_TABLE,
    tokenTableMissingPattern: TOKEN_TABLE_MISSING,
  });
}

function publicTokenRow(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    mode: row.token_mode || "live",
    scopes: normalizeScopes(row.scopes),
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at || null,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || null,
  };
}

function tokenStoreError(res, error) {
  const message = String(error?.message || error || "");
  if (TOKEN_TABLE_MISSING.test(message)) {
    return res.status(503).json({ error: "외부 API 토큰 테이블이 아직 설치되지 않았습니다.", code: "TOKEN_TABLE_MISSING" });
  }
  console.error("[external-api] token store error:", message);
  return res.status(500).json({ error: "액세스 토큰을 처리하지 못했습니다." });
}

module.exports = {
  ALLOWED_SCOPES,
  createCatalogRouter,
  createTokenRouter,
  createExternalApiMiddleware,
  createOpenApiRouter,
  createV1Router,
  hashAccessToken,
  normalizeScopes,
};
