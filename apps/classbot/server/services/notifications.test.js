import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "../store/memory-store.js";
import { NotificationService } from "./notifications.js";

const config = { classCode: "2-4", className: "2학년 4반", timezone: "Asia/Seoul" };

function activateTwo(store) {
  store.members[0].status = "active";
  store.members[0].kakao_user_key = "user-a";
  store.members[1].status = "active";
  store.members[1].kakao_user_key = "user-b";
}

test("Kakao task 부분 실패를 구성원별 sent/failed로 확정한다", async () => {
  const store = new MemoryStore(config);
  activateTwo(store);
  const kakaoClient = {
    enabled: true,
    async send({ users }) {
      assert.equal(users.length, 2);
      return { status: "SUCCESS", taskId: "task-partial" };
    },
    async getTask(taskId) {
      assert.equal(taskId, "task-partial");
      return {
        taskID: taskId,
        status: "1 FAIL",
        allRequestCount: 2,
        successCount: 1,
        fail: { count: 1, list: [{ userID: "user-b", errorMsg: "채널 친구가 아닙니다." }] },
      };
    },
  };
  const service = new NotificationService({ store, kakaoClient });
  const result = await service.dispatchTest({ message: "부분 실패 테스트", dryRun: false });
  assert.equal(result.status, "partial_failed");
  assert.equal(result.successCount, 1);
  assert.equal(result.failCount, 1);
  const records = await store.listNotifications({ limit: 10 });
  assert.equal(records.find((item) => item.member_id === store.members[0].id).status, "sent");
  assert.equal(records.find((item) => item.member_id === store.members[1].id).status, "failed");
  assert.match(records.find((item) => item.member_id === store.members[1].id).failure_reason, /친구/);
  assert.equal(records.some((item) => JSON.stringify(item.payload).includes("user-a")), false);
});

test("task 조회가 아직 준비되지 않으면 reserved 상태를 유지하고 다음 Cron에서 확정한다", async () => {
  const store = new MemoryStore(config);
  activateTwo(store);
  let ready = false;
  const kakaoClient = {
    enabled: true,
    async send() {
      return { status: "SUCCESS", taskId: "task-pending" };
    },
    async getTask() {
      if (!ready) throw new Error("결과 준비 중");
      return { taskID: "task-pending", status: "ALL SUCCESS", allRequestCount: 2, successCount: 2 };
    },
  };
  const service = new NotificationService({ store, kakaoClient });
  const first = await service.dispatchTest({ dryRun: false });
  assert.equal(first.status, "pending");
  assert.equal((await store.listNotifications({ status: "reserved" })).length, 2);

  ready = true;
  const reconciled = await service.reconcilePending();
  assert.equal(reconciled.results[0].status, "sent");
  assert.equal((await store.listNotifications({ status: "sent" })).length, 2);
});

test("동일 공지 revision은 재발송하지 않는다", async () => {
  const store = new MemoryStore(config);
  activateTwo(store);
  let sends = 0;
  const kakaoClient = {
    enabled: true,
    async send() {
      sends += 1;
      return { status: "SUCCESS", taskId: `task-${sends}` };
    },
    async getTask(taskId) {
      return { taskID: taskId, status: "ALL SUCCESS", allRequestCount: 2, successCount: 2 };
    },
  };
  const service = new NotificationService({ store, kakaoClient });
  const notice = await store.createNotice({ title: "공지", body: "본문", status: "published" });
  assert.equal((await service.dispatchNotice(notice)).status, "sent");
  assert.equal((await service.dispatchNotice(notice)).status, "duplicate");
  assert.equal(sends, 1);
});

test("일정 마감 변경은 새 idempotency key를 만들고 알림 비활성 일정은 제외한다", async () => {
  const store = new MemoryStore(config);
  activateTwo(store);
  store.events = [];
  const firstDue = new Date("2026-07-18T03:00:00.000Z");
  const event = await store.createEvent({
    title: "마감 변경 테스트",
    due_at: firstDue.toISOString(),
    reminder_offsets: [0],
    notify_on_change: true,
  });
  const service = new NotificationService({ store, kakaoClient: { enabled: false } });
  const firstBatch = (await service.buildDueBatches(firstDue)).find((batch) => batch.eventId === event.id);
  assert.ok(firstBatch.key.includes(firstDue.toISOString()));

  const secondDue = new Date(firstDue.getTime() + 3_600_000);
  await store.updateEvent(event.id, { due_at: secondDue.toISOString() });
  const secondBatch = (await service.buildDueBatches(secondDue)).find((batch) => batch.eventId === event.id);
  assert.notEqual(firstBatch.key, secondBatch.key);
  assert.ok(secondBatch.key.includes(secondDue.toISOString()));

  await store.updateEvent(event.id, { notify_on_change: false });
  assert.equal((await service.buildDueBatches(secondDue)).some((batch) => batch.eventId === event.id), false);
});

test("개인 일정 알림은 대상 한 명에게만, 반 전체 일정은 활성 구성원 모두에게 보낸다", async () => {
  const store = new MemoryStore(config);
  activateTwo(store);
  store.events = [];
  const dueAt = new Date("2026-07-18T03:00:00.000Z");
  const classwide = await store.createEvent({
    title: "반 전체 일정",
    due_at: dueAt.toISOString(),
    reminder_offsets: [0],
  });
  const personal = await store.createEvent({
    member_id: store.members[0].id,
    title: "홍길동 개인 일정",
    due_at: dueAt.toISOString(),
    reminder_offsets: [0],
  });
  const service = new NotificationService({ store, kakaoClient: { enabled: false } });
  const batches = await service.buildDueBatches(dueAt);
  assert.equal(batches.find((batch) => batch.eventId === classwide.id).recipients.length, 2);
  assert.deepEqual(
    batches.find((batch) => batch.eventId === personal.id).recipients.map((member) => member.id),
    [store.members[0].id],
  );
});

test("아침 시간표 요약은 반 전체와 본인 개인 일정만 포함해 구성원별로 만든다", async () => {
  const store = new MemoryStore(config);
  activateTwo(store);
  store.events = [];
  const dueAt = "2026-07-21T12:00:00+09:00";
  await store.createEvent({ title: "공통 준비", due_at: dueAt, notify_on_change: false });
  await store.createEvent({ member_id: store.members[0].id, title: "홍길동 준비", due_at: dueAt, notify_on_change: false });
  await store.createEvent({ member_id: store.members[1].id, title: "김학생 준비", due_at: dueAt, notify_on_change: false });
  const service = new NotificationService({ store, kakaoClient: { enabled: false } });
  const now = new Date("2026-07-20T22:00:00.000Z");
  const daily = (await service.buildDueBatches(now)).filter((batch) => batch.kind === "daily_digest");
  assert.equal(daily.length, 2);
  const first = daily.find((batch) => batch.recipients[0].id === store.members[0].id).message;
  const second = daily.find((batch) => batch.recipients[0].id === store.members[1].id).message;
  assert.match(first, /공통 준비/);
  assert.match(first, /홍길동 준비/);
  assert.doesNotMatch(first, /김학생 준비/);
  assert.match(second, /공통 준비/);
  assert.match(second, /김학생 준비/);
  assert.doesNotMatch(second, /홍길동 준비/);
});

test("taskId 없는 오래된 reserved 알림을 orphan으로 노출하고 failed로 전환한다", async () => {
  const store = new MemoryStore(config);
  activateTwo(store);
  const [reserved] = await store.reserveNotifications([
    {
      member_id: store.members[0].id,
      event_id: null,
      notice_id: null,
      idempotency_key: "orphan:test:1",
      kind: "test",
      scheduled_for: new Date().toISOString(),
      payload: { message: "고아 예약" },
    },
  ]);
  store.notifications.find((item) => item.id === reserved.id).created_at = new Date(Date.now() - 11 * 60_000).toISOString();
  const service = new NotificationService({ store, kakaoClient: { enabled: false } });
  const result = await service.reconcilePending();
  assert.equal(result.orphanCount, 1);
  assert.equal(result.orphans[0].id, reserved.id);
  assert.equal((await store.getNotification(reserved.id)).status, "failed");
  assert.match((await store.getNotification(reserved.id)).failure_reason, /자동 재시도하지 않았습니다/);
});

test("failed 알림은 관리자 키가 있는 명시적 재시도만 허용하고 같은 키는 중복 발송하지 않는다", async () => {
  const store = new MemoryStore(config);
  activateTwo(store);
  const [original] = await store.reserveNotifications([
    {
      member_id: store.members[0].id,
      event_id: null,
      notice_id: null,
      idempotency_key: "failed:original:1",
      kind: "test",
      scheduled_for: new Date().toISOString(),
      payload: { message: "명시적 재시도" },
    },
  ]);
  await store.markNotifications([original.id], { status: "failed", failure_reason: "테스트 실패" });
  const failedNotification = await store.getNotification(original.id);
  let sends = 0;
  const kakaoClient = {
    enabled: true,
    async send() {
      sends += 1;
      return { status: "SUCCESS", taskId: "retry-task" };
    },
    async getTask() {
      return { taskID: "retry-task", status: "ALL SUCCESS", allRequestCount: 1, successCount: 1 };
    },
  };
  const service = new NotificationService({ store, kakaoClient });
  await assert.rejects(service.retryFailed(failedNotification), /중복 방지 키/);
  assert.equal((await service.retryFailed(failedNotification, { retryKey: "admin-retry-0001" })).status, "sent");
  assert.equal((await service.retryFailed(failedNotification, { retryKey: "admin-retry-0001" })).status, "duplicate");
  assert.equal(sends, 1);
});
