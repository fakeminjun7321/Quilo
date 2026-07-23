import assert from "node:assert/strict";
import test from "node:test";
import {
  createPortalToken,
  portalCookieOptions,
  PORTAL_COOKIE_NAME,
  readPortalCookie,
  verifyPortalToken,
} from "./portal-session.js";

const secret = "portal-test-secret-that-is-long-enough";
const now = new Date("2026-07-15T03:00:00.000Z");

test("학생 포털 토큰은 구성원과 30일 만료를 HMAC으로 보호한다", () => {
  const token = createPortalToken("member-1", secret, { now });
  const verified = verifyPortalToken(token, secret, { now: new Date(now.getTime() + 29 * 86_400_000) });
  assert.equal(verified.memberId, "member-1");
  assert.equal(verified.expiresAt.toISOString(), "2026-08-14T03:00:00.000Z");
  assert.throws(() => verifyPortalToken(`${token}x`, secret, { now }), /올바르지 않은/);
  assert.throws(
    () => verifyPortalToken(token, secret, { now: new Date(now.getTime() + 30 * 86_400_000) }),
    /올바르지 않은/,
  );
});

test("학생 포털 쿠키 helper는 mount 경로와 보안 속성을 고정한다", () => {
  assert.equal(PORTAL_COOKIE_NAME, "classbot_portal");
  assert.deepEqual(portalCookieOptions({ embedded: true, production: true }), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/schedule",
    maxAge: 30 * 86_400_000,
  });
  assert.equal(portalCookieOptions().path, "/");
  assert.equal(readPortalCookie("other=x; classbot_portal=abc.def; another=y"), "abc.def");
  assert.equal(readPortalCookie("other=x"), "");
});
