"use strict";

// Quilo 조직 계정은 학교 계정과 별도의 신뢰 경계다. 자동 역할 부여는
// 표시 문자열/부분 일치가 아니라 인증된 이메일의 정확한 도메인에만 적용한다.
const QUILO_STAFF_DOMAIN = "quilolab.com";

function normalizeEmailDomain(value) {
  const domain = String(value || "").trim().toLowerCase().replace(/^@/, "");
  if (!domain || !/^[a-z0-9.-]+$/.test(domain) || domain.startsWith(".") || domain.endsWith(".")) {
    return "";
  }
  return domain;
}

function emailDomain(value) {
  const email = String(value || "").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1 || email.indexOf("@") !== at) return "";
  return normalizeEmailDomain(email.slice(at + 1));
}

function isQuiloStaffDomain(value) {
  return normalizeEmailDomain(value) === QUILO_STAFF_DOMAIN;
}

function isQuiloStaffEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254) return false;
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@") || at > 64) return false;
  // 메일 발송 경로와 같은 보수적 ASCII local-part만 허용한다. 점은 맨 앞/뒤나
  // 연속으로 올 수 없다. 도메인만 맞춘 malformed 주소가 권한 판정에 쓰이지 않게 한다.
  const local = email.slice(0, at);
  if (!/^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*$/.test(local)) return false;
  return emailDomain(email) === QUILO_STAFF_DOMAIN;
}

module.exports = {
  QUILO_STAFF_DOMAIN,
  normalizeEmailDomain,
  emailDomain,
  isQuiloStaffDomain,
  isQuiloStaffEmail,
};
