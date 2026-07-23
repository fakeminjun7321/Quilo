"use strict";

(function initEditorialPlatform() {
  const API_ROOT = "/api/editorial";
  const page = document.body?.dataset.editorialPage || "";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const POSTS_PER_PAGE = 8;
  const BOOKMARK_KEY = "quilo.editorial.bookmarks.v1";
  const DEFAULT_TAXONOMIES = Object.freeze({
    developer: Object.freeze({
      category: Object.freeze(["Quilo 활용", "개발", "보고서 작성", "새 소식"]),
      topic: Object.freeze(["시작하기", "문서 엔진", "데이터 신뢰성", "API", "운영"]),
    }),
    resource: Object.freeze({
      category: Object.freeze(["화학", "물리", "보고서 양식", "학습 자료", "도구"]),
      topic: Object.freeze(["실험 데이터", "문서 템플릿", "참고 자료"]),
    }),
  });
  let taxonomyCatalogPromise = null;

  function svg(name) {
    const icons = {
      bookmark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4V3Z"></path></svg>',
      share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="2.5"></circle><circle cx="6" cy="12" r="2.5"></circle><circle cx="18" cy="19" r="2.5"></circle><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5"></path></svg>',
      image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><circle cx="8.5" cy="9" r="1.5"></circle><path d="m4 18 5-5 4 4 2-2 5 5"></path></svg>',
      file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h8l4 4v16H6V2Z"></path><path d="M14 2v5h5"></path></svg>',
      download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"></path></svg>',
      empty: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM8 9h8M8 13h5"></path></svg>',
    };
    return icons[name] || "";
  }

  function showToast(message, error = false) {
    const toast = $("#editorialToast");
    if (!toast) return;
    toast.textContent = String(message || "");
    toast.classList.toggle("is-error", error);
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 3600);
  }

  class EditorialApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.name = "EditorialApiError";
      this.status = status;
      this.code = code;
    }
  }

  async function api(path, options = {}) {
    const init = { credentials: "same-origin", cache: "no-store", ...options };
    if (init.body && !(init.body instanceof FormData) && typeof init.body !== "string") {
      init.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
      init.body = JSON.stringify(init.body);
    }
    const response = await fetch(`${API_ROOT}${path}`, init);
    const contentType = response.headers.get("content-type") || "";
    let body = null;
    if (contentType.includes("application/json")) body = await response.json().catch(() => null);
    else body = await response.text().catch(() => "");
    if (!response.ok) {
      const message = body && typeof body === "object" && (body.error || body.message)
        ? body.error || body.message
        : `요청을 처리하지 못했습니다. (${response.status})`;
      throw new EditorialApiError(message, response.status, body && body.code);
    }
    return body;
  }

  async function fetchJson(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body && (body.error || body.message) ? body.error || body.message : `요청을 처리하지 못했습니다. (${response.status})`;
      throw new EditorialApiError(message, response.status, body?.code);
    }
    return body;
  }

  function arrayFrom(payload, keys) {
    if (Array.isArray(payload)) return payload;
    for (const key of keys) {
      if (Array.isArray(payload?.[key])) return payload[key];
      if (Array.isArray(payload?.data?.[key])) return payload.data[key];
    }
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
  }

  function oneFrom(payload, keys) {
    if (!payload || typeof payload !== "object") return null;
    for (const key of keys) if (payload[key] && typeof payload[key] === "object") return payload[key];
    if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) return payload.data;
    return payload.id || payload.slug ? payload : null;
  }

  function cleanText(value, fallback = "") {
    return String(value == null ? fallback : value).trim();
  }

  function normalizeTags(value) {
    if (Array.isArray(value)) return value.map((tag) => cleanText(tag).replace(/^#+/, "")).filter(Boolean);
    return cleanText(value).split(",").map((tag) => tag.trim().replace(/^#+/, "")).filter(Boolean);
  }

  function taxonomyValue(row) {
    if (typeof row === "string") return cleanText(row);
    return cleanText(row?.name || row?.value || row?.label);
  }

  function normalizeTaxonomyRows(rows, kind, type) {
    const seen = new Set();
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => typeof row === "string" || !row?.kind || row.kind === kind)
      .filter((row) => typeof row === "string" || !row?.type || (row.type === "tag" ? "topic" : row.type) === type)
      .filter((row) => typeof row === "string" || row?.isActive !== false && row?.is_active !== false)
      .sort((a, b) => Number(a?.sortOrder ?? a?.sort_order ?? 0) - Number(b?.sortOrder ?? b?.sort_order ?? 0))
      .map(taxonomyValue)
      .filter((value) => {
        const key = value.toLocaleLowerCase("ko-KR");
        if (!value || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function fallbackTaxonomyCatalog() {
    return {
      source: "fallback",
      developer: { category: [...DEFAULT_TAXONOMIES.developer.category], topic: [...DEFAULT_TAXONOMIES.developer.topic] },
      resource: { category: [...DEFAULT_TAXONOMIES.resource.category], topic: [...DEFAULT_TAXONOMIES.resource.topic] },
    };
  }

  function normalizeTaxonomyCatalog(payload) {
    const fallback = fallbackTaxonomyCatalog();
    const all = arrayFrom(payload, ["taxonomies", "items"]);
    const output = { source: "api", developer: { category: [], topic: [] }, resource: { category: [], topic: [] } };
    for (const kind of ["developer", "resource"]) {
      const group = payload?.groups?.[kind] || {};
      for (const type of ["category", "topic"]) {
        const groupRows = group[type === "category" ? "categories" : "topics"] || group[type] || [];
        const rows = groupRows.length ? groupRows : all.filter((row) => row?.kind === kind && (row?.type === type || (type === "topic" && row?.type === "tag")));
        output[kind][type] = normalizeTaxonomyRows(rows, kind, type);
        if (!output[kind][type].length) output[kind][type] = fallback[kind][type];
      }
    }
    return output;
  }

  async function loadTaxonomies({ force = false } = {}) {
    if (force) taxonomyCatalogPromise = null;
    if (!taxonomyCatalogPromise) {
      taxonomyCatalogPromise = api("/taxonomies")
        .then(normalizeTaxonomyCatalog)
        .catch(() => fallbackTaxonomyCatalog());
    }
    return taxonomyCatalogPromise;
  }

  function normalizeAttachment(raw) {
    const id = cleanText(raw?.id || raw?.attachment_id);
    const filename = cleanText(raw?.filename || raw?.file_name || raw?.name, "첨부 파일");
    const mime = cleanText(raw?.mime_type || raw?.mime || raw?.content_type);
    return {
      raw,
      id,
      postId: cleanText(raw?.post_id || raw?.postId),
      filename,
      mime,
      size: Number(raw?.size_bytes ?? raw?.size ?? 0) || 0,
      downloadUrl: cleanText(raw?.downloadUrl || raw?.download_url) || (id ? `${API_ROOT}/attachments/${encodeURIComponent(id)}/download` : ""),
      inlineUrl: cleanText(raw?.inlineUrl || raw?.inline_url) || (id && mime.startsWith("image/") ? `${API_ROOT}/attachments/${encodeURIComponent(id)}/download?inline=1` : ""),
    };
  }

  function normalizePost(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    const author = raw.author && typeof raw.author === "object" ? raw.author : {};
    const richHtml = cleanText(raw.rich_html ?? raw.richHtml ?? raw.content_html ?? raw.html ?? raw.content);
    const authorName = cleanText(author.name || author.display_name || author.username || raw.author_name, "Quilo");
    const kind = cleanText(raw.kind || raw.type) === "developer_note" ? "developer" : cleanText(raw.kind || raw.type);
    return {
      raw,
      id: cleanText(raw.id || raw.post_id),
      slug: cleanText(raw.slug || raw.id),
      kind,
      title: cleanText(raw.title, "제목 없음"),
      summary: cleanText(raw.excerpt ?? raw.summary ?? raw.description),
      richHtml,
      coverUrl: cleanText(raw.cover_image ?? raw.coverImage ?? raw.cover_image_url ?? raw.cover_url ?? raw.cover?.url),
      category: cleanText(raw.category, kind === "resource" ? "자료" : "개발"),
      topic: cleanText(raw.topic || raw.topic_name),
      tags: normalizeTags(raw.tags),
      status: cleanText(raw.status, "published"),
      authorId: cleanText(raw.author_id || author.id || author.user_id),
      authorName,
      avatarUrl: cleanText(author.avatar_url || author.avatarUrl || raw.author_avatar_url),
      roleLabel: cleanText(author.role_title || author.title || raw.author_role) || (author.is_developer || author.isDeveloper || kind === "developer" ? "Quilo 개발자" : author.is_staff || author.isStaff ? "Quilo 스탭" : ""),
      publishedAt: raw.published_at || raw.publishedAt || raw.created_at || raw.createdAt || null,
      updatedAt: raw.updated_at || raw.updatedAt || null,
      readingMinutes: Number(raw.reading_minutes || raw.readingMinutes) || estimateReadingMinutes(richHtml, raw.summary),
      featured: Boolean(raw.featured || raw.is_featured),
      downloadCount: Number(raw.download_count || raw.downloads) || 0,
      attachments: arrayFrom(raw.attachments, ["attachments", "files"]).map(normalizeAttachment),
      canEdit: Boolean(raw.can_edit || raw.canEdit),
      legacy: false,
      legacyId: "",
    };
  }

  function legacyCategory(tag) {
    if (["HWPX", "수식", "문서", "PDF 번역", "문제집", "보고서"].includes(tag)) return "보고서 작성";
    if (["교육", "물리", "화학"].includes(tag)) return "Quilo 활용";
    if (["커뮤니티", "클라우드", "안정성"].includes(tag)) return "새 소식";
    return "개발";
  }

  function safeLegacyAsset(value) {
    const path = cleanText(value);
    return /^\/assets\/developer-notes\/[a-z0-9][a-z0-9._-]*\.(?:svg|png|webp)$/i.test(path) ? path : "";
  }

  function escapeMarkup(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function humanizeEditorialText(value) {
    return String(value == null ? "" : value)
      .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
      .replace(/대폭/g, "크게")
      .replace(/완벽하게/g, "안정적으로")
      .replace(/완벽한/g, "안정적인")
      .replace(/박멸/g, "방지")
      .replace(/LLM이 뱉는/g, "생성 모델이 반환하는")
      .replace(/\s+[—–]\s+/g, ": ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function legacyInlineMarkdown(value) {
    return escapeMarkup(humanizeEditorialText(value))
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  }

  function legacyMarkdownToHtml(markdown) {
    const parts = String(markdown || "").slice(0, 300000).split("```");
    let html = "";
    parts.forEach((part, partIndex) => {
      if (partIndex % 2) {
        const code = part.replace(/^(?:js|javascript|ts|typescript|python|py|json|sql|css|html|bash|sh|text|md)\b[^\n]*\n/i, "");
        html += `<pre><code>${escapeMarkup(code.replace(/\n$/, ""))}</code></pre>`;
        return;
      }
      const lines = part.split("\n");
      let paragraph = [];
      let inList = false;
      const closeParagraph = () => {
        if (!paragraph.length) return;
        html += `<p>${legacyInlineMarkdown(paragraph.join(" "))}</p>`;
        paragraph = [];
      };
      const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
      lines.forEach((rawLine) => {
        const line = rawLine.replace(/\s+$/, "");
        if (!line.trim()) { closeParagraph(); closeList(); return; }
        const image = line.trim().match(/^!\[([^\]]*)\]\(([^\s)]+)\)$/);
        if (image) {
          closeParagraph(); closeList();
          const src = safeLegacyAsset(image[2]);
          if (src) {
            const alt = cleanText(image[1]).slice(0, 300);
            html += `<figure><img src="${escapeMarkup(src)}" alt="${escapeMarkup(alt)}">${alt ? `<figcaption>${escapeMarkup(alt)}</figcaption>` : ""}</figure>`;
          }
          return;
        }
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
          closeParagraph(); closeList();
          const level = Math.min(4, Math.max(2, heading[1].length + 1));
          html += `<h${level}>${legacyInlineMarkdown(heading[2])}</h${level}>`;
          return;
        }
        const item = line.match(/^\s*[-•]\s+(.*)$/);
        if (item) {
          closeParagraph();
          if (!inList) { html += "<ul>"; inList = true; }
          html += `<li>${legacyInlineMarkdown(item[1])}</li>`;
          return;
        }
        paragraph.push(line.trim());
      });
      closeParagraph(); closeList();
    });
    return sanitizeHtml(html);
  }

  function normalizeLegacyEntry(raw, { detail = false } = {}) {
    raw = raw && typeof raw === "object" ? raw : {};
    const legacyId = cleanText(raw.id);
    const tag = cleanText(raw.tag, "개발 기록");
    const files = Array.isArray(raw.files) ? raw.files : [];
    const coverUrl = safeLegacyAsset(raw.coverImage || raw.cover_image);
    const archiveKind = cleanText(raw.archiveKind || raw.archive_kind, "lab");
    const isDevelopmentHistory = archiveKind === "development_history";
    return {
      raw,
      id: `legacy:${legacyId}`,
      slug: legacyId,
      kind: "developer",
      title: humanizeEditorialText(cleanText(raw.title, "제목 없음")),
      summary: humanizeEditorialText(cleanText(raw.summary)),
      richHtml: detail ? legacyMarkdownToHtml(raw.body_markdown) : "",
      coverUrl,
      category: legacyCategory(tag),
      topic: tag,
      tags: [tag],
      status: "published",
      authorId: "",
      authorName: isDevelopmentHistory ? "Quilo 개발팀" : "Quilo Lab",
      avatarUrl: "",
      roleLabel: isDevelopmentHistory ? "제품 개발 기록 · 읽기 전용" : "이전된 기술 기록 · 읽기 전용",
      publishedAt: raw.date || null,
      updatedAt: null,
      readingMinutes: estimateReadingMinutes(detail ? legacyMarkdownToHtml(raw.body_markdown) : "", raw.summary),
      featured: false,
      downloadCount: 0,
      attachments: files.filter((file) => file?.available !== false && file?.path).map((file) => ({
        raw: file,
        id: `legacy-file:${file.path}`,
        postId: `legacy:${legacyId}`,
        filename: cleanText(file.label || file.path, "코드 파일"),
        mime: "text/plain",
        size: Number(file.size) || 0,
        downloadUrl: `/api/lab/file?path=${encodeURIComponent(file.path)}&download=1`,
        inlineUrl: "",
      })),
      canEdit: false,
      legacy: true,
      legacyId,
      archiveKind,
    };
  }

  function estimateReadingMinutes(html, summary) {
    const holder = document.createElement("div");
    holder.textContent = cleanText(summary);
    if (html) {
      const parsed = new DOMParser().parseFromString(String(html), "text/html");
      holder.textContent += ` ${parsed.body.textContent || ""}`;
    }
    const count = holder.textContent.replace(/\s/g, "").length;
    return Math.max(1, Math.ceil(count / 550));
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return cleanText(value);
    return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replace(/\.\s?/g, ".").replace(/\.$/, "");
  }

  function formatBytes(bytes) {
    const number = Number(bytes) || 0;
    if (number < 1024) return number ? `${number} B` : "";
    if (number < 1024 ** 2) return `${(number / 1024).toFixed(number < 10240 ? 1 : 0)} KB`;
    return `${(number / 1024 ** 2).toFixed(1)} MB`;
  }

  function getExtension(filename, mime = "") {
    const match = cleanText(filename).toLowerCase().match(/\.([a-z0-9]{1,8})$/);
    if (match) return match[1];
    if (mime.includes("pdf")) return "pdf";
    if (mime.includes("word")) return "docx";
    if (mime.includes("sheet") || mime.includes("excel")) return "xlsx";
    if (mime.startsWith("image/")) return mime.split("/")[1];
    return "file";
  }

  function safeUrl(value, { image = false } = {}) {
    const raw = cleanText(value);
    if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return "";
    if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
    if (!image && raw.startsWith("#")) return raw;
    try {
      const parsed = new URL(raw, location.origin);
      if (parsed.protocol === "https:" || (parsed.origin === location.origin && parsed.protocol === location.protocol) || (!image && parsed.protocol === "mailto:")) return parsed.href;
    } catch (_) { return ""; }
    return "";
  }

  const ALLOWED_TAGS = new Set(["P","BR","HR","H1","H2","H3","H4","H5","H6","BLOCKQUOTE","PRE","CODE","STRONG","B","EM","I","U","S","MARK","SMALL","SUB","SUP","SPAN","DIV","UL","OL","LI","TABLE","THEAD","TBODY","TFOOT","TR","TH","TD","FIGURE","FIGCAPTION","A","IMG"]);
  const DROP_TAGS = new Set(["SCRIPT","STYLE","IFRAME","OBJECT","EMBED","SVG","MATH","FORM","BUTTON","INPUT","TEXTAREA","SELECT","OPTION","TEMPLATE","NOSCRIPT","META","LINK","BASE","AUDIO","VIDEO"]);
  const STYLE_PROPERTIES = new Set(["text-align","font-weight","font-style","text-decoration","font-size","color","background-color","font-family","width"]);

  function copySafeStyles(from, to) {
    if (!(from instanceof HTMLElement) || !(to instanceof HTMLElement)) return;
    const style = from.getAttribute("style");
    if (!style) return;
    for (const declaration of style.split(";")) {
      const index = declaration.indexOf(":");
      if (index < 1) continue;
      const key = declaration.slice(0, index).trim().toLowerCase();
      const value = declaration.slice(index + 1).trim();
      if (!STYLE_PROPERTIES.has(key) || !value || /url\s*\(|expression|@import|[<>\\]/i.test(value)) continue;
      if (key === "text-align" && !/^(left|center|right|justify)$/.test(value)) continue;
      if (key === "font-size" && !/^(?:1[0-9]|2[0-8])px$/.test(value)) continue;
      if ((key === "color" || key === "background-color") && !/^(?:#[0-9a-f]{3,8}|rgb\([^)]{1,40}\))$/i.test(value)) continue;
      if (key === "width" && !/^(?:100|[1-9]?\d)%$/.test(value)) continue;
      to.style.setProperty(key, value.slice(0, 80));
    }
  }

  function sanitizeNode(node, target) {
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(document.createTextNode(node.nodeValue || ""));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (DROP_TAGS.has(node.tagName)) return;
    if (!ALLOWED_TAGS.has(node.tagName)) {
      for (const child of Array.from(node.childNodes)) sanitizeNode(child, target);
      return;
    }
    const element = document.createElement(node.tagName.toLowerCase());
    copySafeStyles(node, element);
    if (node.hasAttribute("title")) element.title = cleanText(node.getAttribute("title")).slice(0, 300);
    if (node.tagName === "A") {
      const href = safeUrl(node.getAttribute("href"));
      if (href) element.href = href;
      if (node.getAttribute("target") === "_blank") element.target = "_blank";
      element.rel = "noopener noreferrer nofollow";
    }
    if (node.tagName === "IMG") {
      const src = safeUrl(node.getAttribute("src"), { image: true });
      if (!src) return;
      element.src = src;
      element.alt = cleanText(node.getAttribute("alt")).slice(0, 300);
      element.loading = "lazy";
      const width = Number.parseInt(node.getAttribute("width"), 10);
      const height = Number.parseInt(node.getAttribute("height"), 10);
      if (width > 0 && width <= 2400) element.width = width;
      if (height > 0 && height <= 2400) element.height = height;
    }
    if (["TH","TD"].includes(node.tagName)) {
      for (const attribute of ["colspan", "rowspan"]) {
        const count = Number.parseInt(node.getAttribute(attribute), 10);
        if (count > 0 && count <= 100) element.setAttribute(attribute, String(count));
      }
    }
    if (node.tagName === "OL") {
      const start = Number.parseInt(node.getAttribute("start"), 10);
      if (start > 0 && start <= 100) element.start = start;
    }
    for (const child of Array.from(node.childNodes)) sanitizeNode(child, element);
    target.append(element);
  }

  function sanitizeToFragment(html) {
    const parsed = new DOMParser().parseFromString(String(html || "").slice(0, 300000), "text/html");
    const fragment = document.createDocumentFragment();
    for (const node of Array.from(parsed.body.childNodes)) sanitizeNode(node, fragment);
    return fragment;
  }

  function sanitizeHtml(html) {
    const holder = document.createElement("div");
    holder.append(sanitizeToFragment(html));
    return holder.innerHTML;
  }

  function getBookmarks() {
    try { return new Set(JSON.parse(localStorage.getItem(BOOKMARK_KEY) || "[]").map(String)); }
    catch (_) { return new Set(); }
  }

  function toggleBookmark(id) {
    const items = getBookmarks();
    const key = String(id || "");
    if (items.has(key)) items.delete(key); else items.add(key);
    localStorage.setItem(BOOKMARK_KEY, JSON.stringify(Array.from(items).slice(-200)));
    return items.has(key);
  }

  function articleHref(post) {
    return post.legacy
      ? `/article.html?legacy=${encodeURIComponent(post.legacyId || post.slug)}`
      : `/article.html?slug=${encodeURIComponent(post.slug)}`;
  }

  function makeAuthorMeta(post, { compact = false } = {}) {
    const wrap = document.createElement("div");
    wrap.className = "ed-post-meta";
    if (post.avatarUrl) {
      const image = document.createElement("img");
      image.src = safeUrl(post.avatarUrl, { image: true });
      image.alt = "";
      image.loading = "lazy";
      image.addEventListener("error", () => image.remove());
      wrap.append(image);
    } else {
      const fallback = document.createElement("span");
      fallback.className = "ed-author-fallback";
      fallback.textContent = Array.from(post.authorName)[0] || "Q";
      wrap.append(fallback);
    }
    const name = document.createElement("strong");
    name.textContent = post.authorName;
    wrap.append(name);
    if (post.roleLabel && !compact) {
      const role = document.createElement("span");
      role.className = "ed-author-role";
      role.textContent = post.roleLabel;
      wrap.append(role);
    }
    const reading = document.createElement("span");
    reading.className = "ed-meta-dot";
    reading.textContent = `${post.readingMinutes}분 읽기`;
    wrap.append(reading);
    const date = document.createElement("time");
    date.className = "ed-meta-dot";
    date.dateTime = post.publishedAt ? new Date(post.publishedAt).toISOString() : "";
    date.textContent = formatDate(post.publishedAt);
    wrap.append(date);
    return wrap;
  }

  function hasTaxonomyAdminAccess(session) {
    return Boolean(
      session?.capabilities?.manageTaxonomies ||
      session?.profile?.isAdmin ||
      session?.profile?.is_admin,
    );
  }

  function createTaxonomyDialog() {
    const dialog = document.createElement("dialog");
    dialog.className = "ed-taxonomy-dialog";
    dialog.setAttribute("aria-labelledby", "taxonomyDialogTitle");
    dialog.innerHTML = `<div class="ed-taxonomy-dialog__head">
      <div><h2 id="taxonomyDialogTitle">분류와 주제 관리</h2><p>표시 이름, 순서와 공개 여부를 관리합니다.</p></div>
      <button class="ed-taxonomy-dialog__close" type="button" data-close-taxonomy aria-label="닫기">×</button>
    </div>
    <div class="ed-taxonomy-dialog__body">
      <div class="ed-taxonomy-switches">
        <label>공간<select data-taxonomy-admin-kind><option value="developer">개발 노트</option><option value="resource">자료실</option></select></label>
        <label>항목<select data-taxonomy-admin-type><option value="category">카테고리</option><option value="topic">주제</option></select></label>
      </div>
      <p class="ed-taxonomy-help">이름을 수정한 뒤 저장하세요. 화살표 버튼으로 공개 순서를 바꿀 수 있습니다.</p>
      <div class="ed-taxonomy-list" data-taxonomy-admin-list aria-live="polite"></div>
      <form class="ed-taxonomy-create" data-taxonomy-create>
        <label class="ui-sr-only" for="newTaxonomyName">새 항목 이름</label>
        <input id="newTaxonomyName" name="name" type="text" maxlength="60" required placeholder="새 항목 이름">
        <button type="submit">항목 추가</button>
      </form>
      <p class="ed-taxonomy-dialog__status" data-taxonomy-admin-status role="status" aria-live="polite"></p>
    </div>`;
    document.body.append(dialog);
    return dialog;
  }

  function setupTaxonomyAdmin(session) {
    const allowed = hasTaxonomyAdminAccess(session);
    $$('[data-manage-taxonomies]').forEach((button) => { button.hidden = !allowed; });
    $$('[data-taxonomy-admin-section]').forEach((section) => { section.hidden = !allowed; });
    if (!allowed || !$('[data-manage-taxonomies]')) return;

    const dialog = createTaxonomyDialog();
    const kindSelect = $('[data-taxonomy-admin-kind]', dialog);
    const typeSelect = $('[data-taxonomy-admin-type]', dialog);
    const list = $('[data-taxonomy-admin-list]', dialog);
    const status = $('[data-taxonomy-admin-status]', dialog);
    let rows = [];
    let opener = null;

    function normalizeAdminRow(row) {
      return {
        raw: row,
        id: cleanText(row?.id),
        kind: cleanText(row?.kind, kindSelect.value),
        type: cleanText(row?.type === "tag" ? "topic" : row?.type, typeSelect.value),
        name: taxonomyValue(row),
        slug: cleanText(row?.slug),
        sortOrder: Number(row?.sortOrder ?? row?.sort_order ?? 0) || 0,
        isActive: row?.isActive !== false && row?.is_active !== false,
      };
    }

    function setStatus(message, isError = false) {
      status.textContent = message;
      status.style.color = isError ? "var(--ed-danger)" : "";
    }

    async function refreshPublicTaxonomies(message = "") {
      const catalog = await loadTaxonomies({ force: true });
      document.dispatchEvent(new CustomEvent("quilo:taxonomies-change", { detail: catalog }));
      if (message) showToast(message);
    }

    function rowNode(item, index) {
      const row = document.createElement("div");
      row.className = `ed-taxonomy-row${item.isActive ? "" : " is-inactive"}`;
      row.dataset.taxonomyId = item.id;

      const order = document.createElement("div");
      order.className = "ed-taxonomy-row__order";
      const up = document.createElement("button");
      up.type = "button"; up.textContent = "↑"; up.title = "위로 이동"; up.setAttribute("aria-label", `${item.name} 위로 이동`); up.dataset.moveTaxonomy = "up"; up.disabled = index === 0;
      const down = document.createElement("button");
      down.type = "button"; down.textContent = "↓"; down.title = "아래로 이동"; down.setAttribute("aria-label", `${item.name} 아래로 이동`); down.dataset.moveTaxonomy = "down"; down.disabled = index === rows.length - 1;
      order.append(up, down);

      const copy = document.createElement("div");
      copy.className = "ed-taxonomy-row__copy";
      const input = document.createElement("input");
      input.type = "text"; input.value = item.name; input.maxLength = 60; input.setAttribute("aria-label", `${item.name} 이름`); input.dataset.taxonomyName = "";
      const meta = document.createElement("small");
      meta.textContent = `${item.slug || "자동 주소"} · ${item.isActive ? "공개 중" : "비활성"}`;
      copy.append(input, meta);

      const actions = document.createElement("div");
      actions.className = "ed-taxonomy-row__actions";
      const save = document.createElement("button");
      save.type = "button"; save.textContent = "저장"; save.dataset.saveTaxonomy = "";
      const active = document.createElement("button");
      active.type = "button"; active.textContent = item.isActive ? "비활성" : "활성"; active.dataset.toggleTaxonomy = item.isActive ? "deactivate" : "activate";
      const remove = document.createElement("button");
      remove.type = "button"; remove.textContent = "삭제"; remove.dataset.deleteTaxonomy = "";
      actions.append(save, active, remove);
      row.append(order, copy, actions);
      return row;
    }

    function renderRows() {
      list.replaceChildren();
      if (!rows.length) {
        const empty = document.createElement("p");
        empty.className = "ed-taxonomy-help";
        empty.textContent = "등록된 항목이 없습니다. 아래에서 첫 항목을 추가하세요.";
        list.append(empty);
        return;
      }
      rows.forEach((item, index) => list.append(rowNode(item, index)));
    }

    async function loadAdminRows() {
      list.setAttribute("aria-busy", "true");
      setStatus("목록을 불러오는 중입니다.");
      try {
        const query = new URLSearchParams({ kind: kindSelect.value, type: typeSelect.value, active: "all" });
        const payload = await api(`/admin/taxonomies?${query}`);
        rows = arrayFrom(payload, ["taxonomies", "items"])
          .map(normalizeAdminRow)
          .filter((row) => row.kind === kindSelect.value && row.type === typeSelect.value)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ko"));
        renderRows();
        setStatus(`${rows.length}개 항목`);
      } catch (error) {
        rows = [];
        renderRows();
        setStatus(error.message, true);
      } finally { list.removeAttribute("aria-busy"); }
    }

    async function moveRow(item, direction) {
      const from = rows.findIndex((row) => row.id === item.id);
      const to = direction === "up" ? from - 1 : from + 1;
      if (from < 0 || to < 0 || to >= rows.length) return;
      [rows[from], rows[to]] = [rows[to], rows[from]];
      const items = rows.map((row, index) => ({ id: row.id, sortOrder: (index + 1) * 10 }));
      renderRows();
      setStatus("순서를 저장하는 중입니다.");
      try {
        await api("/admin/taxonomies/reorder", { method: "PATCH", body: { items } });
        rows.forEach((row, index) => { row.sortOrder = (index + 1) * 10; });
        setStatus("순서를 저장했습니다.");
        await refreshPublicTaxonomies();
      } catch (error) { setStatus(error.message, true); await loadAdminRows(); }
    }

    list.addEventListener("click", async (event) => {
      const rowElement = event.target.closest?.('[data-taxonomy-id]');
      const item = rows.find((row) => row.id === rowElement?.dataset.taxonomyId);
      if (!item) return;
      const control = event.target.closest("button");
      if (!control) return;
      control.disabled = true;
      try {
        if (control.dataset.moveTaxonomy) {
          await moveRow(item, control.dataset.moveTaxonomy);
          return;
        }
        if (control.hasAttribute("data-save-taxonomy")) {
          const name = cleanText($('[data-taxonomy-name]', rowElement)?.value);
          if (!name) throw new Error("이름을 입력하세요.");
          await api(`/admin/taxonomies/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { name } });
          await loadAdminRows();
          await refreshPublicTaxonomies("이름을 수정했습니다.");
        } else if (control.dataset.toggleTaxonomy) {
          await api(`/admin/taxonomies/${encodeURIComponent(item.id)}/${control.dataset.toggleTaxonomy}`, { method: "POST" });
          await loadAdminRows();
          await refreshPublicTaxonomies(item.isActive ? "항목을 비활성화했습니다." : "항목을 활성화했습니다.");
        } else if (control.hasAttribute("data-delete-taxonomy")) {
          if (!confirm(`'${item.name}' 항목을 삭제할까요? 사용 중이면 안전하게 비활성화됩니다.`)) return;
          const result = await api(`/admin/taxonomies/${encodeURIComponent(item.id)}`, { method: "DELETE" });
          await loadAdminRows();
          await refreshPublicTaxonomies(result?.deactivated ? "사용 중인 항목이라 비활성화했습니다." : "항목을 삭제했습니다.");
        }
      } catch (error) { setStatus(error.message, true); }
      finally { if (control.isConnected) control.disabled = false; }
    });

    $('[data-taxonomy-create]', dialog).addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const name = cleanText(new FormData(form).get("name"));
      if (!name) return;
      const button = $('button[type="submit"]', form);
      button.disabled = true;
      setStatus("새 항목을 추가하는 중입니다.");
      try {
        await api("/admin/taxonomies", { method: "POST", body: { kind: kindSelect.value, type: typeSelect.value, name, sortOrder: (rows.length + 1) * 10, isActive: true } });
        form.reset();
        await loadAdminRows();
        await refreshPublicTaxonomies("새 항목을 추가했습니다.");
      } catch (error) { setStatus(error.message, true); }
      finally { button.disabled = false; }
    });

    [kindSelect, typeSelect].forEach((select) => select.addEventListener("change", loadAdminRows));
    $('[data-close-taxonomy]', dialog).addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener("close", () => opener?.focus());

    $$('[data-manage-taxonomies]').forEach((button) => button.addEventListener("click", () => {
      opener = button;
      const editorKind = $('#kindSelect')?.value;
      kindSelect.value = editorKind === "resource" ? "resource" : button.dataset.taxonomyKind === "resource" ? "resource" : "developer";
      typeSelect.value = "category";
      dialog.showModal();
      loadAdminRows();
    }));
  }

  function setupSharedChrome(session) {
    const canDeveloper = Boolean(session?.capabilities?.writeDeveloperNotes);
    const canResource = Boolean(session?.capabilities?.writeResources);
    $$('[data-write-action]').forEach((node) => { node.hidden = !canDeveloper; });
    $$('[data-resource-write]').forEach((node) => { node.hidden = !canResource; });
    setupTaxonomyAdmin(session);
    $$('[data-focus-search]').forEach((button) => button.addEventListener("click", () => {
      const field = $('input[type="search"]');
      field?.focus();
      field?.scrollIntoView({ block: "center", behavior: "smooth" });
    }));
    document.addEventListener("keydown", (event) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
      const field = $('input[type="search"]');
      if (!field) return;
      event.preventDefault();
      field.focus();
    });
  }

  async function loadSession() {
    try {
      const result = await api("/me/capabilities");
      return {
        capabilities: result?.capabilities || {},
        profile: result?.profile || result?.user || null,
      };
    } catch (error) {
      if (error.status === 401) return null;
      // 권한 저장소/네트워크 오류는 로그아웃과 구분한다. 읽기 화면은 유지하되
      // 쓰기 권한은 fail-closed 상태로 둔다.
      return { state: "unknown", capabilities: {}, profile: null };
    }
  }

  async function hydrateAttachments(post) {
    if (!post?.id || post.legacy || post.attachments.length) return post;
    try {
      const payload = await api(`/posts/${encodeURIComponent(post.id)}/attachments`);
      post.attachments = arrayFrom(payload, ["attachments", "files"]).map(normalizeAttachment);
    } catch (_) { /* 목록은 첨부 조회 실패와 무관하게 보여 준다. */ }
    return post;
  }

  function emptyState(title, description) {
    const wrap = document.createElement("div");
    wrap.className = "ed-empty";
    wrap.innerHTML = svg("empty");
    const heading = document.createElement("h3");
    heading.textContent = title;
    const text = document.createElement("p");
    text.textContent = description;
    wrap.append(heading, text);
    return wrap;
  }

  async function initNotes(session) {
    const initialCatalog = await loadTaxonomies();
    const state = { posts: [], category: "", topic: "", query: "", sort: "latest", shown: POSTS_PER_PAGE, bookmarksOnly: false };
    let categoryValues = [...initialCatalog.developer.category];
    let topicValues = [...initialCatalog.developer.topic];
    const status = $("#notesStatus");
    const list = $("#postList");
    const featured = $("#featuredPost");
    const loadMore = $("#loadMore");

    function postHasTopic(post, topic) {
      if (!topic) return true;
      const key = topic.toLocaleLowerCase("ko-KR");
      return post.topic.toLocaleLowerCase("ko-KR") === key || post.tags.some((tag) => tag.toLocaleLowerCase("ko-KR") === key);
    }

    function filteredPosts() {
      let items = state.posts.filter((post) => {
        if (state.category && post.category !== state.category) return false;
        if (!postHasTopic(post, state.topic)) return false;
        const haystack = `${post.title} ${post.summary} ${post.category} ${post.topic} ${post.tags.join(" ")}`.toLocaleLowerCase("ko-KR");
        if (state.query && !haystack.includes(state.query.toLocaleLowerCase("ko-KR"))) return false;
        if (state.bookmarksOnly && !getBookmarks().has(post.id || post.slug)) return false;
        return true;
      });
      if (state.sort === "oldest") items = items.sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));
      else if (state.sort === "title") items = items.sort((a, b) => a.title.localeCompare(b.title, "ko"));
      else items = items.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
      return items;
    }

    function renderFeatured(post) {
      featured.replaceChildren();
      if (!post) { featured.hidden = true; return; }
      featured.hidden = false;
      const media = document.createElement("a");
      media.className = "ed-featured__media";
      media.href = articleHref(post);
      media.setAttribute("aria-label", `${post.title} 읽기`);
      if (post.coverUrl) {
        const image = document.createElement("img");
        image.src = safeUrl(post.coverUrl, { image: true });
        image.alt = "";
        image.loading = "eager";
        image.addEventListener("error", () => { media.classList.add("ed-featured__media--empty"); media.replaceChildren(); media.innerHTML = svg("image"); });
        media.append(image);
      } else {
        media.classList.add("ed-featured__media--empty");
        media.innerHTML = svg("image");
      }
      const copy = document.createElement("div");
      copy.className = "ed-featured__copy";
      const kicker = document.createElement("span");
      kicker.className = "ed-kicker";
      kicker.textContent = post.category;
      const title = document.createElement("h2");
      const anchor = document.createElement("a");
      anchor.href = articleHref(post);
      anchor.textContent = post.title;
      title.append(anchor);
      const summary = document.createElement("p");
      summary.className = "ed-featured__summary";
      summary.textContent = post.summary;
      copy.append(kicker, title, summary, makeAuthorMeta(post));
      featured.append(media, copy);
    }

    function postRow(post) {
      const row = document.createElement("article");
      row.className = "ed-post-item";
      if (post.coverUrl) {
        const thumbnail = document.createElement("a");
        thumbnail.className = "ed-post-thumbnail";
        thumbnail.href = articleHref(post);
        thumbnail.setAttribute("aria-label", `${post.title} 읽기`);
        const image = document.createElement("img");
        image.src = safeUrl(post.coverUrl, { image: true });
        image.alt = "";
        image.loading = "lazy";
        image.addEventListener("error", () => { thumbnail.remove(); row.classList.remove("has-thumbnail"); });
        thumbnail.append(image);
        row.classList.add("has-thumbnail");
        row.append(thumbnail);
      }
      const copy = document.createElement("div");
      const title = document.createElement("h3");
      const anchor = document.createElement("a");
      anchor.href = articleHref(post);
      anchor.textContent = post.title;
      title.append(anchor);
      const summary = document.createElement("p");
      summary.textContent = post.summary;
      copy.append(title);
      if (post.legacy) {
        const legacy = document.createElement("span");
        legacy.className = "ed-legacy-chip";
        legacy.textContent = post.archiveKind === "development_history"
          ? "Quilo 개발팀 · 읽기 전용"
          : "Quilo Lab · 읽기 전용";
        copy.append(legacy);
      }
      copy.append(summary, makeAuthorMeta(post, { compact: true }));
      const actions = document.createElement("div");
      actions.className = "ed-item-actions";
      const bookmark = document.createElement("button");
      const key = post.id || post.slug;
      bookmark.type = "button";
      bookmark.title = "북마크";
      bookmark.setAttribute("aria-label", `${post.title} 북마크`);
      bookmark.classList.toggle("is-saved", getBookmarks().has(key));
      bookmark.innerHTML = svg("bookmark");
      bookmark.addEventListener("click", () => {
        const saved = toggleBookmark(key);
        bookmark.classList.toggle("is-saved", saved);
        showToast(saved ? "북마크에 저장했습니다." : "북마크에서 삭제했습니다.");
        if (state.bookmarksOnly && !saved) render();
      });
      const share = document.createElement("button");
      share.type = "button";
      share.title = "공유";
      share.setAttribute("aria-label", `${post.title} 공유`);
      share.innerHTML = svg("share");
      share.addEventListener("click", () => sharePost(post));
      actions.append(bookmark, share);
      row.append(copy, actions);
      return row;
    }

    function renderCategoryTabs() {
      const root = $("[data-category-tabs]");
      if (!root) return;
      root.replaceChildren();
      for (const category of ["", ...categoryValues]) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.category = category;
        button.textContent = category || "전체";
        button.classList.toggle("is-active", !state.bookmarksOnly && state.category === category);
        button.setAttribute("aria-pressed", String(!state.bookmarksOnly && state.category === category));
        button.addEventListener("click", () => selectCategory(category));
        root.append(button);
      }
    }

    function renderTopics() {
      const topics = $("[data-topic-list]");
      if (!topics) return;
      topics.replaceChildren();
      for (const topic of ["", ...topicValues]) {
        const button = document.createElement("button");
        button.type = "button";
        button.classList.toggle("is-active", !state.bookmarksOnly && state.topic === topic);
        button.setAttribute("aria-pressed", String(!state.bookmarksOnly && state.topic === topic));
        const label = document.createElement("span");
        label.textContent = topic || "전체 주제";
        const count = document.createElement("b");
        count.textContent = String(topic ? state.posts.filter((post) => postHasTopic(post, topic)).length : state.posts.length);
        button.append(label, count);
        button.addEventListener("click", () => selectTopic(topic));
        topics.append(button);
      }
    }

    function selectCategory(category) {
      state.category = category;
      state.bookmarksOnly = false;
      state.shown = POSTS_PER_PAGE;
      $("[data-bookmark-filter]")?.classList.remove("is-active");
      render();
    }

    function selectTopic(topic) {
      state.topic = topic;
      state.bookmarksOnly = false;
      state.shown = POSTS_PER_PAGE;
      $("[data-bookmark-filter]")?.classList.remove("is-active");
      render();
    }

    function render() {
      const items = filteredPosts();
      const canFeature = !state.query && !state.category && !state.topic && !state.bookmarksOnly && state.sort === "latest";
      const lead = canFeature ? (items.find((post) => post.featured) || items[0]) : null;
      renderFeatured(lead);
      const stream = lead ? items.filter((post) => post !== lead) : items;
      list.replaceChildren();
      stream.slice(0, state.shown).forEach((post) => list.append(postRow(post)));
      if (!stream.length) list.append(emptyState(state.bookmarksOnly ? "저장한 글이 없습니다" : "조건에 맞는 글이 없습니다", state.bookmarksOnly ? "읽고 싶은 글의 북마크 버튼을 눌러 보세요." : "검색어나 분류를 바꿔 다시 확인해 보세요."));
      loadMore.hidden = stream.length <= state.shown;
      status.textContent = state.posts.length ? `${items.length}개의 글` : "";
      renderCategoryTabs();
      renderTopics();
    }

    $("#postSearch")?.addEventListener("input", (event) => { state.query = event.target.value.trim(); state.shown = POSTS_PER_PAGE; render(); });
    $("#postSort")?.addEventListener("change", (event) => { state.sort = event.target.value; render(); });
    loadMore?.addEventListener("click", () => { state.shown += POSTS_PER_PAGE; render(); });
    $("[data-bookmark-filter]")?.addEventListener("click", (event) => {
      state.bookmarksOnly = !state.bookmarksOnly;
      state.category = "";
      state.topic = "";
      event.currentTarget.classList.toggle("is-active", state.bookmarksOnly);
      render();
    });

    document.addEventListener("quilo:taxonomies-change", (event) => {
      const catalog = event.detail || fallbackTaxonomyCatalog();
      categoryValues = [...catalog.developer.category];
      topicValues = [...catalog.developer.topic];
      if (state.category && !categoryValues.includes(state.category)) state.category = "";
      if (state.topic && !topicValues.includes(state.topic)) state.topic = "";
      render();
    });

    const [editorialResult, legacyResult] = await Promise.allSettled([
      api("/posts?kind=developer&limit=100"),
      fetchJson("/api/lab/entries"),
    ]);
    const editorialPosts = editorialResult.status === "fulfilled"
      ? arrayFrom(editorialResult.value, ["posts", "items"]).map(normalizePost)
      : [];
    const legacyPosts = legacyResult.status === "fulfilled"
      ? arrayFrom(legacyResult.value, ["entries", "items"]).map((entry) => normalizeLegacyEntry(entry))
      : [];
    const migratedLegacyIds = new Set(editorialPosts.map((post) => cleanText(post.raw?.legacy_id || post.raw?.legacyId || post.raw?.lab_entry_id)).filter(Boolean));
    const migratedKeys = new Set(editorialPosts.map((post) => `${post.title.toLocaleLowerCase("ko-KR")}|${cleanText(post.publishedAt).slice(0, 10)}`));
    state.posts = editorialPosts.concat(legacyPosts.filter((post) => {
      if (migratedLegacyIds.has(post.legacyId)) return false;
      return !migratedKeys.has(`${post.title.toLocaleLowerCase("ko-KR")}|${cleanText(post.publishedAt).slice(0, 10)}`);
    }));
    if (initialCatalog.source === "fallback") {
      const discoveredTopics = state.posts.map((post) => post.topic).filter(Boolean);
      topicValues = [...new Set([...topicValues, ...discoveredTopics])];
    }
    if (!state.posts.length && editorialResult.status === "rejected" && legacyResult.status === "rejected") {
      const error = editorialResult.reason || legacyResult.reason;
      status.textContent = error?.message || "개발 노트를 불러오지 못했습니다.";
      status.classList.add("is-error");
      list.replaceChildren(emptyState("개발 노트를 불러오지 못했습니다", "잠시 후 다시 시도해 주세요."));
    } else {
      if (editorialResult.status === "rejected" || legacyResult.status === "rejected") status.textContent = "일부 이전 기록을 불러오지 못했지만 확인 가능한 글을 표시합니다.";
      render();
    }
  }

  async function sharePost(post) {
    const url = new URL(articleHref(post), location.origin).href;
    try {
      if (navigator.share) await navigator.share({ title: post.title, text: post.summary, url });
      else { await navigator.clipboard.writeText(url); showToast("글 주소를 복사했습니다."); }
    } catch (error) {
      if (error.name !== "AbortError") showToast("공유 주소를 복사하지 못했습니다.", true);
    }
  }

  async function initArticle(session) {
    const params = new URLSearchParams(location.search);
    const legacyId = params.get("legacy") || "";
    const slug = params.get("slug") || params.get("id") || "";
    const loading = $("#articleLoading");
    const article = $("#article");
    const errorState = $("#articleError");
    if (!slug && !legacyId) {
      loading.hidden = true;
      errorState.hidden = false;
      return;
    }
    try {
      const post = legacyId
        ? normalizeLegacyEntry(await fetchJson(`/api/lab/entry/${encodeURIComponent(legacyId)}`), { detail: true })
        : normalizePost(oneFrom(await api(`/posts/${encodeURIComponent(slug)}`), ["post", "item"]));
      await hydrateAttachments(post);
      document.title = `${post.title} — Quilo`;
      const isResource = post.kind === "resource";
      $("#articleBack").href = isResource ? "/resources.html" : "/developer-notes.html";
      $("#articleBack span").textContent = isResource ? "자료실로" : "개발 노트로";
      $("#articleListLink").href = isResource ? "/resources.html" : "/developer-notes.html";
      $("#articleListLink").firstChild.textContent = isResource ? "자료실의 다른 글 보기" : "목록의 다른 글 보기";
      $("#articleCategory").textContent = post.category;
      const legacyNotice = $("[data-legacy-notice]");
      legacyNotice.hidden = !post.legacy;
      if (post.legacy) {
        legacyNotice.textContent = post.archiveKind === "development_history"
          ? "Quilo 개발팀이 작성한 제품 개발 기록입니다."
          : "이 글은 기존 Quilo Lab에서 이전된 읽기 전용 기록입니다.";
      }
      $("#articleTitle").textContent = post.title;
      $("#articleSummary").textContent = post.summary;
      $("#articleAuthor").textContent = post.authorName;
      $("#articleRole").textContent = post.roleLabel;
      $("#articleDate").textContent = formatDate(post.publishedAt);
      $("#articleDate").dateTime = post.publishedAt ? new Date(post.publishedAt).toISOString() : "";
      $("#articleReadingTime").textContent = `${post.readingMinutes}분 읽기`;
      const avatar = $("#articleAvatar");
      if (post.avatarUrl) { avatar.src = safeUrl(post.avatarUrl, { image: true }); avatar.hidden = false; }
      const cover = $("#articleCover");
      if (post.coverUrl) { $("img", cover).src = safeUrl(post.coverUrl, { image: true }); $("img", cover).alt = `${post.title} 커버`; cover.hidden = false; }
      const body = $("#articleBody");
      const bodyFragment = sanitizeToFragment(post.richHtml);
      if (post.coverUrl) {
        const coverHref = new URL(post.coverUrl, location.origin).href;
        const repeatedCover = [...bodyFragment.querySelectorAll("img")].find((image) => new URL(image.getAttribute("src"), location.origin).href === coverHref);
        if (repeatedCover) (repeatedCover.closest("figure") || repeatedCover).remove();
      }
      body.replaceChildren(bodyFragment);
      if (!body.textContent.trim() && !$('img', body)) body.append(emptyState("본문이 없습니다", "작성자가 내용을 준비하고 있습니다."));
      const attachments = $("#articleAttachments");
      const attachmentList = $("div", attachments);
      const bodyImages = new Set($$("img", body).map((image) => image.src));
      const visibleAttachments = post.attachments.filter((file) => {
        if (!file.inlineUrl) return true;
        const absoluteInlineUrl = new URL(file.inlineUrl, location.origin).href;
        const isCover = post.coverUrl && new URL(post.coverUrl, location.origin).href === absoluteInlineUrl;
        return !isCover && !bodyImages.has(absoluteInlineUrl);
      });
      for (const file of visibleAttachments) {
        const anchor = document.createElement("a");
        anchor.className = "ed-attachment-link";
        anchor.href = file.downloadUrl;
        anchor.innerHTML = svg("file");
        const name = document.createElement("span");
        name.textContent = file.filename;
        const size = document.createElement("small");
        size.textContent = formatBytes(file.size) || getExtension(file.filename).toUpperCase();
        anchor.append(name, size);
        attachmentList.append(anchor);
      }
      attachments.hidden = !visibleAttachments.length;
      const tags = $("#articleTags");
      for (const tag of post.tags) { const node = document.createElement("span"); node.textContent = `#${tag}`; tags.append(node); }
      const key = post.id || post.slug;
      const bookmark = $("[data-bookmark-article]");
      bookmark.setAttribute("aria-pressed", String(getBookmarks().has(key)));
      bookmark.addEventListener("click", () => {
        const saved = toggleBookmark(key);
        bookmark.setAttribute("aria-pressed", String(saved));
        showToast(saved ? "북마크에 저장했습니다." : "북마크에서 삭제했습니다.");
      });
      $("[data-share-article]")?.addEventListener("click", () => sharePost(post));
      const isAdmin = Boolean(session?.profile?.isAdmin || session?.profile?.is_admin);
      const isOwner = Boolean(session?.profile?.id && session.profile.id === post.authorId);
      const canKind = post.kind === "resource" ? session?.capabilities?.writeResources : session?.capabilities?.writeDeveloperNotes;
      if (!post.legacy && (post.canEdit || isAdmin || (isOwner && canKind))) {
        const owner = $("[data-owner-actions]");
        owner.hidden = false;
        $("[data-edit-post]").href = `/editorial-write.html?id=${encodeURIComponent(post.id)}`;
        $("[data-delete-post]").addEventListener("click", async () => {
          if (!confirm("이 글과 첨부 파일을 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.")) return;
          try { await api(`/posts/${encodeURIComponent(post.id)}`, { method: "DELETE" }); location.href = isResource ? "/resources.html" : "/developer-notes.html"; }
          catch (error) { showToast(error.message, true); }
        });
      }
      loading.hidden = true;
      article.hidden = false;
    } catch (error) {
      loading.hidden = true;
      errorState.hidden = false;
      const description = $("p", errorState);
      if (error.status !== 404) description.textContent = error.message;
    }
  }

  function normalizeRequest(raw) {
    return {
      id: cleanText(raw?.id),
      title: cleanText(raw?.title, "자료 요청"),
      details: cleanText(raw?.details ?? raw?.description),
      category: cleanText(raw?.category, "기타"),
      status: cleanText(raw?.status, "open"),
      authorName: cleanText(raw?.author_name || raw?.authorName, "Quilo 사용자"),
      createdAt: raw?.created_at || raw?.createdAt || null,
      linkedPostId: cleanText(raw?.linked_post_id || raw?.linkedPostId),
    };
  }

  async function initResources(session) {
    const initialCatalog = await loadTaxonomies();
    let categoryValues = [...initialCatalog.resource.category];
    const state = { posts: [], query: "", category: "", formats: new Set(), sort: "latest", requests: [] };
    const list = $("#resourceList");
    const status = $("#resourceStatus");
    const count = $("#resourceCount");
    const canManage = Boolean(session?.capabilities?.manageResourceRequests);

    function selectResourceCategory(category) {
      state.category = category;
      render();
    }

    function renderResourceCategories() {
      const fieldset = $("[data-resource-categories]");
      if (!fieldset) return;
      const legend = document.createElement("legend");
      legend.textContent = "분류";
      fieldset.replaceChildren(legend);
      for (const category of ["", ...categoryValues]) {
        const label = document.createElement("label");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "resourceCategory";
        radio.value = category;
        radio.checked = state.category === category;
        radio.addEventListener("change", () => { if (radio.checked) selectResourceCategory(category); });
        const text = document.createElement("span");
        text.textContent = category || "전체 자료";
        const number = document.createElement("b");
        if (category) number.dataset.countCategory = category;
        else number.dataset.countAll = "";
        number.textContent = String(category ? state.posts.filter((post) => post.category === category).length : state.posts.length);
        label.append(radio, text, number);
        fieldset.append(label);
      }

      const requestCategory = $("#requestCategory");
      if (requestCategory) {
        const previous = requestCategory.value;
        requestCategory.replaceChildren();
        for (const category of categoryValues) {
          const option = document.createElement("option");
          option.value = category;
          option.textContent = category;
          requestCategory.append(option);
        }
        if ([...requestCategory.options].some((option) => option.value === previous)) requestCategory.value = previous;
      }
    }

    function filtered() {
      let items = state.posts.filter((post) => {
        if (state.category && post.category !== state.category) return false;
        const search = `${post.title} ${post.summary} ${post.category} ${post.tags.join(" ")}`.toLocaleLowerCase("ko-KR");
        if (state.query && !search.includes(state.query.toLocaleLowerCase("ko-KR"))) return false;
        if (state.formats.size) {
          const formats = new Set(post.attachments.map((file) => getExtension(file.filename, file.mime)));
          if (![...state.formats].some((format) => formats.has(format))) return false;
        }
        return true;
      });
      if (state.sort === "title") items.sort((a, b) => a.title.localeCompare(b.title, "ko"));
      else if (state.sort === "popular") items.sort((a, b) => b.downloadCount - a.downloadCount);
      else items.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
      return items;
    }

    function resourceRow(post) {
      const file = post.attachments.find((attachment) => !attachment.mime.startsWith("image/")) || post.attachments[0] || null;
      const extension = getExtension(file?.filename, file?.mime);
      const row = document.createElement("article");
      row.className = "ed-resource-item";
      const icon = document.createElement("div");
      icon.className = "ed-file-icon";
      icon.innerHTML = svg("file");
      icon.append(document.createTextNode(extension));
      const copy = document.createElement("div");
      const title = document.createElement("h3");
      const anchor = document.createElement("a");
      anchor.href = articleHref(post);
      anchor.textContent = post.title;
      title.append(anchor);
      const summary = document.createElement("p");
      summary.textContent = post.summary;
      const meta = document.createElement("div");
      meta.className = "ed-resource-meta";
      for (const value of [post.category, formatDate(post.publishedAt), file ? formatBytes(file.size) : "설명 자료", post.downloadCount ? `${post.downloadCount.toLocaleString("ko-KR")}회 다운로드` : ""]) {
        if (!value) continue;
        const node = document.createElement("span"); node.textContent = value; meta.append(node);
      }
      copy.append(title, summary, meta);
      row.append(icon, copy);
      if (file) {
        const download = document.createElement("a");
        download.className = "ed-download-action";
        download.href = file.downloadUrl;
        download.innerHTML = `${svg("download")}<span>다운로드</span>`;
        download.setAttribute("aria-label", `${post.title} 다운로드`);
        row.append(download);
      }
      return row;
    }

    function render() {
      const items = filtered();
      list.replaceChildren();
      items.forEach((post) => list.append(resourceRow(post)));
      if (!items.length) list.append(emptyState("조건에 맞는 자료가 없습니다", "필터를 바꾸거나 아래에서 필요한 자료를 요청해 주세요."));
      count.textContent = `총 ${items.length}개 자료`;
      $("#resourceListTitle").textContent = state.category || "전체 자료";
      $("[data-count-all]").textContent = String(state.posts.length);
      $$('[data-count-category]').forEach((node) => { node.textContent = String(state.posts.filter((post) => post.category === node.dataset.countCategory).length); });
    }

    $("#resourceSearch")?.addEventListener("input", (event) => { state.query = event.target.value.trim(); render(); });
    $$('[data-resource-format]').forEach((checkbox) => checkbox.addEventListener("change", () => { if (checkbox.checked) state.formats.add(checkbox.value); else state.formats.delete(checkbox.value); render(); }));
    $("#resourceSort")?.addEventListener("change", (event) => { state.sort = event.target.value; render(); });
    $$('[data-open-request]').forEach((button) => button.addEventListener("click", () => $("#requestSection")?.scrollIntoView({ behavior: "smooth" })));
    renderResourceCategories();
    document.addEventListener("quilo:taxonomies-change", (event) => {
      const catalog = event.detail || fallbackTaxonomyCatalog();
      categoryValues = [...catalog.resource.category];
      if (state.category && !categoryValues.includes(state.category)) state.category = "";
      renderResourceCategories();
      render();
    });

    async function loadRequests() {
      try {
        const path = canManage ? "/resource-requests/manage?limit=100" : "/resource-requests?limit=100";
        const payload = await api(path);
        state.requests = arrayFrom(payload, ["requests", "items"]).map(normalizeRequest);
        renderRequests();
      } catch (error) {
        if (error.status !== 401 && canManage) showToast(error.message, true);
      }
    }

    function renderRequests() {
      const section = $("#requestHistory");
      const requestList = $("[data-request-list]");
      if (!section || !requestList) return;
      section.hidden = !state.requests.length && !canManage;
      $("[data-request-history-title]").textContent = canManage ? "자료 요청 관리" : "내 자료 요청";
      requestList.replaceChildren();
      if (!state.requests.length) { requestList.append(emptyState("접수된 요청이 없습니다", "새 요청이 들어오면 이곳에서 확인할 수 있습니다.")); return; }
      for (const request of state.requests) {
        const row = document.createElement("article");
        row.className = "ed-request-row";
        const copy = document.createElement("div");
        const title = document.createElement("h3"); title.textContent = request.title;
        const detail = document.createElement("p"); detail.textContent = `${request.category} · ${request.authorName} · ${formatDate(request.createdAt)}${request.details ? ` — ${request.details}` : ""}`;
        copy.append(title, detail);
        const side = document.createElement("div"); side.className = "ed-request-row__side";
        const badge = document.createElement("span"); badge.className = "ed-request-status"; badge.dataset.status = request.status; badge.textContent = requestStatusLabel(request.status); side.append(badge);
        if (canManage) {
          const select = document.createElement("select");
          select.setAttribute("aria-label", `${request.title} 상태 변경`);
          for (const [value, label] of [["open","접수"],["reviewing","검토 중"],["planned","제작 예정"],["fulfilled","완료"],["declined","반려"]]) {
            const option = document.createElement("option"); option.value = value; option.textContent = label; option.selected = request.status === value; select.append(option);
          }
          select.addEventListener("change", async () => {
            select.disabled = true;
            try {
              const payload = await api(`/resource-requests/${encodeURIComponent(request.id)}/status`, { method: "PATCH", body: { status: select.value } });
              const updated = normalizeRequest(oneFrom(payload, ["request", "item"]));
              Object.assign(request, updated);
              renderRequests();
              showToast("요청 상태를 변경했습니다.");
            } catch (error) { select.value = request.status; showToast(error.message, true); }
            finally { select.disabled = false; }
          });
          side.append(select);
        }
        row.append(copy, side); requestList.append(row);
      }
    }

    $("#requestForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const formStatus = $("#requestFormStatus");
      if (!session) {
        formStatus.textContent = "자료 요청을 보내려면 로그인이 필요합니다.";
        showToast("로그인 후 자료를 요청할 수 있습니다.", true);
        return;
      }
      const button = $('button[type="submit"]', form);
      button.disabled = true;
      formStatus.textContent = "요청을 보내는 중입니다.";
      try {
        await api("/resource-requests", { method: "POST", body: { title: $("#requestTitleInput").value, category: $("#requestCategory").value, details: $("#requestDescription").value } });
        form.reset();
        formStatus.textContent = "요청이 접수되었습니다. 진행 상태는 아래에서 확인할 수 있습니다.";
        showToast("자료 요청을 접수했습니다.");
        await loadRequests();
      } catch (error) { formStatus.textContent = error.message; showToast(error.message, true); }
      finally { button.disabled = false; }
    });
    $("[data-refresh-requests]")?.addEventListener("click", loadRequests);

    try {
      const payload = await api("/posts?kind=resource&limit=100");
      state.posts = arrayFrom(payload, ["posts", "items"]).map(normalizePost);
      await Promise.all(state.posts.map(hydrateAttachments));
      status.textContent = "";
      render();
    } catch (error) {
      status.textContent = error.message;
      list.replaceChildren(emptyState("자료를 불러오지 못했습니다", "잠시 후 다시 시도해 주세요."));
      count.textContent = "자료 목록을 확인할 수 없습니다.";
    }
    if (session || canManage) await loadRequests();
    else renderRequests();
  }

  function requestStatusLabel(status) {
    return ({ open: "접수", reviewing: "검토 중", planned: "제작 예정", fulfilled: "완료", completed: "완료", declined: "반려", in_progress: "검토 중" })[status] || "접수";
  }

  async function setupWriteTaxonomyControls() {
    const kindSelect = $("#kindSelect");
    const categorySelect = $("#categorySelect");
    const tagInput = $("#tagInput");
    const suggestions = $("#tagSuggestions");
    if (!kindSelect || !categorySelect || !tagInput || !suggestions) return;
    let catalog = await loadTaxonomies();
    let rendering = false;

    function selectedTags() {
      return new Set(normalizeTags(tagInput.value).map((tag) => tag.toLocaleLowerCase("ko-KR")));
    }

    function renderSuggestions(kind) {
      suggestions.replaceChildren();
      const chosen = selectedTags();
      for (const topic of catalog[kind].topic) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = topic;
        const key = topic.toLocaleLowerCase("ko-KR");
        button.setAttribute("aria-pressed", String(chosen.has(key)));
        button.addEventListener("click", () => {
          const values = normalizeTags(tagInput.value);
          const index = values.findIndex((value) => value.toLocaleLowerCase("ko-KR") === key);
          if (index >= 0) values.splice(index, 1);
          else if (values.length < 8) values.push(topic);
          else { showToast("태그는 최대 8개까지 선택할 수 있습니다.", true); return; }
          tagInput.value = values.join(", ");
          tagInput.dispatchEvent(new Event("input", { bubbles: true }));
          renderSuggestions(kindSelect.value === "resource" ? "resource" : "developer");
        });
        suggestions.append(button);
      }
    }

    function render({ preserve = true } = {}) {
      if (rendering) return;
      rendering = true;
      const kind = kindSelect.value === "resource" ? "resource" : "developer";
      const previous = preserve ? categorySelect.value : "";
      categorySelect.replaceChildren();
      for (const category of catalog[kind].category) {
        const option = document.createElement("option");
        option.value = category;
        option.textContent = category;
        categorySelect.append(option);
      }
      if ([...categorySelect.options].some((option) => option.value === previous)) categorySelect.value = previous;
      const adminButton = $('[data-manage-taxonomies]', document.querySelector('[data-taxonomy-admin-section]') || document);
      if (adminButton) adminButton.dataset.taxonomyKind = kind;
      renderSuggestions(kind);
      rendering = false;
    }

    kindSelect.addEventListener("change", () => queueMicrotask(() => render({ preserve: false })));
    tagInput.addEventListener("input", () => renderSuggestions(kindSelect.value === "resource" ? "resource" : "developer"));
    document.addEventListener("quilo:taxonomies-change", (event) => {
      catalog = event.detail || fallbackTaxonomyCatalog();
      queueMicrotask(() => render());
    });
    const observer = new MutationObserver(() => {
      if (rendering) return;
      const kind = kindSelect.value === "resource" ? "resource" : "developer";
      const actual = [...categorySelect.options].map((option) => option.value);
      const expected = catalog[kind].category;
      if (actual.join("\u0000") !== expected.join("\u0000")) queueMicrotask(() => render());
    });
    observer.observe(categorySelect, { childList: true });
    setTimeout(() => render(), 0);
  }

  const sessionPromise = loadSession();
  window.QuiloEditorial = {
    API_ROOT,
    api,
    cleanText,
    formatBytes,
    loadTaxonomies,
    normalizeAttachment,
    normalizePost,
    safeUrl,
    sanitizeHtml,
    sanitizeToFragment,
    session: sessionPromise,
    showToast,
  };

  document.addEventListener("DOMContentLoaded", async () => {
    const session = await sessionPromise;
    setupSharedChrome(session);
    if (page === "notes") await initNotes(session);
    else if (page === "article") await initArticle(session);
    else if (page === "resources") await initResources(session);
    else if (page === "write") await setupWriteTaxonomyControls();
  });
})();
