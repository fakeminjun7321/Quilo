// 범용 이메일 발송(Resend) + 학교 이메일 인증 메일.
// feedback-mailer.js 와 같은 Resend HTTP API 를 쓰되, 인증 메일 등 다른 용도로
// 재사용할 수 있게 일반 sendEmail() 로 분리했다.
//
// 환경변수
//  - RESEND_API_KEY                : 필수(없으면 발송 비활성, sent:false)
//  - RESEND_FROM / FEEDBACK_EMAIL_FROM : 발신 주소(둘 중 하나)
//  - ALLOWED_EMAIL_DOMAINS         : 항상 허용할 교육기관 이메일 도메인(쉼표구분)
//  - SCHOOL_EMAIL_SUFFIXES         : 추가 학교 도메인 suffix(쉼표구분)
//  - PUBLIC_BASE_URL / APP_BASE_URL: 인증 링크 절대주소(없으면 요청 origin 사용)

const { isQuiloStaffDomain } = require("./account-domains");

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── 허용 이메일 도메인 ────────────────────────────────────────────────────────
function allowedEmailDomains() {
  const raw = process.env.ALLOWED_EMAIL_DOMAINS || "ts.hs.kr";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

// 학교마다 메일 도메인이 달라 운영자가 모든 학교를 미리 등록하기 어렵다. 명시 허용
// 목록은 그대로 최우선 적용하고, 그 밖에는 교육기관에서 널리 쓰는 도메인 구조만
// 보수적으로 인정한다. gmail/naver 같은 개인 메일은 이름에 school 이 들어가더라도
// 허용하지 않는다. 최종 학생 여부는 학번·재학 확인 + 관리자 승인 단계에서 확인한다.
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "kakao.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "yahoo.com",
  "proton.me",
  "protonmail.com",
]);

function configuredSchoolSuffixes() {
  return String(process.env.SCHOOL_EMAIL_SUFFIXES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, "").replace(/^\./, ""))
    .filter(Boolean);
}

function classifySchoolEmailDomain(domain) {
  const d = String(domain || "").trim().toLowerCase().replace(/^@/, "");
  if (!d || PERSONAL_EMAIL_DOMAINS.has(d)) {
    return { accepted: false, reason: d ? "personal-provider" : "empty" };
  }

  const explicit = [...allowedEmailDomains(), ...configuredSchoolSuffixes()];
  const matched = explicit.find((suffix) => d === suffix || d.endsWith(`.${suffix}`));
  if (matched) return { accepted: true, reason: "configured", matched };
  if (isQuiloStaffDomain(d)) {
    return { accepted: true, reason: "quilo-staff-domain", matched: "quilolab.com" };
  }

  const labels = d.split(".").filter(Boolean);
  const hasEducationLabel = labels.some((label) =>
    /^(edu|education|school|schools|academy|college|univ|university|campus|student|students)$/.test(label),
  );
  const looksKoreanSchool = /\.(?:es|ms|hs|sc|ac)\.kr$/.test(d);
  const looksK12 = /(?:^|\.)k12(?:\.|$)/.test(d);
  const looksAcademicCountryDomain = /\.(?:edu|ac)\.[a-z]{2,3}$/.test(d);
  const looksEducationTld = /\.(?:edu|school|academy|college|university)$/.test(d);

  if (
    looksKoreanSchool ||
    looksK12 ||
    looksAcademicCountryDomain ||
    looksEducationTld ||
    hasEducationLabel
  ) {
    return { accepted: true, reason: "education-pattern" };
  }
  return { accepted: false, reason: "unrecognized" };
}

// 이메일 형식 + 허용 도메인 검증. 통과하면 정규화된(소문자) 이메일을 반환.
function normalizeSchoolEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  // 보수적 형식 검증: 로컬파트는 영문/숫자/._%+- 만(따옴표·HTML 특수문자 차단 → 저장/표시
  // 경로의 속성 인젝션 원천 차단), 도메인은 영문/숫자/.- 에 점 포함.
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z0-9-]+$/.test(e)) {
    return { ok: false, reason: "이메일 형식이 올바르지 않습니다." };
  }
  const domain = e.split("@")[1] || "";
  const classification = classifySchoolEmailDomain(domain);
  if (!classification.accepted) {
    return {
      ok: false,
      reason:
        "학교·대학 등 교육기관이 발급한 이메일만 인증할 수 있습니다. 개인 이메일은 사용할 수 없습니다.",
    };
  }
  return { ok: true, email: e, domain, matchReason: classification.reason };
}

// ── 범용 발송 ────────────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || process.env.FEEDBACK_EMAIL_FROM;
  if (!apiKey || !from) {
    return { sent: false, reason: "not_configured" };
  }
  if (!to) return { sent: false, reason: "no_recipient" };

  let response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
  } catch (e) {
    return { sent: false, reason: "network", detail: String(e.message || e) };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      sent: false,
      reason: `resend_${response.status}`,
      detail: detail.slice(0, 500),
    };
  }
  const data = await response.json().catch(() => ({}));
  return { sent: true, id: data.id || null };
}

// ── 학교 이메일 인증 메일 ─────────────────────────────────────────────────────
function buildVerificationHtml({ name, link }) {
  const safeName = escapeHtml(name || "");
  const safeLink = escapeHtml(link);
  return `<!doctype html>
<html lang="ko">
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif; color:#1f2937; line-height:1.6;">
    <div style="max-width:520px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 12px;">Quilo 학교 이메일 인증</h2>
      <p style="margin:0 0 16px;">${safeName ? safeName + "님, " : ""}아래 버튼을 눌러 학교 이메일 인증을 완료하세요. 인증 후 관리자 승인을 받으면 보고서 생성을 사용할 수 있습니다.</p>
      <p style="margin:0 0 24px;">
        <a href="${safeLink}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">이메일 인증하기</a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;color:#64748b;">버튼이 동작하지 않으면 아래 주소를 브라우저에 붙여넣으세요.</p>
      <p style="margin:0 0 24px;font-size:13px;word-break:break-all;"><a href="${safeLink}" style="color:#2563eb;">${safeLink}</a></p>
      <p style="margin:0;font-size:12px;color:#94a3b8;">이 링크는 24시간 동안 유효합니다. 본인이 요청하지 않았다면 이 메일을 무시하세요.</p>
    </div>
  </body>
</html>`;
}

function buildVerificationText({ name, link }) {
  return [
    `${name ? name + "님, " : ""}Quilo 학교 이메일 인증을 완료하세요.`,
    "",
    "아래 주소를 브라우저에서 열면 인증이 완료됩니다(24시간 유효):",
    link,
    "",
    "인증 후 관리자 승인을 받으면 보고서 생성을 사용할 수 있습니다.",
    "본인이 요청하지 않았다면 이 메일을 무시하세요.",
  ].join("\n");
}

async function sendVerificationEmail({ to, name, link }) {
  return sendEmail({
    to,
    subject: "[Quilo] 학교 이메일 인증을 완료하세요",
    html: buildVerificationHtml({ name, link }),
    text: buildVerificationText({ name, link }),
  });
}

// ── 비밀번호 재설정 메일 ────────────────────────────────────────────────────
function buildPasswordResetHtml({ name, link }) {
  const safeName = escapeHtml(name || "");
  const safeLink = escapeHtml(link);
  return `<!doctype html>
<html lang="ko">
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif; color:#1f2937; line-height:1.6;">
    <div style="max-width:520px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 12px;">Quilo 비밀번호 재설정</h2>
      <p style="margin:0 0 16px;">${safeName ? safeName + "님, " : ""}아래 버튼을 눌러 새 비밀번호를 설정하세요.</p>
      <p style="margin:0 0 24px;">
        <a href="${safeLink}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">비밀번호 재설정</a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;color:#64748b;">버튼이 동작하지 않으면 아래 주소를 브라우저에 붙여넣으세요.</p>
      <p style="margin:0 0 24px;font-size:13px;word-break:break-all;"><a href="${safeLink}" style="color:#2563eb;">${safeLink}</a></p>
      <p style="margin:0;font-size:12px;color:#94a3b8;">이 링크는 30분 동안 한 번만 사용할 수 있습니다. 본인이 요청하지 않았다면 이 메일을 무시하세요.</p>
    </div>
  </body>
</html>`;
}

function buildPasswordResetText({ name, link }) {
  return [
    `${name ? name + "님, " : ""}Quilo 비밀번호를 재설정하세요.`,
    "",
    "아래 주소를 브라우저에서 여세요(30분 동안 한 번만 사용 가능):",
    link,
    "",
    "본인이 요청하지 않았다면 이 메일을 무시하세요.",
  ].join("\n");
}

async function sendPasswordResetEmail({ to, name, link }) {
  return sendEmail({
    to,
    subject: "[Quilo] 비밀번호를 재설정하세요",
    html: buildPasswordResetHtml({ name, link }),
    text: buildPasswordResetText({ name, link }),
  });
}

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  buildPasswordResetHtml,
  buildPasswordResetText,
  allowedEmailDomains,
  classifySchoolEmailDomain,
  normalizeSchoolEmail,
};
