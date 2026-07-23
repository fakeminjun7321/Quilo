"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "..", "..", "lib", "artifacts-routes.js"),
  "utf8",
);

test("artifact management never falls back to a mutable display name", () => {
  const canManage = source.match(/function canManage\(req, rec\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(canManage, /rec\.owner_id === u\.id/);
  assert.doesNotMatch(canManage, /rec\.owner === u\.name/);
  assert.doesNotMatch(source, /\.is\("owner_id", null\)\.eq\("owner"/);
});

test("rate limits use Express trusted-proxy IP instead of raw forwarding headers", () => {
  assert.doesNotMatch(source, /headers\["x-forwarded-for"\]/i);
  const schoolSource = fs.readFileSync(
    path.join(__dirname, "..", "..", "lib", "school-apply-routes.js"),
    "utf8",
  );
  assert.doesNotMatch(schoolSource, /headers\["x-forwarded-for"\]/i);
  assert.match(schoolSource, /String\(req\.ip \|\| "\?"\)/);
});
