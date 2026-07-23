"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EXAMPLE,
  createSessionRegistry,
  secureViewerHeaders,
  validateSourcePdf,
} = require("../lib/secure-vocabulary-example");

test("secure viewer session is bound to one user and expires", () => {
  let now = 1_000;
  const registry = createSessionRegistry({ secret: "test-secret", now: () => now, ttlMs: 500 });
  const issued = registry.issue({ id: "user-a" });
  assert.equal(registry.verify(issued.token, { id: "user-a" }).viewerCode.length, 10);
  assert.equal(registry.verify(issued.token, { id: "user-b" }), null);
  now = 1_501;
  assert.equal(registry.verify(issued.token, { id: "user-a" }), null);
});

test("secure viewer headers prevent caching, framing, capture API, and active content", () => {
  const headers = {};
  const response = {
    set(values) { Object.assign(headers, values); },
    setHeader(name, value) { headers[name] = value; },
  };
  secureViewerHeaders(response);
  assert.match(headers["Cache-Control"], /no-store/);
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.match(headers["Permissions-Policy"], /display-capture=\(\)/);
  assert.match(headers["Content-Security-Policy"], /object-src 'none'/);
  assert.match(headers["Content-Security-Policy"], /frame-ancestors 'none'/);
});

test("private source validation rejects any PDF other than the registered digest", () => {
  const fake = Buffer.alloc(EXAMPLE.byteLength);
  fake.write("%PDF-", 0, "ascii");
  assert.throws(() => validateSourcePdf(fake), /무결성/);
});
