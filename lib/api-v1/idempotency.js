"use strict";

const KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const MISSING_TABLE = /api_idempotency_keys|schema cache|relation .* does not exist|column .*state/i;

async function claimIdempotency({ req, res, client, sendApiError }) {
  if (!req.apiRoute?.idempotent) return false;
  const key = String(req.get("idempotency-key") || "").trim();
  if (!KEY_RE.test(key)) {
    sendApiError(req, res, 400, "IDEMPOTENCY_KEY_REQUIRED", "8~200자의 유효한 Idempotency-Key가 필요합니다.");
    return true;
  }
  const operation = req.apiRoute.operationId;
  const row = {
    user_id: req.apiUser.id,
    token_id: req.apiAuth?.id || null,
    operation,
    idempotency_key: key,
    state: "pending",
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  try {
    const { data, error } = await client.from("api_idempotency_keys").insert(row).select("id").single();
    if (!error && data?.id) {
      attachResponsePersistence({ req, res, client, id: data.id });
      return false;
    }
    if (!error || String(error.code) !== "23505") throw error || new Error("idempotency claim failed");
    const { data: existing, error: lookupError } = await client
      .from("api_idempotency_keys")
      .select("id, state, response_status, response_body, expires_at")
      .eq("user_id", req.apiUser.id)
      .eq("operation", operation)
      .eq("idempotency_key", key)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!existing || new Date(existing.expires_at).getTime() <= Date.now()) {
      sendApiError(req, res, 409, "IDEMPOTENCY_KEY_EXPIRED", "만료된 키입니다. 새 Idempotency-Key로 다시 요청하세요.");
      return true;
    }
    if (existing.state === "completed" && existing.response_status && existing.response_body != null) {
      res.setHeader("Idempotent-Replayed", "true");
      res.status(existing.response_status).json(existing.response_body);
      return true;
    }
    sendApiError(req, res, 409, "IDEMPOTENCY_REQUEST_IN_PROGRESS", "같은 Idempotency-Key 요청이 처리 중입니다.");
    return true;
  } catch (error) {
    const message = String(error?.message || error || "");
    if (MISSING_TABLE.test(message)) {
      sendApiError(req, res, 503, "IDEMPOTENCY_STORE_MISSING", "중복 실행 방지 저장소가 아직 설치되지 않았습니다.");
      return true;
    }
    console.error("[idempotency] claim:", message);
    sendApiError(req, res, 503, "IDEMPOTENCY_UNAVAILABLE", "중복 실행 방지 상태를 확인하지 못했습니다.");
    return true;
  }
}

function attachResponsePersistence({ res, client, id }) {
  const originalJson = res.json.bind(res);
  let persisted = false;
  res.json = (body) => {
    if (!persisted && res.statusCode < 500) {
      persisted = true;
      const serialized = JSON.stringify(body ?? null);
      if (Buffer.byteLength(serialized, "utf8") <= 64 * 1024) {
        void client.from("api_idempotency_keys").update({
          state: "completed",
          response_status: res.statusCode,
          response_body: body ?? null,
          completed_at: new Date().toISOString(),
        }).eq("id", id).then(() => {}, (error) => console.warn("[idempotency] persist:", error?.message || error));
      }
    }
    return originalJson(body);
  };
  res.once("finish", () => {
    if (res.statusCode >= 500) {
      void client.from("api_idempotency_keys").delete().eq("id", id).then(() => {}, () => {});
    }
  });
}

module.exports = { claimIdempotency };
