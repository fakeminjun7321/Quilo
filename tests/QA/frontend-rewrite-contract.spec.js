const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { isolatedServerEnv } = require("./support/isolated-server-env");

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
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// Every user-facing HTML entry point in public/, excluding admin.html and the
// build metadata response. Those have dedicated administration/server tests.
// Keep this explicit: adding or removing a user route must be an intentional
// frontend contract change rather than an unnoticed filesystem side effect.
const USER_ROUTES = Object.freeze([
  "/",
  "/apps/live-translator.html",
  "/apps/quilo.html",
  "/article.html",
  "/changelog.html",
  "/community.html",
  "/create.html",
  "/developer-notes.html",
  "/developers.html",
  "/editor.html",
  "/editorial-write.html",
  "/equation/index.html",
  "/exam-prep.html",
  "/examples.html",
  "/filechat.html",
  "/guide.html",
  "/login.html",
  "/password-reset.html",
  "/physics-studio.html",
  "/pricing.html",
  "/privacy.html",
  "/refund.html",
  "/resources.html",
  "/school-apply.html",
  "/signup.html",
  "/studio.html",
  "/study.html",
  "/status.html",
  "/support.html",
  "/terms.html",
  "/tools/convert.html",
  "/tools/image-ocr.html",
  "/tools/pdf-analysis.html",
  "/tools/image.html",
  "/tools/index.html",
  "/tools/pdf-compress.html",
  "/tools/pdf-crop.html",
  "/tools/pdf-extract.html",
  "/tools/pdf-merge.html",
  "/tools/pdf-organize.html",
  "/tools/pdf-pagenum.html",
  "/tools/pdf-remove.html",
  "/tools/pdf-rotate.html",
  "/tools/pdf-split.html",
  "/tools/pdf-watermark.html",
  "/translate-app.html",
  "/translate.html",
  "/verify-email.html",
  "/vibe-coding.html",
]);

const LEGACY_ASSET_PATHS = new Set([
  "/style.css",
  "/site-shell.css",
  "/home-redesign.css",
  "/auth-ui.css",
  "/apps/apps.css",
  "/site-shell.js",
]);

const ASSET_RESOURCE_TYPES = new Set([
  "font",
  "image",
  "manifest",
  "media",
  "script",
  "stylesheet",
]);

const unsafeServerRequests = [];
let staticServer;
let baseUrl;
let contractServer;
let contractServerUrl;

function resolvePublicFile(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  } catch (_) {
    return null;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return null;
  try {
    if (fs.statSync(filePath).isDirectory()) return path.join(filePath, "index.html");
  } catch (_) {}
  return filePath;
}

function apiFixture(pathname) {
  if (pathname === "/api/me") return { status: 401, body: { error: "로그인이 필요합니다." } };
  const fixtures = {
    "/api/announcements": { announcements: [] },
    "/api/artifacts/gallery": { items: [] },
    "/api/catalog": { total: 0, categories: {}, features: [] },
    "/api/chat/status": { enabled: false, writeAssistEnabled: false },
    "/api/community/posts": { storage: true, posts: [] },
    "/api/filechat/access": { allowed: false },
    "/api/integrations/api-requests": { requests: [] },
    "/api/integrations/tokens": { tokens: [] },
    "/api/lab/entries": { entries: [] },
    "/api/me/balance": { credits: 0, unlimited: false, isAdmin: false, modelCredits: {} },
    "/api/me/beta": { admin: false, features: [], blockedReportTypes: [] },
    "/api/physics-studio/config": { models: [], difficulties: [], styles: [] },
    "/api/subscriptions/me": { active: false, subscription: null },
    "/api/version": { app: "quilo", version: "qa", shortCommit: "contract" },
    "/api/write-assist/models": { enabled: false, models: [] },
  };
  return { status: 200, body: fixtures[pathname] || {} };
}

function createReadOnlyStaticServer() {
  return http.createServer((request, response) => {
    const method = String(request.method || "GET").toUpperCase();
    if (!SAFE_METHODS.has(method)) {
      unsafeServerRequests.push(`${method} ${request.url}`);
      response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Read-only frontend contract server");
      return;
    }

    const requestUrl = new URL(request.url || "/", "http://localhost");
    if (requestUrl.pathname.startsWith("/api/")) {
      const fixture = apiFixture(requestUrl.pathname);
      response.writeHead(fixture.status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(method === "HEAD" ? undefined : JSON.stringify(fixture.body));
      return;
    }

    const filePath = resolvePublicFile(request.url || "/");
    if (!filePath) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }
    fs.readFile(filePath, (error, body) => {
      if (error) {
        response.writeHead(error.code === "ENOENT" ? 404 : 500, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end(error.code === "ENOENT" ? "Not found" : "Server error");
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      });
      response.end(method === "HEAD" ? undefined : body);
    });
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function freePort() {
  const server = net.createServer();
  const url = await listen(server);
  const port = Number(new URL(url).port);
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server.js exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server.js did not become ready: ${lastError?.message || "timeout"}`);
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
}

function discoverUserHtmlRoutes() {
  const routes = [];
  for (const entry of fs.readdirSync(PUBLIC_DIR, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name.endsWith(".html") &&
      entry.name !== "admin.html" &&
      entry.name !== "build.html"
    ) {
      routes.push(entry.name === "index.html" ? "/" : `/${entry.name}`);
    }
    if (!entry.isDirectory()) continue;
    const directory = path.join(PUBLIC_DIR, entry.name);
    for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
      if (child.isFile() && child.name.endsWith(".html")) routes.push(`/${entry.name}/${child.name}`);
    }
  }
  return routes.sort();
}

async function localAssetReferences(page) {
  return page.evaluate(() => {
    const references = [];
    const add = (value) => {
      if (!value) return;
      try {
        const url = new URL(value, location.href);
        if (url.origin === location.origin && !url.pathname.startsWith("/api/")) references.push(url.href);
      } catch (_) {}
    };
    document.querySelectorAll("script[src], img[src], source[src], audio[src], video[src], embed[src]").forEach((node) => add(node.getAttribute("src")));
    document.querySelectorAll("video[poster]").forEach((node) => add(node.getAttribute("poster")));
    document.querySelectorAll("object[data]").forEach((node) => add(node.getAttribute("data")));
    document.querySelectorAll("link[href]").forEach((node) => {
      const rel = String(node.getAttribute("rel") || "").toLowerCase().split(/\s+/);
      if (rel.some((name) => ["stylesheet", "icon", "apple-touch-icon", "preload", "modulepreload", "manifest"].includes(name))) add(node.getAttribute("href"));
    });
    document.querySelectorAll("img[srcset], source[srcset]").forEach((node) => {
      String(node.getAttribute("srcset") || "").split(",").forEach((candidate) => add(candidate.trim().split(/\s+/)[0]));
    });
    return [...new Set(references)];
  });
}

test.beforeAll(async () => {
  staticServer = createReadOnlyStaticServer();
  baseUrl = await listen(staticServer);

  const port = await freePort();
  contractServerUrl = `http://127.0.0.1:${port}`;
  contractServer = spawn(process.execPath, [path.join(process.cwd(), "server.js")], {
    cwd: process.cwd(),
    env: isolatedServerEnv({
      PORT: String(port),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(contractServerUrl, contractServer);
});

test.afterAll(async () => {
  await stopChild(contractServer);
  await new Promise((resolve, reject) => staticServer.close((error) => (error ? reject(error) : resolve())));
  expect(unsafeServerRequests, "contract suite must never send write requests").toEqual([]);
});

test("the explicit inventory contains all 49 user-facing HTML routes", () => {
  expect(USER_ROUTES).toHaveLength(49);
  expect(new Set(USER_ROUTES).size).toBe(49);
  expect([...USER_ROUTES].sort()).toEqual(discoverUserHtmlRoutes());
  expect(USER_ROUTES).not.toContain("/admin.html");
  expect(USER_ROUTES).not.toContain("/build.html");
});

for (const route of USER_ROUTES) {
  test(`${route} satisfies the frontend rewrite contract`, async ({ page }) => {
    const failedLocalAssets = [];
    const legacyLoads = [];

    page.on("response", (response) => {
      const request = response.request();
      const url = new URL(response.url());
      if (url.origin !== baseUrl) return;
      if (LEGACY_ASSET_PATHS.has(url.pathname)) legacyLoads.push(url.pathname);
      if (ASSET_RESOURCE_TYPES.has(request.resourceType()) && response.status() >= 400) {
        failedLocalAssets.push(`${response.status()} ${url.pathname}`);
      }
    });
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      if (url.origin === baseUrl && ASSET_RESOURCE_TYPES.has(request.resourceType())) {
        failedLocalAssets.push(`FAILED ${url.pathname}: ${request.failure()?.errorText || "unknown"}`);
      }
    });
    await page.route("**/*", async (browserRoute) => {
      const request = browserRoute.request();
      const method = request.method().toUpperCase();
      const url = new URL(request.url());
      expect(SAFE_METHODS.has(method), `${route} attempted unsafe request ${method} ${url.pathname}`).toBe(true);
      if (!SAFE_METHODS.has(method) || url.origin !== baseUrl) {
        await browserRoute.abort("blockedbyclient");
        return;
      }
      await browserRoute.continue();
    });

    await page.setViewportSize({ width: 1440, height: 933 });
    const response = await page.goto(`${baseUrl}${route}`, { waitUntil: "load" });
    expect(response, `${route} navigation response`).not.toBeNull();
    expect(response.status(), `${route} must return HTTP 200`).toBe(200);

    const mainCount = await page.locator("main").count();
    expect(mainCount, `${route} must have exactly one main landmark`).toBe(1);
    const pageName = await page.locator("main").evaluate((main) => {
      const h1 = main.querySelector("h1");
      if (h1?.textContent?.trim()) return h1.textContent.trim();
      if (main.getAttribute("aria-label")?.trim()) return main.getAttribute("aria-label").trim();
      const labelledBy = main.getAttribute("aria-labelledby");
      if (!labelledBy) return "";
      return labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() || "")
        .filter(Boolean)
        .join(" ");
    });
    expect(pageName, `${route} must expose an H1 or an ARIA page name`).not.toBe("");

    const duplicateIds = await page.locator("[id]").evaluateAll((nodes) => {
      const counts = new Map();
      nodes.forEach((node) => counts.set(node.id, (counts.get(node.id) || 0) + 1));
      return [...counts.entries()].filter(([, count]) => count > 1).map(([id, count]) => `${id} (${count})`);
    });
    expect(duplicateIds, `${route} duplicate IDs`).toEqual([]);

    const authoredSource = fs.readFileSync(resolvePublicFile(route), "utf8");
    const authoredMarkup = authoredSource.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    expect(authoredMarkup, `${route} authored inline <style> tags`).not.toMatch(/<style\b/i);
    expect(authoredMarkup, `${route} authored style attributes`).not.toMatch(/\sstyle\s*=/i);
    expect(authoredMarkup, `${route} authored inline onclick handlers`).not.toMatch(/\sonclick\s*=/i);

    const runtimeStyleViolations = await page.locator("[style]").evaluateAll((nodes) => {
      const geometryProperties = new Set([
        "width", "min-width", "max-width", "height", "min-height", "max-height",
        "left", "right", "top", "bottom", "inset", "inset-inline", "inset-block",
        "position", "z-index", "transform", "translate", "rotate", "scale", "opacity",
        "clip", "clip-path", "margin-left", "margin-top", "grid-template-columns",
        "grid-template-rows",
      ]);
      const geometrySignals = new Set([
        "width", "height", "left", "right", "top", "bottom", "inset", "position",
        "transform", "translate", "rotate", "scale", "opacity", "clip", "clip-path",
      ]);
      const thirdPartySelector = [
        ".pdfViewer", ".textLayer", ".annotationLayer", ".annotationEditorLayer",
        ".canvasWrapper", ".monaco-editor", ".CodeMirror", ".cm-editor",
        "[data-pdfjs]", "[data-editor-id]",
      ].join(",");

      return nodes.flatMap((node) => {
        const properties = [...node.style].map((property) => property.toLowerCase());
        if (!properties.length) return [];
        if (node.closest(thirdPartySelector)) return [];

        const identity = `${node.id} ${String(node.className || "")} ${node.getAttribute("role") || ""}`;
        const progressLike = /progress|meter|percent|percentage|fill|bar|thumb|resiz|drag/i.test(identity);
        const geometryOnly = properties.every(
          (property) => property.startsWith("--") || geometryProperties.has(property),
        );
        const hasGeometrySignal = properties.some((property) => geometrySignals.has(property));
        if (geometryOnly && (progressLike || hasGeometrySignal)) return [];

        return [{
          tag: node.tagName.toLowerCase(),
          id: node.id,
          className: String(node.className || ""),
          properties,
          style: node.getAttribute("style"),
        }];
      }).slice(0, 20);
    });
    expect(
      runtimeStyleViolations,
      `${route} runtime styles must be calculated geometry/progress or third-party editor styles; use hidden/classes for display state`,
    ).toEqual([]);

    const linkedLegacyAssets = await page.locator('link[href], script[src]').evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute("href") || node.getAttribute("src"))
        .filter(Boolean)
        .map((value) => new URL(value, location.href).pathname)
        .filter((pathname) => [
          "/style.css",
          "/site-shell.css",
          "/home-redesign.css",
          "/auth-ui.css",
          "/apps/apps.css",
          "/site-shell.js",
        ].includes(pathname)),
    );
    expect(linkedLegacyAssets, `${route} linked legacy assets`).toEqual([]);
    expect(legacyLoads, `${route} loaded legacy assets`).toEqual([]);

    const referencedAssets = await localAssetReferences(page);
    const missingReferencedAssets = referencedAssets
      .map((asset) => new URL(asset))
      .filter((url) => !fs.existsSync(resolvePublicFile(url.pathname)))
      .map((url) => url.pathname);
    expect(missingReferencedAssets, `${route} missing referenced local assets`).toEqual([]);
    expect(failedLocalAssets, `${route} failed local asset requests`).toEqual([]);

    const overflow = await page.evaluate(() => {
      const viewport = window.innerWidth;
      const documentWidth = document.documentElement.scrollWidth;
      const offenders = [...document.querySelectorAll("body *")]
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { tag: node.tagName.toLowerCase(), id: node.id, className: String(node.className || ""), left: rect.left, right: rect.right };
        })
        .filter((item) => item.left < -1 || item.right > viewport + 1)
        .slice(0, 8);
      return { viewport, documentWidth, offenders };
    });
    expect(
      overflow.documentWidth,
      `${route} horizontal overflow at 1440px; offenders: ${JSON.stringify(overflow.offenders)}`,
    ).toBeLessThanOrEqual(overflow.viewport + 1);
  });
}

test("app pages use only first-party macOS and Windows download controls", async ({ page }) => {
  await page.route("**/*", async (browserRoute) => {
    const request = browserRoute.request();
    const url = new URL(request.url());
    if (!SAFE_METHODS.has(request.method().toUpperCase()) || url.origin !== baseUrl) {
      await browserRoute.abort("blockedbyclient");
      return;
    }
    await browserRoute.continue();
  });

  for (const app of ["quilo", "live-translator"]) {
    await page.goto(`${baseUrl}/apps/${app}.html`, { waitUntil: "load" });
    expect(await page.locator(`[data-app-download][data-app="${app}"][data-platform="mac"]`).count()).toBeGreaterThanOrEqual(1);
    expect(await page.locator(`[data-app-download][data-app="${app}"][data-platform="windows"]`).count()).toBeGreaterThanOrEqual(1);
    expect(await page.locator(`a[href^="/api/apps/${app}/download?platform=mac"]`).count()).toBeGreaterThanOrEqual(1);
    expect(await page.locator(`a[href^="/api/apps/${app}/download?platform=windows"]`).count()).toBeGreaterThanOrEqual(1);
    await expect(page.locator('a[href*="github.io"], a[href*="github.com"][href*="releases"], a[href*="download"]:not([href^="/api/apps/"])')).toHaveCount(0);
  }
});

test("app download endpoint rejects unknown apps and unsupported platforms", async ({ request }) => {
  const unknownApp = await request.get(`${contractServerUrl}/api/apps/not-a-real-app/download?platform=mac`);
  expect(unknownApp.status()).toBe(404);

  const unsupportedPlatform = await request.get(`${contractServerUrl}/api/apps/quilo/download?platform=linux`);
  expect(unsupportedPlatform.status()).toBe(400);
});

test("directory-style product links redirect directly to canonical HTML", async ({ request }) => {
  for (const [shortPath, canonicalPath] of [
    ["/tools", "/tools/index.html"],
    ["/tools/", "/tools/index.html"],
    ["/equation", "/equation/index.html"],
    ["/equation/", "/equation/index.html"],
  ]) {
    const response = await request.get(`${contractServerUrl}${shortPath}`, {
      maxRedirects: 0,
    });
    expect(response.status(), shortPath).toBe(308);
    expect(response.headers().location, shortPath).toBe(canonicalPath);
  }
});

test("HTML revalidates while static assets get a short stale-while-revalidate cache", async ({ request }) => {
  const html = await request.get(`${contractServerUrl}/pricing.html`);
  expect(html.status()).toBe(200);
  expect(html.headers()["cache-control"]).toBe("no-cache");

  const asset = await request.get(`${contractServerUrl}/ui/foundation.css`);
  expect(asset.status()).toBe(200);
  expect(asset.headers()["cache-control"]).toBe(
    "public, max-age=300, stale-while-revalidate=86400",
  );

  const catalog = await request.get(`${contractServerUrl}/api/catalog`);
  expect(catalog.status()).toBe(200);
  expect(catalog.headers()["cache-control"]).toBe(
    "public, max-age=300, stale-while-revalidate=3600",
  );
});
