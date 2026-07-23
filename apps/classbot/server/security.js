import crypto from "node:crypto";

export function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function hashInviteCode(code) {
  return crypto.createHash("sha256").update(String(code).trim().toUpperCase()).digest("hex");
}

export function createInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  const raw = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function requireAdmin(req, res, next) {
  if (req.session?.isAdmin === true) return next();
  return res.status(401).json({ error: "관리자 로그인이 필요합니다." });
}

export function createCronGuard(secret) {
  return (req, res, next) => {
    const auth = req.get("authorization") || "";
    if (auth.startsWith("Bearer ") && safeEqual(auth.slice(7), secret)) return next();
    return res.status(401).json({ error: "올바른 Cron 인증이 필요합니다." });
  };
}
