"use strict";

const MISSING_TABLE = /api_request_logs|schema cache|relation .* does not exist/i;
let loggingUnavailable = false;

function attachApiRequestLog({ req, res, client }) {
  if (loggingUnavailable || !client || !req.apiUser?.id || !req.apiRoute) return;
  const startedAt = process.hrtime.bigint();
  let errorCode = null;
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === "object" && typeof body.code === "string") errorCode = body.code;
    return originalJson(body);
  };
  res.once("finish", () => {
    const durationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6));
    const table = client.from("api_request_logs");
    if (!table || typeof table.insert !== "function") return;
    void table.insert({
        user_id: req.apiUser.id,
        token_id: req.apiAuth?.id || null,
        request_id: req.apiRequestId,
        method: req.method,
        path: req.apiRoute.path,
        scope: req.apiRoute.scope,
        status: res.statusCode,
        duration_ms: durationMs,
        error_code: errorCode,
      })
      .then(({ error }) => {
        if (error && MISSING_TABLE.test(String(error.message || error))) loggingUnavailable = true;
      }, (error) => {
        if (MISSING_TABLE.test(String(error?.message || error))) loggingUnavailable = true;
      });
  });
}

function resetForTests() {
  loggingUnavailable = false;
}

module.exports = { attachApiRequestLog, resetForTests };
