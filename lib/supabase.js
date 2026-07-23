// Supabase 클라이언트 + DB 헬퍼.
// SUPABASE_URL + SUPABASE_SERVICE_KEY 환경변수가 모두 있으면 동작.
// 없으면 isEnabled() === false → 호출자가 fallback 처리.

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const { hashPassword, verifyPassword } = require("./auth");
const { isQuiloStaffEmail } = require("./account-domains");
const { aggregateAnalytics } = require("./product-telemetry");

// L11: 로그인 타이밍 사이드채널(아이디 열거) 방지용 더미 해시. 존재하지 않는 계정에도
// 동일한 scrypt 연산을 수행해 '계정 있음/없음'의 응답시간 차이를 없앤다.
const DUMMY_PASSWORD_HASH = hashPassword("timing-equalizer-placeholder");

// 학교 이메일 '다회 인증' 허용 목록 — 이 이메일들은 정상적으로 메일·링크 인증을 거치되,
// 인증 확정 시 unique 'email' 컬럼에 저장하지 않는다. 그래서 같은 주소로 여러 계정을 인증할 수 있다
// (운영자가 권한 있는 테스트 주소를 명시적으로 등록하는 용도). 기본 허용 주소는
// 두지 않는다. 공개 저장소에 개인·학교 이메일을 하드코딩하지 말 것.
const MULTI_VERIFY_EMAILS = new Set(
  (process.env.VERIFY_EXEMPT_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
function isMultiVerifyEmail(email) {
  return !!email && MULTI_VERIFY_EMAILS.has(String(email).trim().toLowerCase());
}

const REPORT_BUCKET = process.env.REPORT_STORAGE_BUCKET || "generated-reports";
const REPORT_RETENTION_HOURS = Math.max(
  1,
  Number(process.env.REPORT_RETENTION_HOURS || 24),
);
const REPORT_MAX_FILES_PER_USER = Math.max(
  1,
  Number(process.env.REPORT_MAX_FILES_PER_USER || 3),
);

let _client = null;
function getClient() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

function isEnabled() {
  return !!getClient();
}

// ── User CRUD ────────────────────────────────────────────────────────────────

async function findUserByName(name) {
  const c = getClient();
  if (!c) return null;
  const raw = String(name || "");
  // ilike 패턴에서 사용자명에 든 % _ 가 SQL 와일드카드로 동작하면(다중 매칭)
  // .maybeSingle() 이 throw 하거나 엉뚱한 계정이 잡힌다. 후보만 받아 JS에서
  // 정확히(대소문자 무시) 매칭한다.
  const { data, error } = await c
    .from("users")
    .select("*")
    .ilike("name", raw)
    .limit(10);
  if (error) throw new Error(`findUserByName: ${error.message}`);
  const lower = raw.toLowerCase();
  return (data || []).find((u) => String(u.name || "").toLowerCase() === lower) || null;
}

// 로그인 아이디(username)로 조회. username 컬럼이 아직 없으면(마이그레이션 전)
// name 으로 폴백한다. % _ 와일드카드 오작동을 피하려고 후보만 받아 JS 에서 정확 매칭.
async function findUserByUsername(username) {
  const c = getClient();
  if (!c) return null;
  const raw = String(username || "");
  if (!raw) return null;
  const lower = raw.toLowerCase();
  try {
    const { data, error } = await c
      .from("users")
      .select("*")
      .ilike("username", raw)
      .limit(10);
    if (error) throw error;
    const hit =
      (data || []).find(
        (u) => String(u.username || "").toLowerCase() === lower,
      ) || null;
    if (hit) return hit;
    // username 컬럼은 있으나 값이 비어있는(백필 전) 계정도 있을 수 있어 name 폴백.
    return await findUserByName(raw);
  } catch (e) {
    // username 컬럼 미존재 등 → name 폴백.
    if (/column .*username.* does not exist|username/i.test(e.message || "")) {
      return await findUserByName(raw);
    }
    throw new Error(`findUserByUsername: ${e.message}`);
  }
}

async function findUserById(id) {
  const c = getClient();
  if (!c) return null;
  const { data, error } = await c
    .from("users")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`findUserById: ${error.message}`);
  return data;
}

// 확정 인증된 학교 이메일로 계정 조회(중복 인증 방지용). 없거나 email 컬럼 미존재면 null.
async function findUserByEmail(email) {
  const c = getClient();
  if (!c) return null;
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  try {
    const { data, error } = await c
      .from("users")
      .select("id, name, username, email")
      .ilike("email", e)
      .limit(10);
    if (error) throw error;
    return (
      (data || []).find((u) => String(u.email || "").toLowerCase() === e) || null
    );
  } catch (err) {
    if (/column .*email.* does not exist|email/i.test(err.message || "")) {
      return null;
    }
    throw new Error(`findUserByEmail: ${err.message}`);
  }
}

// 보고서 종류 접근 제한 값 정규화 (jsonb 배열 또는 JSON 문자열 또는 null).
function normalizeBlockedTypes(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  if (typeof v === "string" && v.trim()) {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

// 한 사용자의 차단된 보고서 종류 목록. findUserById 는 select("*") 라
// blocked_report_types 컬럼이 없어도(마이그레이션 전) 안전(undefined→[]).
async function getBlockedReportTypes(userId) {
  if (!userId) return [];
  try {
    const u = await findUserById(userId);
    return normalizeBlockedTypes(u && u.blocked_report_types);
  } catch {
    return [];
  }
}

// 전체 사용자 id→차단목록 맵 (관리자 목록 표시용). 컬럼 없음/오류면 빈 맵으로
// fail-safe — 크레딧 표시(listUsers)에 영향 주지 않도록 별도 쿼리로 둔다.
async function listBlockedReportTypesMap() {
  const c = getClient();
  if (!c) return {};
  try {
    const { data, error } = await c
      .from("users")
      .select("id, blocked_report_types");
    if (error) throw error;
    const map = {};
    for (const r of data || []) {
      map[r.id] = normalizeBlockedTypes(r.blocked_report_types);
    }
    return map;
  } catch (e) {
    if (!/blocked_report_types/.test(e.message || "")) {
      console.warn("[acl] listBlockedReportTypesMap:", e.message);
    }
    return {};
  }
}

async function listUsers() {
  const c = getClient();
  if (!c) return [];
  // 새 credit 컬럼 포함해서 시도. 컬럼이 없으면 (SQL 미실행) fallback.
  // 컬럼 집합을 단계적으로 시도한다. 일부 마이그레이션만 적용된 환경에서도, 존재하는
  // 컬럼은 실제 값을 유지하고 없는 컬럼만 기본값으로 채운다(예: 인증 컬럼만 없을 때
  // 크레딧/모델제한 값이 0/false 로 덮이지 않도록).
  const fillDefaults = (rows) =>
    (rows || []).map((u) => {
      const row = {
        username: u.name,
        student_id: "",
        email: null,
        recovery_email: null,
        email_verified: false,
        approved: false,
        pre_credits_usd: 0,
        result_credits_usd: 0,
        credits: 0,
        unlimited: false,
        restricted_model: null,
        ...u, // 실제 select 된 값이 기본값을 덮어쓴다
      };
      return { ...row, email: row.email || row.recovery_email || null };
    });

  const COL_SETS = [
    // 전체(인증 + 크레딧 + ACL)
    "id, name, username, student_id, email, recovery_email, email_verified, approved, budget_usd, spent_usd, pre_credits_usd, result_credits_usd, credits, unlimited, restricted_model, is_admin, created_at, updated_at",
    // password reset 마이그레이션만 아직 적용되지 않은 전환기
    "id, name, username, student_id, email, email_verified, approved, budget_usd, spent_usd, pre_credits_usd, result_credits_usd, credits, unlimited, restricted_model, is_admin, created_at, updated_at",
    // 인증 컬럼만 없는 경우(크레딧/ACL 보존)
    "id, name, student_id, budget_usd, spent_usd, pre_credits_usd, result_credits_usd, credits, unlimited, restricted_model, is_admin, created_at, updated_at",
    // 크레딧/ACL 컬럼도 없는 경우(가장 기본)
    "id, name, budget_usd, spent_usd, is_admin, created_at, updated_at",
  ];

  let lastErr = null;
  for (let i = 0; i < COL_SETS.length; i++) {
    const { data, error } = await c
      .from("users")
      .select(COL_SETS[i])
      .order("created_at", { ascending: true });
    if (!error) return fillDefaults(data);
    lastErr = error;
    if (i < COL_SETS.length - 1) {
      console.warn(
        `[listUsers] 컬럼 집합 ${i} 실패, 폴백 시도:`,
        error.message,
      );
    }
  }
  throw new Error(`listUsers: ${lastErr ? lastErr.message : "unknown"}`);
}

async function createUser({
  name,
  username,
  password,
  budgetUsd,
  preCreditsUsd = 0,
  resultCreditsUsd = 0,
  isAdmin = false,
  studentId = "",
  approved = false,
  emailVerified = false,
}) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const password_hash = hashPassword(password);
  // username 미지정 시 name 으로(레거시 호출부 호환). 관리자 생성 계정은 자동 승인.
  const uname = String(username || name || "").trim();
  const row = {
    name,
    username: uname,
    password_hash,
    student_id: String(studentId || "").trim(),
    budget_usd: Number(budgetUsd) || 0,
    pre_credits_usd: Number(preCreditsUsd) || 0,
    result_credits_usd: Number(resultCreditsUsd) || 0,
    is_admin: !!isAdmin,
    approved: !!approved || !!isAdmin,
    email_verified: !!emailVerified || !!isAdmin,
  };
  if (row.approved) row.approved_at = new Date().toISOString();
  const { data, error } = await c.from("users").insert(row).select().single();
  if (error) throw new Error(`createUser: ${error.message}`);
  return data;
}

async function updateUser(id, patch) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const update = {};
  if (patch.name != null) update.name = patch.name;
  if (patch.username != null)
    update.username = String(patch.username || "").trim().slice(0, 50);
  if (patch.studentId != null)
    update.student_id = String(patch.studentId || "").trim().slice(0, 20);
  if (patch.email !== undefined)
    update.email = patch.email ? String(patch.email).trim().toLowerCase() : null;
  if (patch.emailVerified != null) update.email_verified = !!patch.emailVerified;
  if (patch.approved != null) {
    update.approved = !!patch.approved;
    update.approved_at = patch.approved ? new Date().toISOString() : null;
  }
  // 내 기본 글 스타일(문체 메모). users.style_note (text) 컬럼 필요.
  if (patch.styleNote !== undefined)
    update.style_note = String(patch.styleNote || "").slice(0, 4000);
  if (patch.password != null && patch.password !== "") {
    update.password_hash = hashPassword(patch.password);
    // Any direct password change revokes an outstanding recovery link.
    update.password_reset_token_hash = null;
    update.password_reset_expires_at = null;
  }
  if (patch.budgetUsd != null) update.budget_usd = Number(patch.budgetUsd);
  if (patch.isAdmin != null) update.is_admin = !!patch.isAdmin;
  if (patch.spentUsd != null) update.spent_usd = Number(patch.spentUsd);
  if (patch.preCreditsUsd != null)
    update.pre_credits_usd = Number(patch.preCreditsUsd);
  if (patch.resultCreditsUsd != null)
    update.result_credits_usd = Number(patch.resultCreditsUsd);
  if (patch.analyticsConsent != null)
    update.analytics_consent = !!patch.analyticsConsent;
  if (patch.analyticsConsentAt !== undefined)
    update.analytics_consent_at = patch.analyticsConsentAt || null;
  if (patch.analyticsConsentVersion !== undefined)
    update.analytics_consent_version = patch.analyticsConsentVersion
      ? String(patch.analyticsConsentVersion).slice(0, 40)
      : null;
  // 모델 제한: 빈 문자열/null = 제한 없음(전체 허용)
  if (patch.restrictedModel !== undefined)
    update.restricted_model = patch.restrictedModel
      ? String(patch.restrictedModel)
      : null;
  if (patch.unlimited != null) update.unlimited = !!patch.unlimited;
  // 보고서 종류 접근 제한 (jsonb 배열). 빈 배열 = 제한 없음.
  if (patch.blockedReportTypes !== undefined)
    update.blocked_report_types = Array.isArray(patch.blockedReportTypes)
      ? patch.blockedReportTypes.filter((x) => typeof x === "string")
      : [];
  if (Object.keys(update).length === 0) return null;
  const { data, error } = await c
    .from("users")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(`updateUser: ${error.message}`);
  return data;
}

async function deleteUser(id) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const { error } = await c.from("users").delete().eq("id", id);
  if (error) throw new Error(`deleteUser: ${error.message}`);
}

// ── Auth ─────────────────────────────────────────────────────────────────────

// 로그인: 아이디(username) 기준 인증. 기존 계정은 username = name 으로 백필되어
// 같은 값으로 로그인된다. username 으로 못 찾으면 name 으로도 시도(전환기 안전망).
async function authenticate(usernameOrName, password) {
  let user = await findUserByUsername(usernameOrName);
  if (!user) user = await findUserByName(usernameOrName);
  if (!user) {
    // L11: 미존재 계정도 동일한 scrypt 연산을 수행(결과는 버림)해 타이밍 차이를 없앤다.
    verifyPassword(password || "", DUMMY_PASSWORD_HASH);
    return null;
  }
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
}

// 보고서 생성 자격: 관리자이거나 (학교 이메일 인증 완료 AND 관리자 승인).
function isReportEligible(user) {
  if (!user) return false;
  if (user.is_admin) return true;
  return !!user.email_verified && !!user.approved;
}

// 학교 이메일 인증 시작/재발송: 대기 이메일 + 토큰 해시 + 만료를 사용자 행에 저장.
// 원문 토큰은 호출부(server)가 메일로 보내고, 여기엔 해시만 남긴다.
async function setEmailVerification(userId, { email, tokenHash, expiresAt }) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const { error } = await c
    .from("users")
    .update({
      email_verify_email: String(email || "").trim().toLowerCase(),
      email_verify_token_hash: tokenHash,
      email_verify_expires_at: new Date(expiresAt).toISOString(),
      email_verify_sent_at: new Date().toISOString(),
    })
    .eq("id", userId);
  if (error) throw new Error(`setEmailVerification: ${error.message}`);
  return true;
}

// 토큰 해시로 인증 확정. 만료/미존재면 {ok:false}. 같은 이메일이 다른 계정에서 이미
// 인증됐다면 {ok:false, reason}. 성공 시 email 확정 + email_verified=true + 대기필드 정리.
async function verifyEmailToken(tokenHash) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  if (!tokenHash) return { ok: false, reason: "잘못된 인증 링크입니다." };

  const { data: rows, error } = await c
    .from("users")
    .select(
      "id, name, email_verify_email, email_verify_expires_at, email_verified, approved, is_admin, is_staff",
    )
    .eq("email_verify_token_hash", tokenHash)
    .limit(1);
  if (error) throw new Error(`verifyEmailToken(select): ${error.message}`);
  const user = rows && rows[0];
  if (!user) {
    return { ok: false, reason: "이미 사용했거나 유효하지 않은 링크입니다." };
  }
  if (
    user.email_verify_expires_at &&
    new Date(user.email_verify_expires_at).getTime() <= Date.now()
  ) {
    return { ok: false, reason: "인증 링크가 만료되었습니다. 다시 요청하세요." };
  }
  const email = String(user.email_verify_email || "").trim().toLowerCase();
  if (!email) {
    return { ok: false, reason: "인증할 이메일 정보가 없습니다. 다시 요청하세요." };
  }

  // 다회 인증 허용 이메일은 '1계정 1이메일' 중복 검사·저장을 건너뛴다(같은 주소로 여러 계정 인증).
  const multi = isMultiVerifyEmail(email);

  if (!multi) {
    // 같은 이메일을 다른 계정이 이미 확정 인증했는지 확인(중복 방지).
    // L2: ilike 는 값에 포함된 '_'/'%'(정상 이메일 로컬파트에 허용되는 문자)를 와일드카드로
    // 취급해 무관한 주소를 과대매칭한다. ilike 는 '광역 후보' 로만 쓰고, JS 에서 정확히
    // (대소문자 무시) 일치하는 것만 중복으로 판정한다(findUserByEmail 과 동일 패턴).
    const { data: dup } = await c
      .from("users")
      .select("id,email")
      .ilike("email", email)
      .neq("id", user.id)
      .limit(20);
    const exactDup = (dup || []).filter(
      (r) => String(r.email || "").trim().toLowerCase() === email,
    );
    if (exactDup.length) {
      return {
        ok: false,
        reason: "이 이메일은 이미 다른 계정에서 인증되었습니다.",
      };
    }
  }

  // 다회 인증 이메일은 unique 'email' 컬럼에 저장하지 않는다(유니크 인덱스 충돌 회피).
  const updatePatch = {
    email_verified: true,
    recovery_email: email,
    // A link sent to the previous recovery address must stop working as soon as
    // a newly verified recovery address is committed.
    password_reset_token_hash: null,
    password_reset_expires_at: null,
    email_verify_token_hash: null,
    email_verify_email: null,
    email_verify_expires_at: null,
  };
  if (!multi) updatePatch.email = email;
  const autoStaff = isQuiloStaffEmail(email);
  // 조직 도메인 자체만으로는 부족하며, 이 코드는 유효한 일회용 토큰을 소비해
  // email_verified=true로 확정하는 동일 트랜잭션성 업데이트에서만 실행된다.
  if (autoStaff) updatePatch.is_staff = true;

  const { data: updated, error: upErr } = await c
    .from("users")
    .update(updatePatch)
    .eq("id", user.id)
    .eq("email_verify_token_hash", tokenHash)
    .gt("email_verify_expires_at", new Date().toISOString())
    .select("id")
    .maybeSingle();
  if (upErr) {
    // 유니크 인덱스 충돌(동시 인증) 등.
    if (/duplicate key|unique|23505/i.test(upErr.message || "")) {
      return {
        ok: false,
        reason: "이 이메일은 이미 다른 계정에서 인증되었습니다.",
      };
    }
    throw new Error(`verifyEmailToken(update): ${upErr.message}`);
  }
  if (!updated) {
    return { ok: false, reason: "이미 사용했거나 만료된 인증 링크입니다." };
  }
  return {
    ok: true,
    staffGranted: autoStaff && !user.is_staff,
    user: {
      ...user,
      email: multi ? "" : email,
      email_verified: true,
      is_staff: autoStaff || !!user.is_staff,
    },
  };
}

// 비밀번호 재설정 토큰은 사용자 행에 해시만 저장한다. 같은 계정에는 5분에 한 번만
// 새 토큰을 발급하고, 새 토큰을 만들면 이전 링크는 즉시 무효화된다.
async function setPasswordReset(userId, { tokenHash, expiresAt, expectedRecoveryEmail }) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const now = new Date();
  const cooldownBefore = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  // Keep the cooldown predicate in the UPDATE itself. Concurrent requests for the same
  // account therefore cannot both mint and email different reset links.
  const { data, error } = await c
    .from("users")
    .update({
      password_reset_token_hash: tokenHash,
      password_reset_expires_at: new Date(expiresAt).toISOString(),
      password_reset_sent_at: now.toISOString(),
    })
    .eq("id", userId)
    .eq("recovery_email", String(expectedRecoveryEmail || "").trim().toLowerCase())
    .eq("email_verified", true)
    .or(`password_reset_sent_at.is.null,password_reset_sent_at.lt.${cooldownBefore}`)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`setPasswordReset(update): ${error.message}`);
  if (!data) return { issued: false, reason: "cooldown" };
  return { issued: true };
}

async function clearPasswordReset(userId, tokenHash) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  let query = c
    .from("users")
    .update({
      password_reset_token_hash: null,
      password_reset_expires_at: null,
      password_reset_sent_at: null,
    })
    .eq("id", userId);
  if (tokenHash) query = query.eq("password_reset_token_hash", tokenHash);
  const { error } = await query;
  if (error) throw new Error(`clearPasswordReset: ${error.message}`);
  return true;
}

// 유효한 토큰을 조건부 update에서 소비하면서 비밀번호를 바꾼다. 동일 링크의 동시
// 재사용은 password_reset_token_hash 조건 때문에 한 요청만 성공한다.
async function consumePasswordReset(tokenHash, newPassword) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  if (!tokenHash) return { ok: false, reason: "유효하지 않은 재설정 링크입니다." };
  const { data, error } = await c
    .from("users")
    .update({
      password_hash: hashPassword(newPassword),
      password_reset_token_hash: null,
      password_reset_expires_at: null,
    })
    .eq("password_reset_token_hash", tokenHash)
    .gt("password_reset_expires_at", new Date().toISOString())
    .select("id,name,username,is_admin")
    .maybeSingle();
  if (error) throw new Error(`consumePasswordReset: ${error.message}`);
  if (!data) {
    return {
      ok: false,
      reason: "이미 사용했거나 만료된 재설정 링크입니다. 다시 요청하세요.",
    };
  }
  return { ok: true, user: data };
}

// 관리자 승인/승인취소.
async function setApproved(userId, approved, byUserId = null) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const update = {
    approved: !!approved,
    approved_at: approved ? new Date().toISOString() : null,
    approved_by: approved ? byUserId || null : null,
  };
  const { data, error } = await c
    .from("users")
    .update(update)
    .eq("id", userId)
    .select()
    .single();
  if (error) throw new Error(`setApproved: ${error.message}`);
  return data;
}

// ID 기반 비번 검증 (본인 비번 변경 시 사용)
async function verifyUserPassword(userId, password) {
  const user = await findUserById(userId);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
}

// ── Usage tracking ──────────────────────────────────────────────────────────

// ── Credit-based balance system (보고서 종류별 USD 잔액) ──────────────────────
// users.pre_credits_usd  — 화학 사전 잔액
// users.result_credits_usd — 결과보고서 (화학·물리 공통) 잔액
// 작업 시작 전: 잔액 ≥ 단가 검증 → 부족하면 거부
// 작업 끝: 단가만큼 차감 (실제 Anthropic 비용 무관 — 고정 가격)

/**
 * 종류별 잔액 검증.
 * @param {string} userId
 * @param {"pre"|"result"} creditField
 * @param {number} priceUsd 보고서 단가
 */
async function checkCreditBalance(userId, creditField, priceUsd) {
  const user = await findUserById(userId);
  if (!user) return { ok: false, reason: "사용자를 찾을 수 없습니다." };

  const colName =
    creditField === "pre" ? "pre_credits_usd" : "result_credits_usd";
  const balance = Number(user[colName]) || 0;
  const label = creditField === "pre" ? "사전보고서" : "결과보고서";

  if (balance < priceUsd) {
    const remaining = balance.toFixed(3);
    const need = priceUsd.toFixed(2);
    return {
      ok: false,
      user,
      reason: `${label} 잔액 부족 (보유 $${remaining} / 1건 $${need}). 관리자에게 충전 요청하세요.`,
    };
  }
  return { ok: true, user, balance };
}

/**
 * 종류별 잔액 차감 (작업 끝 후).
 * @param {string} userId
 * @param {"pre"|"result"} creditField
 * @param {number} priceUsd
 * @returns {Promise<{ newBalance: number }>}
 */
async function deductCredit(userId, creditField, priceUsd) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const colName =
    creditField === "pre" ? "pre_credits_usd" : "result_credits_usd";

  // 1순위: 원자적 차감 RPC. 단일 UPDATE ... RETURNING이라 동시 요청에서도
  // 잃어버린 갱신(lost update)·이중 차감이 없다. Supabase에 deduct_credit
  // 함수가 아직 없으면(미생성) 아래 폴백으로 내려간다.
  // 활성화 SQL은 db/credit-rpc.sql 참고.
  const rpc = await c.rpc("deduct_credit", {
    p_user_id: userId,
    p_col: colName,
    p_amount: priceUsd,
  });
  if (!rpc.error) {
    const newBalance = Number(rpc.data);
    if (Number.isFinite(newBalance)) return { newBalance, atomic: true };
    throw new Error("deductCredit(rpc): 반환값이 숫자가 아님");
  }
  // 함수 미존재(PGRST202 / 42883)면 폴백, 그 외 진짜 에러는 던진다.
  const rpcMsg = `${rpc.error.message || ""} ${rpc.error.code || ""} ${rpc.error.hint || ""}`;
  const fnMissing =
    /PGRST202|42883|could not find the function|does not exist/i.test(rpcMsg);
  if (!fnMissing) throw new Error(`deductCredit(rpc): ${rpc.error.message}`);

  // 폴백: 비원자 read-modify-write (RPC 미생성 환경). 동작은 기존과 동일하나
  // 동시성 보호가 없으므로, 위 RPC를 생성해 두는 것을 권장한다.
  const user = await findUserById(userId);
  if (!user) throw new Error("사용자를 찾을 수 없습니다.");
  const current = Number(user[colName]) || 0;
  const newBalance = Math.max(current - priceUsd, 0);
  const { error } = await c
    .from("users")
    .update({ [colName]: newBalance })
    .eq("id", userId);
  if (error) throw new Error(`deductCredit: ${error.message}`);
  return { newBalance, atomic: false };
}

/**
 * 종류별 잔액 충전 (admin 전용).
 * @param {string} userId
 * @param {"pre"|"result"} creditField
 * @param {number} addUsd 추가할 금액 (USD)
 */
async function topupCredit(userId, creditField, addUsd) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const colName =
    creditField === "pre" ? "pre_credits_usd" : "result_credits_usd";
  const add = Number(addUsd);
  if (!Number.isFinite(add)) throw new Error("충전 금액이 올바르지 않습니다.");
  const user = await findUserById(userId);
  if (!user) throw new Error("사용자를 찾을 수 없습니다.");
  const current = Number(user[colName]) || 0;
  const newBalance = current + add;
  const { error } = await c
    .from("users")
    .update({ [colName]: newBalance })
    .eq("id", userId);
  if (error) throw new Error(`topupCredit: ${error.message}`);
  return { newBalance };
}

// ── 통합 크레딧 포인트(정수) — 모델별 과금(Opus 3 / Sonnet 1) ─────────────────
// users.credits 사용. 위 *_credits_usd(pre/result)는 레거시로 보존만 함.

async function getCredits(userId) {
  const user = await findUserById(userId);
  if (!user) return 0;
  return Math.max(0, Math.trunc(Number(user.credits) || 0));
}

// 원자적 차감. spend_credits RPC 우선, 미생성 시 read-modify-write 폴백.
async function spendCredits(userId, amount) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const amt = Math.trunc(Number(amount) || 0);
  if (amt < 0) throw new Error(`invalid amount: ${amount}`);
  if (amt === 0) return { newBalance: await getCredits(userId), atomic: true };

  const rpc = await c.rpc("spend_credits", {
    p_user_id: userId,
    p_amount: amt,
  });
  if (!rpc.error) {
    const newBalance = Number(rpc.data);
    if (Number.isFinite(newBalance)) return { newBalance, atomic: true };
    throw new Error("spendCredits(rpc): 반환값이 숫자가 아님");
  }
  const rpcMsg = `${rpc.error.message || ""} ${rpc.error.code || ""} ${rpc.error.hint || ""}`;
  const fnMissing =
    /PGRST202|42883|could not find the function|does not exist/i.test(rpcMsg);
  if (!fnMissing) throw new Error(`spendCredits(rpc): ${rpc.error.message}`);

  // 폴백 (비원자 read-modify-write)
  const user = await findUserById(userId);
  if (!user) throw new Error("사용자를 찾을 수 없습니다.");
  const current = Math.max(0, Math.trunc(Number(user.credits) || 0));
  const newBalance = Math.max(current - amt, 0);
  const { error } = await c
    .from("users")
    .update({ credits: newBalance })
    .eq("id", userId);
  if (error) throw new Error(`spendCredits: ${error.message}`);
  return { newBalance, atomic: false };
}

// 원자적 예약(선차감). 생성 '전' 에 호출해 잔액을 미리 확보한다(P1).
// reserve_credits RPC 우선: credits >= amount 일 때만 원자적으로 차감(0으로 바닥 처리 안 함).
//  - 성공:        { ok:true, newBalance, atomic:true }
//  - 잔액 부족:   { ok:false, newBalance:null, atomic:true }
//  - RPC 미생성:  { unavailable:true } → 호출측이 레거시(후불) 경로로 폴백
async function reserveCredits(userId, amount, { jobId, ttlMs = 60 * 60 * 1000 } = {}) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const amt = Math.trunc(Number(amount) || 0);
  if (amt < 0) throw new Error(`invalid amount: ${amount}`);
  if (amt === 0) return { ok: true, newBalance: await getCredits(userId), atomic: true };
  // job ledger가 없는 구형 reserve_credits는 프로세스 재시작 뒤 환불할 근거를
  // 남기지 않는다. 새 RPC가 없으면 차감하지 않고 호출부의 후불 경로로 폴백한다.
  if (!jobId) return { unavailable: true };
  const rpc = await c.rpc("reserve_generation_credits", {
    p_job_id: String(jobId),
    p_user_id: userId,
    p_amount: amt,
    p_ttl_seconds: Math.max(300, Math.ceil(Number(ttlMs) / 1000) || 3600),
  });
  if (!rpc.error) {
    const bal = Number(rpc.data);
    if (!Number.isFinite(bal)) throw new Error("reserveCredits(rpc): 반환값이 숫자가 아님");
    if (bal < 0) return { ok: false, newBalance: null, atomic: true }; // 잔액 부족
    return { ok: true, newBalance: bal, atomic: true, durable: true };
  }
  const rpcMsg = `${rpc.error.message || ""} ${rpc.error.code || ""} ${rpc.error.hint || ""}`;
  const fnMissing =
    /PGRST202|42883|could not find the function|does not exist/i.test(rpcMsg);
  if (fnMissing) return { unavailable: true }; // 마이그레이션 전 — 레거시 폴백
  throw new Error(`reserveCredits(rpc): ${rpc.error.message}`);
}

async function settleCreditReservation(jobId, spent) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const amount = Math.max(0, Math.trunc(Number(spent) || 0));
  const { data, error } = await c.rpc("settle_generation_credit_reservation", {
    p_job_id: String(jobId || ""),
    p_spent: amount,
  });
  if (error) throw new Error(`settleCreditReservation(rpc): ${error.message}`);
  const newBalance = Number(data?.balance);
  if (!Number.isFinite(newBalance)) {
    throw new Error("settleCreditReservation(rpc): 반환값이 숫자가 아님");
  }
  if (data?.status !== "settled") {
    throw new Error(`settleCreditReservation(rpc): 예상하지 못한 상태 ${data?.status || "unknown"}`);
  }
  return {
    newBalance,
    status: data.status,
    changed: data.changed === true,
    atomic: true,
    durable: true,
  };
}

async function refundCreditReservation(jobId) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const { data, error } = await c.rpc("refund_generation_credit_reservation", {
    p_job_id: String(jobId || ""),
  });
  if (error) throw new Error(`refundCreditReservation(rpc): ${error.message}`);
  const newBalance = Number(data?.balance);
  if (!Number.isFinite(newBalance)) {
    throw new Error("refundCreditReservation(rpc): 반환값이 숫자가 아님");
  }
  if (!["refunded", "settled"].includes(data?.status)) {
    throw new Error(`refundCreditReservation(rpc): 예상하지 못한 상태 ${data?.status || "unknown"}`);
  }
  return {
    newBalance,
    status: data.status,
    refunded: data.status === "refunded",
    alreadySettled: data.status === "settled",
    changed: data.changed === true,
    atomic: true,
    durable: true,
  };
}

async function touchCreditReservation(jobId, ttlMs = 60 * 60 * 1000) {
  const c = getClient();
  if (!c || !jobId) return false;
  const { data, error } = await c.rpc("touch_generation_credit_reservation", {
    p_job_id: String(jobId),
    p_ttl_seconds: Math.max(300, Math.ceil(Number(ttlMs) / 1000) || 3600),
  });
  if (error) {
    const message = `${error.message || ""} ${error.code || ""}`;
    if (/PGRST202|42883|could not find the function|does not exist/i.test(message)) return false;
    throw new Error(`touchCreditReservation(rpc): ${error.message}`);
  }
  return data === true;
}

async function reconcileCreditReservations(limit = 500) {
  const c = getClient();
  if (!c) return 0;
  const { data, error } = await c.rpc("refund_stale_generation_credit_reservations", {
    p_limit: Math.max(1, Math.min(5000, Math.trunc(Number(limit) || 500))),
  });
  if (error) {
    const message = `${error.message || ""} ${error.code || ""}`;
    if (/PGRST202|42883|could not find the function|does not exist/i.test(message)) return 0;
    throw new Error(`reconcileCreditReservations(rpc): ${error.message}`);
  }
  const count = Number(data);
  if (!Number.isFinite(count) || count < 0) {
    throw new Error("reconcileCreditReservations(rpc): 반환값이 숫자가 아님");
  }
  return Math.trunc(count);
}

// 원자적 환불(예약분 정산·작업 실패 시). 0 이하는 no-op.
async function refundCredits(userId, amount) {
  const amt = Math.trunc(Number(amount) || 0);
  if (amt <= 0) return { newBalance: await getCredits(userId) };
  return addCredits(userId, amt);
}

// 정수 크레딧 충전 (admin·환불 공용). add_credits RPC 우선(원자적), 미생성 시 폴백.
async function addCredits(userId, amount) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const amt = Math.trunc(Number(amount) || 0);
  if (!Number.isFinite(amt) || amt <= 0)
    throw new Error(`invalid amount: ${amount}`);

  const rpc = await c.rpc("add_credits", { p_user_id: userId, p_amount: amt });
  if (!rpc.error) {
    const newBalance = Number(rpc.data);
    if (Number.isFinite(newBalance)) return { newBalance, atomic: true };
    throw new Error("addCredits(rpc): 반환값이 숫자가 아님");
  }
  const rpcMsg = `${rpc.error.message || ""} ${rpc.error.code || ""} ${rpc.error.hint || ""}`;
  const fnMissing =
    /PGRST202|42883|could not find the function|does not exist/i.test(rpcMsg);
  if (!fnMissing) throw new Error(`addCredits(rpc): ${rpc.error.message}`);

  // 폴백: 비원자 read-modify-write (RPC 미생성 환경).
  const user = await findUserById(userId);
  if (!user) throw new Error("사용자를 찾을 수 없습니다.");
  const current = Math.max(0, Math.trunc(Number(user.credits) || 0));
  const newBalance = current + amt;
  const { error } = await c
    .from("users")
    .update({ credits: newBalance })
    .eq("id", userId);
  if (error) throw new Error(`addCredits: ${error.message}`);
  return { newBalance, atomic: false };
}

/**
 * Legacy: spent_usd 누적 + usage_logs 기록.
 * 작업이 끝난 후 호출. 잔액 차감은 deductCredit이 별도로 처리.
 */
async function recordUsage({
  userId,
  jobId,
  textCostUsd = 0,
  imageCostUsd = 0,
  meta = null,
}) {
  const c = getClient();
  if (!c) return;
  const total = Number(textCostUsd) + Number(imageCostUsd);

  // 1) usage_logs row (실제 Anthropic 비용)
  const { error: logErr } = await c.from("usage_logs").insert({
    user_id: userId,
    job_id: jobId,
    text_cost_usd: textCostUsd,
    image_cost_usd: imageCostUsd,
    total_usd: total,
    meta,
  });
  if (logErr) throw new Error(`recordUsage(log): ${logErr.message}`);

  // 2) users.spent_usd 누적 (admin 통계용 — 실제 Anthropic 비용 누계)
  // L3: 원자적 증분 RPC 우선(동시 작업의 lost-update 방지). 미생성 시 read-modify-write 폴백.
  const rpc = await c.rpc("add_spent_usd", { p_user_id: userId, p_amount: total });
  if (!rpc.error) return;
  const rpcMsg = `${rpc.error.message || ""} ${rpc.error.code || ""} ${rpc.error.hint || ""}`;
  const fnMissing =
    /PGRST202|42883|could not find the function|does not exist/i.test(rpcMsg);
  if (!fnMissing) throw new Error(`recordUsage(spent): ${rpc.error.message}`);
  const user = await findUserById(userId);
  if (!user) return;
  const newSpent = Number(user.spent_usd || 0) + total;
  await updateUser(userId, { spentUsd: newSpent });
}

// ── Usage log retrieval (admin only) ─────────────────────────────────────────

/**
 * 최근 사용 로그 N건을 user 이름과 join하여 반환.
 * @param {number} limit 최대 행 수 (기본 100)
 */
async function listUsageLogs(limit = 100) {
  const c = getClient();
  if (!c) return [];
  const { data, error } = await c
    .from("usage_logs")
    .select("id, job_id, total_usd, text_cost_usd, image_cost_usd, meta, created_at, users(name)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listUsageLogs: ${error.message}`);
  return (data || []).map((row) => ({
    id: row.id,
    job_id: row.job_id,
    total_usd: row.total_usd,
    text_cost_usd: row.text_cost_usd,
    image_cost_usd: row.image_cost_usd,
    meta: row.meta || {},
    created_at: row.created_at,
    user_name: row.users?.name || "(삭제된 사용자)",
  }));
}

/**
 * 특정 사용자의 최근 사용 로그 N건 (본인 대시보드용).
 * 테이블/컬럼 문제 시 빈 배열로 graceful degrade.
 */
async function listUsageLogsForUser(userId, limit = 20) {
  const c = getClient();
  if (!c || !userId) return [];
  try {
    const { data, error } = await c
      .from("usage_logs")
      .select("id, job_id, total_usd, meta, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(1, limit), 100));
    if (error) throw error;
    return (data || []).map((row) => ({
      id: row.id,
      job_id: row.job_id,
      total_usd: row.total_usd,
      meta: row.meta || {},
      created_at: row.created_at,
    }));
  } catch (e) {
    console.warn("[usage] listUsageLogsForUser:", e.message);
    return [];
  }
}

// ── Login logs (admin only) ──────────────────────────────────────────────────
async function recordLogin({
  userId = null,
  userName = "",
  ip = "",
  userAgent = "",
  success = true,
}) {
  const c = getClient();
  if (!c) return;
  try {
    await c.from("login_logs").insert({
      user_id: userId,
      user_name: String(userName || "").slice(0, 80),
      ip: String(ip || "").slice(0, 64),
      user_agent: String(userAgent || "").slice(0, 300),
      success: !!success,
    });
  } catch (e) {
    console.warn("[login-log] record:", e.message);
  }
}

async function listLoginLogs(limit = 100) {
  const c = getClient();
  if (!c) return [];
  try {
    const { data, error } = await c
      .from("login_logs")
      .select("id, user_name, ip, success, created_at")
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(1, limit), 500));
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn("[login-log] list:", e.message);
    return [];
  }
}

// ── 건의사항/피드백 조회 (admin only) ────────────────────────────────────────
async function listFeedback(limit = 30) {
  const c = getClient();
  if (!c) return [];
  try {
    const { data, error } = await c
      .from("feedback_reports")
      .select("category, title, message, user_name, created_at")
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(1, limit), 100));
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn("[feedback] list:", e.message);
    return [];
  }
}

// ── Generated report file storage (24h retention) ────────────────────────────

function reportStorageConfig() {
  return {
    bucket: REPORT_BUCKET,
    retentionHours: REPORT_RETENTION_HOURS,
    maxFilesPerUser: REPORT_MAX_FILES_PER_USER,
  };
}

function safeExt(filename, fallback = "docx") {
  const m = String(filename || "").match(/\.([A-Za-z0-9]{1,8})$/);
  return (m ? m[1] : fallback).toLowerCase();
}

function blobToBuffer(data) {
  if (Buffer.isBuffer(data)) return Promise.resolve(data);
  if (data && typeof data.arrayBuffer === "function") {
    return data.arrayBuffer().then((ab) => Buffer.from(ab));
  }
  if (data instanceof ArrayBuffer) return Promise.resolve(Buffer.from(data));
  return Promise.resolve(Buffer.from(data || []));
}

function isMissingStorageObjectError(error) {
  if (!error) return false;
  const code = String(error.code || error.error || "").trim().toLowerCase();
  const message = String(error.message || error.error_description || "")
    .trim()
    .toLowerCase();
  if (["object_not_found", "objectnotfound", "nosuchkey", "no_such_key"].includes(code)) {
    return true;
  }
  return /\b(?:object|file|key)\s+(?:was\s+)?(?:not found|does not exist|missing)\b|\b(?:not found|does not exist|missing)\s+(?:object|file|key)\b|\bno such (?:object|file|key)\b/i.test(
    message,
  );
}

function storageRemovalError(operation, bucket, error, reason = "remove failed") {
  const code = String(error?.code || "").trim();
  const status = String(error?.statusCode || error?.status || "").trim();
  const context = [code && `code=${code}`, status && `status=${status}`]
    .filter(Boolean)
    .join(", ");
  const wrapped = new Error(
    `${operation}(storage:${bucket}): ${reason}${context ? ` (${context})` : ""}`,
  );
  wrapped.cause = error instanceof Error ? error : undefined;
  return wrapped;
}

async function removeReportStorageObjects(c, bucket, paths, operation) {
  let result;
  try {
    result = await c.storage.from(bucket).remove(paths);
  } catch (error) {
    if (isMissingStorageObjectError(error)) return;
    throw storageRemovalError(operation, bucket, error);
  }

  // supabase-js의 정상 응답은 항상 { data, error }이다. 응답 자체가 없거나
  // error 필드가 누락되면 삭제 완료를 확인할 수 없으므로 metadata를 보존한다.
  if (!result || typeof result !== "object" || !("error" in result)) {
    throw storageRemovalError(
      operation,
      bucket,
      null,
      "invalid remove response",
    );
  }
  if (result.error && !isMissingStorageObjectError(result.error)) {
    throw storageRemovalError(operation, bucket, result.error);
  }
}

async function removeReportRowsAfterStorage(c, rows, operation) {
  const byBucket = new Map();
  for (const row of rows) {
    const bucket = row.bucket || REPORT_BUCKET;
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket).push(row);
  }

  const removableIds = [];
  const failures = [];
  for (const [bucket, bucketRows] of byBucket) {
    try {
      await removeReportStorageObjects(
        c,
        bucket,
        bucketRows.map((row) => row.object_path),
        operation,
      );
      removableIds.push(...bucketRows.map((row) => row.id));
    } catch (error) {
      failures.push(error);
      // 상위 호출부가 best-effort cleanup 오류를 삼키더라도 운영 로그에는 남긴다.
      // object path/user id는 개인정보 추적자가 될 수 있어 기록하지 않는다.
      console.warn(
        `[report-storage] ${operation}: ${bucketRows.length}개 객체 삭제 실패; metadata 보존`,
        error.message,
      );
    }
  }

  if (removableIds.length > 0) {
    const { error: deleteErr } = await c
      .from("report_files")
      .delete()
      .in("id", removableIds);
    if (deleteErr) throw new Error(`${operation}(delete): ${deleteErr.message}`);
  }

  if (failures.length > 0) {
    throw new Error(
      `${operation}: storage 삭제 실패로 metadata ${rows.length - removableIds.length}건을 보존했습니다; ${failures
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  return removableIds.length;
}

const REPORT_BUCKET_MIME = [
  "application/hwp+zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
];
let _reportBucketReady = false;

async function ensureReportBucket() {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  if (_reportBucketReady) return; // 프로세스당 1회만(중복 API 호출 방지)

  const { error: getErr } = await c.storage.getBucket(REPORT_BUCKET);
  if (!getErr) {
    // 기존 버킷: MIME 화이트리스트를 최신으로 보정(예전에 만들어 application/pdf 가 빠진
    // 운영 버킷도 PDF 통번역 백그라운드 저장이 되도록 — 이미 맞으면 무해, best-effort).
    try {
      await c.storage.updateBucket(REPORT_BUCKET, {
        allowedMimeTypes: REPORT_BUCKET_MIME,
        fileSizeLimit: 50 * 1024 * 1024,
      });
    } catch (_) {
      /* updateBucket 실패는 무시 — 버킷이 이미 PDF 를 허용하면 저장은 그대로 동작 */
    }
    _reportBucketReady = true;
    return;
  }

  const { error: createErr } = await c.storage.createBucket(REPORT_BUCKET, {
    public: false,
    fileSizeLimit: 50 * 1024 * 1024,
    allowedMimeTypes: REPORT_BUCKET_MIME,
  });
  if (createErr && !/already exists/i.test(createErr.message || "")) {
    throw new Error(`ensureReportBucket: ${createErr.message}`);
  }
  _reportBucketReady = true;
}

async function saveReportFile({
  userId,
  jobId,
  reportType,
  filename,
  mimeType,
  buffer,
  meta = null,
}) {
  const c = getClient();
  if (!c) return null;
  if (!userId || !buffer) return null;

  await ensureReportBucket();
  await cleanupExpiredReportFiles(50).catch(() => {});

  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + REPORT_RETENTION_HOURS * 60 * 60 * 1000,
  );
  const ext = safeExt(filename);
  const objectPath = `${userId}/${jobId || crypto.randomUUID()}/${crypto
    .randomBytes(8)
    .toString("hex")}.${ext}`;

  const { error: uploadErr } = await c.storage
    .from(REPORT_BUCKET)
    .upload(objectPath, buffer, {
      contentType: mimeType || "application/octet-stream",
      upsert: false,
      cacheControl: "3600",
    });
  if (uploadErr) throw new Error(`saveReportFile(upload): ${uploadErr.message}`);

  const { data, error: insertErr } = await c
    .from("report_files")
    .insert({
      user_id: userId,
      job_id: jobId || null,
      report_type: reportType || null,
      filename,
      bucket: REPORT_BUCKET,
      object_path: objectPath,
      mime_type: mimeType || "application/octet-stream",
      size_bytes: buffer.length || 0,
      expires_at: expiresAt.toISOString(),
      meta,
    })
    .select()
    .single();

  if (insertErr) {
    try {
      await removeReportStorageObjects(
        c,
        REPORT_BUCKET,
        [objectPath],
        "saveReportFile(rollback)",
      );
    } catch (cleanupErr) {
      console.warn(
        "[report-storage] metadata 저장 실패 후 업로드 객체 rollback도 실패했습니다",
        cleanupErr.message,
      );
      throw new Error(
        `saveReportFile(db): ${insertErr.message}; ${cleanupErr.message}`,
      );
    }
    throw new Error(`saveReportFile(db): ${insertErr.message}`);
  }

  await cleanupOverflowReportFiles(userId).catch(() => {});
  return data;
}

async function listReportFiles(userId, limit = REPORT_MAX_FILES_PER_USER) {
  const c = getClient();
  if (!c || !userId) return [];
  await cleanupExpiredReportFiles(50).catch(() => {});
  await cleanupOverflowReportFiles(userId, REPORT_MAX_FILES_PER_USER).catch(() => {});
  const { data, error } = await c
    .from("report_files")
    .select(
      "id, job_id, report_type, filename, mime_type, size_bytes, created_at, expires_at",
    )
    .eq("user_id", userId)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listReportFiles: ${error.message}`);
  return data || [];
}

async function downloadReportFile(userId, fileId) {
  const c = getClient();
  if (!c || !userId || !fileId) return null;
  const { data: row, error } = await c
    .from("report_files")
    .select("*")
    .eq("id", fileId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`downloadReportFile(row): ${error.message}`);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await deleteReportFile(userId, fileId).catch(() => {});
    return null;
  }

  const { data, error: downloadErr } = await c.storage
    .from(row.bucket || REPORT_BUCKET)
    .download(row.object_path);
  if (downloadErr) {
    throw new Error(`downloadReportFile(storage): ${downloadErr.message}`);
  }
  return { row, buffer: await blobToBuffer(data) };
}

async function deleteReportFile(userId, fileId) {
  const c = getClient();
  if (!c || !userId || !fileId) return false;
  const { data: row, error } = await c
    .from("report_files")
    .select("id, bucket, object_path")
    .eq("id", fileId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`deleteReportFile(row): ${error.message}`);
  if (!row) return false;

  try {
    await removeReportStorageObjects(
      c,
      row.bucket || REPORT_BUCKET,
      [row.object_path],
      "deleteReportFile",
    );
  } catch (storageErr) {
    console.warn(
      "[report-storage] deleteReportFile: Storage 삭제 실패; metadata 보존",
      storageErr.message,
    );
    throw storageErr;
  }
  const { error: deleteErr } = await c
    .from("report_files")
    .delete()
    .eq("id", row.id);
  if (deleteErr) throw new Error(`deleteReportFile(db): ${deleteErr.message}`);
  return true;
}

async function cleanupExpiredReportFiles(limit = 200) {
  const c = getClient();
  if (!c) return { deleted: 0 };
  const { data: rows, error } = await c
    .from("report_files")
    .select("id, bucket, object_path")
    .lte("expires_at", new Date().toISOString())
    .limit(limit);
  if (error) throw new Error(`cleanupExpiredReportFiles(select): ${error.message}`);
  if (!rows || rows.length === 0) return { deleted: 0 };

  const deleted = await removeReportRowsAfterStorage(
    c,
    rows,
    "cleanupExpiredReportFiles",
  );
  return { deleted };
}

async function cleanupOverflowReportFiles(
  userId,
  keep = REPORT_MAX_FILES_PER_USER,
) {
  const c = getClient();
  if (!c || !userId) return { deleted: 0 };
  const keepCount = Math.max(1, Number(keep) || REPORT_MAX_FILES_PER_USER);
  const { data: rows, error } = await c
    .from("report_files")
    .select("id, bucket, object_path")
    .eq("user_id", userId)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`cleanupOverflowReportFiles(select): ${error.message}`);
  if (!rows || rows.length <= keepCount) return { deleted: 0 };

  const excess = rows.slice(keepCount);
  const deleted = await removeReportRowsAfterStorage(
    c,
    excess,
    "cleanupOverflowReportFiles",
  );
  return { deleted };
}

// ── Feedback storage (optional table; email still works without it) ──────────

async function recordFeedback({
  userId,
  userName = "",
  category,
  title,
  message,
  contactEmail = "",
  pageUrl = "",
  userAgent = "",
  emailSent = false,
  emailError = "",
  meta = null,
}) {
  const c = getClient();
  if (!c) return null;
  const payload = {
    user_id: userId || null,
    user_name: userName,
    category,
    title,
    message,
    contact_email: contactEmail || null,
    page_url: pageUrl || null,
    user_agent: userAgent || null,
    email_sent: !!emailSent,
    email_error: emailError || null,
    meta,
  };
  const { data, error } = await c
    .from("feedback_reports")
    .insert(payload)
    .select()
    .single();
  if (error) {
    if (!userId) throw new Error(`recordFeedback: ${error.message}`);
    const fallbackMeta = {
      kind: "feedback",
      feedback: payload,
      feedbackTableError: error.message,
    };
    const { data: fallbackData, error: fallbackError } = await c
      .from("usage_logs")
      .insert({
        user_id: userId,
        job_id: "feedback",
        text_cost_usd: 0,
        image_cost_usd: 0,
        total_usd: 0,
        meta: fallbackMeta,
      })
      .select()
      .single();
    if (fallbackError) {
      throw new Error(
        `recordFeedback: ${error.message}; fallback usage_logs: ${fallbackError.message}`,
      );
    }
    return { ...fallbackData, fallback: "usage_logs" };
  }
  return data;
}

// 7일 무활동 시 Supabase 무료 플랜이 자동 pause되는 걸 막기 위한 가벼운 쿼리.
// UptimeRobot 등 외부 모니터가 주기적으로 호출하도록 /api/keepalive에 노출.
async function ping() {
  const c = getClient();
  if (!c) return { ok: false, reason: "supabase not configured" };
  try {
    // 가장 가벼운 쿼리: users 테이블에서 1행 select (count(*)보다 가벼움)
    const { error } = await c.from("users").select("id").limit(1);
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ── 베타 기능 플래그 + 테스터 지정 ──────────────────────────────────────────
// 테이블이 아직 없으면(마이그레이션 전) 읽기 경로는 안전하게 빈 값/false 를 돌려
// 본 사이트가 죽지 않게 한다. 쓰기 경로(admin)는 에러를 그대로 던져 안내한다.
function _betaTableMissing(error) {
  return error && /relation .*beta_(features|testers).* does not exist|could not find the table/i.test(error.message || "");
}

// 관리자용: 모든 베타 기능 + 각 기능의 테스터(이름 포함)
async function listBetaFeatures() {
  const c = getClient();
  if (!c) return [];
  const { data, error } = await c
    .from("beta_features")
    .select("key,label,enabled,created_at, testers:beta_testers(user_id, user:users(id,name))")
    .order("created_at", { ascending: true });
  if (error) {
    if (_betaTableMissing(error)) {
      const e = new Error("베타 테이블이 없습니다. db/migrations의 20260603_add_beta_features.sql 을 Supabase에 실행하세요.");
      e.code = "BETA_TABLE_MISSING";
      throw e;
    }
    throw new Error(`listBetaFeatures: ${error.message}`);
  }
  return (data || []).map((f) => ({
    key: f.key,
    label: f.label,
    enabled: !!f.enabled,
    testers: (f.testers || [])
      .map((t) => ({ id: t.user_id, name: t.user?.name || "" }))
      .filter((t) => t.name),
  }));
}

async function createBetaFeature(key, label) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const { error } = await c
    .from("beta_features")
    .insert({ key: String(key).trim(), label: String(label || "").trim() });
  if (error) throw new Error(`createBetaFeature: ${error.message}`);
}

// 기능이 없으면 생성(있으면 그대로 둠). 시작 시 코드 내장 베타를 관리자 패널에
// 자동 등록해 테스터 지정이 가능하게 한다. 테이블 없음/오류는 조용히 무시.
async function ensureBetaFeature(key, label) {
  const c = getClient();
  if (!c) return false;
  try {
    const { data } = await c
      .from("beta_features")
      .select("key")
      .eq("key", key)
      .maybeSingle();
    if (data) return false; // 이미 존재(활성/비활성 상태 보존)
    const { error } = await c
      .from("beta_features")
      .insert({ key: String(key).trim(), label: String(label || key).trim() });
    if (error) throw error;
    return true;
  } catch (_) {
    return false; // beta_features 테이블 미적용 등 → 무시
  }
}

// 범용 앱 설정(KV). app_settings 테이블 미적용/미설정이면 graceful 하게 null/false.
async function getAppSetting(key) {
  const c = getClient();
  if (!c) return null;
  try {
    const { data } = await c
      .from("app_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    return data ? data.value : null;
  } catch (_) {
    return null;
  }
}

async function setAppSetting(key, value) {
  const c = getClient();
  if (!c) return false;
  try {
    const { error } = await c
      .from("app_settings")
      .upsert(
        { key: String(key), value, updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );
    if (error) throw error;
    return true;
  } catch (_) {
    return false;
  }
}

async function setBetaFeatureEnabled(key, enabled) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const { error } = await c
    .from("beta_features")
    .update({ enabled: !!enabled })
    .eq("key", key);
  if (error) throw new Error(`setBetaFeatureEnabled: ${error.message}`);
}

async function deleteBetaFeature(key) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const { error } = await c.from("beta_features").delete().eq("key", key);
  if (error) throw new Error(`deleteBetaFeature: ${error.message}`);
}

async function addBetaTester(key, userId) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const { error } = await c
    .from("beta_testers")
    .upsert({ feature_key: key, user_id: userId }, { onConflict: "feature_key,user_id" });
  if (error) throw new Error(`addBetaTester: ${error.message}`);
}

async function removeBetaTester(key, userId) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const { error } = await c
    .from("beta_testers")
    .delete()
    .eq("feature_key", key)
    .eq("user_id", userId);
  if (error) throw new Error(`removeBetaTester: ${error.message}`);
}

// 이 사용자가 접근 가능한(enabled + 테스터로 지정된) 베타 기능 key 목록.
// 테이블이 없거나 오류면 빈 배열 — 접근 차단(안전한 기본값).
async function getUserBetaFeatures(userId) {
  const c = getClient();
  if (!c || !userId) return [];
  try {
    const { data: t, error: e1 } = await c
      .from("beta_testers")
      .select("feature_key")
      .eq("user_id", userId);
    if (e1) throw e1;
    const keys = (t || []).map((r) => r.feature_key);
    if (!keys.length) return [];
    const { data: f, error: e2 } = await c
      .from("beta_features")
      .select("key")
      .eq("enabled", true)
      .in("key", keys);
    if (e2) throw e2;
    return (f || []).map((r) => r.key);
  } catch (e) {
    if (!_betaTableMissing(e)) {
      console.warn("[beta] getUserBetaFeatures:", e.message);
    }
    return [];
  }
}

async function userHasBeta(userId, key) {
  const features = await getUserBetaFeatures(userId);
  // 'pro' 우산 회원권(2026-07-03 관리자 '등급' 탭 통합): 'pro' 보유자는 모든 Pro 기능 통과.
  return features.includes(key) || features.includes("pro");
}

// ── API 키 위임(grant) — 관리자가 지정한 사용자에게 기간 한정 무료 사용권 ──────────
// "관리자 키로 사용" = 위임 기간 동안 그 사용자의 보고서 생성 + 파일 챗봇이 크레딧
// 차감 없이 서버 키로 실행된다. 개인 키 저장은 하지 않는다.
// 테이블이 아직 없으면(마이그레이션 전) 읽기 경로는 안전하게 null/[] 를 돌려 본 사이트가
// 죽지 않게 한다. 쓰기 경로(admin)는 안내 가능한 에러(GRANT_TABLE_MISSING)를 던진다.
function _grantTableMissing(error) {
  return (
    error &&
    /relation .*api_key_grants.* does not exist|could not find the table/i.test(
      error.message || "",
    )
  );
}

// 이 사용자의 현재 활성 위임(만료 전 + 회수 안 됨) 1건. 없으면 null.
async function getActiveGrant(userId) {
  const c = getClient();
  if (!c || !userId) return null;
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await c
      .from("api_key_grants")
      .select("id, user_id, granted_by, expires_at, note, created_at")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .gt("expires_at", nowIso)
      .order("expires_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    return (data && data[0]) || null;
  } catch (e) {
    if (!_grantTableMissing(e)) {
      console.warn("[grant] getActiveGrant:", e.message);
    }
    return null;
  }
}

// 관리자용: 위임 목록(사용자 이름 포함). activeOnly=true 면 활성만.
// 사용자 이름은 FK 임베드 대신 별도 쿼리로 매핑(2개의 users FK 모호성 회피).
async function listGrants({ activeOnly = false } = {}) {
  const c = getClient();
  if (!c) return [];
  try {
    const { data, error } = await c
      .from("api_key_grants")
      .select(
        "id, user_id, granted_by, expires_at, note, revoked_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    const nowMs = Date.now();
    let rows = (data || []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      grantedBy: r.granted_by,
      expiresAt: r.expires_at,
      note: r.note || "",
      revokedAt: r.revoked_at,
      createdAt: r.created_at,
      active: !r.revoked_at && new Date(r.expires_at).getTime() > nowMs,
    }));
    if (activeOnly) rows = rows.filter((r) => r.active);

    if (rows.length) {
      const nameMap = {};
      try {
        const ids = [
          ...new Set(
            rows.flatMap((r) => [r.userId, r.grantedBy].filter(Boolean)),
          ),
        ];
        if (ids.length) {
          const { data: us } = await c
            .from("users")
            .select("id, name")
            .in("id", ids);
          for (const u of us || []) nameMap[u.id] = u.name;
        }
      } catch (_) {
        /* 이름 매핑 실패는 무시(목록은 id 로라도 표시) */
      }
      rows = rows.map((r) => ({
        ...r,
        userName: nameMap[r.userId] || "(삭제된 사용자)",
        grantedByName: r.grantedBy ? nameMap[r.grantedBy] || "" : "",
      }));
    }
    return rows;
  } catch (e) {
    if (_grantTableMissing(e)) {
      const err = new Error(
        "위임 테이블이 없습니다. db/migrations 의 20260620_add_api_key_grants.sql 을 Supabase에 실행하세요.",
      );
      err.code = "GRANT_TABLE_MISSING";
      throw err;
    }
    throw new Error(`listGrants: ${e.message}`);
  }
}

// 관리자: 위임 생성. { userId, grantedBy, expiresAt(ISO), note }
async function createGrant({ userId, grantedBy = null, expiresAt, note = "" }) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  if (!userId) throw new Error("대상 사용자가 필요합니다.");
  const exp = new Date(expiresAt);
  if (isNaN(exp.getTime())) throw new Error("만료 일시가 올바르지 않습니다.");
  if (exp.getTime() <= Date.now()) {
    throw new Error("만료 일시는 현재 이후여야 합니다.");
  }
  const { data, error } = await c
    .from("api_key_grants")
    .insert({
      user_id: userId,
      granted_by: grantedBy || null,
      expires_at: exp.toISOString(),
      note: String(note || "").slice(0, 200),
    })
    .select()
    .single();
  if (error) {
    if (_grantTableMissing(error)) {
      const err = new Error(
        "위임 테이블이 없습니다. db/migrations 의 20260620_add_api_key_grants.sql 을 Supabase에 실행하세요.",
      );
      err.code = "GRANT_TABLE_MISSING";
      throw err;
    }
    throw new Error(`createGrant: ${error.message}`);
  }
  return data;
}

// 관리자: 위임 회수(즉시 만료 처리). 이미 회수된 건 그대로.
async function revokeGrant(grantId) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  if (!grantId) throw new Error("위임 id 가 필요합니다.");
  const { error } = await c
    .from("api_key_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", grantId)
    .is("revoked_at", null);
  if (error) throw new Error(`revokeGrant: ${error.message}`);
}

// ── 백그라운드 실행 구독(background_subscriptions) ─────────────────────────────
// api_key_grants 와 같은 "기간 한정 per-user 권한" 구조. 백그라운드 보고서 실행 전용.
// 나중에 월 결제 웹훅이 createBackgroundSub({ expiresAt }) 만 호출하면 구독제로 확장된다.
function _bgTableMissing(error) {
  const m = `${error?.message || ""} ${error?.code || ""} ${error?.details || ""} ${error?.hint || ""}`;
  return /42P01|PGRST205|PGRST202|does not exist|could not find the table|schema cache/i.test(
    m,
  );
}

// 이 사용자의 현재 활성 백그라운드 구독(만료 전 + 회수 안 됨) 1건. 없으면 null.
async function getActiveBackgroundSub(userId) {
  const c = getClient();
  if (!c || !userId) return null;
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await c
      .from("background_subscriptions")
      .select("id, user_id, granted_by, expires_at, note, created_at")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .gt("expires_at", nowIso)
      .order("expires_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    return (data && data[0]) || null;
  } catch (e) {
    if (!_bgTableMissing(e)) {
      console.warn("[bgsub] getActiveBackgroundSub:", e.message);
    }
    return null;
  }
}

// 관리자용: 구독 목록(사용자 이름 포함). activeOnly=true 면 활성만.
async function listBackgroundSubs({ activeOnly = false } = {}) {
  const c = getClient();
  if (!c) return [];
  try {
    const { data, error } = await c
      .from("background_subscriptions")
      .select(
        "id, user_id, granted_by, expires_at, note, revoked_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    const nowMs = Date.now();
    let rows = (data || []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      grantedBy: r.granted_by,
      expiresAt: r.expires_at,
      note: r.note || "",
      revokedAt: r.revoked_at,
      createdAt: r.created_at,
      active: !r.revoked_at && new Date(r.expires_at).getTime() > nowMs,
    }));
    if (activeOnly) rows = rows.filter((r) => r.active);

    if (rows.length) {
      const nameMap = {};
      try {
        const ids = [
          ...new Set(
            rows.flatMap((r) => [r.userId, r.grantedBy].filter(Boolean)),
          ),
        ];
        if (ids.length) {
          const { data: us } = await c
            .from("users")
            .select("id, name")
            .in("id", ids);
          for (const u of us || []) nameMap[u.id] = u.name;
        }
      } catch (_) {
        /* 이름 매핑 실패는 무시(목록은 id 로라도 표시) */
      }
      rows = rows.map((r) => ({
        ...r,
        userName: nameMap[r.userId] || "(삭제된 사용자)",
        grantedByName: r.grantedBy ? nameMap[r.grantedBy] || "" : "",
      }));
    }
    return rows;
  } catch (e) {
    if (_bgTableMissing(e)) {
      const err = new Error(
        "백그라운드 구독 테이블이 없습니다. db/migrations 의 20260627_add_background_feature.sql 을 Supabase에 실행하세요.",
      );
      err.code = "BG_SUB_TABLE_MISSING";
      throw err;
    }
    throw new Error(`listBackgroundSubs: ${e.message}`);
  }
}

// 관리자: 구독 부여. { userId, grantedBy, expiresAt(ISO), note }
async function createBackgroundSub({
  userId,
  grantedBy = null,
  expiresAt,
  note = "",
}) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  if (!userId) throw new Error("대상 사용자가 필요합니다.");
  const exp = new Date(expiresAt);
  if (isNaN(exp.getTime())) throw new Error("만료 일시가 올바르지 않습니다.");
  if (exp.getTime() <= Date.now()) {
    throw new Error("만료 일시는 현재 이후여야 합니다.");
  }
  const { data, error } = await c
    .from("background_subscriptions")
    .insert({
      user_id: userId,
      granted_by: grantedBy || null,
      expires_at: exp.toISOString(),
      note: String(note || "").slice(0, 200),
    })
    .select()
    .single();
  if (error) {
    if (_bgTableMissing(error)) {
      const err = new Error(
        "백그라운드 구독 테이블이 없습니다. db/migrations 의 20260627_add_background_feature.sql 을 Supabase에 실행하세요.",
      );
      err.code = "BG_SUB_TABLE_MISSING";
      throw err;
    }
    throw new Error(`createBackgroundSub: ${error.message}`);
  }
  return data;
}

// 관리자: 구독 회수(즉시 만료 처리). 이미 회수된 건 그대로.
async function revokeBackgroundSub(subId) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  if (!subId) throw new Error("구독 id 가 필요합니다.");
  const { error } = await c
    .from("background_subscriptions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", subId)
    .is("revoked_at", null);
  if (error) throw new Error(`revokeBackgroundSub: ${error.message}`);
}

// ── 프리미엄 입금 신청(premium_requests) ───────────────────────────────────────
// 자동결제 없이: 사용자가 입금 후 신청 → 관리자가 입금 확인하고 '승인'하면 즉시 구독 부여.
function _premiumReqMissingError(e) {
  if (_bgTableMissing(e)) {
    const err = new Error(
      "프리미엄 신청 테이블이 없습니다. db/migrations 의 20260627_add_premium_requests.sql 을 Supabase에 실행하세요.",
    );
    err.code = "PREMIUM_REQ_TABLE_MISSING";
    return err;
  }
  return null;
}

async function createPremiumRequest({
  userId,
  depositorName = "",
  periodDays = 30,
  amount = null,
}) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  if (!userId) throw new Error("사용자가 필요합니다.");
  // 이미 대기 중인 신청이 있으면 그것을 재사용(중복 신청 방지).
  try {
    const { data: existing } = await c
      .from("premium_requests")
      .select("id, status, created_at")
      .eq("user_id", userId)
      .eq("status", "pending")
      .limit(1);
    if (existing && existing[0]) return { ...existing[0], duplicate: true };
  } catch (e) {
    const missing = _premiumReqMissingError(e);
    if (missing) throw missing;
  }
  const { data, error } = await c
    .from("premium_requests")
    .insert({
      user_id: userId,
      depositor_name: String(depositorName || "").slice(0, 80),
      period_days: Math.max(1, Math.min(366, Number(periodDays) || 30)),
      amount: amount != null ? Math.trunc(Number(amount)) : null,
      status: "pending",
    })
    .select()
    .single();
  if (error) {
    const missing = _premiumReqMissingError(error);
    if (missing) throw missing;
    throw new Error(`createPremiumRequest: ${error.message}`);
  }
  return data;
}

async function listPremiumRequests({ status = "pending" } = {}) {
  const c = getClient();
  if (!c) return [];
  try {
    let q = c
      .from("premium_requests")
      .select(
        "id, user_id, depositor_name, amount, period_days, status, note, decided_by, decided_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (status && status !== "all") q = q.eq("status", status);
    const { data, error } = await q;
    if (error) throw error;
    let rows = (data || []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      depositorName: r.depositor_name || "",
      amount: r.amount,
      periodDays: r.period_days,
      status: r.status,
      note: r.note || "",
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      createdAt: r.created_at,
    }));
    if (rows.length) {
      const nameMap = {};
      try {
        const ids = [...new Set(rows.map((r) => r.userId).filter(Boolean))];
        if (ids.length) {
          const { data: us } = await c
            .from("users")
            .select("id, name, email")
            .in("id", ids);
          for (const u of us || [])
            nameMap[u.id] = { name: u.name, email: u.email };
        }
      } catch (_) {
        /* 이름 매핑 실패는 무시 */
      }
      rows = rows.map((r) => ({
        ...r,
        userName: nameMap[r.userId]?.name || "(삭제된 사용자)",
        userEmail: nameMap[r.userId]?.email || null,
      }));
    }
    return rows;
  } catch (e) {
    if (!_bgTableMissing(e)) {
      console.warn("[premium] listPremiumRequests:", e.message);
    }
    return [];
  }
}

async function getPremiumRequest(id) {
  const c = getClient();
  if (!c || !id) return null;
  try {
    const { data, error } = await c
      .from("premium_requests")
      .select("*")
      .eq("id", id)
      .single();
    if (error) throw error;
    return data;
  } catch (e) {
    if (!_bgTableMissing(e)) console.warn("[premium] getPremiumRequest:", e.message);
    return null;
  }
}

// pending→status 로의 상태 전이를 원자적으로 시도하고, '실제로 바뀐 행 수'를 돌려준다.
// 호출측이 updated>=1 일 때만 부수효과(구독·크레딧 지급)를 실행하면 동시 승인 이중 grant
// 를 막을 수 있다(L1).
async function decidePremiumRequest(id, { status, decidedBy = null }) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  if (!id) throw new Error("신청 id 가 필요합니다.");
  const { data, error } = await c
    .from("premium_requests")
    .update({
      status,
      decided_by: decidedBy || null,
      decided_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  if (error) throw new Error(`decidePremiumRequest: ${error.message}`);
  return { updated: Array.isArray(data) ? data.length : 0 };
}

// ── 학교 도입 신청 (school_applications) ───────────────────────────────────────
// 로그인 없이 외부 학교가 도입 신청 → 관리자 검토. 테이블 미생성 시 호출측이 이메일
// 알림만으로 fallback 하도록 명확한 에러를 던진다.
const SCHOOL_APP_STATUSES = ["new", "reviewing", "contacted", "approved", "rejected", "archived"];
function _schoolAppMissing(e) {
  const msg = `${(e && e.message) || e || ""} ${(e && e.code) || ""}`;
  return /school_applications|does not exist|42P01|PGRST205|schema cache/i.test(msg);
}

// 신청 1건 저장(+ 업로드 파일 base64 보관). files = [{ filename, mime, size, dataBase64 }]
async function createSchoolApplication(payload = {}, files = []) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const str = (v, n = 500) => String(v == null ? "" : v).slice(0, n);
  const row = {
    school_name: str(payload.schoolName, 200),
    school_type: str(payload.schoolType, 40),
    contact_name: str(payload.contactName, 80),
    contact_email: str(payload.contactEmail, 200),
    contact_phone: str(payload.contactPhone, 40),
    student_email_domain: str(payload.studentEmailDomain, 120),
    student_id_scheme: str(payload.studentIdScheme, 500),
    desired_reports: str(payload.desiredReports, 1000),
    desired_start: str(payload.desiredStart, 60),
    budget_note: str(payload.budgetNote, 500),
    message: str(payload.message, 4000),
    status: "new",
  };
  let data, error;
  ({ data, error } = await c.from("school_applications").insert(row).select("id").single());
  if (error) {
    if (_schoolAppMissing(error)) throw new Error("SCHOOL_APP_TABLE_MISSING");
    throw new Error(`createSchoolApplication: ${error.message}`);
  }
  const appId = data.id;
  const fileRows = (Array.isArray(files) ? files : [])
    .slice(0, 8)
    .filter((f) => f && f.dataBase64)
    .map((f) => ({
      application_id: appId,
      filename: str(f.filename, 255),
      mime: str(f.mime, 120),
      size_bytes: Math.max(0, Math.trunc(Number(f.size) || 0)),
      data_base64: String(f.dataBase64 || ""),
    }));
  if (fileRows.length) {
    const { error: fErr } = await c.from("school_application_files").insert(fileRows);
    if (fErr) console.warn("[school-apply] 파일 저장 실패:", fErr.message);
  }
  return { id: appId, fileCount: fileRows.length };
}

async function listSchoolApplications({ status = "all" } = {}) {
  const c = getClient();
  if (!c) return [];
  try {
    let q = c
      .from("school_applications")
      .select(
        "id, school_name, school_type, contact_name, contact_email, contact_phone, student_email_domain, student_id_scheme, desired_reports, desired_start, budget_note, message, status, admin_note, decided_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(300);
    if (status && status !== "all") q = q.eq("status", status);
    const { data, error } = await q;
    if (error) throw error;
    const ids = (data || []).map((r) => r.id);
    const counts = {};
    if (ids.length) {
      try {
        const { data: fs } = await c
          .from("school_application_files")
          .select("application_id")
          .in("application_id", ids);
        for (const f of fs || []) counts[f.application_id] = (counts[f.application_id] || 0) + 1;
      } catch (_) { /* 파일 카운트 실패는 무시 */ }
    }
    return (data || []).map((r) => ({ ...r, file_count: counts[r.id] || 0 }));
  } catch (e) {
    if (!_schoolAppMissing(e)) console.warn("[school-apply] list:", e.message);
    return [];
  }
}

async function getSchoolApplication(id) {
  const c = getClient();
  if (!c) return null;
  try {
    const { data, error } = await c
      .from("school_applications")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    let files = [];
    try {
      const { data: fs } = await c
        .from("school_application_files")
        .select("id, filename, mime, size_bytes, created_at")
        .eq("application_id", id)
        .order("created_at", { ascending: true });
      files = fs || [];
    } catch (_) { /* 파일 목록 실패는 무시 */ }
    return { ...data, files };
  } catch (e) {
    if (!_schoolAppMissing(e)) console.warn("[school-apply] get:", e.message);
    return null;
  }
}

async function getSchoolApplicationFile(appId, fileId) {
  const c = getClient();
  if (!c) return null;
  try {
    const { data, error } = await c
      .from("school_application_files")
      .select("id, application_id, filename, mime, size_bytes, data_base64")
      .eq("id", fileId)
      .eq("application_id", appId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (e) {
    if (!_schoolAppMissing(e)) console.warn("[school-apply] getFile:", e.message);
    return null;
  }
}

async function decideSchoolApplication(id, { status, note, decidedBy = null } = {}) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  if (!id) throw new Error("신청 id 가 필요합니다.");
  const patch = { decided_at: new Date().toISOString(), decided_by: decidedBy || null };
  if (status != null) {
    if (!SCHOOL_APP_STATUSES.includes(String(status))) throw new Error("잘못된 상태값");
    patch.status = String(status);
  }
  if (note != null) patch.admin_note = String(note).slice(0, 4000);
  const { data, error } = await c
    .from("school_applications")
    .update(patch)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`decideSchoolApplication: ${error.message}`);
  return { updated: data ? 1 : 0 };
}

// ── 백그라운드 작업 영속화(report_jobs) ────────────────────────────────────────
// 백그라운드 보고서 작업 상태를 저장 → 재배포/재시작에도 '내 작업'에서 추적.
// 데이터 조작 방지: 결과 파일 binary 는 저장하지 않고 report_files.id(file_id)만 참조한다.
async function upsertReportJob(job) {
  const c = getClient();
  if (!c || !job || !job.id || !job.userId) return null;
  try {
    const row = {
      id: String(job.id),
      user_id: job.userId,
      report_type: job.reportType || "",
      model: job.model || "",
      status: job.status || "running",
      filename: job.filename || null,
      file_id: job.fileId || null,
      error: job.error ? String(job.error).slice(0, 1000) : null,
      progress: Array.isArray(job.progress) ? job.progress.slice(-15) : [],
      background: job.background !== false,
      notify_email: !!job.notifyEmail,
      notified: !!job.notified,
      updated_at: new Date().toISOString(),
    };
    const { error } = await c
      .from("report_jobs")
      .upsert(row, { onConflict: "id" });
    if (error) throw error;
    return true;
  } catch (e) {
    if (!_bgTableMissing(e)) console.warn("[bgjob] upsertReportJob:", e.message);
    return null;
  }
}

// '내 작업' 목록(최근순). 완료본은 파일함(report_files)에도 나타난다.
async function listReportJobs(userId, { limit = 20 } = {}) {
  const c = getClient();
  if (!c || !userId) return [];
  try {
    const { data, error } = await c
      .from("report_jobs")
      .select(
        "id, report_type, model, status, filename, file_id, error, background, notify_email, created_at, updated_at",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(Math.min(50, Math.max(1, limit)));
    if (error) throw error;
    return (data || []).map((r) => ({
      id: r.id,
      reportType: r.report_type,
      model: r.model,
      status: r.status,
      filename: r.filename,
      fileId: r.file_id,
      error: r.error,
      background: r.background,
      notifyEmail: r.notify_email,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } catch (e) {
    if (!_bgTableMissing(e)) console.warn("[bgjob] listReportJobs:", e.message);
    return [];
  }
}

// 외부 API 작업 단건 조회. user_id 조건을 쿼리에 함께 넣어 다른 사용자의 작업 ID를
// 알아도 존재 여부나 상태가 노출되지 않게 한다.
async function getReportJob(userId, jobId) {
  const c = getClient();
  if (!c || !userId || !jobId) return null;
  try {
    const { data, error } = await c
      .from("report_jobs")
      .select(
        "id, report_type, model, status, filename, file_id, error, progress, background, notify_email, notified, created_at, updated_at",
      )
      .eq("id", String(jobId))
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      id: data.id,
      reportType: data.report_type,
      model: data.model,
      status: data.status,
      filename: data.filename,
      fileId: data.file_id,
      error: data.error,
      progress: Array.isArray(data.progress) ? data.progress : [],
      background: data.background,
      notifyEmail: data.notify_email,
      notified: !!data.notified,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  } catch (e) {
    if (!_bgTableMissing(e)) console.warn("[bgjob] getReportJob:", e.message);
    return null;
  }
}

async function listApiRequestLogs(userId, { limit = 25 } = {}) {
  const c = getClient();
  if (!c || !userId) return [];
  try {
    const { data, error } = await c
      .from("api_request_logs")
      .select("request_id, method, path, scope, status, duration_ms, error_code, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(Math.min(100, Math.max(1, limit)));
    if (error) throw error;
    return (data || []).map((row) => ({
      requestId: row.request_id,
      method: row.method,
      path: row.path,
      scope: row.scope,
      status: row.status,
      durationMs: row.duration_ms,
      errorCode: row.error_code,
      createdAt: row.created_at,
    }));
  } catch (error) {
    if (!/api_request_logs|schema cache|relation .* does not exist/i.test(String(error.message || error))) {
      console.warn("[api] listApiRequestLogs:", error.message || error);
    }
    return [];
  }
}

// 부팅 시: 이전 프로세스에서 'running' 으로 남은 작업을 'interrupted' 로 정리.
// (in-memory job 은 재시작으로 사라졌으므로 더는 진행되지 않는다. 크레딧은 생성 성공 후
//  마지막에만 차감되므로 중단 작업은 애초에 미차감 → 환불 불필요.)
async function reconcileRunningJobs() {
  const c = getClient();
  if (!c) return 0;
  try {
    const { data, error } = await c
      .from("report_jobs")
      .update({
        status: "interrupted",
        error: "서버 재시작으로 중단되었습니다 — 다시 생성해 주세요.",
        updated_at: new Date().toISOString(),
      })
      .eq("status", "running")
      .select("id");
    if (error) throw error;
    return (data || []).length;
  } catch (e) {
    if (!_bgTableMissing(e)) {
      console.warn("[bgjob] reconcileRunningJobs:", e.message);
    }
    return 0;
  }
}

// ── Cloud storage connections (Dropbox 등 외부 클라우드 연동) ───────────────────
// refresh_token 은 호출부(server)에서 CLOUD_TOKEN_SECRET 으로 암호화한 문자열을 받는다.
async function saveCloudConnection(
  userId,
  provider,
  { refreshToken, accountEmail, accountName },
) {
  const c = getClient();
  if (!c || !userId || !provider) return null;
  const { data, error } = await c
    .from("cloud_connections")
    .upsert(
      {
        user_id: userId,
        provider,
        refresh_token: refreshToken,
        account_email: accountEmail || null,
        account_name: accountName || null,
        connected_at: new Date().toISOString(),
      },
      { onConflict: "user_id,provider" },
    )
    .select()
    .single();
  if (error) throw new Error(`saveCloudConnection: ${error.message}`);
  return data;
}

async function getCloudConnection(userId, provider) {
  const c = getClient();
  if (!c || !userId || !provider) return null;
  const { data, error } = await c
    .from("cloud_connections")
    .select(
      "user_id, provider, refresh_token, account_email, account_name, connected_at",
    )
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new Error(`getCloudConnection: ${error.message}`);
  return data || null;
}

async function deleteCloudConnection(userId, provider) {
  const c = getClient();
  if (!c || !userId || !provider) return false;
  const { error } = await c
    .from("cloud_connections")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);
  if (error) throw new Error(`deleteCloudConnection: ${error.message}`);
  return true;
}

// ── 서비스 품질 관측 + 선택형 제품 분석 ───────────────────────────────────────
// 입력 원문·파일명·사용자 메모·생성 본문은 이 계층에 전달하지 않는다.
const TELEMETRY_MISSING_RE =
  /relation .*?(generation_runs|product_events|report_quality_feedback|privacy_consent_logs|admin_audit_logs).*? does not exist|could not find the table|column .*?analytics_consent/i;

function isTelemetrySchemaMissing(error) {
  return TELEMETRY_MISSING_RE.test(String(error && error.message ? error.message : error));
}

async function recordGenerationRun(row) {
  const c = getClient();
  if (!c || !row || !row.request_id) return false;
  try {
    const { error } = await c
      .from("generation_runs")
      .upsert(row, { onConflict: "request_id" });
    if (error) throw error;
    return true;
  } catch (error) {
    if (isTelemetrySchemaMissing(error)) return false;
    console.warn("[telemetry] generation run:", error.message);
    return false;
  }
}

async function updateGenerationRun(jobId, patch) {
  const c = getClient();
  if (!c || !jobId || !patch) return false;
  try {
    const { error } = await c
      .from("generation_runs")
      .update(patch)
      .eq("job_id", String(jobId));
    if (error) throw error;
    return true;
  } catch (error) {
    if (isTelemetrySchemaMissing(error)) return false;
    console.warn("[telemetry] generation update:", error.message);
    return false;
  }
}

async function recordGenerationDelivery(jobId, kind) {
  const c = getClient();
  if (!c || !jobId || !["preview", "download"].includes(kind)) return false;
  try {
    const { data, error } = await c.rpc("record_generation_delivery", {
      p_job_id: String(jobId),
      p_kind: kind,
    });
    if (error) throw error;
    return !!data;
  } catch (error) {
    if (/PGRST202|42883|does not exist|could not find the function/i.test(error.message || "")) {
      return false;
    }
    console.warn("[telemetry] delivery:", error.message);
    return false;
  }
}

async function recordProductEvents(userId, events, consentVersion) {
  const c = getClient();
  if (!c || !userId || !Array.isArray(events) || !events.length) return 0;
  const rows = events.map((event) => ({
    ...event,
    user_id: userId,
    consent_version: String(consentVersion || "").slice(0, 40),
  }));
  try {
    const { error } = await c
      .from("product_events")
      .upsert(rows, { onConflict: "event_id", ignoreDuplicates: true });
    if (error) throw error;
    return rows.length;
  } catch (error) {
    if (isTelemetrySchemaMissing(error)) return 0;
    console.warn("[telemetry] product events:", error.message);
    return 0;
  }
}

async function upsertQualityFeedback({ userId, jobId, reportType, score, disposition, tags }) {
  const c = getClient();
  if (!c || !userId || !jobId) return false;
  try {
    const { error } = await c.from("report_quality_feedback").upsert(
      {
        user_id: userId,
        job_id: String(jobId),
        report_type: String(reportType || "unknown").slice(0, 80),
        score,
        disposition,
        tags,
      },
      { onConflict: "user_id,job_id" },
    );
    if (error) throw error;
    return true;
  } catch (error) {
    if (isTelemetrySchemaMissing(error)) return false;
    throw new Error(`upsertQualityFeedback: ${error.message}`);
  }
}

async function getGenerationRunForUser(jobId, userId) {
  const c = getClient();
  if (!c || !jobId || !userId) return null;
  try {
    const { data, error } = await c
      .from("generation_runs")
      .select("job_id, user_id, report_type, status")
      .eq("job_id", String(jobId))
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (error) {
    if (isTelemetrySchemaMissing(error)) return null;
    throw new Error(`getGenerationRunForUser: ${error.message}`);
  }
}

async function recordPrivacyConsent({ userId, granted, policyVersion }) {
  const c = getClient();
  if (!c || !userId) return false;
  try {
    const { error } = await c.from("privacy_consent_logs").insert({
      user_id: userId,
      consent_type: "product_analytics",
      granted: !!granted,
      policy_version: String(policyVersion || "").slice(0, 40),
    });
    if (error) throw error;
    return true;
  } catch (error) {
    if (isTelemetrySchemaMissing(error)) return false;
    console.warn("[privacy] consent log:", error.message);
    return false;
  }
}

async function recordAdminAudit(row) {
  const c = getClient();
  if (!c || !row || !row.request_id) return false;
  try {
    const { error } = await c.from("admin_audit_logs").insert(row);
    if (error) throw error;
    return true;
  } catch (error) {
    if (isTelemetrySchemaMissing(error)) return false;
    console.warn("[audit] admin:", error.message);
    return false;
  }
}

async function getAnalyticsSummary(days = 30, { excludeReportTypes = [] } = {}) {
  const c = getClient();
  const safeDays = Math.min(90, Math.max(1, Math.trunc(Number(days) || 30)));
  if (!c) return aggregateAnalytics({ days: safeDays });
  const excluded = new Set(
    [...excludeReportTypes]
      .map((type) => String(type || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const visible = (row) => {
    const type = String(
      row?.report_type || row?.properties?.reportType || row?.properties?.report_type || "",
    )
      .trim()
      .toLowerCase();
    return !excluded.has(type);
  };
  const cutoff = new Date(Date.now() - safeDays * 86400000).toISOString();
  try {
    const [runsResult, eventsResult, feedbackResult] = await Promise.all([
      c
        .from("generation_runs")
        .select("accepted,status,report_type,model,total_ms,queue_ms,generation_ms,build_ms,validation_ms,storage_ms,error_phase,error_code,preview_count,download_count")
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(10000),
      c
        .from("product_events")
        .select("event_name,properties")
        .gte("received_at", cutoff)
        .order("received_at", { ascending: false })
        .limit(10000),
      c
        .from("report_quality_feedback")
        .select("score,disposition,tags,report_type")
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(10000),
    ]);
    const firstError = runsResult.error || eventsResult.error || feedbackResult.error;
    if (firstError) throw firstError;
    return aggregateAnalytics({
      days: safeDays,
      runs: (runsResult.data || []).filter(visible),
      events: (eventsResult.data || []).filter(visible),
      feedback: (feedbackResult.data || []).filter(visible),
    });
  } catch (error) {
    if (isTelemetrySchemaMissing(error)) return aggregateAnalytics({ days: safeDays });
    throw new Error(`getAnalyticsSummary: ${error.message}`);
  }
}

async function cleanupProductTelemetry() {
  const c = getClient();
  if (!c) return null;
  try {
    const { data, error } = await c.rpc("cleanup_product_telemetry");
    if (error) throw error;
    return data || {};
  } catch (error) {
    if (/PGRST202|42883|does not exist|could not find the function/i.test(error.message || "")) {
      return null;
    }
    console.warn("[telemetry] cleanup:", error.message);
    return null;
  }
}

// ── BYOK 사용자 API 키(user_api_keys) ───────────────────────────────────────────
// key_enc 는 lib/byok.js 의 AES-256-GCM 암호문 — 평문 키는 DB에 저장하지 않는다.
const USER_KEYS_MISSING_RE =
  /relation .*user_api_keys.* does not exist|could not find the table/i;

async function listUserApiKeys(userId) {
  if (!userId) return [];
  const { data, error } = await getClient()
    .from("user_api_keys")
    .select("provider, key_enc, hint, created_at, updated_at")
    .eq("user_id", userId);
  if (error) {
    if (USER_KEYS_MISSING_RE.test(error.message)) return []; // 마이그레이션 전 → 기능 없음으로 동작
    throw new Error(`listUserApiKeys: ${error.message}`);
  }
  return data || [];
}

async function setUserApiKey(userId, provider, keyEnc, hint) {
  const { error } = await getClient()
    .from("user_api_keys")
    .upsert(
      {
        user_id: userId,
        provider,
        key_enc: keyEnc,
        hint: String(hint || "").slice(0, 8),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,provider" },
    );
  if (error) {
    if (USER_KEYS_MISSING_RE.test(error.message)) {
      const e = new Error(
        "BYOK 테이블이 없습니다. db/migrations 의 20260702_add_user_api_keys.sql 을 Supabase에 실행하세요.",
      );
      e.code = "USER_KEYS_TABLE_MISSING";
      throw e;
    }
    throw new Error(`setUserApiKey: ${error.message}`);
  }
  return true;
}

async function deleteUserApiKey(userId, provider) {
  const { error } = await getClient()
    .from("user_api_keys")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);
  if (error && !USER_KEYS_MISSING_RE.test(error.message)) {
    throw new Error(`deleteUserApiKey: ${error.message}`);
  }
  return true;
}

module.exports = {
  isEnabled,
  getClient,
  listUserApiKeys,
  setUserApiKey,
  deleteUserApiKey,
  findUserByName,
  findUserByUsername,
  findUserByEmail,
  findUserById,
  isReportEligible,
  isMultiVerifyEmail,
  setEmailVerification,
  verifyEmailToken,
  setPasswordReset,
  clearPasswordReset,
  consumePasswordReset,
  setApproved,
  normalizeBlockedTypes,
  getBlockedReportTypes,
  listBlockedReportTypesMap,
  listBetaFeatures,
  createBetaFeature,
  ensureBetaFeature,
  getAppSetting,
  setAppSetting,
  setBetaFeatureEnabled,
  deleteBetaFeature,
  addBetaTester,
  removeBetaTester,
  getUserBetaFeatures,
  userHasBeta,
  getActiveGrant,
  listGrants,
  createGrant,
  revokeGrant,
  getActiveBackgroundSub,
  listBackgroundSubs,
  createBackgroundSub,
  revokeBackgroundSub,
  createPremiumRequest,
  listPremiumRequests,
  getPremiumRequest,
  decidePremiumRequest,
  createSchoolApplication,
  listSchoolApplications,
  getSchoolApplication,
  getSchoolApplicationFile,
  decideSchoolApplication,
  upsertReportJob,
  listReportJobs,
  getReportJob,
  listApiRequestLogs,
  reconcileRunningJobs,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  authenticate,
  verifyUserPassword,
  checkCreditBalance,
  deductCredit,
  topupCredit,
  getCredits,
  spendCredits,
  reserveCredits,
  settleCreditReservation,
  refundCreditReservation,
  touchCreditReservation,
  reconcileCreditReservations,
  refundCredits,
  addCredits,
  recordUsage,
  listUsageLogs,
  listUsageLogsForUser,
  recordLogin,
  listLoginLogs,
  recordGenerationRun,
  updateGenerationRun,
  recordGenerationDelivery,
  recordProductEvents,
  upsertQualityFeedback,
  getGenerationRunForUser,
  recordPrivacyConsent,
  recordAdminAudit,
  getAnalyticsSummary,
  cleanupProductTelemetry,
  reportStorageConfig,
  saveReportFile,
  listReportFiles,
  downloadReportFile,
  deleteReportFile,
  cleanupExpiredReportFiles,
  recordFeedback,
  listFeedback,
  saveCloudConnection,
  getCloudConnection,
  deleteCloudConnection,
  ping,
};
