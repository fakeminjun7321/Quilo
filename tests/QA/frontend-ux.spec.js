const fs = require("fs");
const path = require("path");
const { startQaServer } = require("./helpers/qa-server");

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
const SCREEN_DIR = path.join(process.cwd(), "test-results", "frontend-screens");
let qaServer = null;
let BASE_URL = "";

async function mockLoggedInApis(page) {
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/api/announcements") {
      return route.fulfill({ json: { announcements: [] } });
    }
    if (pathname === "/api/me") {
      return route.fulfill({
        json: {
          user: "QA",
          studentId: "2402",
          isAdmin: false,
          styleNote: "",
          blockedReportTypes: [],
        },
      });
    }
    if (pathname === "/api/me/beta") {
      return route.fulfill({ json: { admin: false, features: [] } });
    }
    if (pathname === "/api/me/balance") {
      return route.fulfill({ json: { credits: 8, unlimited: false } });
    }
    if (pathname === "/api/me/files") {
      return route.fulfill({
        json: {
          storage: true,
          cloud: null,
          maxFilesPerUser: 3,
          files: [
            {
              id: "qa-file-1",
              filename: "화학_사전보고서_QA.docx",
              size_bytes: 128000,
              created_at: "2026-06-14T01:00:00.000Z",
              expires_at: "2026-06-15T01:00:00.000Z",
            },
          ],
        },
      });
    }
    if (pathname === "/api/cloud/dropbox/status") {
      return route.fulfill({ json: { enabled: false } });
    }
    if (pathname === "/api/cloud/providers/status") {
      return route.fulfill({
        json: {
          integrations: {
            dropbox: { configured: true, connected: false, connectUrl: "/api/cloud/dropbox/connect" },
            google: { configured: true, connected: false, connectUrl: "/api/cloud/google/connect" },
            notion: { configured: true, connected: false, connectUrl: "/api/cloud/notion/connect" },
          },
        },
      });
    }
    if (pathname === "/api/me/usage") {
      return route.fulfill({
        json: {
          credits: 8,
          genCount: 1,
          genLimit: 5,
          recent: [
            { date: "2026-06-14T01:00:00.000Z", label: "화학 사전보고서", model: "gpt-5.4", credits: 1 },
          ],
        },
      });
    }
    return route.fulfill({ json: {} });
  });
}

test.beforeAll(async () => {
  qaServer = await startQaServer();
  BASE_URL = qaServer.baseUrl;
});

test.afterAll(async () => {
  if (qaServer) await qaServer.stop();
});

test("home uses the compact header at the real 933px viewport", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/me") return route.fulfill({ status: 401, json: { error: "로그인이 필요합니다." } });
    if (pathname === "/api/announcements") return route.fulfill({ json: { announcements: [] } });
    if (pathname === "/api/chat/status") return route.fulfill({ json: { enabled: false } });
    return route.fulfill({ json: {} });
  });

  await page.setViewportSize({ width: 933, height: 897 });
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  const mobileTrigger = page.locator("[data-ui-mobile-trigger]");
  await expect(mobileTrigger).toBeVisible();
  await expect(page.locator("#navMenu")).toBeHidden();
  await expect(page.locator("#reportTypeFieldset")).toBeHidden();
  await expect(page.locator("#reportTypes")).toBeHidden();
  await mobileTrigger.click();
  await expect(page.locator("#uiMobilePanel")).toBeVisible();
  await expect(page.locator("#uiMobilePanel")).toContainText("제품");
  await expect(page.locator("#uiMobilePanel")).toContainText("Instagram");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});

test("report runtime is loaded only after an authenticated report choice", async ({ page }) => {
  await mockLoggedInApis(page);
  const requested = [];
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  expect(requested).not.toContain("/app.js");
  expect(requested).not.toContain("/workspace/report-runtime.js");
  const started = Date.now();
  await page.locator('[data-ui-menu-trigger="0"]').click();
  await page.locator('#uiSiteMega a[data-report="chem-pre"]').click();
  await expect(page.locator('#form[data-report-form="chem-pre"]')).toBeVisible();
  expect(Date.now() - started).toBeLessThan(1500);
  expect(requested).toContain("/app.js");
  expect(requested).toContain("/workspace/report-runtime.js");
});

test("production announcements render as one quiet dismissible rail", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/me") return route.fulfill({ status: 401, json: { error: "로그인이 필요합니다." } });
    if (pathname === "/api/announcements") {
      return route.fulfill({
        json: {
          announcements: [{ category: "공지", title: "Quilola.com 전용 도메인 생성", link: "/changelog.html" }],
        },
      });
    }
    if (pathname === "/api/chat/status") return route.fulfill({ json: { enabled: false } });
    return route.fulfill({ json: {} });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await expect(page.locator("#annTicker")).toBeVisible();
  const metrics = await page.evaluate(() => {
    const ticker = document.getElementById("annTicker");
    const track = document.getElementById("annTrack");
    const title = track.querySelector(".ui-announcement__title");
    return {
      height: ticker.getBoundingClientRect().height,
      scrollHeight: ticker.scrollHeight,
      titleWhiteSpace: title ? getComputedStyle(title).whiteSpace : "",
      animationName: getComputedStyle(track).animationName,
      itemCount: track.querySelectorAll(".ui-announcement__title").length,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(metrics.height).toBeGreaterThanOrEqual(56);
  expect(metrics.height).toBeLessThanOrEqual(64);
  expect(metrics.scrollHeight).toBeLessThanOrEqual(64);
  expect(metrics.titleWhiteSpace).toBe("nowrap");
  expect(metrics.animationName).toBe("none");
  expect(metrics.itemCount).toBe(1);
  expect(metrics.pageOverflow).toBe(0);
  await expect(page.locator(".ui-announcement__category")).toHaveText("공지");
  await expect(page.locator(".ui-announcement__date")).toBeHidden();
  await expect(page.locator(".ui-announcement__more")).toContainText("자세히 보기");
});

test("authentication stays on landing until an explicit report opens the workspace", async ({ page }) => {
  fs.mkdirSync(SCREEN_DIR, { recursive: true });
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await mockLoggedInApis(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await expect(page.locator("body")).toHaveAttribute("data-auth", "in");
  await expect(page.locator("body")).toHaveAttribute("data-view", "landing");
  await expect(page.locator("#landingSurface")).toBeVisible();
  await expect(page.locator("#workspaceSurface")).toBeHidden();
  await expect(page.locator("#reportTypes")).toBeHidden();
  await expect(page.locator("#reportTypeFieldset")).toBeHidden();
  await expect(page.locator("#loginDd")).toBeHidden();
  await expect(page.locator("#sessionAction")).toBeVisible();
  await expect(page.locator("#acctDd")).toBeHidden();
  await page.locator("#sessionAction").click();
  await expect(page.locator("#accountSlot")).toHaveClass(/is-open/);
  await expect(page.locator("#acctDd")).toBeVisible();
  await expect(page.locator("#homeHero")).toBeVisible();
  await expect(page.locator("#quiloBotMount .quilo-bot-fallback")).toHaveAttribute("href", "/?report=phys-result");

  await page.locator('[data-ui-menu-trigger="0"]').click();
  await page.locator('#uiSiteMega a[data-report="chem-pre"]').click();
  await page.waitForTimeout(350);
  await expect(page.locator("body")).toHaveAttribute("data-view", "workspace");
  await expect(page.locator("#landingSurface")).toBeHidden();
  await expect(page.locator("#workspaceSurface")).toBeVisible();
  await expect(page.locator("#workspaceSummary")).toBeVisible();
  await expect(page.locator("#form.active")).toBeVisible();
  await expect(page.locator("#form")).toHaveAttribute("data-flow-step", "upload");
  await expect(page.locator("#reportWorkflowNav")).toBeVisible();
  await expect(page.locator("#reportWorkflowNav [data-flow-jump]")).toHaveCount(4);
  await expect(page.locator("#form .form-flow-steps, #form .optional-settings")).toHaveCount(0);
  let stepVisibility = await page.evaluate(() => ({
    sectionCount: document.querySelectorAll("#form > .form-section").length,
    visibleSectionCount: [...document.querySelectorAll("#form > .form-section")].filter((node) => getComputedStyle(node).display !== "none").length,
    actions: getComputedStyle(document.querySelector("#form > .form-actions")).display,
  }));
  expect(stepVisibility.visibleSectionCount).toBe(stepVisibility.sectionCount);
  expect(stepVisibility.actions).not.toBe("none");

  await page.locator('#reportWorkflowNav button[data-flow-jump="info"]').click();
  await page.waitForTimeout(150);
  await expect(page.locator("#form")).toHaveAttribute("data-flow-step", "info");
  stepVisibility = await page.evaluate(() => ({
    sectionCount: document.querySelectorAll("#form > .form-section").length,
    visibleSectionCount: [...document.querySelectorAll("#form > .form-section")].filter((node) => getComputedStyle(node).display !== "none").length,
  }));
  expect(stepVisibility.visibleSectionCount).toBe(stepVisibility.sectionCount);

  await page.locator('#reportWorkflowNav button[data-flow-jump="settings"]').click();
  await page.waitForTimeout(150);
  await expect(page.locator("#form")).toHaveAttribute("data-flow-step", "settings");

  await page.locator('#reportWorkflowNav button[data-flow-jump="generate"]').click();
  await page.waitForTimeout(150);
  await expect(page.locator("#form")).toHaveAttribute("data-flow-step", "generate");
  stepVisibility = await page.evaluate(() => ({
    sectionCount: document.querySelectorAll("#form > .form-section").length,
    visibleSectionCount: [...document.querySelectorAll("#form > .form-section")].filter((node) => getComputedStyle(node).display !== "none").length,
    actions: getComputedStyle(document.querySelector("#form > .form-actions")).display,
  }));
  expect(stepVisibility.visibleSectionCount).toBe(stepVisibility.sectionCount);
  expect(stepVisibility.actions).not.toBe("none");
  const selectedLayout = await page.evaluate(() => {
    const form = document.querySelector("#form").getBoundingClientRect();
    const sidebar = document.querySelector("#workspaceSummary").getBoundingClientRect();
    return {
      separated: form.right <= sidebar.left,
      sidebarWidth: Math.round(sidebar.width),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(selectedLayout.separated).toBe(true);
  expect(selectedLayout.sidebarWidth).toBeGreaterThanOrEqual(320);
  expect(selectedLayout.pageOverflow).toBe(0);
  await page.screenshot({ path: path.join(SCREEN_DIR, "desktop-1440.png"), fullPage: false });

  await page.setViewportSize({ width: 1206, height: 900 });
  await page.goto(`${BASE_URL}/?report=chem-pre`, { waitUntil: "networkidle" });
  await expect(page.locator("#workspaceSummary")).toBeVisible();
  await expect(page.locator("#reportWorkflowNav")).toBeVisible();
  await expect(page.locator("#reportTypeFieldset")).toBeHidden();
  const compactDesktop = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    sidebarWidth: Math.round(document.getElementById("workspaceSummary").getBoundingClientRect().width),
  }));
  expect(compactDesktop.overflow).toBe(0);
  expect(compactDesktop.sidebarWidth).toBeGreaterThanOrEqual(320);
  await page.screenshot({ path: path.join(SCREEN_DIR, "desktop-1206.png"), fullPage: false });

  expect(errors).toEqual([]);
});

test("cloud providers use a separate account tab instead of the files panel", async ({ page }) => {
  await mockLoggedInApis(page);
  await page.goto(`${BASE_URL}/#integrations`, { waitUntil: "networkidle" });

  await expect(page.locator("body")).toHaveAttribute("data-auth", "in");
  await page.locator("#sessionAction").click();
  await expect(page.locator("#accountSlot")).toHaveClass(/is-open/);
  await expect(page.locator('#acctDd a[data-tab="integrations"] strong')).toHaveText("외부 서비스 연결");
  await expect(page.locator("#integrationsPanel")).toBeVisible();
  await expect(page.locator("#cloudCard")).toBeVisible();
  await expect(page.locator("#integrationsPanel")).toContainText("Google Drive·Docs");
  await expect(page.locator("#integrationsPanel")).toContainText("Notion");
  await expect(page.locator("#filesPanel #cloudCard")).toHaveCount(0);
  await expect(page.locator("#filesPanel")).toBeHidden();
});

test("account utility panels are centered and integrations have a real empty state", async ({ page }) => {
  await mockLoggedInApis(page);
  await page.route("**/api/cloud/providers/status", (route) => route.fulfill({ json: { integrations: {} } }));
  await page.setViewportSize({ width: 1206, height: 900 });
  await page.goto(`${BASE_URL}/#integrations`, { waitUntil: "networkidle" });

  await expect(page.locator("#integrationsPanel")).toBeVisible();
  await expect(page.locator("#cloudCard")).toBeHidden();
  await expect(page.locator("#cloudEmptyState")).toBeVisible();
  await expect(page.locator("#cloudEmptyState")).toContainText("아직 연결된 외부 서비스가 없습니다");
  const integrationLayout = await page.evaluate(() => {
    const panel = document.getElementById("integrationsPanel").getBoundingClientRect();
    const card = document.getElementById("cloudEmptyState").getBoundingClientRect();
    return {
      width: Math.round(card.width),
      centerDelta: Math.round(Math.abs((card.left + card.right) / 2 - (panel.left + panel.right) / 2)),
    };
  });
  expect(integrationLayout.width).toBeLessThanOrEqual(920);
  expect(integrationLayout.centerDelta).toBeLessThanOrEqual(2);

  await page.locator("#sessionAction").click();
  await expect(page.locator("#accountSlot")).toHaveClass(/is-open/);
  await page.locator('#acctDd a[data-tab="files"]').click();
  await expect(page.locator("#filesPanel")).toBeVisible();
  await expect(page.locator("#filesPanel > .settings-card")).toBeVisible();
  await page.locator("#sessionAction").click();
  await expect(page.locator("#accountSlot")).toHaveClass(/is-open/);
  const supportLink = page.locator('#acctDd a[href="/support.html"]');
  await expect(supportLink).toBeVisible();
  await expect(supportLink).toContainText("고객센터");
  await expect(page.locator('#acctDd a[data-tab="feedback"]')).toHaveCount(0);
});

test("report entry links bypass the removed intermediary and open the free report form", async ({ page }) => {
  await mockLoggedInApis(page);
  await page.goto(`${BASE_URL}/?report=free`, { waitUntil: "networkidle" });

  await expect(page.locator("body")).toHaveAttribute("data-view", "workspace");
  await expect(page.locator('input[name="reportType"][value="free"]')).toBeChecked();
  await expect(page.locator('#freeForm[data-report-form="free"]')).toBeVisible();
  await expect(page.locator("#reportsPanel")).toHaveClass(/workspace-mode/);
  await expect(page.locator("#choosePrompt")).toHaveCount(0);
  await expect(page.locator(".home-hero-categories")).toHaveCount(0);
  await page.locator('[data-ui-menu-trigger="0"]').click();
  await expect(page.locator('#uiSiteMega a[data-report="free"] strong')).toHaveText("자유 보고서");
  await expect(page.locator('.ui-site-actions [data-ui-start-action]')).toBeHidden();
});

test("home fallback remains actionable when the AI chat provider is unavailable", async ({ page }) => {
  await mockLoggedInApis(page);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  const fallback = page.locator("#quiloBotMount .quilo-bot-fallback");
  await expect(fallback).toBeVisible();
  await fallback.click();
  await expect(page.locator("body")).toHaveAttribute("data-view", "workspace");
  await expect(page.locator('input[name="reportType"][value="phys-result"]')).toBeChecked();
  await expect(page.locator('#physResultForm[data-report-form="phys-result"]')).toBeVisible();
});

test("mobile report routes put the working form before the long status summary", async ({ page }) => {
  await mockLoggedInApis(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/?report=chem-pre`, { waitUntil: "networkidle" });

  await expect(page.locator("#form.active")).toBeVisible();
  await expect(page.locator("#workspaceSummary")).toBeVisible();
  const layout = await page.evaluate(() => {
    const form = document.getElementById("form").getBoundingClientRect();
    const summary = document.getElementById("workspaceSummary").getBoundingClientRect();
    const workflow = document.getElementById("reportWorkflowNav").getBoundingClientRect();
    return {
      workflowBeforeForm: workflow.top < form.top,
      formBeforeSummary: form.top < summary.top,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(layout.workflowBeforeForm).toBe(true);
  expect(layout.formBeforeSummary).toBe(true);
  expect(layout.pageOverflow).toBe(0);
});

test("public report routes resolve to a continuous visible form contract", async ({ page }) => {
  await mockLoggedInApis(page);
  const cases = [
    ["chem-pre", "form"],
    ["chem-result", "chemResultForm"],
    ["phys-result", "physResultForm"],
    ["reading-log", "readingLogForm"],
    ["free", "freeForm"],
  ];
  for (const [type, formId] of cases) {
    await page.goto(`${BASE_URL}/?report=${type}`, { waitUntil: "networkidle" });
    await expect(page.locator("body")).toHaveAttribute("data-view", "workspace");
    await expect(page.locator(`input[name="reportType"][value="${type}"]`)).toBeChecked();
    await expect(page.locator(`#${formId}[data-report-form="${type}"]`)).toBeVisible();
    await expect(page.locator("#reportWorkflowNav [data-flow-jump]")).toHaveCount(4);
    await expect(page.locator(`#${formId} .form-flow-steps, #${formId} .optional-settings`)).toHaveCount(0);
    const visibleSections = await page.locator(`#${formId} > .form-section:visible`).count();
    expect(visibleSections).toBeGreaterThan(0);
  }
});

test("secondary UX pages render without console errors", async ({ page }) => {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`${page.url()}: ${msg.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));

  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/community/posts") {
      return route.fulfill({ json: { storage: true, posts: [] } });
    }
    if (pathname === "/api/lab/entries") {
      return route.fulfill({ json: { entries: [] } });
    }
    if (pathname === "/api/me/beta") {
      return route.fulfill({ json: { admin: false, features: [] } });
    }
    if (pathname === "/api/artifacts/gallery") {
      return route.fulfill({ json: { items: [] } });
    }
    if (pathname === "/api/artifacts") {
      return route.fulfill({ json: { persistent: true, artifacts: [] } });
    }
    return route.fulfill({ json: {} });
  });

  for (const pathName of ["/tools/convert.html", "/guide.html", "/examples.html", "/community.html", "/create.html"]) {
    await page.goto(`${BASE_URL}${pathName}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toBeVisible();
  }

  expect(errors).toEqual([]);
});
