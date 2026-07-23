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
let server;
let baseUrl;
let apiRequests = [];
let loginRedirect = "/oauth/authorize?client_id=qa";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
  });
}

test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "POST" && url.pathname.startsWith("/api/")) {
      const raw = await readBody(request);
      const body = raw ? JSON.parse(raw) : {};
      apiRequests.push({ pathname: url.pathname, body });
      const expiredReset = url.pathname === "/api/password-reset/confirm" && body.token === "expired-token";
      const payload =
        url.pathname === "/api/login"
          ? { redirect: loginRedirect }
          : url.pathname === "/api/password-reset/request"
            ? { ok: true, message: "계정에 인증된 이메일이 있으면 비밀번호 재설정 링크를 보냈습니다." }
            : url.pathname === "/api/password-reset/confirm"
              ? { ok: true }
          : url.pathname === "/api/signup"
            ? {
                emailSent: true,
                pendingEmail: body.email,
                organizationStaffPending: String(body.email || "").toLowerCase().endsWith("@quilolab.com"),
              }
            : url.pathname === "/api/verify-email/confirm"
              ? { ok: true, staffGranted: body.token === "staff-token" }
            : {};
      response.writeHead(expiredReset ? 400 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(expiredReset
        ? { error: "이미 사용했거나 만료된 재설정 링크입니다. 다시 요청하세요." }
        : payload));
      return;
    }
    if (url.pathname === "/oauth/authorize") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>OAuth</title><p id='oauth-ok'>OAuth authorize</p>");
      return;
    }
    const relative = url.pathname === "/" ? "login.html" : url.pathname.replace(/^\/+/, "");
    const file = path.resolve(PUBLIC_DIR, relative);
    if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    fs.readFile(file, (error, contents) => {
      if (error) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream",
      });
      response.end(contents);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
  apiRequests = [];
  loginRedirect = "/oauth/authorize?client_id=qa";
});

test("auth pages load only the new isolated stylesheets", async ({ page }) => {
  for (const pathname of ["/login.html", "/signup.html", "/verify-email.html?token=qa", "/password-reset.html"]) {
    await page.goto(baseUrl + pathname);
    const styles = await page.locator('link[rel="stylesheet"]').evaluateAll((links) =>
      links.map((link) => new URL(link.href).pathname),
    );
    expect(styles).toEqual(["/ui/foundation.css", "/ui/auth.css"]);
  }
});

test("auth theme controls use icon-only moon/sun states and keep accessible labels synchronized", async ({ page }) => {
  for (const pathname of ["/login.html", "/signup.html", "/verify-email.html?token=qa", "/password-reset.html"]) {
    await page.goto(baseUrl + pathname);
    const toggle = page.locator("#themeToggle");
    await expect(toggle).toHaveText(/☾\s*☀/);
    await expect(toggle.locator(".auth-theme__moon")).toHaveCount(1);
    await expect(toggle.locator(".auth-theme__sun")).toHaveCount(1);
    await expect(toggle).toHaveCSS("width", "40px");
    await expect(toggle).toHaveCSS("height", "40px");
    await expect(toggle).toHaveAttribute("aria-label", "다크 모드로 전환");
    await expect(toggle).toHaveAttribute("title", "다크 모드로 전환");
    await expect(toggle.locator(".auth-theme__moon")).toBeVisible();
    await expect(toggle.locator(".auth-theme__sun")).toBeHidden();

    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(toggle).toHaveAttribute("aria-label", "라이트 모드로 전환");
    await expect(toggle).toHaveAttribute("title", "라이트 모드로 전환");
    await expect(toggle.locator(".auth-theme__moon")).toBeHidden();
    await expect(toggle.locator(".auth-theme__sun")).toBeVisible();

    await page.evaluate(() => localStorage.removeItem("theme"));
  }
});

test("login clears the previous principal, preserves payload, toggles password, and redirects to OAuth", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lastUsername", "saved-user"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/login.html`);
  await expect(page.locator("#li_username")).toHaveValue("");
  await page.locator("#li_username").fill("qa-user");
  await page.locator("#li_password").fill("secret-pass");
  await page.locator('[data-password-toggle="li_password"]').click();
  await expect(page.locator("#li_password")).toHaveAttribute("type", "text");
  await page.screenshot({ path: "/tmp/quilo-auth-login.png", fullPage: true });
  await page.locator("#loginForm").evaluate((form) => form.requestSubmit());
  await expect(page).toHaveURL(/\/oauth\/authorize\?client_id=qa$/);
  expect(apiRequests).toEqual([
    {
      pathname: "/api/login",
      body: { username: "qa-user", password: "secret-pass", remember: true },
    },
  ]);
});

test("login rejects non-local OAuth redirect values", async ({ page }) => {
  loginRedirect = "https://malicious.example/steal";
  await page.goto(`${baseUrl}/login.html`);
  await page.locator("#li_username").fill("qa-user");
  await page.locator("#li_password").fill("qa-password");
  await page.locator("#loginForm").evaluate((form) => form.requestSubmit());
  await expect(page).toHaveURL(`${baseUrl}/`);
});

test("login returns to a safe next path and rejects an external next target", async ({ page }) => {
  loginRedirect = null;
  await page.goto(`${baseUrl}/login.html?next=${encodeURIComponent("/developer-notes.html?from=login#latest")}`);
  await page.locator("#li_username").fill("qa-user");
  await page.locator("#li_password").fill("qa-password");
  await page.locator("#loginForm").evaluate((form) => form.requestSubmit());
  await expect(page).toHaveURL(`${baseUrl}/developer-notes.html?from=login#latest`);

  await page.goto(`${baseUrl}/login.html?next=${encodeURIComponent("//malicious.example/steal")}`);
  await page.locator("#li_username").fill("qa-user");
  await page.locator("#li_password").fill("qa-password");
  await page.locator("#loginForm").evaluate((form) => form.requestSubmit());
  await expect(page).toHaveURL(`${baseUrl}/`);
});

test("mobile login submits and returns to the requested page without horizontal overflow", async ({ page }) => {
  loginRedirect = null;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/login.html?next=${encodeURIComponent("/developer-notes.html#latest")}`);

  await expect(page.locator("#loginForm")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.locator("#li_username").fill("mobile-qa");
  await page.locator("#li_password").fill("mobile-password");
  await page.locator("#loginForm").evaluate((form) => form.requestSubmit());

  await expect(page).toHaveURL(`${baseUrl}/developer-notes.html#latest`);
  expect(apiRequests).toEqual([
    {
      pathname: "/api/login",
      body: { username: "mobile-qa", password: "mobile-password", remember: true },
    },
  ]);
});

test("login exposes account recovery and reset requests keep a generic response", async ({ page }) => {
  await page.goto(`${baseUrl}/login.html`);
  await expect(page.locator('a[href="/password-reset.html"]')).toHaveText("비밀번호를 잊으셨나요?");
  await page.locator('a[href="/password-reset.html"]').click();
  await page.locator("#resetUsername").fill("qa-admin");
  await page.locator("#requestForm").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#requestStatus")).toContainText("인증된 이메일이 있으면");
  expect(apiRequests).toEqual([
    { pathname: "/api/password-reset/request", body: { username: "qa-admin" } },
  ]);
});

test("password reset never consumes the token before explicit matching-password submit", async ({ page }) => {
  await page.goto(`${baseUrl}/password-reset.html?token=reset-token-123`);
  await expect(page).toHaveURL(`${baseUrl}/password-reset.html`);
  expect(apiRequests).toEqual([]);
  await expect(page.locator("#resetTitle")).toHaveText("새 비밀번호 설정");
  await page.locator("#newPassword").fill("new-password-123");
  await page.locator("#confirmPassword").fill("different-password");
  await page.locator("#confirmForm").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#confirmStatus")).toContainText("일치하지 않습니다");
  expect(apiRequests).toEqual([]);

  await page.locator("#confirmPassword").fill("new-password-123");
  await page.locator("#confirmForm").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#confirmStatus")).toContainText("변경되었습니다");
  expect(apiRequests).toEqual([
    {
      pathname: "/api/password-reset/confirm",
      body: { token: "reset-token-123", newPassword: "new-password-123" },
    },
  ]);
});

test("password recovery preserves a safe return path and confirms success on login", async ({ page }) => {
  const next = "/developer-notes.html#latest";
  await page.goto(`${baseUrl}/login.html?next=${encodeURIComponent(next)}`);
  await expect(page.locator("#passwordResetLink")).toHaveAttribute(
    "href",
    `/password-reset.html?next=${encodeURIComponent(next)}`,
  );
  await page.locator("#passwordResetLink").click();
  await page.locator("#resetUsername").fill("qa-return-user");
  await page.locator("#requestForm").evaluate((form) => form.requestSubmit());
  expect(apiRequests.at(-1)).toEqual({
    pathname: "/api/password-reset/request",
    body: { username: "qa-return-user", next },
  });

  await page.goto(`${baseUrl}/password-reset.html?token=return-token&next=${encodeURIComponent(next)}`);
  await expect(page).toHaveURL(`${baseUrl}/password-reset.html?next=${encodeURIComponent(next)}`);
  await expect(page.locator("[data-login-return]").first()).toHaveAttribute(
    "href",
    `/login.html?next=${encodeURIComponent(next)}`,
  );
  await page.locator("#newPassword").fill("new-password-123");
  await page.locator("#confirmPassword").fill("new-password-123");
  await page.locator("#confirmForm").evaluate((form) => form.requestSubmit());
  await expect(page).toHaveURL(
    `${baseUrl}/login.html?passwordReset=1&next=${encodeURIComponent(next)}`,
    { timeout: 4000 },
  );
  await expect(page.locator("#loginNotice")).toContainText("비밀번호가 변경되었습니다");
});

test("expired reset tokens expose an accessible new-link recovery action", async ({ page }) => {
  await page.goto(`${baseUrl}/password-reset.html?token=expired-token`);
  await page.locator("#newPassword").fill("new-password-123");
  await page.locator("#confirmPassword").fill("new-password-123");
  await page.locator("#confirmForm").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#confirmStatus")).toHaveAttribute("role", "alert");
  await expect(page.locator("#confirmStatus")).toContainText("만료된 재설정 링크");
  await expect(page.locator("#requestAgain")).toBeVisible();
  await expect(page.locator("#requestAgain")).toBeFocused();
});

test("password recovery remains usable without horizontal overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/password-reset.html`);
  await expect(page.locator("#requestForm")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const formBox = await page.locator("#requestForm").boundingBox();
  const submitBox = await page.locator("#requestBtn").boundingBox();
  expect(formBox?.y).toBeLessThan(500);
  expect((submitBox?.y || 0) + (submitBox?.height || 0)).toBeLessThan(844);
});

test("signup preserves validation and exact API payload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/signup.html`);
  await page.locator("#username").fill("qa.student");
  await page.locator("#name").fill("김퀼로");
  await page.locator("#studentId").fill("2402");
  await page.locator("#email").fill("qa@ts.hs.kr");
  await page.locator("#password").fill("password-123");
  await page.locator("#password2").fill("password-123");
  await page.locator("#studentConfirmed").check();
  await page.locator("#age14").check();
  await page.locator("#agree").check();
  await page.screenshot({ path: "/tmp/quilo-auth-signup.png", fullPage: true });
  await page.locator("#form").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#signupCard")).toContainText("계정이 만들어졌습니다");
  expect(apiRequests).toEqual([
    {
      pathname: "/api/signup",
      body: {
        username: "qa.student",
        name: "김퀼로",
        studentId: "2402",
        email: "qa@ts.hs.kr",
        password: "password-123",
        studentConfirmed: true,
        age14Confirmed: true,
        termsAccepted: true,
      },
    },
  ]);
});

test("Quilo organization signup hides student-only fields and sends an employee payload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/signup.html`);
  await page.locator("#email").fill("employee@QuiloLab.com");
  await expect(page.locator("#studentIdField")).toBeHidden();
  await expect(page.locator("#studentId")).not.toHaveAttribute("required", "");
  await expect(page.locator("#studentConfirmedRow")).toBeHidden();
  await expect(page.locator("#studentConfirmed")).not.toHaveAttribute("required", "");
  await expect(page.locator("#emailHelp")).toContainText("스탭 권한");

  await page.locator("#username").fill("qa.employee");
  await page.locator("#name").fill("퀼로직원");
  await page.locator("#password").fill("password-123");
  await page.locator("#password2").fill("password-123");
  await page.locator("#age14").check();
  await page.locator("#agree").check();
  await page.screenshot({ path: "/tmp/quilo-auth-staff-signup.png", fullPage: true });
  await page.locator("#form").evaluate((form) => form.requestSubmit());

  await expect(page.locator("#signupCard")).toContainText("스탭 권한이 자동으로 활성화됩니다");
  expect(apiRequests).toEqual([
    {
      pathname: "/api/signup",
      body: {
        username: "qa.employee",
        name: "퀼로직원",
        studentId: "",
        email: "employee@QuiloLab.com",
        password: "password-123",
        studentConfirmed: false,
        age14Confirmed: true,
        termsAccepted: true,
      },
    },
  ]);
});

test("Quilo organization signup remains usable on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/signup.html`);
  await page.locator("#email").fill("mobile@quilolab.com");
  await expect(page.locator("#studentIdField")).toBeHidden();
  await expect(page.locator("#studentConfirmedRow")).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "/tmp/quilo-auth-staff-signup-mobile.png", fullPage: true });
});

test("email verification never consumes the token before explicit click", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/verify-email.html?token=token-123`);
  expect(apiRequests).toEqual([]);
  await expect(page.locator("#confirmBtn")).toBeEnabled();
  await page.screenshot({ path: "/tmp/quilo-auth-verify.png", fullPage: true });
  await page.locator("#confirmBtn").click();
  await expect(page.locator("#result")).toHaveClass(/is-success/);
  expect(apiRequests).toEqual([
    { pathname: "/api/verify-email/confirm", body: { token: "token-123" } },
  ]);
});

test("Quilo organization verification explains the activated staff role", async ({ page }) => {
  await page.goto(`${baseUrl}/verify-email.html?token=staff-token`);
  await page.locator("#confirmBtn").click();
  await expect(page.locator("#lead")).toContainText("스탭 권한 활성화");
  await expect(page.locator("#result")).toContainText("스탭 기능");
  expect(apiRequests).toEqual([
    { pathname: "/api/verify-email/confirm", body: { token: "staff-token" } },
  ]);
});

test("email verification disables confirmation when token is missing", async ({ page }) => {
  await page.goto(`${baseUrl}/verify-email.html`);
  await expect(page.locator("#confirmBtn")).toBeDisabled();
  await expect(page.locator("#result")).toHaveClass(/is-error/);
  expect(apiRequests).toEqual([]);
});
