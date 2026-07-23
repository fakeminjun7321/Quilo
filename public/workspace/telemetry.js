const CONSENT_VERSION = "2026-07-15";
const EVENT_NAMES = new Set([
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

const state = {
  enabled: false,
  queue: [],
  timer: null,
  installed: false,
  viewed: false,
};

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.random() * 16 | 0;
    return (char === "x" ? value : (value & 3) | 8).toString(16);
  });
}

function sessionId() {
  try {
    const key = "quilo.analytics.session";
    const saved = sessionStorage.getItem(key);
    if (saved) return saved;
    const next = uuid();
    sessionStorage.setItem(key, next);
    return next;
  } catch (_) {
    return uuid();
  }
}

const currentSessionId = sessionId();

function extension(filename) {
  const match = String(filename || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return match ? match[1] : "unknown";
}

function sizeBucket(size) {
  const bytes = Math.max(0, Number(size) || 0);
  if (bytes < 100 * 1024) return "lt_100kb";
  if (bytes < 1024 * 1024) return "100kb_1mb";
  if (bytes < 5 * 1024 * 1024) return "1mb_5mb";
  if (bytes < 20 * 1024 * 1024) return "5mb_20mb";
  return "gte_20mb";
}

export function summarizeGenerationForm(formData) {
  const files = [];
  for (const value of formData?.values?.() || []) {
    if (value instanceof File && value.size > 0) files.push(value);
  }
  const fileSizeBuckets = {};
  files.forEach((file) => {
    const bucket = sizeBucket(file.size);
    fileSizeBuckets[bucket] = (fileSizeBuckets[bucket] || 0) + 1;
  });
  return {
    reportType: String(formData?.get?.("type") || "unknown"),
    model: String(formData?.get?.("model") || "unknown"),
    format: String(formData?.get?.("format") || "docx"),
    background: formData?.get?.("backgroundMode") === "true",
    saveToGoogleDrive: formData?.get?.("saveToGoogleDrive") === "true",
    fileCount: files.length,
    fileExtensions: [...new Set(files.map((file) => extension(file.name)))].sort(),
    fileSizeBuckets,
  };
}

async function flush({ keepalive = false } = {}) {
  if (!state.enabled || !state.queue.length) return;
  const events = state.queue.splice(0, 20);
  try {
    const response = await fetch("/api/telemetry/events", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionId, events }),
      keepalive,
    });
    if (response.status === 401 || response.status === 403) {
      state.enabled = false;
      state.queue.length = 0;
    }
  } catch (_) {
    // 분석 실패는 사용자 작업을 방해하지 않는다. 페이지가 살아 있으면 1회 재시도한다.
    if (!keepalive && state.enabled) state.queue.unshift(...events);
  }
}

function scheduleFlush() {
  if (state.timer || !state.enabled) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void flush();
  }, 4000);
}

export function trackEvent(name, properties = {}) {
  if (!state.enabled || !EVENT_NAMES.has(name)) return;
  state.queue.push({
    eventId: uuid(),
    sessionId: currentSessionId,
    name,
    occurredAt: new Date().toISOString(),
    properties,
  });
  if (state.queue.length >= 10) void flush();
  else scheduleFlush();
}

export function setTelemetryConsent(granted, version = "", currentVersion = CONSENT_VERSION) {
  state.enabled = !!granted && version === currentVersion;
  if (!state.enabled) {
    state.queue.length = 0;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    return;
  }
  if (!state.viewed) {
    state.viewed = true;
    trackEvent("workspace_viewed", { source: "workspace" });
  }
}

export function installTelemetryListeners() {
  if (state.installed) return;
  state.installed = true;
  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target?.matches?.('input[name="reportType"]') && target.checked) {
      trackEvent("feature_selected", { reportType: target.value, source: "report_picker" });
    }
  });
  window.addEventListener("pagehide", () => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    void flush({ keepalive: true });
  });
}

export { CONSENT_VERSION };
