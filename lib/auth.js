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

module.exports = { hashPassword, verifyPassword };
