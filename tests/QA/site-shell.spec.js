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
const { FEATURES } = require("../../lib/quilo-catalog");

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
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

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
    "/api/chat/status": { enabled: false, writeAssistEnabled: false },
    "/api/filechat/access": { allowed: false },
    "/api/me/beta": { admin: false, features: [] },
    "/api/subscriptions/me": { active: false, subscription: null },
    "/api/version": { version: "qa" },
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
      const fixture = readOnlyApiFixture(url.pathname);
      await route.fulfill({
        status: fixture.status,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(fixture.body),
      });
      return;
    }

    if (url.origin !== baseUrl) {
      await route.abort("blockedbyclient");
      return;
    }

    await route.continue();
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
  expect(unsafeBrowserRequests.get(page), "Shell smoke tests must not initiate write requests").toEqual([]);
});

test("open-source equation boundary renders without the excluded vendor engine", async ({ page }) => {
  const responses = [];
  page.on("response", (response) => responses.push({
    path: new URL(response.url()).pathname,
    status: response.status(),
  }));

  await page.goto(`${baseUrl}/equation/index.html`, { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "한글 수식 변환기", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "왜 제외되었나요?" })).toBeVisible();
  await expect(page.getByRole("link", { name: "GitHub Issues" })).toHaveAttribute(
    "href",
    "https://github.com/fakeminjun7321/Quilo/issues",
  );
  expect(responses.some(({ path }) => path.startsWith("/equation/src/"))).toBe(false);
  expect(responses.some(({ path }) => path === "/equation/vendor/jszip.min.js")).toBe(false);
  expect(
    responses.filter(
      ({ path, status }) => status >= 400 && !(path === "/api/me" && status === 401),
    ),
  ).toEqual([]);
});

test("guide desktop shell renders with real navigation destinations", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseUrl}/guide.html`, { waitUntil: "domcontentloaded" });

  await expect(page.locator("[data-ui-shell]")).toBeVisible();
  await expect(page.locator(".ui-site-nav")).toBeVisible();
  await expect(page.locator(".ui-site-actions")).toBeVisible();
  await expect(page.locator("[data-ui-mobile-trigger]")).toBeHidden();
  await expect(page.locator("#main-content")).toBeVisible();
  await expect(page.locator('.ui-skip-link[href="#main-content"]')).toHaveText("본문으로 건너뛰기");

  const desktopHrefs = await page.locator(".ui-site-nav > a[href]").evaluateAll((links) =>
    links.map((link) => link.getAttribute("href")),
  );
  expect(desktopHrefs).toEqual([
    "/pricing.html",
    "https://www.instagram.com/quilo._.official/",
  ]);
  await expect(page.locator(".ui-site-nav [data-ui-menu-trigger]")).toHaveText([
    "제품", "학습", "창작", "파일 및 번역", "개발자", "리소스",
  ]);
  await page.locator('[data-ui-menu-trigger="0"]').click();
  await expect(page.locator('#uiSiteMega [data-report="chem-pre"]')).toBeVisible();
  await expect(page.locator('.ui-site-actions a[href="/login.html?next=%2Fguide.html"]')).toHaveText("로그인");
  await expect(page.locator('.ui-site-actions .ui-site-cta[href="/signup.html"]')).toHaveText("무료로 시작하기");

  const placeholderLinks = page.locator('[data-ui-shell] a[href="#"], [data-ui-shell] a:not([href])');
  await expect(placeholderLinks).toHaveCount(0);
});

test("guide 933px shell uses the compact navigation without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 933, height: 844 });
  await page.goto(`${baseUrl}/guide.html`, { waitUntil: "domcontentloaded" });

  await expect(page.locator(".ui-site-nav")).toBeHidden();
  await expect(page.locator(".ui-site-actions")).toBeHidden();
  const trigger = page.locator("[data-ui-mobile-trigger]");
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.locator("#uiMobilePanel")).toBeVisible();
  await expect(page.locator('#uiMobilePanel a[href="/signup.html"]')).toHaveText("무료로 시작하기");

  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport + 1);
});

test("pricing page explains plan differences without inventing a fixed price", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseUrl}/pricing.html`, { waitUntil: "domcontentloaded" });

  await expect(page).toHaveTitle("요금 및 플랜 — Quilo");
  await expect(page.locator("#main-content h1")).toHaveText("요금 및 플랜");
  await expect(page.locator("#main-content tbody th")).toHaveText(["Free", "Pro", "Max"]);
  await expect(page.locator('#main-content a[href="/login.html?next=%2Fpricing.html"]')).toHaveText("로그인하고 현재 플랜 확인");
  await expect(page.locator("#main-content")).toContainText("Max 가격·기간·입금 안내는 그 화면에 표시되는 현재 운영 설정을 기준으로 합니다.");
  const mainText = await page.locator("#main-content").innerText();
  expect(mainText).not.toMatch(/\d[\d,]*\s*원/);
  await expect(page.locator('#main-content [data-ui-start-action]')).toHaveAttribute("href", "/signup.html");
  await expect(page.locator('#main-content [data-ui-start-action]')).toHaveText("무료로 시작하기");
});

test("shared shell prefetches a likely same-origin destination only after intent", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseUrl}/guide.html`, { waitUntil: "domcontentloaded" });

  await expect(page.locator('link[rel="prefetch"][href="/pricing.html"]')).toHaveCount(0);
  await page.locator('.ui-site-nav > a[href="/pricing.html"]').hover();
  await expect(page.locator('link[rel="prefetch"][href="/pricing.html"]')).toHaveCount(1);
});

test("home metadata positions Quilo as a broad learning and research workspace", async ({ page }) => {
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("Quilo | 학습과 연구를 위한 AI Workspace");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /보고서, 리서치, 데이터 분석, 문서, 번역과 코딩/,
  );
});

test("every public pricing navigation points to the visible pricing page", () => {
  const htmlFiles = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".html")) htmlFiles.push(target);
    }
  };
  visit(PUBLIC_DIR);

  expect(fs.existsSync(path.join(PUBLIC_DIR, "pricing.html"))).toBe(true);
  for (const file of htmlFiles) {
    const source = fs.readFileSync(file, "utf8");
    expect(source, path.relative(PUBLIC_DIR, file)).not.toMatch(/href=["']\/?#balanceBox["']/);
  }
});

test("every catalog feature exposes a real destination and an explicit audience", () => {
  const serverSource = fs.readFileSync(path.join(process.cwd(), "server.js"), "utf8");
  expect(FEATURES.length).toBeGreaterThan(30);
  for (const feature of FEATURES) {
    expect(["public", "member", "pro", "max", "admin"], `${feature.id} audience`).toContain(feature.audience);
    expect(["active", "pro", "max", "paused", "beta"], `${feature.id} status`).toContain(feature.status);
    const pathname = new URL(feature.path, "http://quilo.local").pathname;
    // "/schedule/"은 정적 파일이 아니라 server.js의 app.use("/schedule", …) 라우트가 서빙한다.
    if (pathname === "/schedule/") {
      expect(serverSource, `${feature.id} dynamic destination`).toMatch(/app\.use\(["']\/schedule["']/);
      continue;
    }
    const target = pathname === "/"
      ? path.join(PUBLIC_DIR, "index.html")
      : path.join(PUBLIC_DIR, pathname.replace(/^\/+/, ""));
    expect(fs.existsSync(target), `${feature.id} destination ${feature.path}`).toBe(true);
  }
});

test("shared shell is the single source for account and navigation destinations", () => {
  const sharedShellPages = [
    "index.html",
    "create.html", "editor.html", "exam-prep.html", "filechat.html", "physics-studio.html",
    "studio.html", "study.html", "translate.html", "vibe-coding.html", "developers.html",
  ];
  for (const file of sharedShellPages) {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8");
    expect(source, file).not.toContain('/account.html');
    expect(source, file).toContain("data-ui-shell");
    expect(source, file).toContain('src="/ui/shell.js"');
  }

  const shell = fs.readFileSync(path.join(PUBLIC_DIR, "ui", "shell.js"), "utf8");
  expect(shell).toContain('href="/#settings"');
  expect(shell).toContain('href="/#files"');
  expect(shell).toContain('href="/#integrations"');
  expect(shell).toContain('href="/support.html"');
  expect(shell).toContain('/developers.html#catalog');
  expect(shell).toContain('/developers.html#tokenCard');

  const retiredTranslator = fs.readFileSync(path.join(PUBLIC_DIR, "translate-app.html"), "utf8");
  expect(retiredTranslator).toContain('content="0;url=/translate.html"');
  expect(retiredTranslator).toContain('location.replace("/translate.html"');

  const developers = fs.readFileSync(path.join(PUBLIC_DIR, "developers.html"), "utf8");
  expect(developers).toContain('id="catalog"');
  expect(developers).toContain('id="tokenCard"');
});

test("desktop mega menu switches groups and returns focus on Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseUrl}/guide.html`, { waitUntil: "domcontentloaded" });

  const productTrigger = page.locator('[data-ui-menu-trigger="0"]');
  const resourceTrigger = page.locator('[data-ui-menu-trigger="5"]');
  const panel = page.locator("#uiSiteMega");

  await productTrigger.click();
  await expect(productTrigger).toHaveAttribute("aria-expanded", "true");

  await resourceTrigger.click();
  await expect(resourceTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(productTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toContainText("이용 가이드");

  const focusedMenuLink = panel.locator('a[href="/guide.html"]').first();
  await focusedMenuLink.focus();
  await expect(focusedMenuLink).toBeFocused();
  await focusedMenuLink.press("Escape");

  await expect(panel).toHaveAttribute("aria-hidden", "true");
  await expect(resourceTrigger).toBeFocused();
});

test("guide mobile shell exposes the same real destinations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/guide.html`, { waitUntil: "domcontentloaded" });

  await expect(page.locator(".ui-site-nav")).toBeHidden();
  await expect(page.locator(".ui-site-actions")).toBeHidden();

  const mobileSummary = page.locator("[data-ui-mobile-trigger]");
  const mobilePanel = page.locator("#uiMobilePanel");
  await expect(mobileSummary).toBeVisible();
  await mobileSummary.click();
  await expect(mobileSummary).toHaveAttribute("aria-expanded", "true");
  await expect(mobilePanel).toBeVisible();

  const mobileHrefs = await mobilePanel.locator("a[href]").evaluateAll((links) =>
    links.map((link) => link.getAttribute("href")),
  );
  expect(mobileHrefs).toContain("/?report=chem-pre");
  expect(mobileHrefs).toContain("/tools/index.html");
  expect(mobileHrefs).toContain("/developers.html#catalog");
  expect(mobileHrefs).toContain("/pricing.html");
  expect(mobileHrefs).toContain("/login.html?next=%2Fguide.html");
  expect(mobileHrefs).toContain("/signup.html");

  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
});

test("mobile login action opens the dedicated login page and preserves the current page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/guide.html`, { waitUntil: "domcontentloaded" });

  await page.locator("[data-ui-mobile-trigger]").click();
  await page.locator("#uiMobilePanel [data-ui-auth-action]").click();

  await expect(page).toHaveURL(`${baseUrl}/login.html?next=%2Fguide.html`);
  await expect(page.locator("#loginForm")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("mobile legacy login entry opens a visible login page and preserves returnTo", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/?login=1&returnTo=${encodeURIComponent("/developer-notes.html")}`, {
    waitUntil: "domcontentloaded",
  });

  await expect(page).toHaveURL(`${baseUrl}/login.html?next=%2Fdeveloper-notes.html`);
  await expect(page.locator("#loginForm")).toBeVisible();
});

test("mobile logged-out report selection opens login and keeps the pending report", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });

  await page.locator("[data-ui-mobile-trigger]").click();
  await page.locator('#uiMobilePanel a[data-report="chem-pre"]').click();

  await expect(page).toHaveURL(`${baseUrl}/login.html?next=%2F`);
  await expect(page.locator("#loginForm")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("pendingReportType"))).toBe("chem-pre");
});

test("login query opens the logged-out login dropdown without a write request", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseUrl}/?login=1`, { waitUntil: "domcontentloaded" });

  const accountSlot = page.locator("#accountSlot");
  const loginDropdown = page.locator("#loginDd");
  await expect(page.locator("body")).toHaveAttribute("data-auth", "out");
  await expect(accountSlot).toHaveClass(/is-open/);
  await expect(loginDropdown).toBeVisible();
  await expect(page.locator("#li_username")).toBeFocused();
});

test("logged-out report entry preserves intent and opens login instead of the removed hub", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseUrl}/?report=free`, { waitUntil: "domcontentloaded" });

  await expect(page.locator("body")).toHaveAttribute("data-auth", "out");
  await expect(page.locator("#accountSlot")).toHaveClass(/is-open/);
  await expect(page.locator("#loginDd")).toBeVisible();
  await expect(page.locator("#choosePrompt")).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("pendingReportType"))).toBe("free");
});
