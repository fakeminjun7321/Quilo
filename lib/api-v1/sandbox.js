"use strict";

const crypto = require("node:crypto");

const PASSTHROUGH_SCOPES = new Set([
  "account:read", "jobs:read", "files:read", "translations:read", "documents:read",
  "tools:read", "studios:read", "knowledge:read", "community:read",
]);

function handleSandboxRequest(req, res) {
  if (req.apiAuth?.mode !== "test" || PASSTHROUGH_SCOPES.has(req.apiRoute?.scope)) return false;
  const operationId = req.apiRoute?.operationId || "unknown";
  const jobOperation = new Set(["createReport", "createPdfTranslation"]).has(operationId);
  res.setHeader("X-Quilo-Mode", "test");
  if (jobOperation) {
    res.status(202).json({
      jobId: `sbx_${crypto.randomBytes(12).toString("hex")}`,
      status: "simulated",
      sandbox: true,
      operationId,
      chargedCredits: 0,
    });
  } else {
    res.json({ ok: true, sandbox: true, operationId, chargedCredits: 0 });
  }
  return true;
}

module.exports = { handleSandboxRequest, PASSTHROUGH_SCOPES };
