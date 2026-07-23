"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("site responses hide framework details and define the compatible CSP boundary", () => {
  assert.match(source, /app\.disable\("x-powered-by"\)/);
  assert.match(source, /res\.setHeader\("X-Content-Type-Options", "nosniff"\)/);
  assert.match(source, /res\.setHeader\(\s*"Permissions-Policy"/);
  assert.match(source, /res\.setHeader\("Cross-Origin-Opener-Policy"/);
  assert.match(source, /"default-src 'self'"/);
  assert.match(source, /"object-src 'none'"/);
  assert.match(source, /"base-uri 'self'"/);
  assert.match(source, /"frame-ancestors 'self'"/);
  assert.match(source, /https:\/\/cdn\.jsdelivr\.net/);
  assert.match(source, /const allowDynamicCode/);
  assert.match(source, /allowDynamicCode \? " 'unsafe-eval'" : ""/);
  assert.match(source, /req\.path\.startsWith\("\/equation\/"\)/);
});

test("public artifacts keep their separate embed boundary", () => {
  const headerBlock = source.match(
    /app\.use\(\(req, res, next\) => \{[\s\S]*?\/\/ MIT-licensed Express compression middleware/,
  )?.[0] || "";
  assert.match(headerBlock, /if \(!req\.path\.startsWith\("\/p\/"\)\) \{/);
  assert.match(headerBlock, /Content-Security-Policy/);
  assert.match(headerBlock, /X-Frame-Options/);
});
