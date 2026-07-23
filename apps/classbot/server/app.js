import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieSession from "cookie-session";
import express from "express";
import helmet from "helmet";
import multer from "multer";
import { loadConfig } from "./config.js";
import { createInviteCode, createCronGuard, hashInviteCode, requireAdmin, safeEqual } from "./security.js";
import { createStore } from "./store/index.js";
import { createFileToken, verifyFileToken } from "./services/file-tokens.js";
import {
  CompositeFileStore,
  createGoogleDriveFileProvider,
} from "./services/google-drive-files.js";
import {
  createPortalToken,
  portalCookieOptions,
  PORTAL_COOKIE_NAME,
  readPortalCookie,
  verifyPortalToken,
} from "./services/portal-session.js";
import { KakaoEventClient, simpleTextResponse } from "./services/kakao.js";
import { handleKakaoCommand } from "./services/commands.js";
import { NotificationService } from "./services/notifications.js";
import { getUpcomingEvents } from "./services/schedule.js";
import { parseKoreaDateTime } from "./time.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATEGORIES = new Set(["assessment", "assignment", "class", "schedule_change"]);
const EVENT_STATUSES = new Set(["scheduled", "completed", "cancelled"]);
const NOTICE_STATUSES = new Set(["draft", "published", "archived"]);
const MEMBER_STATUSES = new Set(["invited", "active", "disabled", "left"]);
const FILE_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const PORTAL_LOGIN_ERROR = "이름을 확인할 수 없습니다.";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function requireString(value, label, maxLength = 200) {
  const text = String(value ?? "").trim();
  if (!text) throw new HttpError(400, `${label}을(를) 입력해 주세요.`);
  if (text.length > maxLength) throw new HttpError(400, `${label}은(는) ${maxLength}자 이하여야 합니다.`);
  return text;
}

function optionalString(value, label, maxLength = 1000) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) throw new HttpError(400, `${label}은(는) ${maxLength}자 이하여야 합니다.`);
  return text;
}

function detectedFileMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) return "application/pdf";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function publicFile(file) {
  const { bucket: _bucket, object_path: _objectPath, created_by: _createdBy, ...safe } = file;
  return { ...safe, visibility: safe.member_id ? "private" : "class" };
}

function safeFileName(value) {
  return String(value || "file").replace(/[\r\n\0"]/g, "_").slice(0, 180) || "file";
}

function sendFileBody(res, file, body, { attachment = false } = {}) {
  const filename = safeFileName(file.filename);
  res.set({
    "Content-Type": file.mime_type,
    "Content-Length": String(body.length),
    "Content-Disposition": `${attachment ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
  });
  return res.send(body);
}

function fileLink(req, token, { download = false } = {}) {
  const basePath = String(req.baseUrl || "").replace(/\/$/, "");
  const url = new URL(`${basePath}/api/files/${encodeURIComponent(token)}`, `${req.protocol}://${req.get("host")}`);
  if (download) url.searchParams.set("download", "1");
  return url.toString();
}

function booleanValue(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new HttpError(400, "켜기/끄기 값은 boolean이어야 합니다.");
  return value;
}

function requestKey(req) {
  const value = req.get("idempotency-key") || req.body?.request_key || "";
  if (!value) return null;
  const normalized = String(value).trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalized)) {
    throw new HttpError(400, "Idempotency-Key는 8~128자의 영문, 숫자, '.', '_', ':', '-'만 사용할 수 있습니다.");
  }
  return normalized;
}

function validateReminderOffsets(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) throw new HttpError(400, "알림 시점은 배열로 최대 10개까지 입력해 주세요.");
  const offsets = [...new Set(value.map(Number))];
  if (offsets.some((item) => !Number.isInteger(item) || item < 0 || item > 525_600)) {
    throw new HttpError(400, "알림 시점은 0~525600 사이의 분 단위 정수여야 합니다.");
  }
  return offsets;
}

function eventInput(body, { partial = false } = {}) {
  const input = {};
  if (!partial || body.title !== undefined) input.title = requireString(body.title, "일정 제목", 120);
  if (!partial || body.category !== undefined) {
    input.category = body.category || "assessment";
    if (!CATEGORIES.has(input.category)) throw new HttpError(400, "올바른 일정 유형을 선택해 주세요.");
  }
  if (!partial || body.due_at !== undefined) {
    const dueAt = requireString(body.due_at, "마감 일시", 40);
    try {
      input.due_at = parseKoreaDateTime(dueAt).toISOString();
    } catch {
      throw new HttpError(400, "올바른 마감 일시를 입력해 주세요.");
    }
  }
  if (body.subject !== undefined || !partial) input.subject = optionalString(body.subject, "과목", 40);
  if (body.description !== undefined || !partial) input.description = optionalString(body.description, "설명", 2000);
  if (body.member_id !== undefined || !partial) {
    input.member_id = body.member_id == null || body.member_id === ""
      ? null
      : requireString(body.member_id, "개인 일정 구성원", 128);
  }
  if (body.status !== undefined) {
    if (!EVENT_STATUSES.has(body.status)) throw new HttpError(400, "올바른 일정 상태를 선택해 주세요.");
    input.status = body.status;
  }
  if (body.notify_on_change !== undefined || !partial) input.notify_on_change = booleanValue(body.notify_on_change, true);
  const offsets = validateReminderOffsets(body.reminder_offsets);
  if (offsets !== undefined) input.reminder_offsets = offsets;
  return input;
}

async function validateEventMember(store, memberId) {
  if (!memberId) return;
  const member = await store.getMember(memberId);
  if (!member || member.status === "left") {
    throw new HttpError(400, "개인 일정을 등록할 구성원을 찾을 수 없습니다.");
  }
}

function noticeInput(body, { partial = false } = {}) {
  const input = {};
  if (!partial || body.title !== undefined) input.title = requireString(body.title, "공지 제목", 120);
  if (!partial || body.body !== undefined) input.body = requireString(body.body, "공지 내용", 4000);
  if (body.status !== undefined || !partial) {
    input.status = body.status || "draft";
    if (!NOTICE_STATUSES.has(input.status)) throw new HttpError(400, "올바른 공지 상태를 선택해 주세요.");
  }
  if (body.pinned !== undefined || !partial) input.pinned = booleanValue(body.pinned, false);
  if (body.notify_on_publish !== undefined || !partial) {
    input.notify_on_publish = booleanValue(body.notify_on_publish, true);
  }
  return input;
}

function timetableInput(weekday, body) {
  const numericWeekday = Number(weekday);
  if (!Number.isInteger(numericWeekday) || numericWeekday < 1 || numericWeekday > 5) {
    throw new HttpError(400, "요일은 1(월)부터 5(금) 사이여야 합니다.");
  }
  const sourceRows = body.rows ?? body.items;
  if (!Array.isArray(sourceRows) || sourceRows.length > 12) throw new HttpError(400, "시간표는 rows 배열로 최대 12교시까지 입력해 주세요.");
  const rows = sourceRows.map((row, index) => {
    const period = Number(row.period ?? index + 1);
    if (!Number.isInteger(period) || period < 1 || period > 12) throw new HttpError(400, "교시는 1~12 사이의 정수여야 합니다.");
    return {
      period,
      subject: optionalString(row.subject, "과목", 40),
      activity: optionalString(row.activity, "수업 내용", 120),
      teacher: optionalString(row.teacher, "교사", 40),
      room: optionalString(row.room, "교실", 40),
      memo: optionalString(row.memo, "준비물", 200),
      effective_from: row.effective_from,
      effective_to: row.effective_to,
    };
  });
  const periods = rows.filter((row) => row.subject).map((row) => row.period);
  if (new Set(periods).size !== periods.length) throw new HttpError(409, "같은 교시를 두 번 저장할 수 없습니다.");
  return { weekday: numericWeekday, rows };
}

function initialMembersInput(body) {
  const source = body.members ?? body.items;
  if (!Array.isArray(source) || source.length < 1 || source.length > 16) {
    throw new HttpError(400, "초기 구성원 명단은 members 배열로 1~16명을 입력해 주세요.");
  }
  const members = source.map((item) => {
    const role = item.role || "student";
    if (!new Set(["admin", "student"]).has(role)) throw new HttpError(400, "올바른 구성원 역할을 선택해 주세요.");
    return { display_name: requireString(item.display_name, "이름", 40), role };
  });
  const normalizedNames = members.map((member) => member.display_name.replace(/\s+/g, " "));
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    throw new HttpError(409, "초기 구성원 명단에 같은 이름을 두 번 넣을 수 없습니다.");
  }
  return members;
}

function allowedOrigins(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function publicNotifications(items) {
  return items.map((item) => ({
    ...item,
    payload: item.payload?.message ? { message: item.payload.message } : {},
  }));
}

function publicMember(member) {
  const {
    kakao_user_key: kakaoUserKey,
    kakao_user_key_type: _keyType,
    quilo_user_id: quiloUserId,
    ...safe
  } = member;
  return {
    ...safe,
    kakao_connected: Boolean(kakaoUserKey),
    quilo_connected: Boolean(quiloUserId),
  };
}

function publicMembers(items) {
  return items.map(publicMember);
}

function portalMember(member) {
  return { id: member.id, display_name: member.display_name, role: member.role };
}

function portalRange(query) {
  const result = {};
  for (const key of ["from", "to"]) {
    const value = query[key];
    if (value == null || value === "") continue;
    if (typeof value !== "string" || value.length > 40) {
      throw new HttpError(400, "올바른 일정 조회 기간을 입력해 주세요.");
    }
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `${value}T${key === "from" ? "00:00:00.000" : "23:59:59.999"}`
      : value;
    try {
      result[key] = parseKoreaDateTime(normalized).toISOString();
    } catch {
      throw new HttpError(400, "올바른 일정 조회 기간을 입력해 주세요.");
    }
  }
  if (result.from && result.to && new Date(result.from) > new Date(result.to)) {
    throw new HttpError(400, "일정 조회 시작은 종료보다 늦을 수 없습니다.");
  }
  return result;
}

function createLoginLimiter() {
  const attempts = new Map();
  return (req, _res, next) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter((time) => now - time < 15 * 60_000);
    if (recent.length >= 10) return next(new HttpError(429, "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요."));
    recent.push(now);
    attempts.set(key, recent);
    req.clearLoginAttempts = () => attempts.delete(key);
    next();
  };
}

function createPortalLoginLimiter() {
  const attempts = new Map();
  return (req, _res, next) => {
    const key = req.ip || "unknown";
    const current = Date.now();
    const recent = (attempts.get(key) || []).filter((time) => current - time < 15 * 60_000);
    if (recent.length >= 10) {
      return next(new HttpError(429, "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요."));
    }
    recent.push(current);
    attempts.set(key, recent);
    return next();
  };
}

export async function createApp(options = {}) {
  const config = options.config || loadConfig();
  const store = options.store || (await createStore(config));
  const kakaoClient = options.kakaoClient || new KakaoEventClient(config.kakao);
  const notifications = options.notificationService || new NotificationService({ store, kakaoClient });
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const googleDriveFiles = options.googleDriveFileProvider
    || createGoogleDriveFileProvider(config, options.googleDriveDependencies);
  const fileStore = options.fileStore || new CompositeFileStore(store, googleDriveFiles);
  const commandStore = new Proxy(store, {
    get(target, property) {
      if (property === "listFiles") return fileStore.listFiles.bind(fileStore);
      if (property === "getFile") return fileStore.getFile.bind(fileStore);
      if (property === "downloadFile") return fileStore.downloadFile.bind(fileStore);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const embedded = options.embedded === true;
  const app = express();
  const origins = allowedOrigins(config.allowedOrigin);
  const portalCookie = portalCookieOptions({ embedded, production: config.production });
  const clearPortalCookie = (res) => {
    const { maxAge: _maxAge, ...options } = portalCookie;
    res.clearCookie(PORTAL_COOKIE_NAME, options);
  };
  const setPortalCookie = (res, token) => res.cookie(PORTAL_COOKIE_NAME, token, portalCookie);
  const resolvePortalMember = async (req) => {
    if (embedded) {
      const identity = req.classbotExternalUser;
      if (!identity?.id || !/^[A-Za-z0-9_-]{8,300}$/.test(String(identity.id))) return null;
      const member = await store.findMemberByQuiloUserId(identity.id);
      return member && !new Set(["left", "disabled"]).has(member.status) ? member : null;
    }
    const token = readPortalCookie(req.get("cookie"));
    if (!token) return null;
    let verified;
    try {
      verified = verifyPortalToken(token, config.sessionSecret, { now: now() });
    } catch {
      return null;
    }
    const member = await store.getMember(verified.memberId);
    return member && !new Set(["left", "disabled"]).has(member.status) ? member : null;
  };
  const requirePortal = asyncRoute(async (req, _res, next) => {
    const member = await resolvePortalMember(req);
    if (!member) throw new HttpError(401, "학생 포털 로그인이 필요합니다.");
    req.portalMember = member;
    return next();
  });
  const portalCanManageEvent = (member, event) => Boolean(
    event
    && (event.member_id === member.id || (member.role === "admin" && event.member_id == null)),
  );
  const portalFile = (req, file, issuedAt) => {
    const token = createFileToken(file.id, config.sessionSecret, { now: issuedAt, ttlSeconds: 15 * 60 });
    return {
      id: file.id,
      alias: file.alias,
      filename: file.filename,
      description: file.description,
      mime_type: file.mime_type,
      size_bytes: file.size_bytes,
      member_id: file.member_id || null,
      visibility: file.member_id ? "private" : "class",
      created_at: file.created_at,
      open_url: fileLink(req, token),
      download_url: fileLink(req, token, { download: true }),
      links_expire_at: new Date(issuedAt.getTime() + 15 * 60_000).toISOString(),
    };
  };
  const fileForAdmin = (req, file) => {
    const safe = publicFile(file);
    if (file.member_id) return safe;
    const issuedAt = now();
    return {
      ...safe,
      share_url: fileLink(req, createFileToken(file.id, config.sessionSecret, { now: issuedAt })),
      share_expires_at: new Date(issuedAt.getTime() + 15 * 60_000).toISOString(),
    };
  };
  const fileUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 8, fieldSize: 4 * 1024 },
  }).single("file");
  const receiveFile = (req, res, next) => fileUpload(req, res, (error) => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") return next(new HttpError(413, "파일은 20MB 이하여야 합니다."));
    return next(new HttpError(400, "파일 업로드 형식이 올바르지 않습니다."));
  });

  if (config.production) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        upgradeInsecureRequests: null,
      },
    },
  }));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    next();
  });
  app.use((req, res, next) => {
    const origin = req.get("origin");
    const requestOrigin = `${req.protocol}://${req.get("host")}`;
    const originAllowed = !origin || origin === requestOrigin || origins.has(origin);
    if (origin && originAllowed) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Credentials", "true");
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key");
      res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") return originAllowed ? res.sendStatus(204) : res.sendStatus(403);
    if (origin && !originAllowed && (req.path.startsWith("/api/admin") || req.path.startsWith("/api/portal"))) {
      return next(new HttpError(403, "허용되지 않은 화면에서 보낸 요청입니다."));
    }
    return next();
  });
  app.use(express.json({ limit: "256kb" }));
  // Standalone development keeps its own cookie. In production the app is
  // mounted inside Quilo and reuses the already verified Quilo admin session;
  // installing a second cookie-session there would overwrite req.session.
  if (!embedded) {
    app.use(
      cookieSession({
        name: "classbot_admin",
        keys: [config.sessionSecret],
        maxAge: 8 * 60 * 60_000,
        httpOnly: true,
        secure: config.production,
        sameSite: "strict",
      }),
    );
  }

  app.get("/api/health", asyncRoute(async (_req, res) => {
    try {
      await store.healthCheck?.();
      res.json({ ok: true, storage: config.storage, kakaoEnabled: kakaoClient.enabled });
    } catch {
      res.status(503).json({ ok: false, storage: config.storage, kakaoEnabled: kakaoClient.enabled, reason: "storage_unavailable" });
    }
  }));

  app.get("/api/files/:token", asyncRoute(async (req, res) => {
    let verified;
    try {
      verified = verifyFileToken(req.params.token, config.sessionSecret, { now: now() });
    } catch (error) {
      throw new HttpError(/만료/.test(error.message) ? 410 : 403, error.message);
    }
    const file = await fileStore.getFile(verified.fileId);
    if (!file || file.status !== "active") throw new HttpError(404, "파일을 찾을 수 없습니다.");
    sendFileBody(res, file, await fileStore.downloadFile(file.id), { attachment: req.query.download === "1" });
  }));

  app.post("/api/portal/login", createPortalLoginLimiter(), asyncRoute(async (req, res) => {
    if (embedded) {
      const identity = req.classbotExternalUser;
      const inviteCode = typeof req.body?.invite_code === "string" ? req.body.invite_code.trim() : "";
      if (!identity?.id) throw new HttpError(401, "Quilo 로그인이 필요합니다.");
      if (!inviteCode || inviteCode.length > 40) throw new HttpError(401, PORTAL_LOGIN_ERROR);
      let member;
      try {
        member = await store.claimQuiloInvite({ code: inviteCode, userId: identity.id });
      } catch {
        throw new HttpError(401, PORTAL_LOGIN_ERROR);
      }
      return res.json({ authenticated: true, member: portalMember(member) });
    }
    const displayName = typeof req.body?.display_name === "string" ? req.body.display_name.trim() : "";
    const inviteCode = typeof req.body?.invite_code === "string" ? req.body.invite_code.trim() : "";
    const members = displayName && displayName.length <= 40 && inviteCode && inviteCode.length <= 40
      ? await store.listMembers()
      : [];
    const matches = members.filter((member) => member.display_name === displayName);
    if (matches.length !== 1 || new Set(["left", "disabled"]).has(matches[0].status)) {
      throw new HttpError(401, PORTAL_LOGIN_ERROR);
    }
    let member;
    try {
      member = await store.claimPortalInvite({ memberId: matches[0].id, code: inviteCode });
    } catch {
      throw new HttpError(401, PORTAL_LOGIN_ERROR);
    }
    if (!member || new Set(["left", "disabled"]).has(member.status)) {
      throw new HttpError(401, PORTAL_LOGIN_ERROR);
    }
    setPortalCookie(res, createPortalToken(member.id, config.sessionSecret, { now: now() }));
    res.json({ authenticated: true, member: portalMember(member) });
  }));

  app.get("/api/portal/session", asyncRoute(async (req, res) => {
    const member = await resolvePortalMember(req);
    if (!member) {
      if (!embedded && readPortalCookie(req.get("cookie"))) clearPortalCookie(res);
      return res.json({
        authenticated: false,
        ...(embedded ? {
          reason: req.classbotExternalUser ? "invite_required" : "login_required",
          login_url: "/login.html?next=/schedule/",
        } : {}),
      });
    }
    return res.json({ authenticated: true, member: portalMember(member) });
  }));

  app.post("/api/portal/logout", (req, res) => {
    clearPortalCookie(res);
    res.json({ authenticated: false });
  });

  app.get("/api/portal/overview", requirePortal, asyncRoute(async (req, res) => {
    const range = portalRange(req.query || {});
    const timetablePromise = (async () => {
      if (typeof store.listMemberTimetable === "function") {
        const memberTimetable = await store.listMemberTimetable(req.portalMember.id, { date: range.from || now() });
        if (Array.isArray(memberTimetable) && memberTimetable.length) return memberTimetable;
      }
      return store.listTimetable();
    })();
    const [classroom, timetable, events, notices, members] = await Promise.all([
      store.getClassroom(),
      timetablePromise,
      store.listEvents({ ...range, targetMemberId: req.portalMember.id }),
      store.listNotices({ status: "published", limit: 50 }),
      store.listMembers(),
    ]);
    res.json({
      member: portalMember(req.portalMember),
      classroom,
      timetable,
      notices: notices.filter((notice) => notice.status === "published"),
      events: events.filter((event) => event.member_id == null || event.member_id === req.portalMember.id),
      members: members
        .filter((member) => !new Set(["left", "disabled"]).has(member.status))
        .map(portalMember),
    });
  }));

  app.get("/api/portal/files", requirePortal, asyncRoute(async (req, res) => {
    const issuedAt = now();
    const files = await fileStore.listFiles({ targetMemberId: req.portalMember.id, status: "active" });
    res.json({
      items: files
        .filter((file) => file.status === "active" && (file.member_id == null || file.member_id === req.portalMember.id))
        .map((file) => portalFile(req, file, issuedAt)),
    });
  }));

  app.post("/api/portal/events", requirePortal, asyncRoute(async (req, res) => {
    const requestedScope = String(req.body?.scope || "personal");
    const scope = requestedScope === "self" ? "personal" : requestedScope;
    if (!new Set(["personal", "class"]).has(scope)) throw new HttpError(400, "올바른 일정 공개 범위를 선택해 주세요.");
    if (scope === "class" && req.portalMember.role !== "admin") {
      throw new HttpError(403, "반 전체 일정은 학급 관리자만 등록할 수 있습니다.");
    }
    const memberId = scope === "class" ? null : req.portalMember.id;
    if (req.body?.member_id !== undefined && (req.body.member_id || null) !== memberId) {
      throw new HttpError(403, "다른 구성원의 일정은 등록할 수 없습니다.");
    }
    const input = {
      ...eventInput({ ...(req.body || {}), member_id: memberId }),
      request_key: requestKey(req),
    };
    const item = await store.createEvent(input, `portal:${req.portalMember.id}`);
    res.status(201).json({ item });
  }));

  app.patch("/api/portal/events/:id", requirePortal, asyncRoute(async (req, res) => {
    const current = await store.getEvent(req.params.id);
    if (!portalCanManageEvent(req.portalMember, current)) throw new HttpError(404, "일정을 찾을 수 없습니다.");
    if (req.body?.member_id !== undefined || req.body?.scope !== undefined) {
      throw new HttpError(400, "학생 포털에서는 일정 공개 범위를 변경할 수 없습니다.");
    }
    const input = eventInput(req.body || {}, { partial: true });
    if (!Object.keys(input).length) throw new HttpError(400, "변경할 일정 내용을 입력해 주세요.");
    const item = await store.updateEvent(req.params.id, input, `portal:${req.portalMember.id}`);
    res.json({ item });
  }));

  app.delete("/api/portal/events/:id", requirePortal, asyncRoute(async (req, res) => {
    const current = await store.getEvent(req.params.id);
    if (!portalCanManageEvent(req.portalMember, current)) throw new HttpError(404, "일정을 찾을 수 없습니다.");
    const item = await store.cancelEvent(req.params.id, `portal:${req.portalMember.id}`);
    res.json({ item });
  }));

  const isAdminRequest = (req) => embedded
    ? req.classbotExternalAdmin === true
    : req.session?.isAdmin === true;

  app.get("/api/admin/session", (req, res) => {
    const authenticated = isAdminRequest(req);
    return res.json({
      authenticated,
      ...(authenticated && req.classbotExternalUser
        ? { actor: { id: req.classbotExternalUser.id, name: req.classbotExternalUser.name } }
        : {}),
    });
  });
  app.post("/api/admin/login", createLoginLimiter(), asyncRoute(async (req, res) => {
    if (embedded) throw new HttpError(401, "Quilo 관리자 계정으로 먼저 로그인해 주세요.");
    const password = requireString(req.body?.password, "관리자 비밀번호", 512);
    if (!safeEqual(password, config.adminPassword)) throw new HttpError(401, "관리자 비밀번호가 올바르지 않습니다.");
    req.session = { isAdmin: true, signedInAt: new Date().toISOString() };
    req.clearLoginAttempts?.();
    res.json({ authenticated: true, classroom: await store.getClassroom() });
  }));
  app.post("/api/admin/logout", (req, res) => {
    if (embedded) return res.json({ authenticated: false, login_url: "/login.html" });
    req.session = null;
    res.json({ authenticated: false });
  });

  app.use("/api/admin", (req, res, next) => {
    if (isAdminRequest(req)) return next();
    return requireAdmin(req, res, next);
  });

  app.get("/api/admin/files", asyncRoute(async (req, res) => {
    res.json({ items: (await fileStore.listFiles({ all: true })).map((file) => fileForAdmin(req, file)) });
  }));
  app.get("/api/admin/drive/status", asyncRoute(async (_req, res) => {
    res.json(await googleDriveFiles.status());
  }));
  app.post("/api/admin/drive/sync", asyncRoute(async (req, res) => {
    if (!googleDriveFiles.configured) {
      throw new HttpError(409, "Google Drive 자료실 운영 계정이 설정되지 않았습니다.");
    }
    const items = await googleDriveFiles.listFiles();
    res.json({
      ok: true,
      item_count: items.length,
      items: items.map((file) => fileForAdmin(req, file)),
    });
  }));
  app.post("/api/admin/files", receiveFile, asyncRoute(async (req, res) => {
    if (!req.file?.buffer?.length) throw new HttpError(400, "올릴 PDF 또는 이미지 파일을 선택해 주세요.");
    const mimeType = detectedFileMime(req.file.buffer);
    if (!mimeType || !FILE_MIME_TYPES.has(mimeType)) {
      throw new HttpError(400, "PDF, JPEG, PNG, WebP, GIF 파일만 올릴 수 있습니다.");
    }
    const visibility = String(req.body?.visibility || (req.body?.member_id ? "private" : "class"));
    if (!new Set(["class", "private"]).has(visibility)) throw new HttpError(400, "자료 공개 범위가 올바르지 않습니다.");
    let memberId = req.body?.member_id ? requireString(req.body.member_id, "개인 자료 구성원", 128) : null;
    if (visibility === "private" && !memberId) throw new HttpError(400, "개인 자료를 받을 구성원을 선택해 주세요.");
    if (visibility === "class" && memberId) throw new HttpError(400, "반 전체 자료에는 개인 구성원을 지정할 수 없습니다.");
    if (memberId) {
      const member = await store.getMember(memberId);
      if (!member || member.status === "left") throw new HttpError(400, "개인 자료를 받을 구성원을 찾을 수 없습니다.");
    }
    const item = await fileStore.createFile({
      member_id: memberId,
      alias: requireString(req.body?.alias, "자료 별칭", 60),
      filename: requireString(req.file.originalname, "파일 이름", 180),
      description: optionalString(req.body?.description, "자료 설명", 1000),
      mime_type: mimeType,
    }, req.file.buffer, "admin");
    res.status(201).json({ item: fileForAdmin(req, item) });
  }));
  app.patch("/api/admin/files/:id", asyncRoute(async (req, res) => {
    const patch = {};
    if (req.body.alias !== undefined) patch.alias = requireString(req.body.alias, "자료 별칭", 60);
    if (req.body.description !== undefined) patch.description = optionalString(req.body.description, "자료 설명", 1000);
    if (!Object.keys(patch).length) throw new HttpError(400, "변경할 자료 정보를 입력해 주세요.");
    res.json({ item: fileForAdmin(req, await fileStore.updateFile(req.params.id, patch, "admin")) });
  }));
  app.get("/api/admin/files/:id/download", asyncRoute(async (req, res) => {
    const file = await fileStore.getFile(req.params.id);
    if (!file || file.status !== "active") throw new HttpError(404, "파일을 찾을 수 없습니다.");
    sendFileBody(res, file, await fileStore.downloadFile(file.id), { attachment: true });
  }));
  app.delete("/api/admin/files/:id", asyncRoute(async (req, res) => {
    res.json({ item: publicFile(await fileStore.deleteFile(req.params.id, "admin")) });
  }));

  app.get("/api/admin/overview", asyncRoute(async (_req, res) => {
    const [classroom, members, timetable, events, notices, notificationItems] = await Promise.all([
      store.getClassroom(),
      store.listMembers(),
      store.listTimetable(),
      getUpcomingEvents(store, now(), 60),
      store.listNotices({ limit: 20 }),
      store.listNotifications({ limit: 30 }),
    ]);
    res.json({
      classroom,
      members: publicMembers(members),
      timetable,
      events,
      notices: notices.filter((notice) => notice.status !== "archived"),
      notifications: publicNotifications(notificationItems),
      stats: {
        memberCount: members.length,
        activeMemberCount: members.filter((member) => member.status === "active").length,
        upcomingAssessmentCount: events.filter((event) => event.category === "assessment").length,
        failedNotificationCount: notificationItems.filter((item) => item.status === "failed").length,
      },
    });
  }));

  app.get("/api/admin/settings", asyncRoute(async (_req, res) => res.json({ item: await store.getClassroom() })));
  app.patch("/api/admin/settings", asyncRoute(async (req, res) => {
    const patch = {};
    if (req.body.name !== undefined) patch.name = requireString(req.body.name, "학급 이름", 60);
    if (req.body.daily_digest_time !== undefined) {
      const time = String(req.body.daily_digest_time);
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, "아침 알림 시간은 HH:MM 형식이어야 합니다.");
      patch.daily_digest_time = time;
    }
    if (req.body.daily_digest_enabled !== undefined) patch.daily_digest_enabled = booleanValue(req.body.daily_digest_enabled, true);
    res.json({ item: await store.updateSettings(patch, "admin") });
  }));

  app.get("/api/admin/members", asyncRoute(async (_req, res) => res.json({ items: publicMembers(await store.listMembers()) })));
  app.post("/api/admin/members", asyncRoute(async (req, res) => {
    const role = req.body.role || "student";
    if (!new Set(["admin", "student"]).has(role)) throw new HttpError(400, "올바른 구성원 역할을 선택해 주세요.");
    const item = await store.createMember({ display_name: requireString(req.body.display_name, "이름", 40), role }, "admin");
    res.status(201).json({ item: publicMember(item) });
  }));
  app.post("/api/admin/members/import", asyncRoute(async (req, res) => {
    const createdCount = await store.seedMembersIfEmpty(initialMembersInput(req.body || {}), "admin");
    if (!createdCount) throw new HttpError(409, "구성원이 이미 있어 초기 명단을 가져올 수 없습니다.");
    res.status(201).json({ created_count: createdCount });
  }));
  app.patch("/api/admin/members/:id", asyncRoute(async (req, res) => {
    const patch = {};
    if (req.body.display_name !== undefined) patch.display_name = requireString(req.body.display_name, "이름", 40);
    if (req.body.role !== undefined) {
      if (!new Set(["admin", "student"]).has(req.body.role)) throw new HttpError(400, "올바른 구성원 역할을 선택해 주세요.");
      patch.role = req.body.role;
    }
    if (req.body.status !== undefined) {
      if (!MEMBER_STATUSES.has(req.body.status)) throw new HttpError(400, "올바른 구성원 상태를 선택해 주세요.");
      patch.status = req.body.status;
    }
    for (const key of ["notification_enabled", "daily_digest_enabled"]) {
      if (req.body[key] !== undefined) patch[key] = booleanValue(req.body[key], true);
    }
    res.json({ item: publicMember(await store.updateMember(req.params.id, patch, "admin")) });
  }));
  app.post("/api/admin/members/:id/invite", asyncRoute(async (req, res) => {
    const expiresInHours = Number(req.body?.expires_in_hours ?? 72);
    if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 168) {
      throw new HttpError(400, "초대 코드 유효기간은 1~168시간 사이여야 합니다.");
    }
    const code = createInviteCode();
    const expiresAt = new Date(Date.now() + expiresInHours * 3_600_000).toISOString();
    const item = await store.createInvite({ memberId: req.params.id, codeHash: hashInviteCode(code), expiresAt }, "admin");
    res.status(201).json({ item: { id: item.id, member_id: item.member_id, expires_at: item.expires_at }, code });
  }));

  app.get("/api/admin/members/:id/timetable", asyncRoute(async (req, res) => {
    const weekday = req.query.weekday === undefined ? undefined : Number(req.query.weekday);
    if (weekday !== undefined && (!Number.isInteger(weekday) || weekday < 1 || weekday > 5)) {
      throw new HttpError(400, "요일은 1~5 사이여야 합니다.");
    }
    res.json({ items: await store.listMemberTimetable(req.params.id, { weekday, date: req.query.date || now() }) });
  }));
  app.put("/api/admin/members/:id/timetable", asyncRoute(async (req, res) => {
    if (!Array.isArray(req.body?.rows)) throw new HttpError(400, "개인 시간표 rows 배열이 필요합니다.");
    res.json({ items: await store.replaceMemberTimetable({ memberId: req.params.id, rows: req.body.rows }, "admin") });
  }));

  app.get("/api/admin/timetable", asyncRoute(async (req, res) => {
    const weekday = req.query.weekday === undefined ? undefined : Number(req.query.weekday);
    if (weekday !== undefined && (!Number.isInteger(weekday) || weekday < 1 || weekday > 5)) throw new HttpError(400, "요일은 1~5 사이여야 합니다.");
    res.json({ items: await store.listTimetable({ weekday }) });
  }));
  app.put("/api/admin/timetable/:weekday", asyncRoute(async (req, res) => {
    const input = timetableInput(req.params.weekday, req.body || {});
    res.json({ items: await store.replaceTimetableDay(input, "admin") });
  }));

  app.get("/api/admin/events", asyncRoute(async (req, res) => {
    if (req.query.status && !EVENT_STATUSES.has(req.query.status)) throw new HttpError(400, "올바른 일정 상태를 선택해 주세요.");
    for (const key of ["from", "to"]) {
      if (req.query[key]) {
        try {
          parseKoreaDateTime(req.query[key]);
        } catch {
          throw new HttpError(400, "올바른 일정 조회 기간을 입력해 주세요.");
        }
      }
    }
    let items = await store.listEvents({ from: req.query.from, to: req.query.to, status: req.query.status });
    if (req.query.category) items = items.filter((item) => item.category === req.query.category);
    res.json({ items });
  }));
  app.post("/api/admin/events", asyncRoute(async (req, res) => {
    const input = { ...eventInput(req.body || {}), request_key: requestKey(req) };
    await validateEventMember(store, input.member_id);
    const item = await store.createEvent(input, "admin");
    res.status(201).json({ item });
  }));
  app.patch("/api/admin/events/:id", asyncRoute(async (req, res) => {
    const input = eventInput(req.body || {}, { partial: true });
    if (!Object.keys(input).length) throw new HttpError(400, "변경할 일정 내용을 입력해 주세요.");
    if (input.member_id !== undefined) await validateEventMember(store, input.member_id);
    res.json({ item: await store.updateEvent(req.params.id, input, "admin") });
  }));
  app.delete("/api/admin/events/:id", asyncRoute(async (req, res) => {
    res.json({ item: await store.cancelEvent(req.params.id, "admin") });
  }));

  app.get("/api/admin/notices", asyncRoute(async (req, res) => {
    if (req.query.status && !NOTICE_STATUSES.has(req.query.status)) throw new HttpError(400, "올바른 공지 상태를 선택해 주세요.");
    let items = await store.listNotices({ status: req.query.status, limit: Math.min(Number(req.query.limit) || 50, 100) });
    if (!req.query.status) items = items.filter((notice) => notice.status !== "archived");
    res.json({ items });
  }));
  app.post("/api/admin/notices", asyncRoute(async (req, res) => {
    const input = { ...noticeInput(req.body || {}), request_key: requestKey(req) };
    const item = await store.createNotice(input, "admin");
    const delivery = item.status === "published" && item.notify_on_publish
      ? await notifications.dispatchNotice(item)
      : null;
    res.status(201).json({ item, delivery });
  }));
  app.patch("/api/admin/notices/:id", asyncRoute(async (req, res) => {
    const input = noticeInput(req.body || {}, { partial: true });
    if (!Object.keys(input).length) throw new HttpError(400, "변경할 공지 내용을 입력해 주세요.");
    let item;
    let delivery = null;
    if (input.status === "published") {
      const { status: _status, ...other } = input;
      if (Object.keys(other).length) await store.updateNotice(req.params.id, other, "admin");
      const published = await store.publishNotice(req.params.id, "admin");
      item = published.notice;
      if (published.newlyPublished && item.notify_on_publish) delivery = await notifications.dispatchNotice(item);
    } else {
      item = await store.updateNotice(req.params.id, input, "admin");
    }
    res.json({ item, delivery });
  }));
  app.delete("/api/admin/notices/:id", asyncRoute(async (req, res) => {
    res.json({ item: await store.archiveNotice(req.params.id, "admin") });
  }));
  app.post("/api/admin/notices/:id/send", asyncRoute(async (req, res) => {
    const { notice } = await store.publishNotice(req.params.id, "admin");
    res.json({ item: notice, delivery: await notifications.dispatchNotice(notice, { dryRun: req.body?.dry_run === true }) });
  }));

  app.get("/api/admin/notifications", asyncRoute(async (req, res) => {
    const status = req.query.status;
    if (status && !new Set(["reserved", "sent", "failed", "skipped"]).has(status)) throw new HttpError(400, "올바른 알림 상태를 선택해 주세요.");
    const items = await store.listNotifications({ status, limit: Math.min(Number(req.query.limit) || 50, 200) });
    res.json({ items: publicNotifications(items) });
  }));
  app.post("/api/admin/notifications/test", asyncRoute(async (req, res) => {
    const message = optionalString(req.body?.message || "Quilo 알림 연결 테스트입니다.", "테스트 메시지", 900);
    res.json({ delivery: await notifications.dispatchTest({ message, memberId: req.body?.member_id, dryRun: req.body?.dry_run === true }) });
  }));
  app.post("/api/admin/notifications/:id/retry", asyncRoute(async (req, res) => {
    const retryKey = requestKey(req);
    if (!retryKey) throw new HttpError(400, "명시적 재시도에는 Idempotency-Key가 필요합니다.");
    const notification = await store.getNotification(req.params.id);
    if (!notification) throw new HttpError(404, "알림 기록을 찾을 수 없습니다.");
    const delivery = await notifications.retryFailed(notification, {
      retryKey,
      dryRun: req.body?.dry_run === true,
    });
    res.json({ delivery });
  }));

  app.post("/api/kakao/skill", asyncRoute(async (req, res) => {
    if (config.kakaoSkillSecret) {
      const supplied = req.get("x-classbot-skill-secret") || req.query.secret;
      if (!safeEqual(supplied, config.kakaoSkillSecret)) return res.status(401).json(simpleTextResponse("인증되지 않은 스킬 요청입니다."));
    }
    res.json(await handleKakaoCommand({
      payload: req.body || {},
      store: commandStore,
      now: now(),
      makeFileUrl: (file) => fileLink(req, createFileToken(file.id, config.sessionSecret, { now: now() })),
    }));
  }));

  app.post("/api/cron/notifications", createCronGuard(config.cronSecret), asyncRoute(async (req, res) => {
    const dryRun = req.body?.dry_run === true;
    const reconciliation = dryRun
      ? { dryRun: true, skipped: true, reason: "read_only_preview" }
      : await notifications.reconcilePending();
    const dispatch = await notifications.dispatchDue({ now: now(), dryRun });
    res.json({ reconciliation, dispatch });
  }));

  const distDir = path.resolve(__dirname, "../dist");
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false }));
    app.get("/{*path}", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      return res.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.use((req, res) => res.status(404).json({ error: "요청한 API를 찾을 수 없습니다." }));
  app.use((error, _req, res, _next) => {
    const inferredStatus = /찾을 수 없습니다/.test(error.message)
      ? 404
      : /초과|이미|중복|두 번/.test(error.message)
        ? 409
        : /입력|올바른|선택|만료|초대 코드|게시된 공지|재시도|활성 구성원|원본 알림/.test(error.message)
          ? 400
          : 500;
    const status = error.status || (error.type === "entity.parse.failed" ? 400 : inferredStatus);
    const message = status >= 500 && config.production ? "서버에서 요청을 처리하지 못했습니다." : error.message;
    if (status >= 500) console.error("[classbot]", error);
    res.status(status).json({ error: message || "요청을 처리하지 못했습니다." });
  });

  app.locals.classbot = { config, store, kakaoClient, notifications };
  return app;
}
