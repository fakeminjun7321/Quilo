"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const sharp = require("sharp");
const editorial = require("../lib/editorial-content");
const createEditorialRouter = require("../lib/editorial-routes");

test("rich HTML sanitizer preserves editor formatting while removing executable markup", () => {
  const dirty = [
    '<h2 onclick="steal()" style="font-family:Pretendard;text-align:center;position:fixed">개발 팁</h2>',
    '<script><img src="https://evil.example/x" onerror="steal()">alert(1)</script>',
    '<p><strong>굵게</strong> <u>밑줄</u> <span style="font-size:18px;color:#123456;background-image:url(javascript:1)">본문 🙂</span></p>',
    '<a href="jav&#x61;script:alert(1)" target="_blank">위험</a>',
    '<a href="https://quilolab.com/guide" target="_blank">안전</a>',
    '<img src="/api/editorial/attachments/123/download?inline=1" onload="steal()" width="800">',
    '<iframe srcdoc="<script>alert(1)</script>">숨김</iframe>',
  ].join("");
  const clean = editorial.sanitizeRichHtml(dirty);

  assert.match(clean, /<h2 style="font-family:pretendard;text-align:center">개발 팁<\/h2>/);
  assert.match(clean, /<strong>굵게<\/strong>/);
  assert.match(clean, /font-size:18px;color:#123456/);
  assert.match(clean, /href="https:\/\/quilolab\.com\/guide" target="_blank" rel="noopener noreferrer nofollow"/);
  assert.match(clean, /src="\/api\/editorial\/attachments\/123\/download\?inline=1" width="800" loading="lazy"/);
  assert.doesNotMatch(clean, /script|iframe|onerror|onload|onclick|javascript|position|background-image|alert\(1\)|숨김/i);
});

test("sanitizer rejects encoded and whitespace-obfuscated dangerous URLs", () => {
  const clean = editorial.sanitizeRichHtml([
    '<a href="java&#x09;script:alert(1)">a</a>',
    '<img src="data:image/svg+xml,%3Csvg%20onload=alert(1)%3E">',
    '<a href="//evil.example/x">b</a>',
    '<a href="mailto:help@quilolab.com">mail</a>',
    '<svg><a href="https://evil.example">dropped</a></svg>',
  ].join(""));
  assert.equal(clean, '<a>a</a><img loading="lazy"><a>b</a><a href="mailto:help@quilolab.com">mail</a>');
});

test("post normalization creates stable Korean slugs, deduplicates tags and sanitizes HTML", () => {
  const post = editorial.normalizePostInput({
    kind: "developer",
    title: "  Quilo 개발 꿀팁  ",
    tags: ["#API", "api", "실험", ""],
    richHtml: '<p onmouseover="x()">안전한 본문</p>',
    status: "draft",
  });
  assert.equal(post.slug, "quilo-개발-꿀팁");
  assert.deepEqual(post.tags, ["API", "실험"]);
  assert.equal(post.rich_html, "<p>안전한 본문</p>");
  assert.equal(post.published_at, null);

  const transitional = editorial.normalizePostInput({
    kind: "developer_note",
    title: "전환기 입력",
    status: "draft",
  });
  assert.equal(transitional.kind, "developer");
});

test("developer, staff and admin permissions remain independent", () => {
  const developer = { isDeveloper: true, isStaff: false, isAdmin: false };
  const staff = { isDeveloper: false, isStaff: true, isAdmin: false };
  const admin = { isDeveloper: false, isStaff: false, isAdmin: true };
  assert.equal(editorial.canWriteKind(developer, "developer"), true);
  assert.equal(editorial.canWriteKind(developer, "resource"), false);
  assert.equal(editorial.canWriteKind(staff, "resource"), true);
  assert.equal(editorial.canWriteKind(staff, "developer"), false);
  assert.equal(editorial.canWriteKind(admin, "developer"), true);
  assert.equal(editorial.canWriteKind(admin, "resource"), true);
  assert.equal(editorial.canManageRequests(developer), false);
  assert.equal(editorial.canManageRequests(staff), true);
});

test("attachment validation checks size, filename, extension, MIME and file signature", () => {
  const pdf = Buffer.from("%PDF-1.7\nvalid fixture");
  const valid = editorial.validateAttachment({
    originalname: "실험 자료.pdf",
    mimetype: "application/pdf",
    size: pdf.length,
    buffer: pdf,
  });
  assert.equal(valid.filename, "실험 자료.pdf");
  assert.equal(valid.mimeType, "application/pdf");

  const fakePdf = Buffer.from("notapdf!");
  assert.throws(() => editorial.validateAttachment({
    originalname: "가짜.pdf", mimetype: "application/pdf", size: fakePdf.length, buffer: fakePdf,
  }), (error) => error.code === "EDITORIAL_INVALID_ATTACHMENT_MIME" && error.status === 415);
  const html = Buffer.from("<b>x</b>");
  assert.throws(() => editorial.validateAttachment({
    originalname: "payload.html", mimetype: "text/html", size: html.length, buffer: html,
  }), (error) => error.code === "EDITORIAL_INVALID_ATTACHMENT_MIME");
  assert.throws(() => editorial.validateAttachment({
    originalname: "notes.txt", mimetype: "text/plain", size: 3, buffer: Buffer.from([65, 0, 66]),
  }), (error) => error.code === "EDITORIAL_INVALID_ATTACHMENT_MIME");

  const huge = Buffer.alloc(editorial.MAX_ATTACHMENT_BYTES + 1, 65);
  assert.throws(() => editorial.validateAttachment({
    originalname: "large.txt", mimetype: "text/plain", size: huge.length, buffer: huge,
  }), (error) => error.code === "EDITORIAL_ATTACHMENT_TOO_LARGE" && error.status === 413);
});

test("avatar validation and processing verify real pixels and output a 512px WebP", async () => {
  const png = await sharp({
    create: { width: 900, height: 450, channels: 4, background: { r: 40, g: 90, b: 210, alpha: 1 } },
  }).png().toBuffer();
  const file = { originalname: "profile.png", mimetype: "image/png", size: png.length, buffer: png };
  const validated = editorial.validateAvatarInput(file);
  assert.equal(validated.sharpFormat, "png");

  const processed = await editorial.prepareAvatarImage(file);
  assert.equal(processed.mimeType, "image/webp");
  assert.ok(processed.buffer.length <= editorial.MAX_AVATAR_OUTPUT_BYTES);
  const metadata = await sharp(processed.buffer).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 512);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.throws(() => editorial.validateAvatarInput({
    originalname: "avatar.svg", mimetype: "image/svg+xml", size: svg.length, buffer: svg,
  }), (error) => error.code === "EDITORIAL_INVALID_AVATAR_MIME" && error.status === 415);

  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
  await assert.rejects(() => editorial.prepareAvatarImage({
    originalname: "fake.jpg", mimetype: "image/jpeg", size: fakeJpeg.length, buffer: fakeJpeg,
  }), (error) => error.code === "EDITORIAL_INVALID_AVATAR_DATA");
});

test("avatar storage reports a missing profile-images bucket as 503", async (t) => {
  const supa = require("../lib/supabase");
  const originalGetClient = supa.getClient;
  const png = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "#123456" },
  }).png().toBuffer();
  const query = {
    select() { return this; },
    eq() { return this; },
    maybeSingle() { return Promise.resolve({ data: { avatar_url: null }, error: null }); },
  };
  supa.getClient = () => ({
    from: () => Object.create(query),
    storage: {
      from: () => ({
        upload: async () => ({ error: { message: "Bucket not found" } }),
        getPublicUrl: () => ({ data: { publicUrl: "" } }),
        remove: async () => ({ error: null }),
      }),
    },
  });
  t.after(() => { supa.getClient = originalGetClient; });

  await assert.rejects(() => editorial.saveAvatarImage(
    "123e4567-e89b-42d3-a456-426614174000",
    { originalname: "avatar.png", mimetype: "image/png", size: png.length, buffer: png },
  ), (error) => error.code === "EDITORIAL_AVATAR_STORAGE_UNAVAILABLE" && error.status === 503);
});

test("database migration errors become an explicit 503 contract", () => {
  const source = { code: "PGRST204", message: "Could not find the 'is_staff' column of 'users' in the schema cache" };
  assert.equal(editorial.isSchemaMissingError(source), true);
  const error = editorial.dbError("권한 조회", source);
  assert.equal(error.status, 503);
  assert.equal(error.code, "EDITORIAL_SCHEMA_MISSING");
  assert.match(error.message, /20260714_add_editorial_platform\.sql/);
});

test("taxonomy input accepts tag aliases and validates names, slugs and ordering", () => {
  const normalized = editorial.normalizeTaxonomyInput({
    kind: "developer_note",
    type: "tag",
    name: "  API · 자동화  ",
    sortOrder: "12",
    isActive: true,
  });
  assert.deepEqual(normalized, {
    kind: "developer",
    type: "topic",
    name: "API · 자동화",
    slug: "api-자동화",
    sort_order: 12,
    is_active: true,
  });

  assert.equal(editorial.normalizeTaxonomyType("tags"), "topic");
  assert.equal(editorial.normalizeTaxonomySlug(undefined, "물리 실험 자료"), "물리-실험-자료");
  assert.throws(
    () => editorial.normalizeTaxonomyInput({ kind: "unknown", type: "category", name: "기타" }),
    (error) => error.code === "EDITORIAL_TAXONOMY_VALIDATION_ERROR" && error.status === 400,
  );
  assert.throws(
    () => editorial.normalizeTaxonomyInput({ kind: "resource", type: "label", name: "기타" }),
    (error) => error.code === "EDITORIAL_TAXONOMY_VALIDATION_ERROR",
  );
  assert.throws(
    () => editorial.normalizeTaxonomyInput({ kind: "resource", type: "topic", name: " ", slug: "bad slug" }),
    (error) => error.code === "EDITORIAL_TAXONOMY_VALIDATION_ERROR",
  );
  assert.throws(
    () => editorial.normalizeTaxonomySlug("bad/slug"),
    (error) => error.code === "EDITORIAL_TAXONOMY_VALIDATION_ERROR",
  );
  assert.throws(
    () => editorial.normalizeTaxonomyInput({ kind: "resource", type: "topic", name: "자료", sortOrder: 1.5 }),
    (error) => error.code === "EDITORIAL_TAXONOMY_VALIDATION_ERROR",
  );
  assert.throws(
    () => editorial.normalizeTaxonomyInput({ kind: "resource", type: "topic", name: "자료", isActive: "true" }),
    (error) => error.code === "EDITORIAL_TAXONOMY_VALIDATION_ERROR",
  );
});

test("taxonomy reorder rejects duplicate IDs and response groups retain legacy post field mapping", () => {
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(editorial.normalizeTaxonomyReorder([
    { id: firstId, sortOrder: 20 },
    { id: secondId, sort_order: -5 },
  ]), [
    { id: firstId, sort_order: 20 },
    { id: secondId, sort_order: -5 },
  ]);
  assert.throws(
    () => editorial.normalizeTaxonomyReorder([
      { id: firstId, sortOrder: 0 },
      { id: firstId, sortOrder: 1 },
    ]),
    (error) => error.code === "EDITORIAL_TAXONOMY_VALIDATION_ERROR",
  );

  const topic = editorial.taxonomyShape({
    id: firstId,
    kind: "developer",
    type: "topic",
    slug: "api",
    name: "API",
    sort_order: 20,
    is_active: true,
  });
  const category = editorial.taxonomyShape({
    id: secondId,
    kind: "resource",
    type: "category",
    slug: "physics",
    name: "물리",
    sort_order: -5,
    is_active: true,
  });
  assert.equal(topic.value, "API");
  assert.equal(topic.postField, "tags");
  assert.equal(category.postField, "category");
  assert.deepEqual(editorial.groupTaxonomies([topic, category]), {
    developer: { categories: [], topics: [topic] },
    resource: { categories: [category], topics: [] },
  });
});

test("post taxonomy validation rejects values outside the active admin vocabulary", async (t) => {
  const supa = require("../lib/supabase");
  const originalGetClient = supa.getClient;
  const rows = [
    { id: "11111111-1111-4111-8111-111111111111", kind: "developer", type: "category", slug: "development", name: "개발", sort_order: 10, is_active: true },
    { id: "22222222-2222-4222-8222-222222222222", kind: "developer", type: "topic", slug: "api", name: "API", sort_order: 10, is_active: true },
  ];
  supa.getClient = () => ({
    from(table) {
      assert.equal(table, "editorial_taxonomies");
      const query = {
        select() { return this; },
        order() { return this; },
        eq() { return this; },
        then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject); },
      };
      return query;
    },
  });
  t.after(() => { supa.getClient = originalGetClient; });

  await assert.doesNotReject(() => editorial.assertPostTaxonomies("developer", "개발", ["API"]));
  await assert.rejects(
    () => editorial.assertPostTaxonomies("developer", "임의 분류", ["API"]),
    (error) => error.code === "EDITORIAL_TAXONOMY_INVALID_CATEGORY" && error.status === 400,
  );
  await assert.rejects(
    () => editorial.assertPostTaxonomies("developer", "개발", ["임의 주제"]),
    (error) => error.code === "EDITORIAL_TAXONOMY_INVALID_TOPIC" && error.status === 400,
  );
});

test("resource request routes keep personal request history authenticated and user-scoped", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/editorial-routes.js"), "utf8");
  assert.match(source, /router\.get\("\/resource-requests", requireAuth/);
  assert.match(source, /listResourceRequests\(\{\s*userId: user\.id/);
});

test("taxonomy migration errors identify the exact required migration", () => {
  const source = {
    code: "PGRST205",
    message: "Could not find the table 'public.editorial_taxonomies' in the schema cache",
  };
  const error = editorial.dbError("분류 목록 조회", source);
  assert.equal(error.status, 503);
  assert.equal(error.code, "EDITORIAL_TAXONOMY_SCHEMA_MISSING");
  assert.match(error.message, /20260715_add_editorial_taxonomies\.sql/);
});

test("safe taxonomy deletion consumes the atomic RPC result and preserves used post values", async (t) => {
  const supa = require("../lib/supabase");
  const originalGetClient = supa.getClient;
  const taxonomyId = "33333333-3333-4333-8333-333333333333";
  const adminId = "44444444-4444-4444-8444-444444444444";
  let rpcCall = null;
  supa.getClient = () => ({
    rpc: async (name, args) => {
      rpcCall = { name, args };
      return {
        data: {
          taxonomy: {
            id: taxonomyId,
            kind: "resource",
            type: "category",
            slug: "physics",
            name: "물리",
            sort_order: 1,
            is_active: false,
          },
          deleted: false,
          deactivated: true,
          inUseCount: 7,
        },
        error: null,
      };
    },
  });
  t.after(() => { supa.getClient = originalGetClient; });

  const result = await editorial.deleteTaxonomy(taxonomyId, adminId);
  assert.deepEqual(rpcCall, {
    name: "delete_editorial_taxonomy_safely",
    args: { p_id: taxonomyId, p_updated_by: adminId },
  });
  assert.equal(result.deleted, false);
  assert.equal(result.deactivated, true);
  assert.equal(result.inUseCount, 7);
  assert.equal(result.taxonomy.isActive, false);
  assert.equal(result.taxonomy.postField, "category");
});

test("taxonomy routes expose active public data and admin CRUD with a stable contract", async (t) => {
  const adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const taxonomyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const taxonomy = {
    id: taxonomyId,
    kind: "developer",
    type: "topic",
    slug: "api",
    name: "API",
    value: "API",
    postField: "tags",
    sortOrder: 3,
    isActive: true,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
  const calls = [];
  const original = {
    listTaxonomies: editorial.listTaxonomies,
    createTaxonomy: editorial.createTaxonomy,
    updateTaxonomy: editorial.updateTaxonomy,
    reorderTaxonomies: editorial.reorderTaxonomies,
    deleteTaxonomy: editorial.deleteTaxonomy,
  };
  editorial.listTaxonomies = async (options) => {
    calls.push(["list", options]);
    return [taxonomy];
  };
  editorial.createTaxonomy = async (body, actorId) => {
    calls.push(["create", body, actorId]);
    return taxonomy;
  };
  editorial.updateTaxonomy = async (id, body, actorId) => {
    calls.push(["update", id, body, actorId]);
    return { ...taxonomy, ...body };
  };
  editorial.reorderTaxonomies = async (items, actorId) => {
    calls.push(["reorder", items, actorId]);
    return [{ ...taxonomy, sortOrder: items[0].sortOrder }];
  };
  editorial.deleteTaxonomy = async (id, actorId) => {
    calls.push(["delete", id, actorId]);
    return { taxonomy: { ...taxonomy, isActive: false }, deleted: false, deactivated: true, inUseCount: 4 };
  };
  t.after(() => Object.assign(editorial, original));

  const app = express();
  app.use(express.json());
  app.use("/api/editorial", createEditorialRouter({
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    getSessionUser: () => ({ id: adminId, name: "관리자" }),
    refreshSessionUser: async () => ({ id: adminId, name: "관리자" }),
    upload: { single: () => (_req, _res, next) => next() },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/editorial`;

  const publicResponse = await fetch(`${base}/taxonomies?kind=developer&type=tag`);
  assert.equal(publicResponse.status, 200);
  const publicBody = await publicResponse.json();
  assert.deepEqual(publicBody.taxonomies, [taxonomy]);
  assert.deepEqual(publicBody.groups.developer.topics, [taxonomy]);
  assert.deepEqual(calls.shift(), ["list", { kind: "developer", type: "tag", activeOnly: true }]);

  const adminList = await fetch(`${base}/admin/taxonomies?active=false`);
  assert.equal(adminList.status, 200);
  assert.deepEqual(calls.shift(), ["list", { kind: null, type: null, activeOnly: false }]);

  const badFilter = await fetch(`${base}/admin/taxonomies?active=maybe`);
  assert.equal(badFilter.status, 400);
  assert.equal((await badFilter.json()).code, "EDITORIAL_TAXONOMY_VALIDATION_ERROR");

  const create = await fetch(`${base}/admin/taxonomies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "developer", type: "topic", name: "API" }),
  });
  assert.equal(create.status, 201);
  assert.equal((await create.json()).taxonomy.id, taxonomyId);
  assert.deepEqual(calls.shift(), [
    "create",
    { kind: "developer", type: "topic", name: "API" },
    adminId,
  ]);

  const reorder = await fetch(`${base}/admin/taxonomies/reorder`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ id: taxonomyId, sortOrder: 11 }] }),
  });
  assert.equal(reorder.status, 200);
  assert.equal((await reorder.json()).taxonomies[0].sortOrder, 11);
  assert.deepEqual(calls.shift(), ["reorder", [{ id: taxonomyId, sortOrder: 11 }], adminId]);

  const update = await fetch(`${base}/admin/taxonomies/${taxonomyId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: "api-tips" }),
  });
  assert.equal(update.status, 200);
  assert.deepEqual(calls.shift(), ["update", taxonomyId, { slug: "api-tips" }, adminId]);

  const deactivate = await fetch(`${base}/admin/taxonomies/${taxonomyId}/deactivate`, { method: "POST" });
  assert.equal(deactivate.status, 200);
  assert.equal((await deactivate.json()).taxonomy.isActive, false);
  assert.deepEqual(calls.shift(), ["update", taxonomyId, { isActive: false }, adminId]);

  const remove = await fetch(`${base}/admin/taxonomies/${taxonomyId}`, { method: "DELETE" });
  assert.equal(remove.status, 200);
  assert.deepEqual(await remove.json(), {
    ok: true,
    taxonomy: { ...taxonomy, isActive: false },
    deleted: false,
    deactivated: true,
    inUseCount: 4,
  });
  assert.deepEqual(calls.shift(), ["delete", taxonomyId, adminId]);
  assert.deepEqual(calls, []);
});

test("taxonomy administration routes remain admin-only", async (t) => {
  const app = express();
  app.use(express.json());
  app.use("/api/editorial", createEditorialRouter({
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, res) => res.status(403).json({ error: "관리자 전용", code: "ADMIN_REQUIRED" }),
    getSessionUser: () => null,
    refreshSessionUser: async () => null,
    upload: { single: () => (_req, _res, next) => next() },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/editorial/admin/taxonomies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "developer", type: "topic", name: "API" }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "ADMIN_REQUIRED");
});

test("router blocks cross-account draft edits and attachment downloads", async (t) => {
  const authorId = "11111111-1111-4111-8111-111111111111";
  const viewerId = "22222222-2222-4222-8222-222222222222";
  const postId = "33333333-3333-4333-8333-333333333333";
  const attachmentId = "44444444-4444-4444-8444-444444444444";
  const original = {
    getUserRoles: editorial.getUserRoles,
    getPostById: editorial.getPostById,
    getAttachment: editorial.getAttachment,
  };
  editorial.getUserRoles = async () => ({
    id: viewerId, name: "다른 사용자", isAdmin: false, isDeveloper: true, isStaff: false,
  });
  editorial.getPostById = async () => ({
    id: postId, kind: "developer", status: "draft", author_id: authorId, published_at: null,
  });
  editorial.getAttachment = async () => ({
    id: attachmentId,
    post_id: postId,
    filename: "secret.pdf",
    mime_type: "application/pdf",
    size_bytes: 10,
    data_base64: Buffer.from("top secret").toString("base64"),
    post: { id: postId, status: "draft", author_id: authorId, published_at: null },
  });
  t.after(() => Object.assign(editorial, original));

  const app = express();
  app.use(express.json());
  const viewer = { id: viewerId, name: "다른 사용자" };
  app.use("/api/editorial", createEditorialRouter({
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, res) => res.status(403).json({ error: "관리자 전용" }),
    getSessionUser: () => viewer,
    refreshSessionUser: async () => viewer,
    upload: { single: () => (_req, _res, next) => next() },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/editorial`;

  const draftDownload = await fetch(`${base}/attachments/${attachmentId}/download`);
  assert.equal(draftDownload.status, 403);
  assert.equal((await draftDownload.json()).code, "EDITORIAL_FORBIDDEN");

  const edit = await fetch(`${base}/posts/${postId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "가로채기" }),
  });
  assert.equal(edit.status, 403);
  assert.equal((await edit.json()).code, "EDITORIAL_FORBIDDEN");
});

test("router factory keeps public editorial reads available without storage and structures protected errors", async (t) => {
  assert.throws(() => createEditorialRouter({}), /requireAuth/);

  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SERVICE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
  t.after(() => {
    if (oldUrl == null) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = oldUrl;
    if (oldKey == null) delete process.env.SUPABASE_SERVICE_KEY;
    else process.env.SUPABASE_SERVICE_KEY = oldKey;
  });

  const requireAuth = (_req, res, next) => next ? next() : res.status(401).json({ error: "로그인이 필요합니다." });
  const requireAdmin = (_req, _res, next) => next();
  const upload = { single: () => (_req, _res, next) => next() };
  const app = express();
  app.use(express.json());
  app.use("/api/editorial", createEditorialRouter({
    requireAuth,
    requireAdmin,
    getSessionUser: () => null,
    refreshSessionUser: async () => null,
    upload,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const base = `http://127.0.0.1:${server.address().port}`;
  const posts = await fetch(`${base}/api/editorial/posts`);
  assert.equal(posts.status, 200);
  assert.deepEqual(await posts.json(), { posts: [] });

  const taxonomies = await fetch(`${base}/api/editorial/taxonomies`);
  assert.equal(taxonomies.status, 200);
  assert.deepEqual(await taxonomies.json(), {
    taxonomies: [],
    groups: {
      developer: { categories: [], topics: [] },
      resource: { categories: [], topics: [] },
    },
  });

  const unavailable = await fetch(`${base}/api/editorial/profiles/00000000-0000-4000-8000-000000000000`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    error: "편집 콘텐츠 저장소가 설정되지 않았습니다.",
    code: "EDITORIAL_STORAGE_UNAVAILABLE",
  });

  const invalidId = await fetch(`${base}/api/editorial/profiles/not-a-uuid`);
  assert.equal(invalidId.status, 400);
  assert.equal((await invalidId.json()).code, "EDITORIAL_INVALID_ID");
});
