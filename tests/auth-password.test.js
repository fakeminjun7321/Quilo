"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { verifyPassword } = require("../lib/auth");

test("malformed stored password hashes fail closed", () => {
  assert.equal(verifyPassword("password", "not-hex:also-not-hex"), false);
  assert.equal(
    verifyPassword("password", `${"z".repeat(32)}:${"0".repeat(128)}`),
    false,
  );
  assert.equal(
    verifyPassword("password", `${"0".repeat(32)}:${"z".repeat(128)}`),
    false,
  );
});

test("runtime no longer exposes an environment-backed admin bootstrap", () => {
  const supa = require("../lib/supabase");
  assert.equal(supa.ensureAdminFromEnv, undefined);
});
