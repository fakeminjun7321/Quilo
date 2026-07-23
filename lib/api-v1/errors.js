"use strict";

const crypto = require("crypto");

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,100}$/;

function ensureRequestId(req, res) {
  if (req.apiRequestId) return req.apiRequestId;
  const supplied = String(req.headers?.["x-request-id"] || "").trim();
  const requestId = REQUEST_ID_RE.test(supplied)
    ? supplied
    : `req_${crypto.randomBytes(12).toString("hex")}`;
  req.apiRequestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  return requestId;
}

function sendApiError(req, res, status, code, message, details) {
  const requestId = ensureRequestId(req, res);
  const body = { error: message, code, requestId };
  if (details && typeof details === "object") Object.assign(body, details);
  return res.status(status).json(body);
}

module.exports = { ensureRequestId, sendApiError };
