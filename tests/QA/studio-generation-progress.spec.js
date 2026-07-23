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
let qaServer;
let BASE_URL;

test.beforeAll(async () => {
  qaServer = await startQaServer({ env: { NODE_ENV: "test" } });
  BASE_URL = qaServer.baseUrl;
});

test.afterAll(async () => { if (qaServer) await qaServer.stop(); });

async function mockStudioApis(page, aborts) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/me") return route.fulfill({ json: { id: "qa-admin", user: "QA", isAdmin: true } });
    if (pathname === "/api/me/beta") return route.fulfill({ json: { admin: true, tier: "admin", features: ["create"] } });
    if (pathname === "/api/me/balance") return route.fulfill({ json: { credits: 99, unlimited: true } });
    if (pathname === "/api/artifacts/models") return route.fulfill({ json: { models: ["auto"], default: "auto" } });
    if (pathname === "/api/artifacts/image-models") return route.fulfill({ json: { models: ["auto"], default: "auto" } });
    if (pathname === "/api/studio/route") return route.fulfill({ json: { action: "generate", reportType: "cap-translate", reply: "문서를 만들고 있어요." } });
    if (pathname === "/api/generate") return route.fulfill({ json: { jobId: "qa-studio-job" } });
    if (pathname === "/api/jobs/qa-studio-job/abort") {
      aborts.push(request.method());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: {} });
  });
}

test("Studio shows a concise generation stage and never renders raw SSE logs", async ({ page }) => {
  const errors = [];
  const aborts = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    class QaEventSource extends EventTarget {
      constructor() {
        super();
        window.__qaStudioSource = this;
        setTimeout(() => this.dispatchEvent(new MessageEvent("progress", {
          data: JSON.stringify("[internal:trace=abc123] AI 데이터 분석 batch 4/9"),
        })), 30);
      }
      close() {}
    }
    window.EventSource = QaEventSource;
    window.__qaStudioProgress = (text) => window.__qaStudioSource?.dispatchEvent(new MessageEvent("progress", {
      data: JSON.stringify(text),
    }));
  });
  await mockStudioApis(page, aborts);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/studio.html`, { waitUntil: "networkidle" });
  await expect(page.locator("#app")).toBeVisible();
  await page.locator("#prompt").fill("첨부 문서를 정리해 줘");
  await page.locator("#sendBtn").click();

  const status = page.locator(".studio-generation-status");
  await expect(status).toBeVisible();
  await expect(status.locator(".studio-generation-status__head strong")).toHaveText("자료 분석");
  await expect(status.locator(".studio-generation-status__message")).toHaveText("AI가 첨부 자료를 분석하고 있습니다.");
  await expect(status.locator(".studio-generation-status__elapsed")).toHaveText(/^경과 \d+:\d{2}$/);
  await expect(page.locator("#msgs")).not.toContainText("internal:trace");
  await expect(page.locator("#msgs pre, #msgs [role=log]")).toHaveCount(0);

  await page.evaluate(() => window.__qaStudioProgress("[12:00:00] 📦 .cap 파일 파싱 중..."));
  await expect(status.locator(".studio-generation-status__head strong")).toHaveText("자료 분석");
  await page.evaluate(() => window.__qaStudioProgress("[12:00:01] ✓ 응답 완료 — JSON 파싱 중"));
  await expect(status.locator(".studio-generation-status__head strong")).toHaveText("자료 분석");
  await page.evaluate(() => window.__qaStudioProgress("[12:00:02] 📄 .docx 파일 빌드 중..."));
  await expect(status.locator(".studio-generation-status__head strong")).toHaveText("문서 생성");
  await expect(status.locator(".studio-generation-status__head strong")).not.toHaveText("파일 준비");

  await status.locator(".studio-generation-status__stop").click();
  await expect(status.locator(".studio-generation-status__message")).toHaveText("안전하게 작업을 중지하고 있습니다.");
  await expect.poll(() => aborts).toEqual(["POST"]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "/tmp/quilo-studio-generation-mobile.png", fullPage: false });
  expect(errors).toEqual([]);
});
