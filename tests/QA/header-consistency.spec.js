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
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const TOOL_ROUTES = Object.freeze([
  "/tools/convert.html",
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
]);

const GENERAL_PUBLIC_ROUTES = Object.freeze([
  "/changelog.html",
  "/community.html",
  "/developer-notes.html",
  "/developers.html",
  "/equation/index.html",
  "/examples.html",
  "/guide.html",
  "/pricing.html",
  "/privacy.html",
  "/refund.html",
  "/resources.html",
  "/school-apply.html",
  "/status.html",
  "/support.html",
  "/terms.html",
]);

const DOWNLOAD_APP_ROUTES = Object.freeze([
  "/apps/live-translator.html",
  "/apps/quilo.html",
]);

const WORK_APP_ROUTES = Object.freeze([
  "/create.html",
  "/editor.html",
  "/exam-prep.html",
  "/filechat.html",
  "/physics-studio.html",
  "/studio.html",
  "/study.html",
  "/vibe-coding.html",
]);

const HEADER_ROUTES = Object.freeze([
  "/",
  ...TOOL_ROUTES,
  ...GENERAL_PUBLIC_ROUTES,
  ...DOWNLOAD_APP_ROUTES,
  ...WORK_APP_ROUTES,
  "/translate.html",
]);

const MENU_GROUPS = Object.freeze(["제품", "학습", "창작", "파일 및 번역", "개발자", "리소스"]);
const COMMON_NAV_DESTINATIONS = Object.freeze([
  "/?report=chem-pre",
  "/?report=chem-result",
  "/?report=phys-result",
  "/?report=free",
  "/tools/index.html",
  "/translate.html",
  "/apps/quilo.html",
  "/apps/live-translator.html",
  "/developers.html",
  "/developers.html#catalog",
  "/developers.html#tokenCard",
  "/guide.html",
  "/examples.html",
  "/changelog.html",
  "/community.html",
  "/support.html",
  "/school-apply.html",
  "/pricing.html",
  "https://www.instagram.com/quilo._.official/",
]);

const VIEWPORTS = Object.freeze([
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "compact-desktop-933", width: 933, height: 844 },
  { name: "mobile-430", width: 430, height: 932 },
  { name: "mobile-390", width: 390, height: 844 },
]);

let staticServer;
let baseUrl;
const unsafeBrowserRequests = new WeakMap();
const unsafeServerRequests = [];

function resolvePublicFile(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  } catch (_) {
    return null;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return null;

  try {
    if (fs.statSync(filePath).isDirectory()) return path.join(filePath, "index.html");
  } catch (_) {}
  return filePath;
}

function createStaticServer() {
  return http.createServer((request, response) => {
    const method = String(request.method || "GET").toUpperCase();
    if (!SAFE_METHODS.has(method)) {
      unsafeServerRequests.push(`${method} ${request.url}`);
      response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Read-only QA server");
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

function apiFixture(pathname, authenticated) {
  if (pathname === "/api/me") {
    return authenticated
      ? {
          status: 200,
          body: {
            user: "세션사용자",
            username: "session-user",
            isAdmin: false,
            blockedReportTypes: [],
          },
        }
      : { status: 401, body: { error: "로그인이 필요합니다." } };
  }

  const fixtures = {
    "/api/announcements": { announcements: [] },
    "/api/artifacts/gallery": { items: [] },
    "/api/catalog": { total: 0, categories: {}, features: [] },
    "/api/chat/status": { enabled: false, writeAssistEnabled: false },
    "/api/cloud/providers/status": { integrations: {} },
    "/api/community/posts": { storage: true, posts: [] },
    "/api/filechat/access": { allowed: false },
    "/api/integrations/api-requests": { requests: [] },
    "/api/integrations/tokens": { tokens: [] },
    "/api/lab/entries": { entries: [] },
    "/api/me/balance": { credits: 0, unlimited: false, isAdmin: false, modelCredits: {} },
    "/api/me/beta": {
      admin: false,
      tier: authenticated ? "max" : "free",
      features: [],
      blockedReportTypes: [],
    },
    "/api/me/files": { storage: true, files: [] },
    "/api/physics-studio/config": { models: [], difficulties: [], styles: [] },
    "/api/subscriptions/me": { active: authenticated, subscription: null },
    "/api/version": {
      app: "quilo",
      version: "qa",
      shortCommit: "header",
      commit: "header-consistency",
      branch: "qa",
      serverStartedAt: "2026-07-12T00:00:00.000Z",
      patchNotes: [],
    },
    "/api/write-assist/models": { enabled: false, models: [] },
  };
  return { status: 200, body: fixtures[pathname] || {} };
}

async function installReadOnlyNetworkGuard(page, { authenticated = false } = {}) {
  const unsafe = [];
  unsafeBrowserRequests.set(page, unsafe);

  await page.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const url = new URL(request.url());

    if (!SAFE_METHODS.has(method)) {
      unsafe.push(`${method} ${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }

    if (url.origin === baseUrl && url.pathname.startsWith("/api/")) {
      const fixture = apiFixture(url.pathname, authenticated);
      await route.fulfill({
        status: fixture.status,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(fixture.body),
      });
      return;
    }

    if (url.origin !== baseUrl) {
      const resourceType = request.resourceType();
      if (resourceType === "script") {
        await route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: "" });
      } else if (resourceType === "stylesheet") {
        await route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: "" });
      } else {
        await route.fulfill({ status: 204, body: "" });
      }
      return;
    }

    await route.continue();
  });
}

function normalizeHref(href) {
  if (!href) return href;
  const target = new URL(href, baseUrl);
  if (target.origin !== baseUrl) return target.href;
  return `${target.pathname}${target.search}${target.hash}`;
}

async function horizontalOverflowReport(page) {
  return page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const documentWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const header = document.querySelector("[data-ui-shell]");
    const headerInner = header?.firstElementChild || header;
    const offenders = [...document.querySelectorAll("[data-ui-shell] *")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > viewportWidth + 1);
      })
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id,
        className: typeof element.className === "string" ? element.className : "",
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
      }));

    return {
      viewportWidth,
      documentWidth,
      headerScrollWidth: headerInner?.scrollWidth || 0,
      headerClientWidth: headerInner?.clientWidth || 0,
      offenders,
    };
  });
}

async function expectCanonicalAnonymousHeader(page, route) {
  const header = page.locator("[data-ui-shell]");
  await expect(header, `${route} must render exactly one canonical shell`).toHaveCount(1);
  await expect(header, `${route} canonical shell must be visible`).toBeVisible();

  const brand = header.locator('a[href="/"][aria-label="Quilo 홈"]');
  await expect(brand, `${route} canonical brand`).toHaveCount(1);
  await expect(brand).toHaveText("Quilo");
  await expect(brand.locator('img[src="/favicon.png"]'), `${route} canonical logo asset`).toHaveCount(1);

  const desktopNav = header.locator('nav[aria-label="주요 메뉴"], nav[aria-label="주 메뉴"]');
  const compact = await page.evaluate(() => window.innerWidth <= 1120);
  await expect(desktopNav, `${route} desktop navigation`).toHaveCount(1);
  if (compact) await expect(desktopNav).toBeHidden();
  else await expect(desktopNav).toBeVisible();
  await expect(desktopNav.locator("[data-ui-menu-trigger]"), `${route} menu groups`).toHaveText(MENU_GROUPS);

  const pricing = desktopNav.locator(':scope > a[href="/pricing.html"]');
  await expect(pricing, `${route} pricing navigation`).toHaveText("요금");
  const instagram = desktopNav.locator('a[href="https://www.instagram.com/quilo._.official/"]');
  await expect(instagram, `${route} Instagram navigation`).toContainText("Instagram");
  await expect(instagram).toHaveAttribute("target", "_blank");
  await expect(instagram).toHaveAttribute("rel", /noopener/);

  const actions = header.locator(".ui-site-actions");
  await expect(actions, `${route} desktop actions`).toHaveCount(1);
  if (compact) await expect(actions).toBeHidden();
  else await expect(actions).toBeVisible();

  const actionScope = compact ? header.locator("#uiMobilePanel") : actions;
  if (compact) {
    const mobileTrigger = header.locator("[data-ui-mobile-trigger]");
    await expect(mobileTrigger).toBeVisible();
    await mobileTrigger.click();
    await expect(header.locator("#uiMobilePanel")).toBeVisible();
  }

  const authAction = actionScope.locator("[data-ui-auth-action]");
  await expect(authAction, `${route} logged-out action`).toHaveCount(1);
  await expect(authAction).toBeVisible();
  await expect(authAction).toHaveText("로그인");
  const routeUrl = new URL(route, "https://qa.quilolab.com");
  const returnPath = `${routeUrl.pathname}${routeUrl.search}${routeUrl.hash}`;
  await expect(authAction).toHaveAttribute("href", `/login.html?next=${encodeURIComponent(returnPath)}`);

  const start = actionScope.locator('.ui-site-cta[href="/signup.html"]');
  await expect(start, `${route} signup start action`).toHaveCount(1);
  await expect(start).toBeVisible();
  await expect(start).toHaveText("무료로 시작하기");

  const theme = actionScope.locator("[data-ui-theme]");
  await expect(theme, `${route} desktop theme control`).toHaveCount(1);
  await expect(theme).toBeVisible();
  await expect(theme).toHaveAttribute("aria-label", /테마/);
  await expect(theme.locator("svg")).toHaveCount(1);

  const previousTheme = await page.locator("html").getAttribute("data-theme");
  await theme.click();
  await expect(page.locator("html"), `${route} theme interaction`).not.toHaveAttribute(
    "data-theme",
    previousTheme || "light",
  );
}

test("desktop product menu is one complete editorial mega panel", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

  await page.locator('[data-ui-menu-trigger="0"]').click();
  const menu = page.locator("#uiSiteMega");
  await expect(menu).toBeVisible();
  const layout = await menu.evaluate((element) => {
    return {
      height: Math.round(element.getBoundingClientRect().height),
      links: element.querySelectorAll("a").length,
      sections: element.querySelectorAll(".ui-site-menu-section").length,
      overflow: element.scrollWidth - element.clientWidth,
    };
  });
  expect(layout.links).toBeGreaterThanOrEqual(10);
  expect(layout.sections).toBe(3);
  expect(layout.height).toBeLessThanOrEqual(460);
  expect(layout.overflow).toBeLessThanOrEqual(1);
  await expect(menu.locator('[data-report="chem-pre"]')).toContainText("Free");
  await expect(menu.locator('a[href="/translate.html"]')).toContainText("Max");
});

test.beforeAll(async () => {
  staticServer = createStaticServer();
  await new Promise((resolve, reject) => {
    staticServer.once("error", reject);
    staticServer.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${staticServer.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve, reject) => {
    staticServer.close((error) => (error ? reject(error) : resolve()));
  });
  expect(unsafeServerRequests, "The header QA server must never receive a write request").toEqual([]);
});

test.afterEach(async ({ page }) => {
  expect(
    unsafeBrowserRequests.get(page) || [],
    "Header consistency QA must never initiate POST, PUT, PATCH, DELETE, or other write requests",
  ).toEqual([]);
});

test("canonical header route inventory and destinations are explicit", () => {
  expect(TOOL_ROUTES).toHaveLength(14);
  expect(GENERAL_PUBLIC_ROUTES).toHaveLength(15);
  expect(DOWNLOAD_APP_ROUTES).toHaveLength(2);
  expect(WORK_APP_ROUTES).toHaveLength(8);
  expect(HEADER_ROUTES).toHaveLength(41);
  expect(new Set(HEADER_ROUTES).size).toBe(HEADER_ROUTES.length);
  expect(COMMON_NAV_DESTINATIONS).toHaveLength(19);
  expect(new Set(COMMON_NAV_DESTINATIONS).size).toBe(COMMON_NAV_DESTINATIONS.length);

  for (const route of HEADER_ROUTES) {
    const filePath = route === "/"
      ? path.join(PUBLIC_DIR, "index.html")
      : path.join(PUBLIC_DIR, route.replace(/^\/+/, ""));
    expect(fs.existsSync(filePath), `${route} must exist in the public tree`).toBe(true);
  }
});

for (const viewport of VIEWPORTS) {
  test.describe(`canonical header ${viewport.name}`, () => {
    for (const route of HEADER_ROUTES) {
      test(`${route} exposes the complete shared header without overflow`, async ({ page }) => {
        await installReadOnlyNetworkGuard(page, { authenticated: false });
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded" });

        await expectCanonicalAnonymousHeader(page, route);

        const overflow = await horizontalOverflowReport(page);
        expect(
          overflow.documentWidth,
          `${route} at ${viewport.name} overflows ${overflow.viewportWidth}px; offenders: ${JSON.stringify(overflow.offenders)}`,
        ).toBeLessThanOrEqual(overflow.viewportWidth + 1);
        expect(
          overflow.headerScrollWidth,
          `${route} at ${viewport.name} clips its header; offenders: ${JSON.stringify(overflow.offenders)}`,
        ).toBeLessThanOrEqual(overflow.headerClientWidth + 1);
        expect(overflow.offenders, `${route} at ${viewport.name} header offenders`).toEqual([]);
      });
    }
  });
}

test.describe("authenticated header state", () => {
  for (const route of HEADER_ROUTES) {
    test(`${route} renders the same account action for an authenticated session`, async ({ page }) => {
      await installReadOnlyNetworkGuard(page, { authenticated: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded" });

      const header = page.locator("[data-ui-shell]");
      await expect(header, `${route} authenticated canonical shell`).toHaveCount(1);
      await expect(header).toHaveAttribute("data-ui-auth-state", "authenticated");

      const account = header.locator(".ui-site-actions [data-ui-auth-action]");
      await expect(account, `${route} authenticated account action`).toHaveCount(1);
      await expect(account).toBeVisible();
      await expect(account).toHaveText("세션사용자 님");
      await expect(account).toHaveAttribute("href", "/#settings");
      await expect(header.locator('.ui-site-actions a[href="/?login=1"]')).toHaveCount(0);
      await expect(header.locator(".ui-site-actions [data-ui-start-action]")).toBeHidden();

      await page.setViewportSize({ width: 390, height: 844 });
      await header.locator("[data-ui-mobile-trigger]").click();
      const mobileAccount = header.locator("#uiMobilePanel [data-ui-auth-action]");
      await expect(mobileAccount, `${route} mobile account action`).toBeVisible();
      await expect(mobileAccount).toHaveText("세션사용자 님");
      await expect(mobileAccount).toHaveAttribute("href", "/#settings");
      await expect(header.locator("#uiMobilePanel [data-ui-mobile-logout]")).toBeVisible();
      await expect(header.locator("#uiMobilePanel [data-ui-mobile-admin]")).toBeHidden();
      const overflow = await horizontalOverflowReport(page);
      expect(overflow.documentWidth, `${route} authenticated mobile overflow`).toBeLessThanOrEqual(overflow.viewportWidth + 1);
    });
  }
});

test("representative mega menu groups switch in place and restore focus on close", async ({ page }) => {
  await installReadOnlyNetworkGuard(page, { authenticated: false });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/guide.html`, { waitUntil: "domcontentloaded" });

  const header = page.locator("[data-ui-shell]");
  const navigation = header.locator('nav[aria-label="주요 메뉴"], nav[aria-label="주 메뉴"]');
  const productTrigger = navigation.locator('[data-ui-menu-trigger="0"]');
  const resourceTrigger = navigation.locator('[data-ui-menu-trigger="5"]');
  const panel = header.locator("#uiSiteMega");

  await productTrigger.click();
  await expect(productTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toBeVisible();

  await resourceTrigger.click();
  await expect(resourceTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(productTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toContainText("이용 가이드");

  const resourceLink = panel.locator('a[href="/guide.html"]').first();
  await resourceLink.focus();
  await expect(resourceLink).toBeFocused();
  await resourceLink.press("Escape");
  await expect(panel).toHaveAttribute("aria-hidden", "true");
  await expect(resourceTrigger).toBeFocused();

  await productTrigger.click();
  await expect(productTrigger).toHaveAttribute("aria-expanded", "true");
  const outsideY = await panel.evaluate((element) =>
    Math.min(window.innerHeight - 8, Math.ceil(element.getBoundingClientRect().bottom) + 8),
  );
  await page.mouse.click(8, outsideY);
  await expect(panel).toHaveAttribute("aria-hidden", "true");
});
