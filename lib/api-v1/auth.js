"use strict";

const { ensureRequestId, sendApiError } = require("./errors");
const { matchApiRoute } = require("./registry");
const { hasScope, normalizeScopes } = require("./scopes");
const { attachApiRequestLog } = require("./telemetry");
const { claimIdempotency } = require("./idempotency");
const { handleSandboxRequest } = require("./sandbox");

const TOKEN_RE = /^quilo_(?:(?:live|test)_)?[a-f0-9]{8}_[A-Za-z0-9_-]{40,}$/;

function safeUser(user) {
  return {
    id: user.id,
    name: user.name || "",
    username: user.username || user.name || "",
    studentId: user.student_id || "",
    isAdmin: false,
    unlimited: !!user.unlimited,
    restrictedModel: user.restricted_model || null,
    emailVerified: !!user.email_verified,
    approved: !!user.approved,
  };
}

function createBearerAuthMiddleware({
  supa,
  hashToken,
  tokenTable,
  tokenTableMissingPattern,
}) {
  return async function bearerAuthMiddleware(req, res, next) {
    const pathname = String(req.path || "");
    if (!pathname.startsWith("/api/v1/")) return next();

    ensureRequestId(req, res);
    const matched = matchApiRoute(req.method, pathname);
    if (!matched) {
      return sendApiError(req, res, 404, "API_ROUTE_NOT_FOUND", "지원하지 않는 Quilo API v1 경로입니다.");
    }

    const auth = String(req.headers.authorization || "");
    const rawToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!TOKEN_RE.test(rawToken)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return sendApiError(req, res, 401, "INVALID_ACCESS_TOKEN", "유효한 Quilo Bearer 토큰이 필요합니다.");
    }

    const client = supa.getClient();
    if (!client) {
      return sendApiError(req, res, 503, "API_AUTH_UNAVAILABLE", "외부 API 인증을 사용할 수 없습니다.");
    }

    try {
      const now = new Date().toISOString();
      let { data: tokenRow, error } = await client
        .from(tokenTable)
        .select("id, user_id, name, token_prefix, token_mode, scopes, expires_at, revoked_at, last_used_at")
        .eq("token_hash", hashToken(rawToken))
        .is("revoked_at", null)
        .gt("expires_at", now)
        .maybeSingle();
      if (error && /token_mode|column .*does not exist|schema cache/i.test(String(error.message || error))) {
        const fallback = await client
          .from(tokenTable)
          .select("id, user_id, name, token_prefix, scopes, expires_at, revoked_at, last_used_at")
          .eq("token_hash", hashToken(rawToken))
          .is("revoked_at", null)
          .gt("expires_at", now)
          .maybeSingle();
        tokenRow = fallback.data;
        error = fallback.error;
      }
      if (error) throw error;
      if (!tokenRow) {
        res.setHeader("WWW-Authenticate", "Bearer");
        return sendApiError(req, res, 401, "ACCESS_TOKEN_EXPIRED", "토큰이 만료되었거나 폐기되었습니다.");
      }

      const scopes = normalizeScopes(tokenRow.scopes);
      if (!hasScope(scopes, matched.entry.scope)) {
        return sendApiError(
          req,
          res,
          403,
          "INSUFFICIENT_SCOPE",
          `이 토큰에는 ${matched.entry.scope} 권한이 없습니다.`,
          { requiredScope: matched.entry.scope },
        );
      }

      const user = await supa.findUserById(tokenRow.user_id);
      if (!user) {
        return sendApiError(req, res, 401, "TOKEN_USER_NOT_FOUND", "토큰의 사용자 계정을 찾을 수 없습니다.");
      }

      req.apiRoute = matched.entry;
      req.apiUser = safeUser(user);
      req.apiAuth = {
        id: tokenRow.id,
        name: tokenRow.name,
        prefix: tokenRow.token_prefix,
        mode: tokenRow.token_mode || (rawToken.startsWith("quilo_test_") ? "test" : "live"),
        scopes,
      };
      attachApiRequestLog({ req, res, client });
      void client.from(tokenTable).update({ last_used_at: now }).eq("id", tokenRow.id).then(() => {}, () => {});

      if (handleSandboxRequest(req, res)) return;
      if (await claimIdempotency({ req, res, client, sendApiError })) return;

      if (matched.entry.rewrite) {
        const target = matched.entry.rewrite(matched.match);
        const queryIndex = req.url.indexOf("?");
        req.url = target + (queryIndex >= 0 ? req.url.slice(queryIndex) : "");
      }
      return next();
    } catch (error) {
      if (tokenTableMissingPattern.test(String(error.message || error))) {
        return sendApiError(
          req,
          res,
          503,
          "TOKEN_TABLE_MISSING",
          "외부 API 토큰 테이블이 아직 설치되지 않았습니다.",
        );
      }
      console.error("[external-api] auth error:", error.message || error);
      return sendApiError(req, res, 503, "API_AUTH_FAILED", "외부 API 인증을 확인할 수 없습니다.");
    }
  };
}

module.exports = { createBearerAuthMiddleware, safeUser };
