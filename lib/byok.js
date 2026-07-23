// BYOK(Bring Your Own Key) — 사용자가 등록한 본인 API 키로 AI 를 호출하는 컨텍스트.
//
// 흐름: 사용자가 개인 설정에서 키 등록(user_api_keys, AES-256-GCM 암호화 저장)
//   → /api/generate·스튜디오가 요청 단위로 run(keys, fn) 으로 감싸면
//   → 파이프라인/헬퍼는 anthropicKey()/openaiKey() 로 "사용자 키 우선, 없으면 서버 env 키"를 얻는다.
// 등록된 제공자의 호출은 크레딧을 차감하지 않는다(차감 면제 판단은 호출부에서 activeProvider 로).
//
// 주의:
// - 복호 실패(시크릿 회전·손상)는 '키 없음'으로 취급한다 — 사용자에게 재등록 안내.
// - 키를 로그·job 영속화(persistBgJob)·응답에 절대 싣지 않는다.
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();

// 암호화 시크릿: USER_KEY_SECRET 우선, 없으면 운영 키에서 결정적으로 파생(SESSION_SECRET 방식과 동일).
function secret() {
  const seed =
    process.env.USER_KEY_SECRET ||
    `quilo-user-keys:${
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      "dev-only"
    }`;
  return crypto.createHash("sha256").update(seed).digest();
}

function encryptKey(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", secret(), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

function decryptKey(payload) {
  try {
    const [v, ivB, tagB, dataB] = String(payload || "").split(":");
    if (v !== "v1" || !ivB || !tagB || !dataB) return null;
    const d = crypto.createDecipheriv(
      "aes-256-gcm",
      secret(),
      Buffer.from(ivB, "base64"),
    );
    d.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([
      d.update(Buffer.from(dataB, "base64")),
      d.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

// 요청/작업 단위 컨텍스트. keys = { anthropic?, openai? } (null 허용).
function run(keys, fn) {
  const k = keys || {};
  return als.run({ anthropic: k.anthropic || null, openai: k.openai || null }, fn);
}

function ctx() {
  return als.getStore() || {};
}

// 사용자 키 우선, 없으면 서버 env 키.
function anthropicKey() {
  return ctx().anthropic || process.env.ANTHROPIC_API_KEY || "";
}
function openaiKey() {
  return (
    ctx().openai || process.env.GPT_API_KEY || process.env.OPENAI_API_KEY || ""
  );
}

// 이 모델 호출이 어느 제공자 키를 쓰는지 (크레딧 면제 판단용).
function activeProvider(model) {
  const m = String(model || "");
  if (/^gpt/i.test(m)) return "openai";
  // Gemini 는 BYOK 미지원(loadUserKeys 는 anthropic/openai 만 반환)이지만,
  // anthropic 으로 오분류하면 사용자의 anthropic BYOK 키로 크레딧이 잘못 면제된다.
  // 별도 provider 로 반환해 byokActive 가 false 가 되게 한다.
  if (/^gemini/i.test(m)) return "gemini";
  return "anthropic";
}

// 사용자 등록 키 로드(복호까지). supa 를 주입받아 순환 require 를 피한다.
// 반환: { anthropic?, openai? } 또는 null(등록 없음/테이블 없음/복호 실패).
async function loadUserKeys(supa, userId) {
  if (!supa || !supa.isEnabled() || !userId) return null;
  let rows;
  try {
    rows = await supa.listUserApiKeys(userId);
  } catch {
    return null;
  }
  const out = {};
  for (const r of rows || []) {
    const k = decryptKey(r.key_enc);
    if (k && (r.provider === "anthropic" || r.provider === "openai")) {
      out[r.provider] = k;
    }
  }
  return out.anthropic || out.openai ? out : null;
}

module.exports = {
  run,
  anthropicKey,
  openaiKey,
  activeProvider,
  encryptKey,
  decryptKey,
  loadUserKeys,
};
