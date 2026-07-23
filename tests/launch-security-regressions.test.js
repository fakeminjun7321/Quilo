"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { withWebhookCreateLock } = require("../lib/api-v1/webhooks");

const root = path.resolve(__dirname, "..");

test("all API upload consumers receive the shared response-lifecycle release hook", () => {
  const source = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.match(source, /app\.use\("\/api", initializeUploadMemoryBudget\);/);
  const generateRoute = source.slice(source.indexOf('app.post(\n  "\/api\/generate"'));
  assert.doesNotMatch(
    generateRoute.slice(0, generateRoute.indexOf("async (req, res)")),
    /initializeUploadMemoryBudget/,
  );
});

test("Studio popout assigns untrusted HTML only through sandboxed iframe srcdoc", () => {
  const source = fs.readFileSync(path.join(root, "public/studio.html"), "utf8");
  const start = source.indexOf("function openSandboxedPopout()");
  const end = source.indexOf('$("popout").onclick', start);
  const body = source.slice(start, end);
  assert.match(body, /previewFrame\.srcdoc = currentHtml/);
  assert.doesNotMatch(body, /JSON\.stringify\(currentHtml\)/);
  assert.doesNotMatch(body, /document\.write\([^\n]*currentHtml/);
});

test("Studio durable reservation is heartbeated while the provider call is in flight", () => {
  const source = fs.readFileSync(path.join(root, "lib/ai-studio-core.js"), "utf8");
  assert.match(source, /touchCreditReservation\([\s\S]{0,180}STUDIO_RESERVATION_TTL_MS/);
  assert.match(source, /finally \{[\s\S]{0,180}clearInterval\(studioReservationHeartbeat\)/);
});

test("webhook create critical sections serialize per user", async () => {
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withWebhookCreateLock("user-1", async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:end");
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = withWebhookCreateLock("user-1", async () => {
    order.push("second:start");
    order.push("second:end");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});
