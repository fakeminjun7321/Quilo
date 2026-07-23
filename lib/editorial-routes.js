"use strict";

const express = require("express");
const content = require("./editorial-content");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createEditorialRouter({
  requireAuth,
  requireAdmin,
  getSessionUser,
  refreshSessionUser,
  upload,
}) {
  for (const [name, dependency] of Object.entries({ requireAuth, requireAdmin, getSessionUser })) {
    if (typeof dependency !== "function") throw new TypeError(`editorial-routes: ${name} 의존성이 필요합니다.`);
  }
  if (!upload || typeof upload.single !== "function") {
    throw new TypeError("editorial-routes: upload 의존성이 필요합니다.");
  }

  const router = express.Router();
  const sessionRefresh = typeof refreshSessionUser === "function" ? refreshSessionUser : async (req) => getSessionUser(req);

  function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  }

  function errorResponse(error, req, res, _next) {
    if (res.headersSent) return _next(error);
    const status = Number(error && error.status) || 500;
    const code = error && error.code || "EDITORIAL_INTERNAL_ERROR";
    if (status >= 500 && code !== "EDITORIAL_SCHEMA_MISSING" &&
      code !== "EDITORIAL_TAXONOMY_SCHEMA_MISSING" && code !== "EDITORIAL_STORAGE_UNAVAILABLE") {
      console.error("[editorial]", req.method, req.originalUrl, error);
    }
    const message = error && error.message || "편집 콘텐츠 처리 중 오류가 발생했습니다.";
    return res.status(status).json({ error: message, code });
  }

  function uuid(value, label = "ID") {
    const id = String(value || "");
    if (!UUID_RE.test(id)) {
      throw new content.EditorialError(`올바른 ${label}가 아닙니다.`, {
        code: "EDITORIAL_INVALID_ID",
        status: 400,
      });
    }
    return id;
  }

  function notFound(message, code) {
    throw new content.EditorialError(message, { code, status: 404 });
  }

  function forbidden(message = "이 작업을 수행할 권한이 없습니다.") {
    throw new content.EditorialError(message, { code: "EDITORIAL_FORBIDDEN", status: 403 });
  }

  function activeFilter(value) {
    if (value === undefined || value === null || value === "" || String(value).toLowerCase() === "all") return null;
    const normalized = String(value).trim().toLowerCase();
    if (["true", "1", "active"].includes(normalized)) return true;
    if (["false", "0", "inactive"].includes(normalized)) return false;
    throw new content.EditorialError("활성 상태 필터는 all, true 또는 false여야 합니다.", {
      code: "EDITORIAL_TAXONOMY_VALIDATION_ERROR",
      status: 400,
    });
  }

  function adminActorId(req) {
    const user = getSessionUser(req);
    return user && user.id || null;
  }

  async function currentIdentity(req) {
    let user = getSessionUser(req);
    if (!user) return { user: null, roles: null };
    try {
      // refresh가 세션을 무효화해 null을 반환한 경우, 요청 시작 시의 stale 사용자를
      // 되살리지 않는다. 비밀번호 변경·계정 삭제 직후 권한이 남는 문제를 막는다.
      user = await sessionRefresh(req, { failClosed: true });
    } catch (error) {
      throw new content.EditorialError("로그인 정보를 확인하지 못했습니다.", {
        code: "EDITORIAL_AUTH_REFRESH_FAILED",
        status: 503,
        cause: error,
      });
    }
    if (!user || !user.id) return { user: null, roles: null };
    const roles = await content.getUserRoles(user.id);
    if (!roles) {
      throw new content.EditorialError("사용자 계정을 찾을 수 없습니다.", {
        code: "EDITORIAL_USER_NOT_FOUND",
        status: 401,
      });
    }
    return { user: { ...user, id: roles.id, name: roles.name || user.name }, roles };
  }

  async function authenticatedIdentity(req) {
    const identity = await currentIdentity(req);
    if (!identity.user) {
      throw new content.EditorialError("로그인이 필요합니다.", {
        code: "EDITORIAL_AUTH_REQUIRED",
        status: 401,
      });
    }
    return identity;
  }

  function isPublished(post) {
    return !!post && post.status === "published" && !!post.published_at &&
      new Date(post.published_at).getTime() <= Date.now();
  }

  async function mayReadPost(req, post) {
    if (isPublished(post)) return true;
    const identity = await currentIdentity(req);
    return !!identity.user && (identity.roles.isAdmin || post.author_id === identity.user.id);
  }

  function mayEditPost(identity, post, nextKind = post.kind) {
    if (!identity || !identity.user || !post) return false;
    if (identity.roles.isAdmin) return true;
    return post.author_id === identity.user.id &&
      content.canWriteKind(identity.roles, post.kind) &&
      content.canWriteKind(identity.roles, nextKind);
  }

  function uploadOne(req, res, next) {
    const contentLength = Number(req.headers["content-length"] || 0);
    // 일반적인 multipart 경계/헤더 여유를 포함해, 파일 제한보다 터무니없이 큰 요청은
    // multer가 메모리에 담기 전에 거절한다. 최종 파일 크기는 validateAttachment가 재검증한다.
    if (Number.isFinite(contentLength) && contentLength > content.MAX_ATTACHMENT_BYTES + 1024 * 1024) {
      return res.status(413).json({
        error: "첨부 파일은 8MB 이하여야 합니다.",
        code: "EDITORIAL_ATTACHMENT_TOO_LARGE",
      });
    }
    upload.single("file")(req, res, (error) => {
      if (!error) return next();
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? "첨부 파일은 8MB 이하여야 합니다." : "첨부 파일을 처리하지 못했습니다.",
        code: tooLarge ? "EDITORIAL_ATTACHMENT_TOO_LARGE" : "EDITORIAL_UPLOAD_ERROR",
      });
    });
  }

  function uploadAvatarOne(req, res, next) {
    const contentLength = Number(req.headers["content-length"] || 0);
    if (Number.isFinite(contentLength) && contentLength > content.MAX_AVATAR_INPUT_BYTES + 1024 * 1024) {
      return res.status(413).json({
        error: "프로필 이미지는 5MB 이하여야 합니다.",
        code: "EDITORIAL_AVATAR_TOO_LARGE",
      });
    }
    upload.single("avatar")(req, res, (error) => {
      if (!error) return next();
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? "프로필 이미지는 5MB 이하여야 합니다." : "프로필 이미지를 처리하지 못했습니다.",
        code: tooLarge ? "EDITORIAL_AVATAR_TOO_LARGE" : "EDITORIAL_UPLOAD_ERROR",
      });
    });
  }

  // ── 공개 글 ───────────────────────────────────────────────────────────────

  router.get("/taxonomies", asyncRoute(async (req, res) => {
    let taxonomies;
    try {
      taxonomies = await content.listTaxonomies({
        kind: req.query.kind || null,
        type: req.query.type || null,
        activeOnly: true,
      });
    } catch (error) {
      if (error?.code !== "EDITORIAL_STORAGE_UNAVAILABLE") throw error;
      taxonomies = [];
    }
    res.json({ taxonomies, groups: content.groupTaxonomies(taxonomies) });
  }));

  router.get("/posts", asyncRoute(async (req, res) => {
    let posts;
    try {
      posts = await content.listPublishedPosts({
        kind: req.query.kind ? content.normalizePostKind(req.query.kind) : null,
        category: req.query.category ? String(req.query.category) : null,
        tag: req.query.tag ? String(req.query.tag) : null,
        search: req.query.q ? String(req.query.q) : null,
        limit: req.query.limit,
        offset: req.query.offset,
      });
    } catch (error) {
      if (error?.code !== "EDITORIAL_STORAGE_UNAVAILABLE") throw error;
      posts = [];
    }
    res.json({ posts });
  }));

  router.get("/posts/:slug", asyncRoute(async (req, res) => {
    const post = await content.getPublishedPostBySlug(req.params.slug);
    if (!post) return res.status(404).json({ error: "글을 찾을 수 없습니다.", code: "EDITORIAL_POST_NOT_FOUND" });
    res.json({ post });
  }));

  router.get("/profiles/:userId", asyncRoute(async (req, res) => {
    const profile = await content.getUserRoles(uuid(req.params.userId, "사용자 ID"));
    if (!profile) return res.status(404).json({ error: "사용자를 찾을 수 없습니다.", code: "EDITORIAL_USER_NOT_FOUND" });
    res.json({
      profile: {
        id: profile.id,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        profileBio: profile.profileBio,
        badges: [profile.isDeveloper ? "developer" : null, profile.isStaff ? "staff" : null].filter(Boolean),
      },
    });
  }));

  // ── 내 프로필과 작성 권한 ─────────────────────────────────────────────────

  router.get("/me/profile", requireAuth, asyncRoute(async (req, res) => {
    const { roles } = await authenticatedIdentity(req);
    res.json({ profile: roles });
  }));

  router.patch("/me/profile", requireAuth, asyncRoute(async (req, res) => {
    const { user } = await authenticatedIdentity(req);
    const profile = await content.updateProfile(user.id, {
      avatarUrl: req.body && req.body.avatarUrl,
      profileBio: req.body && req.body.profileBio,
    });
    await sessionRefresh(req).catch(() => null);
    res.json({ ok: true, profile });
  }));

  router.post("/me/avatar", requireAuth, asyncRoute(async (req, _res, next) => {
    req.editorialIdentity = await authenticatedIdentity(req);
    next();
  }), uploadAvatarOne, asyncRoute(async (req, res) => {
    if (!req.file) {
      throw new content.EditorialError("업로드할 프로필 이미지를 선택하세요.", {
        code: "EDITORIAL_INVALID_AVATAR",
        status: 400,
      });
    }
    const profile = await content.saveAvatarImage(req.editorialIdentity.user.id, req.file);
    await sessionRefresh(req).catch(() => null);
    res.json({ profile });
  }));

  router.get("/me/capabilities", requireAuth, asyncRoute(async (req, res) => {
    const { roles } = await authenticatedIdentity(req);
    res.json({
      capabilities: {
        writeDeveloperNotes: content.canWriteKind(roles, "developer"),
        writeResources: content.canWriteKind(roles, "resource"),
        manageResourceRequests: content.canManageRequests(roles),
        administerRoles: roles.isAdmin,
      },
      profile: roles,
    });
  }));

  // ── 내 글 / 글 CRUD ────────────────────────────────────────────────────────

  router.get("/me/posts", requireAuth, asyncRoute(async (req, res) => {
    const { user } = await authenticatedIdentity(req);
    const posts = await content.listOwnPosts(user.id, {
      status: req.query.status ? String(req.query.status) : null,
      kind: req.query.kind ? content.normalizePostKind(req.query.kind) : null,
      limit: req.query.limit,
    });
    res.json({ posts });
  }));

  router.get("/me/posts/:id", requireAuth, asyncRoute(async (req, res) => {
    const { user, roles } = await authenticatedIdentity(req);
    const post = await content.getPostById(uuid(req.params.id, "글 ID"));
    if (!post) notFound("글을 찾을 수 없습니다.", "EDITORIAL_POST_NOT_FOUND");
    if (!roles.isAdmin && post.author_id !== user.id) forbidden();
    const attachments = await content.listAttachments(post.id);
    res.json({ post, attachments });
  }));

  router.post("/posts", requireAuth, asyncRoute(async (req, res) => {
    const identity = await authenticatedIdentity(req);
    const kind = content.normalizePostKind(req.body && req.body.kind);
    if (!content.canWriteKind(identity.roles, kind)) {
      forbidden(kind === "developer" ? "Quilo 개발자만 개발 노트를 작성할 수 있습니다." : "스탭 또는 관리자만 자료실 글을 작성할 수 있습니다.");
    }
    const post = await content.createPost(identity.user, req.body || {});
    res.status(201).json({ ok: true, post });
  }));

  router.patch("/posts/:id", requireAuth, asyncRoute(async (req, res) => {
    const identity = await authenticatedIdentity(req);
    const postId = uuid(req.params.id, "글 ID");
    const existing = await content.getPostById(postId);
    if (!existing) notFound("글을 찾을 수 없습니다.", "EDITORIAL_POST_NOT_FOUND");
    const nextKind = req.body && req.body.kind !== undefined
      ? content.normalizePostKind(req.body.kind)
      : existing.kind;
    if (!mayEditPost(identity, existing, nextKind)) forbidden();
    const post = await content.updatePost(postId, req.body || {}, existing);
    res.json({ ok: true, post });
  }));

  router.delete("/posts/:id", requireAuth, asyncRoute(async (req, res) => {
    const identity = await authenticatedIdentity(req);
    const postId = uuid(req.params.id, "글 ID");
    const existing = await content.getPostById(postId);
    if (!existing) notFound("글을 찾을 수 없습니다.", "EDITORIAL_POST_NOT_FOUND");
    if (!mayEditPost(identity, existing)) forbidden();
    await content.deletePost(postId);
    res.json({ ok: true });
  }));

  // ── 첨부 ──────────────────────────────────────────────────────────────────

  router.get("/posts/:id/attachments", asyncRoute(async (req, res) => {
    const post = await content.getPostById(uuid(req.params.id, "글 ID"));
    if (!post) notFound("글을 찾을 수 없습니다.", "EDITORIAL_POST_NOT_FOUND");
    if (!(await mayReadPost(req, post))) forbidden();
    const attachments = await content.listAttachments(post.id);
    res.json({ attachments });
  }));

  router.post("/posts/:id/attachments", requireAuth, asyncRoute(async (req, _res, next) => {
    const identity = await authenticatedIdentity(req);
    const postId = uuid(req.params.id, "글 ID");
    const post = await content.getPostById(postId);
    if (!post) notFound("글을 찾을 수 없습니다.", "EDITORIAL_POST_NOT_FOUND");
    if (!mayEditPost(identity, post)) forbidden();
    req.editorialUpload = { identity, postId };
    next();
  }), uploadOne, asyncRoute(async (req, res) => {
    const { identity, postId } = req.editorialUpload;
    if (!req.file) throw new content.EditorialError("첨부할 파일을 선택하세요.", { code: "EDITORIAL_INVALID_ATTACHMENT", status: 400 });
    const attachment = await content.createAttachment({ postId, userId: identity.user.id, file: req.file });
    res.status(201).json({
      ok: true,
      attachment: {
        ...attachment,
        downloadUrl: `/api/editorial/attachments/${attachment.id}/download`,
        inlineUrl: attachment.mime_type.startsWith("image/")
          ? `/api/editorial/attachments/${attachment.id}/download?inline=1`
          : null,
      },
    });
  }));

  router.get("/attachments/:id/download", asyncRoute(async (req, res) => {
    const attachment = await content.getAttachment(uuid(req.params.id, "첨부 ID"), { includeData: true });
    if (!attachment) notFound("첨부 파일을 찾을 수 없습니다.", "EDITORIAL_ATTACHMENT_NOT_FOUND");
    const post = attachment.post;
    if (!post || !(await mayReadPost(req, post))) forbidden();
    const binary = Buffer.from(String(attachment.data_base64 || ""), "base64");
    if (!binary.length || binary.length !== attachment.size_bytes) {
      throw new content.EditorialError("첨부 파일 데이터가 손상되었습니다.", {
        code: "EDITORIAL_ATTACHMENT_CORRUPT",
        status: 500,
      });
    }
    const inline = req.query.inline === "1" && String(attachment.mime_type).startsWith("image/");
    const asciiName = String(attachment.filename).replace(/[^a-z0-9._-]/gi, "_").slice(0, 100) || "download";
    res.set({
      "Content-Type": attachment.mime_type,
      "Content-Length": String(binary.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
    res.send(binary);
  }));

  router.delete("/attachments/:id", requireAuth, asyncRoute(async (req, res) => {
    const identity = await authenticatedIdentity(req);
    const attachmentId = uuid(req.params.id, "첨부 ID");
    const attachment = await content.getAttachment(attachmentId);
    if (!attachment) notFound("첨부 파일을 찾을 수 없습니다.", "EDITORIAL_ATTACHMENT_NOT_FOUND");
    const post = attachment.post || await content.getPostById(attachment.post_id);
    if (!post || !mayEditPost(identity, post)) forbidden();
    await content.deleteAttachment(attachmentId);
    res.json({ ok: true });
  }));

  // ── 자료 요청 ─────────────────────────────────────────────────────────────

  router.get("/resource-requests", requireAuth, asyncRoute(async (req, res) => {
    const { user } = await authenticatedIdentity(req);
    const requests = await content.listResourceRequests({
      userId: user.id,
      status: req.query.status ? String(req.query.status) : null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ requests });
  }));

  router.post("/resource-requests", requireAuth, asyncRoute(async (req, res) => {
    const { user } = await authenticatedIdentity(req);
    const request = await content.createResourceRequest(user, req.body || {});
    res.status(201).json({ ok: true, request });
  }));

  router.get("/resource-requests/manage", requireAuth, asyncRoute(async (req, res) => {
    const { roles } = await authenticatedIdentity(req);
    if (!content.canManageRequests(roles)) forbidden("스탭 또는 관리자만 요청 관리 목록을 볼 수 있습니다.");
    const requests = await content.listResourceRequests({
      manage: true,
      status: req.query.status ? String(req.query.status) : null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ requests });
  }));

  router.patch("/resource-requests/:id/status", requireAuth, asyncRoute(async (req, res) => {
    const { user, roles } = await authenticatedIdentity(req);
    if (!content.canManageRequests(roles)) forbidden("스탭 또는 관리자만 요청 상태를 변경할 수 있습니다.");
    const patch = { ...(req.body || {}) };
    if (patch.linkedPostId) patch.linkedPostId = uuid(patch.linkedPostId, "연결 글 ID");
    const request = await content.updateResourceRequest(uuid(req.params.id, "자료 요청 ID"), user.id, patch);
    res.json({ ok: true, request });
  }));

  // ── 관리자 편집 분류 ─────────────────────────────────────────────────────

  router.get("/admin/taxonomies", requireAdmin, asyncRoute(async (req, res) => {
    const taxonomies = await content.listTaxonomies({
      kind: req.query.kind || null,
      type: req.query.type || null,
      activeOnly: activeFilter(req.query.active),
    });
    res.json({ taxonomies, groups: content.groupTaxonomies(taxonomies) });
  }));

  router.post("/admin/taxonomies", requireAdmin, asyncRoute(async (req, res) => {
    const taxonomy = await content.createTaxonomy(req.body || {}, adminActorId(req));
    res.status(201).json({ ok: true, taxonomy });
  }));

  // :id 라우트보다 먼저 선언해 "reorder"가 ID로 해석되지 않게 한다.
  router.patch("/admin/taxonomies/reorder", requireAdmin, asyncRoute(async (req, res) => {
    const taxonomies = await content.reorderTaxonomies(req.body && req.body.items, adminActorId(req));
    res.json({ ok: true, taxonomies, groups: content.groupTaxonomies(taxonomies) });
  }));

  router.patch("/admin/taxonomies/:id", requireAdmin, asyncRoute(async (req, res) => {
    const taxonomy = await content.updateTaxonomy(
      uuid(req.params.id, "분류 ID"),
      req.body || {},
      adminActorId(req),
    );
    res.json({ ok: true, taxonomy });
  }));

  router.post("/admin/taxonomies/:id/activate", requireAdmin, asyncRoute(async (req, res) => {
    const taxonomy = await content.updateTaxonomy(
      uuid(req.params.id, "분류 ID"),
      { isActive: true },
      adminActorId(req),
    );
    res.json({ ok: true, taxonomy });
  }));

  router.post("/admin/taxonomies/:id/deactivate", requireAdmin, asyncRoute(async (req, res) => {
    const taxonomy = await content.updateTaxonomy(
      uuid(req.params.id, "분류 ID"),
      { isActive: false },
      adminActorId(req),
    );
    res.json({ ok: true, taxonomy });
  }));

  router.delete("/admin/taxonomies/:id", requireAdmin, asyncRoute(async (req, res) => {
    const result = await content.deleteTaxonomy(uuid(req.params.id, "분류 ID"), adminActorId(req));
    res.json({ ok: true, ...result });
  }));

  // ── 관리자 역할 부여/회수 ─────────────────────────────────────────────────

  router.get("/admin/roles", requireAdmin, asyncRoute(async (req, res) => {
    const users = await content.listRoleUsers({ limit: req.query.limit });
    res.json({ users });
  }));

  router.patch("/admin/users/:userId/roles", requireAdmin, asyncRoute(async (req, res) => {
    const userId = uuid(req.params.userId, "사용자 ID");
    const roles = await content.updateUserRoles(userId, {
      isStaff: req.body && req.body.isStaff,
      isDeveloper: req.body && req.body.isDeveloper,
    });
    const current = getSessionUser(req);
    if (current && current.id === userId) await sessionRefresh(req).catch(() => null);
    res.json({ ok: true, roles });
  }));

  router.use(errorResponse);
  return router;
}

module.exports = createEditorialRouter;
module.exports.createEditorialRouter = createEditorialRouter;
