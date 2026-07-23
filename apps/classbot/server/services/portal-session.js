import crypto from "node:crypto";

export const PORTAL_COOKIE_NAME = "classbot_portal";
export const PORTAL_SESSION_SECONDS = 30 * 24 * 60 * 60;

const TOKEN_VERSION = "p1";

function signature(payload, secret) {
  return crypto
    .createHmac("sha256", String(secret || ""))
    .update(`${TOKEN_VERSION}.${payload}`)
    .digest("base64url");
}

function invalidToken() {
  return new Error("올바르지 않은 학생 포털 세션입니다.");
}

export function createPortalToken(memberId, secret, options = {}) {
  const subject = String(memberId || "").trim();
  if (!subject || subject.length > 128) throw new Error("학생 식별값이 필요합니다.");
  if (!secret) throw new Error("학생 포털 세션 비밀키가 필요합니다.");

  const ttlSeconds = Number(options.ttlSeconds ?? PORTAL_SESSION_SECONDS);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > PORTAL_SESSION_SECONDS) {
    throw new Error("학생 포털 세션 유효시간이 올바르지 않습니다.");
  }
  const now = options.now instanceof Date ? options.now : new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload = Buffer.from(JSON.stringify({ sub: subject, iat: issuedAt, exp: issuedAt + ttlSeconds }))
    .toString("base64url");
  return `${TOKEN_VERSION}.${payload}.${signature(payload, secret)}`;
}

export function verifyPortalToken(token, secret, options = {}) {
  const [version, payload, supplied, extra] = String(token || "").split(".");
  if (version !== TOKEN_VERSION || !payload || !supplied || extra || !secret) throw invalidToken();

  const expected = signature(payload, secret);
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    throw invalidToken();
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw invalidToken();
  }
  const now = Math.floor((options.now instanceof Date ? options.now : new Date()).getTime() / 1000);
  if (
    !decoded?.sub
    || String(decoded.sub).length > 128
    || !Number.isInteger(decoded.iat)
    || !Number.isInteger(decoded.exp)
    || decoded.iat > now + 60
    || decoded.exp <= now
    || decoded.exp <= decoded.iat
    || decoded.exp - decoded.iat > PORTAL_SESSION_SECONDS
  ) {
    throw invalidToken();
  }
  return {
    memberId: String(decoded.sub),
    issuedAt: new Date(decoded.iat * 1000),
    expiresAt: new Date(decoded.exp * 1000),
  };
}

export function readPortalCookie(cookieHeader) {
  for (const part of String(cookieHeader || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== PORTAL_COOKIE_NAME) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

export function portalCookieOptions({ embedded = false, production = false } = {}) {
  return {
    httpOnly: true,
    secure: production,
    sameSite: "lax",
    path: embedded ? "/schedule" : "/",
    maxAge: PORTAL_SESSION_SECONDS * 1000,
  };
}
