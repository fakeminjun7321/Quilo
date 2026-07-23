import assert from "node:assert/strict";
import test from "node:test";
import { createFileToken, verifyFileToken } from "./file-tokens.js";

const secret = "test-secret-long-enough-for-file-token";
const now = new Date("2026-07-16T00:00:00.000Z");

test("파일 토큰은 파일 ID를 숨기고 만료 전 검증된다", () => {
  const token = createFileToken("private-file-id", secret, { now, ttlSeconds: 60 });
  assert.equal(token.includes("private-file-id"), false);
  const result = verifyFileToken(token, secret, { now: new Date(now.getTime() + 59_000) });
  assert.equal(result.fileId, "private-file-id");
});

test("변조되거나 만료된 파일 토큰은 거부한다", () => {
  const token = createFileToken("file-id", secret, { now, ttlSeconds: 60 });
  assert.throws(() => verifyFileToken(`${token}x`, secret, { now }), /올바르지 않은/);
  assert.throws(() => verifyFileToken(token, secret, { now: new Date(now.getTime() + 61_000) }), /만료/);
});
