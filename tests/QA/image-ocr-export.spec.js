const path = require("path");
const { startQaServer } = require("./helpers/qa-server");

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
let qaServer = null;
let BASE_URL = "";

test.beforeAll(async () => {
  qaServer = await startQaServer();
  BASE_URL = qaServer.baseUrl;
});

test.afterAll(async () => { if (qaServer) await qaServer.stop(); });

test("highest-accuracy OCR renders spatial preview and downloads editable reconstructed documents", async ({ page }) => {
  const consoleErrors = [];
  const exportBodies = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/tools/images/ocr") {
      return route.fulfill({ json: {
        model: "mistral-ocr-latest",
        text: "# 스캔 제목\n\n본문 123",
        confidence: { average: 0.98, minimum: 0.91, lowConfidenceWords: 1 },
        quality: { agreement: 0.96, verifiedConfidence: 0.97, layoutConfidence: 0.94, reviewRequired: false, selectedVariant: "handwriting" },
        source: { passes: 4, attemptedPasses: 4, mode: "quality" },
        pages: [{ page: 1, markdown: "# 스캔 제목\n\n본문 123", dimensions: { width: 800, height: 1000 }, images: [{ id: "figure-1", topLeftX: 100, topLeftY: 500, bottomRightX: 400, bottomRightY: 750 }], blocks: [{ type: "table", tableId: "table-1", content: "" }], tables: [{ id: "table-1", format: "html", content: "<table><tr><td>본문 123</td></tr></table>" }] }],
      } });
    }
    if (pathname === "/api/tools/images/ocr/export") {
      exportBodies.push(request.postDataBuffer()?.toString("utf8") || "");
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "content-disposition": "attachment; filename=scan_OCR.docx",
          "x-quilo-source-image": "not-embedded",
          "x-quilo-reconstruction": "editable-elements",
          "x-quilo-detected-images": "1",
          "x-quilo-postflight": "passed",
          "x-quilo-layout-blocks": "3",
        },
        body: Buffer.from("PK\u0003\u0004mock-docx"),
      });
    }
    if (pathname === "/api/version") return route.fulfill({ json: { shortCommit: "qa", releaseVersion: "qa" } });
    if (pathname === "/api/me") return route.fulfill({ json: { user: "QA", isAdmin: false } });
    if (pathname === "/api/me/beta") return route.fulfill({ json: { tier: "pro", features: ["image-ocr"] } });
    return route.fulfill({ json: {} });
  });

  await page.goto(`${BASE_URL}/tools/image-ocr.html`, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle(/이미지 OCR/);
  await expect(page.locator("#ocrMode")).toHaveCount(0);
  await expect(page.locator(".ocr-quality-default")).toContainText("고품질 판독이 기본");
  await expect(page.locator(".ocr-quality-default")).toContainText("4중 교차 검증");
  await page.locator("#ocrFile").setInputFiles({
    name: "scan.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zy1sAAAAASUVORK5CYII=", "base64"),
  });
  await page.locator("#ocrRun").click();
  await expect(page.locator("#ocrResult")).toBeVisible();
  await expect(page.locator("#ocrResultMeta")).toContainText("4회 비교");
  await expect(page.locator("#ocrQuality")).toContainText("검증 신뢰도");
  await expect(page.locator("#ocrQuality")).toContainText("판독 일치도");
  await expect(page.locator("#ocrQuality")).toContainText("레이아웃 신뢰도");
  await expect(page.locator("#ocrQuality")).toContainText("96%");
  await expect(page.getByRole("button", { name: "Word (.docx)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "한글 (.hwpx)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "HTML 내보내기" })).toBeVisible();
  await expect(page.getByRole("button", { name: "TXT 내보내기" })).toBeVisible();
  await expect(page.locator("#ocrLayoutPreview")).toBeVisible();
  await expect(page.locator("#ocrLayoutBadge")).toContainText("요소");
  await expect(page.locator(".ocr-export-note")).toContainText("원본 전체 스캔을 넣지 않습니다");

  await page.locator("#ocrText").fill("사용자가 교정한 OCR 텍스트 456");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Word (.docx)" }).click();
  await download;
  await expect(page.locator("#ocrExportStatus")).toContainText("파일 내부 검증 통과");
  await expect(page.locator("#ocrExportStatus")).toContainText("편집 요소 3개 복원");
  await expect(page.locator("#ocrExportStatus")).toContainText("원본 전체 스캔 제외");
  expect(exportBodies).toHaveLength(1);
  expect(exportBodies[0]).toContain("docx");
  expect(exportBodies[0]).toContain("사용자가 교정한 OCR 텍스트 456");
  expect(exportBodies[0]).toContain("table-1");
  expect(exportBodies[0]).toContain("sourceText");
  expect(consoleErrors).toEqual([]);
});
