"use strict";

const express = require("express");
const { sendApiError } = require("./errors");

function normalizeJobStatus(status) {
  const value = String(status || "unknown");
  if (value === "done") return "completed";
  if (value === "error") return "failed";
  if (value === "aborted") return "cancelled";
  return value;
}

function publicRuntimeJob(job) {
  const files = (job.files || []).map((file, index) => ({
    index,
    filename: file.filename || "",
    fileId: file.fileId || null,
    effectiveMode: file.effectiveMode || null,
    downloadUrl: `/api/v1/jobs/${encodeURIComponent(job.id)}/download?file=${index}`,
  }));
  const completed = job.status === "done";
  return {
    id: job.id,
    type: job.reportType || "",
    model: job.model || "",
    status: normalizeJobStatus(job.status),
    rawStatus: job.status || "unknown",
    filename: job.filename || null,
    fileId: job.fileId || null,
    error: job.error || null,
    progress: Array.isArray(job.progress) ? job.progress.slice(-50) : [],
    background: !!job.background,
    createdAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
    updatedAt: null,
    downloadAvailable: completed && (!!job.result || files.length > 0),
    downloadUrl: completed && job.result ? `/api/v1/jobs/${encodeURIComponent(job.id)}/download` : null,
    eventsUrl: `/api/v1/jobs/${encodeURIComponent(job.id)}/events`,
    files,
  };
}

function publicStoredJob(job) {
  const completed = job.status === "done" || job.status === "completed";
  return {
    id: job.id,
    type: job.reportType || "",
    model: job.model || "",
    status: normalizeJobStatus(job.status),
    rawStatus: job.status || "unknown",
    filename: job.filename || null,
    fileId: job.fileId || null,
    error: job.error || null,
    progress: Array.isArray(job.progress) ? job.progress : [],
    background: job.background !== false,
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || null,
    downloadAvailable: completed && !!job.fileId,
    downloadUrl: completed && job.fileId
      ? `/api/v1/files/${encodeURIComponent(job.fileId)}/download`
      : null,
    eventsUrl: null,
    files: [],
  };
}

function createV1Router({
  supa,
  getRuntimeJob = () => null,
  excludeReportTypes = [],
}) {
  const router = express.Router();
  const excluded = new Set(
    [...excludeReportTypes]
      .map((type) => String(type || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const isExcluded = (job) =>
    excluded.has(String(job?.reportType || job?.report_type || "").trim().toLowerCase());

  router.get("/account", async (req, res) => {
    const user = req.apiUser;
    if (!user) return sendApiError(req, res, 401, "AUTH_REQUIRED", "인증이 필요합니다.");
    let credits = 0;
    let pro = false;
    let max = false;
    try {
      [credits, pro, max] = await Promise.all([
        supa.getCredits(user.id),
        supa.getUserBetaFeatures(user.id).then((items) =>
          (Array.isArray(items) ? items : []).some(
            (item) => !excluded.has(String(item || "").trim().toLowerCase()),
          )),
        supa.getActiveBackgroundSub(user.id).then(Boolean),
      ]);
    } catch (_) {
      // Account identity remains useful if optional entitlement lookups fail.
    }
    res.json({
      user: { id: user.id, name: user.name, username: user.username, studentId: user.studentId },
      plan: max ? "max" : pro ? "pro" : "free",
      credits,
      unlimited: !!user.unlimited,
      token: req.apiAuth,
      requestId: req.apiRequestId,
    });
  });

  router.get("/api-requests", async (req, res) => {
    const user = req.apiUser;
    if (!user?.id) return sendApiError(req, res, 401, "AUTH_REQUIRED", "인증이 필요합니다.");
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const requests = typeof supa.listApiRequestLogs === "function"
      ? await supa.listApiRequestLogs(user.id, { limit })
      : [];
    res.json({ requests, requestId: req.apiRequestId });
  });

  router.get("/jobs/:id", async (req, res) => {
    const user = req.apiUser;
    if (!user?.id) return sendApiError(req, res, 401, "AUTH_REQUIRED", "인증이 필요합니다.");
    const jobId = String(req.params.id || "");
    const runtimeJob = getRuntimeJob(jobId);
    if (runtimeJob) {
      if (runtimeJob.userInfo?.id !== user.id || isExcluded(runtimeJob)) {
        return sendApiError(req, res, 404, "JOB_NOT_FOUND", "작업을 찾을 수 없습니다.");
      }
      return res.json({ job: publicRuntimeJob(runtimeJob), requestId: req.apiRequestId });
    }

    try {
      const storedJob = typeof supa.getReportJob === "function"
        ? await supa.getReportJob(user.id, jobId)
        : null;
      if (!storedJob) {
        return sendApiError(req, res, 404, "JOB_NOT_FOUND", "작업을 찾을 수 없습니다.");
      }
      if (isExcluded(storedJob)) {
        return sendApiError(req, res, 404, "JOB_NOT_FOUND", "작업을 찾을 수 없습니다.");
      }
      return res.json({ job: publicStoredJob(storedJob), requestId: req.apiRequestId });
    } catch (error) {
      console.error("[api-v1] get job:", error.message || error);
      return sendApiError(req, res, 500, "JOB_LOOKUP_FAILED", "작업 상태를 불러오지 못했습니다.");
    }
  });

  return router;
}

module.exports = {
  createV1Router,
  normalizeJobStatus,
  publicRuntimeJob,
  publicStoredJob,
};
