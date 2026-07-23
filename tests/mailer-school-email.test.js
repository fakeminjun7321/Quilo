"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPasswordResetHtml,
  buildPasswordResetText,
  classifySchoolEmailDomain,
  normalizeSchoolEmail,
} = require("../lib/mailer");

test("비밀번호 재설정 메일은 이름과 링크를 안전하게 이스케이프한다", () => {
  const html = buildPasswordResetHtml({
    name: '<script>alert("x")</script>',
    link: "https://quilolab.com/password-reset.html?token=a&next=b",
  });
  const text = buildPasswordResetText({ name: "사용자", link: "https://quilolab.com/reset" });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /token=a&amp;next=b/);
  assert.match(text, /30분/);
});

test("명시 허용된 학교 도메인과 하위 도메인을 허용한다", () => {
  assert.equal(classifySchoolEmailDomain("ts.hs.kr").accepted, true);
  assert.equal(classifySchoolEmailDomain("student.ts.hs.kr").accepted, true);
});

test("국내외 교육기관 도메인 패턴을 보수적으로 허용한다", () => {
  for (const domain of [
    "sample.hs.kr",
    "sample.ac.kr",
    "students.example.edu",
    "school.example.edu.au",
    "district.k12.ca.us",
    "students.example.school",
  ]) {
    assert.equal(classifySchoolEmailDomain(domain).accepted, true, domain);
  }
});

test("개인 이메일과 일반 회사 도메인은 거부한다", () => {
  for (const domain of ["gmail.com", "naver.com", "outlook.com", "example.com"])
    assert.equal(classifySchoolEmailDomain(domain).accepted, false, domain);
});

test("학교 이메일을 소문자로 정규화한다", () => {
  const result = normalizeSchoolEmail("Student@Example.EDU");
  assert.deepEqual(
    { ok: result.ok, email: result.email, domain: result.domain },
    { ok: true, email: "student@example.edu", domain: "example.edu" },
  );
});

test("잘못된 이메일 문법은 도메인 판정 전에 거부한다", () => {
  const result = normalizeSchoolEmail("not an email");
  assert.equal(result.ok, false);
  assert.match(result.reason, /형식/);
});
