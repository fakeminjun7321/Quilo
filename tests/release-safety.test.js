"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

test("the production repository cannot be published to npm accidentally", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  assert.equal(pkg.private, true);
  assert.equal(lock.packages?.[""]?.private, true);
});

test("generated output is excluded as a whole, including metadata and caches", () => {
  const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(gitignore, /^\/output\/$/m);
});
