const fs = require("fs");
const http = require("http");
const path = require("path");

function loadPlaywrightTest() {
  try {
    return require("@playwright/test");
  } catch (error) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const cacheKey = Object.keys(require.cache).find((key) =>
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
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

let server;
let baseUrl;

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/me") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "qa-admin", user: "QA 관리자", isAdmin: true }));
      return;
    }
    if (url.pathname === "/api/subscriptions/me") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ active: true, subscription: { tier: "max" } }));
      return;
    }
    if (url.pathname === "/api/translate-pdf/estimate" && request.method === "POST") {
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ meta: { page_count: 12, text_chars: 18000, scanned: false, math_density: 2 } }));
      return;
    }
    if (url.pathname === "/api/translate-pdf" && request.method === "POST") {
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jobId: "qa-pdf-job" }));
      return;
    }
    if (url.pathname === "/api/jobs/qa-pdf-job/stream") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream; charset=utf-8",
      });
      response.end(
        `event: progress\ndata: ${JSON.stringify("문서를 분석했습니다.")}\n\n` +
        `event: done\ndata: ${JSON.stringify({ filename: "research-paper_KO.pdf", files: [] })}\n\n`,
      );
      return;
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405).end("Read-only QA");
      return;
    }
    const relative = url.pathname === "/" ? "translate.html" : url.pathname.replace(/^\/+/, "");
    const file = path.resolve(PUBLIC_DIR, relative);
    if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
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
        "Content-Type": CONTENT_TYPES[path.extname(file)] || "application/octet-stream",
      });
      response.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("PDF translator uses a dedicated three-region workflow without legacy app-shell overlays", () => {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, "translate.html"), "utf8");
  const markup = source.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  expect(markup).toContain('class="pdf-workspace"');
  expect(markup).toContain('class="pdf-files"');
  expect(markup).toContain('class="pdf-options"');
  expect(markup).toContain('class="pdf-summary"');
  expect(markup).toContain('/ui/pdf-translate.css');
  expect(markup).not.toContain('/ui/app-shell.css');
  expect(markup).not.toMatch(/<style\b|\sstyle\s*=/i);
  expect(source).not.toMatch(/style\.cssText/);
});

test("file selection updates queue, summary, controls, and stays within the desktop viewport", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${baseUrl}/translate.html`, { waitUntil: "networkidle" });

  await expect(page.locator("#tool")).toBeVisible();
  await expect(page.locator(".pdf-files")).toBeVisible();
  await expect(page.locator(".pdf-options")).toBeVisible();
  await expect(page.locator(".pdf-summary")).toBeVisible();

  await page.locator("#trPdf").setInputFiles({
    name: "research-paper.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% QA fixture"),
  });
  await expect(page.locator("#trFileCount")).toHaveText("1/10");
  await expect(page.locator("#trFileList")).toContainText("research-paper.pdf");
  await expect(page.locator("#trSummaryFiles")).toHaveText("1개 PDF");
  await expect(page.locator("#trBtn")).toBeEnabled();

  await page.locator("#trMode").selectOption("retypeset");
  await expect(page.locator("#trSummaryMode")).toHaveText("재조판");
  await page.locator(".pdf-advanced summary").click();
  await page.locator("#trRestoreOnly").check();
  await expect(page.locator("#trSummaryRestore")).toHaveText("사용");

  const geometry = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    files: document.querySelector(".pdf-files").getBoundingClientRect().width,
    summary: document.querySelector(".pdf-summary").getBoundingClientRect().width,
  }));
  expect(geometry.overflow).toBeLessThanOrEqual(0);
  expect(geometry.files).toBeGreaterThanOrEqual(300);
  expect(geometry.summary).toBeGreaterThanOrEqual(300);
  await page.screenshot({ path: "/tmp/quilo-pdf-translate-workspace.png", fullPage: false });
  expect(errors).toEqual([]);
});

test("logged-out users see the canonical login route without changing session state", async ({ page }) => {
  await page.route("**/api/me", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "login required" }) }),
  );
  await page.goto(`${baseUrl}/translate.html`, { waitUntil: "networkidle" });
  await expect(page.locator("#tool")).toBeHidden();
  await expect(page.locator('#gate a[href="/login.html?next=/translate.html"]')).toHaveText("로그인");
});

test("the rewritten workspace keeps the upload-to-result controller contract", async ({ page }) => {
  await page.goto(`${baseUrl}/translate.html`, { waitUntil: "networkidle" });
  await page.locator("#trPdf").setInputFiles({
    name: "research-paper.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% QA fixture"),
  });
  await expect(page.locator("#trBtn")).toBeEnabled();
  await page.locator("#trBtn").click();
  await expect(page.locator("#statusTitle")).toHaveText("완료");
  await expect(page.locator("#progress")).toBeHidden();
  await expect(page.locator("#progressLatest")).toHaveText("번역이 완료되었습니다. 아래에서 파일을 받을 수 있습니다.");
  await expect(page.locator("#progressStage")).toHaveText("완료");
  await expect(page.locator("#progressElapsed")).toHaveText(/^경과 \d+:\d{2}$/);
  const visibleProgressText = await page.locator("#progressArea").evaluate((node) => node.innerText);
  expect(visibleProgressText).not.toContain("문서를 분석했습니다.");
  const download = page.locator('#resultArea a[href="/api/jobs/qa-pdf-job/download"]');
  await expect(download).toHaveText("research-paper_KO.pdf 다운로드");
  await expect(page.locator("#trBtn")).toHaveText("번역 시작");
});

test("translation progress does not report completion while pages or the PDF are still being built", async ({ page }) => {
  await page.addInitScript(() => {
    class QaEventSource extends EventTarget {
      constructor() {
        super();
        window.__qaTranslateSource = this;
      }
      close() {}
    }
    window.EventSource = QaEventSource;
    window.__qaTranslateEvent = (type, data) => window.__qaTranslateSource?.dispatchEvent(new MessageEvent(type, {
      data: JSON.stringify(data),
    }));
  });
  await page.goto(`${baseUrl}/translate.html`, { waitUntil: "networkidle" });
  await page.locator("#trPdf").setInputFiles({
    name: "research-paper.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% QA fixture"),
  });
  await page.locator("#trBtn").click();
  await expect(page.locator("#progressStage")).toHaveText("준비");
  await expect.poll(() => page.evaluate(() => Boolean(window.__qaTranslateSource))).toBe(true);

  await page.evaluate(() => window.__qaTranslateEvent("progress", "PDF 3/10 페이지 번역 중..."));
  await expect(page.locator("#progressStage")).toHaveText("본문 번역");
  await page.evaluate(() => window.__qaTranslateEvent("progress", "번역 응답 완료 — 후처리 중"));
  await expect(page.locator("#progressStage")).toHaveText("본문 번역");
  await page.evaluate(() => window.__qaTranslateEvent("progress", "PDF 파일 생성 중..."));
  await expect(page.locator("#progressStage")).toHaveText("파일 생성");
  await expect(page.locator("#progressStage")).not.toHaveText("파일 준비");
});
