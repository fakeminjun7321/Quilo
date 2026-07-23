const fs = require("fs");
const http = require("http");
const path = require("path");

function loadPlaywrightTest() {
  try {
    return require("@playwright/test");
  } catch (error) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const cached = Object.keys(require.cache).find(
      (key) =>
        key.includes(`${marker}@playwright${path.sep}test${path.sep}`) ||
        key.includes(`${marker}playwright${path.sep}`),
    );
    if (!cached) throw error;
    const root = cached.slice(0, cached.indexOf(marker) + marker.length);
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
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

let server;
let baseUrl;
const unsafeRequests = [];

function fixture(pathname) {
  if (pathname === "/api/me") return { user: "모바일 QA 관리자", name: "모바일 QA 관리자", isAdmin: true };
  if (pathname === "/api/subscriptions/me") return { active: true, admin: true };
  if (pathname === "/api/admin/users") return { users: [], krwPerUsd: 1400 };
  if (pathname === "/api/admin/usage-logs") return { logs: [] };
  if (pathname === "/api/admin/problemset-limit") return { limit: 100 };
  if (pathname === "/api/admin/chat/models" || pathname === "/api/admin/code-assist/models") {
    return { models: [{ id: "default", label: "기본 모델" }] };
  }
  if (pathname === "/api/admin/beta") return { features: [] };
  if (pathname === "/api/admin/beta/pro/testers") return { testers: [] };
  if (pathname === "/api/announcements/all" || pathname === "/api/announcements") return { announcements: [] };
  if (pathname === "/api/grants") return { grants: [] };
  if (pathname === "/api/subscriptions") return { subscriptions: [] };
  if (pathname === "/api/subscriptions/requests") return { requests: [] };
  if (pathname === "/api/community/appeals") return { appeals: [] };
  if (pathname === "/api/school-apply/admin/list") return { applications: [] };
  return {};
}

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const method = String(request.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      unsafeRequests.push(`${method} ${url.pathname}`);
      response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Read-only mobile QA");
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" });
      response.end(JSON.stringify(fixture(url.pathname)));
      return;
    }

    const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const file = path.resolve(PUBLIC_DIR, relative);
    if (file !== PUBLIC_DIR && !file.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    fs.readFile(file, (error, body) => {
      if (error) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      });
      response.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  expect(unsafeRequests, "mobile layout QA must remain read-only").toEqual([]);
});

function collectErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

for (const viewport of [
  { name: "phone-390", width: 390, height: 844 },
  { name: "mobile-boundary-760", width: 760, height: 900 },
]) {
  test(`admin console is usable at ${viewport.name}`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${baseUrl}/admin.html`, { waitUntil: "networkidle" });

    await expect(page.locator(".operations-commandbar")).toBeVisible();
    await expect(page.locator("#adminTabs")).toBeVisible();
    await expect(page.locator("#adminAiSection")).toBeVisible();

    const baseLayout = await page.evaluate(() => {
      const header = document.querySelector(".operations-commandbar");
      const tabs = document.getElementById("adminTabs");
      const main = document.querySelector(".operations-main");
      const theme = document.getElementById("themeToggle");
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        headerHeight: Math.round(header.getBoundingClientRect().height),
        tabsDirection: getComputedStyle(tabs).flexDirection,
        tabsOverflowX: getComputedStyle(tabs).overflowX,
        tabsTop: Math.round(tabs.getBoundingClientRect().top),
        tabsInternalOverflow: tabs.scrollWidth > tabs.clientWidth,
        mainMarginLeft: getComputedStyle(main).marginLeft,
        themeWidth: Math.round(theme.getBoundingClientRect().width),
      };
    });
    expect(baseLayout.documentWidth).toBeLessThanOrEqual(baseLayout.viewportWidth + 1);
    expect(baseLayout.headerHeight).toBe(68);
    expect(baseLayout.tabsDirection).toBe("row");
    expect(baseLayout.tabsOverflowX).toBe("auto");
    expect(baseLayout.tabsTop).toBe(68);
    if (viewport.width === 390) expect(baseLayout.tabsInternalOverflow).toBe(true);
    expect(baseLayout.mainMarginLeft).toBe("0px");
    expect(baseLayout.themeWidth).toBe(40);

    await page.locator('#adminTabs .atab[data-go="users"]').click();
    await expect(page.locator("#adminUsersSection")).toBeVisible();
    await expect(page.locator("#adminUserInspector")).toBeVisible();

    const userLayout = await page.evaluate(() => {
      const main = document.querySelector(".operations-main");
      const inspector = document.getElementById("adminUserInspector");
      const wrapper = document.querySelector("#adminUsersSection .table-wrapper");
      return {
        columns: getComputedStyle(main).gridTemplateColumns.split(" ").filter(Boolean).length,
        inspectorPosition: getComputedStyle(inspector).position,
        inspectorHeight: getComputedStyle(inspector).height,
        tableContained: wrapper.scrollWidth >= wrapper.clientWidth && wrapper.getBoundingClientRect().right <= innerWidth + 1,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
      };
    });
    expect(userLayout.columns).toBe(1);
    expect(userLayout.inspectorPosition).toBe("static");
    expect(userLayout.inspectorHeight).not.toBe("0px");
    expect(userLayout.tableContained).toBe(true);
    expect(userLayout.documentWidth).toBeLessThanOrEqual(userLayout.viewportWidth + 1);
    expect(errors).toEqual([]);

    if (viewport.width === 390) {
      await page.screenshot({ path: "/tmp/quilo-admin-mobile-390.png", fullPage: false });
    }
  });

  test(`PDF translator keeps one continuous mobile workflow at ${viewport.name}`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${baseUrl}/translate.html`, { waitUntil: "networkidle" });

    await expect(page.locator("#tool")).toBeVisible();
    await expect(page.locator(".pdf-workspace")).toBeVisible();

    const layout = await page.evaluate(() => {
      const workspace = document.querySelector(".pdf-workspace");
      const regions = [".pdf-files", ".pdf-options", ".pdf-summary"].map((selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { top: Math.round(rect.top), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
      });
      const status = document.querySelector(".pdf-statusbar").getBoundingClientRect();
      return {
        direction: getComputedStyle(workspace).flexDirection,
        regions,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        statusBottom: Math.round(innerHeight - status.bottom),
      };
    });
    expect(layout.direction).toBe("column");
    expect(layout.regions[0].top).toBeLessThan(layout.regions[1].top);
    expect(layout.regions[1].top).toBeLessThan(layout.regions[2].top);
    for (const region of layout.regions) {
      expect(region.left).toBeGreaterThanOrEqual(0);
      expect(region.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
    }
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.statusBottom).toBe(0);

    await page.locator("#trMode").selectOption("retypeset");
    await expect(page.locator("#trModeHint")).toContainText("다시 조판");
    expect(errors).toEqual([]);

    if (viewport.width === 390) {
      await page.screenshot({ path: "/tmp/quilo-pdf-mobile-390.png", fullPage: false });
    }
  });
}
