"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  emailDomain,
  isQuiloStaffDomain,
  isQuiloStaffEmail,
} = require("../lib/account-domains");
const { normalizeSchoolEmail } = require("../lib/mailer");

test("정확한 quilolab.com 조직 이메일만 스탭 자동 부여 대상으로 판정한다", () => {
  assert.equal(isQuiloStaffEmail("employee@quilolab.com"), true);
  assert.equal(isQuiloStaffEmail("EMPLOYEE@QUILOLAB.COM"), true);
  assert.equal(isQuiloStaffDomain("quilolab.com"), true);
});

test("부분 일치·하위 도메인·복수 @ 주소는 조직 계정으로 인정하지 않는다", () => {
  for (const email of [
    "employee@evilquilolab.com",
    "employee@quilolab.com.evil.test",
    "employee@sub.quilolab.com",
    "employee@quilolab.com@evil.test",
  ]) {
    assert.equal(isQuiloStaffEmail(email), false, email);
  }
  assert.equal(emailDomain("employee@quilolab.com"), "quilolab.com");
});

test("malformed local-part는 도메인이 정확해도 조직 계정으로 인정하지 않는다", () => {
  for (const email of [
    "@quilolab.com",
    ".employee@quilolab.com",
    "employee.@quilolab.com",
    "employee..name@quilolab.com",
    "employee name@quilolab.com",
    `${"a".repeat(65)}@quilolab.com`,
  ]) {
    assert.equal(isQuiloStaffEmail(email), false, email);
  }
});

test("DB 자동 부여와 백필도 split_part 도메인 비교 없이 전체 이메일을 anchored 검증한다", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "../db/migrations/20260714_auto_staff_for_quilolab_email.sql"),
    "utf8",
  );
  assert.doesNotMatch(sql, /lower\s*\(\s*split_part/i);
  assert.equal((sql.match(/\^\[a-z0-9_%\+\-\]\+/gi) || []).length, 2);
  assert.equal((sql.match(/@quilolab\[\.\]com\$/gi) || []).length, 2);
  assert.equal((sql.match(/position\('@' in coalesce\((?:new\.)?email, ''\)\) between 2 and 65/gi) || []).length, 2);
});

test("quilolab.com은 학교 도메인 휴리스틱과 별개로 인증 허용된다", () => {
  const result = normalizeSchoolEmail("employee@quilolab.com");
  assert.equal(result.ok, true);
  assert.equal(result.matchReason, "quilo-staff-domain");
});
