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
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

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

function createStaticServer() {
  return http.createServer((request, response) => {
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
      response.end(body);
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

let server;
let baseUrl;

test.beforeAll(async () => {
  server = createStaticServer();
  baseUrl = await listen(server);
});

test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function mockLoggedIn(page) {
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/me") {
      return route.fulfill({
        json: {
          user: "QA",
          studentId: "2402",
          isAdmin: false,
          styleNote: "",
          blockedReportTypes: [],
          reportEligible: true,
          emailVerified: true,
        },
      });
    }
    if (pathname === "/api/announcements") return route.fulfill({ json: { announcements: [] } });
    if (pathname === "/api/me/beta") return route.fulfill({ json: { admin: false, features: [] } });
    if (pathname === "/api/me/balance") return route.fulfill({ json: { credits: 8, unlimited: false } });
    if (pathname === "/api/subscriptions/me") return route.fulfill({ json: { active: false, subscription: null } });
    if (pathname === "/api/catalog") return route.fulfill({ json: { total: 0, categories: {}, features: [] } });
    return route.fulfill({ json: {} });
  });
}

async function expectBulkModeOpen(page) {
  await expect(page.locator("#readingLogForm")).toBeVisible();
  await expect(page.locator('input[name="reportType"][value="reading-log"]')).toBeChecked();
  await expect(page.locator('#readingLogForm input[name="rlMode"][value="bulk"]')).toBeChecked();
  await expect(page.locator("#rlBulkSection")).toBeVisible();
  await expect(page.locator("#rlBtn")).toHaveText("독서록 대량 생성 (ZIP)");
  await expect(page.locator("body")).toHaveAttribute("data-view", "workspace");
}

test("/?report=reading-log-bulk opens the 독서록 form in bulk mode", async ({ page }) => {
  await mockLoggedIn(page);
  await page.goto(`${baseUrl}/?report=reading-log-bulk`, { waitUntil: "load" });
  // select()가 report 런타임 lazy import보다 먼저 실행되는 경로까지 그대로 검증한다.
  await expectBulkModeOpen(page);
});

test("in-page 독서록 대량 생성 nav link selects bulk mode", async ({ page }) => {
  await mockLoggedIn(page);
  await page.goto(`${baseUrl}/`, { waitUntil: "load" });
  await expect(page.locator("body")).toHaveAttribute("data-auth", "in");
  // 데스크톱 메가메뉴 패널은 열 때 lazy 렌더되지만 모바일 패널 앵커는 로드 시 즉시 존재한다.
  // 숨겨진 앵커라 locator 클릭 대신 위임 핸들러(shell-controller)로 이벤트를 흘린다.
  await page.waitForSelector('[data-ui-shell] a[data-report="reading-log-bulk"]', { state: "attached" });
  await page.evaluate(() => {
    document.querySelector('[data-ui-shell] a[data-report="reading-log-bulk"]').click();
  });
  await expectBulkModeOpen(page);
});
