"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const test = require("node:test");
const byok = require("../lib/byok");
const {
  mergeUserModelProviderAvailability,
  serverModelProviderAvailability,
} = require("../lib/report-model-policy");
const { isolatedServerEnv } = require("./QA/support/isolated-server-env");

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(origin, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch (_) {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("server did not become healthy");
}

test("provider availability combines server credentials and decryptable BYOK without enabling Gemini BYOK", () => {
  const serverOnly = serverModelProviderAvailability({
    ANTHROPIC_API_KEY: "anthropic-server-secret",
    GPT_API_KEY: "",
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "gemini-server-secret",
  });
  assert.deepEqual(serverOnly, { anthropic: true, openai: false, gemini: true });

  const combined = mergeUserModelProviderAvailability(serverOnly, {
    openai: "openai-user-secret",
    gemini: "unsupported-user-secret",
  });
  assert.deepEqual(combined, { anthropic: true, openai: true, gemini: true });
  assert.doesNotMatch(JSON.stringify(combined), /secret/);

  assert.deepEqual(
    mergeUserModelProviderAvailability(
      { anthropic: false, openai: false, gemini: false },
      { gemini: "unsupported-user-secret" },
    ),
    { anthropic: false, openai: false, gemini: false },
  );
});

test("a user key table lookup failure gracefully falls back to server provider state", async () => {
  const failingSupa = {
    isEnabled: () => true,
    listUserApiKeys: async () => { throw new Error("temporary database error"); },
  };
  const userKeys = await byok.loadUserKeys(failingSupa, "user-1");
  assert.equal(userKeys, null);
  assert.deepEqual(
    mergeUserModelProviderAvailability(
      { anthropic: true, openai: false, gemini: false },
      userKeys,
    ),
    { anthropic: true, openai: false, gemini: false },
  );
});

test("GET /api/me/balance exposes booleans only for report model providers", { timeout: 30_000 }, async (t) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: isolatedServerEnv({
      PORT: String(port),
      DEV_FAKE_AUTH: "1",
      SESSION_SECRET: "model-provider-test-session-secret",
      ANTHROPIC_API_KEY: "anthropic-provider-test-secret",
      GEMINI_API_KEY: "gemini-provider-test-secret",
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString().slice(0, 4_000); });
  t.after(() => { if (child.exitCode == null) child.kill(); });

  await waitForHealth(origin, child);
  const response = await fetch(`${origin}/api/me/balance`);
  assert.equal(response.status, 200, stderr);
  const data = await response.json();
  assert.deepEqual(data.modelProviders, {
    anthropic: true,
    openai: false,
    gemini: true,
  });
  assert.equal(Object.values(data.modelProviders).every((value) => typeof value === "boolean"), true);
  const serialized = JSON.stringify(data);
  assert.doesNotMatch(serialized, /provider-test-secret/);
});
