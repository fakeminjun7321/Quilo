"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..", "..");

test("Supabase helpers do not ship a default personal verification address", () => {
  const source = fs.readFileSync(path.join(root, "lib", "supabase.js"), "utf8");
  const initializer = source.match(/const MULTI_VERIFY_EMAILS[\s\S]*?\.filter\(Boolean\),\n\);/)?.[0] || "";
  assert.match(initializer, /process\.env\.VERIFY_EXEMPT_EMAILS \|\| ""/);
  assert.doesNotMatch(initializer, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
});
