const fs = require("fs");
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
const RETIRED = ["eng-exam-prep", "korean-lit-exam", "phys-inquiry", "math-inquiry", "phys-mock-exam"];
const RETIRED_LABELS = ["영어 시험대비", "국어 문학 시험", "물리 수행평가", "수학 수행평가", "물리 모의고사"];
let qaServer;
let BASE_URL;

async function mockApis(page) {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/me") return route.fulfill({ json: { user: "관리자", studentId: "2402", isAdmin: true, reportEligible: true, blockedReportTypes: [], analyticsConsent: false, analyticsConsentVersion: "2026-07-15" } });
    if (pathname === "/api/me/beta") return route.fulfill({ json: { admin: true, tier: "admin", features: [...RETIRED, "reading-log"] } });
    if (pathname === "/api/subscriptions/me") return route.fulfill({ json: { active: true, admin: true } });
    if (pathname === "/api/me/balance") return route.fulfill({ json: { credits: 24, unlimited: true, isAdmin: true } });
    if (pathname === "/api/me/files") return route.fulfill({ json: { storage: true, files: [] } });
    if (pathname === "/api/me/jobs") return route.fulfill({ json: { jobs: [
      { id: "active-job", reportType: "chem-pre", status: "running", createdAt: "2026-07-22T10:00:00Z" },
      { id: "retired-running", reportType: "phys-inquiry", status: "running", createdAt: "2026-07-22T10:01:00Z" },
      { id: "retired-error", reportType: "eng-exam-prep", status: "error", error: "중단됨", createdAt: "2026-07-22T10:02:00Z" },
    ] } });
    if (pathname === "/api/catalog") return route.fulfill({ json: {
      categories: { study: { title: "학습", description: "학습 기능" } },
      features: [
        { id: "reading-log", title: "독서록", summary: "독서활동 기록", category: "study", audience: "member", status: "active", execution: "handoff", path: "/?report=reading-log" },
        ...RETIRED.map((id) => ({ id, title: `미출시 ${id}`, summary: "준비 중", category: "study", audience: "pro", status: "paused", execution: "paused", path: `/?report=${id}` })),
      ],
    } });
    if (pathname === "/api/announcements") return route.fulfill({ json: { announcements: [] } });
    return route.fulfill({ json: {} });
  });
}

test.beforeAll(async () => {
  qaServer = await startQaServer({ env: { NODE_ENV: "test" } });
  BASE_URL = qaServer.baseUrl;
});

test.afterAll(async () => { if (qaServer) await qaServer.stop(); });

test("retired report names and form ids are absent from the public index source", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");
  const retiredIds = [
    ...RETIRED,
    "rtPhysInquiry", "rtMathInquiry", "rtEngExam", "rtKoreanLit", "rtPhysMock",
    "physInquiryForm", "mathInquiryForm", "engExamForm", "koreanLitForm", "physMockForm",
  ];
  for (const value of [...retiredIds, ...RETIRED_LABELS]) expect(source).not.toContain(value);
  expect(source).not.toContain("data-retired-report-template");
});

test("retired report queries cannot select or reveal their forms even for admins", async ({ page }) => {
  await mockApis(page);
  for (const type of RETIRED) {
    await page.goto(`${BASE_URL}/?report=${type}`, { waitUntil: "networkidle" });
    const radio = page.locator(`input[name="reportType"][value="${type}"]`);
    await expect(radio).toHaveCount(0);
    await expect(page.locator(`[data-report-form="${type}"]`)).toHaveCount(0);
  }
  const bodyText = await page.locator("body").evaluate((body) => body.textContent || "");
  for (const label of RETIRED_LABELS) expect(bodyText).not.toContain(label);
});

test("global search and developer catalog filter retired features returned by the API", async ({ page }) => {
  await mockApis(page);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  const search = page.locator("#uiFeatureSearch");
  for (const query of ["미출시", "물리 수행평가", "영어 시험대비"]) {
    await search.fill(query);
    for (const type of RETIRED) {
      await expect(page.locator(`#uiFeatureSearchResults [data-report="${type}"]`)).toHaveCount(0);
      await expect(page.locator(`#uiFeatureSearchResults a[href*="report=${type}"]`)).toHaveCount(0);
    }
  }
  await search.fill("독서록");
  await expect(page.locator('#uiFeatureSearchResults [data-search-index][data-report="reading-log"]')).toBeVisible();

  await page.goto(`${BASE_URL}/developers.html#catalog`, { waitUntil: "networkidle" });
  await page.locator("#catalogAccess").selectOption("all");
  await page.locator("#catalogSearch").fill("미출시");
  await expect(page.locator("#catalogBody")).toContainText("조건에 맞는 기능이 없습니다.");
  for (const type of RETIRED) await expect(page.locator(`#catalogBody >> text=${type}`)).toHaveCount(0);
});

test("background jobs hide historical jobs from retired report types", async ({ page }) => {
  await mockApis(page);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const { createBackgroundJobsController } = await import("/workspace/background-jobs.js");
    await createBackgroundJobsController({}).render();
  });
  await expect(page.locator("#bgJobsBlock")).toContainText("화학 사전보고서");
  await expect(page.locator("#bgJobsBlock .background-job")).toHaveCount(1);
  const text = await page.locator("#bgJobsBlock").innerText();
  for (const label of RETIRED_LABELS) expect(text).not.toContain(label);
  for (const type of RETIRED) expect(text).not.toContain(type);
});

test("retired study pages keep only released study entry points visible", async ({ page }) => {
  await mockApis(page);
  await page.goto(`${BASE_URL}/exam-prep.html#phys`, { waitUntil: "networkidle" });
  await expect(page).toHaveTitle("독서활동 기록지 — Quilo");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /독서활동 기록지/);
  await expect(page.locator("#tabPhys, #tabMath, #panePhys, #paneMath")).toHaveCount(0);
  await expect(page.locator("#paneReading")).toBeVisible();
  const examBody = await page.locator("body").evaluate((body) => body.textContent || "");
  for (const label of RETIRED_LABELS) expect(examBody).not.toContain(label);
  for (const type of RETIRED) expect(examBody).not.toContain(type);

  await page.goto(`${BASE_URL}/guide.html`, { waitUntil: "networkidle" });
  await expect(page.locator("#exam-prep")).toContainText("독서활동 기록지");
  await expect(page.locator("#exam-prep")).not.toContainText("물리 수행평가");
  await expect(page.locator("#exam-prep")).not.toContainText("수학 수행평가");
});
