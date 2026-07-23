import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "../store/memory-store.js";
import { handleKakaoCommand } from "./commands.js";
import {
  buildTodayBriefing,
  isTodayBriefingCommand,
  rankBrowseFileCandidates,
  readFileBrowseSpec,
} from "./chatbot-read-features.js";

const config = { classCode: "2-4", className: "2학년 4반", timezone: "Asia/Seoul" };
const now = new Date("2026-07-15T03:00:00.000Z");

function fixture() {
  const store = new MemoryStore(config);
  const member = store.members[0];
  member.display_name = "홍길동";
  member.status = "active";
  member.kakao_user_key = "joined-hong";
  member.kakao_user_key_type = "botUserKey";
  store.events = [];
  store.notices = [];
  store.files = [];
  return { store, member };
}

async function ask(store, utterance, makeFileUrl = async (file) => `https://files.example.test/${file.id}`) {
  return handleKakaoCommand({
    store,
    now,
    makeFileUrl,
    payload: { userRequest: { utterance, user: { id: "joined-hong" } } },
  });
}

function output(response) {
  return response.template.outputs[0];
}

test("브리핑과 자연어 자료 검색 명령을 단순한 읽기 명령으로 분류한다", () => {
  assert.equal(isTodayBriefingCommand("오늘 브리핑"), true);
  assert.equal(isTodayBriefingCommand("오늘 요약?"), true);
  assert.equal(isTodayBriefingCommand("이번 주 요약"), false);

  assert.deepEqual(readFileBrowseSpec("수학 자료", { allowRaw: true }), {
    kind: "search", requestedType: "file", query: "수학", explicit: true,
  });
  assert.deepEqual(readFileBrowseSpec("김종수T 파일", { allowRaw: true }), {
    kind: "search", requestedType: "file", query: "김종수T", explicit: true,
  });
  assert.deepEqual(readFileBrowseSpec("영어 PDF", { allowRaw: true }), {
    kind: "search", requestedType: "pdf", query: "영어", explicit: true,
  });
  assert.equal(readFileBrowseSpec("최근 올라온 파일", { allowRaw: true }).kind, "recent");
});

test("자료 검색은 별칭·파일명·설명·MIME 토큰을 모두 활용하고 최근순을 지원한다", () => {
  const files = [
    { id: "math", alias: "미적분 정리", filename: "calculus.pdf", description: "수학 김종수T 학습지", mime_type: "application/pdf", created_at: "2026-07-14T00:00:00Z" },
    { id: "english", alias: "독해 연습", filename: "english-reading.pdf", description: "영어 학습지", mime_type: "application/pdf", created_at: "2026-07-15T00:00:00Z" },
    { id: "image", alias: "영어 단어", filename: "words.png", description: "영어", mime_type: "image/png", created_at: "2026-07-16T00:00:00Z" },
  ];

  assert.deepEqual(
    rankBrowseFileCandidates(files, { kind: "search", requestedType: "file", query: "김종수T 학습지" }).map((item) => item.file.id),
    ["math"],
  );
  assert.deepEqual(
    rankBrowseFileCandidates(files, { kind: "search", requestedType: "pdf", query: "영어" }).map((item) => item.file.id),
    ["english"],
  );
  assert.deepEqual(
    rankBrowseFileCandidates(files, { kind: "recent", requestedType: "file", query: "" }).map((item) => item.file.id),
    ["image", "english", "math"],
  );
});

test("오늘 브리핑은 개인 시간표·3일 이내 일정·최신 공지와 자료만 짧게 요약한다", async () => {
  const { store, member } = fixture();
  store.memberTimetable = [{
    id: "personal-timetable", class_id: store.classroom.id, member_id: member.id,
    weekday: 3, period: 1, subject: "개인수학", activity: "심화", teacher: "", room: "", memo: "",
    effective_from: "2026-03-01", effective_to: null,
  }];
  await store.createEvent({ member_id: member.id, subject: "영어", title: "개인 과제", due_at: "2026-07-16T18:00:00+09:00" });
  await store.createEvent({ member_id: store.members[1].id, subject: "물리", title: "타인 과제", due_at: "2026-07-16T18:00:00+09:00" });
  await store.createEvent({ subject: "화학", title: "나흘 뒤 일정", due_at: "2026-07-19T18:00:00+09:00" });
  store.notices = [
    { id: "old", title: "중요하지만 오래된 공지", status: "published", pinned: true, published_at: "2026-07-10T00:00:00Z" },
    { id: "new", title: "최신 공지", status: "published", pinned: false, published_at: "2026-07-15T00:00:00Z" },
  ];
  store.files = [
    { id: "old-file", alias: "이전 자료", filename: "old.pdf", mime_type: "application/pdf", member_id: null, status: "active", created_at: "2026-07-10T00:00:00Z" },
    { id: "new-file", alias: "새 자료", filename: "new.pdf", mime_type: "application/pdf", member_id: member.id, status: "active", created_at: "2026-07-15T00:00:00Z" },
  ];

  const briefing = await buildTodayBriefing({ store, member, now });
  assert.match(briefing, /홍길동님의 오늘 브리핑/);
  assert.match(briefing, /1교시 개인수학/);
  assert.match(briefing, /개인 과제 \(내일\)/);
  assert.doesNotMatch(briefing, /타인 과제|나흘 뒤 일정/);
  assert.match(briefing, /새 공지: 최신 공지/);
  assert.match(briefing, /최근 자료: 새 자료 · 이전 자료/);
  assert.ok(briefing.length < 500);
});

test("등록 사용자의 오늘 브리핑을 한 응답과 5개 이하 Quick Reply로 보낸다", async () => {
  const { store } = fixture();
  const response = await ask(store, "오늘 브리핑");
  assert.match(output(response).simpleText.text, /홍길동님의 오늘 브리핑/);
  assert.ok(response.template.quickReplies.length <= 5);
});

test("과목·교사·형식 검색은 한 건이면 열고 여러 건이면 기존 후보 확인을 재사용한다", async () => {
  const { store, member } = fixture();
  store.files = [
    { id: "math", alias: "미적분 정리", filename: "calculus.pdf", description: "수학 김종수T 학습지", mime_type: "application/pdf", member_id: null, status: "active", created_at: "2026-07-12T00:00:00Z" },
    { id: "english-a", alias: "영어 독해", filename: "reading.pdf", description: "영어 학습지", mime_type: "application/pdf", member_id: null, status: "active", created_at: "2026-07-14T00:00:00Z" },
    { id: "english-b", alias: "영어 문법", filename: "grammar.pdf", description: "영어 학습지", mime_type: "application/pdf", member_id: member.id, status: "active", created_at: "2026-07-15T00:00:00Z" },
  ];

  const direct = await ask(store, "김종수T 학습지");
  assert.equal(output(direct).textCard.title, "미적분 정리");

  const candidates = await ask(store, "영어 PDF");
  assert.match(output(candidates).simpleText.text, /비슷한 후보/);
  assert.match(output(candidates).simpleText.text, /영어 문법|영어 독해/);
  assert.ok(candidates.template.quickReplies.length <= 5);

  const selected = await ask(store, "맞아");
  assert.match(output(selected).textCard.title, /영어 문법|영어 독해/);
});

test("최근 파일 검색은 최신 3개만 후보로 제시하고 타인의 개인 자료는 숨긴다", async () => {
  const { store, member } = fixture();
  const other = store.members[1];
  store.files = [
    { id: "first", alias: "첫 자료", filename: "first.pdf", mime_type: "application/pdf", member_id: null, status: "active", created_at: "2026-07-13T00:00:00Z" },
    { id: "second", alias: "둘째 자료", filename: "second.pdf", mime_type: "application/pdf", member_id: member.id, status: "active", created_at: "2026-07-14T00:00:00Z" },
    { id: "third", alias: "셋째 자료", filename: "third.pdf", mime_type: "application/pdf", member_id: null, status: "active", created_at: "2026-07-15T00:00:00Z" },
    { id: "hidden", alias: "타인 자료", filename: "hidden.pdf", mime_type: "application/pdf", member_id: other.id, status: "active", created_at: "2026-07-16T00:00:00Z" },
    { id: "old", alias: "오래된 자료", filename: "old.pdf", mime_type: "application/pdf", member_id: null, status: "active", created_at: "2026-07-12T00:00:00Z" },
  ];

  const response = await ask(store, "최근 올라온 파일");
  const copy = output(response).simpleText.text;
  assert.match(copy, /셋째 자료|둘째 자료|첫 자료/);
  assert.doesNotMatch(copy, /타인 자료|오래된 자료/);
  assert.ok(response.template.quickReplies.length <= 5);
});

test("명시적인 자료 검색 결과가 없으면 파일 리스트를 안내한다", async () => {
  const { store } = fixture();
  for (const query of ["생명과학 자료", "김종수T 학습지"]) {
    const response = await ask(store, query);
    assert.match(output(response).simpleText.text, /요청한 자료를 찾을 수 없습니다/);
    assert.match(output(response).simpleText.text, /파일 리스트/);
  }
});

test("일정과 파일 확인 후보가 겹치면 가장 최근 요청 하나만 확인한다", async () => {
  const { store, member } = fixture();
  store.files = [
    { id: "english-a", alias: "영어 독해", filename: "reading.pdf", description: "영어 학습지", mime_type: "application/pdf", member_id: null, status: "active" },
    { id: "english-b", alias: "영어 문법", filename: "grammar.pdf", description: "영어 학습지", mime_type: "application/pdf", member_id: member.id, status: "active" },
  ];

  await ask(store, "내일 영어 과제 추가");
  const fileCandidates = await ask(store, "영어 PDF");
  assert.match(output(fileCandidates).simpleText.text, /비슷한 후보/);
  assert.equal(await store.getPendingKakaoAction(member.id), null);

  const opened = await ask(store, "맞아요");
  assert.ok(output(opened).textCard);
  assert.equal(store.events.length, 0);

  await ask(store, "영어 PDF");
  const eventProposal = await ask(store, "내일 영어 과제 추가");
  assert.match(output(eventProposal).simpleText.text, /개인 일정으로 추가할까요/);
  assert.equal(await store.getPendingFileSelection(member.id), null);

  const confirmed = await ask(store, "추가할게요");
  assert.match(output(confirmed).simpleText.text, /개인 일정을 추가했습니다/);
  assert.equal(store.events.length, 1);
});
