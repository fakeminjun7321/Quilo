const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFileSync } = require("child_process");

function loadPlaywrightTest() {
  try {
    return require("@playwright/test");
  } catch (error) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const cacheKey = Object.keys(require.cache).find(
      (key) =>
        key.includes(`${marker}@playwright${path.sep}test${path.sep}`)
        || key.includes(`${marker}playwright${path.sep}`),
    );
    if (!cacheKey) throw error;
    const root = cacheKey.slice(0, cacheKey.indexOf(marker) + marker.length);
    return require(path.join(root, "@playwright", "test"));
  }
}

const { test, expect } = loadPlaywrightTest();
const CLASSBOT_DIR = path.join(process.cwd(), "apps", "classbot");
const DIST_DIR = path.join(CLASSBOT_DIR, "dist");
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

let server;
let baseUrl;
let bound;
let receivedLoginBody;

function json(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function staticFile(pathname) {
  const relative = pathname.replace(/^\/schedule\/?/, "") || "index.html";
  const target = path.resolve(DIST_DIR, relative);
  if (target !== DIST_DIR && !target.startsWith(`${DIST_DIR}${path.sep}`)) return null;
  return target;
}

test.beforeAll(async () => {
  execFileSync("npm", ["run", "build"], {
    cwd: CLASSBOT_DIR,
    encoding: "utf8",
    stdio: "pipe",
  });

  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/schedule/api/admin/session") {
      return json(response, 200, { authenticated: false });
    }
    if (url.pathname === "/schedule/api/portal/session") {
      return json(response, 200, bound
        ? { authenticated: true, member: { id: "member-1", display_name: "홍길동", role: "student" } }
        : { authenticated: false, reason: "invite_required", login_url: "/login.html?next=/schedule/" });
    }
    if (url.pathname === "/schedule/api/portal/login" && request.method === "POST") {
      receivedLoginBody = await readJson(request);
      if (
        receivedLoginBody.invite_code === "ABCD-EFGH"
        && !Object.prototype.hasOwnProperty.call(receivedLoginBody, "display_name")
      ) {
        bound = true;
        return json(response, 200, {
          authenticated: true,
          member: { id: "member-1", display_name: "홍길동", role: "student" },
        });
      }
      return json(response, 401, { error: "이름 또는 초대 코드가 올바르지 않습니다." });
    }
    if (url.pathname === "/schedule/api/portal/overview") {
      return json(response, bound ? 200 : 401, bound ? {
        member: { id: "member-1", display_name: "홍길동", role: "student" },
        classroom: { id: "class-1", name: "2학년 4반", max_members: 16 },
        members: [{ id: "member-1", display_name: "홍길동", role: "student" }],
        timetable: [],
        events: [],
        notices: [],
      } : { error: "학생 포털 로그인이 필요합니다." });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405);
      return response.end();
    }
    const file = staticFile(url.pathname);
    if (!file) {
      response.writeHead(403);
      return response.end();
    }
    fs.readFile(file, (error, body) => {
      if (error) {
        response.writeHead(error.code === "ENOENT" ? 404 : 500);
        response.end();
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": CONTENT_TYPES[path.extname(file)] || "application/octet-stream",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => {
  bound = false;
  receivedLoginBody = null;
});

test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("embedded student portal binds a logged-in Quilo account with an invite code, not a display name", async ({ page }) => {
  await page.goto(`${baseUrl}/schedule/`);

  await expect(page.getByRole("heading", { name: "학급 초대 코드 입력" })).toBeVisible();
  await expect(page.getByLabel("이름")).toHaveCount(0);
  await page.getByLabel("초대 코드").fill("ABCD-EFGH");
  await page.getByRole("button", { name: /내 계정 연결/ }).click();

  await expect(page.getByRole("heading", { name: "오늘 시간표" })).toBeVisible();
  expect(receivedLoginBody).toEqual({ invite_code: "ABCD-EFGH" });
});
