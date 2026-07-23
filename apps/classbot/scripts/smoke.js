const input = process.argv[2] || process.env.CLASSBOT_BASE_URL;
if (!input) {
  console.error("Usage: node scripts/smoke.js https://your-quilo-schedule.example");
  process.exit(2);
}

const baseUrl = new URL(input);
if (baseUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(baseUrl.hostname)) {
  console.error("Smoke target must use HTTPS unless it is localhost.");
  process.exit(2);
}

const currentPath = baseUrl.pathname.replace(/\/$/, "");
const schedulePath = currentPath.endsWith("/schedule") ? currentPath : `${currentPath}/schedule`;

async function request(path, options = {}) {
  const suffix = path === "/" ? "/" : path;
  const response = await fetch(new URL(`${schedulePath}${suffix}`, baseUrl.origin), {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    ...options,
  });
  return { response, text: await response.text() };
}

function expectStatus(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected HTTP ${expected}, received ${actual}`);
}

try {
  const health = await request("/api/health");
  expectStatus(health.response.status, 200, "health");
  const healthBody = JSON.parse(health.text);
  if (healthBody.ok !== true) throw new Error("health: response did not report ok=true");
  if (process.env.CLASSBOT_EXPECT_STORAGE && healthBody.storage !== process.env.CLASSBOT_EXPECT_STORAGE) {
    throw new Error(`health: expected storage ${process.env.CLASSBOT_EXPECT_STORAGE}, received ${healthBody.storage}`);
  }

  const page = await request("/");
  expectStatus(page.response.status, 200, "admin page");
  if (!page.text.includes("Quilo")) throw new Error("admin page: Quilo marker is missing");

  const session = await request("/api/admin/session");
  expectStatus(session.response.status, 200, "anonymous session");
  if (JSON.parse(session.text).authenticated !== false) throw new Error("anonymous session: unexpectedly authenticated");

  const protectedOverview = await request("/api/admin/overview");
  expectStatus(protectedOverview.response.status, 401, "protected overview");

  const cron = await request("/api/cron/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expectStatus(cron.response.status, 401, "cron guard");

  const kakao = await request("/api/kakao/skill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userRequest: { utterance: "도움말", user: { id: "smoke-anonymous" } } }),
  });
  if (healthBody.storage === "supabase") expectStatus(kakao.response.status, 401, "Kakao skill guard");
  else if (![200, 401].includes(kakao.response.status)) throw new Error(`Kakao skill guard: unexpected HTTP ${kakao.response.status}`);

  console.log(JSON.stringify({
    ok: true,
    target: `${baseUrl.origin}${schedulePath}`,
    storage: healthBody.storage,
    kakaoEnabled: healthBody.kakaoEnabled,
    checks: 6,
  }));
} catch (error) {
  console.error(`Quilo smoke test failed: ${error.message}`);
  process.exitCode = 1;
}
