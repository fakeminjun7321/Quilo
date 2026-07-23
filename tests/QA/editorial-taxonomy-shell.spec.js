const fs = require("fs");
const http = require("http");
const path = require("path");

function loadPlaywrightTest() {
  try {
    return require("@playwright/test");
  } catch (error) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const cacheKey = Object.keys(require.cache).find(
      (key) =>
        key.includes(`${marker}@playwright${path.sep}test${path.sep}`) ||
        key.includes(`${marker}playwright${path.sep}`),
    );
    if (!cacheKey) throw error;
    const root = cacheKey.slice(0, cacheKey.indexOf(marker) + marker.length);
    return require(path.join(root, "@playwright", "test"));
  }
}

const { test, expect } = loadPlaywrightTest();
const PUBLIC_DIR = path.join(process.cwd(), "public");
const LAB_ENTRIES = require(path.join(process.cwd(), "lib", "lab-content.json"));
const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};

let server;
let baseUrl;

function publicFile(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)) return null;
  return resolved;
}

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const file = publicFile(request.url || "/");
    if (!file) { response.writeHead(403).end(); return; }
    fs.readFile(file, (error, body) => {
      if (error) { response.writeHead(404, { "Content-Type": "text/plain" }).end("Not found"); return; }
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      response.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function taxonomyRows() {
  const groups = {
    developer: {
      category: ["Quilo 활용", "개발", "보고서 작성", "새 소식"],
      topic: [...new Set(["활용 팁", ...LAB_ENTRIES.map((entry) => entry.tag)])],
    },
    resource: {
      category: ["화학", "물리", "보고서 양식", "학습 자료", "도구", "기타"],
      topic: ["실험", "보고서", "수행평가", "문서 도구"],
    },
  };
  const rows = [];
  for (const [kind, values] of Object.entries(groups)) {
    for (const [type, names] of Object.entries(values)) {
      names.forEach((name, index) => rows.push({
        id: `${kind}-${type}-${index + 1}`,
        kind,
        type,
        slug: `${kind}-${type}-${index + 1}`,
        name,
        value: name,
        postField: type === "category" ? "category" : "tags",
        sortOrder: (index + 1) * 10,
        isActive: true,
      }));
    }
  }
  return rows;
}

function grouped(rows) {
  const output = { developer: { categories: [], topics: [] }, resource: { categories: [], topics: [] } };
  rows.filter((row) => row.isActive).sort((a, b) => a.sortOrder - b.sortOrder).forEach((row) => {
    output[row.kind][row.type === "category" ? "categories" : "topics"].push(row);
  });
  return output;
}

async function installFixtures(page, { admin = false } = {}) {
  const rows = taxonomyRows();
  const operations = [];
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== baseUrl) { await route.abort(); return; }
    if (url.pathname.startsWith("/assets/developer-notes/") && /\.(?:svg|png|webp)$/.test(url.pathname)) {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><rect width="800" height="450" fill="#edf4ff"/><path d="M90 300 270 110l150 150 110-90 180 160" fill="none" stroke="#0759ed" stroke-width="18"/></svg>' });
      return;
    }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }

    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
    if (url.pathname === "/api/me") {
      await json({ id: "admin-user", user: admin ? "관리자" : "테스트 사용자", isAdmin: admin }); return;
    }
    if (url.pathname === "/api/catalog") { await json({ features: [] }); return; }
    if (url.pathname === "/api/version") { await json({ version: "qa", shortCommit: "editorial" }); return; }
    if (url.pathname === "/api/editorial/me/capabilities") {
      await json({ capabilities: { writeDeveloperNotes: admin, writeResources: admin, manageResourceRequests: admin, administerRoles: admin }, profile: { id: "admin-user", name: admin ? "관리자" : "테스트 사용자", isAdmin: admin } }); return;
    }
    if (url.pathname === "/api/editorial/taxonomies") {
      const active = rows.filter((row) => row.isActive);
      await json({ taxonomies: active, groups: grouped(active) }); return;
    }
    if (url.pathname === "/api/editorial/admin/taxonomies" && request.method() === "GET") {
      const kind = url.searchParams.get("kind");
      const type = url.searchParams.get("type");
      await json({ taxonomies: rows.filter((row) => (!kind || row.kind === kind) && (!type || row.type === type)), groups: grouped(rows) }); return;
    }
    if (url.pathname === "/api/editorial/admin/taxonomies/reorder" && request.method() === "PATCH") {
      const body = request.postDataJSON(); operations.push({ method: "reorder", body });
      body.items.forEach((item) => { const row = rows.find((value) => value.id === item.id); if (row) row.sortOrder = item.sortOrder; });
      await json({ ok: true, taxonomies: rows }); return;
    }
    const adminTaxonomy = url.pathname.match(/^\/api\/editorial\/admin\/taxonomies\/([^/]+)(?:\/(activate|deactivate))?$/);
    if (adminTaxonomy) {
      const row = rows.find((value) => value.id === decodeURIComponent(adminTaxonomy[1]));
      if (request.method() === "PATCH") { const body = request.postDataJSON(); Object.assign(row, body); operations.push({ method: "update", body }); }
      if (request.method() === "POST") { row.isActive = adminTaxonomy[2] === "activate"; operations.push({ method: adminTaxonomy[2] }); }
      if (request.method() === "DELETE") { row.isActive = false; operations.push({ method: "delete" }); }
      await json({ ok: true, taxonomy: row, deleted: false, deactivated: request.method() === "DELETE" }); return;
    }
    if (url.pathname === "/api/editorial/admin/taxonomies" && request.method() === "POST") {
      const body = request.postDataJSON();
      const row = { id: `created-${rows.length}`, slug: `created-${rows.length}`, value: body.name, postField: body.type === "category" ? "category" : "tags", ...body };
      rows.push(row); operations.push({ method: "create", body });
      await json({ ok: true, taxonomy: row }, 201); return;
    }
    if (url.pathname === "/api/editorial/posts") {
      if (url.searchParams.get("kind") === "resource") {
        await json({ posts: [{ id: "resource-1", slug: "physics-sheet", kind: "resource", title: "물리 실험 정리 양식", excerpt: "측정값을 정리하는 양식", category: "물리", tags: ["실험"], published_at: "2026-07-10" }] });
      } else {
        await json({ posts: [{ id: "post-1", slug: "using-quilo", kind: "developer", title: "Quilo 활용 시작하기", excerpt: "첫 개발 노트", category: "Quilo 활용", tags: ["활용 팁"], published_at: "2026-07-13", author: { name: "Quilo 개발팀", is_developer: true } }] });
      }
      return;
    }
    if (/^\/api\/editorial\/posts\/[^/]+\/attachments$/.test(url.pathname)) { await json({ attachments: [] }); return; }
    if (url.pathname === "/api/editorial/resource-requests" || url.pathname === "/api/editorial/resource-requests/manage") { await json({ requests: [] }); return; }
    if (url.pathname === "/api/lab/entries") {
      await json({ entries: LAB_ENTRIES.map((entry, index) => ({ id: entry.id, date: entry.date, tag: entry.tag, title: entry.title, summary: entry.summary, fileCount: entry.files.length, coverImage: index === 0 ? "/assets/developer-notes/overview-cover.webp" : "" })) }); return;
    }
    if (url.pathname.startsWith("/api/lab/entry/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop());
      const source = LAB_ENTRIES.find((entry) => entry.id === id) || LAB_ENTRIES[0];
      await json({ ...source, coverImage: "/assets/developer-notes/overview-cover.webp", body_markdown: "## 안전한 커버\n\n![Quilo Lab 개요](/assets/developer-notes/overview-cover.webp)\n\n![보조 도식](/assets/developer-notes/overview.svg)\n\n![외부 이미지](https://example.com/unsafe.svg)\n\n<script>window.__legacyUnsafe=1</script>", files: [{ path: "server.js", label: "서버 코드", size: 1200, available: true }] }); return;
    }
    await json({});
  });
  return { rows, operations, consoleErrors };
}

test("four editorial surfaces use the canonical shell without mobile overflow", async ({ page }) => {
  const fixtures = await installFixtures(page);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const pathname of ["/developer-notes.html", "/resources.html", "/article.html", "/editorial-write.html"]) {
      await page.goto(`${baseUrl}${pathname}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-ui-shell-mounted="true"]')).toBeVisible();
      await expect(page.locator(".ui-site-footer__logo")).toHaveText("Quilo");
      await expect(page.locator(".ed-header, .ed-footer")).toHaveCount(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
  }
  expect(fixtures.consoleErrors).toEqual([]);
});

test("developer notes merge all legacy Lab entries and render legacy content safely", async ({ page }) => {
  const fixtures = await installFixtures(page);
  await page.goto(`${baseUrl}/developer-notes.html`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#notesStatus")).toHaveText(`${LAB_ENTRIES.length + 1}개의 글`);
  await expect(page.locator('[data-category-tabs] button')).toContainText(["전체", "Quilo 활용", "개발", "보고서 작성", "새 소식"]);
  await expect(page.locator('[data-topic-list]')).toContainText("HWPX");
  for (let index = 0; index < 4 && await page.locator("#loadMore").isVisible(); index += 1) await page.locator("#loadMore").click();
  await expect(page.locator('#postList h3 a[href*="?legacy="]')).toHaveCount(LAB_ENTRIES.length);
  await expect(page.locator('.ed-post-thumbnail img[src="/assets/developer-notes/overview-cover.webp"]')).toHaveCount(1);

  await page.goto(`${baseUrl}/article.html?legacy=${encodeURIComponent(LAB_ENTRIES[0].id)}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-legacy-notice]")).toBeVisible();
  await expect(page.locator('#articleCover img[src="/assets/developer-notes/overview-cover.webp"]')).toBeVisible();
  await expect(page.locator("#articleBody img")).toHaveCount(1);
  await expect(page.locator('#articleBody img[src="/assets/developer-notes/overview.svg"]')).toHaveCount(1);
  await expect(page.locator("#articleBody script")).toHaveCount(0);
  expect(await page.evaluate(() => window.__legacyUnsafe)).toBeUndefined();
  await expect(page.locator('#articleAttachments a[href^="/api/lab/file?path="]')).toHaveCount(1);
  expect(fixtures.consoleErrors).toEqual([]);
});

test("dynamic taxonomies drive resource and editor controls and admin management", async ({ page }) => {
  const fixtures = await installFixtures(page, { admin: true });
  await page.goto(`${baseUrl}/developer-notes.html`, { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-manage-taxonomies]')).toBeVisible();
  await page.locator('[data-manage-taxonomies]').click();
  await expect(page.locator(".ed-taxonomy-dialog")).toBeVisible();
  const firstName = page.locator(".ed-taxonomy-row [data-taxonomy-name]").first();
  await firstName.fill("Quilo 사용법");
  await page.locator(".ed-taxonomy-row [data-save-taxonomy]").first().click();
  await expect(page.locator(".ed-taxonomy-row [data-taxonomy-name]").first()).toHaveValue("Quilo 사용법");
  await page.locator(".ed-taxonomy-dialog [data-close-taxonomy]").click();
  expect(fixtures.operations.some((operation) => operation.method === "update" && operation.body.name === "Quilo 사용법")).toBeTruthy();

  await page.goto(`${baseUrl}/resources.html`, { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-resource-categories] input[name="resourceCategory"]')).toHaveCount(7);
  await expect(page.locator("#requestCategory option")).toContainText(["화학", "물리", "보고서 양식", "학습 자료", "도구", "기타"]);

  await page.goto(`${baseUrl}/editorial-write.html`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#editorShell")).toBeVisible();
  await expect(page.locator("#categorySelect option")).toContainText(["Quilo 사용법", "개발", "보고서 작성", "새 소식"]);
  await expect(page.locator("#tagSuggestions button")).toContainText(["활용 팁", "아키텍처"]);
  expect(await page.locator("#editorToolbar button").count()).toBeGreaterThanOrEqual(20);
  await page.locator("#kindSelect").selectOption("resource");
  await expect(page.locator("#categorySelect option")).toContainText(["화학", "물리", "보고서 양식", "학습 자료", "도구", "기타"]);
  expect(fixtures.consoleErrors).toEqual([]);
});
