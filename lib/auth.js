// 비밀번호 해시·검증 (Node 내장 crypto.scrypt 사용)
const crypto = require("crypto");

const KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * Hash a plaintext password. Returns a string "salt:hash" (hex).
 */
function hashPassword(password) {
  if (!password || typeof password !== "string") {
    throw new Error("password가 비어있습니다.");
  }
  const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Verify a plaintext password against a stored "salt:hash" string.
 */
function verifyPassword(password, stored) {
  if (!password || !stored || typeof stored !== "string") return false;
  const idx = stored.indexOf(":");
  if (idx === -1) return false;
  const salt = stored.slice(0, idx);
  const hashHex = stored.slice(idx + 1);
  // Buffer.from(value, "hex") silently truncates malformed hex. Validate the
  // exact on-disk format before timingSafeEqual so a damaged legacy row cannot
  // turn a failed login into a RangeError/500.
  if (!/^[0-9a-f]{32}$/i.test(salt) || !/^[0-9a-f]{128}$/i.test(hashHex)) {
    return false;
  }
  let testHex;
  try {
    testHex = crypto.scryptSync(password, salt, KEYLEN).toString("hex");
  } catch {
    return false;
  }
  if (testHex.length !== hashHex.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(hashHex, "hex"),
    Buffer.from(testHex, "hex"),
  );
}

// ── 이메일 인증 토큰 ──────────────────────────────────────────────────────────
// 원문 토큰은 메일 링크로만 나가고, DB 에는 sha256 해시만 저장한다(토큰 유출 시
// DB 노출만으로 인증이 통과되지 않게).

/** URL-safe 랜덤 토큰(원문). 메일 링크에 들어간다. */
function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

/** 원문 토큰을 DB 저장/비교용 해시로. */
function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || ""))
    .digest("hex");
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  hashToken,
};
