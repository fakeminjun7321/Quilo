import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "../store/memory-store.js";
import { getDaySchedule, getWeekTimetable } from "./schedule.js";

const config = { classCode: "2-4", className: "2학년 4반", timezone: "Asia/Seoul" };
const wednesday = new Date("2026-07-15T03:00:00.000Z");

test("대상 구성원의 개인 시간표를 우선하고 개인 행이 없으면 반 시간표로 폴백한다", async () => {
  const store = new MemoryStore(config);
  const member = store.members[0];
  const otherMember = store.members[1];
  await store.replaceMemberTimetable({
    memberId: member.id,
    rows: [{ weekday: 3, period: 1, subject: "개인 선택 수업", effective_from: "2026-03-01" }],
  });

  const personal = await getDaySchedule(store, wednesday, { targetMemberId: member.id });
  const fallback = await getDaySchedule(store, wednesday, { targetMemberId: otherMember.id });

  assert.equal(personal.timetable[0].subject, "개인 선택 수업");
  assert.equal(fallback.timetable[0].subject, "물리학");
});

test("주간 개인 시간표는 개인 행이 등록된 요일만 덮어쓰고 나머지는 반 시간표를 유지한다", async () => {
  const store = new MemoryStore(config);
  const member = store.members[0];
  await store.replaceMemberTimetable({
    memberId: member.id,
    rows: [{ weekday: 1, period: 1, subject: "월요일 개인 수업", effective_from: "2026-03-01" }],
  });

  const bundle = await getWeekTimetable(store, wednesday, { targetMemberId: member.id });
  assert.equal(bundle.days[0].rows[0].subject, "월요일 개인 수업");
  assert.equal(bundle.days[1].rows[0].subject, "영어");
});

test("개인 시간표 저장은 구성원별로 격리하고 조회일에 유효한 최신 버전만 선택한다", async () => {
  const store = new MemoryStore(config);
  const member = store.members[0];
  const otherMember = store.members[1];
  await store.replaceMemberTimetable({
    memberId: member.id,
    rows: [
      { weekday: 3, period: 1, subject: "1학기 수업", effective_from: "2026-03-01", effective_to: "2026-07-31" },
      { weekday: 3, period: 1, subject: "2학기 수업", effective_from: "2026-08-01" },
    ],
  });

  assert.equal((await store.listMemberTimetable(member.id, { date: "2026-07-15" }))[0].subject, "1학기 수업");
  assert.equal((await store.listMemberTimetable(member.id, { date: "2026-08-15" }))[0].subject, "2학기 수업");
  assert.deepEqual(await store.listMemberTimetable(otherMember.id, { date: "2026-08-15" }), []);
});

test("개인 시간표 교체는 중복 교시와 잘못된 적용 기간을 거부한다", async () => {
  const store = new MemoryStore(config);
  const memberId = store.members[0].id;
  await assert.rejects(
    store.replaceMemberTimetable({
      memberId,
      rows: [
        { weekday: 1, period: 1, subject: "수학", effective_from: "2026-08-01" },
        { weekday: 1, period: 1, subject: "영어", effective_from: "2026-08-01" },
      ],
    }),
    /동일 교시/,
  );
  await assert.rejects(
    store.replaceMemberTimetable({
      memberId,
      rows: [{ weekday: 1, period: 1, subject: "수학", effective_from: "2026-09-01", effective_to: "2026-08-01" }],
    }),
    /종료일/,
  );
});
