import assert from "node:assert/strict";
import test from "node:test";
import { getSeoulParts } from "../time.js";
import { MemoryStore } from "../store/memory-store.js";
import { handleKakaoCommand } from "./commands.js";

const config = { classCode: "2-4", className: "2학년 4반", timezone: "Asia/Seoul" };

function fixture() {
  const store = new MemoryStore(config);
  store.events = [];
  store.members[0].display_name = "홍길동";
  store.members[0].status = "active";
  store.members[0].kakao_user_key = "joined-hong";
  return store;
}

async function ask(store, utterance, { userId = "joined-hong", now = new Date() } = {}) {
  return handleKakaoCommand({
    store,
    now,
    payload: { userRequest: { utterance, user: { id: userId } } },
  });
}

function text(response) {
  return response.template.outputs[0].simpleText.text;
}

test("채팅 개인 일정 추가는 확인 전 저장하지 않고 10분 pending 확인 뒤 본인 일정만 만든다", async () => {
  const store = fixture();
  const now = new Date();
  const proposal = await ask(store, "내일 영어 과제 추가", { now });

  assert.equal(store.events.length, 0);
  assert.match(text(proposal), /개인 일정으로 추가할까요/);
  assert.match(text(proposal), /영어 과제/);
  assert.equal(proposal.template.quickReplies.length <= 5, true);
  assert.equal(proposal.template.quickReplies[0].messageText, "추가할게요");

  const pending = await store.getPendingKakaoAction(store.members[0].id);
  assert.equal(pending.action, "create");
  const remaining = new Date(pending.expires_at).getTime() - Date.now();
  assert.equal(remaining > 9 * 60 * 1000 && remaining <= 10 * 60 * 1000, true);

  const confirmed = await ask(store, "추가할게요", { now });
  assert.match(text(confirmed), /개인 일정을 추가했습니다/);
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0].member_id, store.members[0].id);
  assert.equal(store.events[0].category, "assignment");
  assert.equal(getSeoulParts(new Date(store.events[0].due_at)).hour, 23);
  assert.equal(await store.getPendingKakaoAction(store.members[0].id), null);
});

test("미등록 사용자는 개인 일정 변경을 시작할 수 없다", async () => {
  const store = fixture();
  const response = await ask(store, "내일 수학 시험 추가", { userId: "anonymous" });
  assert.match(text(response), /초대 코드로 먼저 가입/);
  assert.equal(store.events.length, 0);
});

test("공부 시간 분량의 '시간'을 시각으로 오인하지 않는다", async () => {
  const store = fixture();
  const proposal = await ask(store, "7월 20일 2시간 영어 공부 추가", {
    now: new Date("2026-07-16T03:00:00Z"),
  });
  assert.match(text(proposal), /2시간 영어 공부/);
  assert.match(text(proposal), /23:59/);

  await ask(store, "추가할게요");
  assert.equal(store.events[0].title, "2시간 영어 공부");
  assert.equal(getSeoulParts(new Date(store.events[0].due_at)).timeKey, "23:59");
});

test("제목 일정의 날짜 변경도 확인 후 적용하고 취소하면 원본을 유지한다", async () => {
  const store = fixture();
  const event = await store.createEvent({
    member_id: store.members[0].id,
    category: "assessment",
    title: "수학 수행평가",
    due_at: "2026-07-20T18:30:00+09:00",
  }, store.members[0].id);

  const proposal = await ask(store, "수학 수행평가 22일로 변경");
  assert.match(text(proposal), /7\. 20|7월 20일/);
  assert.match(text(proposal), /7\. 22|7월 22일/);
  assert.equal((await store.getEvent(event.id)).due_at, event.due_at);

  const cancelled = await ask(store, "취소");
  assert.match(text(cancelled), /취소했습니다/);
  assert.equal((await store.getEvent(event.id)).due_at, event.due_at);

  await ask(store, "수학 수행평가 22일로 변경", { now: new Date() });
  const confirmed = await ask(store, "변경할게요");
  assert.match(text(confirmed), /개인 일정을 변경했습니다/);
  const changed = getSeoulParts(new Date((await store.getEvent(event.id)).due_at));
  assert.equal(changed.day, 22);
  assert.equal(changed.timeKey, "18:30");
});

test("방금 일정 완료와 삭제는 본인 개인 일정만 대상으로 하고 각각 확인을 요구한다", async () => {
  const store = fixture();
  const classEvent = await store.createEvent({ title: "반 전체 일정", due_at: "2026-07-30T23:59:00+09:00" });
  const personal = await store.createEvent({ member_id: store.members[0].id, title: "내 개인 일정", due_at: "2026-07-21T23:59:00+09:00" }, store.members[0].id);

  const completion = await ask(store, "방금 일정 완료");
  assert.match(text(completion), /내 개인 일정/);
  assert.equal((await store.getEvent(personal.id)).status, "scheduled");
  await ask(store, "완료할게요");
  assert.equal((await store.getEvent(personal.id)).status, "completed");
  assert.equal((await store.getEvent(classEvent.id)).status, "scheduled");

  await ask(store, "방금 일정 삭제");
  assert.equal((await store.getEvent(personal.id)).status, "completed");
  await ask(store, "삭제할게요");
  assert.equal((await store.getEvent(personal.id)).status, "cancelled");
  assert.equal((await store.getEvent(classEvent.id)).status, "scheduled");
});

test("반 전체 일정은 이름이 같아도 카카오 개인 일정 명령으로 수정할 수 없다", async () => {
  const store = fixture();
  const classEvent = await store.createEvent({ title: "수학 수행평가", due_at: "2026-07-20T23:59:00+09:00" });
  const response = await ask(store, "수학 수행평가 22일로 변경", { now: new Date("2026-07-16T03:00:00Z") });
  assert.match(text(response), /본인 개인 일정을 찾을 수 없습니다/);
  assert.equal((await store.getEvent(classEvent.id)).due_at, classEvent.due_at);
  assert.equal(await store.getPendingKakaoAction(store.members[0].id), null);
});

test("10분이 지난 일정 변경 확인 상태는 실행하지 않고 만료한다", async () => {
  const store = fixture();
  await store.setPendingKakaoAction({
    memberId: store.members[0].id,
    action: "create",
    payload: {
      title: "만료된 과제",
      category: "assignment",
      due_at: "2026-07-30T14:59:00.000Z",
      request_key: "expired-request",
    },
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });

  const response = await ask(store, "추가할게요");
  assert.equal(store.events.length, 0);
  assert.equal(await store.getPendingKakaoAction(store.members[0].id), null);
  assert.doesNotMatch(text(response), /추가했습니다/);
});
