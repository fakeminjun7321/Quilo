const path = require("path");
const { startQaServer } = require("./helpers/qa-server");

function loadPlaywrightTest() {
  try { return require("@playwright/test"); }
  catch (error) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const cacheKey = Object.keys(require.cache).find((key) =>
      key.includes(`${marker}@playwright${path.sep}test${path.sep}`) || key.includes(`${marker}playwright${path.sep}`));
    if (!cacheKey) throw error;
    const root = cacheKey.slice(0, cacheKey.indexOf(marker) + marker.length);
    return require(path.join(root, "@playwright", "test"));
  }
}
const { test, expect } = loadPlaywrightTest();

let qaServer = null;
let BASE_URL = "";

async function mockAccountApis(page, options = {}) {
  const calls = options.calls || [];
  const role = options.role || "admin";
  const isAdmin = role === "admin";
  const isMax = role === "max";
  const isPro = role === "pro";
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      calls.push({ pathname, method: request.method(), body: request.postDataJSON?.() || null });
    }
    if (pathname === "/api/me") return route.fulfill({ json: { user: "구민준", studentId: "2402", isAdmin, styleNote: "", blockedReportTypes: options.blockedReportTypes || [], analyticsConsent: false, analyticsConsentVersion: "2026-07-15" } });
    if (pathname === "/api/me/balance") {
      options.onBalance?.();
      const payload = {
        credits: isAdmin ? 100000 : 24,
        unlimited: isAdmin,
        isAdmin,
        restrictedModel: options.restrictedModel || null,
      };
      if (Object.prototype.hasOwnProperty.call(options, "modelProviders")) {
        payload.modelProviders = typeof options.modelProviders === "function"
          ? options.modelProviders()
          : options.modelProviders;
      }
      return route.fulfill({ json: payload });
    }
    if (pathname === "/api/me/beta") return route.fulfill({
      json: options.tierError ? null : {
        admin: isAdmin,
        tier: role,
        features: options.features || (isAdmin || isMax || isPro ? ["code-editor", "create"] : []),
      },
      status: options.tierError ? 500 : 200,
    });
    if (pathname === "/api/subscriptions/me") return route.fulfill({
      json: options.tierError ? null : { active: isAdmin || isMax, admin: isAdmin },
      status: options.tierError ? 500 : 200,
    });
    if (pathname === "/api/me/api-keys" && request.method() === "GET") {
      if (options.keyError) return route.fulfill({ status: 500, json: { error: "연결 상태 오류" } });
      return route.fulfill({ json: { keys: [{ provider: "openai", hint: "8K3x" }] } });
    }
    if (pathname === "/api/me/usage") {
      return route.fulfill({ json: {
        isAdmin,
        credits: isAdmin ? 100000 : 24,
        genCount: options.emptyUsage ? 0 : 2,
        genLimit: 5,
        recent: options.emptyUsage ? [] : [
          { date: "2026-07-11T14:32:00.000Z", label: "문서 요약 생성", model: "Claude Sonnet", credits: 2 },
          { date: "2026-07-11T11:08:00.000Z", label: "보고서 초안 작성", model: "GPT-5.4", credits: 1 },
        ],
      } });
    }
    if (pathname === "/api/me/profile" && request.method() === "PATCH") return route.fulfill({ json: { studentId: request.postDataJSON().studentId } });
    if (pathname === "/api/me/analytics-consent" && request.method() === "PATCH") {
      return route.fulfill({ json: { ok: true, granted: !!request.postDataJSON().granted, version: "2026-07-15" } });
    }
    if (pathname === "/api/me/password" && request.method() === "POST") return route.fulfill({ json: { ok: true } });
    if (pathname === "/api/me/api-keys" && request.method() === "POST") {
      options.onKeyMutation?.("save", request.postDataJSON()?.provider);
      return route.fulfill({ json: { ok: true } });
    }
    if (pathname.startsWith("/api/me/api-keys/") && request.method() === "DELETE") {
      options.onKeyMutation?.("delete", pathname.split("/").pop());
      return route.fulfill({ json: { ok: true } });
    }
    if (pathname === "/api/announcements") return route.fulfill({ json: { announcements: [] } });
    if (pathname === "/api/me/files") return route.fulfill({ json: { storage: true, files: [] } });
    if (pathname === "/api/cloud/providers/status") return route.fulfill({ json: { integrations: {} } });
    if (pathname === "/api/cloud/dropbox/status") return route.fulfill({ json: { enabled: false } });
    if (pathname === "/api/chat/status") return route.fulfill({ json: { enabled: false } });
    return route.fulfill({ json: {} });
  });
}

test.beforeAll(async () => {
  qaServer = await startQaServer();
  BASE_URL = qaServer.baseUrl;
});

test.afterAll(async () => { if (qaServer) await qaServer.stop(); });

test("account center uses continuous sections and preserves account contracts", async ({ page }) => {
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await mockAccountApis(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${BASE_URL}/#settings`, { waitUntil: "networkidle" });

  await expect(page.locator("#settingsPanel")).toBeVisible();
  await expect(page.locator("#settingsPanel .settings-card")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Account Center" })).toBeVisible();
  await expect(page.locator(".account-local-nav a")).toHaveCount(6);
  await expect(page.locator("#settingsUserName")).toHaveText("구민준");
  await expect(page.locator("#settingsStudentId")).toHaveText("2402");
  await expect(page.locator("#settingsUserRole")).toHaveText("관리자");
  await expect(page.locator("#tierStatus")).toContainText("Admin");
  await expect(page.locator("#usageCredits")).toHaveText("무제한");
  await expect(page.locator("#usageGen")).toHaveText("2회");
  await expect(page.locator("#usageGenLabel")).toHaveText("이번 시간 · 제한 없음");
  await expect(page.locator("#usageMeter")).toBeHidden();
  await expect(page.locator("#usageRecent th")).toHaveText(["날짜", "작업", "모델", "크레딧"]);
  await expect(page.locator("#usageRecent tbody tr")).toHaveCount(2);
  await expect(page.locator("#byokOpenaiStatus")).toContainText("등록됨");
  await expect(page.locator("#byokAnthropicStatus")).toHaveText("미등록");
  await expect(page.locator('#settingsPanel [data-action="open-quilo-assist"]')).toHaveCount(0);

  const metrics = await page.evaluate(() => {
    const panel = document.getElementById("settingsPanel");
    const nav = panel.querySelector(".account-local-nav");
    const section = panel.querySelector(".account-section");
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      columns: getComputedStyle(panel.querySelector(".account-center-shell")).gridTemplateColumns,
      navWidth: nav.getBoundingClientRect().width,
      sectionRadius: getComputedStyle(section).borderRadius,
      workspaceHead: getComputedStyle(document.querySelector(".workspace-page-head")).display,
    };
  });
  expect(metrics.overflow).toBe(0);
  expect(metrics.columns).not.toBe("none");
  expect(metrics.navWidth).toBeLessThan(190);
  expect(metrics.sectionRadius).toBe("0px");
  expect(metrics.workspaceHead).toBe("none");
  expect(consoleErrors).toEqual([]);
  if (process.env.ACCOUNT_QA_SCREEN) {
    await page.screenshot({ path: process.env.ACCOUNT_QA_SCREEN, fullPage: false });
  }
});

test("mobile account center opens from a report and back restores the report route", async ({ page }) => {
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await mockAccountApis(page, { role: "max" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/?report=chem-pre`, { waitUntil: "networkidle" });
  await expect(page.locator('input[name="reportType"][value="chem-pre"]')).toBeChecked();

  await page.locator("[data-ui-mobile-trigger]").click();
  await page.locator("#uiMobilePanel [data-ui-auth-action]").click();
  await expect(page).toHaveURL(`${BASE_URL}/#settings`);
  await expect(page.locator("#settingsPanel")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account Center" })).toBeVisible();
  await expect(page.locator("#settingsUserName")).toHaveText("구민준");
  const accountMetrics = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    display: getComputedStyle(document.querySelector(".account-center-shell")).display,
    navOverflow: document.querySelector(".account-local-nav").scrollWidth - document.querySelector(".account-local-nav").clientWidth,
  }));
  expect(accountMetrics.overflow).toBeLessThanOrEqual(1);
  expect(accountMetrics.display).toBe("block");
  expect(accountMetrics.navOverflow).toBeGreaterThanOrEqual(0);

  await page.goBack({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(`${BASE_URL}/?report=chem-pre`);
  await expect(page.locator('input[name="reportType"][value="chem-pre"]')).toBeChecked();
  expect(consoleErrors).toEqual([]);
});

test("account center keeps profile, preferences, BYOK and password actions working", async ({ page }) => {
  const calls = [];
  await mockAccountApis(page, { calls });
  await page.goto(`${BASE_URL}/#settings`, { waitUntil: "networkidle" });

  await page.locator("#settingsProfileCard > summary").click();
  await page.locator("#settingsStudentIdInput").fill("2501");
  await page.locator("#profileBtn").click();
  await expect(page.locator("#profileStatus")).toHaveText("저장 완료");
  await expect(page.locator("#settingsStudentId")).toHaveText("2501");

  await page.locator("#prefModelSel").selectOption("gpt-5.4-mini");
  await expect(page.locator("#prefSaveStatus")).toHaveText("기본 모델 저장됨");
  expect(await page.evaluate(() => localStorage.getItem("prefModel"))).toBe("gpt-5.4-mini");

  await page.locator('[data-provider="anthropic"] > summary').click();
  await page.locator("#byokAnthropicInput").fill("sk-ant-test-account-center");
  await page.locator("#byokSaveAnthropic").click();
  await expect(page.locator("#byokMsg")).toContainText("등록했습니다");

  await page.locator("#currentPw").fill("old-password");
  await page.locator("#newPw").fill("new-password");
  await page.locator("#confirmPw").fill("new-password");
  await page.locator("#pwBtn").click();
  await expect(page.locator("#pwStatus")).toHaveText("변경 완료");

  await page.locator("#analyticsConsentToggle").check();
  await expect(page.locator("#analyticsConsentStatus")).toContainText("동의했습니다");

  expect(calls.some((call) => call.pathname === "/api/me/profile" && call.body.studentId === "2501")).toBeTruthy();
  expect(calls.some((call) => call.pathname === "/api/me/api-keys" && call.body.provider === "anthropic")).toBeTruthy();
  expect(calls.some((call) => call.pathname === "/api/me/password" && call.body.newPassword === "new-password")).toBeTruthy();
  expect(calls.some((call) => call.pathname === "/api/me/analytics-consent" && call.body.granted === true)).toBeTruthy();
});

test("account center exposes empty and error states without blank cards", async ({ page }) => {
  await mockAccountApis(page, { emptyUsage: true, keyError: true, tierError: true });
  await page.goto(`${BASE_URL}/#settings`, { waitUntil: "networkidle" });

  await expect(page.locator("#usageRecent")).toHaveAttribute("data-state", "empty");
  await expect(page.locator("#usageRecent")).toContainText("최근 생성 기록이 없습니다");
  await expect(page.locator("#byokStatus")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#byokStatus")).toContainText("연결 상태 오류");
  await expect(page.locator("#tierStatus")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#tierStatus")).toHaveText("확인할 수 없음");
});

async function reportModelState(page) {
  return page.evaluate(() => {
    const selector = 'input[type="radio"][name="model"], input[type="radio"][name$="Model"]';
    const groups = {};
    document.querySelectorAll(selector).forEach((radio) => {
      const label = radio.closest("label");
      (groups[radio.name] ||= []).push({
        value: radio.value,
        visible: !label?.hidden,
        disabled: radio.disabled,
        checked: radio.checked,
        providerAvailability: label?.dataset.modelProviderAvailability || "",
        title: label?.title || "",
        describedBy: radio.getAttribute("aria-describedby") || "",
        unavailableNote: label?.querySelector('[data-model-provider-note="true"]')?.textContent || "",
      });
    });
    return groups;
  });
}

const REPORT_MODEL_GROUPS = [
  "model", "crModel", "prModel", "rlModel", "psModel",
  "vbModel", "fmModel", "capModel", "frModel",
];

test("a comma-separated model restriction keeps every allowed model selectable in every report", async ({ page }) => {
  await mockAccountApis(page, { role: "free", restrictedModel: "gpt-5.4-mini, claude-sonnet-5" });
  await page.goto(`${BASE_URL}/#settings`, { waitUntil: "networkidle" });

  const state = await reportModelState(page);
  expect(Object.keys(state).sort()).toEqual([...REPORT_MODEL_GROUPS].sort());
  for (const name of REPORT_MODEL_GROUPS) {
    const visible = state[name].filter((model) => model.visible);
    expect(visible.map((model) => model.value).sort(), name).toEqual(["claude-sonnet-5", "gpt-5.4-mini"]);
    expect(visible.every((model) => !model.disabled), name).toBeTruthy();
    expect(visible.filter((model) => model.checked), name).toHaveLength(1);
  }
  expect(await page.locator('input[name="reportType"][value="chem-pre"]').evaluate((radio) => !radio.closest("label")?.hidden)).toBeTruthy();
  expect(await page.locator('input[name="reportType"][value="free"]').evaluate((radio) => !radio.closest("label")?.hidden)).toBeTruthy();
});

test("a single model restriction selects only that model in every report", async ({ page }) => {
  await mockAccountApis(page, { role: "free", restrictedModel: "gpt-5.4-mini" });
  await page.goto(`${BASE_URL}/#settings`, { waitUntil: "networkidle" });

  const state = await reportModelState(page);
  for (const name of REPORT_MODEL_GROUPS) {
    const visible = state[name].filter((model) => model.visible);
    expect(visible.map((model) => model.value), name).toEqual(["gpt-5.4-mini"]);
    expect(visible[0].disabled, name).toBeFalsy();
    expect(visible[0].checked, name).toBeTruthy();
  }
});

test("accounts without a model restriction keep the normal model choices", async ({ page }) => {
  await mockAccountApis(page, { role: "free" });
  await page.goto(`${BASE_URL}/#settings`, { waitUntil: "networkidle" });

  const state = await reportModelState(page);
  for (const name of REPORT_MODEL_GROUPS) {
    const visible = state[name].filter((model) => model.visible);
    expect(visible.map((model) => model.value).sort(), name).toEqual([
      "claude-opus-4-8", "claude-sonnet-5", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini",
    ].sort());
    expect(visible.every((model) => !model.disabled), name).toBeTruthy();
    expect(visible.filter((model) => model.checked), name).toHaveLength(1);
  }
});

test("provider availability disables unavailable models and keeps BYOK-backed models selectable", async ({ page }) => {
  await mockAccountApis(page, {
    role: "free",
    modelProviders: { anthropic: false, openai: true, gemini: false },
  });
  await page.goto(`${BASE_URL}/#settings`, { waitUntil: "networkidle" });

  const state = await reportModelState(page);
  for (const name of REPORT_MODEL_GROUPS) {
    const visible = state[name].filter((model) => model.visible);
    const claude = visible.filter((model) => model.value.startsWith("claude-"));
    const gpt = visible.filter((model) => model.value.startsWith("gpt-"));
    expect(claude.every((model) => model.disabled), `${name}: Claude disabled`).toBeTruthy();
    expect(claude.every((model) => model.providerAvailability === "unavailable"), `${name}: unavailable state`).toBeTruthy();
    expect(claude.every((model) => /Anthropic 연결이 없어/.test(model.title)), `${name}: clear title`).toBeTruthy();
    expect(claude.every((model) => /Anthropic 연결 필요/.test(model.unavailableNote)), `${name}: accessible copy`).toBeTruthy();
    expect(claude.every((model) => model.describedBy.includes("model-provider-note-")), `${name}: described by`).toBeTruthy();
    expect(gpt.every((model) => !model.disabled), `${name}: BYOK-backed GPT enabled`).toBeTruthy();
    expect(visible.filter((model) => model.checked)).toHaveLength(1);
    expect(visible.find((model) => model.checked)?.value, `${name}: unavailable default cleared`).toMatch(/^gpt-/);
  }
});

test("a restriction that only allows an unavailable provider blocks submission instead of falling through to 503", async ({ page }) => {
  await mockAccountApis(page, {
    role: "free",
    restrictedModel: "claude-opus-4-8",
    modelProviders: { anthropic: false, openai: true, gemini: false },
  });
  await page.goto(`${BASE_URL}/#settings`, { waitUntil: "networkidle" });

  const opus = page.locator('input[name="model"][value="claude-opus-4-8"]');
  await expect(opus).toBeDisabled();
  await expect(opus).not.toBeChecked();
  await expect(page.locator("#btn")).toBeDisabled();
  await expect(page.locator("#btn")).toHaveAttribute(
    "title",
    "현재 연결된 AI 제공자가 없습니다. 모델 연결 상태를 확인해 주세요.",
  );
  await expect(page.locator('input[name="model"][value="gpt-5.4"]')).toBeHidden();
});

test("missing provider availability preserves the existing model behavior", async ({ page }) => {
  await mockAccountApis(page, { role: "free" });
  await page.goto(`${BASE_URL}/#settings`, { waitUntil: "networkidle" });

  const state = await reportModelState(page);
  for (const name of REPORT_MODEL_GROUPS) {
    const visible = state[name].filter((model) => model.visible);
    expect(visible.every((model) => !model.disabled), name).toBeTruthy();
    expect(visible.every((model) => model.providerAvailability === ""), name).toBeTruthy();
    expect(visible.every((model) => model.unavailableNote === ""), name).toBeTruthy();
  }
});

test("saving and deleting BYOK refreshes report model availability", async ({ page }) => {
  const providers = { anthropic: false, openai: true, gemini: false };
  let balanceReads = 0;
  await mockAccountApis(page, {
    role: "free",
    modelProviders: () => ({ ...providers }),
    onBalance: () => { balanceReads += 1; },
    onKeyMutation: (action, provider) => {
      if (provider === "anthropic" && action === "save") providers.anthropic = true;
      if (provider === "openai" && action === "delete") providers.openai = false;
    },
  });
  await page.goto(`${BASE_URL}/#settings`, { waitUntil: "networkidle" });

  const anthropic = page.locator('input[name="model"][value="claude-opus-4-8"]');
  const openai = page.locator('input[name="model"][value="gpt-5.4"]');
  await expect(anthropic).toBeDisabled();
  await expect(openai).toBeEnabled();

  await page.locator('[data-provider="anthropic"] > summary').click();
  await page.locator("#byokAnthropicInput").fill("sk-ant-test-account-center-refresh");
  await page.locator("#byokSaveAnthropic").click();
  await expect(anthropic).toBeEnabled();
  await expect.poll(() => balanceReads).toBeGreaterThanOrEqual(2);

  await page.locator('[data-provider="openai"] > summary').click();
  await page.locator("#byokDelOpenai").click();
  await expect(openai).toBeDisabled();
  await expect.poll(() => balanceReads).toBeGreaterThanOrEqual(3);
});

test("an administrator still receives the configured model restriction", async ({ page }) => {
  await mockAccountApis(page, { role: "admin", restrictedModel: "gpt-5.4-mini" });
  await page.goto(`${BASE_URL}/#settings`, { waitUntil: "networkidle" });

  const state = await reportModelState(page);
  for (const name of REPORT_MODEL_GROUPS) {
    const visible = state[name].filter((model) => model.visible);
    expect(visible.map((model) => model.value), name).toEqual(["gpt-5.4-mini"]);
    expect(visible[0].disabled, name).toBeFalsy();
    expect(visible[0].checked, name).toBeTruthy();
  }
});

test("the saved default model applies to all report model groups", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("prefModel", "gpt-5.4"));
  await mockAccountApis(page, { role: "free" });
  await page.goto(`${BASE_URL}/#settings`, { waitUntil: "networkidle" });

  const state = await reportModelState(page);
  for (const name of REPORT_MODEL_GROUPS) {
    expect(state[name].find((model) => model.checked)?.value, name).toBe("gpt-5.4");
  }
});

test("Gemini choices and confirmation metadata remain administrator-only", async ({ page }) => {
  await mockAccountApis(page, { role: "admin" });
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  for (const name of ["model", "crModel", "prModel", "frModel"]) {
    expect(
      await page.locator(`input[name="${name}"][value="gemini-3.1-pro"]`).evaluate(
        (radio) => !radio.closest("label")?.hidden,
      ),
      name,
    ).toBeTruthy();
  }
  const contract = await page.evaluate(async () => {
    const helpers = await import("/workspace/report-helpers.js");
    return {
      label: helpers.getModelLabel("gemini-3.1-pro"),
      credits: helpers.getModelCredits("gemini-3.1-pro"),
    };
  });
  expect(contract).toEqual({ label: "Gemini 3.1 Pro", credits: 2 });

  await page.locator('[data-ui-menu-trigger="0"]').click();
  await page.locator('#uiSiteMega a[data-report="chem-pre"]').click();
  await expect(page.locator('[data-report-form="chem-pre"]')).toBeVisible();
  await page.locator('input[name="model"][value="gemini-3.1-pro"]').check();
  await page.setInputFiles("#manual", {
    name: "manual.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\nqa\n%%EOF"),
  });
  await page.locator("#form").dispatchEvent("submit");
  await expect(page.locator(".confirm-card")).toContainText("Gemini 3.1 Pro");
  await page.locator(".confirm-card button.secondary").click();
});

test("report access keeps initial, entitlement, retired, blocked and admin-only visibility separate", async ({ page }) => {
  await mockAccountApis(page, {
    role: "pro",
    features: ["form-maker"],
    blockedReportTypes: ["chem-result", "form-maker"],
  });
  await page.goto(`${BASE_URL}/#settings`, { waitUntil: "networkidle" });

  const labelHidden = (value) =>
    page.locator(`input[name="reportType"][value="${value}"]`).evaluate(
      (radio) => !!radio.closest("label")?.hidden,
    );

  await expect.poll(() => labelHidden("chem-pre")).toBe(false);
  await expect.poll(() => labelHidden("chem-result")).toBe(true);
  await expect.poll(() => labelHidden("form-maker")).toBe(true);
  await expect(page.locator('input[name="reportType"][value="phys-inquiry"]')).toHaveCount(0);
  await expect.poll(() => labelHidden("print-pdf-restore")).toBe(true);
});

test("an allowed Pro entitlement can reveal its initially hidden report label", async ({ page }) => {
  await mockAccountApis(page, { role: "pro", features: ["form-maker"] });
  await page.goto(`${BASE_URL}/#settings`, { waitUntil: "networkidle" });

  await expect.poll(() =>
    page.locator('input[name="reportType"][value="form-maker"]').evaluate(
      (radio) => !!radio.closest("label")?.hidden,
    )
  ).toBe(false);
});

for (const [role, label] of [["free", "Free"], ["pro", "Pro"], ["max", "Max"], ["admin", "Admin"]]) {
  test(`${role} role renders one consistent account and navigation state`, async ({ page }) => {
    await mockAccountApis(page, { role });
    await page.goto(`${BASE_URL}/#settings`, { waitUntil: "networkidle" });

    await expect(page.locator("body")).toHaveAttribute("data-auth", "in");
    await expect(page.locator("#tierStatus")).toHaveAttribute("data-tier", role);
    await expect(page.locator("#tierStatus")).toContainText(label);
    await expect(page.locator("#accountTriggerMeta")).toHaveText(label);
    await expect(page.locator("#settingsPanel .settings-card")).toHaveCount(0);
    await expect(page.locator("#qc-launch")).toHaveCount(0);
    if (role === "admin") await expect(page.locator("#adminLink")).not.toHaveAttribute("hidden", "");
    else await expect(page.locator("#adminLink")).toHaveAttribute("hidden", "");
    await expect(page.locator("#navBetaEditor, #navBetaTranslate")).toHaveCount(0);
    await page.locator('[data-ui-menu-trigger="3"]').click();
    await expect(page.locator('#uiSiteMega a[href="/translate.html"] strong').filter({ hasText: "PDF 통번역" })).toHaveCount(1);
  });
}
