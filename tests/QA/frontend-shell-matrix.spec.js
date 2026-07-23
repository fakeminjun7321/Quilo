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
  "/developers.html",
  "/equation/index.html",
  "/examples.html",
  "/guide.html",
  "/pricing.html",
  "/privacy.html",
  "/refund.html",
  "/school-apply.html",
  "/status.html",
  "/support.html",
  "/terms.html",
]);

const APP_ROUTES = Object.freeze([
  "/apps/live-translator.html",
  "/apps/quilo.html",
]);

const COMMON_SHELL_ROUTES = Object.freeze([
  ...TOOL_ROUTES,
  ...GENERAL_PUBLIC_ROUTES,
  ...APP_ROUTES,
]);

const NEW_STATIC_SHELL_ROUTES = new Set([
  ...TOOL_ROUTES,
  "/changelog.html",
  "/community.html",
  "/developers.html",
  "/equation/index.html",
  "/examples.html",
  "/guide.html",
  "/pricing.html",
  "/privacy.html",
  "/refund.html",
  "/school-apply.html",
  "/status.html",
  "/support.html",
  "/terms.html",
  ...APP_ROUTES,
]);

const APP_SHELL_ROUTES = Object.freeze([
  "/create.html",
  "/editor.html",
  "/exam-prep.html",
  "/filechat.html",
  "/physics-studio.html",
  "/studio.html",
  "/study.html",
  "/vibe-coding.html",
]);
const APP_SHELL_ROUTE_SET = new Set(APP_SHELL_ROUTES);

// These surfaces keep dedicated authentication or administration chrome, or
// share the canonical header above a desktop-first work surface.
const EXCLUDED_ROUTES = Object.freeze({
  auth: Object.freeze(["/login.html", "/password-reset.html", "/signup.html", "/verify-email.html"]),
  admin: Object.freeze(["/admin.html"]),
  fullscreenApps: Object.freeze([
    "/create.html",
    "/editor.html",
    "/exam-prep.html",
    "/filechat.html",
    "/physics-studio.html",
    "/studio.html",
    "/study.html",
    "/translate.html",
    "/vibe-coding.html",
  ]),
});

const VIEWPORTS = Object.freeze([
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "desktop-933", width: 933, height: 844 },
  { name: "mobile-390", width: 390, height: 844 },
]);
// Work surfaces are intentionally desktop-first in this rewrite. The product
// owner deferred mobile layout; 933px remains the required compact desktop floor.
const APP_SHELL_VIEWPORTS = Object.freeze(VIEWPORTS.filter((viewport) => viewport.width >= 933));

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

function readOnlyApiFixture(pathname) {
  if (pathname === "/api/me") {
    return { status: 401, body: { error: "로그인이 필요합니다." } };
  }

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
    "/api/version": {
      app: "quilo",
      version: "qa",
      shortCommit: "matrix",
      commit: "matrix",
      branch: "qa",
      serverStartedAt: "2026-07-11T00:00:00.000Z",
      patchNotes: [],
    },
    "/api/write-assist/models": { enabled: false, models: [] },
  };
  return { status: 200, body: fixtures[pathname] || {} };
}

async function installReadOnlyNetworkGuard(page) {
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
      if (/^\/api\/apps\/(?:quilo|live-translator)\/download$/.test(url.pathname)) {
        const extension = url.searchParams.get("platform") === "windows" ? "exe" : "dmg";
        await route.fulfill({
          status: 200,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Disposition": `attachment; filename="qa-installer.${extension}"`,
            "Content-Length": "32",
            "Content-Type": "application/octet-stream",
            "X-Quilo-App-Version": "qa",
          },
          body: "0123456789abcdefghijklmnopqrstuv",
        });
        return;
      }
      const fixture = readOnlyApiFixture(url.pathname);
      await route.fulfill({
        status: fixture.status,
        contentType: "application/json; charset=utf-8",
        body: Object.prototype.hasOwnProperty.call(fixture, "rawBody")
          ? fixture.rawBody
          : JSON.stringify(fixture.body),
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

function collectConsoleErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // The logged-out contract intentionally returns 401 from /api/me. Chromium
    // reports that expected auth probe as a resource error even though each page
    // handles the response and renders its signed-out state normally.
    if (/Failed to load resource:.*401 \(Unauthorized\)/.test(message.text())) return;
    errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function horizontalOverflowReport(page) {
  return page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const documentWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth || 0,
    );
    const offenders = [...document.querySelectorAll("body *")]
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.right > viewportWidth + 1 || rect.left < -1);
      })
      .slice(0, 8)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id,
          className: typeof element.className === "string" ? element.className : "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      });
    return { viewportWidth, documentWidth, offenders };
  });
}

test.beforeAll(async () => {
  staticServer = createStaticServer();
  await new Promise((resolve, reject) => {
    staticServer.once("error", reject);
    staticServer.listen(0, "127.0.0.1", resolve);
  });
  const address = staticServer.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise((resolve, reject) => {
    staticServer.close((error) => (error ? reject(error) : resolve()));
  });
  expect(unsafeServerRequests, "The local QA server must never receive a write request").toEqual([]);
});

test.beforeEach(async ({ page }) => {
  await installReadOnlyNetworkGuard(page);
});

test.afterEach(async ({ page }) => {
  expect(
    unsafeBrowserRequests.get(page),
    "Frontend shell QA must not initiate POST, PUT, PATCH, DELETE, or other write requests",
  ).toEqual([]);
});

test("shell matrix inventory is explicit and excludes specialized chrome", () => {
  expect(TOOL_ROUTES).toHaveLength(14);
  expect(GENERAL_PUBLIC_ROUTES).toHaveLength(13);
  expect(APP_ROUTES).toHaveLength(2);
  expect(COMMON_SHELL_ROUTES).toHaveLength(29);
  expect(APP_SHELL_ROUTES).toHaveLength(8);
  expect(new Set(COMMON_SHELL_ROUTES).size).toBe(COMMON_SHELL_ROUTES.length);

  const excluded = Object.values(EXCLUDED_ROUTES).flat();
  expect(excluded).toEqual([
    "/login.html",
    "/password-reset.html",
    "/signup.html",
    "/verify-email.html",
    "/admin.html",
    "/create.html",
    "/editor.html",
    "/exam-prep.html",
    "/filechat.html",
    "/physics-studio.html",
    "/studio.html",
    "/study.html",
    "/translate.html",
    "/vibe-coding.html",
  ]);
  for (const route of excluded) expect(COMMON_SHELL_ROUTES).not.toContain(route);
});

test("removed standalone tools are absent from the public tree", () => {
  for (const route of [
    "/tools/word-count.html",
    "/tools/regression.html",
    "/tools/graph.html",
  ]) {
    expect(fs.existsSync(path.join(PUBLIC_DIR, route.replace(/^\/+/, ""))), route).toBe(false);
  }
});

test("redesigned static pages use only the new independent stylesheet stack", () => {
  for (const route of NEW_STATIC_SHELL_ROUTES) {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, route.replace(/^\/+/, "")), "utf8");
    expect(source, route).toContain('href="/ui/foundation.css"');
    expect(source, route).toContain('href="/ui/shell.css"');
    if (route === "/developers.html") {
      expect(source, route).toContain('href="/ui/developers.css"');
      expect(source, route).not.toContain('href="/ui/pages.css"');
    } else {
      expect(source, route).toContain('href="/ui/pages.css"');
    }
    expect(source, route).not.toMatch(/href="\/(?:style|site-shell|home-redesign|auth-ui)\.css"/);
    expect(source, route).not.toContain('href="/apps/apps.css"');
    expect(source, route).not.toMatch(/<style\b|style="/);
    expect(source, route).not.toMatch(/\son(?:click|change|input|submit)\s*=/i);
  }
});

test("school application connects validation errors to fields and clears them while editing", async ({ page }) => {
  await page.goto(`${baseUrl}/school-apply.html`, { waitUntil: "networkidle" });

  await page.locator('[data-next-step="2"]').click();
  await expect(page.locator("#schoolName")).toBeFocused();
  await expect(page.locator("#schoolName")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#schoolName")).toHaveAttribute("aria-errormessage", "schoolNameError");
  await expect(page.locator("#schoolNameError")).toHaveText("학교명을 입력해 주세요.");

  await page.locator("#schoolName").fill("QA과학고등학교");
  await expect(page.locator("#schoolName")).not.toHaveAttribute("aria-invalid");
  await expect(page.locator("#schoolName")).not.toHaveAttribute("aria-errormessage");
  await expect(page.locator("#schoolNameError")).toBeEmpty();
  await page.locator("#contactName").fill("테스트 담당자");
  await page.locator("#contactEmail").fill("teacher@qa.hs.kr");
  await page.locator('[data-next-step="2"]').click();

  await page.locator('[data-next-step="3"]').click();
  await expect(page.locator("#studentEmailDomain")).toBeFocused();
  await expect(page.locator("#studentEmailDomain")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#studentEmailDomain")).toHaveAttribute("aria-errormessage", "studentEmailDomainError");
  await expect(page.locator("#studentEmailDomainError")).toContainText("도메인을 입력");

  await page.locator("#studentEmailDomain").fill("qa.hs.kr");
  await expect(page.locator("#studentEmailDomain")).not.toHaveAttribute("aria-invalid");
  await expect(page.locator("#studentEmailDomain")).not.toHaveAttribute("aria-errormessage");
  await page.locator('[data-next-step="3"]').click();

  await page.locator("#btn").click();
  await expect(page.locator("#consent")).toBeFocused();
  await expect(page.locator("#consent")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#consent")).toHaveAttribute("aria-errormessage", "consentError");
  await expect(page.locator("#consentError")).toHaveText("개인정보 수집·이용 동의가 필요합니다.");

  await page.locator("#consent").check();
  await expect(page.locator("#consent")).not.toHaveAttribute("aria-invalid");
  await expect(page.locator("#consent")).not.toHaveAttribute("aria-errormessage");
  await expect(page.locator("#consentError")).toBeEmpty();
});

test("school application exposes one file picker control and keeps drag-drop capped at eight files", async ({ page }) => {
  await page.goto(`${baseUrl}/school-apply.html`, { waitUntil: "networkidle" });
  await page.locator("#schoolName").fill("QA과학고등학교");
  await page.locator("#contactName").fill("테스트 담당자");
  await page.locator("#contactEmail").fill("teacher@qa.hs.kr");
  await page.locator('[data-next-step="2"]').click();

  const dropzone = page.locator("#fileDropzone");
  const trigger = page.locator("[data-file-trigger]");
  await expect(dropzone).toHaveAttribute("role", "group");
  await expect(dropzone).not.toHaveAttribute("role", "button");
  await expect(dropzone).not.toHaveAttribute("tabindex");
  await expect(trigger).toHaveAttribute("aria-controls", "files");

  await page.evaluate(() => {
    const input = document.getElementById("files");
    window.__qaFileInputClicks = 0;
    input.addEventListener("click", () => { window.__qaFileInputClicks += 1; });
  });
  await trigger.click();
  await trigger.focus();
  await trigger.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__qaFileInputClicks)).toBe(2);

  await dropzone.click({ position: { x: 12, y: 12 } });
  await expect.poll(() => page.evaluate(() => window.__qaFileInputClicks)).toBe(2);

  await page.evaluate(() => {
    const transfer = new DataTransfer();
    for (let index = 1; index <= 9; index += 1) {
      transfer.items.add(new File([`fixture-${index}`], `fixture-${index}.pdf`, {
        type: "application/pdf",
        lastModified: index,
      }));
    }
    const target = document.getElementById("fileDropzone");
    target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.locator("#fileList li")).toHaveCount(8);
  await expect(page.locator("#fileError")).toHaveText("첨부 파일은 최대 8개까지 접수됩니다.");
  await expect(dropzone).not.toHaveClass(/is-dragging/);
});

test("app pages expose first-party platform download endpoints", () => {
  const expected = {
    "/apps/quilo.html": "/api/apps/quilo/download?platform=",
    "/apps/live-translator.html": "/api/apps/live-translator/download?platform=",
  };
  for (const [route, prefix] of Object.entries(expected)) {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, route.replace(/^\/+/, "")), "utf8");
    expect(source, route).not.toContain("다운로드 페이지 열기");
    expect(source, route).not.toContain("fakeminjun7321.github.io/quilo-app");
    expect(source.match(/data-app-download/g)?.length, route).toBeGreaterThanOrEqual(4);
    expect(source, route).toContain(`${prefix}mac`);
    expect(source, route).toContain(`${prefix}windows`);
  }
});

for (const viewport of VIEWPORTS) {
  test.describe(`common shell ${viewport.name}`, () => {
    for (const route of COMMON_SHELL_ROUTES) {
      test(`${route} renders the shared shell without overflow or console errors`, async ({ page }) => {
        const consoleErrors = collectConsoleErrors(page);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });

        await expect(page.locator("[data-ui-shell]"), `${route} shared shell`).toBeVisible();
        await expect(page.locator(".ui-site-header"), `${route} visible header`).toBeVisible();
        await expect(page.locator(".ui-site-footer"), `${route} visible footer`).toBeVisible();
        await expect(page.locator("#main-content"), `${route} main landmark`).toHaveCount(1);
        await expect(page.locator("#main-content"), `${route} visible main content`).toBeVisible();
        await expect(page.locator(".landing-nav"), `${route} legacy navigation`).toHaveCount(0);

        if (viewport.width > 1120) {
          await expect(page.locator(".ui-site-nav"), `${route} desktop navigation`).toBeVisible();
          await expect(page.locator(".ui-site-actions"), `${route} desktop actions`).toBeVisible();
          await expect(page.locator("[data-ui-mobile-trigger]"), `${route} mobile trigger`).toBeHidden();

          const themeButton = page.locator(".ui-site-actions .ui-theme-toggle");
          await expect(themeButton, `${route} desktop theme control`).toBeVisible();
          await expect(themeButton).toHaveAttribute("aria-label", /테마로 변경/);
          const initialTheme = await page.locator("html").getAttribute("data-theme");
          await themeButton.click();
          await expect(page.locator("html")).not.toHaveAttribute("data-theme", initialTheme || "light");
        } else {
          await expect(page.locator(".ui-site-nav"), `${route} compact navigation`).toBeHidden();
          await expect(page.locator(".ui-site-actions"), `${route} compact actions`).toBeHidden();
          await expect(page.locator("[data-ui-mobile-trigger]"), `${route} compact menu trigger`).toBeVisible();
        }

        const shellClipping = await page.evaluate(() =>
          [".ui-site-header__inner", ".ui-site-footer__inner"].flatMap((selector) => {
            const element = document.querySelector(selector);
            if (!element) return [{ selector, reason: "missing" }];
            const rect = element.getBoundingClientRect();
            return element.scrollWidth > element.clientWidth + 1 || rect.width <= 0 || rect.height <= 0
              ? [{ selector, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, width: rect.width, height: rect.height }]
              : [];
          }),
        );
        expect(shellClipping, `${route} header/footer clipping`).toEqual([]);

        const overflow = await horizontalOverflowReport(page);
        expect(
          overflow.documentWidth,
          `${route} at ${viewport.name} overflows ${overflow.viewportWidth}px; offenders: ${JSON.stringify(overflow.offenders)}`,
        ).toBeLessThanOrEqual(overflow.viewportWidth + 1);
        expect(consoleErrors, `${route} at ${viewport.name} console health`).toEqual([]);

        if (route === "/developers.html" && viewport.width === 1440) {
          await page.screenshot({ path: "/tmp/quilo-public-developers-1440.png", fullPage: false });
        }
        if (route === "/tools/index.html" && viewport.width === 933) {
          await page.screenshot({ path: "/tmp/quilo-public-tools-933.png", fullPage: false });
        }

        if (viewport.width === 1440) {
          if (APP_ROUTES.includes(route)) {
            const appName = route.includes("live-translator") ? "live-translator" : "quilo";
            const download = page.locator(
              `[data-app-download][data-app="${appName}"][data-platform="mac"]`,
            ).filter({ hasText: "macOS용 다운로드" });
            await expect(download, `${route} primary direct-download CTA`).toHaveCount(1);
            await expect(download).toHaveAttribute(
              "href",
              `/api/apps/${appName}/download?platform=mac`,
            );
            const [downloadEvent] = await Promise.all([
              page.waitForEvent("download"),
              download.click(),
            ]);
            expect(downloadEvent.suggestedFilename()).toBe("qa-installer.dmg");
            await expect(page.locator("[data-app-download-status]")).toContainText("다운로드를 시작했습니다");
          } else {
            const startCta = page.locator('.ui-site-actions .ui-site-cta[href="/signup.html"]');
            await expect(startCta, `${route} primary CTA`).toHaveCount(1);
            await startCta.click();
            await expect(page).toHaveURL(`${baseUrl}/signup.html`);
          }
        }
      });
    }
  });
}

for (const viewport of APP_SHELL_VIEWPORTS) {
  test.describe(`app shell ${viewport.name}`, () => {
    for (const route of APP_SHELL_ROUTES) {
      test(`${route} renders the shared header and app surface without overflow or console errors`, async ({ page }) => {
        const consoleErrors = collectConsoleErrors(page);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });

        await expect(page.locator("[data-app-shell]"), `${route} app shell root`).toHaveCount(1);
        await expect(page.locator("[data-app-shell]"), `${route} visible app shell`).toBeVisible();
        await expect(page.locator("[data-ui-shell]"), `${route} shared header root`).toHaveCount(1);
        await expect(page.locator(".ui-site-header"), `${route} shared header`).toBeVisible();
        if (viewport.width > 1120) {
          await expect(page.locator(".ui-site-nav"), `${route} shared navigation`).toBeVisible();
          await expect(page.locator(".ui-site-actions"), `${route} shared actions`).toBeVisible();
        } else {
          await expect(page.locator(".ui-site-nav"), `${route} compact navigation`).toBeHidden();
          await expect(page.locator(".ui-site-actions"), `${route} compact actions`).toBeHidden();
          await expect(page.locator("[data-ui-mobile-trigger]"), `${route} compact menu trigger`).toBeVisible();
        }
        await expect(page.locator("#main-content"), `${route} main landmark`).toHaveCount(1);
        await expect(page.locator("#main-content"), `${route} visible main content`).toBeVisible();
        await expect(page.locator(".app-commandbar"), `${route} removed app commandbar`).toHaveCount(0);
        const headerToken = await page.evaluate(() =>
          Number.parseInt(
            getComputedStyle(document.documentElement).getPropertyValue("--ui-site-header-h"),
            10,
          ),
        );
        expect(headerToken, `${route} common header height token`).toBe(viewport.width > 1120 ? 72 : 68);

        const overflow = await horizontalOverflowReport(page);
        expect(
          overflow.documentWidth,
          `${route} at ${viewport.name} overflows ${overflow.viewportWidth}px; offenders: ${JSON.stringify(overflow.offenders)}`,
        ).toBeLessThanOrEqual(overflow.viewportWidth + 1);
        expect(consoleErrors, `${route} at ${viewport.name} console health`).toEqual([]);
      });
    }
  });
}

test("index mobile uses the canonical scroll-contained mobile panel", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });

  await expect(page.locator("body")).toHaveAttribute("data-auth", "out");
  const trigger = page.locator("[data-ui-mobile-trigger]");
  const panel = page.locator("#uiMobilePanel");
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toBeVisible();

  const metrics = await page.evaluate(() => {
    const navElement = document.querySelector(".ui-mobile-panel");
    const firstMenuLink = navElement.querySelector("a");
    const cta = navElement.querySelector(".ui-site-cta");
    const navRect = navElement.getBoundingClientRect();
    const firstRect = firstMenuLink.getBoundingClientRect();
    const ctaRect = cta.getBoundingClientRect();
    const navStyle = getComputedStyle(navElement);
    const firstStyle = getComputedStyle(firstMenuLink);
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      navLeft: navRect.left,
      navRight: navRect.right,
      navTop: navRect.top,
      navBottom: navRect.bottom,
      navWidth: navRect.width,
      navHeight: navRect.height,
      navOverflowY: navStyle.overflowY,
      navDisplay: navStyle.display,
      navColumns: navStyle.gridTemplateColumns,
      firstLeft: firstRect.left,
      firstTextAlign: firstStyle.textAlign,
      ctaLeft: ctaRect.left,
      ctaWidth: ctaRect.width,
    };
  });

  expect(metrics.navHeight).toBeGreaterThan(120);
  expect(metrics.navBottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.navOverflowY).toMatch(/auto|scroll/);
  expect(metrics.navDisplay).toBe("block");
  expect(metrics.navLeft).toBeGreaterThanOrEqual(0);
  expect(metrics.navRight).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.firstTextAlign).toMatch(/^(left|start)$/);
  expect(metrics.firstLeft).toBeGreaterThanOrEqual(metrics.navLeft + 10);
  expect(metrics.ctaLeft).toBeGreaterThanOrEqual(metrics.navLeft + 10);
  expect(metrics.ctaWidth).toBeGreaterThan(120);
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(consoleErrors, "index mobile topnav console health").toEqual([]);
});
