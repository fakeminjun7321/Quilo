"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  DISABLED_EXTERNAL_ENV,
  isolatedServerEnv,
} = require("./QA/support/isolated-server-env");

const qaRoot = path.join(__dirname, "QA");

function qaJavaScriptFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return qaJavaScriptFiles(target);
    return entry.isFile() && /\.(?:c?js|mjs)$/u.test(entry.name) ? [target] : [];
  });
}

test("QA server processes always use the isolated external-service environment", () => {
  const serverSpawners = qaJavaScriptFiles(qaRoot).filter((file) => {
    const source = fs.readFileSync(file, "utf8");
    return /spawn\s*\(/u.test(source) && /server\.js/u.test(source);
  });

  assert.ok(serverSpawners.length > 0, "expected at least one QA server spawner");
  for (const file of serverSpawners) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(
      source,
      /require\(["'](?:\.\/|\.\.\/)support\/isolated-server-env["']\)/u,
      `${path.relative(qaRoot, file)} must import isolatedServerEnv`,
    );
    assert.match(
      source,
      /env\s*:\s*isolatedServerEnv\s*\(/u,
      `${path.relative(qaRoot, file)} must isolate inherited credentials`,
    );
  }
});

test("the isolated QA environment disables every report-provider credential", () => {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "CHAT_API_KEY",
    "GEMINI_API_KEY",
    "GPT_API_KEY",
    "MISTRAL_API_KEY",
    "OPENAI_API_KEY",
    "SUPABASE_SERVICE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]) {
    assert.equal(DISABLED_EXTERNAL_ENV[name], "", `${name} must be disabled`);
  }

  const env = isolatedServerEnv({ PORT: "39876" });
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.DEV_FAKE_AUTH, "0");
  assert.equal(env.DISABLE_SELF_PING, "1");
  assert.equal(env.PORT, "39876");
});
