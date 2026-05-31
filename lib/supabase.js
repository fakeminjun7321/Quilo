// Supabase 클라이언트 + DB 헬퍼.
// SUPABASE_URL + SUPABASE_SERVICE_KEY 환경변수가 모두 있으면 동작.
// 없으면 isEnabled() === false → 호출자가 fallback 처리.

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const { hashPassword, verifyPassword } = require("./auth");

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
  const { data, error } = await c
    .from("users")
    .select("*")
    .ilike("name", name)
    .maybeSingle();
  if (error) throw new Error(`findUserByName: ${error.message}`);
  return data;
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

async function listUsers() {
  const c = getClient();
  if (!c) return [];
  // 새 credit 컬럼 포함해서 시도. 컬럼이 없으면 (SQL 미실행) fallback.
  const fullCols =
    "id, name, budget_usd, spent_usd, pre_credits_usd, result_credits_usd, is_admin, created_at, updated_at";
  let { data, error } = await c
    .from("users")
    .select(fullCols)
    .order("created_at", { ascending: true });
  if (error) {
    // 새 컬럼이 DB에 없는 경우 — fallback으로 기본 컬럼만 select
    console.warn("[listUsers] credit 컬럼 없음, fallback 사용:", error.message);
    const r2 = await c
      .from("users")
      .select(
        "id, name, budget_usd, spent_usd, is_admin, created_at, updated_at",
      )
      .order("created_at", { ascending: true });
    if (r2.error) throw new Error(`listUsers: ${r2.error.message}`);
    data = (r2.data || []).map((u) => ({
      ...u,
      pre_credits_usd: 0,
      result_credits_usd: 0,
    }));
  }
  return data || [];
}

async function createUser({
  name,
  password,
  budgetUsd,
  preCreditsUsd = 0,
  resultCreditsUsd = 0,
  isAdmin = false,
  studentId = "",
}) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const password_hash = hashPassword(password);
  const { data, error } = await c
    .from("users")
    .insert({
      name,
      password_hash,
      student_id: String(studentId || "").trim(),
      budget_usd: Number(budgetUsd) || 0,
      pre_credits_usd: Number(preCreditsUsd) || 0,
      result_credits_usd: Number(resultCreditsUsd) || 0,
      is_admin: !!isAdmin,
    })
    .select()
    .single();
  if (error) throw new Error(`createUser: ${error.message}`);
  return data;
}

async function updateUser(id, patch) {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");
  const update = {};
  if (patch.name != null) update.name = patch.name;
  if (patch.studentId != null)
    update.student_id = String(patch.studentId || "").trim().slice(0, 20);
  if (patch.password != null && patch.password !== "")
    update.password_hash = hashPassword(patch.password);
  if (patch.budgetUsd != null) update.budget_usd = Number(patch.budgetUsd);
  if (patch.isAdmin != null) update.is_admin = !!patch.isAdmin;
  if (patch.spentUsd != null) update.spent_usd = Number(patch.spentUsd);
  if (patch.preCreditsUsd != null)
    update.pre_credits_usd = Number(patch.preCreditsUsd);
  if (patch.resultCreditsUsd != null)
    update.result_credits_usd = Number(patch.resultCreditsUsd);
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

async function authenticate(name, password) {
  const user = await findUserByName(name);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
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
  const user = await findUserById(userId);
  if (!user) throw new Error("사용자를 찾을 수 없습니다.");
  const current = Number(user[colName]) || 0;
  const newBalance = current + Number(addUsd);
  const { error } = await c
    .from("users")
    .update({ [colName]: newBalance })
    .eq("id", userId);
  if (error) throw new Error(`topupCredit: ${error.message}`);
  return { newBalance };
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

async function ensureReportBucket() {
  const c = getClient();
  if (!c) throw new Error("Supabase 미설정");

  const { error: getErr } = await c.storage.getBucket(REPORT_BUCKET);
  if (!getErr) return;

  const { error: createErr } = await c.storage.createBucket(REPORT_BUCKET, {
    public: false,
    fileSizeLimit: 50 * 1024 * 1024,
    allowedMimeTypes: [
      "application/hwp+zip",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  });
  if (createErr && !/already exists/i.test(createErr.message || "")) {
    throw new Error(`ensureReportBucket: ${createErr.message}`);
  }
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
    await c.storage.from(REPORT_BUCKET).remove([objectPath]).catch(() => {});
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

  await c.storage
    .from(row.bucket || REPORT_BUCKET)
    .remove([row.object_path])
    .catch(() => {});
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

  const byBucket = new Map();
  for (const row of rows) {
    const bucket = row.bucket || REPORT_BUCKET;
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket).push(row.object_path);
  }
  for (const [bucket, paths] of byBucket) {
    await c.storage.from(bucket).remove(paths).catch(() => {});
  }
  const ids = rows.map((row) => row.id);
  const { error: deleteErr } = await c.from("report_files").delete().in("id", ids);
  if (deleteErr) throw new Error(`cleanupExpiredReportFiles(delete): ${deleteErr.message}`);
  return { deleted: rows.length };
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
  const byBucket = new Map();
  for (const row of excess) {
    const bucket = row.bucket || REPORT_BUCKET;
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket).push(row.object_path);
  }
  for (const [bucket, paths] of byBucket) {
    await c.storage.from(bucket).remove(paths).catch(() => {});
  }

  const ids = excess.map((row) => row.id);
  const { error: deleteErr } = await c.from("report_files").delete().in("id", ids);
  if (deleteErr) throw new Error(`cleanupOverflowReportFiles(delete): ${deleteErr.message}`);
  return { deleted: excess.length };
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

// ── Admin bootstrap ──────────────────────────────────────────────────────────

/**
 * ADMIN_NAME, ADMIN_PASSWORD 환경변수가 있으면 admin 사용자를 보장한다.
 * 이미 있으면 비밀번호 갱신 안 함 (수동 변경 보존).
 * 없으면 새로 생성, is_admin = true, budget = 0 (admin은 본인 작업 안 한다고 가정 — 필요시 수동 조정).
 */
async function ensureAdminFromEnv() {
  if (!isEnabled()) return null;
  const name = (process.env.ADMIN_NAME || "").trim();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!name || !password) return null;
  if (password.length < 5) {
    console.warn(
      "⚠ ADMIN_PASSWORD가 5자 미만입니다. admin 계정 부트스트랩을 건너뜁니다.",
    );
    return null;
  }
  let admin = await findUserByName(name);
  if (admin) {
    // 권한만 보장 (이미 있으면 비번 보존)
    if (!admin.is_admin) {
      await updateUser(admin.id, { isAdmin: true });
    }
    return admin;
  }
  return await createUser({
    name,
    password,
    budgetUsd: 1000, // admin은 사실상 무제한 (본인 보고서 만들 일도 있을 수 있으니 큰 값)
    isAdmin: true,
  });
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

module.exports = {
  isEnabled,
  getClient,
  findUserByName,
  findUserById,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  authenticate,
  verifyUserPassword,
  checkCreditBalance,
  deductCredit,
  topupCredit,
  recordUsage,
  listUsageLogs,
  reportStorageConfig,
  saveReportFile,
  listReportFiles,
  downloadReportFile,
  deleteReportFile,
  cleanupExpiredReportFiles,
  recordFeedback,
  ensureAdminFromEnv,
  ping,
};
