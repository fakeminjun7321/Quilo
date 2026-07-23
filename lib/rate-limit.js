// In-memory rate limiting.
// 무료 Render 단일 인스턴스 환경 가정. 재시작하면 카운터 리셋(=의도된 release valve).

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MIN_MS = 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;

// ── 보고서 생성 (per-user) ──────────────────────────────────────────────────
// 시간당 생성 건수 상한. 크레딧 과금 보고서는 크레딧 자체가 남용을 막으므로 넉넉히 둔다.
// env GEN_LIMIT 로 조정(예: 999=사실상 무제한). 관리자는 이 제한에서 항상 예외.
const GEN_LIMIT = Math.max(1, Number(process.env.GEN_LIMIT) || 100);
const userGenAttempts = new Map(); // userId -> [timestamp, ...]

function _pruneAndGet(userId) {
  const now = Date.now();
  const attempts = (userGenAttempts.get(userId) || []).filter(
    (t) => now - t < ONE_HOUR_MS,
  );
  userGenAttempts.set(userId, attempts);
  return attempts;
}

function checkUserGenLimit(userId) {
  const attempts = _pruneAndGet(userId);
  if (attempts.length >= GEN_LIMIT) {
    const oldest = Math.min(...attempts);
    return {
      allowed: false,
      unlockAt: oldest + ONE_HOUR_MS,
      count: attempts.length,
      limit: GEN_LIMIT,
    };
  }
  return { allowed: true, count: attempts.length, limit: GEN_LIMIT };
}

function recordUserGenAttempt(userId) {
  const attempts = userGenAttempts.get(userId) || [];
  attempts.push(Date.now());
  userGenAttempts.set(userId, attempts);
}

function unlockUser(userId) {
  userGenAttempts.delete(userId);
}

function getUserGenCount(userId) {
  return _pruneAndGet(userId).length;
}

// ── 비밀번호 변경 (per-user) ────────────────────────────────────────────────
const PWCHANGE_LIMIT = 3; // 10분당 3회
const pwChangeAttempts = new Map(); // userId -> [timestamp, ...]

function checkPasswordChangeLimit(userId) {
  const now = Date.now();
  const attempts = (pwChangeAttempts.get(userId) || []).filter(
    (t) => now - t < TEN_MIN_MS,
  );
  pwChangeAttempts.set(userId, attempts);
  return {
    allowed: attempts.length < PWCHANGE_LIMIT,
    count: attempts.length,
    limit: PWCHANGE_LIMIT,
  };
}

function recordPasswordChangeAttempt(userId) {
  const attempts = pwChangeAttempts.get(userId) || [];
  attempts.push(Date.now());
  pwChangeAttempts.set(userId, attempts);
}

// ── 건의사항/버그 제보 (per-user) ───────────────────────────────────────────
const FEEDBACK_LIMIT = 5; // 10분당 5회
const feedbackAttempts = new Map(); // userId -> [timestamp, ...]

function checkFeedbackLimit(userId) {
  const now = Date.now();
  const attempts = (feedbackAttempts.get(userId) || []).filter(
    (t) => now - t < TEN_MIN_MS,
  );
  feedbackAttempts.set(userId, attempts);
  return {
    allowed: attempts.length < FEEDBACK_LIMIT,
    count: attempts.length,
    limit: FEEDBACK_LIMIT,
  };
}

function recordFeedbackAttempt(userId) {
  const attempts = feedbackAttempts.get(userId) || [];
  attempts.push(Date.now());
  feedbackAttempts.set(userId, attempts);
}

// ── 베타 기능 사용 (per-user, per-feature, 일일 한도) ────────────────────────
// 베타 기능(예: PDF 통번역)은 크레딧 차감이 없으므로 테스터 1인당 하루 사용량을 제한한다.
// 한도 값은 server.js가 관리(관리자 설정 + 환경변수 기본값)하고 여기엔 카운터만 둔다.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const betaUsage = new Map(); // `${userId}|${featureKey}` -> [timestamp, ...]
function _betaK(userId, key) {
  return String(userId) + "|" + String(key);
}
function _betaPruneGet(userId, key) {
  const now = Date.now();
  const k = _betaK(userId, key);
  const a = (betaUsage.get(k) || []).filter((t) => now - t < ONE_DAY_MS);
  betaUsage.set(k, a);
  return a;
}
// limit <= 0 또는 무한대면 무제한. allowed=false면 한도 초과.
function checkBetaUsageLimit(userId, key, limit) {
  const lim = Number(limit);
  const a = _betaPruneGet(userId, key);
  if (!Number.isFinite(lim) || lim <= 0) {
    return { allowed: true, count: a.length, limit: 0, unlimited: true };
  }
  const oldest = a.length ? Math.min(...a) : null;
  return {
    allowed: a.length < lim,
    count: a.length,
    limit: lim,
    resetAt: oldest != null ? oldest + ONE_DAY_MS : null,
  };
}
function recordBetaUsage(userId, key) {
  const k = _betaK(userId, key);
  const a = betaUsage.get(k) || [];
  a.push(Date.now());
  betaUsage.set(k, a);
}
function getBetaUsageCount(userId, key) {
  return _betaPruneGet(userId, key).length;
}

// ── PDF 통번역 월간 페이지 캡 (per-user) ─────────────────────────────────────
// 통번역 원가 단위는 '페이지'라 월간 총 페이지로 제한한다(2026-07-02 결정, 기본 300p).
// 메모리 보관 → 재시작 시 리셋(실비 계측 단계의 임시 가드레일 — 영속 원장은 추후).
const translatePages = new Map(); // userId -> { month: 'YYYY-MM', pages }
function _monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function getTranslatePagesUsed(userId) {
  const e = translatePages.get(String(userId));
  return e && e.month === _monthKey() ? e.pages : 0;
}
function addTranslatePages(userId, pages) {
  const m = _monthKey();
  const k = String(userId);
  const e = translatePages.get(k);
  if (e && e.month === m) e.pages += pages;
  else translatePages.set(k, { month: m, pages });
  return translatePages.get(k).pages;
}

// ── 로그인 (per-IP) ──────────────────────────────────────────────────────────
const LOGIN_LIMIT = 10; // 분당 10회
const loginAttemptsByIp = new Map(); // ip -> [timestamp, ...]

function checkLoginLimit(ip) {
  const now = Date.now();
  const attempts = (loginAttemptsByIp.get(ip) || []).filter(
    (t) => now - t < ONE_MIN_MS,
  );
  loginAttemptsByIp.set(ip, attempts);
  return {
    allowed: attempts.length < LOGIN_LIMIT,
    count: attempts.length,
    limit: LOGIN_LIMIT,
  };
}

function recordLoginAttempt(ip) {
  const attempts = loginAttemptsByIp.get(ip) || [];
  attempts.push(Date.now());
  loginAttemptsByIp.set(ip, attempts);
}

// ── AI 도우미 챗 (per-IP 분당/일일 + 전역 일일) ───────────────────────────────
// 무로그인 챗이라 IP 기준 + 전역 일일 상한으로 남용/비용을 막는다.
const CHAT_IP_PER_MIN = 8; // IP당 분당
const CHAT_IP_PER_DAY = 80; // IP당 하루
const chatIpMin = new Map(); // ip -> [ts]
const chatIpDay = new Map(); // ip -> [ts]
let chatGlobalDay = []; // [ts] 전역 하루

function checkChatLimit(ip, globalDailyMax) {
  const now = Date.now();
  const mn = (chatIpMin.get(ip) || []).filter((t) => now - t < ONE_MIN_MS);
  chatIpMin.set(ip, mn);
  const dy = (chatIpDay.get(ip) || []).filter((t) => now - t < ONE_DAY_MS);
  chatIpDay.set(ip, dy);
  chatGlobalDay = chatGlobalDay.filter((t) => now - t < ONE_DAY_MS);
  if (mn.length >= CHAT_IP_PER_MIN) return { allowed: false, reason: "rate" };
  if (dy.length >= CHAT_IP_PER_DAY) return { allowed: false, reason: "ip_day" };
  const gmax = Number(globalDailyMax);
  if (Number.isFinite(gmax) && gmax > 0 && chatGlobalDay.length >= gmax)
    return { allowed: false, reason: "global" };
  return { allowed: true };
}
function recordChatAttempt(ip) {
  const now = Date.now();
  const mn = chatIpMin.get(ip) || [];
  mn.push(now);
  chatIpMin.set(ip, mn);
  const dy = chatIpDay.get(ip) || [];
  dy.push(now);
  chatIpDay.set(ip, dy);
  chatGlobalDay.push(now);
}

// ── 유료 LLM 엔드포인트 (per-user 일일) ───────────────────────────────────────
// filechat(Opus)·유료 write-assist 는 서버 키로 '크레딧 차감 없이' 비싼 모델을 호출한다.
// per-IP 공유 버킷만으론 IP 로테이션·계정 공유로 남용(운영자 비용 폭증)되므로, 사용자
// id 기준 일일 상한을 추가로 건다(M4). env PAID_LLM_DAILY 로 조정.
const PAID_LLM_PER_DAY = Math.max(1, Number(process.env.PAID_LLM_DAILY) || 40);
const paidLlmDay = new Map(); // userId -> [ts]
function checkPaidLlmLimit(userId, limit) {
  const now = Date.now();
  const k = String(userId);
  const a = (paidLlmDay.get(k) || []).filter((t) => now - t < ONE_DAY_MS);
  paidLlmDay.set(k, a);
  const lim = Math.max(1, Number(limit) || PAID_LLM_PER_DAY);
  const oldest = a.length ? Math.min(...a) : null;
  return {
    allowed: a.length < lim,
    count: a.length,
    limit: lim,
    resetAt: oldest != null ? oldest + ONE_DAY_MS : null,
  };
}
function recordPaidLlmUse(userId) {
  const k = String(userId);
  const a = paidLlmDay.get(k) || [];
  a.push(Date.now());
  paidLlmDay.set(k, a);
}

// ── 학교 도입 신청 (public: per-IP 시간당 + 전역 일일) ────────────────────────
// 로그인 없이 외부에서 제출하므로 스팸/남용을 IP 시간당 + 전역 일일 상한으로 막는다.
const SCHOOL_APPLY_PER_HOUR = Math.max(1, Number(process.env.SCHOOL_APPLY_PER_HOUR) || 5);
const SCHOOL_APPLY_GLOBAL_DAY = Math.max(1, Number(process.env.SCHOOL_APPLY_GLOBAL_DAY) || 200);
const schoolApplyIpHour = new Map(); // ip -> [ts]
let schoolApplyGlobalDay = [];
function checkSchoolApplyLimit(ip) {
  const now = Date.now();
  const h = (schoolApplyIpHour.get(ip) || []).filter((t) => now - t < ONE_HOUR_MS);
  schoolApplyIpHour.set(ip, h);
  schoolApplyGlobalDay = schoolApplyGlobalDay.filter((t) => now - t < ONE_DAY_MS);
  if (h.length >= SCHOOL_APPLY_PER_HOUR) return { allowed: false, reason: "ip" };
  if (schoolApplyGlobalDay.length >= SCHOOL_APPLY_GLOBAL_DAY) return { allowed: false, reason: "global" };
  return { allowed: true };
}
function recordSchoolApply(ip) {
  const now = Date.now();
  const h = schoolApplyIpHour.get(ip) || [];
  h.push(now);
  schoolApplyIpHour.set(ip, h);
  schoolApplyGlobalDay.push(now);
}

// ── 비용 서킷 브레이커 (토큰 폭주·돈 빼가기 자동 차단) ──────────────────────
// 실제 API 비용(USD)을 롤링 1시간 창으로 per-user + 전역 누적한다. 임계 초과 시 신규
// 생성을 막아, 누군가 대용량 입력·반복 호출로 API 비용을 폭증시키는 공격(=운영자 돈
// 빼가기)을 자동 중단한다. 재시작하면 리셋(release valve). 관리자는 호출부에서 예외.
// env 로 조정: USER_HOURLY_COST_USD(1인 시간당), GLOBAL_HOURLY_COST_USD(전역 시간당).
// 0 이하로 두면 해당 차단 비활성.
// USER_HOURLY_COST_USD = 무료 등급 기본 한도. Pro/Max 는 서버가 등급별 한도를 넘겨준다.
const USER_HOURLY_COST_USD = Math.max(0, Number(process.env.USER_HOURLY_COST_USD) || 15);
const GLOBAL_HOURLY_COST_USD = Math.max(0, Number(process.env.GLOBAL_HOURLY_COST_USD) || 100);
const userCostLog = new Map(); // userId -> [{ t, usd }]
let globalCostLog = []; // [{ t, usd }]

function _sumRecentCost(arr) {
  if (!arr || !arr.length) return 0;
  const now = Date.now();
  let sum = 0;
  for (const e of arr) if (now - e.t < ONE_HOUR_MS) sum += e.usd;
  return sum;
}

// 생성 1건의 실제 API 비용(USD)을 기록. 정산 직후 호출한다(0 이하는 무시).
function recordGenCost(userId, usd) {
  const amt = Number(usd) || 0;
  if (amt <= 0) return;
  const now = Date.now();
  globalCostLog.push({ t: now, usd: amt });
  // 폭주 방어: 전역 로그가 과도하게 커지면 즉시 만료분 청소.
  if (globalCostLog.length > 10000) {
    globalCostLog = globalCostLog.filter((e) => now - e.t < ONE_HOUR_MS);
  }
  if (userId) {
    const arr = (userCostLog.get(userId) || []).filter(
      (e) => now - e.t < ONE_HOUR_MS,
    );
    arr.push({ t: now, usd: amt });
    userCostLog.set(userId, arr);
  }
}

// 신규 생성 허용 여부. tripped 이면 차단(userTripped=이 사용자만, globalTripped=전체).
// userLimit = 이 사용자 등급 한도(무료 15 / Pro 20 / Max 30). 서버가 등급을 판정해 넘긴다.
// 생략하면 무료 기본(USER_HOURLY_COST_USD) 을 쓴다.
function checkCostCircuitBreaker(userId, userLimit) {
  const uLimit =
    userLimit != null && Number(userLimit) > 0
      ? Number(userLimit)
      : USER_HOURLY_COST_USD;
  const globalUsd = _sumRecentCost(globalCostLog);
  const userUsd = userId ? _sumRecentCost(userCostLog.get(userId)) : 0;
  return {
    globalTripped: GLOBAL_HOURLY_COST_USD > 0 && globalUsd >= GLOBAL_HOURLY_COST_USD,
    userTripped: uLimit > 0 && userUsd >= uLimit,
    globalUsd,
    userUsd,
    userLimit: uLimit,
    globalLimit: GLOBAL_HOURLY_COST_USD,
  };
}

// 주기적 정리 (메모리 leak 방지) — 30분마다 만료된 항목 청소
setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of userGenAttempts.entries()) {
      const fresh = v.filter((t) => now - t < ONE_HOUR_MS);
      if (fresh.length === 0) userGenAttempts.delete(k);
      else userGenAttempts.set(k, fresh);
    }
    for (const [k, v] of loginAttemptsByIp.entries()) {
      const fresh = v.filter((t) => now - t < ONE_MIN_MS);
      if (fresh.length === 0) loginAttemptsByIp.delete(k);
      else loginAttemptsByIp.set(k, fresh);
    }
    for (const [k, v] of pwChangeAttempts.entries()) {
      const fresh = v.filter((t) => now - t < TEN_MIN_MS);
      if (fresh.length === 0) pwChangeAttempts.delete(k);
      else pwChangeAttempts.set(k, fresh);
    }
    for (const [k, v] of feedbackAttempts.entries()) {
      const fresh = v.filter((t) => now - t < TEN_MIN_MS);
      if (fresh.length === 0) feedbackAttempts.delete(k);
      else feedbackAttempts.set(k, fresh);
    }
    for (const [k, v] of betaUsage.entries()) {
      const fresh = v.filter((t) => now - t < ONE_DAY_MS);
      if (fresh.length === 0) betaUsage.delete(k);
      else betaUsage.set(k, fresh);
    }
    for (const [k, v] of chatIpMin.entries()) {
      const fresh = v.filter((t) => now - t < ONE_MIN_MS);
      if (fresh.length === 0) chatIpMin.delete(k);
      else chatIpMin.set(k, fresh);
    }
    for (const [k, v] of chatIpDay.entries()) {
      const fresh = v.filter((t) => now - t < ONE_DAY_MS);
      if (fresh.length === 0) chatIpDay.delete(k);
      else chatIpDay.set(k, fresh);
    }
    chatGlobalDay = chatGlobalDay.filter((t) => now - t < ONE_DAY_MS);
    for (const [k, v] of paidLlmDay.entries()) {
      const fresh = v.filter((t) => now - t < ONE_DAY_MS);
      if (fresh.length === 0) paidLlmDay.delete(k);
      else paidLlmDay.set(k, fresh);
    }
    for (const [k, v] of schoolApplyIpHour.entries()) {
      const fresh = v.filter((t) => now - t < ONE_HOUR_MS);
      if (fresh.length === 0) schoolApplyIpHour.delete(k);
      else schoolApplyIpHour.set(k, fresh);
    }
    schoolApplyGlobalDay = schoolApplyGlobalDay.filter((t) => now - t < ONE_DAY_MS);
    for (const [k, v] of userCostLog.entries()) {
      const fresh = v.filter((e) => now - e.t < ONE_HOUR_MS);
      if (fresh.length === 0) userCostLog.delete(k);
      else userCostLog.set(k, fresh);
    }
    globalCostLog = globalCostLog.filter((e) => now - e.t < ONE_HOUR_MS);
  },
  30 * 60 * 1000,
);

module.exports = {
  GEN_LIMIT,
  LOGIN_LIMIT,
  PWCHANGE_LIMIT,
  FEEDBACK_LIMIT,
  checkUserGenLimit,
  recordUserGenAttempt,
  unlockUser,
  getUserGenCount,
  checkLoginLimit,
  recordLoginAttempt,
  checkPasswordChangeLimit,
  recordPasswordChangeAttempt,
  checkFeedbackLimit,
  recordFeedbackAttempt,
  checkBetaUsageLimit,
  recordBetaUsage,
  getBetaUsageCount,
  getTranslatePagesUsed,
  addTranslatePages,
  checkChatLimit,
  recordChatAttempt,
  PAID_LLM_PER_DAY,
  checkPaidLlmLimit,
  recordPaidLlmUse,
  checkSchoolApplyLimit,
  recordSchoolApply,
  USER_HOURLY_COST_USD,
  GLOBAL_HOURLY_COST_USD,
  recordGenCost,
  checkCostCircuitBreaker,
};
