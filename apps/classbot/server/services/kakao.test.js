import assert from "node:assert/strict";
import test from "node:test";
import { KakaoEventClient, personalizedQuickReplies, registeredQuickReplies, templateResponse } from "./kakao.js";

const config = {
  enabled: true,
  botId: "bot-id",
  restApiKey: "rest-key",
  eventName: "quilo_schedule_notification",
  apiBase: "https://bot-api.kakao.com",
};

test("Event API 대상 중복을 제거하고 문자열 event.data만 보낸다", async () => {
  let requestBody;
  let requestSignal;
  const client = new KakaoEventClient(config, async (_url, options) => {
    requestBody = JSON.parse(options.body);
    requestSignal = options.signal;
    return new Response(JSON.stringify({ status: "SUCCESS", taskId: "task-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const result = await client.send({
    users: [
      { type: "botUserKey", id: "user-1" },
      { type: "botUserKey", id: "user-1" },
    ],
    data: { message: "안내", kind: "notice" },
  });
  assert.equal(result.taskId, "task-1");
  assert.equal(requestBody.user.length, 1);
  assert.deepEqual(requestBody.event.data, { message: "안내", kind: "notice" });
  assert.equal(requestSignal instanceof AbortSignal, true);
});

test("Event API 사용자 타입, 인원수, data 타입을 발송 전에 검증한다", async () => {
  const client = new KakaoEventClient(config, async () => {
    throw new Error("fetch should not run");
  });
  await assert.rejects(
    client.send({ users: [{ type: "unknown", id: "x" }], data: { message: "x" } }),
    /사용자 키 타입/,
  );
  await assert.rejects(
    client.send({ users: Array.from({ length: 101 }, (_, i) => ({ type: "botUserKey", id: `u-${i}` })), data: { message: "x" } }),
    /최대 100명/,
  );
  await assert.rejects(
    client.send({ users: [{ type: "botUserKey", id: "x" }], data: { count: 1 } }),
    /모두 문자열/,
  );
});

test("스킬 응답 output은 최대 3개로 제한하고 개인화 Quick Reply는 자료 목록을 포함해 5개다", () => {
  const outputs = Array.from({ length: 5 }, (_, index) => ({ simpleText: { text: String(index) } }));
  const response = templateResponse(outputs, personalizedQuickReplies("홍길동"));
  assert.equal(response.template.outputs.length, 3);
  assert.equal(response.template.quickReplies.length, 5);
  assert.equal(response.template.quickReplies.at(-1).messageText, "자료 목록 홍길동");
  assert.equal(response.template.quickReplies.every((item) => item.messageText.endsWith("홍길동")), true);
});

test("이름등록이 끝난 요청자용 Quick Reply는 이름 suffix 없이 5개다", () => {
  const replies = registeredQuickReplies();
  assert.deepEqual(replies.map((item) => item.messageText), [
    "오늘 브리핑",
    "오늘 일정",
    "다음 일정",
    "시간표 전체",
    "파일 리스트",
  ]);
});
