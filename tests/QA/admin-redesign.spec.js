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
const screenshotPath = "/tmp/quilo-admin-operations.png";
const REQUIRED_IDS = ["aaChips","aaInput","aaModel","aaModelHint","aaMsgs","aaSend","addForm","addStatus","adminAiSection","adminAnnSection","adminAppealsSection","adminEditorSection","adminPageTitle","adminTabs","adminUserFilter","adminUserFilterReset","adminUserInspector","adminUserSort","adminUserStatusFilter","adminUsersSection","annAddBtn","annAdminList","annCat","annLink","annStatus","annTitle","appealsList","appealsRefresh","betaAddForm","betaAddStatus","betaKey","betaLabel","betaList","betaSection","betaStatus","bgSubsSection","caActions","caGo","caHint","caModel","caPrompt","caResult","caText","caUseCode","ceAi","ceArea","ceFrame","ceLang","ceOut","grantAddForm","grantAddStatus","grantDays","grantHours","grantList","grantName","grantNote","grantStatus","grantsSection","ide","ideFileInput","ideFiles","ideMiniCode","ideMiniView","ideMinimap","ideNewFile","ideOpenFile","ideOpenFolder","idePanel","idePanelClose","ideSide","ideTabs","isAdmin","listStatus","logStatus","logTable","logTbody","logout","name","openAudience","openFeatureSection","openForm","openHours","openKey","openList","openSetStatus","openStatus","password","proAddForm","proAddStatus","proList","proName","proStatus","proTierSection","problemsetSection","psLimitForm","psLimitInput","psLimitStatus","rateInfo","refresh","refreshBeta","refreshGrants","refreshLogs","refreshOpen","refreshProMembers","refreshPsLimit","refreshSchoolApps","refreshSubReqs","refreshSubs","schoolAppFilter","schoolAppsList","schoolAppsSection","stDownload","stMinimap","stMsg","stPos","stRun","stSave","stTheme","subAddForm","subAddStatus","subDays","subHours","subList","subName","subNote","subPermanent","subReqList","subStatus","themeToggle","userCreateButton","userCreatePanel","userInspectorActions","userInspectorClose","userMetricAdmin","userMetricLocked","userMetricPending","userMetricTotal","userMetricUnverified","userRefreshMeta","userTable","userTbody"];
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

function fixture(pathname) {
  if (pathname === "/api/me") return { isAdmin: true, name: "관리자" };
  if (pathname === "/api/admin/users") {
    return {
      users: [
        {
          id: "qa-user",
          name: "QA 사용자",
          username: "qa-user",
          is_admin: false,
          approved: true,
          email_verified: true,
          email: "qa@ts.hs.kr",
          credits: 8,
          spent_usd: 0,
          recent_gen_count: 0,
          recent_gen_limit: 5,
          created_at: "2026-07-01T00:00:00Z",
          restricted_model: "",
          blocked_report_types: [],
        },
        {
          id: "pending-user",
          name: "승인 대기 사용자",
          username: "pending-user",
          student_id: "2501",
          is_admin: false,
          approved: false,
          email_verified: false,
          email: "pending@ts.hs.kr",
          credits: 0,
          spent_usd: 1.25,
          recent_gen_count: 0,
          recent_gen_limit: 5,
          created_at: "2026-07-02T00:00:00Z",
          restricted_model: "gpt-5.4-mini",
          blocked_report_types: ["phys-result"],
        },
        {
          id: "locked-user",
          name: "사용 잠김 사용자",
          username: "locked-user",
          student_id: "2502",
          is_admin: false,
          approved: true,
          email_verified: true,
          email: "locked@ts.hs.kr",
          credits: 2,
          spent_usd: 4.5,
          recent_gen_count: 5,
          recent_gen_limit: 5,
          created_at: "2026-07-03T00:00:00Z",
          restricted_model: "",
          blocked_report_types: [],
        },
        {
          id: "admin-user",
          name: "운영 관리자",
          username: "admin-user",
          is_admin: true,
          approved: true,
          email_verified: true,
          email: "admin@quilo.test",
          credits: 1000,
          unlimited: true,
          spent_usd: 10,
          recent_gen_count: 0,
          recent_gen_limit: 5,
          created_at: "2026-07-04T00:00:00Z",
          restricted_model: "",
          blocked_report_types: [],
        },
      ],
      krwPerUsd: 1400,
    };
  }
  if (pathname === "/api/admin/usage-logs") return { logs: [] };
  if (pathname === "/api/admin/problemset-limit") return { limit: 120 };
  if (pathname === "/api/admin/chat/models" || pathname === "/api/admin/code-assist/models") {
    return { models: [{ id: "default", label: "기본 모델" }] };
  }
  if (pathname === "/api/admin/beta") return { features: [] };
  if (pathname === "/api/admin/beta/pro/testers") return { testers: [] };
  if (pathname === "/api/announcements/all" || pathname === "/api/announcements") {
    return {
      announcements: [
        { id: "ann-1", category: "공지", title: "Quilo 전용 도메인 안내", active: true, link: "/guide.html" },
        { id: "ann-2", category: "점검", title: "시스템 점검 안내", active: false, link: "" },
      ],
    };
  }
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
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end("Read-only QA");
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(fixture(url.pathname)));
      return;
    }
    const relative = url.pathname === "/" ? "admin.html" : url.pathname.replace(/^\/+/, "");
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
        "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream",
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

test("admin console keeps all operational groups reachable without write requests", async ({ page }) => {
  const writes = [];
  page.on("request", (request) => {
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${request.url()}`);
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/admin.html`, { waitUntil: "networkidle" });

  const localStylesheets = await page.locator('link[rel="stylesheet"]').evaluateAll((links) =>
    links
      .map((link) => new URL(link.href))
      .filter((url) => url.origin === window.location.origin)
      .map((url) => url.pathname),
  );
  expect(localStylesheets).toEqual([
    "/ui/foundation.css",
    "/ui/admin.css",
  ]);
  expect(localStylesheets).not.toEqual(
    expect.arrayContaining(["/style.css", "/admin-redesign.css", "/site-shell.css"]),
  );

  const missingIds = await page.evaluate(
    (ids) => ids.filter((id) => document.getElementById(id) === null),
    REQUIRED_IDS,
  );
  expect(missingIds).toEqual([]);

  await expect(page.locator(".operations-brand__copy strong")).toHaveText("Quilo");
  await expect(page.locator("#themeToggle")).toHaveAttribute("aria-label", /모드로 전환/);
  await expect(page.locator("#themeToggle .operations-theme__icon")).toHaveCount(2);
  await expect(page.locator("#adminTabs .atab.on")).toHaveAttribute("data-go", "ai");
  await expect(page.locator("#adminAiSection")).toBeVisible();
  await expect(page.locator("[data-admin-editor-asset]")).toHaveCount(0);

  for (const group of ["users", "subs", "grants", "beta", "schools", "logs", "announce", "appeals", "editor"]) {
    await page.locator(`#adminTabs .atab[data-go="${group}"]`).click();
    await expect(page.locator(`section.settings-card[data-atab="${group}"]`).first()).toBeVisible();
  }
  await expect(page.locator('link[data-admin-editor-asset]')).toHaveCount(6);
  expect(await page.locator('script[data-admin-editor-asset]').count()).toBeGreaterThan(0);

  await page.locator('#adminTabs .atab[data-go="ai"]').click();
  await expect(page.locator("#adminPageTitle")).toHaveText("운영 개요");
  await expect(page.locator("#adminTabs .atab.on")).toHaveCount(1);
  await expect(page.locator('#adminTabs .atab[data-go="ai"]')).toHaveCSS(
    "background-color",
    "rgb(23, 41, 70)",
  );
  await expect(page.locator('#adminTabs .atab[data-go="editor"]')).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );

  const unexpectedRuntimeStyles = await page.locator("[style]").evaluateAll((elements) =>
    elements.flatMap((element) => {
      if (element.closest(".CodeMirror")) return [];
      const properties = [...element.style].filter(
        (property) => !["--minimap-scale", "--minimap-top", "--minimap-height"].includes(property),
      );
      return properties.length
        ? [{ tag: element.tagName, id: element.id, properties }]
        : [];
    }),
  );
  expect(unexpectedRuntimeStyles).toEqual([]);

  await page.screenshot({ path: screenshotPath, fullPage: true });
  expect(writes).toEqual([]);
});

test("users and announcements use dense list and inspector workflows", async ({ page }) => {
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/admin.html`, { waitUntil: "networkidle" });

  await page.locator('#adminTabs .atab[data-go="users"]').click();
  const userList = page.locator('section[data-atab="users"]:has(#userTable)');
  const userInspector = page.locator('section[data-atab="users"]:has(#addForm)');
  await expect(userList).toBeVisible();
  await expect(userInspector).toBeVisible();
  await expect(page.locator("#userMetricTotal")).toHaveText("4");
  await expect(page.locator("#userMetricPending")).toHaveText("1");
  await expect(page.locator("#userMetricUnverified")).toHaveText("1");
  await expect(page.locator("#userMetricLocked")).toHaveText("1");
  await expect(page.locator("#userMetricAdmin")).toHaveText("1");
  await page.locator("#adminUserFilter").fill("qa-user");
  await expect(page.locator('#userTbody tr[data-user-id="qa-user"]')).toBeVisible();
  await expect(page.locator('#userTbody tr[data-user-id]')).toHaveCount(1);
  await page.locator('#userTbody tr[data-user-id="qa-user"] td').first().click();
  await expect(page.locator("#userInspectorDetails")).toContainText("QA 사용자");
  await expect(page.locator('#userTbody tr[data-user-id="qa-user"]')).toHaveAttribute("aria-selected", "true");
  await page.locator("#adminUserFilter").fill("");
  await page.locator('[data-user-preset="pending"]').click();
  await expect(page.locator('#userTbody tr[data-user-id="pending-user"]')).toBeVisible();
  await expect(page.locator('#userTbody tr[data-user-id]')).toHaveCount(1);
  await page.locator("#adminUserFilterReset").click();
  await expect(page.locator('#userTbody tr[data-user-id]')).toHaveCount(4);
  await page.locator('#userTbody tr[data-user-id="qa-user"]').focus();
  await page.locator('#userTbody tr[data-user-id="qa-user"]').press("Enter");
  await expect(page.locator("#userInspectorDetails")).toContainText("qa-user");
  await expect(page.locator("#userInspectorActions")).toBeVisible();
  await expect(page.locator("#userCreatePanel")).not.toHaveAttribute("open", "");
  await page.locator("#userCreateButton").click();
  await expect(page.locator("#userCreatePanel")).toHaveAttribute("open", "");
  await expect(page.locator("#name")).toBeFocused();
  await page.locator("#userCreatePanel > summary").click();
  await expect(page.locator("#userCreatePanel")).not.toHaveAttribute("open", "");
  const userListBox = await userList.boundingBox();
  const userInspectorBox = await userInspector.boundingBox();
  expect(userListBox.x + userListBox.width).toBeLessThanOrEqual(userInspectorBox.x + 1);
  await page.screenshot({ path: "/tmp/quilo-admin-users-console.png", fullPage: false });

  await page.locator('#adminTabs .atab[data-go="announce"]').click();
  await expect(page.locator("#adminAnnSection .announcement-inspector")).toBeVisible();
  await expect(page.locator("#annAdminList .announcement-item")).toHaveCount(2);
  await page.locator("#annTitle").fill("새 운영 공지");
  await page.locator("#annCat").fill("업데이트");
  await expect(page.locator("#annPreviewTitle")).toHaveText("새 운영 공지");
  await expect(page.locator("#annPreviewCategory")).toHaveText("업데이트");
  const announcementListBox = await page.locator("#annAdminList").boundingBox();
  const announcementInspectorBox = await page.locator("#adminAnnSection .announcement-inspector").boundingBox();
  expect(announcementListBox.x + announcementListBox.width).toBeLessThanOrEqual(announcementInspectorBox.x + 1);
  await page.screenshot({ path: "/tmp/quilo-admin-announcements-console.png", fullPage: false });
  expect(consoleErrors).toEqual([]);
});

test("user console remains readable at the reported 1206px desktop width", async ({ page }) => {
  await page.setViewportSize({ width: 1206, height: 850 });
  await page.goto(`${baseUrl}/admin.html`, { waitUntil: "networkidle" });
  await page.locator('#adminTabs .atab[data-go="users"]').click();

  await expect(page.locator("#adminUsersSection")).toBeVisible();
  await expect(page.locator("#adminUserInspector")).toBeVisible();
  await expect(page.locator("#userCreateButton")).toBeVisible();
  await expect(page.locator("#userTable thead")).toBeVisible();
  const geometry = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
    toolbarRight: document.querySelector(".user-console-toolbar").getBoundingClientRect().right,
    listRight: document.getElementById("adminUsersSection").getBoundingClientRect().right,
  }));
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.toolbarRight).toBeLessThanOrEqual(geometry.listRight + 1);
  await page.screenshot({ path: "/tmp/quilo-admin-users-1206.png", fullPage: false });
});

test("subscription, system, usage, feedback, and development panels keep dense console geometry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/admin.html`, { waitUntil: "networkidle" });

  await page.locator('#adminTabs .atab[data-go="subs"]').click();
  const maxPanel = await page.locator("#bgSubsSection").boundingBox();
  const proPanel = await page.locator("#proTierSection").boundingBox();
  const openPanel = await page.locator("#openFeatureSection").boundingBox();
  expect(maxPanel.x + maxPanel.width).toBeLessThanOrEqual(proPanel.x + 1);
  expect(proPanel.y).toBeLessThan(openPanel.y);
  await page.screenshot({ path: "/tmp/quilo-admin-subscriptions-console.png", fullPage: false });

  await page.locator('#adminTabs .atab[data-go="beta"]').click();
  const featurePanel = await page.locator("#betaSection").boundingBox();
  const systemPanel = await page.locator("#problemsetSection").boundingBox();
  expect(featurePanel.x + featurePanel.width).toBeLessThanOrEqual(systemPanel.x + 1);

  for (const group of ["logs", "appeals", "schools", "editor"]) {
    await page.locator(`#adminTabs .atab[data-go="${group}"]`).click();
    await expect(page.locator(`section.settings-card[data-atab="${group}"]`).first()).toBeVisible();
  }
  await page.locator('#adminTabs .atab[data-go="logs"]').click();
  await expect(page.locator("#logTable")).toBeVisible();
  await page.screenshot({ path: "/tmp/quilo-admin-usage-console.png", fullPage: false });

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("destructive operations retain confirmation gates and cancel without writes", async ({ page }) => {
  const writes = [];
  page.on("request", (request) => {
    if (!["GET", "HEAD"].includes(request.method())) {
      writes.push(`${request.method()} ${request.url()}`);
    }
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/admin.html`, { waitUntil: "networkidle" });
  await page.locator('#adminTabs .atab[data-go="users"]').click();

  let confirmationMessage = "";
  page.once("dialog", async (dialog) => {
    confirmationMessage = dialog.message();
    await dialog.dismiss();
  });
  await page.locator('#userTbody tr[data-user-id="qa-user"]').click();
  await page.locator('#userInspectorActions [data-inspector-action="delete"]').click();
  expect(confirmationMessage).toBe("정말 삭제할까요?");
  expect(writes).toEqual([]);
});

test("all high-impact admin actions keep explicit source-level confirmations", () => {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, "admin.html"), "utf8");
  expect(source.match(/\sstyle\s*=/gi) || []).toHaveLength(0);
  expect(source.match(/\son(?:click|change|input|submit)\s*=/gi) || []).toHaveLength(0);
  expect(source.match(/\.style\.(?!setProperty\b)[A-Za-z_$][\w$]*/g) || []).toHaveLength(0);
  expect(source.match(/\.style\.cssText\b/g) || []).toHaveLength(0);
  expect(source.match(/\.on[a-z]+\s*=/gi) || []).toHaveLength(0);

  const variableWrites = [...source.matchAll(/\.style\.setProperty\(\s*["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  expect(variableWrites).toEqual([
    "--minimap-scale",
    "--minimap-scale",
    "--minimap-top",
    "--minimap-height",
  ]);

  for (const message of [
    "정말 삭제할까요?",
    "기능을 삭제할까요?",
    "이 공지를 삭제할까요?",
    "이 위임을 회수할까요?",
    "이 구독을 회수할까요?",
    "이 신청을 거절할까요?",
    "입금을 확인했나요?",
    "Pro 권한을 즉시·완전히 해제할까요?",
  ]) {
    expect(source).toContain(message);
  }
});
