import crypto from "node:crypto";
import { formatKoreanDateTime, getSeoulParts } from "../time.js";
import { registeredQuickReplies, simpleTextResponse } from "./kakao.js";

const ACTION_TTL_MS = 10 * 60 * 1000;
const YES_WORDS = new Set(["맞아", "맞아요", "네", "넵", "예", "응", "ㅇㅇ", "확인"]);
const NO_WORDS = new Set(["아니", "아니야", "아니요", "ㄴㄴ", "취소", "그만"]);
const ACTION_LABELS = {
  create: "추가",
  update: "변경",
  complete: "완료",
  delete: "삭제",
};

function normalizedText(value) {
  return String(value || "").trim().replace(/[?!.,。]+$/u, "").replace(/\s+/g, " ");
}

function compactText(value) {
  return normalizedText(value).replace(/\s+/g, "").toLowerCase();
}

function seoulDate(year, month, day, hour = 23, minute = 59) {
  const value = new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`);
  const parts = getSeoulParts(value);
  if (Number.isNaN(value.getTime()) || parts.year !== year || parts.month !== month || parts.day !== day) {
    throw new Error("올바른 날짜를 입력해 주세요.");
  }
  return value;
}

function readTime(text) {
  const match = text.match(/(?:(오전|오후)\s*)?(\d{1,2})시(?!간)(?:\s*(\d{1,2})분)?/u);
  if (!match) return { hour: 23, minute: 59, explicit: false, text };
  let hour = Number(match[2]);
  const minute = Number(match[3] || 0);
  if (match[1]) {
    if (hour < 1 || hour > 12) throw new Error("시간을 정확히 입력해 주세요.");
    if (match[1] === "오후" && hour < 12) hour += 12;
    if (match[1] === "오전" && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) throw new Error("시간을 정확히 입력해 주세요.");
  return { hour, minute, explicit: true, text: normalizedText(text.replace(match[0], "")) };
}

function dateFromText(text, now, { fallbackDate } = {}) {
  const timed = readTime(text);
  const base = getSeoulParts(now);
  let match = timed.text.match(/(오늘|내일|모레)/u);
  if (match) {
    const offset = { 오늘: 0, 내일: 1, 모레: 2 }[match[1]];
    const noon = new Date(`${base.dateKey}T12:00:00+09:00`);
    const target = getSeoulParts(new Date(noon.getTime() + offset * 86_400_000));
    return {
      date: seoulDate(target.year, target.month, target.day, timed.hour, timed.minute),
      text: normalizedText(timed.text.replace(match[0], "")),
    };
  }

  match = timed.text.match(/(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일/u);
  if (match) {
    const month = Number(match[2]);
    const day = Number(match[3]);
    let year = match[1] ? Number(match[1]) : base.year;
    const fallback = fallbackDate && !timed.explicit ? getSeoulParts(fallbackDate) : timed;
    let date = seoulDate(year, month, day, fallback.hour, fallback.minute);
    if (!match[1] && date.getTime() < now.getTime() - 86_400_000) {
      year += 1;
      date = seoulDate(year, month, day, fallback.hour, fallback.minute);
    }
    return { date, text: normalizedText(timed.text.replace(match[0], "")) };
  }

  match = timed.text.match(/(\d{1,2})일/u);
  if (match && fallbackDate) {
    const fallback = getSeoulParts(fallbackDate);
    const hour = timed.explicit ? timed.hour : fallback.hour;
    const minute = timed.explicit ? timed.minute : fallback.minute;
    return {
      date: seoulDate(fallback.year, fallback.month, Number(match[1]), hour, minute),
      text: normalizedText(timed.text.replace(match[0], "")),
    };
  }
  return null;
}

function categoryForTitle(title) {
  const compact = compactText(title);
  if (["수행평가", "시험", "테스트"].some((word) => compact.includes(word))) return "assessment";
  if (["과제", "숙제", "제출"].some((word) => compact.includes(word))) return "assignment";
  return "class";
}

function subjectForTitle(title) {
  const first = normalizedText(title).split(" ")[0] || "";
  return first.length <= 30 && !/^(수행평가|시험|테스트|과제|숙제|제출)$/u.test(first) ? first : "";
}

function looksLikeMutation(command) {
  return /(추가|등록|변경|수정|삭제|완료)(?:해줘|해주세요)?$/u.test(normalizedText(command));
}

function confirmationReplies(action) {
  const label = ACTION_LABELS[action];
  return [
    { label: `${label}할게요`, action: "message", messageText: `${label}할게요` },
    { label: "취소", action: "message", messageText: "취소" },
    { label: "오늘 일정", action: "message", messageText: "오늘 일정" },
    { label: "도움말", action: "message", messageText: "도움말" },
  ];
}

function mutationSummary(action, payload) {
  const label = ACTION_LABELS[action];
  if (action === "create") {
    return `개인 일정으로 ${label}할까요?\n\n${payload.title}\n${formatKoreanDateTime(new Date(payload.due_at))}`;
  }
  if (action === "update") {
    return `이 개인 일정을 ${label}할까요?\n\n${payload.title}\n${formatKoreanDateTime(new Date(payload.previous_due_at))} → ${formatKoreanDateTime(new Date(payload.due_at))}`;
  }
  return `이 개인 일정을 ${label}할까요?\n\n${payload.title}\n${formatKoreanDateTime(new Date(payload.due_at))}`;
}

function eventSearchKey(text) {
  return compactText(text).replace(/일정$/u, "");
}

async function findOwnedEvent(store, member, query, { allowCompleted = false } = {}) {
  const rows = (await store.listEvents({ targetMemberId: member.id }))
    .filter((event) => event.member_id === member.id)
    .filter((event) => allowCompleted ? event.status !== "cancelled" : event.status === "scheduled");
  const key = eventSearchKey(query);
  if (key === "방금" || key === "최근" || key === "방금일정" || key === "최근일정") {
    return rows.sort((a, b) => new Date(b.created_at || b.updated_at) - new Date(a.created_at || a.updated_at))[0] || null;
  }
  const exact = rows.filter((event) => eventSearchKey(event.title) === key);
  if (exact.length === 1) return exact[0];
  const partial = rows.filter((event) => {
    const title = eventSearchKey(event.title);
    return title.includes(key) || key.includes(title);
  });
  if (partial.length === 1) return partial[0];
  if (exact.length > 1 || partial.length > 1) throw new Error("같은 이름의 개인 일정이 여러 개입니다. 제목을 더 정확히 입력해 주세요.");
  return null;
}

async function parseMutation(command, member, store, now) {
  const text = normalizedText(command);
  let match = text.match(/^(.+?)\s*(?:추가|등록)(?:해줘|해주세요)?$/u);
  if (match) {
    const parsed = dateFromText(match[1], now);
    if (!parsed) throw new Error("날짜를 함께 입력해 주세요. 예: ‘7월 20일 수학 수행평가 추가’");
    const title = normalizedText(parsed.text);
    if (!title || title.length > 100) throw new Error("일정 제목을 100자 이내로 입력해 주세요.");
    return {
      action: "create",
      payload: {
        title,
        due_at: parsed.date.toISOString(),
        category: categoryForTitle(title),
        subject: subjectForTitle(title),
        request_key: `kakao-${member.id}-${crypto.randomUUID()}`,
      },
    };
  }

  match = text.match(/^(.+?)\s+((?:(?:\d{4})년\s*)?\d{1,2}월\s*\d{1,2}일|\d{1,2}일)(?:로)?\s*(?:변경|수정)(?:해줘|해주세요)?$/u);
  if (match) {
    const event = await findOwnedEvent(store, member, match[1]);
    if (!event) throw new Error("변경할 본인 개인 일정을 찾을 수 없습니다.");
    const parsed = dateFromText(match[2], now, { fallbackDate: new Date(event.due_at) });
    if (!parsed) throw new Error("변경할 날짜를 정확히 입력해 주세요.");
    return {
      action: "update",
      eventId: event.id,
      payload: { title: event.title, previous_due_at: event.due_at, due_at: parsed.date.toISOString() },
    };
  }

  match = text.match(/^(.+?)(?:\s+일정)?\s*(삭제|완료)(?:해줘|해주세요)?$/u);
  if (match) {
    const action = match[2] === "완료" ? "complete" : "delete";
    const event = await findOwnedEvent(store, member, match[1], { allowCompleted: action === "delete" });
    if (!event) throw new Error(`${ACTION_LABELS[action]}할 본인 개인 일정을 찾을 수 없습니다.`);
    return { action, eventId: event.id, payload: { title: event.title, due_at: event.due_at } };
  }
  return null;
}

function isConfirmCommand(command, pendingAction) {
  const compact = compactText(command);
  const actionLabel = ACTION_LABELS[pendingAction];
  return YES_WORDS.has(compact) || compact === `${actionLabel}할게요` || compact === `${actionLabel}해주세요` || compact === `${actionLabel}해줘`;
}

async function executePending(store, member, pending) {
  if (pending.action === "create") {
    return store.createEvent({ ...pending.payload, member_id: member.id }, member.id);
  }
  const event = await store.getEvent(pending.event_id);
  if (!event || event.member_id !== member.id) throw new Error("본인 개인 일정만 바꿀 수 있습니다.");
  if (event.status === "cancelled") throw new Error("이미 삭제된 일정입니다.");
  if (pending.action === "update") return store.updateEvent(event.id, { due_at: pending.payload.due_at }, member.id);
  if (pending.action === "complete") {
    if (event.status !== "scheduled") throw new Error("이미 완료된 일정입니다.");
    return store.updateEvent(event.id, { status: "completed" }, member.id);
  }
  return store.cancelEvent(event.id, member.id);
}

export async function answerPendingEventMutation({ command, member, store }) {
  if (!member || typeof store.getPendingKakaoAction !== "function") return null;
  const pending = await store.getPendingKakaoAction(member.id);
  if (!pending) return null;
  const compact = compactText(command);
  if (NO_WORDS.has(compact)) {
    await store.clearPendingKakaoAction(member.id);
    return simpleTextResponse("일정 변경을 취소했습니다.", registeredQuickReplies());
  }
  if (!isConfirmCommand(command, pending.action)) return null;
  const event = await executePending(store, member, pending);
  await store.clearPendingKakaoAction(member.id);
  const label = ACTION_LABELS[pending.action];
  const suffix = pending.action === "delete" ? "삭제했습니다" : `${label}했습니다`;
  return simpleTextResponse(`개인 일정을 ${suffix}.\n\n${event.title}\n${formatKoreanDateTime(new Date(event.due_at))}`, registeredQuickReplies());
}

export async function answerEventMutation({ command, member, store, now = new Date() }) {
  if (!looksLikeMutation(command)) return null;
  if (!member || member.status !== "active") {
    return simpleTextResponse("개인 일정을 바꾸려면 관리자에게 받은 1회용 초대 코드로 먼저 가입해 주세요.");
  }
  const mutation = await parseMutation(command, member, store, now);
  if (!mutation) return null;
  if (typeof store.setPendingKakaoAction !== "function") {
    return simpleTextResponse("현재 채팅 일정 변경 기능을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.", registeredQuickReplies());
  }
  if (typeof store.clearPendingFileSelection === "function") {
    await store.clearPendingFileSelection(member.id);
  }
  await store.setPendingKakaoAction({
    memberId: member.id,
    action: mutation.action,
    eventId: mutation.eventId || null,
    payload: mutation.payload,
    expiresAt: new Date(Date.now() + ACTION_TTL_MS).toISOString(),
  });
  return simpleTextResponse(`${mutationSummary(mutation.action, mutation.payload)}\n\n10분 안에 확인해 주세요.`, confirmationReplies(mutation.action));
}
