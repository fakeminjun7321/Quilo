import { createSeedOverview } from "../data/seed.js";

const STORAGE_KEY = "quilo-schedule-demo-state-v1";
const DEMO_FALLBACK_ENABLED = import.meta.env.DEV || import.meta.env.VITE_CLASSBOT_DEMO_FALLBACK === "true";
const API_PREFIX = String(import.meta.env.VITE_CLASSBOT_API_BASE || `${import.meta.env.BASE_URL}api`).replace(/\/$/, "");
const EMBEDDED_IN_QUILO = !import.meta.env.DEV && import.meta.env.BASE_URL.startsWith("/schedule/");
let transport = "remote";

function resolveApiPath(path) {
  if (!path.startsWith("/api")) return path;
  return `${API_PREFIX}${path.slice(4)}`;
}

export function createIdempotencyKey(scope = "request") {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `classbot-${scope}-${id}`;
}

function readLocal() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : createSeedOverview();
  } catch {
    return createSeedOverview();
  }
}

let localState = readLocal();
if (!Array.isArray(localState.files)) localState.files = [];

function persistLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(localState)); } catch { /* private mode */ }
}

function nextId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function request(path, options = {}) {
  const { body, headers, root = false, ...rest } = options;
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const response = await fetch(root ? path : resolveApiPath(path), {
    credentials: "same-origin",
    ...rest,
    headers: body && !isFormData ? { "Content-Type": "application/json", ...headers } : headers,
    body: body && typeof body !== "string" && !isFormData ? JSON.stringify(body) : body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || data.message || "요청을 처리하지 못했습니다.");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function remoteOrLocal(remoteCall, localCall) {
  if (transport === "local") return localCall();
  try {
    return await remoteCall();
  } catch (error) {
    if (!DEMO_FALLBACK_ENABLED || (error.status && error.status < 500 && error.status !== 404)) throw error;
    transport = "local";
    return localCall();
  }
}

function idempotencyHeaders(scope, input, options = {}) {
  const key = options.idempotencyKey || input?.request_key || createIdempotencyKey(scope);
  return { "Idempotency-Key": key };
}

function updateItem(collection, id, patch) {
  const index = localState[collection].findIndex((item) => item.id === id);
  if (index < 0) throw new Error("항목을 찾을 수 없습니다.");
  localState[collection][index] = { ...localState[collection][index], ...patch, updated_at: new Date().toISOString() };
  persistLocal();
  return { item: structuredClone(localState[collection][index]) };
}

function createItem(collection, prefix, input) {
  const item = { id: nextId(prefix), ...input, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  localState[collection].unshift(item);
  persistLocal();
  return { item: structuredClone(item) };
}

export const api = {
  get mode() { return transport; },
  get embedded() { return EMBEDDED_IN_QUILO; },
  get demoFallbackEnabled() { return DEMO_FALLBACK_ENABLED; },
  async session() {
    return remoteOrLocal(() => request("/api/admin/session"), () => ({ authenticated: true, actor: "demo-admin", demo: true }));
  },
  login(password) { return request("/api/admin/login", { method: "POST", body: { password } }); },
  logout() {
    return remoteOrLocal(
      () => EMBEDDED_IN_QUILO
        ? request("/api/logout", { method: "POST", root: true })
        : request("/api/admin/logout", { method: "POST" }),
      () => ({ ok: true }),
    );
  },
  overview() { return remoteOrLocal(() => request("/api/admin/overview"), () => structuredClone(localState)); },
  settings() { return remoteOrLocal(() => request("/api/admin/settings"), () => ({ item: structuredClone(localState.classroom) })); },
  updateSettings(patch) {
    return remoteOrLocal(() => request("/api/admin/settings", { method: "PATCH", body: patch }), () => {
      localState.classroom = { ...localState.classroom, ...patch };
      persistLocal();
      return { item: structuredClone(localState.classroom) };
    });
  },
  members() { return remoteOrLocal(() => request("/api/admin/members"), () => ({ items: structuredClone(localState.members) })); },
  createMember(input, options) { return remoteOrLocal(() => request("/api/admin/members", { method: "POST", headers: idempotencyHeaders("member", input, options), body: input }), () => createItem("members", "member", { status: "invited", notification_enabled: true, daily_digest_enabled: true, ...input })); },
  updateMember(id, patch) { return remoteOrLocal(() => request(`/api/admin/members/${id}`, { method: "PATCH", body: patch }), () => updateItem("members", id, patch)); },
  inviteMember(id, options = {}) { return remoteOrLocal(() => request(`/api/admin/members/${id}/invite`, { method: "POST", headers: { "Idempotency-Key": options.idempotencyKey || createIdempotencyKey("invite") } }), () => ({ invite_url: `${location.origin}/join/demo-${id.slice(-4)}`, expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString() })); },
  memberTimetable(id, { weekday, date } = {}) {
    const query = new URLSearchParams();
    if (weekday != null) query.set("weekday", String(weekday));
    if (date) query.set("date", date);
    return request(`/api/admin/members/${id}/timetable${query.size ? `?${query.toString()}` : ""}`);
  },
  saveMemberTimetable(id, rows) { return request(`/api/admin/members/${id}/timetable`, { method: "PUT", body: { rows } }); },
  timetable() { return remoteOrLocal(() => request("/api/admin/timetable"), () => ({ items: structuredClone(localState.timetable) })); },
  saveTimetable(weekday, items) {
    return remoteOrLocal(async () => {
      const result = await request(`/api/admin/timetable/${weekday}`, { method: "PUT", body: { items } });
      return { ...result, items: result.items || result.rows || [] };
    }, () => {
      localState.timetable = [...localState.timetable.filter((item) => item.weekday !== Number(weekday)), ...items.map((item, index) => ({ ...item, id: item.id || nextId("tt"), weekday: Number(weekday), period: index + 1 }))];
      persistLocal();
      return { items: structuredClone(localState.timetable.filter((item) => item.weekday === Number(weekday))) };
    });
  },
  events() { return remoteOrLocal(() => request("/api/admin/events"), () => ({ items: structuredClone(localState.events) })); },
  createEvent(input, options) { return remoteOrLocal(() => request("/api/admin/events", { method: "POST", headers: idempotencyHeaders("event", input, options), body: input }), () => createItem("events", "event", { status: "scheduled", ...input })); },
  updateEvent(id, patch) { return remoteOrLocal(() => request(`/api/admin/events/${id}`, { method: "PATCH", body: patch }), () => updateItem("events", id, patch)); },
  deleteEvent(id) { return remoteOrLocal(() => request(`/api/admin/events/${id}`, { method: "DELETE" }), () => { localState.events = localState.events.filter((item) => item.id !== id); persistLocal(); return { ok: true }; }); },
  notices() { return remoteOrLocal(() => request("/api/admin/notices"), () => ({ items: structuredClone(localState.notices) })); },
  createNotice(input, options) { return remoteOrLocal(() => request("/api/admin/notices", { method: "POST", headers: idempotencyHeaders("notice", input, options), body: input }), () => createItem("notices", "notice", { status: "draft", pinned: false, ...input })); },
  updateNotice(id, patch) { return remoteOrLocal(() => request(`/api/admin/notices/${id}`, { method: "PATCH", body: patch }), () => updateItem("notices", id, patch)); },
  deleteNotice(id) { return remoteOrLocal(() => request(`/api/admin/notices/${id}`, { method: "DELETE" }), () => { localState.notices = localState.notices.filter((item) => item.id !== id); persistLocal(); return { ok: true }; }); },
  sendNotice(id, options = {}) { return remoteOrLocal(() => request(`/api/admin/notices/${id}/send`, { method: "POST", headers: { "Idempotency-Key": options.idempotencyKey || createIdempotencyKey("notice-send") } }), () => updateItem("notices", id, { status: "published", published_at: new Date().toISOString() })); },
  files() { return remoteOrLocal(() => request("/api/admin/files"), () => ({ items: structuredClone(localState.files) })); },
  driveStatus() {
    return remoteOrLocal(
      () => request("/api/admin/drive/status"),
      () => ({ configured: false, connected: false, reason: "demo_mode" }),
    );
  },
  syncDrive() { return request("/api/admin/drive/sync", { method: "POST" }); },
  uploadFile(input, options) {
    const body = new FormData();
    body.append("file", input.file);
    body.append("alias", input.alias);
    body.append("description", input.description || "");
    body.append("member_id", input.member_id || "");
    body.append("visibility", input.member_id ? "private" : "class");
    return remoteOrLocal(
      () => request("/api/admin/files", { method: "POST", headers: idempotencyHeaders("file", input, options), body }),
      () => {
        const now = new Date().toISOString();
        const item = {
          id: nextId("file"), alias: input.alias, description: input.description || "", member_id: input.member_id || null,
          filename: input.file.name, original_name: input.file.name, mime_type: input.file.type || "application/octet-stream",
          size_bytes: input.file.size, visibility: input.member_id ? "private" : "class",
          download_url: URL.createObjectURL(input.file), created_at: now, updated_at: now,
        };
        localState.files.unshift(item);
        persistLocal();
        return { item: structuredClone(item) };
      },
    );
  },
  deleteFile(id) { return remoteOrLocal(() => request(`/api/admin/files/${id}`, { method: "DELETE" }), () => { localState.files = localState.files.filter((item) => item.id !== id); persistLocal(); return { ok: true }; }); },
  fileDownloadUrl(item) {
    const value = item?.admin_download_url || item?.download_url || item?.file_url;
    if (value) return new URL(value, location.href).href;
    return new URL(resolveApiPath(`/api/admin/files/${item.id}/download`), location.href).href;
  },
  fileShareUrl(item) {
    const value = item?.share_url || item?.public_url || item?.url;
    if (value) return new URL(value, location.href).href;
    const token = item?.share_token || item?.public_token || item?.token;
    if (token) return new URL(resolveApiPath(`/api/files/${encodeURIComponent(token)}`), location.href).href;
    return this.fileDownloadUrl(item);
  },
  portalSession() { return request("/api/portal/session"); },
  portalLogin({ display_name, invite_code }) {
    return request("/api/portal/login", {
      method: "POST",
      body: EMBEDDED_IN_QUILO ? { invite_code } : { display_name, invite_code },
    });
  },
  portalLogout() { return request("/api/portal/logout", { method: "POST" }); },
  quiloLogout() {
    return EMBEDDED_IN_QUILO
      ? request("/api/logout", { method: "POST", root: true })
      : request("/api/portal/logout", { method: "POST" });
  },
  portalOverview(from, to) {
    const query = new URLSearchParams({ from, to });
    return request(`/api/portal/overview?${query.toString()}`);
  },
  portalFiles() { return request("/api/portal/files"); },
  portalFileUrl(value) {
    if (!value) return "";
    const url = new URL(value, location.href);
    if (url.origin === location.origin && url.pathname.startsWith("/api/")) {
      const base = new URL(API_PREFIX, location.href);
      url.protocol = base.protocol; url.host = base.host;
      url.pathname = `${base.pathname}${url.pathname.slice(4)}`;
    }
    return url.href;
  },
  portalCreateEvent(input, options) { return request("/api/portal/events", { method: "POST", headers: idempotencyHeaders("portal-event", input, options), body: input }); },
  portalUpdateEvent(id, patch) { return request(`/api/portal/events/${id}`, { method: "PATCH", body: patch }); },
  portalDeleteEvent(id) { return request(`/api/portal/events/${id}`, { method: "DELETE" }); },
  notifications() { return remoteOrLocal(() => request("/api/admin/notifications"), () => ({ items: structuredClone(localState.notifications) })); },
  testNotification(options = {}) { return remoteOrLocal(() => request("/api/admin/notifications/test", { method: "POST", headers: { "Idempotency-Key": options.idempotencyKey || createIdempotencyKey("notification-test") } }), () => createItem("notifications", "notification", { kind: "test", status: "reserved", scheduled_for: new Date().toISOString(), payload: { title: "테스트 알림" } })); },
};
