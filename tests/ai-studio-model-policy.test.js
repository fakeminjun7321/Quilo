"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createStudioHandler, resolveModel } = require("../lib/ai-studio-core");

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
}

test("AI Studio rejects an explicit unknown model before provider or credit work", async () => {
  const calls = [];
  const handler = createStudioHandler({
    feature: "test-studio",
    parseInput: () => ({}),
    buildSystem: () => "system",
    buildUserText: () => "user",
  }, {
    getSessionUser: () => ({ id: "user-1" }),
    supa: {
      isEnabled: () => { calls.push("isEnabled"); return true; },
      getUserApiKeys: async () => { calls.push("getUserApiKeys"); return []; },
    },
    pricing: { getModelCredits: () => 4 },
  });
  const res = responseRecorder();
  await handler({ body: { model: "not-a-real-model" } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /지원하지 않는/);
  assert.deepEqual(calls, []);
});

test("AI Studio preserves an explicit allowed model for provider availability checks", () => {
  assert.equal(resolveModel("gpt-5.5"), "gpt-5.5");
  assert.equal(resolveModel("claude-sonnet-5"), "claude-sonnet-5");
});
