import crypto from "node:crypto";

const DEFAULT_TTL_SECONDS = 15 * 60;

function signature(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createFileToken(fileId, secret, options = {}) {
  const id = String(fileId || "").trim();
  if (!id) throw new Error("파일 식별값이 필요합니다.");
  const ttlSeconds = Number(options.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) {
    throw new Error("파일 링크 유효시간이 올바르지 않습니다.");
  }
  const now = options.now instanceof Date ? options.now : new Date();
  const payload = Buffer.from(JSON.stringify({ id, exp: Math.floor(now.getTime() / 1000) + ttlSeconds })).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyFileToken(token, secret, options = {}) {
  const [payload, supplied, extra] = String(token || "").split(".");
  if (!payload || !supplied || extra) throw new Error("올바르지 않은 파일 링크입니다.");
  const expected = signature(payload, secret);
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    throw new Error("올바르지 않은 파일 링크입니다.");
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("올바르지 않은 파일 링크입니다.");
  }
  const now = options.now instanceof Date ? options.now : new Date();
  if (!decoded?.id || !Number.isInteger(decoded.exp) || decoded.exp <= Math.floor(now.getTime() / 1000)) {
    throw new Error("파일 링크가 만료되었습니다. 챗봇에서 다시 요청해 주세요.");
  }
  return { fileId: String(decoded.id), expiresAt: new Date(decoded.exp * 1000) };
}
