"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const sharp = require("sharp");
const supa = require("./supabase");

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_AVATAR_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_AVATAR_OUTPUT_BYTES = 2 * 1024 * 1024;
const AVATAR_BUCKET = "profile-images";
const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POST_KINDS = new Set(["developer", "resource"]);
const POST_STATUSES = new Set(["draft", "published"]);
const REQUEST_STATUSES = new Set(["open", "reviewing", "planned", "fulfilled", "declined"]);
const TAXONOMY_TYPES = new Set(["category", "topic"]);

class EditorialError extends Error {
  constructor(message, { code = "EDITORIAL_ERROR", status = 400, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "EditorialError";
    this.code = code;
    this.status = status;
  }
}

const SCHEMA_MISSING_RE =
  /(?:relation|column).*?(?:editorial_|resource_requests|is_staff|is_developer|avatar_url|profile_bio).*?(?:does not exist|not found)|could not find (?:the table|the .* column)|schema cache|PGRST20[245]/i;

function isSchemaMissingError(error) {
  const message = `${error && error.code ? error.code : ""} ${error && error.message ? error.message : error || ""}`;
  return SCHEMA_MISSING_RE.test(message);
}

function storageClient() {
  const client = supa.getClient();
  if (!client) {
    throw new EditorialError("편집 콘텐츠 저장소가 설정되지 않았습니다.", {
      code: "EDITORIAL_STORAGE_UNAVAILABLE",
      status: 503,
    });
  }
  return client;
}

function dbError(context, error) {
  if (error instanceof EditorialError) return error;
  if (isSchemaMissingError(error)) {
    const taxonomySchema = /editorial_taxonomies|reorder_editorial_taxonomies|delete_editorial_taxonomy_safely/i.test(
      String(error && error.message || error || ""),
    );
    return new EditorialError(
      taxonomySchema
        ? "편집 분류 데이터베이스가 아직 준비되지 않았습니다. 20260715_add_editorial_taxonomies.sql 마이그레이션을 적용하세요."
        : "편집 플랫폼 데이터베이스가 아직 준비되지 않았습니다. 20260714_add_editorial_platform.sql 마이그레이션을 적용하세요.",
      {
        code: taxonomySchema ? "EDITORIAL_TAXONOMY_SCHEMA_MISSING" : "EDITORIAL_SCHEMA_MISSING",
        status: 503,
        cause: error,
      },
    );
  }
  if (error && error.code === "23505") {
    const taxonomyConflict = /editorial_taxonom/i.test(
      `${error.message || ""} ${error.details || ""} ${error.hint || ""}`,
    );
    return new EditorialError(taxonomyConflict ? "같은 종류에 이미 사용 중인 분류 이름 또는 slug입니다." : "이미 사용 중인 주소(slug)입니다.", {
      code: taxonomyConflict ? "EDITORIAL_TAXONOMY_CONFLICT" : "EDITORIAL_SLUG_CONFLICT",
      status: 409,
      cause: error,
    });
  }
  return new EditorialError(`${context} 처리 중 오류가 발생했습니다.`, {
    code: "EDITORIAL_DATABASE_ERROR",
    status: 500,
    cause: error,
  });
}

function throwIfDbError(context, error) {
  if (error) throw dbError(context, error);
}

function requiredText(value, field, max) {
  const text = String(value == null ? "" : value).trim();
  if (!text) {
    throw new EditorialError(`${field}을(를) 입력하세요.`, {
      code: "EDITORIAL_VALIDATION_ERROR",
      status: 400,
    });
  }
  if (Array.from(text).length > max) {
    throw new EditorialError(`${field}은(는) ${max}자 이하여야 합니다.`, {
      code: "EDITORIAL_VALIDATION_ERROR",
      status: 400,
    });
  }
  return text;
}

function optionalText(value, max) {
  const text = String(value == null ? "" : value).trim();
  if (Array.from(text).length > max) {
    throw new EditorialError(`입력값은 ${max}자 이하여야 합니다.`, {
      code: "EDITORIAL_VALIDATION_ERROR",
      status: 400,
    });
  }
  return text;
}

function normalizePostKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  return kind === "developer_note" ? "developer" : kind;
}

function normalizeSlug(value, fallback = "") {
  let slug = String(value || fallback || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 120)
    .replace(/-+$/g, "");
  if (!slug) slug = `post-${Date.now().toString(36)}`;
  return slug;
}

function normalizeTags(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  const seen = new Set();
  const tags = [];
  for (const item of source) {
    const tag = String(item || "").trim().replace(/^#+/, "").slice(0, 30);
    const key = tag.toLocaleLowerCase("ko-KR");
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 12) break;
  }
  return tags;
}

function taxonomyValidation(message) {
  return new EditorialError(message, {
    code: "EDITORIAL_TAXONOMY_VALIDATION_ERROR",
    status: 400,
  });
}

function normalizeTaxonomyType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (type === "tag" || type === "tags") return "topic";
  return type;
}

function normalizeTaxonomyName(value) {
  const name = String(value == null ? "" : value).normalize("NFKC").trim();
  if (!name) throw taxonomyValidation("분류 이름을 입력하세요.");
  if (Array.from(name).length > 60) throw taxonomyValidation("분류 이름은 60자 이하여야 합니다.");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw taxonomyValidation("분류 이름에 제어 문자를 사용할 수 없습니다.");
  return name;
}

function normalizeTaxonomySlug(value, fallbackName = "") {
  const explicit = value !== undefined && value !== null && String(value).trim() !== "";
  const source = String(explicit ? value : fallbackName).normalize("NFKC").trim().toLocaleLowerCase("ko-KR");
  const slug = explicit
    ? source
    : source.replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  if (!slug || !/^[\p{Letter}\p{Number}]+(?:-[\p{Letter}\p{Number}]+)*$/u.test(slug)) {
    throw taxonomyValidation("분류 slug는 글자·숫자와 단일 하이픈만 사용할 수 있습니다.");
  }
  if (Array.from(slug).length > 80) throw taxonomyValidation("분류 slug는 80자 이하여야 합니다.");
  return slug;
}

function normalizeSortOrder(value) {
  if (typeof value === "string" && !/^-?\d+$/.test(value.trim())) {
    throw taxonomyValidation("정렬 순서는 정수여야 합니다.");
  }
  const order = Number(value);
  if (!Number.isInteger(order) || order < -100000 || order > 100000) {
    throw taxonomyValidation("정렬 순서는 -100000부터 100000 사이의 정수여야 합니다.");
  }
  return order;
}

function normalizeTaxonomyInput(input, { partial = false } = {}) {
  const source = input || {};
  const result = {};
  if (!partial || source.kind !== undefined) {
    const kind = normalizePostKind(source.kind);
    if (!POST_KINDS.has(kind)) throw taxonomyValidation("분류 kind는 developer 또는 resource여야 합니다.");
    result.kind = kind;
  }
  if (!partial || source.type !== undefined) {
    const type = normalizeTaxonomyType(source.type);
    if (!TAXONOMY_TYPES.has(type)) throw taxonomyValidation("분류 type은 category 또는 topic이어야 합니다.");
    result.type = type;
  }
  if (!partial || source.name !== undefined) result.name = normalizeTaxonomyName(source.name);
  if (!partial || source.slug !== undefined) {
    result.slug = normalizeTaxonomySlug(source.slug, result.name || source.name);
  }
  if (source.sortOrder !== undefined || source.sort_order !== undefined || !partial) {
    const raw = source.sortOrder !== undefined ? source.sortOrder : source.sort_order;
    result.sort_order = raw === undefined ? 0 : normalizeSortOrder(raw);
  }
  if (source.isActive !== undefined || source.is_active !== undefined || !partial) {
    const raw = source.isActive !== undefined ? source.isActive : source.is_active;
    if (raw !== undefined && typeof raw !== "boolean") throw taxonomyValidation("활성 상태는 boolean이어야 합니다.");
    result.is_active = raw === undefined ? true : raw;
  }
  return result;
}

function normalizeTaxonomyReorder(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 200) {
    throw taxonomyValidation("정렬 항목은 1개 이상 200개 이하여야 합니다.");
  }
  const seen = new Set();
  return items.map((item) => {
    const id = String(item && item.id || "").trim();
    if (!USER_ID_RE.test(id)) throw taxonomyValidation("정렬 항목에 올바르지 않은 ID가 있습니다.");
    if (seen.has(id)) throw taxonomyValidation("같은 분류를 정렬 목록에 중복으로 넣을 수 없습니다.");
    seen.add(id);
    const raw = item && (item.sortOrder !== undefined ? item.sortOrder : item.sort_order);
    return { id, sort_order: normalizeSortOrder(raw) };
  });
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);?/g, (_m, n) => String.fromCodePoint(Math.min(Number(n) || 0, 0x10ffff)))
    .replace(/&#x([0-9a-f]+);?/gi, (_m, n) => String.fromCodePoint(Math.min(parseInt(n, 16) || 0, 0x10ffff)))
    .replace(/&colon;?/gi, ":")
    .replace(/&tab;?/gi, "\t")
    .replace(/&newline;?/gi, "\n")
    .replace(/&amp;?/gi, "&");
}

function escapeAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeUrl(value, { image = false, avatar = false } = {}) {
  const raw = decodeHtmlEntities(value).trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const compact = raw.replace(/[\s\u00a0]+/g, "").toLowerCase();
  if (/^(?:javascript|vbscript|data|file|blob):/.test(compact)) return null;
  if (raw.startsWith("#") && !image && !avatar) return raw.slice(0, 160);
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw.slice(0, 1000);
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:") return parsed.toString().slice(0, 1000);
    if (!image && !avatar && parsed.protocol === "mailto:") return parsed.toString().slice(0, 1000);
  } catch (_) {
    return null;
  }
  return null;
}

function sanitizeStyle(value) {
  const allowedFonts = new Set([
    "pretendard", "nanum gothic", "nanum myeongjo", "noto sans kr", "noto serif kr",
    "arial", "helvetica", "georgia", "times new roman", "monospace", "sans-serif", "serif",
  ]);
  const declarations = [];
  for (const part of String(value || "").split(";")) {
    const index = part.indexOf(":");
    if (index < 1) continue;
    const property = part.slice(0, index).trim().toLowerCase();
    let val = part.slice(index + 1).trim();
    if (!val || /url\s*\(|expression\s*\(|@import|\\|[<>]/i.test(val)) continue;
    if (property === "text-align" && /^(left|center|right|justify)$/.test(val)) {
      declarations.push(`${property}:${val}`);
    } else if (property === "font-weight" && /^(normal|bold|[1-9]00)$/.test(val)) {
      declarations.push(`${property}:${val}`);
    } else if (property === "font-style" && /^(normal|italic)$/.test(val)) {
      declarations.push(`${property}:${val}`);
    } else if (property === "text-decoration" && /^(none|underline|line-through)$/.test(val)) {
      declarations.push(`${property}:${val}`);
    } else if (property === "font-size" && /^(?:1[0-9]|2[0-8])px$/.test(val)) {
      declarations.push(`${property}:${val}`);
    } else if ((property === "color" || property === "background-color") &&
      /^(?:#[0-9a-f]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i.test(val)) {
      declarations.push(`${property}:${val}`);
    } else if (property === "font-family") {
      val = val.replace(/["']/g, "").trim().toLowerCase();
      if (allowedFonts.has(val)) declarations.push(`${property}:${val}`);
    } else if (property === "width" && /^(?:100|[1-9]?\d)%$/.test(val)) {
      declarations.push(`${property}:${val}`);
    }
  }
  return declarations.slice(0, 8).join(";");
}

const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code",
  "strong", "b", "em", "i", "u", "s", "mark", "small", "sub", "sup", "span", "div",
  "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "figure",
  "figcaption", "a", "img",
]);
const VOID_TAGS = new Set(["br", "hr", "img"]);
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "svg", "math", "form", "button", "input",
  "textarea", "select", "option", "template", "noscript", "meta", "link", "base", "audio", "video",
]);
const GLOBAL_ATTRS = new Set(["title", "style"]);
const TAG_ATTRS = {
  a: new Set(["href", "target", "rel", "title"]),
  img: new Set(["src", "alt", "title", "width", "height", "loading", "style"]),
  ol: new Set(["start"]),
  li: new Set(["value"]),
  th: new Set(["colspan", "rowspan", "scope", "style"]),
  td: new Set(["colspan", "rowspan", "style"]),
  p: new Set(["style"]),
  div: new Set(["style"]),
  span: new Set(["style"]),
  h1: new Set(["style"]), h2: new Set(["style"]), h3: new Set(["style"]),
  h4: new Set(["style"]), h5: new Set(["style"]), h6: new Set(["style"]),
};

function readHtmlToken(html, start) {
  if (html.startsWith("<!--", start)) {
    const end = html.indexOf("-->", start + 4);
    return { raw: html.slice(start, end < 0 ? html.length : end + 3), end: end < 0 ? html.length : end + 3 };
  }
  let quote = null;
  for (let i = start + 1; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return { raw: html.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

function parseAttributes(source) {
  const attrs = [];
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(source))) {
    attrs.push({ name: match[1].toLowerCase(), value: match[2] ?? match[3] ?? match[4] ?? "" });
  }
  return attrs;
}

function sanitizeAttribute(tag, name, value) {
  const allowed = TAG_ATTRS[tag] || new Set();
  if (!GLOBAL_ATTRS.has(name) && !allowed.has(name)) return null;
  if (name.startsWith("on") || name === "srcdoc") return null;
  if (name === "style") {
    const style = sanitizeStyle(value);
    return style ? style : null;
  }
  if (name === "href" || name === "src") return safeUrl(value, { image: name === "src" });
  if (name === "target") return value === "_blank" ? "_blank" : null;
  if (name === "rel") return "noopener noreferrer nofollow";
  if (["width", "height", "colspan", "rowspan", "start", "value"].includes(name)) {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n > 0 && n <= (name === "width" || name === "height" ? 2400 : 100)
      ? String(n)
      : null;
  }
  if (name === "scope") return /^(row|col|rowgroup|colgroup)$/.test(value) ? value : null;
  if (name === "loading") return value === "eager" ? "eager" : "lazy";
  return String(value).slice(0, name === "alt" || name === "title" ? 300 : 160);
}

function sanitizeRichHtml(input) {
  const html = String(input || "").slice(0, 300000);
  let output = "";
  let cursor = 0;
  const dropStack = [];
  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open < 0) {
      if (dropStack.length === 0) output += html.slice(cursor);
      break;
    }
    if (dropStack.length === 0) output += html.slice(cursor, open);
    const token = readHtmlToken(html, open);
    if (!token) {
      if (dropStack.length === 0) output += "&lt;";
      cursor = open + 1;
      continue;
    }
    cursor = token.end;
    if (token.raw.startsWith("<!--") || /^<!|^<\?/i.test(token.raw)) continue;
    const match = token.raw.match(/^<\s*(\/?)\s*([a-z0-9:-]+)([\s\S]*?)\/?\s*>$/i);
    if (!match) continue;
    const closing = !!match[1];
    const tag = match[2].toLowerCase();

    if (dropStack.length) {
      if (!closing && DROP_WITH_CONTENT.has(tag) && !/\/\s*>$/.test(token.raw)) dropStack.push(tag);
      else if (closing && tag === dropStack[dropStack.length - 1]) dropStack.pop();
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing && !/\/\s*>$/.test(token.raw)) dropStack.push(tag);
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (closing) {
      if (!VOID_TAGS.has(tag)) output += `</${tag}>`;
      continue;
    }
    const rendered = [];
    let hasRel = false;
    let opensBlank = false;
    for (const attr of parseAttributes(match[3] || "")) {
      const clean = sanitizeAttribute(tag, attr.name, attr.value);
      if (clean == null) continue;
      if (attr.name === "rel") hasRel = true;
      if (attr.name === "target" && clean === "_blank") opensBlank = true;
      rendered.push(`${attr.name}="${escapeAttribute(clean)}"`);
    }
    if (tag === "a" && opensBlank && !hasRel) rendered.push('rel="noopener noreferrer nofollow"');
    if (tag === "img" && !rendered.some((x) => x.startsWith('loading="'))) rendered.push('loading="lazy"');
    output += `<${tag}${rendered.length ? ` ${rendered.join(" ")}` : ""}>`;
  }
  return output.trim();
}

function normalizeAvatarUrl(value) {
  if (value == null || String(value).trim() === "") return null;
  const url = safeUrl(value, { image: true, avatar: true });
  if (!url) {
    throw new EditorialError("프로필 이미지는 HTTPS 또는 Quilo 내부 파일 주소만 사용할 수 있습니다.", {
      code: "EDITORIAL_INVALID_AVATAR_URL",
      status: 400,
    });
  }
  return url;
}

function normalizePostInput(input, { partial = false } = {}) {
  const source = input || {};
  const result = {};
  if (!partial || source.kind !== undefined) {
    const kind = normalizePostKind(source.kind);
    if (!POST_KINDS.has(kind)) throw new EditorialError("올바른 글 종류가 아닙니다.", { code: "EDITORIAL_VALIDATION_ERROR" });
    result.kind = kind;
  }
  if (!partial || source.title !== undefined) result.title = requiredText(source.title, "제목", 180);
  if (source.slug !== undefined || !partial) result.slug = normalizeSlug(source.slug, result.title || source.title);
  if (source.excerpt !== undefined || !partial) result.excerpt = optionalText(source.excerpt, 600);
  if (source.richHtml !== undefined || source.rich_html !== undefined || !partial) {
    const raw = source.richHtml !== undefined ? source.richHtml : source.rich_html;
    result.rich_html = sanitizeRichHtml(raw);
  }
  if (source.coverImage !== undefined || source.cover_image !== undefined || !partial) {
    const raw = source.coverImage !== undefined ? source.coverImage : source.cover_image;
    result.cover_image = raw ? normalizeAvatarUrl(raw) : null;
  }
  if (source.category !== undefined || !partial) result.category = optionalText(source.category, 60);
  if (source.tags !== undefined || !partial) result.tags = normalizeTags(source.tags);
  if (source.status !== undefined || !partial) {
    const status = String(source.status || "draft");
    if (!POST_STATUSES.has(status)) throw new EditorialError("올바른 공개 상태가 아닙니다.", { code: "EDITORIAL_VALIDATION_ERROR" });
    result.status = status;
    if (status === "published") result.published_at = new Date().toISOString();
    else result.published_at = null;
  }
  return result;
}

function roleShape(row) {
  return row && {
    id: row.id,
    name: row.name || "",
    isAdmin: !!row.is_admin,
    isStaff: !!row.is_staff,
    isDeveloper: !!row.is_developer,
    avatarUrl: row.avatar_url || null,
    profileBio: row.profile_bio || "",
  };
}

function canWriteKind(roles, kind) {
  kind = normalizePostKind(kind);
  if (!roles || !POST_KINDS.has(kind)) return false;
  if (roles.isAdmin || roles.is_admin) return true;
  if (kind === "developer") return !!(roles.isDeveloper || roles.is_developer);
  return !!(roles.isStaff || roles.is_staff);
}

function canManageRequests(roles) {
  return !!roles && !!(roles.isAdmin || roles.is_admin || roles.isStaff || roles.is_staff);
}

async function getUserRoles(userId) {
  try {
    const client = storageClient();
    const { data, error } = await client
      .from("users")
      .select("id, name, is_admin, is_staff, is_developer, avatar_url, profile_bio")
      .eq("id", userId)
      .maybeSingle();
    throwIfDbError("사용자 권한 조회", error);
    return roleShape(data);
  } catch (error) {
    throw dbError("사용자 권한 조회", error);
  }
}

async function listRoleUsers({ limit = 250 } = {}) {
  try {
    const client = storageClient();
    const { data, error } = await client
      .from("users")
      .select("id, name, username, is_admin, is_staff, is_developer, avatar_url, profile_bio, created_at")
      .order("created_at", { ascending: true })
      .limit(Math.min(Math.max(Number(limit) || 250, 1), 500));
    throwIfDbError("역할 목록 조회", error);
    return (data || []).map((row) => ({
      ...roleShape(row),
      username: row.username || "",
      createdAt: row.created_at,
    }));
  } catch (error) {
    throw dbError("역할 목록 조회", error);
  }
}

async function updateUserRoles(userId, patch) {
  const update = {};
  if (patch && patch.isStaff !== undefined) update.is_staff = !!patch.isStaff;
  if (patch && patch.isDeveloper !== undefined) update.is_developer = !!patch.isDeveloper;
  if (!Object.keys(update).length) {
    throw new EditorialError("변경할 역할을 지정하세요.", { code: "EDITORIAL_VALIDATION_ERROR" });
  }
  try {
    const client = storageClient();
    const { data, error } = await client
      .from("users")
      .update(update)
      .eq("id", userId)
      .select("id, name, is_admin, is_staff, is_developer, avatar_url, profile_bio")
      .maybeSingle();
    throwIfDbError("역할 변경", error);
    if (!data) throw new EditorialError("사용자를 찾을 수 없습니다.", { code: "EDITORIAL_USER_NOT_FOUND", status: 404 });
    return roleShape(data);
  } catch (error) {
    throw dbError("역할 변경", error);
  }
}

async function updateProfile(userId, patch) {
  const update = {};
  let removeStoredAvatar = false;
  if (patch && patch.avatarUrl !== undefined) {
    // 프로필 이미지는 서버가 실제 픽셀을 검증하고 512px WebP로 변환한 업로드만
    // 허용한다. PATCH는 삭제(null) 용도이며 외부 추적 이미지 URL 주입을 받지 않는다.
    if (patch.avatarUrl !== null && String(patch.avatarUrl).trim() !== "") {
      throw new EditorialError("프로필 이미지는 파일 업로드로만 설정할 수 있습니다.", {
        code: "EDITORIAL_INVALID_AVATAR_URL",
        status: 400,
      });
    }
    update.avatar_url = null;
    removeStoredAvatar = true;
  }
  if (patch && patch.profileBio !== undefined) update.profile_bio = optionalText(patch.profileBio, 500);
  if (!Object.keys(update).length) throw new EditorialError("변경할 프로필 정보를 입력하세요.", { code: "EDITORIAL_VALIDATION_ERROR" });
  try {
    const client = storageClient();
    let oldAvatarUrl = null;
    if (removeStoredAvatar) {
      const { data: current, error: currentError } = await client.from("users")
        .select("avatar_url").eq("id", userId).maybeSingle();
      throwIfDbError("프로필 조회", currentError);
      oldAvatarUrl = current && current.avatar_url || null;
    }
    const { data, error } = await client.from("users").update(update).eq("id", userId)
      .select("id, name, is_admin, is_staff, is_developer, avatar_url, profile_bio").maybeSingle();
    throwIfDbError("프로필 변경", error);
    if (!data) throw new EditorialError("사용자를 찾을 수 없습니다.", { code: "EDITORIAL_USER_NOT_FOUND", status: 404 });
    const oldPath = avatarObjectPathFromUrl(oldAvatarUrl, userId);
    const bucket = oldPath && client.storage && client.storage.from(AVATAR_BUCKET);
    if (oldPath && bucket && typeof bucket.remove === "function") {
      await bucket.remove([oldPath]).catch((cleanupError) => {
        console.warn("[editorial] removed avatar cleanup failed:", cleanupError && cleanupError.message || cleanupError);
      });
    }
    return roleShape(data);
  } catch (error) {
    throw dbError("프로필 변경", error);
  }
}

const AVATAR_FORMATS = new Map([
  ["image/jpeg", { extensions: new Set([".jpg", ".jpeg"]), sharpFormat: "jpeg" }],
  ["image/png", { extensions: new Set([".png"]), sharpFormat: "png" }],
  ["image/webp", { extensions: new Set([".webp"]), sharpFormat: "webp" }],
  ["image/gif", { extensions: new Set([".gif"]), sharpFormat: "gif" }],
]);

function avatarHeaderMatches(buffer, mimeType) {
  if (mimeType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === "image/png") return buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mimeType === "image/gif") return /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii"));
  if (mimeType === "image/webp") {
    return buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

function validateAvatarInput(file) {
  const buffer = file && Buffer.isBuffer(file.buffer) ? file.buffer : null;
  const size = Number(file && (file.size || (buffer && buffer.length))) || 0;
  if (!buffer || !size || size !== buffer.length) {
    throw new EditorialError("프로필 이미지 파일을 읽을 수 없습니다.", {
      code: "EDITORIAL_INVALID_AVATAR",
      status: 400,
    });
  }
  if (size > MAX_AVATAR_INPUT_BYTES) {
    throw new EditorialError("프로필 이미지는 5MB 이하여야 합니다.", {
      code: "EDITORIAL_AVATAR_TOO_LARGE",
      status: 413,
    });
  }
  const filename = cleanFilename(file.originalname || file.filename);
  const extension = path.extname(filename).toLowerCase();
  const mimeType = String(file.mimetype || "").toLowerCase().split(";", 1)[0].trim();
  const expected = AVATAR_FORMATS.get(mimeType);
  if (!expected || !expected.extensions.has(extension) || !avatarHeaderMatches(buffer, mimeType)) {
    throw new EditorialError("프로필 사진은 JPG, PNG, WebP 또는 GIF 이미지만 사용할 수 있습니다.", {
      code: "EDITORIAL_INVALID_AVATAR_MIME",
      status: 415,
    });
  }
  return { buffer, sizeBytes: size, filename, mimeType, sharpFormat: expected.sharpFormat };
}

async function prepareAvatarImage(file) {
  const input = validateAvatarInput(file);
  let metadata;
  try {
    metadata = await sharp(input.buffer, {
      failOn: "error",
      limitInputPixels: 40_000_000,
      animated: false,
    }).metadata();
  } catch (error) {
    throw new EditorialError("손상되었거나 처리할 수 없는 프로필 이미지입니다.", {
      code: "EDITORIAL_INVALID_AVATAR_DATA",
      status: 415,
      cause: error,
    });
  }
  if (metadata.format !== input.sharpFormat || !metadata.width || !metadata.height ||
      metadata.width * metadata.height > 40_000_000) {
    throw new EditorialError("파일 내용과 프로필 이미지 형식이 일치하지 않습니다.", {
      code: "EDITORIAL_INVALID_AVATAR_DATA",
      status: 415,
    });
  }

  let output;
  try {
    for (const quality of [86, 72, 56]) {
      output = await sharp(input.buffer, {
        failOn: "error",
        limitInputPixels: 40_000_000,
        animated: false,
      })
        .rotate()
        .resize(512, 512, { fit: "cover", position: "centre" })
        .webp({ quality, effort: 5 })
        .toBuffer();
      if (output.length <= MAX_AVATAR_OUTPUT_BYTES) break;
    }
  } catch (error) {
    throw new EditorialError("프로필 이미지 픽셀 데이터를 처리하지 못했습니다.", {
      code: "EDITORIAL_INVALID_AVATAR_DATA",
      status: 415,
      cause: error,
    });
  }
  if (!output || output.length > MAX_AVATAR_OUTPUT_BYTES) {
    throw new EditorialError("최적화한 프로필 이미지가 2MB를 초과합니다.", {
      code: "EDITORIAL_AVATAR_OUTPUT_TOO_LARGE",
      status: 413,
    });
  }
  return { buffer: output, mimeType: "image/webp", width: 512, height: 512 };
}

function avatarObjectPathFromUrl(value, userId) {
  if (!value || !USER_ID_RE.test(String(userId || ""))) return null;
  try {
    const parsed = new URL(String(value));
    const marker = `/storage/v1/object/public/${AVATAR_BUCKET}/`;
    const index = parsed.pathname.indexOf(marker);
    if (index < 0) return null;
    const objectPath = decodeURIComponent(parsed.pathname.slice(index + marker.length));
    return objectPath.startsWith(`${userId}/`) && !objectPath.includes("..") ? objectPath : null;
  } catch (_) {
    return null;
  }
}

function avatarStorageError(error) {
  const message = String(error && error.message || error || "");
  if (/bucket.*not found|not found.*bucket|profile-images|storage.*not (?:configured|available)/i.test(message)) {
    return new EditorialError(
      "프로필 이미지 저장소가 준비되지 않았습니다. profile-images 버킷 마이그레이션을 적용하세요.",
      { code: "EDITORIAL_AVATAR_STORAGE_UNAVAILABLE", status: 503, cause: error },
    );
  }
  return new EditorialError("프로필 이미지를 저장하지 못했습니다.", {
    code: "EDITORIAL_AVATAR_STORAGE_ERROR",
    status: 500,
    cause: error,
  });
}

async function saveAvatarImage(userId, file) {
  if (!USER_ID_RE.test(String(userId || ""))) {
    throw new EditorialError("올바른 사용자 ID가 아닙니다.", {
      code: "EDITORIAL_INVALID_ID",
      status: 400,
    });
  }
  const image = await prepareAvatarImage(file);
  const client = storageClient();
  let oldAvatarUrl = null;
  try {
    const { data: oldUser, error: oldUserError } = await client.from("users")
      .select("avatar_url").eq("id", userId).maybeSingle();
    throwIfDbError("프로필 조회", oldUserError);
    if (!oldUser) {
      throw new EditorialError("사용자를 찾을 수 없습니다.", {
        code: "EDITORIAL_USER_NOT_FOUND",
        status: 404,
      });
    }
    oldAvatarUrl = oldUser.avatar_url || null;
  } catch (error) {
    throw dbError("프로필 조회", error);
  }

  const objectPath = `${userId}/avatar-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.webp`;
  const bucket = client.storage && client.storage.from(AVATAR_BUCKET);
  if (!bucket || typeof bucket.upload !== "function" || typeof bucket.getPublicUrl !== "function" ||
      typeof bucket.remove !== "function") {
    throw avatarStorageError(new Error("Storage not configured"));
  }
  let uploadError;
  try {
    ({ error: uploadError } = await bucket.upload(objectPath, image.buffer, {
      contentType: image.mimeType,
      cacheControl: "3600",
      upsert: false,
    }));
  } catch (error) {
    throw avatarStorageError(error);
  }
  if (uploadError) throw avatarStorageError(uploadError);

  const publicResult = bucket.getPublicUrl(objectPath);
  const publicUrl = publicResult && publicResult.data && publicResult.data.publicUrl;
  if (!publicUrl) {
    await bucket.remove([objectPath]).catch(() => null);
    throw avatarStorageError(new Error("profile-images public URL unavailable"));
  }

  let profile;
  try {
    const { data, error } = await client.from("users").update({ avatar_url: publicUrl }).eq("id", userId)
      .select("id, name, is_admin, is_staff, is_developer, avatar_url, profile_bio").maybeSingle();
    throwIfDbError("프로필 이미지 변경", error);
    if (!data) throw new EditorialError("사용자를 찾을 수 없습니다.", { code: "EDITORIAL_USER_NOT_FOUND", status: 404 });
    profile = roleShape(data);
  } catch (error) {
    await bucket.remove([objectPath]).catch(() => null);
    throw dbError("프로필 이미지 변경", error);
  }

  const oldPath = avatarObjectPathFromUrl(oldAvatarUrl, userId);
  if (oldPath && oldPath !== objectPath) {
    await bucket.remove([oldPath]).catch((error) => {
      console.warn("[editorial] old avatar cleanup failed:", error && error.message || error);
    });
  }
  return profile;
}

const TAXONOMY_SELECT =
  "id, kind, type, slug, name, sort_order, is_active, created_by, updated_by, created_at, updated_at";

function taxonomyShape(row) {
  if (!row) return null;
  const type = normalizeTaxonomyType(row.type);
  return {
    id: row.id,
    kind: normalizePostKind(row.kind),
    type,
    slug: row.slug,
    name: row.name,
    // 기존 editorial_posts의 문자열 필드에 그대로 저장할 값과 대상 필드를 명시한다.
    value: row.name,
    postField: type === "category" ? "category" : "tags",
    sortOrder: Number(row.sort_order) || 0,
    isActive: !!row.is_active,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function sortTaxonomies(items) {
  const kindOrder = { developer: 0, resource: 1 };
  const typeOrder = { category: 0, topic: 1 };
  return [...items].sort((a, b) =>
    (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9) ||
    (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) ||
    a.sortOrder - b.sortOrder ||
    String(a.name).localeCompare(String(b.name), "ko"),
  );
}

function groupTaxonomies(items) {
  const groups = {
    developer: { categories: [], topics: [] },
    resource: { categories: [], topics: [] },
  };
  for (const item of sortTaxonomies(items || [])) {
    if (!groups[item.kind]) continue;
    groups[item.kind][item.type === "category" ? "categories" : "topics"].push(item);
  }
  return groups;
}

function actorIdForDb(value) {
  const id = String(value || "").trim();
  return USER_ID_RE.test(id) ? id : null;
}

async function listTaxonomies({ kind = null, type = null, activeOnly = true } = {}) {
  if (kind != null && kind !== "") {
    kind = normalizePostKind(kind);
    if (!POST_KINDS.has(kind)) throw taxonomyValidation("분류 kind는 developer 또는 resource여야 합니다.");
  } else {
    kind = null;
  }
  if (type != null && type !== "") {
    type = normalizeTaxonomyType(type);
    if (!TAXONOMY_TYPES.has(type)) throw taxonomyValidation("분류 type은 category 또는 topic이어야 합니다.");
  } else {
    type = null;
  }
  if (![true, false, null].includes(activeOnly)) throw taxonomyValidation("활성 상태 필터가 올바르지 않습니다.");

  try {
    const client = storageClient();
    let query = client.from("editorial_taxonomies").select(TAXONOMY_SELECT)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });
    if (kind) query = query.eq("kind", kind);
    if (type) query = query.eq("type", type);
    if (activeOnly !== null) query = query.eq("is_active", activeOnly);
    const { data, error } = await query;
    throwIfDbError("분류 목록 조회", error);
    return sortTaxonomies((data || []).map(taxonomyShape));
  } catch (error) {
    throw dbError("분류 목록 조회", error);
  }
}

async function assertPostTaxonomies(kind, category, tags) {
  kind = normalizePostKind(kind);
  if (!POST_KINDS.has(kind)) {
    throw new EditorialError("올바른 글 종류가 아닙니다.", {
      code: "EDITORIAL_VALIDATION_ERROR",
      status: 400,
    });
  }
  const rows = await listTaxonomies({ kind, activeOnly: true });
  const categoryValues = new Set(rows.filter((row) => row.type === "category").map((row) => row.name));
  const topicValues = new Set(rows.filter((row) => row.type === "topic").map((row) => row.name));
  const normalizedCategory = String(category || "").trim();
  const normalizedTags = normalizeTags(tags);
  if (!normalizedCategory || !categoryValues.has(normalizedCategory)) {
    throw new EditorialError("관리자가 활성화한 분류를 선택하세요.", {
      code: "EDITORIAL_TAXONOMY_INVALID_CATEGORY",
      status: 400,
    });
  }
  const invalidTopics = normalizedTags.filter((tag) => !topicValues.has(tag));
  if (invalidTopics.length) {
    throw new EditorialError(`활성화되지 않은 주제입니다: ${invalidTopics.join(", ")}`, {
      code: "EDITORIAL_TAXONOMY_INVALID_TOPIC",
      status: 400,
    });
  }
  return true;
}

async function getTaxonomyById(id) {
  try {
    const client = storageClient();
    const { data, error } = await client.from("editorial_taxonomies").select(TAXONOMY_SELECT)
      .eq("id", id).maybeSingle();
    throwIfDbError("분류 조회", error);
    return taxonomyShape(data);
  } catch (error) {
    throw dbError("분류 조회", error);
  }
}

async function createTaxonomy(input, actorId = null) {
  const values = normalizeTaxonomyInput(input);
  values.created_by = actorIdForDb(actorId);
  values.updated_by = actorIdForDb(actorId);
  try {
    const client = storageClient();
    const { data, error } = await client.from("editorial_taxonomies").insert(values)
      .select(TAXONOMY_SELECT).single();
    throwIfDbError("분류 등록", error);
    return taxonomyShape(data);
  } catch (error) {
    throw dbError("분류 등록", error);
  }
}

async function taxonomyUsageCount(taxonomy) {
  if (!taxonomy) return 0;
  try {
    const client = storageClient();
    let query = client.from("editorial_posts").select("id", { count: "exact", head: true })
      .eq("kind", taxonomy.kind);
    query = taxonomy.type === "category"
      ? query.eq("category", taxonomy.name)
      : query.contains("tags", [taxonomy.name]);
    const { count, error } = await query;
    throwIfDbError("분류 사용 여부 조회", error);
    return Math.max(Number(count) || 0, 0);
  } catch (error) {
    throw dbError("분류 사용 여부 조회", error);
  }
}

async function updateTaxonomy(id, input, actorId = null) {
  const existing = await getTaxonomyById(id);
  if (!existing) {
    throw new EditorialError("분류를 찾을 수 없습니다.", {
      code: "EDITORIAL_TAXONOMY_NOT_FOUND",
      status: 404,
    });
  }
  const values = normalizeTaxonomyInput(input, { partial: true });
  if (!Object.keys(values).length) throw taxonomyValidation("변경할 분류 정보를 입력하세요.");

  const identityChanged =
    (values.kind !== undefined && values.kind !== existing.kind) ||
    (values.type !== undefined && values.type !== existing.type) ||
    (values.name !== undefined && values.name !== existing.name);
  if (identityChanged) {
    const inUseCount = await taxonomyUsageCount(existing);
    if (inUseCount > 0) {
      throw new EditorialError(
        "게시글에서 사용 중인 분류의 kind, type 또는 이름은 바꿀 수 없습니다. 새 분류를 만들고 기존 항목을 비활성화하세요.",
        {
          code: "EDITORIAL_TAXONOMY_IN_USE",
          status: 409,
        },
      );
    }
  }
  values.updated_by = actorIdForDb(actorId);
  try {
    const client = storageClient();
    const { data, error } = await client.from("editorial_taxonomies").update(values).eq("id", id)
      .select(TAXONOMY_SELECT).maybeSingle();
    throwIfDbError("분류 수정", error);
    if (!data) {
      throw new EditorialError("분류를 찾을 수 없습니다.", {
        code: "EDITORIAL_TAXONOMY_NOT_FOUND",
        status: 404,
      });
    }
    return taxonomyShape(data);
  } catch (error) {
    throw dbError("분류 수정", error);
  }
}

async function reorderTaxonomies(items, actorId = null) {
  const normalized = normalizeTaxonomyReorder(items);
  try {
    const client = storageClient();
    const { data, error } = await client.rpc("reorder_editorial_taxonomies", {
      p_items: normalized,
      p_updated_by: actorIdForDb(actorId),
    });
    if (error && (error.code === "P0002" || /taxonomy_not_found/i.test(error.message || ""))) {
      throw new EditorialError("정렬할 분류 중 찾을 수 없는 항목이 있습니다.", {
        code: "EDITORIAL_TAXONOMY_NOT_FOUND",
        status: 404,
      });
    }
    if (error && (error.code === "22023" || /taxonomy_items_/i.test(error.message || ""))) {
      throw taxonomyValidation("정렬 요청이 올바르지 않습니다.");
    }
    throwIfDbError("분류 순서 변경", error);
    return sortTaxonomies((data || []).map(taxonomyShape));
  } catch (error) {
    throw dbError("분류 순서 변경", error);
  }
}

async function deleteTaxonomy(id, actorId = null) {
  try {
    const client = storageClient();
    const { data, error } = await client.rpc("delete_editorial_taxonomy_safely", {
      p_id: id,
      p_updated_by: actorIdForDb(actorId),
    });
    if (error && (error.code === "P0002" || /taxonomy_not_found/i.test(error.message || ""))) {
      throw new EditorialError("분류를 찾을 수 없습니다.", {
        code: "EDITORIAL_TAXONOMY_NOT_FOUND",
        status: 404,
      });
    }
    throwIfDbError("분류 삭제", error);
    if (!data || !data.taxonomy) {
      throw new EditorialError("분류 삭제 결과를 확인하지 못했습니다.", {
        code: "EDITORIAL_DATABASE_ERROR",
        status: 500,
      });
    }
    return {
      taxonomy: taxonomyShape(data.taxonomy),
      deleted: !!data.deleted,
      deactivated: !!data.deactivated,
      inUseCount: Math.max(Number(data.inUseCount ?? data.in_use_count) || 0, 0),
    };
  } catch (error) {
    throw dbError("분류 삭제", error);
  }
}

const POST_PUBLIC_SELECT = "id, kind, slug, title, excerpt, cover_image, category, tags, status, author_id, author_name, published_at, created_at, updated_at, author:users!editorial_posts_author_id_fkey(id,name,avatar_url,profile_bio,is_staff,is_developer)";
const POST_FULL_SELECT = `${POST_PUBLIC_SELECT}, rich_html`;

async function listPublishedPosts({ kind = null, category = null, tag = null, search = null, limit = 30, offset = 0 } = {}) {
  try {
    const client = storageClient();
    let query = client.from("editorial_posts").select(POST_PUBLIC_SELECT)
      .eq("status", "published").lte("published_at", new Date().toISOString())
      .order("published_at", { ascending: false })
      .range(Math.max(Number(offset) || 0, 0), Math.max(Number(offset) || 0, 0) + Math.min(Math.max(Number(limit) || 30, 1), 100) - 1);
    kind = normalizePostKind(kind);
    if (kind && POST_KINDS.has(kind)) query = query.eq("kind", kind);
    if (category) query = query.eq("category", String(category).slice(0, 60));
    if (tag) query = query.contains("tags", [String(tag).slice(0, 30)]);
    if (search) {
      const term = String(search).replace(/[%_,()]/g, " ").trim().slice(0, 80);
      if (term) query = query.or(`title.ilike.%${term}%,excerpt.ilike.%${term}%`);
    }
    const { data, error } = await query;
    throwIfDbError("글 목록 조회", error);
    return data || [];
  } catch (error) {
    throw dbError("글 목록 조회", error);
  }
}

async function getPublishedPostBySlug(slug) {
  try {
    const client = storageClient();
    const { data, error } = await client.from("editorial_posts").select(POST_FULL_SELECT)
      .ilike("slug", normalizeSlug(slug)).eq("status", "published")
      .lte("published_at", new Date().toISOString()).maybeSingle();
    throwIfDbError("글 조회", error);
    return data || null;
  } catch (error) {
    throw dbError("글 조회", error);
  }
}

async function getPostById(id) {
  try {
    const client = storageClient();
    const { data, error } = await client.from("editorial_posts").select(POST_FULL_SELECT).eq("id", id).maybeSingle();
    throwIfDbError("글 조회", error);
    return data || null;
  } catch (error) {
    throw dbError("글 조회", error);
  }
}

async function listOwnPosts(userId, { status = null, kind = null, limit = 100 } = {}) {
  try {
    const client = storageClient();
    let query = client.from("editorial_posts").select(POST_FULL_SELECT).eq("author_id", userId)
      .order("updated_at", { ascending: false }).limit(Math.min(Math.max(Number(limit) || 100, 1), 200));
    if (status && POST_STATUSES.has(status)) query = query.eq("status", status);
    kind = normalizePostKind(kind);
    if (kind && POST_KINDS.has(kind)) query = query.eq("kind", kind);
    const { data, error } = await query;
    throwIfDbError("내 글 조회", error);
    return data || [];
  } catch (error) {
    throw dbError("내 글 조회", error);
  }
}

async function createPost(user, input) {
  const values = normalizePostInput(input);
  await assertPostTaxonomies(values.kind, values.category, values.tags);
  try {
    const client = storageClient();
    const { data, error } = await client.from("editorial_posts").insert({
      ...values,
      author_id: user.id,
      author_name: String(user.name || "").slice(0, 100),
    }).select(POST_FULL_SELECT).single();
    throwIfDbError("글 등록", error);
    return data;
  } catch (error) {
    throw dbError("글 등록", error);
  }
}

async function updatePost(id, input, existing) {
  const values = normalizePostInput(input, { partial: true });
  if (!Object.keys(values).length) throw new EditorialError("변경할 글 내용을 입력하세요.", { code: "EDITORIAL_VALIDATION_ERROR" });
  await assertPostTaxonomies(
    values.kind !== undefined ? values.kind : existing && existing.kind,
    values.category !== undefined ? values.category : existing && existing.category,
    values.tags !== undefined ? values.tags : existing && existing.tags,
  );
  if (values.status === "published" && existing && existing.status === "published") {
    delete values.published_at;
  }
  try {
    const client = storageClient();
    const { data, error } = await client.from("editorial_posts").update(values).eq("id", id)
      .select(POST_FULL_SELECT).maybeSingle();
    throwIfDbError("글 수정", error);
    if (!data) throw new EditorialError("글을 찾을 수 없습니다.", { code: "EDITORIAL_POST_NOT_FOUND", status: 404 });
    return data;
  } catch (error) {
    throw dbError("글 수정", error);
  }
}

async function deletePost(id) {
  try {
    const client = storageClient();
    const { error } = await client.from("editorial_posts").delete().eq("id", id);
    throwIfDbError("글 삭제", error);
    return true;
  } catch (error) {
    throw dbError("글 삭제", error);
  }
}

const MIME_EXTENSIONS = new Map([
  ["image/jpeg", new Set([".jpg", ".jpeg"])], ["image/png", new Set([".png"])],
  ["image/gif", new Set([".gif"])], ["image/webp", new Set([".webp"])],
  ["application/pdf", new Set([".pdf"])], ["application/zip", new Set([".zip"])],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", new Set([".docx"])],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", new Set([".xlsx"])],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", new Set([".pptx"])],
  ["application/hwp+zip", new Set([".hwpx"])],
  ["application/vnd.ms-excel", new Set([".xls"])], ["application/x-hwp", new Set([".hwp"])],
  ["text/plain", new Set([".txt", ".md"])], ["text/markdown", new Set([".md"])],
  ["text/csv", new Set([".csv"])],
]);

function cleanFilename(value) {
  const raw = path.basename(String(value || "")).normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/:*?"<>|]/g, "-").trim();
  const filename = raw.slice(0, 180).replace(/[. ]+$/g, "");
  if (!filename || filename === "." || filename === "..") {
    throw new EditorialError("올바른 파일 이름이 아닙니다.", { code: "EDITORIAL_INVALID_ATTACHMENT", status: 400 });
  }
  return filename;
}

function hasMagic(buffer, mime) {
  if (["text/plain", "text/markdown", "text/csv"].includes(mime)) {
    return !buffer.includes(0) && buffer.subarray(0, 4096).toString("utf8").includes("\ufffd") === false;
  }
  if (mime === "image/jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === "image/png") return buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mime === "image/gif") return /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii"));
  if (mime === "image/webp") return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (mime === "application/pdf") return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (["application/vnd.ms-excel", "application/x-hwp"].includes(mime)) return buffer.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"));
  return buffer.subarray(0, 4).equals(Buffer.from("504b0304", "hex")) || buffer.subarray(0, 4).equals(Buffer.from("504b0506", "hex"));
}

function validateAttachment(file) {
  const buffer = file && Buffer.isBuffer(file.buffer) ? file.buffer : null;
  const size = Number(file && (file.size || (buffer && buffer.length))) || 0;
  if (!buffer || size < 1 || size !== buffer.length) throw new EditorialError("첨부 파일을 읽을 수 없습니다.", { code: "EDITORIAL_INVALID_ATTACHMENT", status: 400 });
  if (size > MAX_ATTACHMENT_BYTES) throw new EditorialError("첨부 파일은 8MB 이하여야 합니다.", { code: "EDITORIAL_ATTACHMENT_TOO_LARGE", status: 413 });
  const filename = cleanFilename(file.originalname || file.filename);
  const mimeType = String(file.mimetype || "").toLowerCase().split(";", 1)[0].trim();
  const extensions = MIME_EXTENSIONS.get(mimeType);
  const extension = path.extname(filename).toLowerCase();
  if (!extensions || !extensions.has(extension) || !hasMagic(buffer, mimeType)) {
    throw new EditorialError("허용되지 않거나 파일 내용과 형식이 일치하지 않는 첨부 파일입니다.", {
      code: "EDITORIAL_INVALID_ATTACHMENT_MIME",
      status: 415,
    });
  }
  return { filename, mimeType, sizeBytes: size, buffer };
}

async function createAttachment({ postId, userId, file }) {
  const clean = validateAttachment(file);
  try {
    const client = storageClient();
    const { data, error } = await client.from("editorial_attachments").insert({
      post_id: postId, uploaded_by: userId, filename: clean.filename,
      mime_type: clean.mimeType, size_bytes: clean.sizeBytes, data_base64: clean.buffer.toString("base64"),
    }).select("id, post_id, uploaded_by, filename, mime_type, size_bytes, created_at").single();
    throwIfDbError("첨부 파일 등록", error);
    return data;
  } catch (error) {
    throw dbError("첨부 파일 등록", error);
  }
}

async function getAttachment(id, { includeData = false } = {}) {
  try {
    const client = storageClient();
    const columns = `id, post_id, uploaded_by, filename, mime_type, size_bytes, created_at${includeData ? ", data_base64" : ""}, post:editorial_posts!editorial_attachments_post_id_fkey(id,status,author_id,published_at)`;
    const { data, error } = await client.from("editorial_attachments").select(columns).eq("id", id).maybeSingle();
    throwIfDbError("첨부 파일 조회", error);
    return data || null;
  } catch (error) {
    throw dbError("첨부 파일 조회", error);
  }
}

async function listAttachments(postId) {
  try {
    const client = storageClient();
    const { data, error } = await client.from("editorial_attachments")
      .select("id, post_id, uploaded_by, filename, mime_type, size_bytes, created_at")
      .eq("post_id", postId).order("created_at", { ascending: true });
    throwIfDbError("첨부 파일 목록 조회", error);
    return data || [];
  } catch (error) {
    throw dbError("첨부 파일 목록 조회", error);
  }
}

async function deleteAttachment(id) {
  try {
    const client = storageClient();
    const { error } = await client.from("editorial_attachments").delete().eq("id", id);
    throwIfDbError("첨부 파일 삭제", error);
    return true;
  } catch (error) {
    throw dbError("첨부 파일 삭제", error);
  }
}

async function createResourceRequest(user, input) {
  const row = {
    user_id: user.id,
    author_name: String(user.name || "").slice(0, 100),
    title: requiredText(input && input.title, "요청 제목", 180),
    details: optionalText(input && input.details, 5000),
    category: optionalText(input && input.category, 60),
  };
  try {
    const client = storageClient();
    const { data, error } = await client.from("resource_requests").insert(row)
      .select("id, author_name, title, details, category, status, created_at, updated_at").single();
    throwIfDbError("자료 요청 등록", error);
    return data;
  } catch (error) {
    throw dbError("자료 요청 등록", error);
  }
}

async function listResourceRequests({ manage = false, userId = null, status = null, limit = 100, offset = 0 } = {}) {
  if (!manage && !USER_ID_RE.test(String(userId || ""))) {
    throw new EditorialError("내 자료 요청을 조회하려면 로그인이 필요합니다.", {
      code: "EDITORIAL_AUTH_REQUIRED",
      status: 401,
    });
  }
  try {
    const client = storageClient();
    const columns = manage
      ? "id, user_id, author_name, title, details, category, status, staff_note, linked_post_id, handled_by, handled_at, created_at, updated_at"
      : "id, author_name, title, details, category, status, linked_post_id, created_at, updated_at";
    let query = client.from("resource_requests").select(columns).order("created_at", { ascending: false })
      .range(Math.max(Number(offset) || 0, 0), Math.max(Number(offset) || 0, 0) + Math.min(Math.max(Number(limit) || 100, 1), 200) - 1);
    if (!manage) query = query.eq("user_id", userId);
    if (status && REQUEST_STATUSES.has(status) && (manage || status !== "declined")) {
      query = query.eq("status", status);
    } else if (!manage) {
      query = query.neq("status", "declined");
    }
    const { data, error } = await query;
    throwIfDbError("자료 요청 목록 조회", error);
    return data || [];
  } catch (error) {
    throw dbError("자료 요청 목록 조회", error);
  }
}

async function updateResourceRequest(id, actorId, input) {
  const status = String(input && input.status || "");
  if (!REQUEST_STATUSES.has(status)) throw new EditorialError("올바른 요청 상태가 아닙니다.", { code: "EDITORIAL_VALIDATION_ERROR" });
  const update = {
    status,
    staff_note: optionalText(input && input.staffNote, 2000),
    handled_by: actorId,
    handled_at: new Date().toISOString(),
  };
  if (input && input.linkedPostId !== undefined) update.linked_post_id = input.linkedPostId || null;
  try {
    const client = storageClient();
    const { data, error } = await client.from("resource_requests").update(update).eq("id", id)
      .select("id, user_id, author_name, title, details, category, status, staff_note, linked_post_id, handled_by, handled_at, created_at, updated_at")
      .maybeSingle();
    throwIfDbError("자료 요청 상태 변경", error);
    if (!data) throw new EditorialError("자료 요청을 찾을 수 없습니다.", { code: "EDITORIAL_REQUEST_NOT_FOUND", status: 404 });
    return data;
  } catch (error) {
    throw dbError("자료 요청 상태 변경", error);
  }
}

module.exports = {
  EditorialError,
  MAX_ATTACHMENT_BYTES,
  MAX_AVATAR_INPUT_BYTES,
  MAX_AVATAR_OUTPUT_BYTES,
  POST_KINDS,
  POST_STATUSES,
  REQUEST_STATUSES,
  TAXONOMY_TYPES,
  isSchemaMissingError,
  dbError,
  safeUrl,
  sanitizeStyle,
  sanitizeRichHtml,
  normalizePostKind,
  normalizeSlug,
  normalizeTags,
  normalizeTaxonomyType,
  normalizeTaxonomyName,
  normalizeTaxonomySlug,
  normalizeTaxonomyInput,
  normalizeTaxonomyReorder,
  normalizeAvatarUrl,
  normalizePostInput,
  canWriteKind,
  canManageRequests,
  validateAttachment,
  getUserRoles,
  listRoleUsers,
  updateUserRoles,
  updateProfile,
  validateAvatarInput,
  prepareAvatarImage,
  avatarObjectPathFromUrl,
  saveAvatarImage,
  taxonomyShape,
  sortTaxonomies,
  groupTaxonomies,
  listTaxonomies,
  getTaxonomyById,
  createTaxonomy,
  taxonomyUsageCount,
  updateTaxonomy,
  reorderTaxonomies,
  deleteTaxonomy,
  assertPostTaxonomies,
  listPublishedPosts,
  getPublishedPostBySlug,
  getPostById,
  listOwnPosts,
  createPost,
  updatePost,
  deletePost,
  createAttachment,
  getAttachment,
  listAttachments,
  deleteAttachment,
  createResourceRequest,
  listResourceRequests,
  updateResourceRequest,
};
