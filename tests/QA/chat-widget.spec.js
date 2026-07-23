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

const publicDir = path.join(process.cwd(), "public");

function publicFile(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  const relative = pathname.replace(/^\/+/, "");
  const file = path.resolve(publicDir, relative);
  if (!file.startsWith(`${publicDir}${path.sep}`)) return null;
  return file;
}

let server;
let baseUrl;

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const file = publicFile(request.url || "/");
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const contentType = file.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8";
      response.writeHead(200, { "Content-Type": contentType });
      response.end(fs.readFileSync(file));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><html><head><title>Quilo QA</title></head><body><main><div id="quiloBotMount"></div></main><script src="/chat-widget.js"></script></body></html>',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function installChatFixtures(page) {
  let chatRequests = 0;
  await page.route("**/api/chat/status", (route) =>
    route.fulfill({ json: { enabled: true } }),
  );
  await page.route("**/api/write-assist/models", (route) =>
    route.fulfill({ json: { enabled: false, loggedIn: false, models: [] } }),
  );
  await page.route("**/api/chat", (route) => {
    chatRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: "업로드한 자료를 바탕으로 분석을 도와드릴게요.",
    });
  });
  await page.route("**/api/chat/feedback", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  return () => chatRequests;
}

test("inline chat becomes one compact conversation surface after the first message", async ({ page }) => {
  const getChatRequests = await installChatFixtures(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(baseUrl);

  await expect(page.locator('link[data-quilo-chat-css][href="/ui/chat.css"]')).toHaveCount(1);
  await expect(page.locator("style")).toHaveCount(0);

  const panel = page.locator("#qc-panel");
  await expect(panel).toHaveClass(/qc-idle/);
  await page.locator("#qc-in").fill("안녕");
  await page.locator("#qc-send").click();

  await expect(panel).not.toHaveClass(/qc-idle/);
  await expect(page.locator(".qc-row.me .qc-b")).toHaveText("안녕");
  await expect(page.locator(".qc-row.ai .qc-b")).toHaveText(/자료를 바탕으로 분석/);
  expect(getChatRequests()).toBe(1);

  const geometry = await page.evaluate(() => ({
    panel: document.querySelector("#qc-panel").getBoundingClientRect().height,
    messages: document.querySelector("#qc-msgs").getBoundingClientRect().height,
    composer: document.querySelector("#qc-inrow").getBoundingClientRect().height,
  }));
  expect(geometry.panel).toBeLessThan(360);
  expect(geometry.messages).toBeLessThan(250);
  expect(geometry.composer).toBeLessThan(80);

  const actions = page.locator(".qc-bar button");
  await expect(actions).toHaveCount(4);
  await expect(actions.nth(0)).toHaveAttribute("aria-label", "도움이 됐어요");
  await expect(actions.nth(2)).toHaveAttribute("aria-label", "다시 시도");
  await expect(actions.nth(3)).toHaveAttribute("aria-label", "의견 보내기");
  await expect(actions.nth(0)).toHaveCSS("border-top-width", "0px");
});

test("home inline chat has no duplicate legacy floating launcher", async ({ page }) => {
  await installChatFixtures(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(baseUrl);

  const panel = page.locator("#qc-panel");
  await expect(panel).toHaveClass(/qc-inline/);
  await expect(panel).toHaveClass(/qc-idle/);
  await expect(panel).toHaveClass(/open/);
  expect(await panel.evaluate((node) => node.parentElement.id)).toBe("quiloBotMount");

  await expect(page.locator("#qc-panel")).toHaveCount(1);
  await expect(page.locator("#qc-launch")).toHaveCount(0);
  await expect(page.locator('link[data-quilo-chat-css]')).toHaveCount(1);
  await expect(page.locator("#qc-in")).toHaveAttribute("placeholder", "실험 자료를 분석해줘");
});

test("Korean IME Enter confirms composition without sending or leaving a syllable behind", async ({ page }) => {
  const getChatRequests = await installChatFixtures(page);
  await page.goto(baseUrl);
  await expect(page.locator("#qc-in")).toBeVisible();

  await page.evaluate(() => {
    const input = document.querySelector("#qc-in");
    input.focus();
    input.dispatchEvent(
      new CompositionEvent("compositionstart", {
        bubbles: true,
        data: "안녕",
      }),
    );
    input.value = "안녕";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const enterDuringComposition = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Enter",
      key: "Enter",
    });
    Object.defineProperty(enterDuringComposition, "isComposing", {
      value: true,
    });
    Object.defineProperty(enterDuringComposition, "keyCode", { value: 229 });
    input.dispatchEvent(enterDuringComposition);
    input.dispatchEvent(
      new CompositionEvent("compositionend", {
        bubbles: true,
        data: "안녕",
      }),
    );
  });

  await expect(page.locator("#qc-in")).toHaveValue("안녕");
  await expect(page.locator(".qc-row.me")).toHaveCount(0);
  expect(getChatRequests()).toBe(0);

  await page.locator("#qc-in").press("Enter");
  await expect(page.locator(".qc-row.me .qc-b")).toHaveText("안녕");
  await expect(page.locator("#qc-in")).toHaveValue("");
  expect(getChatRequests()).toBe(1);
});

test("Korean voice recognition fills the composer without submitting", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeRecognition {
      constructor() {
        window.__recognition = this;
      }
      start() {
        if (this.onstart) this.onstart();
      }
      stop() {
        if (this.onend) this.onend();
      }
    }
    window.SpeechRecognition = FakeRecognition;
  });
  const getChatRequests = await installChatFixtures(page);
  await page.goto(baseUrl);

  const mic = page.locator("#qc-mic");
  await expect(mic).toBeEnabled();
  await mic.click();
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#qc-voice-status")).toHaveText("듣고 있어요. 말씀해 주세요.");

  await page.evaluate(() => {
    window.__recognition.onresult({
      results: [[{ transcript: "실험 결과를 분석해 줘" }]],
    });
    window.__recognition.onend();
  });

  await expect(page.locator("#qc-in")).toHaveValue("실험 결과를 분석해 줘");
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#qc-voice-status")).toHaveText(
    "음성이 입력되었습니다. 내용을 확인한 뒤 전송하세요.",
  );
  await expect(page.locator(".qc-row.me")).toHaveCount(0);
  expect(getChatRequests()).toBe(0);
  expect(await page.evaluate(() => window.__recognition.lang)).toBe("ko-KR");
});

test("unsupported voice recognition is clearly disabled", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(window, "SpeechRecognition", { value: undefined, configurable: true });
      Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined, configurable: true });
    } catch (_) {}
  });
  await installChatFixtures(page);
  await page.goto(baseUrl);

  const mic = page.locator("#qc-mic");
  await expect(mic).toBeDisabled();
  await expect(mic).toHaveAttribute(
    "title",
    "이 브라우저에서는 음성 입력을 지원하지 않습니다.",
  );
});
