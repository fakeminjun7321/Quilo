const fs = require("fs");
const http = require("http");
const path = require("path");

function loadPlaywrightTest() {
  try {
    return require("@playwright/test");
  } catch (error) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const cacheKey = Object.keys(require.cache).find(
      (key) => key.includes(`${marker}@playwright${path.sep}test${path.sep}`) || key.includes(`${marker}playwright${path.sep}`),
    );
    if (!cacheKey) throw error;
    const root = cacheKey.slice(0, cacheKey.indexOf(marker) + marker.length);
    return require(path.join(root, "@playwright", "test"));
  }
}

const { test, expect } = loadPlaywrightTest();
const PUBLIC_DIR = path.join(process.cwd(), "public");
let server;
let baseUrl;

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function resolvePublicFile(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return null;
  return filePath;
}

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const filePath = resolvePublicFile(request.url || "/");
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function mockApis(page, { authenticated = false, posts = [], captures = [], feedbackFailure = false } = {}) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== "GET") captures.push({ pathname, method, body: request.postDataJSON?.() || null });

    if (pathname === "/api/me") {
      return authenticated
        ? route.fulfill({ json: { user: "구민준", email: "student@school.ac.kr", isAdmin: false } })
        : route.fulfill({ status: 401, json: { error: "not logged in" } });
    }
    if (pathname === "/api/community/posts" && method === "GET") {
      return route.fulfill({ json: { storage: true, posts, me: authenticated ? { id: "user-1", isAdmin: false } : null } });
    }
    if (pathname === "/api/community/posts" && method === "POST") {
      const body = request.postDataJSON();
      return route.fulfill({ json: { ok: true, post: { id: "new-post", user_id: "user-1", author_name: "구민준", created_at: "2026-07-14T02:00:00.000Z", upvotes: 0, ...body } } });
    }
    if (pathname === "/api/feedback" && method === "POST") {
      return feedbackFailure
        ? route.fulfill({ status: 503, json: { ok: false, error: "현재 문의 저장 채널에 연결할 수 없습니다." } })
        : route.fulfill({ json: { ok: true, emailSent: false, stored: true } });
    }
    if (pathname.endsWith("/comments") && method === "GET") return route.fulfill({ json: { comments: [], me: authenticated ? { id: "user-1", isAdmin: false } : null } });
    if (pathname === "/api/version") return route.fulfill({ json: { releaseVersion: "1.0.24", shortCommit: "qa" } });
    if (pathname === "/api/catalog") return route.fulfill({ json: { features: [] } });
    return route.fulfill({ json: {} });
  });
}

test("anonymous support page shows email help, login guidance, and searchable FAQ", async ({ page }) => {
  await mockApis(page);
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto(`${baseUrl}/support.html`, { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "무엇을 도와드릴까요?" })).toBeVisible();
  await expect(page.getByRole("link", { name: /fakeminjun7321@quilolab.com/ })).toHaveAttribute("href", "mailto:fakeminjun7321@quilolab.com");
  await expect(page.locator("#supportAuthNotice")).toBeVisible();
  await expect(page.locator("#supportForm")).toBeHidden();
  await expect(page.locator("#supportLoginLink")).toHaveAttribute("href", "/login.html?next=%2Fsupport.html");
  if (process.env.SUPPORT_QA_SCREEN) await page.screenshot({ path: process.env.SUPPORT_QA_SCREEN, fullPage: false });

  await page.locator("#faqSearch").fill("Dropbox");
  await expect(page.locator(".support-faq-item:visible")).toHaveCount(1);
  await expect(page.locator(".support-faq-item:visible")).toContainText("24시간");

  await page.locator("#faqSearch").fill("");
  await page.getByRole("button", { name: "학교 도입", exact: true }).click();
  await expect(page.locator(".support-faq-item:visible")).toHaveCount(1);
  await expect(page.locator(".support-faq-item:visible")).toContainText("학교 또는 기관");
});

test("logged-in support inquiry uses the existing feedback contract without external delivery", async ({ page }) => {
  const captures = [];
  await mockApis(page, { authenticated: true, captures });
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto(`${baseUrl}/support.html`, { waitUntil: "domcontentloaded" });

  await expect(page.locator("#supportForm")).toBeVisible();
  await expect(page.locator("#supportContactEmail")).toHaveValue("student@school.ac.kr");
  await expect(page.locator("#supportCategory option")).toHaveText([
    "선택해 주세요", "버그", "기능 제안", "계정", "결제", "보고서 품질", "데이터", "문서형식", "학교도입", "기타",
  ]);
  if (process.env.SUPPORT_AUTH_QA_SCREEN) await page.screenshot({ path: process.env.SUPPORT_AUTH_QA_SCREEN, fullPage: false });

  await page.locator("#supportCategory").selectOption("billing");
  await page.locator("#supportInquiryTitle").fill("결제 내역 확인 요청");
  await page.locator("#supportMessage").fill("Account Center의 결제 내역을 확인하고 싶습니다.");
  await page.locator("#supportSubmit").click();
  await expect(page.locator("#supportFormStatus")).toHaveText("문의가 접수되었습니다.");

  const submission = captures.find((call) => call.pathname === "/api/feedback");
  expect(submission.body.category).toBe("billing");
  expect(submission.body.title).toBe("결제 내역 확인 요청");
  expect(submission.body.contactEmail).toBe("student@school.ac.kr");
  expect(submission.body.pageUrl).toContain("/support.html");
});

test("support never reports success when every delivery channel is unavailable", async ({ page }) => {
  await mockApis(page, { authenticated: true, feedbackFailure: true });
  await page.goto(`${baseUrl}/support.html`, { waitUntil: "domcontentloaded" });
  await page.locator("#supportCategory").selectOption("bug");
  await page.locator("#supportInquiryTitle").fill("문의 저장 실패 확인");
  await page.locator("#supportMessage").fill("문의 저장 채널이 없을 때 성공으로 보이면 안 됩니다.");
  await page.locator("#supportSubmit").click();
  await expect(page.locator("#supportFormStatus")).toContainText("연결할 수 없습니다");
  await expect(page.locator("#supportFormStatus")).toHaveClass(/is-error/);
});

test("legacy feature and suggestion posts are preserved in the support archive", async ({ page }) => {
  const posts = [
    { id: "feature-old", category: "feature", title: "다크 모드 기능 요청", body: "기존 공개 기능 요청입니다.", created_at: "2026-05-10T02:00:00.000Z" },
    { id: "suggestion-old", category: "suggestion", title: "자료실 개선 건의", body: "기존 공개 건의사항입니다.", created_at: "2026-05-11T02:00:00.000Z" },
  ];
  await mockApis(page, { posts });
  await page.goto(`${baseUrl}/support.html`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#supportLegacyRequests")).toContainText("다크 모드 기능 요청");
  await expect(page.locator("#supportLegacyRequests")).toContainText("자료실 개선 건의");
  await expect(page.locator(".support-archive__item")).toHaveCount(2);
});

test("community is a general board while legacy request posts live in support", async ({ page }) => {
  const posts = [
    { id: "legacy-1", user_id: "old-user", author_name: "이상훈", category: "feature", title: "다크 모드 지원 요청드립니다.", body: "이전에 접수된 기능 요청 본문입니다.", upvotes: 17, comment_count: 8, created_at: "2026-05-10T02:00:00.000Z" },
    { id: "tip-1", user_id: "user-2", author_name: "이준호", category: "tip", title: "스타일 가이드 설정으로 문서 일관성 높이는 방법", body: "Account Center의 스타일 노트를 활용한 경험을 공유합니다.", upvotes: 28, comment_count: 2, created_at: "2026-07-13T02:00:00.000Z" },
  ];
  await mockApis(page, { authenticated: true, posts });
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto(`${baseUrl}/community.html`, { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "커뮤니티" })).toBeVisible();
  await expect(page.locator("[data-community-category]")).toHaveText(["전체", "자유", "질문", "사용팁", "작업공유"]);
  await expect(page.locator("#communityNewCategory option")).toHaveText(["분류를 선택하세요", "자유", "질문", "사용팁", "작업공유"]);
  await expect(page.getByText("랩 (기술 공개)", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /개발 노트 보기/ })).toHaveAttribute("href", "/developer-notes.html");
  await expect(page.getByText("이전 기능 요청", { exact: true })).toHaveCount(0);
  await expect(page.getByText("다크 모드 지원 요청드립니다.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("스타일 가이드 설정으로 문서 일관성 높이는 방법", { exact: true })).toBeVisible();

  await page.locator("#communityComposeToggle").click();
  if (process.env.COMMUNITY_QA_SCREEN) await page.screenshot({ path: process.env.COMMUNITY_QA_SCREEN, fullPage: false });

  await page.locator("#communitySearch").fill("스타일 노트");
  await expect(page.locator(".community-post")).toHaveCount(1);
  await expect(page.locator(".community-post")).toContainText("스타일 가이드");
});

test("community creates only a current general-board category", async ({ page }) => {
  const captures = [];
  await mockApis(page, { authenticated: true, captures });
  await page.goto(`${baseUrl}/community.html`, { waitUntil: "domcontentloaded" });

  await page.locator("#communityComposeToggle").click();
  await expect(page.locator("#communityWritePanel")).toBeVisible();
  await page.locator("#communityNewCategory").selectOption("question");
  await page.locator("#communityNewTitle").fill("HWPX 출력 형식 질문");
  await page.locator("#communityNewBody").fill("물리 결과보고서에서 HWPX를 선택할 때 확인할 점이 궁금합니다.");
  await page.locator("#communityPostSubmit").click();
  await expect(page.getByText("HWPX 출력 형식 질문", { exact: true })).toBeVisible();

  const submission = captures.find((call) => call.pathname === "/api/community/posts" && call.method === "POST");
  expect(submission.body.category).toBe("question");
  expect(["feature", "suggestion"]).not.toContain(submission.body.category);
});

test("support and community keep the shared shell and mobile width", async ({ page }) => {
  await mockApis(page);
  for (const pathName of ["/support.html", "/community.html"]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}${pathName}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-ui-shell-mounted='true']")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/support.html`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-ui-menu-trigger="5"]').click();
  await expect(page.locator('#uiSiteMega a[href="/support.html"] strong')).toHaveText("고객센터");
  await expect(page.locator('.ui-site-footer a[href="/community.html"]')).toHaveText("커뮤니티");
});
