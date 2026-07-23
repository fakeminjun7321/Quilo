"use strict";

const crypto = require("crypto");

const CONSENT_VERSION =
  process.env.PRODUCT_ANALYTICS_CONSENT_VERSION || "2026-07-15";

const PRODUCT_EVENT_NAMES = new Set([
  "workspace_viewed",
  "feature_selected",
  "form_started",
  "generation_submitted",
  "generation_accepted",
  "generation_rejected",
  "job_stream_opened",
  "generation_completed",
  "generation_failed",
  "preview_clicked",
  "download_clicked",
  "retry_clicked",
  "abort_clicked",
  "quality_feedback_submitted",
]);

const QUALITY_DISPOSITIONS = new Set([
  "as_is",
  "minor_edits",
  "major_edits",
  "not_used",
]);

const QUALITY_TAGS = new Set([
  "data_error",
  "missing_content",
  "format_broken",
  "equation_error",
  "chart_error",
  "too_verbose",
  "too_short",
  "style_mismatch",
  "other",
]);

const UPLOAD_EXTENSIONS = new Set([
  "cap",
  "csv",
  "docx",
  "gif",
  "hwp",
  "hwpx",
  "jpeg",
  "jpg",
  "md",
  "pdf",
  "png",
  "pptx",
  "txt",
  "webp",
  "xls",
  "xlsx",
  "zip",
]);

const PROPERTY_KEYS = new Set([
  "reportType",
  "model",
  "format",
  "style",
  "background",
  "saveToGoogleDrive",
  "fileCount",
  "fileExtensions",
  "fileSizeBuckets",
  "httpStatus",
  "failureCode",
  "fileIndex",
  "score",
  "disposition",
  "tags",
  "source",
]);

const SAFE_CODE_RE = /^[a-zA-Z0-9._-]{1,80}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeCode(value, fallback = "") {
  const out = String(value || "").trim();
  return SAFE_CODE_RE.test(out) ? out : fallback;
}

function safeReportType(value) {
  return safeCode(value, "unknown").toLowerCase();
}

function safeModel(value) {
  return safeCode(value, "unknown");
}

function safeFormat(value) {
  const format = String(value || "").trim().toLowerCase();
  return ["docx", "hwpx", "pdf", "zip"].includes(format)
    ? format
    : "unknown";
}

function providerForModel(model) {
  const value = String(model || "").toLowerCase();
  if (value.startsWith("gpt")) return "openai";
  if (value.startsWith("gemini")) return "google";
  if (
    value.startsWith("claude") ||
    value.startsWith("codex-sonnet") ||
    value.startsWith("codex-opus")
  ) return "anthropic";
  return "unknown";
}

function sizeBucket(size) {
  const bytes = Math.max(0, Number(size) || 0);
  if (bytes < 100 * 1024) return "lt_100kb";
  if (bytes < 1024 * 1024) return "100kb_1mb";
  if (bytes < 5 * 1024 * 1024) return "1mb_5mb";
  if (bytes < 20 * 1024 * 1024) return "5mb_20mb";
  return "gte_20mb";
}

function extensionOf(filename) {
  const match = String(filename || "")
    .toLowerCase()
    .match(/\.([a-z0-9]{1,8})$/);
  const ext = match ? match[1] : "unknown";
  return UPLOAD_EXTENSIONS.has(ext) ? ext : "unknown";
}

function summarizeUploads(files) {
  const list = Array.isArray(files) ? files : [];
  const extensions = new Set();
  const buckets = {
    lt_100kb: 0,
    "100kb_1mb": 0,
    "1mb_5mb": 0,
    "5mb_20mb": 0,
    gte_20mb: 0,
  };
  let totalBytes = 0;
  for (const file of list.slice(0, 100)) {
    extensions.add(extensionOf(file && file.originalname));
    const bytes = Math.max(0, Number(file && file.size) || 0);
    totalBytes += bytes;
    buckets[sizeBucket(bytes)] += 1;
  }
  return {
    fileCount: list.length,
    fileExtensions: [...extensions].sort(),
    fileSizeBuckets: buckets,
    totalBytesBucket: sizeBucket(totalBytes),
  };
}

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((tag) => String(tag || "").trim()))]
    .filter((tag) => QUALITY_TAGS.has(tag))
    .slice(0, 8);
}

function sanitizeFileSizeBuckets(value) {
  const allowed = [
    "lt_100kb",
    "100kb_1mb",
    "1mb_5mb",
    "5mb_20mb",
    "gte_20mb",
  ];
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const key of allowed) {
    const count = Math.trunc(Number(value[key]) || 0);
    if (count > 0) out[key] = Math.min(count, 100);
  }
  return out;
}

function sanitizeProductProperties(properties) {
  const source =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? properties
      : {};
  const out = {};
  for (const key of Object.keys(source)) {
    if (!PROPERTY_KEYS.has(key)) continue;
    const value = source[key];
    switch (key) {
      case "reportType":
        out.reportType = safeReportType(value);
        break;
      case "model":
        out.model = safeModel(value);
        break;
      case "format":
        out.format = safeFormat(value);
        break;
      case "style":
      case "failureCode":
      case "source": {
        const code = safeCode(value);
        if (code) out[key] = code;
        break;
      }
      case "background":
      case "saveToGoogleDrive":
        out[key] = !!value;
        break;
      case "fileCount":
        out.fileCount = Math.min(100, Math.max(0, Math.trunc(Number(value) || 0)));
        break;
      case "fileExtensions":
        if (Array.isArray(value)) {
          out.fileExtensions = [...new Set(value.map((item) => {
            const raw = String(item || "").toLowerCase();
            return UPLOAD_EXTENSIONS.has(raw) ? raw : extensionOf(raw);
          }))].sort();
        }
        break;
      case "fileSizeBuckets":
        out.fileSizeBuckets = sanitizeFileSizeBuckets(value);
        break;
      case "httpStatus":
        out.httpStatus = Math.min(599, Math.max(100, Math.trunc(Number(value) || 0)));
        break;
      case "fileIndex":
        out.fileIndex = Math.min(99, Math.max(0, Math.trunc(Number(value) || 0)));
        break;
      case "score":
        out.score = Math.min(5, Math.max(1, Math.trunc(Number(value) || 0)));
        break;
      case "disposition":
        if (QUALITY_DISPOSITIONS.has(String(value))) out.disposition = String(value);
        break;
      case "tags":
        out.tags = sanitizeTags(value);
        break;
      default:
        break;
    }
  }
  return out;
}

function normalizeProductEvents(events, { sessionId = "" } = {}) {
  const defaultSessionId = UUID_RE.test(String(sessionId))
    ? String(sessionId)
    : crypto.randomUUID();
  const now = Date.now();
  return (Array.isArray(events) ? events : [])
    .slice(0, 20)
    .map((event) => {
      if (!event || !PRODUCT_EVENT_NAMES.has(String(event.name))) return null;
      const occurred = new Date(event.occurredAt || now).getTime();
      const occurredAt =
        Number.isFinite(occurred) && Math.abs(now - occurred) <= 24 * 60 * 60 * 1000
          ? new Date(occurred).toISOString()
          : new Date(now).toISOString();
      return {
        event_id: UUID_RE.test(String(event.eventId || ""))
          ? String(event.eventId)
          : crypto.randomUUID(),
        session_id: UUID_RE.test(String(event.sessionId || ""))
          ? String(event.sessionId)
          : defaultSessionId,
        event_name: String(event.name),
        page_path: "/",
        properties: sanitizeProductProperties(event.properties),
        occurred_at: occurredAt,
      };
    })
    .filter(Boolean);
}

function validateQualityFeedback(input) {
  const score = Math.trunc(Number(input && input.score));
  const disposition = String((input && input.disposition) || "");
  if (score < 1 || score > 5) {
    const error = new Error("평점은 1~5 사이여야 합니다.");
    error.code = "INVALID_SCORE";
    throw error;
  }
  if (!QUALITY_DISPOSITIONS.has(disposition)) {
    const error = new Error("사용 결과를 선택해 주세요.");
    error.code = "INVALID_DISPOSITION";
    throw error;
  }
  return { score, disposition, tags: sanitizeTags(input && input.tags) };
}

function artifactRuleCodes(artifactCheck) {
  if (!artifactCheck || !Array.isArray(artifactCheck.problems)) return [];
  return [...new Set(
    artifactCheck.problems
      .map((problem) => safeCode(problem && problem.rule))
      .filter(Boolean),
  )].slice(0, 20);
}

function percentile(values, p) {
  const sorted = (Array.isArray(values) ? values : [])
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[index]);
}

function countBy(rows, getter) {
  const out = {};
  for (const row of rows || []) {
    const key = safeCode(getter(row), "unknown");
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function aggregateAnalytics({ runs = [], events = [], feedback = [], days = 30 } = {}) {
  const accepted = runs.filter((row) => row.accepted !== false);
  const completed = accepted.filter((row) => row.status === "done");
  const failed = accepted.filter((row) => ["error", "aborted"].includes(row.status));
  const rejected = runs.filter((row) => row.accepted === false);
  const durations = accepted.map((row) => row.total_ms);
  const stages = ["queue_ms", "generation_ms", "build_ms", "validation_ms", "storage_ms"];
  const stageTimings = {};
  for (const stage of stages) {
    const values = accepted.map((row) => row[stage]);
    stageTimings[stage] = { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
  }
  const scores = feedback.map((row) => Number(row.score)).filter(Number.isFinite);
  const tags = {};
  for (const row of feedback) {
    for (const tag of sanitizeTags(row.tags)) tags[tag] = (tags[tag] || 0) + 1;
  }
  return {
    days,
    runs: {
      total: runs.length,
      accepted: accepted.length,
      completed: completed.length,
      failed: failed.length,
      rejected: rejected.length,
      successRate: accepted.length ? Number((completed.length / accepted.length).toFixed(4)) : 0,
      downloads: accepted.reduce((sum, row) => sum + (Number(row.download_count) || 0), 0),
      previews: accepted.reduce((sum, row) => sum + (Number(row.preview_count) || 0), 0),
      p50TotalMs: percentile(durations, 0.5),
      p95TotalMs: percentile(durations, 0.95),
      stageTimings,
      byReportType: countBy(accepted, (row) => row.report_type),
      byModel: countBy(accepted, (row) => row.model),
      byErrorPhase: countBy(failed, (row) => row.error_phase),
      byErrorCode: countBy(failed, (row) => row.error_code),
    },
    funnel: countBy(events, (row) => row.event_name),
    quality: {
      count: feedback.length,
      averageScore: scores.length
        ? Number((scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(2))
        : 0,
      dispositions: countBy(feedback, (row) => row.disposition),
      tags,
    },
  };
}

function normalizeAdminPath(pathname) {
  return String(pathname || "/")
    .split("?")[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, "/:id")
    .replace(/\/[0-9a-f]{20,}/gi, "/:id")
    .slice(0, 180);
}

module.exports = {
  CONSENT_VERSION,
  PRODUCT_EVENT_NAMES,
  QUALITY_DISPOSITIONS,
  QUALITY_TAGS,
  aggregateAnalytics,
  artifactRuleCodes,
  normalizeAdminPath,
  normalizeProductEvents,
  providerForModel,
  safeCode,
  safeFormat,
  safeModel,
  safeReportType,
  sanitizeProductProperties,
  sizeBucket,
  summarizeUploads,
  validateQualityFeedback,
};
