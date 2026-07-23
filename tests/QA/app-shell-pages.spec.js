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
const PAGES = [
  "create.html",
  "editor.html",
  "exam-prep.html",
  "filechat.html",
  "physics-studio.html",
  "studio.html",
  "study.html",
  "vibe-coding.html",
];

const EXPECTED_IDS = {
  "create.html": ["betaNotice", "chips", "cmtClose", "cmtList", "cmtModal", "cmtSend", "cmtSlug", "cmtText", "cmtTitle", "galcount", "gallery", "launch", "main-content", "mineWrap", "mylist", "sort", "whoami"],
  "editor.html": ["agentClear", "agentClose", "agentModel", "agentMsgs", "agentPrompt", "agentSend", "app", "ceFrame", "ceLang", "ceOut", "gate", "ideAgent", "ideFileInput", "ideFiles", "ideNewFile", "ideOpenFile", "ideOpenFolder", "idePanel", "idePanelClose", "ideSide", "ideTabs", "ideWelcome", "main-content", "monaco", "stDownload", "stFormat", "stMinimap", "stMsg", "stPip", "stPos", "stRun", "stSave", "stTheme", "wOpenFile", "wOpenFolder", "wStart"],
  "exam-prep.html": ["badgeCoding", "badgeReading", "btnConsole", "btnReset", "btnRunEx", "btnSubmit", "codingGate", "codingMain", "ctAssist", "ctAssistInput", "ctAssistMsgs", "ctAssistSend", "ctDetail", "ctEditor", "ctFallback", "ctList", "ctResults", "ctStatus", "main-content", "paneCoding", "paneReading", "readingGate", "readingMain", "tabCoding", "tabReading"],
  "filechat.html": ["accessNote", "fcChat", "fcClear", "fcFileChips", "fcFiles", "fcInput", "fcModel", "fcSend", "gate", "main-content", "tool"],
  "physics-studio.html": ["app", "bal", "copyMd", "cost", "count", "difficulty", "dlMd", "err", "formCard", "gate", "go", "hint", "main-content", "model", "notes", "out", "sol", "style", "toggleAll", "topic"],
  "studio.html": ["addFileBtn", "app", "balChip", "chips", "devseg", "dlZip", "fileTree", "gate", "imgBtn", "imgFile", "instatus", "main-content", "model", "modeseg", "monacoHost", "msgs", "o", "openPublish", "pCancel", "pCat", "pDo", "pPublic", "pSlug", "pTitle", "popout", "preview", "prompt", "pubModal", "pubModalTitle", "pubStatus", "pv", "pvhost", "refresh", "restoreBar", "restoreMeta", "restoreNo", "restoreYes", "sendBtn", "stage", "tabs", "thumbs", "toStage", "undoBtn"],
  "study.html": ["analyzeBtn", "assumptionList", "betaOut", "betaRange", "closeZoomBtn", "description", "diagramExplanation", "diagramTitle", "downloadBtn", "etaOut", "etaRange", "eventList", "main-content", "minkowskiCanvas", "minkowskiZoomCanvas", "modelHint", "modelSelect", "openZoomBtn", "problemImage", "resetBtn", "studyGate", "studyMain", "studyMsg", "studyStatus", "studyZoomModal", "studyZoomStage", "studyZoomTitle", "warningList", "worldlineList", "zoomFitBtn", "zoomMinusBtn", "zoomPlusBtn", "zoomScaleOut"],
  "translate.html": ["gate", "genSpinner", "main-content", "progress", "progressArea", "resultArea", "retypesetDlgBody", "retypesetDlgTitle", "retypesetMultiBody", "retypesetMultiTitle", "statusTitle", "stopBtn", "themeToggle", "tool", "trBg", "trBgField", "trBgNotify", "trBgNotifyWrap", "trBtn", "trChartRedraw", "trError", "trEstimate", "trForm", "trMode", "trModeHint", "trModel", "trPdf", "trRestoreOnly"],
  "vibe-coding.html": ["again", "chatLog", "chatMsg", "chatSend", "copyMd", "costLine", "dlMd", "err", "gate", "goBtn", "heroImg", "i_free", "i_idea", "i_img", "i_model", "intro", "loadMsg", "loadTitle", "loading", "main-content", "nextBtn", "planArea", "prevBtn", "progress", "refineChat", "refineCost", "result", "stage", "toStudio", "wizard"],
};

const EXPECTED_DATA = {
  "create.html": ["data-cat", "data-cmt", "data-del", "data-embed", "data-like", "data-report", "data-src", "data-title", "data-ui-shell"],
  "editor.html": ["data-act", "data-panel", "data-ui-shell"],
  "exam-prep.html": ["data-id", "data-ui-shell"],
  "filechat.html": ["data-ui-shell"],
  "physics-studio.html": ["data-ui-shell"],
  "studio.html": ["data-dev", "data-f", "data-mode", "data-rm", "data-tab", "data-tpl", "data-ui-shell", "data-ver"],
  "study.html": ["data-beta", "data-example", "data-ui-shell"],
  "translate.html": ["data-dz-file", "data-ui-shell"],
  "vibe-coding.html": ["data-chip", "data-ex", "data-opt", "data-ui-shell"],
};

const EXPECTED_STYLES = {
  "create.html": ["/ui/foundation.css", "/ui/shell.css", "/ui/app-shell.css", "/ui/app-workbench.css"],
  "editor.html": ["/ui/foundation.css", "/ui/shell.css", "/ui/app-shell.css", "/ui/app-workbench.css"],
  "exam-prep.html": ["/ui/foundation.css", "/ui/shell.css", "/ui/app-shell.css", "/ui/app-workbench.css"],
  "filechat.html": ["/ui/foundation.css", "/ui/shell.css", "/ui/app-shell.css", "/ui/app-chat.css"],
  "physics-studio.html": ["/ui/foundation.css", "/ui/shell.css", "/ui/app-shell.css", "/ui/app-generator.css"],
  "studio.html": ["/ui/foundation.css", "/ui/shell.css", "/ui/app-shell.css", "/ui/app-workbench.css"],
  "study.html": ["/ui/foundation.css", "/ui/shell.css", "/ui/app-shell.css", "/ui/app-workbench.css"],
  "vibe-coding.html": ["/ui/foundation.css", "/ui/shell.css", "/ui/app-shell.css", "/ui/app-generator.css"],
};

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

let server;
let baseUrl;

function fixture(pathname) {
  const fixtures = {
    "/api/me": { user: "QA 사용자", username: "qa-user", isAdmin: false },
    "/api/me/beta": { admin: false, tier: "pro", features: ["create", "code-editor", "physics-studio", "relativity-study", "vibe-coding"], blockedReportTypes: [] },
    "/api/me/balance": { credits: 8, isAdmin: false, modelCredits: { "claude-sonnet-5": 1 } },
    "/api/artifacts": { artifacts: [], persistent: true },
    "/api/artifacts/gallery": { items: [] },
    "/api/artifacts/models": { models: ["claude-sonnet-5"], default: "claude-sonnet-5" },
    "/api/artifacts/image-models": { models: ["gpt-image"], default: "gpt-image" },
    "/api/filechat/access": { allowed: true, reason: "beta" },
    "/api/physics-studio/config": {
      models: [{ id: "claude-sonnet-5", label: "Sonnet 5", credits: 1 }],
      defaultModel: "claude-sonnet-5",
      difficulties: ["상위 학부 중상", "올림피아드"],
      styles: [{ id: "olympiad-deep", label: "올림피아드 심화" }],
    },
    "/api/study/relativity/models": {
      models: [
        { id: "auto", label: "자동", available: true },
        { id: "claude-sonnet-5", label: "Sonnet 5", provider: "anthropic", available: true },
      ],
      defaultModel: "auto",
      autoLadder: ["claude-sonnet-5"],
    },
    "/api/subscriptions/me": { active: true, subscription: { tier: "max" } },
    "/api/vibe/config": {
      models: [{ id: "claude-sonnet-5", label: "Sonnet 5", credits: 1 }],
      defaultModel: "claude-sonnet-5",
      imageAvailable: false,
      imageCredits: 1,
    },
    "/api/chat/status": { enabled: false },
  };
  return fixtures[pathname] || {};
}

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405).end("Read-only QA");
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(fixture(url.pathname)));
      return;
    }
    const relative = url.pathname === "/" ? "create.html" : url.pathname.replace(/^\/+/, "");
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

test("all work surfaces use the shared Quilo header and preserve app DOM contracts", () => {
  for (const pageName of PAGES) {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, pageName), "utf8");
    const markupOnly = source.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
    const localStyles = [...markupOnly.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)/gi)]
      .map((match) => match[1])
      .filter((href) => href.startsWith("/"));
    expect(localStyles, pageName).toEqual(EXPECTED_STYLES[pageName]);
    expect(source, pageName).not.toMatch(/\/(?:style\.css|site-shell\.css|site-shell\.js)/);
    expect(markupOnly, pageName).not.toMatch(/<style\b|\sstyle\s*=/i);
    expect(markupOnly.match(/<main\b[^>]*id=["']main-content["']/gi) || [], pageName).toHaveLength(1);
    expect(markupOnly, `${pageName} shell root`).toMatch(/<body\b[^>]*data-app-shell/);
    expect(markupOnly, `${pageName} shared header`).toContain(
      '<header class="ui-site-header" data-ui-shell data-shell-mode="fixed"></header>',
    );
    expect(source, `${pageName} shared header runtime`).toContain('src="/ui/shell.js"');
    expect(source, `${pageName} removed app commandbar`).not.toContain("app-commandbar");
    expect(source, `${pageName} removed legacy app header hook`).not.toContain("data-q-shell");
    expect(markupOnly, `${pageName} accessible page name`).toMatch(
      /<main\b[^>]*(?:aria-label=["'][^"']+["'])|<h1\b/i,
    );
    for (const id of EXPECTED_IDS[pageName]) {
      expect(source, `${pageName} keeps #${id}`).toContain(`id="${id}"`);
    }
    for (const dataName of EXPECTED_DATA[pageName]) {
      expect(source, `${pageName} keeps ${dataName}`).toContain(dataName);
    }
  }

  for (const pageName of ["filechat.html"]) {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, pageName), "utf8");
    expect(source, `${pageName} runtime markup`).not.toMatch(/\sstyle\s*=/i);
  }
});

test("legacy translate app route redirects to the canonical PDF translation workspace", () => {
  const source = fs.readFileSync(path.join(PUBLIC_DIR, "translate-app.html"), "utf8");
  expect(source).toContain('http-equiv="refresh" content="0;url=/translate.html"');
  expect(source).toContain('location.replace("/translate.html"');
  expect(source).not.toContain('/api/translate-app');
});

test("legacy translate app route reaches the canonical PDF translation workspace", async ({ page }) => {
  await installNetworkFixtures(page, []);
  await page.goto(`${baseUrl}/translate-app.html`, { waitUntil: "networkidle" });
  await expect(page).toHaveURL(/\/translate\.html$/);
  await expect(page.locator("#main-content")).toBeVisible();
});

test("app entitlement gate distinguishes logged-out, forbidden, and Max access", async ({ page }) => {
  await page.route("**/api/me", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "login" }) }),
  );
  await page.goto(`${baseUrl}/physics-studio.html`, { waitUntil: "networkidle" });
  await expect(page.locator("#gate")).toContainText("로그인이 필요합니다");
  await expect(page.locator("#app")).toBeHidden();

  await page.unroute("**/api/me");
  await page.route("**/api/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: "QA", isAdmin: false }) }),
  );
  await page.route("**/api/me/beta", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ admin: false, tier: "pro", features: [] }) }),
  );
  await page.goto(`${baseUrl}/physics-studio.html`, { waitUntil: "networkidle" });
  await expect(page.locator("#gate")).toContainText("Pro 권한이 필요합니다");
  await expect(page.locator("#app")).toBeHidden();

  await page.unroute("**/api/me/beta");
  await page.route("**/api/me/beta", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ admin: false, tier: "max", features: [] }) }),
  );
  await page.route("**/api/me/balance", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture("/api/me/balance")) }),
  );
  await page.route("**/api/physics-studio/config", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture("/api/physics-studio/config")) }),
  );
  await page.goto(`${baseUrl}/physics-studio.html`, { waitUntil: "networkidle" });
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#gate")).toBeHidden();
});

test("app entitlement gate follows login and logout changes from another tab", async ({ page, context }) => {
  let loggedIn = false;
  await page.route("**/api/me", (route) =>
    route.fulfill({
      status: loggedIn ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(loggedIn ? { user: "모바일 QA", isAdmin: false } : { error: "login" }),
    }),
  );
  await page.route("**/api/me/beta", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ admin: false, tier: "max", features: [] }),
    }),
  );

  await page.goto(`${baseUrl}/physics-studio.html`, { waitUntil: "networkidle" });
  await expect(page.locator("#gate")).toContainText("로그인이 필요합니다");
  await expect(page.locator("#app")).toBeHidden();

  const peer = await context.newPage();
  await peer.goto(`${baseUrl}/guide.html`, { waitUntil: "domcontentloaded" });
  loggedIn = true;
  await peer.evaluate(() => localStorage.setItem("quilo:auth-sync", JSON.stringify({ action: "login", at: Date.now() })));

  await expect(page.locator("[data-ui-shell]")).toHaveAttribute("data-ui-auth-state", "authenticated");
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#gate")).toBeHidden();

  loggedIn = false;
  await peer.evaluate(() => localStorage.setItem("quilo:auth-sync", JSON.stringify({ action: "logout", at: Date.now() })));

  await expect(page.locator("[data-ui-shell]")).toHaveAttribute("data-ui-auth-state", "anonymous");
  await expect(page.locator("#gate")).toContainText("로그인이 필요합니다");
  await expect(page.locator("#app")).toBeHidden();
  await peer.close();
});

test("heavy app engines are loaded only after permission or the matching action", () => {
  const editor = fs.readFileSync(path.join(PUBLIC_DIR, "editor.html"), "utf8");
  const exam = fs.readFileSync(path.join(PUBLIC_DIR, "exam-prep.html"), "utf8");
  const physics = fs.readFileSync(path.join(PUBLIC_DIR, "physics-studio.html"), "utf8");
  const studio = fs.readFileSync(path.join(PUBLIC_DIR, "studio.html"), "utf8");
  expect(editor).not.toMatch(/<script[^>]+monaco-editor/i);
  expect(exam).not.toMatch(/<script[^>]+monaco-editor/i);
  expect(studio).not.toMatch(/<script[^>]+(?:monaco-editor|jszip)/i);
  expect(physics).not.toMatch(/<script[^>]+mathjax/i);
  expect(editor).toContain("QuiloAssets.monacoLoader");
  expect(exam).toContain("QuiloAssets.monacoLoader");
  expect(studio).toContain("QuiloAssets.jszip");
  expect(physics).toContain("QuiloAssets.mathjax");
});

test("app entitlement gate exposes a recoverable error state", async ({ page }) => {
  await page.route("**/api/me", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary" }) }),
  );
  await page.goto(`${baseUrl}/editor.html`, { waitUntil: "networkidle" });
  await expect(page.locator("#gate")).toContainText("권한 확인을 완료하지 못했습니다");
  await expect(page.locator("#gate [data-entitlement-retry]")).toBeVisible();
  await expect(page.locator("#app")).toBeHidden();
});

async function installNetworkFixtures(page, writes) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(`${request.method()} ${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    if (url.origin === baseUrl && url.pathname.startsWith("/api/")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture(url.pathname)) });
      return;
    }
    if (url.origin !== baseUrl) {
      const type = request.resourceType();
      if (type === "script") {
        await route.fulfill({ status: 200, contentType: "text/javascript", body: "" });
      } else if (type === "stylesheet") {
        await route.fulfill({ status: 200, contentType: "text/css", body: "" });
      } else {
        await route.fulfill({ status: 204, body: "" });
      }
      return;
    }
    await route.continue();
  });
}

async function exerciseCoreInteraction(page, pageName) {
  if (pageName === "create.html") {
    await page.locator("#sort").selectOption("likes");
    await expect(page.locator("#sort")).toHaveValue("likes");
  } else if (pageName === "editor.html") {
    const before = await page.locator("html").getAttribute("data-theme");
    const desktopTheme = page.locator("#themeToggle");
    if (await desktopTheme.isVisible()) {
      await desktopTheme.click();
    } else {
      await page.locator("[data-ui-mobile-trigger]").click();
      await page.locator("#uiMobilePanel [data-ui-theme]").click();
    }
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", before || "light");
  } else if (pageName === "exam-prep.html") {
    await page.locator("#tabReading").click();
    await expect(page.locator("#paneReading")).toBeVisible();
  } else if (pageName === "filechat.html") {
    await expect(page.locator("#tool")).toBeVisible();
    await page.locator("#fcInput").fill("요약해 줘");
    await page.locator("#fcClear").click();
    await expect(page.locator("#fcChat")).toContainText("대화를 초기화했습니다");
  } else if (pageName === "physics-studio.html") {
    await expect(page.locator("#app")).toBeVisible();
    await page.locator("#topic").fill("특수상대론 운동량");
    await expect(page.locator("#topic")).toHaveValue("특수상대론 운동량");
  } else if (pageName === "studio.html") {
    await expect(page.locator("#app")).toBeVisible();
    const layout = await page.evaluate(() => {
      const app = document.querySelector("#app");
      const body = document.querySelector("#app > .body");
      const top = document.querySelector("#app > .top");
      const chat = document.querySelector("#app .chat");
      const stage = document.querySelector("#app .stage");
      return {
        appDirection: getComputedStyle(app).flexDirection,
        bodyDisplay: getComputedStyle(body).display,
        topAboveBody: top.getBoundingClientRect().bottom <= body.getBoundingClientRect().top + 1,
        chatLeftOfStage: chat.getBoundingClientRect().right <= stage.getBoundingClientRect().left + 1,
      };
    });
    expect(layout).toEqual({
      appDirection: "column",
      bodyDisplay: "flex",
      topAboveBody: true,
      chatLeftOfStage: true,
    });
    await page.locator('[data-mode="image"]').click();
    await expect(page.locator('[data-mode="image"]')).toHaveClass(/on/);
  } else if (pageName === "study.html") {
    await expect(page.locator("#studyMain")).toBeVisible();
    await page.locator('[data-example="boost"]').click();
    await expect(page.locator("#description")).toHaveValue(/막대/);
  } else if (pageName === "translate-app.html") {
    await expect(page.locator("#app")).toBeVisible();
    await page.locator("#mode").selectOption("retypeset");
    await expect(page.locator("#mode")).toHaveValue("retypeset");
  } else if (pageName === "translate.html") {
    await expect(page.locator("#tool")).toBeVisible();
    await page.locator("#trMode").selectOption("inplace");
    await expect(page.locator("#trModeHint")).toContainText("레이아웃");
  } else if (pageName === "vibe-coding.html") {
    await expect(page.locator("#wizard")).toBeVisible();
    await page.locator("#i_idea").fill("실험 일정 관리 웹앱");
    await page.locator("#nextBtn").click();
    await expect(page.locator("#stage h2")).toContainText("어떤 느낌");
  }
}

async function shellGeometry(page) {
  return page.evaluate(() => {
    const header = document.querySelector("[data-ui-shell]");
    const status = document.querySelector(".app-statusbar");
    const headerRect = header.getBoundingClientRect();
    const statusRect = status.getBoundingClientRect();
    const headerOffenders = [...header.querySelectorAll("a, button")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
      })
      .map((element) => element.id || element.textContent.trim());
    return {
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      headerPosition: getComputedStyle(header).position,
      headerTop: Math.round(headerRect.top),
      headerToken: Number.parseInt(
        getComputedStyle(document.documentElement).getPropertyValue("--ui-site-header-h"),
        10,
      ),
      statusPosition: getComputedStyle(status).position,
      statusBottom: Math.round(innerHeight - statusRect.bottom),
      headerOffenders,
    };
  });
}

async function verifyPinnedChrome(page, pageName) {
  const maxScroll = await page.evaluate(() =>
    Math.max(0, document.documentElement.scrollHeight - innerHeight),
  );
  if (maxScroll === 0) return;
  await page.evaluate((top) => window.scrollTo(0, top), Math.min(240, maxScroll));
  await page.waitForTimeout(40);
  const pinned = await page.evaluate(() => {
    const headerRect = document.querySelector("[data-ui-shell]").getBoundingClientRect();
    const statusRect = document.querySelector(".app-statusbar").getBoundingClientRect();
    return {
      headerTop: Math.round(headerRect.top),
      statusBottom: Math.round(innerHeight - statusRect.bottom),
    };
  });
  expect(pinned, `${pageName} pinned chrome after scroll`).toEqual({ headerTop: 0, statusBottom: 0 });
  await page.evaluate(() => window.scrollTo(0, 0));
}

for (const pageName of PAGES) {
  test(`${pageName} renders at 1440×933, responds, and has no runtime errors`, async ({ page }) => {
    const writes = [];
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    await installNetworkFixtures(page, writes);
    await page.setViewportSize({ width: 1440, height: 933 });
    await page.goto(`${baseUrl}/${pageName}`, { waitUntil: "networkidle" });

    await expect(page.locator("[data-ui-shell].ui-site-header")).toBeVisible();
    await expect(page.locator(".ui-site-nav")).toBeVisible();
    await expect(page.locator(".ui-site-actions")).toBeVisible();
    await expect(page.locator("#main-content")).toBeVisible();
    await expect(page.locator(".app-statusbar")).toBeVisible();
    await expect(page.locator("body")).toHaveClass(new RegExp(`app-shell--${pageName.replace(/\.html$/, "")}`));
    await exerciseCoreInteraction(page, pageName);
    const geometry = await shellGeometry(page);
    expect(geometry, pageName).toEqual({
      overflow: 0,
      headerPosition: "fixed",
      headerTop: 0,
      headerToken: 72,
      statusPosition: "fixed",
      statusBottom: 0,
      headerOffenders: [],
    });
    await verifyPinnedChrome(page, pageName);
    if (["create.html", "filechat.html", "physics-studio.html", "studio.html", "study.html", "vibe-coding.html"].includes(pageName)) {
      await page.screenshot({ path: `/tmp/quilo-${pageName.replace(".html", "")}-app-shell.png`, fullPage: false });
    }
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("all work surfaces reflow and respond at the 933px compact desktop width", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await installNetworkFixtures(page, []);
  await page.setViewportSize({ width: 933, height: 768 });

  for (const pageName of PAGES) {
    const errorCount = errors.length;
    await page.goto(`${baseUrl}/${pageName}`, { waitUntil: "networkidle" });
    await exerciseCoreInteraction(page, pageName);
    const geometry = await shellGeometry(page);
    expect(geometry, pageName).toEqual({
      overflow: 0,
      headerPosition: "fixed",
      headerTop: 0,
      headerToken: 68,
      statusPosition: "fixed",
      statusBottom: 0,
      headerOffenders: [],
    });
    await verifyPinnedChrome(page, pageName);
    if (["create.html", "studio.html", "translate.html"].includes(pageName)) {
      await page.screenshot({
        path: `/tmp/quilo-${pageName.replace(".html", "")}-app-shell-933.png`,
        fullPage: false,
      });
    }
    expect(errors.slice(errorCount), `${pageName} console health`).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test("all work surfaces reflow and keep core controls usable at 390px", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await installNetworkFixtures(page, []);
  await page.setViewportSize({ width: 390, height: 844 });

  for (const pageName of PAGES) {
    const errorCount = errors.length;
    await page.goto(`${baseUrl}/${pageName}`, { waitUntil: "networkidle" });
    await expect(page.locator("[data-ui-mobile-trigger]"), `${pageName} mobile menu`).toBeVisible();
    await expect(page.locator("#main-content"), `${pageName} mobile content`).toBeVisible();
    if (pageName === "studio.html") {
      await expect(page.locator("#app")).toBeVisible();
      await page.locator('[data-mode="image"]').click();
      await expect(page.locator('[data-mode="image"]')).toHaveClass(/on/);
    } else {
      await exerciseCoreInteraction(page, pageName);
    }
    const geometry = await shellGeometry(page);
    expect(geometry, pageName).toEqual({
      overflow: 0,
      headerPosition: "fixed",
      headerTop: 0,
      headerToken: 68,
      statusPosition: "fixed",
      statusBottom: 0,
      headerOffenders: [],
    });
    await verifyPinnedChrome(page, pageName);
    if (["editor.html", "filechat.html", "physics-studio.html"].includes(pageName)) {
      await page.screenshot({
        path: `/tmp/quilo-${pageName.replace(".html", "")}-app-shell-390.png`,
        fullPage: false,
      });
    }
    expect(errors.slice(errorCount), `${pageName} mobile console health`).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test("representative empty, modal, and loading states remain contained below the shared header", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await installNetworkFixtures(page, []);
  await page.setViewportSize({ width: 1440, height: 933 });

  await page.goto(`${baseUrl}/create.html`, { waitUntil: "networkidle" });
  await expect(page.locator("#gallery .empty")).toBeVisible();
  await page.route("**/p/focus-demo", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>QA preview</title>" }),
  );
  await page.evaluate(() => {
    galItems = [{ slug: "focus-demo", title: "포커스 테스트", owner: "QA", category: "기타", likes: 0, views: 0 }];
    renderGallery();
  });
  const commentOpener = page.locator('button[data-cmt="focus-demo"]');
  await commentOpener.focus();
  await commentOpener.click();
  await expect(page.locator("#cmtModal")).toBeVisible();
  await expect(page.locator("#cmtClose")).toBeFocused();
  await expect(page.locator("#main-content")).toHaveJSProperty("inert", true);
  const modalRect = await page.locator("#cmtModal .card").boundingBox();
  expect(modalRect.x).toBeGreaterThanOrEqual(0);
  expect(modalRect.y).toBeGreaterThanOrEqual(0);
  expect(modalRect.x + modalRect.width).toBeLessThanOrEqual(1440);
  expect(modalRect.y + modalRect.height).toBeLessThanOrEqual(933);

  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#cmtSend")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#cmtClose")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#cmtModal")).toBeHidden();
  await expect(commentOpener).toBeFocused();
  await expect(page.locator("#main-content")).toHaveJSProperty("inert", false);

  await commentOpener.click();
  await expect(page.locator("#cmtClose")).toBeFocused();
  await page.locator("#cmtClose").click();
  await expect(page.locator("#cmtModal")).toBeHidden();
  await expect(commentOpener).toBeFocused();

  await page.route("**/api/physics-studio/generate", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: { title: "QA", problems: [] }, newBalance: 7 }),
    });
  });
  await page.goto(`${baseUrl}/physics-studio.html`, { waitUntil: "networkidle" });
  await page.locator("#topic").fill("특수상대론 운동량");
  await page.locator("#go").click();
  await expect(page.locator("#go")).toContainText("생성 중");
  await expect(page.locator("#out .spinner")).toBeVisible();
  await expect(page.locator("#go")).toHaveText("문제 생성", { timeout: 3000 });
  expect(errors).toEqual([]);
});
