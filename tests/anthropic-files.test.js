"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const byok = require("../lib/byok");
const {
  uploadFileToAnthropic,
  deleteAnthropicFile,
} = require("../lib/anthropic-files");

function installFetchRecorder(t) {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (options.method === "POST") {
      return {
        ok: true,
        json: async () => ({ id: "file_test_account_scope" }),
      };
    }
    return { ok: true, text: async () => "" };
  };
  t.after(() => {
    global.fetch = previousFetch;
  });
  return calls;
}

test("Files API upload and delete use the active BYOK Anthropic key", async (t) => {
  const previousServerKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "server-account-key";
  t.after(() => {
    if (previousServerKey == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousServerKey;
  });
  const calls = installFetchRecorder(t);

  await byok.run({ anthropic: "user-account-key" }, async () => {
    const fileId = await uploadFileToAnthropic(
      Buffer.from("%PDF-test"),
      "manual.pdf",
    );
    await deleteAnthropicFile(fileId);
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers["x-api-key"], "user-account-key");
  assert.equal(calls[1].options.headers["x-api-key"], "user-account-key");
  assert.match(calls[1].url, /file_test_account_scope$/);
});

test("an explicitly injected key stays bound across upload and delete", async (t) => {
  const calls = installFetchRecorder(t);

  await byok.run({ anthropic: "different-context-key" }, async () => {
    const fileId = await uploadFileToAnthropic(
      Buffer.from("%PDF-test"),
      "manual.pdf",
      { apiKey: "bound-job-key" },
    );
    await deleteAnthropicFile(fileId, { apiKey: "bound-job-key" });
  });

  assert.deepEqual(
    calls.map((call) => call.options.headers["x-api-key"]),
    ["bound-job-key", "bound-job-key"],
  );
});

test("core report pipelines bind one Files API key for upload and cleanup", () => {
  const files = [
    "lib/pipelines/chem-pre/generate.js",
    "lib/pipelines/chem-result/generate.js",
    "lib/pipelines/phys-result/generate.js",
  ];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
    assert.match(
      source,
      /const filesApiKey = !USE_GPT \? byok\.anthropicKey\(\) : "";/,
      `${relative}: active key must be captured once`,
    );
    assert.match(
      source,
      /uploadFileToAnthropic\([\s\S]{0,300}apiKey: filesApiKey/,
      `${relative}: upload must use the captured key`,
    );
    assert.match(
      source,
      /deleteAnthropicFile\(id, \{ apiKey: filesApiKey \}\)/,
      `${relative}: cleanup must use the captured key`,
    );
  }
});
