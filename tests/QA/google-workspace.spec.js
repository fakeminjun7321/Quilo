const path = require("path");
const { startQaServer } = require("./helpers/qa-server");

function loadPlaywrightTest() {
  try { return require("@playwright/test"); }
  catch (error) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const cacheKey = Object.keys(require.cache).find((key) =>
      key.includes(`${marker}@playwright${path.sep}test${path.sep}`) || key.includes(`${marker}playwright${path.sep}`));
    if (!cacheKey) throw error;
    const root = cacheKey.slice(0, cacheKey.indexOf(marker) + marker.length);
    return require(path.join(root, "@playwright", "test"));
  }
}

const { test, expect } = loadPlaywrightTest();
let qaServer = null;
let BASE_URL = "";

test.beforeAll(async () => {
  qaServer = await startQaServer();
  BASE_URL = qaServer.baseUrl;
});

test.afterAll(async () => { if (qaServer) await qaServer.stop(); });

test("Google Workspace UI exposes real Drive, Docs, comments, save, disconnect, and reconnect flows", async ({ page }) => {
  let googleConnected = true;
  const calls = [];
  await page.addInitScript(() => { window.open = () => null; });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    calls.push({ pathname, method: request.method() });
    if (pathname === "/api/me") return route.fulfill({ json: { user: "QA", studentId: "2402", isAdmin: false, blockedReportTypes: [] } });
    if (pathname === "/api/me/beta") return route.fulfill({ json: { admin: false, tier: "pro", features: [] } });
    if (pathname === "/api/me/balance") return route.fulfill({ json: { credits: 10 } });
    if (pathname === "/api/announcements") return route.fulfill({ json: { announcements: [] } });
    if (pathname === "/api/me/files") return route.fulfill({ json: { storage: true, maxFilesPerUser: 3, files: [{ id: "report-1", filename: "물리 결과.docx", size_bytes: 12000, created_at: "2026-07-14T00:00:00Z", expires_at: "2026-07-15T00:00:00Z" }] } });
    if (pathname === "/api/cloud/providers/status") return route.fulfill({ json: { integrations: {
      google: { configured: true, connected: googleConnected, accountEmail: "qa@example.com", connectUrl: "/api/cloud/google/connect", reconnectUrl: "/api/cloud/google/connect?reconnect=1", disconnectUrl: "/api/cloud/google/disconnect" },
    } } });
    if (pathname === "/api/cloud/google/drive/folders") return route.fulfill({ json: { folders: [{ id: "folder-1", name: "Quilo" }] } });
    if (pathname === "/api/cloud/google/drive/files") return route.fulfill({ json: { files: [{ id: "doc-1", name: "실험 보고서", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-07-14T00:00:00Z", webViewLink: "https://docs.google.com/document/d/doc-1/edit" }] } });
    if (pathname === "/api/cloud/google/drive/files/doc-1/comments" && request.method() === "GET") return route.fulfill({ json: { comments: [{ id: "comment-1", content: "수치 확인", createdTime: "2026-07-14T00:00:00Z", author: { displayName: "QA" }, replies: [] }] } });
    if (pathname === "/api/cloud/google/drive/reports/report-1") return route.fulfill({ json: { file: { id: "gdoc-report", webViewLink: "https://docs.google.com/document/d/gdoc-report/edit" } }, status: 201 });
    if (pathname === "/api/cloud/google/disconnect") { googleConnected = false; return route.fulfill({ json: { ok: true, revoked: true } }); }
    if (pathname === "/api/subscriptions/me") return route.fulfill({ json: { active: false } });
    if (pathname === "/api/me/usage") return route.fulfill({ json: { credits: 10, genCount: 0, genLimit: 5, recent: [] } });
    return route.fulfill({ json: {} });
  });

  await page.goto(`${BASE_URL}/#integrations`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#googleWorkspace")).toBeVisible();
  await expect(page.locator(".cloud-provider-row")).toContainText("Google Drive·Docs");
  await expect(page.getByRole("link", { name: "재연결" })).toHaveAttribute("href", "/api/cloud/google/connect?reconnect=1");
  await expect(page.locator("#googleDriveFiles .google-drive-file")).toHaveCount(1);
  await expect(page.locator("#googleDriveFiles")).toContainText("실험 보고서");

  await page.locator("#googleDriveFolder").selectOption("folder-1");
  await page.locator("#googleAutoSaveReports").check();
  const autoSaveFields = await page.evaluate(async () => {
    const { createGenerationController } = await import("/workspace/generation-controller.js");
    const formData = new FormData();
    const noop = () => {};
    const controller = createGenerationController({
      lockForm: noop,
      backgroundChoice: () => ({ enabled: false, notifyEmail: false }),
      capturePreferences: noop,
      rememberSubmission: noop,
      clearRetryCard: noop,
      beginProgress: noop,
      setCurrentJob: noop,
      streamJob: noop,
      showBackgroundToast: noop,
      stopTimer: noop,
      resetForm: noop,
      showSuspendedAppeal: noop,
      showError: noop,
    });
    await controller.submitReport({ formEl: document.createElement("form"), formData });
    return Object.fromEntries(formData.entries());
  });
  expect(autoSaveFields.saveToGoogleDrive).toBe("true");
  expect(autoSaveFields.googleDriveFolderId).toBe("folder-1");

  await page.getByRole("button", { name: "본문 추가" }).click();
  await expect(page.locator("#googleAppendDocumentId")).toHaveValue("doc-1");
  await page.getByRole("button", { name: "댓글", exact: true }).click();
  await expect(page.locator("#googleCommentsPanel")).toBeVisible();
  await expect(page.locator("#googleCommentsList")).toContainText("수치 확인");

  await page.evaluate(() => window.__quiloWorkspaceRuntime.shell.showTab("files"));
  await expect(page.locator("#filesList")).toContainText("물리 결과.docx");
  await expect(page.getByRole("button", { name: "Drive 저장" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Google Docs" })).toBeVisible();
  await page.getByRole("button", { name: "Google Docs" }).click();
  await expect(page.locator("#googleReportStatus")).toContainText("Google Docs로 변환");
  expect(calls.some((call) => call.pathname === "/api/cloud/google/drive/reports/report-1" && call.method === "POST")).toBeTruthy();

  await page.evaluate(() => window.__quiloWorkspaceRuntime.shell.showTab("integrations"));
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "연결 해제" }).click();
  await expect(page.locator("#googleWorkspace")).toBeHidden();
  expect(calls.some((call) => call.pathname === "/api/cloud/google/disconnect" && call.method === "POST")).toBeTruthy();
});
