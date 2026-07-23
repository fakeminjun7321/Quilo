"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");
const { hashPassword, hashToken, verifyPassword } = require("../lib/auth");

function makeClient(rows) {
  class Query {
    constructor() {
      this.operation = "select";
      this.payload = null;
      this.filters = [];
      this.neqFilters = [];
      this.gtFilters = [];
      this.orFilter = null;
      this.ilikeFilter = null;
      this.selected = "*";
    }

    select(columns = "*") {
      this.selected = columns;
      return this;
    }

    update(payload) {
      this.operation = "update";
      this.payload = payload;
      return this;
    }

    eq(column, value) {
      this.filters.push([column, value]);
      return this;
    }

    neq(column, value) {
      this.neqFilters.push([column, value]);
      return this;
    }

    gt(column, value) {
      this.gtFilters.push([column, value]);
      return this;
    }

    or(expression) {
      this.orFilter = String(expression || "");
      return this;
    }

    ilike(column, value) {
      this.ilikeFilter = [column, String(value || "").toLowerCase()];
      return this;
    }

    matches(row) {
      if (!this.filters.every(([column, value]) => row[column] === value)) return false;
      if (!this.neqFilters.every(([column, value]) => row[column] !== value)) return false;
      if (!this.gtFilters.every(([column, value]) => String(row[column] || "") > String(value))) return false;
      if (this.orFilter) {
        const cutoff = this.orFilter.match(/password_reset_sent_at\.lt\.(.+)$/)?.[1] || "";
        const sentAt = row.password_reset_sent_at;
        if (sentAt != null && !(String(sentAt) < cutoff)) return false;
      }
      if (this.ilikeFilter) {
        const [column, value] = this.ilikeFilter;
        if (String(row[column] || "").toLowerCase() !== value) return false;
      }
      return true;
    }

    project(row) {
      if (!row || this.selected === "*") return row ? { ...row } : null;
      return Object.fromEntries(
        this.selected.split(",").map((column) => column.trim()).filter(Boolean)
          .map((column) => [column, row[column]]),
      );
    }

    run() {
      const matches = rows.filter((row) => this.matches(row));
      if (this.operation === "update") {
        for (const row of matches) Object.assign(row, this.payload);
      }
      return matches;
    }

    limit(count) {
      return Promise.resolve({
        data: this.run().slice(0, count).map((row) => this.project(row)),
        error: null,
      });
    }

    maybeSingle() {
      const row = this.run()[0] || null;
      return Promise.resolve({ data: this.project(row), error: null });
    }

    single() {
      const matches = this.run();
      return Promise.resolve({
        data: matches.length === 1 ? this.project(matches[0]) : null,
        error: matches.length === 1 ? null : { message: "expected one row" },
      });
    }

    then(resolve, reject) {
      this.run();
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    }
  }

  return { from: () => new Query() };
}

function loadSupabase(rows) {
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "@supabase/supabase-js") {
      return { createClient: () => makeClient(rows) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const modulePath = require.resolve("../lib/supabase");
  delete require.cache[modulePath];
  const previous = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_KEY,
  };
  process.env.SUPABASE_URL = "https://password-reset.test";
  process.env.SUPABASE_SERVICE_KEY = "service-role-test-key";
  try {
    const supa = require(modulePath);
    supa.getClient();
    return supa;
  } finally {
    Module._load = originalLoad;
    if (previous.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previous.url;
    if (previous.key === undefined) delete process.env.SUPABASE_SERVICE_KEY;
    else process.env.SUPABASE_SERVICE_KEY = previous.key;
  }
}

test("password reset is single-use and preserves the admin role", async () => {
  const oldPassword = "old-password";
  const newPassword = "new-password";
  const rawToken = "raw-token-value";
  const tokenHash = hashToken(rawToken);
  const rows = [{
    id: "admin-1",
    name: "관리자",
    username: "admin-user",
    password_hash: hashPassword(oldPassword),
    is_admin: true,
    password_reset_token_hash: null,
    password_reset_expires_at: null,
    password_reset_sent_at: null,
    recovery_email: "admin@school.edu",
    email_verified: true,
  }];
  const supa = loadSupabase(rows);

  const issued = await supa.setPasswordReset("admin-1", {
    tokenHash,
    expiresAt: Date.now() + 30 * 60 * 1000,
    expectedRecoveryEmail: "admin@school.edu",
  });
  assert.equal(issued.issued, true);
  assert.equal(rows[0].password_reset_token_hash, tokenHash);
  assert.equal(JSON.stringify(rows[0]).includes(rawToken), false);

  const consumed = await supa.consumePasswordReset(tokenHash, newPassword);
  assert.equal(consumed.ok, true);
  assert.equal(rows[0].is_admin, true);
  assert.equal(verifyPassword(oldPassword, rows[0].password_hash), false);
  assert.equal(verifyPassword(newPassword, rows[0].password_hash), true);
  assert.equal(rows[0].password_reset_token_hash, null);
  assert.equal(rows[0].password_reset_expires_at, null);

  const replay = await supa.consumePasswordReset(tokenHash, "another-password");
  assert.equal(replay.ok, false);
  assert.equal(verifyPassword(newPassword, rows[0].password_hash), true);
});

test("expired reset tokens fail and per-account issue cooldown is enforced", async () => {
  const expiredHash = hashToken("expired-token");
  const rows = [{
    id: "user-1",
    name: "사용자",
    username: "normal-user",
    password_hash: hashPassword("original-password"),
    is_admin: false,
    password_reset_token_hash: expiredHash,
    password_reset_expires_at: new Date(Date.now() - 60_000).toISOString(),
    password_reset_sent_at: new Date().toISOString(),
    recovery_email: "user@school.edu",
    email_verified: true,
  }];
  const supa = loadSupabase(rows);

  const expired = await supa.consumePasswordReset(expiredHash, "replacement-password");
  assert.equal(expired.ok, false);
  assert.equal(verifyPassword("original-password", rows[0].password_hash), true);

  const cooldown = await supa.setPasswordReset("user-1", {
    tokenHash: hashToken("new-token"),
    expiresAt: Date.now() + 30 * 60 * 1000,
    expectedRecoveryEmail: "user@school.edu",
  });
  assert.deepEqual(cooldown, { issued: false, reason: "cooldown" });
  assert.equal(rows[0].password_reset_token_hash, expiredHash);
});

test("concurrent reset issuance allows only one token during the cooldown window", async () => {
  const rows = [{
    id: "user-concurrent",
    name: "동시 요청 사용자",
    username: "concurrent-user",
    password_hash: hashPassword("original-password"),
    is_admin: false,
    password_reset_token_hash: null,
    password_reset_expires_at: null,
    password_reset_sent_at: null,
    recovery_email: "concurrent@school.edu",
    email_verified: true,
  }];
  const supa = loadSupabase(rows);
  const firstHash = hashToken("concurrent-token-1");
  const secondHash = hashToken("concurrent-token-2");
  const expiresAt = Date.now() + 30 * 60_000;

  const [first, second] = await Promise.all([
    supa.setPasswordReset("user-concurrent", {
      tokenHash: firstHash,
      expiresAt,
      expectedRecoveryEmail: "concurrent@school.edu",
    }),
    supa.setPasswordReset("user-concurrent", {
      tokenHash: secondHash,
      expiresAt,
      expectedRecoveryEmail: "concurrent@school.edu",
    }),
  ]);

  assert.deepEqual([first.issued, second.issued].sort(), [false, true]);
  assert.equal([firstHash, secondHash].includes(rows[0].password_reset_token_hash), true);
});

test("reset issuance fails if the recovery email changed after the request lookup", async () => {
  const rows = [{
    id: "user-email-race",
    name: "이메일 경쟁 사용자",
    username: "email-race-user",
    password_hash: hashPassword("original-password"),
    is_admin: false,
    recovery_email: "new@school.edu",
    email_verified: true,
    password_reset_token_hash: null,
    password_reset_expires_at: null,
    password_reset_sent_at: null,
  }];
  const supa = loadSupabase(rows);
  const attemptedHash = hashToken("old-mailbox-token");

  const issued = await supa.setPasswordReset("user-email-race", {
    tokenHash: attemptedHash,
    expiresAt: Date.now() + 30 * 60_000,
    expectedRecoveryEmail: "old@school.edu",
  });

  assert.deepEqual(issued, { issued: false, reason: "cooldown" });
  assert.equal(rows[0].password_reset_token_hash, null);
});

test("a direct password change revokes an outstanding reset link", async () => {
  const resetHash = hashToken("still-unconsumed-token");
  const rows = [{
    id: "user-2",
    name: "사용자 2",
    username: "normal-user-2",
    password_hash: hashPassword("original-password"),
    is_admin: false,
    password_reset_token_hash: resetHash,
    password_reset_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    password_reset_sent_at: new Date().toISOString(),
  }];
  const supa = loadSupabase(rows);

  await supa.updateUser("user-2", { password: "manually-changed-password" });
  assert.equal(rows[0].password_reset_token_hash, null);
  assert.equal(rows[0].password_reset_expires_at, null);

  const replay = await supa.consumePasswordReset(resetHash, "attacker-password");
  assert.equal(replay.ok, false);
  assert.equal(verifyPassword("manually-changed-password", rows[0].password_hash), true);
});

test("verifying a new recovery email revokes a token sent to the previous address", async () => {
  const emailTokenHash = hashToken("email-verification-token");
  const resetHash = hashToken("old-address-reset-token");
  const rows = [{
    id: "user-email-change",
    name: "이메일 변경 사용자",
    username: "email-change-user",
    email: "old@school.edu",
    recovery_email: "old@school.edu",
    email_verified: true,
    approved: true,
    is_admin: false,
    is_staff: false,
    email_verify_email: "new@school.edu",
    email_verify_token_hash: emailTokenHash,
    email_verify_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    password_reset_token_hash: resetHash,
    password_reset_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  }];
  const supa = loadSupabase(rows);

  const verified = await supa.verifyEmailToken(emailTokenHash);
  assert.equal(verified.ok, true);
  assert.equal(rows[0].recovery_email, "new@school.edu");
  assert.equal(rows[0].password_reset_token_hash, null);
  assert.equal(rows[0].password_reset_expires_at, null);

  const consumed = await supa.consumePasswordReset(resetHash, "attacker-password");
  assert.equal(consumed.ok, false);
});
