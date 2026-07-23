const path = require("path");
const http = require("http");
const express = require("express");

function loadPlaywrightTest() {
  try { return require("@playwright/test"); }
  catch (error) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const cacheKey = Object.keys(require.cache).find((key) => key.includes(`${marker}@playwright${path.sep}test${path.sep}`) || key.includes(`${marker}playwright${path.sep}`));
    if (!cacheKey) throw error;
    const root = cacheKey.slice(0, cacheKey.indexOf(marker) + marker.length);
    return require(path.join(root, "@playwright", "test"));
  }
}

const { test, expect } = loadPlaywrightTest();
let baseUrl = "";
let server = null;

test.beforeAll(async () => {
  const app = express();
  app.use(express.static(path.join(process.cwd(), "public")));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("uploads a PDF and renders the structural analysis result", async ({ page }) => {
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/me") return route.fulfill({ json: { user: "QA" } });
    if (pathname === "/api/tools/pdf/analyze") {
      return route.fulfill({ json: {
        filename: "physics.pdf",
        analysis: {
          page_count: 12,
          text_chars: 18420,
          scanned: false,
          scan_page_count: 0,
          scan_pages: [],
          garbled: false,
          garbled_ratio: 0,
          math_garbled: false,
          math_garbled_ratio: 0,
          math_score: 146,
          math_density: 7.93,
          two_column: true,
          ocr_layer: false,
          photo_page_ratio: 0,
          invisible_text_ratio: 0,
        },
      } });
    }
    if (pathname === "/api/version") return route.fulfill({ json: { shortCommit: "qa", releaseVersion: "qa" } });
    return route.fulfill({ json: {} });
  });

  await page.goto(`${baseUrl}/tools/pdf-analysis.html`, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle(/PDF 분석/);
  await page.locator("#pdfAnalysisFile").setInputFiles({
    name: "physics.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%%EOF"),
  });
  await expect(page.locator("#pdfAnalysisRun")).toBeEnabled();
  await page.locator("#pdfAnalysisRun").click();
  await expect(page.locator("#pdfAnalysisResult")).toBeVisible();
  await expect(page.locator("#pdfAnalysisResultBadge")).toHaveText("텍스트 PDF");
  await expect(page.locator("#pdfMetricPages")).toHaveText("12쪽");
  await expect(page.locator("#pdfCheckLayout")).toContainText("2단 본문 감지");
  await expect(page.locator("#pdfAnalysisRecommendations")).toContainText("읽기 순서");
  expect(consoleErrors).toEqual([]);
});
