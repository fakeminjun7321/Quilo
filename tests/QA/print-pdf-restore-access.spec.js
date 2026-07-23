const path = require("path");
const { startQaServer } = require("./helpers/qa-server");

function loadPlaywrightTest() {
  try { return require("@playwright/test"); }
  catch (error) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const cacheKey = Object.keys(require.cache).find((key) =>
      key.includes(`${marker}@playwright${path.sep}test${path.sep}`) ||
      key.includes(`${marker}playwright${path.sep}`));
    if (!cacheKey) throw error;
    const root = cacheKey.slice(0, cacheKey.indexOf(marker) + marker.length);
    return require(path.join(root, "@playwright", "test"));
  }
}

const { test, expect } = loadPlaywrightTest();
let qaServer = null;
let BASE_URL = "";

async function mockApis(page, isAdmin) {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/me") return route.fulfill({ json: {
      user: isAdmin ? "관리자" : "일반 사용자",
      studentId: "2402",
      isAdmin,
      blockedReportTypes: [],
      reportEligible: true,
      analyticsConsent: false,
      analyticsConsentVersion: "2026-07-15",
    } });
    if (pathname === "/api/me/beta") return route.fulfill({ json: { admin: isAdmin, tier: isAdmin ? "admin" : "free", features: [] } });
    if (pathname === "/api/subscriptions/me") return route.fulfill({ json: { active: isAdmin, admin: isAdmin } });
    if (pathname === "/api/me/files") return route.fulfill({ json: { storage: true, files: [] } });
    if (pathname === "/api/cloud/providers/status") return route.fulfill({ json: { integrations: {} } });
    if (pathname === "/api/cloud/dropbox/status") return route.fulfill({ json: { enabled: false } });
    if (pathname === "/api/announcements") return route.fulfill({ json: { announcements: [] } });
    if (pathname === "/api/chat/status") return route.fulfill({ json: { enabled: false } });
    if (pathname === "/api/me/balance") return route.fulfill({ json: { credits: 24, unlimited: isAdmin, isAdmin } });
    return route.fulfill({ json: {} });
  });
}

test.beforeAll(async () => {
  qaServer = await startQaServer({ env: { NODE_ENV: "test" } });
  BASE_URL = qaServer.baseUrl;
});

test.afterAll(async () => { if (qaServer) await qaServer.stop(); });

test("admin direct URL opens the restoration workspace and form", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await mockApis(page, true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${BASE_URL}/?report=print-pdf-restore`, { waitUntil: "networkidle" });

  await expect(page).toHaveTitle(/Quilo/);
  await expect(page.locator("#workspaceSurface")).toBeVisible();
  // 보고서 종류 fieldset은 새 workspace UI에서 CSS로 접혀 있으므로 화면상 visible이
  // 아니라 관리자 권한에 의해 hidden 속성이 제거됐는지를 검사한다.
  await expect(page.locator("#rtPrintPdfRestore")).not.toHaveAttribute("hidden", "");
  await expect(page.locator('input[name="reportType"][value="print-pdf-restore"]')).toBeChecked();
  await expect(page.locator("#printPdfRestoreForm")).toBeVisible();
  await expect(page.locator("#workspaceTitle")).toHaveText("프린트 PDF 복원");

  await page.locator("#pprPageOrder").fill("3,1,2");
  await expect(page.locator("#pprPageOrder")).toHaveValue("3,1,2");
  await page.screenshot({ path: "/tmp/quilo-print-pdf-restore-admin.png", fullPage: false });
  expect(errors).toEqual([]);
});

test("restoration confirmation and numeric ETA use the shared styled generation UI", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await mockApis(page, true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${BASE_URL}/?report=print-pdf-restore`, { waitUntil: "networkidle" });
  await page.setInputFiles("#pprPhotos", {
    name: "print-page.png",
    mimeType: "image/png",
    buffer: Buffer.from("print restore QA"),
  });
  await page.locator('#reportWorkflowNav button[data-flow-jump="generate"]').click();
  await page.locator("#printPdfRestoreForm .policy-check input").check({ force: true });
  await page.locator("#pprBtn").click();

  const dialog = page.locator(".confirm-card");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("프린트 PDF 복원 · 관리자 베타");
  await expect(dialog).toContainText("예상 시간");
  await expect(dialog).not.toContainText("NaN");
  const geometry = await dialog.evaluate((card) => ({
    card: card.getBoundingClientRect().toJSON(),
    background: getComputedStyle(card).backgroundColor,
    overlayPosition: getComputedStyle(card.closest(".confirm-overlay")).position,
    overflow: document.documentElement.scrollWidth - innerWidth,
  }));
  expect(geometry.overlayPosition).toBe("fixed");
  expect(geometry.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(geometry.card.width).toBeLessThanOrEqual(620);
  expect(geometry.overflow).toBe(0);
  await expect(page.locator(".confirm-card button.primary")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#pprBtn")).toBeFocused();

  await page.evaluate(async () => {
    const { createProgressView } = await import("/workspace/progress-view.js");
    window.__qaProgressView = createProgressView();
    window.__qaProgressView.begin("복원 중...", 180);
  });
  await expect(page.locator("#genTimer")).toContainText("예상 3분 · 경과");
  await expect(page.locator("#genTimer")).not.toContainText("NaN");
  await expect(page.locator(".progress-details")).toBeHidden();
  await expect(page.locator("#progress")).toBeHidden();
  await page.evaluate(() => window.__qaProgressView.stopTimer());
  expect(errors).toEqual([]);
});

test("restoration confirmation remains usable at 390px", async ({ page }) => {
  await mockApis(page, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/?report=print-pdf-restore`, { waitUntil: "networkidle" });
  await page.setInputFiles("#pprPhotos", {
    name: "print-page.png",
    mimeType: "image/png",
    buffer: Buffer.from("print restore QA"),
  });
  await page.locator('#reportWorkflowNav button[data-flow-jump="generate"]').click();
  await page.locator("#printPdfRestoreForm .policy-check input").check({ force: true });
  await page.locator("#pprBtn").click();

  const geometry = await page.locator(".confirm-card").evaluate((card) => {
    const rect = card.getBoundingClientRect();
    const buttons = [...card.querySelectorAll(".confirm-actions button")].map((button) => button.getBoundingClientRect().height);
    return { left: rect.left, right: rect.right, bottom: rect.bottom, viewport: innerHeight, buttons, overflow: document.documentElement.scrollWidth - innerWidth };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(390);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport);
  expect(Math.min(...geometry.buttons)).toBeGreaterThanOrEqual(44);
  expect(geometry.overflow).toBe(0);
  await page.screenshot({ path: "/tmp/quilo-print-pdf-restore-confirm-mobile.png", fullPage: false });
});

test("non-admin direct URL cannot reveal the restoration entry or form", async ({ page }) => {
  await mockApis(page, false);
  await page.goto(`${BASE_URL}/?report=print-pdf-restore`, { waitUntil: "networkidle" });
  await expect(page.locator("#rtPrintPdfRestore")).toHaveAttribute("hidden", "");
  await expect(page.locator("#printPdfRestoreForm")).toBeHidden();
  await expect(page.locator('input[name="reportType"][value="print-pdf-restore"]')).not.toBeChecked();
});
